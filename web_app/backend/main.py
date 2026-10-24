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
from database import (
        SessionLocal, DetectionLog, ClassificationLog, Part,
    init_db, clear_detection_history,
)

app = FastAPI()
from dataset_api import router as dataset_router
app.include_router(dataset_router)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

PROJECT_ROOT = os.path.dirname(BASE_DIR)
MODEL_DET_PATH = os.path.join(PROJECT_ROOT, "models", "best_v26_det.pt")
MODEL_CLS_PATH = os.path.join(PROJECT_ROOT, "models", "best_v26_cls.pt")

model_det = YOLO(MODEL_DET_PATH)
model_cls = YOLO(MODEL_CLS_PATH)
INFERENCE_LOCK = Lock()
PRINTER_SCOPE = "All parts (printer compatibility unverified)"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

IMAGES_DIR = os.path.join(BASE_DIR, "data", "detection_images")
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


@app.get("/api/health")
def health():
    return {"status": "ok", "model_version": os.path.basename(MODEL_DET_PATH)}


@app.get("/api/models")
def printer_models():
    # No verified printer-to-part compatibility mapping is supplied by this project.
    return {"models": [PRINTER_SCOPE], "filtering_supported": False}


@app.get("/api/parts")
def catalogue(db: Session = Depends(get_db)):
    return {"parts": [{"class_id": p.class_id, "part_number": p.serial_number,
                       "description": p.part_desc}
                      for p in db.query(Part).order_by(Part.class_id).all()]}


@app.get("/")
async def main_page():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/datasets")
def dataset_page():
    return FileResponse(os.path.join(STATIC_DIR, "datasets.html"))


@app.post("/detect")
def detect(file: UploadFile = File(...), printer_model: str = Form(PRINTER_SCOPE), db: Session = Depends(get_db)):
    print(f"[Predict] request: {file.filename}")

    try:
        if printer_model != PRINTER_SCOPE:
            raise HTTPException(422, "This server supports all-parts recognition only; printer compatibility is not verified.")
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

        buffered = io.BytesIO()
        image.save(buffered, format="JPEG")
        img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")

        with INFERENCE_LOCK:
            results = model_det(image, conf=0.05, verbose=False)

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
            qry = db.query(Part).filter(Part.class_id == classes[i]).first()
            number = qry.serial_number if qry else str(result.names.get(int(classes[i]), classes[i]))
            description = qry.part_desc if qry else "Unmapped model class; please verify."
            srl.append(number)
            msg.append(description)
            parts.append({"class_name": str(result.names.get(int(classes[i]), classes[i])),
                          "class_id": int(classes[i]), "part_number": number,
                          "description": description, "confidence": conf[i],
                          "bbox_norm": bboxes[i], "compatibility": []})
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
        raise HTTPException(status_code=500, detail=f"Processing error: {str(e)}")

@app.post("/classify")
async def classify(file: UploadFile = File(...), db: Session = Depends(get_db)):
    print(f"[Predict] request: {file.filename}")

    try:
        image_bytes = await file.read()
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        buffered = io.BytesIO()
        image.save(buffered, format="JPEG")
        img_str = base64.b64encode(buffered.getvalue()).decode("utf-8")

        results = model_cls(image, conf=0.05)

        plotted_bgr = results[0].plot()
        plotted_rgb = Image.fromarray(plotted_bgr[..., ::-1])
        buf = io.BytesIO()
        plotted_rgb.save(buf, format="JPEG")
        img_str = base64.b64encode(buf.getvalue()).decode("utf-8")

        saved_path = save_result_image(Image.fromarray(plotted_bgr[..., ::-1]), file.filename)

        conf = []
        classes = []
        for result in results:
            probs = result.probs
            conf = probs.top5conf.cpu().numpy().tolist()
            classes = [result.names[i] for i in probs.top5]


        n = len(classes)
        msg = []
        send = []

        # Database Commit & Message
        for i in range(n):
            qry = db.query(Part).filter(Part.serial_number == classes[i]).first()
            msg.append(qry.part_desc)
            send.append({
                "class": classes[i],
                "confidence": conf[i],
            })
                        
        log = ClassificationLog(
            image_url=saved_path,
            result=send
        )
        db.add(log)
        db.commit()
        db.refresh(log)

        return {"image": img_str, "conf": conf, "cls": classes, "desc": msg}

    except Exception as e:
        print(f"[predict] error: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Processing error: {str(e)}")

@app.delete("/admin/clear-db")
async def clear_db(db: Session = Depends(get_db)):
    """Clear all detection history (logs, bounding boxes, feedbacks) and saved result images. Parts are preserved."""
    clear_detection_history(db)

    deleted_files = 0
    for filename in os.listdir(IMAGES_DIR):
        filepath = os.path.join(IMAGES_DIR, filename)
        if os.path.isfile(filepath):
            os.remove(filepath)
            deleted_files += 1

    return {"message": f"Detection history cleared. {deleted_files} result image(s) deleted. Parts are preserved."}
