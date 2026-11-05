import hashlib
import io
import logging
import threading
import warnings
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from starlette.concurrency import run_in_threadpool

from database import AsyncSessionLocal, PartCompatibility, PrinterModel, PrinterPart

router = APIRouter(tags=["Recognition"])
logger = logging.getLogger(__name__)
SUPPORTED_MODEL = "E877"
MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 20_000_000
WEIGHTS = Path(__file__).resolve().parent / "../../models" / "best_v26_det.pt"


class Detector:
    def __init__(self, weights: Path):
        from ultralytics import YOLO

        if not weights.is_file():
            raise FileNotFoundError(f"Place best_v26_det.pt at {weights}")

        self.model = YOLO(str(weights))
        if self.model.task != "detect":
            raise ValueError("Expected a detection checkpoint, not a classification checkpoint.")

        self.names = {int(key): str(value).strip() for key, value in self.model.names.items()}
        self.version = "best_v26_det.pt:" + hashlib.sha256(weights.read_bytes()).hexdigest()[:12]
        self.lock = threading.Lock()

    def predict(self, image: Image.Image, class_ids: list[int]) -> list[dict]:
        with self.lock:
            result = self.model.predict(source=image, classes=class_ids, conf=0.25, imgsz=640,
                                        max_det=100, verbose=False, save=False)[0]
            if result.boxes is None:
                return []

            # xywhn is [centre_x, centre_y, width, height], normalized to 0..1.
            boxes = result.boxes.xywhn.cpu().tolist()
            scores = result.boxes.conf.cpu().tolist()
            labels = result.boxes.cls.int().cpu().tolist()

            return [dict(class_id=label, confidence=float(score), bbox_norm=box)
                    for label, score, box in zip(labels, scores, boxes)]


async def load_detector(app):
    app.state.e877_detector = await run_in_threadpool(Detector, WEIGHTS)


def decode_image(data: bytes) -> Image.Image:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)

            with Image.open(io.BytesIO(data)) as source:
                if source.format not in {"JPEG", "PNG"}:
                    raise HTTPException(415, "Upload a JPEG or PNG image.")

                if source.width * source.height > MAX_PIXELS:
                    raise HTTPException(413, "Image dimensions are too large.")

                source.load()

                return ImageOps.exif_transpose(source).convert("RGB")

    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(413, "Image dimensions are too large.") from exc

    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise HTTPException(400, "The uploaded image cannot be decoded.") from exc


async def e877_parts() -> dict[str, dict]:
    try:
        async with AsyncSessionLocal() as session:
            model = await session.scalar(select(PrinterModel).where(PrinterModel.name == SUPPORTED_MODEL))

            if model is None:
                raise HTTPException(503, "E877 is missing from printer_models. Import it first.")

            parts = (await session.scalars(select(PrinterPart)
                                           .join(PartCompatibility, PartCompatibility.part_id == PrinterPart.id)
                                           .where(PartCompatibility.printer_model_id == model.id))
                     ).all()

            result = {}
            for part in parts:
                if part.serial_number in result:
                    raise HTTPException(503, "Duplicate E877 part numbers in the catalogue. Resolve them first.")

                result[part.serial_number] = {
                    "part_id": part.id,
                    "catalogue_class_id": part.class_id,
                    "description": part.part_desc,
                }
            return result

    except SQLAlchemyError as exc:
        logger.exception("E877 catalogue lookup failed")
        raise HTTPException(503, "Catalogue database unavailable.") from exc


@router.get("/api/recognition/models", response_model=list[str])
async def recognition_models():
    return [SUPPORTED_MODEL]


@router.post("/detect")
async def detect(request: Request, file: Annotated[UploadFile, File()], printer_model: Annotated[str, Form()],):
    try:
        if printer_model.strip().upper() != SUPPORTED_MODEL:
            raise HTTPException(400, "Recognition is currently available only for E877.")

        detector = getattr(request.app.state, "e877_detector", None)
        if detector is None:
            raise HTTPException(503, "The E877 detector has not been loaded.")

        data = await file.read(MAX_BYTES + 1)

        if len(data) > MAX_BYTES:
            raise HTTPException(413, "Maximum image size is 10 MB.")

        if not data:
            raise HTTPException(400, "The uploaded file is empty.")
    finally:
        await file.close()

    image = await run_in_threadpool(decode_image, data)
    try:
        catalogue = await e877_parts()
        allowed = [class_id for class_id, serial in detector.names.items() if serial in catalogue]
        if not allowed:
            raise HTTPException(503, "No trained part numbers are linked to E877. Check catalogue compatibility records.")

        try:
            predictions = await run_in_threadpool(detector.predict, image, allowed)
        except Exception as exc:
            logger.exception("E877 inference failed")
            raise HTTPException(500, "Part detection failed. Check the server log.") from exc
    finally:
        image.close()

    output = []
    for prediction in predictions:
        class_id = prediction["class_id"]
        if class_id not in allowed:
            continue
        serial = detector.names[class_id]
        output.append({
            **prediction,
            **catalogue[serial],
            "class_name": serial,
            "part_number": serial,
            "compatibility": [SUPPORTED_MODEL],
        })
    return {
        "status": "completed" if output else "no-detection",
        "printer_model": SUPPORTED_MODEL,
        "model_version": detector.version,
        "parts": output,
    }
