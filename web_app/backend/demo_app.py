import os
import io
import base64
import uuid
from datetime import datetime
from fastapi import FastAPI, File, UploadFile, Depends, HTTPException, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session
from PIL import Image, ImageOps, UnidentifiedImageError
from threading import Lock

# Keep model runtime settings inside this project, alongside its runtime data.
os.environ.setdefault("YOLO_CONFIG_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ultralytics"))
os.makedirs(os.environ["YOLO_CONFIG_DIR"], exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "matplotlib"))
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
from ultralytics import YOLO
from database import DATA_DIR
from database import (
        SessionLocal, DetectionLog, Part,
    init_db,
)
from printer_catalog import PrinterPart, seed_printer_catalog

app = FastAPI()
from dataset_api import router as dataset_router
app.include_router(dataset_router)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.abspath(os.path.join(BASE_DIR, "../frontend"))
app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, "../.."))
MODEL_DET_PATH = os.path.abspath(os.environ.get("KAMERO_MODEL_PATH", os.path.join(PROJECT_ROOT, "models", "best_v26_det.pt")))
model_det = None
INFERENCE_LOCK = Lock()

def load_detector():
    global model_det
    if model_det is None:
        if not os.path.isfile(MODEL_DET_PATH):
            raise HTTPException(503, "Recognition weights are not installed. Catalogue browsing remains available.")
        try:
            candidate = YOLO(MODEL_DET_PATH)
            if candidate.task != "detect":
                raise ValueError("A detection model is required.")
            model_det = candidate
        except Exception as exc:
            raise HTTPException(503, "The detection model could not be loaded. Check the model and runtime versions.") from exc
    return model_det


def run_detection(image):
    with INFERENCE_LOCK:
        return load_detector()(image, conf=0.25, verbose=False)

PRINTER_SCOPE = "All parts (printer compatibility unverified)"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

IMAGES_DIR = os.path.join(DATA_DIR, "detection_images")
os.makedirs(IMAGES_DIR, exist_ok=True)


def save_result_image(img: Image.Image, original_filename: str) -> str:
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    uid = uuid.uuid4().hex[:8]
    safe_name = os.path.splitext(os.path.basename(original_filename))[0][:40]
    filename = f"{ts}_{uid}_{safe_name}.jpg"
    path = os.path.join(IMAGES_DIR, filename)
    img.save(path, format="JPEG")
    return path


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@app.on_event("startup")
async def startup():
    from seed_db import seed
    seed()
    with SessionLocal() as db:
        seed_printer_catalog(db)


@app.get("/api/health")
def health():
    try:
        with INFERENCE_LOCK:
            detector = load_detector()
            labels = list(detector.names.values())
        ready, reason = True, None
    except HTTPException as exc:
        ready, reason, labels = False, exc.detail, []
    return {"status": "ok", "model_version": os.path.basename(MODEL_DET_PATH),
            "recognition_available": ready, "reason": reason, "class_count": len(labels),
            "e786_recognition_available": False}


@app.get("/api/models")
def printer_models(db: Session = Depends(get_db)):
    state = health()
    labels = set(model_det.names.values()) if state["recognition_available"] else set()
    coverage = []
    for printer in ("E731", "E786"):
        rows = db.query(PrinterPart).filter_by(printer_model=printer).all()
        matched = [p.part_number for p in rows if p.part_number in labels]
        coverage.append({"printer_model": printer, "catalogue_count": len(rows),
                         "matching_model_labels": matched, "matching_count": len(matched),
                         "full_model_connected": False})
    return {"models": [PRINTER_SCOPE, "E731", "E786"] if state["recognition_available"] else [],
            "filtering_supported": False, "recognition_available": state["recognition_available"],
            "e786_recognition_available": False, "catalogues": coverage,
            "message": state["reason"] or "The connected model recognizes 40 legacy classes. Selecting E731 or E786 changes the specification lookup. Both use the same legacy detector."}


@app.get("/api/parts")
def catalogue(printer_model: str = "legacy", db: Session = Depends(get_db)):
    if printer_model in {"E731", "E786"}:
        return {"printer_model": printer_model, "parts": [
            {"class_id": None, "part_no": p.part_no, "part_number": p.part_number,
             "description": p.description}
            for p in db.query(PrinterPart).filter_by(printer_model=printer_model).order_by(PrinterPart.part_no)]}
    if printer_model != "legacy":
        raise HTTPException(422, "Unknown printer catalogue.")
    return {"parts": [{"class_id": p.class_id, "part_number": p.serial_number,
                       "description": p.part_desc}
                      for p in db.query(Part).order_by(Part.class_id).all()]}


@app.get("/")
async def main_page():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/datasets")
def dataset_page():
    return FileResponse(os.path.join(STATIC_DIR, "datasets.html"))


def read_upload(file, printer_model):
    if printer_model not in (PRINTER_SCOPE, "E731", "E786"):
        raise HTTPException(422, "Unknown printer model.")
    image_bytes = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Maximum upload size is 10 MB.")
    try:
        with Image.open(io.BytesIO(image_bytes)) as source:
            if source.format not in {"JPEG", "PNG"}:
                raise HTTPException(415, "Please upload a JPG or PNG image.")
            if source.width * source.height > 40_000_000:
                raise HTTPException(413, "Image exceeds 40 megapixels.")
            image = ImageOps.exif_transpose(source).convert("RGB")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(415, "The uploaded file is not a readable JPG or PNG image.")
    return image


@app.post("/api/v1/validate")
def validate_upload(file: UploadFile = File(...), printer_model: str = Form(...)):
    read_upload(file, printer_model)
    return {"valid": True}


@app.post("/api/v1/analyze")
@app.post("/detect")
def detect(file: UploadFile = File(...), printer_model: str = Form(PRINTER_SCOPE), db: Session = Depends(get_db)):
    print(f"[Predict] request: {file.filename}")

    try:
        image = read_upload(file, printer_model)
        results = run_detection(image)

        if not len(results[0].boxes):
            return {"parts": [], "printer_model": printer_model, "model_version": os.path.basename(MODEL_DET_PATH)}

        plotted_bgr = results[0].plot()
        plotted_rgb = Image.fromarray(plotted_bgr[..., ::-1])
        buf = io.BytesIO()
        plotted_rgb.save(buf, format="JPEG")
        img_str = base64.b64encode(buf.getvalue()).decode("utf-8")

        saved_path = save_result_image(Image.fromarray(plotted_bgr[..., ::-1]), file.filename)

        bboxes = [] 
        conf = []
        classes = []
        for result in results:
            bboxes = result.boxes.xywhn.cpu().numpy().tolist()
            conf = result.boxes.conf.cpu().numpy().tolist()
            classes = result.boxes.cls.cpu().numpy().tolist()

        n = len(classes)
        srl = []
        msg = []
        send = []
        parts = []

        # Database Commit & Message
        for i in range(n):
            # Class indices can change between models; resolve by the embedded part label.
            label = str(result.names.get(int(classes[i]), classes[i]))
            qry = db.query(Part).filter(Part.serial_number == label).first()
            number = label
            description = qry.part_desc if qry else "Unmapped model class; please verify."
            compatibility = sorted({p.printer_model for p in db.query(PrinterPart).filter_by(part_number=label)})
            if printer_model != PRINTER_SCOPE:
                spec = db.query(PrinterPart).filter_by(printer_model=printer_model, part_number=label).first()
                description = spec.description if spec else "No matching specification in the selected printer catalogue."
            srl.append(number)
            msg.append(description)
            parts.append({"class_name": str(result.names.get(int(classes[i]), classes[i])),
                          "class_id": int(classes[i]), "part_number": number,
                          "description": description, "confidence": conf[i],
                          "bbox_norm": bboxes[i], "compatibility": compatibility,
                          "mapping_status": "matched_part_number" if qry else "unmapped"})
            send.append({
                "class": number,
                "confidence": conf[i],
                "bbox": bboxes[i]
            })
                        
        log = DetectionLog(
            image_url=saved_path,
            result=send
        )
        db.add(log)
        db.commit()
        db.refresh(log)

        return {"image": img_str, "conf": conf, "cls": srl, "desc": msg,
                "parts": parts, "bboxes": bboxes, "bbox_format": "cxcywh_normalized",
                "record_id": log.id, "model_version": os.path.basename(MODEL_DET_PATH),
                "printer_model": printer_model}

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"[predict] error: {str(e)}")
        raise HTTPException(status_code=500, detail="Recognition failed. Please check the server log and retry.")

