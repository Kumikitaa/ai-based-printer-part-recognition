"""History and ZIPs read Kirill's logs/predictions; feedback never changes a prediction."""
import csv
import hashlib
import io
import json
import re
import secrets
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image, ImageDraw
from pydantic import BaseModel, Field
from sqlalchemy import ForeignKey, String, DateTime, delete, select
from sqlalchemy.orm import Mapped, mapped_column
from starlette.concurrency import run_in_threadpool

from database import (Base, AsyncSessionLocal, RecognitionLog, PartPrediction,
                      PrinterPart, PrinterModel, PartCompatibility, db_directory)

router = APIRouter(prefix="/api/results", tags=["Saved results"])
IMAGE_DIR = Path(db_directory) / "images"


class RecognitionContext(Base):
    """Extra metadata without changing the five existing tables."""
    __tablename__ = "recognition_contexts"
    recognition_id: Mapped[int] = mapped_column(ForeignKey("recognition_logs.id"), primary_key=True)
    owner_hash: Mapped[str] = mapped_column(String(64), index=True)
    source_file: Mapped[str] = mapped_column(String(255))
    model_version: Mapped[str] = mapped_column(String(200))


class PredictionFeedback(Base):
    """One current correction per prediction; not a training label or audit history."""
    __tablename__ = "prediction_feedback"
    prediction_id: Mapped[int] = mapped_column(ForeignKey("part_predictions.id"), primary_key=True)
    value: Mapped[str] = mapped_column(String(100))
    updated_at: Mapped[datetime] = mapped_column(DateTime)


def owner_key(request: Request, response: Response):
    token = request.cookies.get("kamero_owner", "")
    if not re.fullmatch(r"[0-9a-f]{64}", token):
        token = secrets.token_hex(32)
        response.set_cookie("kamero_owner", token, httponly=True,
                            secure=request.url.scheme == "https", samesite="strict", max_age=31536000)
    return hashlib.sha256(token.encode()).hexdigest()


async def session():
    async with AsyncSessionLocal() as db:
        yield db


async def owned_record(db, record_id, owner):
    row = (await db.execute(select(RecognitionLog, RecognitionContext)
        .join(RecognitionContext, RecognitionContext.recognition_id == RecognitionLog.id)
        .where(RecognitionLog.id == record_id, RecognitionContext.owner_hash == owner))).first()
    if row is None:
        raise HTTPException(404, "Recognition record not found.")
    return row


async def compatible_models(db, part_ids):
    result = {part_id: [] for part_id in part_ids}
    if result:
        rows = await db.execute(select(PartCompatibility.part_id, PrinterModel.name)
            .join(PrinterModel, PrinterModel.id == PartCompatibility.printer_model_id)
            .where(PartCompatibility.part_id.in_(result)).order_by(PrinterModel.name))
        for part_id, name in rows:
            result[part_id].append(name)
    return result


async def result_data(db, log, context):
    model = await db.get(PrinterModel, log.printer_model_id)
    rows = (await db.execute(select(PartPrediction, PrinterPart, PredictionFeedback)
        .join(PrinterPart, PrinterPart.id == PartPrediction.part_id)
        .outerjoin(PredictionFeedback, PredictionFeedback.prediction_id == PartPrediction.id)
        .where(PartPrediction.recognition_id == log.id).order_by(PartPrediction.id))).all()
    compatibility = await compatible_models(db, [part.id for _, part, _ in rows])
    width, height = log.image_dimensions
    parts = []
    for prediction, part, feedback in rows:
        x1, y1, x2, y2 = prediction.bounding_box_cords
        parts.append({"prediction_id": prediction.id, "part_id": part.id,
            "part_number": part.serial_number, "class_name": part.serial_number,
            "description": part.part_desc, "confidence": prediction.detector_confidence,
            "classifier_confidence": prediction.classifier_confidence,
            "bbox_norm": [(x1 + x2) / (2 * width), (y1 + y2) / (2 * height),
                          (x2 - x1) / width, (y2 - y1) / height],
            "bbox_xyxy_pixels": [x1, y1, x2, y2], "compatibility": compatibility[part.id],
            "user_feedback": feedback.value if feedback else None})
    return {"record_id": log.id, "created": log.created_date.isoformat() + "Z",
            "printer_model": model.name, "status": log.status, "source_file": context.source_file,
            "model_version": context.model_version, "image_dimensions": log.image_dimensions,
            "image_url": f"/api/results/{log.id}/image", "parts": parts}


def save_image(image, path):
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")


async def save_recognition(image, filename, version, model_name, predictions, owner):
    path = IMAGE_DIR / (uuid.uuid4().hex + ".png")
    try:
        await run_in_threadpool(save_image, image, path)
        async with AsyncSessionLocal() as db:
            async with db.begin():
                model_id = await db.scalar(select(PrinterModel.id).where(PrinterModel.name == model_name))
                if model_id is None:
                    raise HTTPException(503, "Printer model is missing from the catalogue.")
                log = RecognitionLog(printer_model_id=model_id, image_path=str(path.resolve()),
                    image_dimensions=list(image.size), status="completed" if predictions else "no-detection")
                db.add(log)
                await db.flush()
                context = RecognitionContext(recognition_id=log.id, owner_hash=owner,
                    source_file=filename.replace("\\", "/").split("/")[-1][:255], model_version=version)
                db.add(context)
                width, height = image.size
                for item in predictions:
                    cx, cy, w, h = item["bbox_norm"]
                    # Kirill's schema stores pixel xyxy; the UI receives normalized centre xywh.
                    db.add(PartPrediction(recognition_id=log.id, part_id=item["part_id"],
                        bounding_box_cords=[(cx-w/2)*width, (cy-h/2)*height,
                                            (cx+w/2)*width, (cy+h/2)*height],
                        detector_confidence=item["confidence"], classifier_confidence=None))
                await db.flush()
                payload = await result_data(db, log, context)
            return payload
    except BaseException:
        path.unlink(missing_ok=True)
        raise


@router.get("")
async def history(owner=Depends(owner_key), db=Depends(session)):
    rows = (await db.execute(select(RecognitionLog, RecognitionContext)
        .join(RecognitionContext, RecognitionContext.recognition_id == RecognitionLog.id)
        .where(RecognitionContext.owner_hash == owner)
        .order_by(RecognitionLog.id.desc()).limit(100))).all()
    return [await result_data(db, log, context) for log, context in rows]


@router.get("/{record_id}")
async def detail(record_id: int, owner=Depends(owner_key), db=Depends(session)):
    log, context = await owned_record(db, record_id, owner)
    return await result_data(db, log, context)


@router.get("/{record_id}/image")
async def image_file(record_id: int, owner=Depends(owner_key), db=Depends(session)):
    log, _ = await owned_record(db, record_id, owner)
    if not Path(log.image_path).is_file():
        raise HTTPException(404, "Saved image is unavailable.")
    return FileResponse(log.image_path, media_type="image/png", headers={"Cache-Control": "no-store"})


class FeedbackInput(BaseModel):
    value: str = Field(max_length=100)


@router.put("/{record_id}/predictions/{prediction_id}/feedback")
async def feedback(record_id: int, prediction_id: int, body: FeedbackInput,
                   owner=Depends(owner_key), db=Depends(session)):
    await owned_record(db, record_id, owner)
    prediction = await db.get(PartPrediction, prediction_id)
    if prediction is None or prediction.recognition_id != record_id:
        raise HTTPException(404, "Prediction not found in this recognition.")
    if body.value not in ("", "none"):
        exists = await db.scalar(select(PrinterPart.id).where(PrinterPart.serial_number == body.value).limit(1))
        if exists is None:
            raise HTTPException(422, "Choose a part from the catalogue or unknown.")
    row = await db.get(PredictionFeedback, prediction_id)
    if not body.value:
        if row is not None:
            await db.delete(row)
    else:
        if row is None:
            row = PredictionFeedback(prediction_id=prediction_id)
            db.add(row)
        row.value = body.value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await db.commit()
    return {"saved": True}


def build_zip(data, image_path):
    csv_file = io.StringIO()
    writer = csv.writer(csv_file)
    writer.writerow(["prediction_id", "part_number", "description", "confidence", "user_feedback"])
    with Image.open(image_path) as source:
        annotated = source.convert("RGB")
    draw = ImageDraw.Draw(annotated)
    for part in data["parts"]:
        cells = [part["prediction_id"], part["part_number"], part["description"],
                 part["confidence"], part["user_feedback"] or ""]
        writer.writerow(["'" + v if isinstance(v, str) and v.startswith(("=", "+", "-", "@")) else v for v in cells])
        coords = part["bbox_xyxy_pixels"]
        color = "orange" if part["confidence"] < .6 else "green"
        draw.rectangle(coords, outline=color, width=3)
        draw.text((max(0, coords[0]), max(0, coords[1]-12)), part["part_number"], fill=color)
    image_bytes = io.BytesIO()
    annotated.save(image_bytes, format="PNG")
    annotated.close()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("results.json", json.dumps(data, ensure_ascii=False, indent=2))
        archive.writestr("results.csv", "\ufeff" + csv_file.getvalue())
        archive.writestr("annotated.png", image_bytes.getvalue())
    output.seek(0)
    return output


@router.get("/{record_id}/export")
async def export(record_id: int, owner=Depends(owner_key), db=Depends(session)):
    log, context = await owned_record(db, record_id, owner)
    if not Path(log.image_path).is_file():
        raise HTTPException(404, "Saved image is unavailable.")
    data = await result_data(db, log, context)
    archive = await run_in_threadpool(build_zip, data, log.image_path)
    return StreamingResponse(archive, media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="recognition-{record_id}.zip"',
                 "Cache-Control": "no-store"})


@router.delete("")
async def clear_history(owner=Depends(owner_key), db=Depends(session)):
    rows = (await db.execute(select(RecognitionLog.id, RecognitionLog.image_path)
        .join(RecognitionContext, RecognitionContext.recognition_id == RecognitionLog.id)
        .where(RecognitionContext.owner_hash == owner))).all()
    ids = [row.id for row in rows]
    if ids:
        predictions = select(PartPrediction.id).where(PartPrediction.recognition_id.in_(ids))
        await db.execute(delete(PredictionFeedback).where(PredictionFeedback.prediction_id.in_(predictions)))
        await db.execute(delete(PartPrediction).where(PartPrediction.recognition_id.in_(ids)))
        await db.execute(delete(RecognitionContext).where(RecognitionContext.recognition_id.in_(ids)))
        await db.execute(delete(RecognitionLog).where(RecognitionLog.id.in_(ids)))
        await db.commit()
        for row in rows:
            path = Path(row.image_path).resolve()
            if path.parent == IMAGE_DIR.resolve():
                path.unlink(missing_ok=True)
    return {"cleared": True}
