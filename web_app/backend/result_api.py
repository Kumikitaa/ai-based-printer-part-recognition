"""Persist recognition results and feedback; build downloads on the server."""
import csv
import io
import json
import secrets
import zipfile
from pathlib import Path

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import Column, Integer, String, JSON
from database import Base, SessionLocal

router = APIRouter(prefix="/api/results")

class RecognitionRecord(Base):
    __tablename__ = "recognition_records"
    id = Column(Integer, primary_key=True)
    owner = Column(String(64), nullable=False, index=True)
    payload = Column(JSON, nullable=False)
    image_path = Column(String, nullable=True)

def session():
    with SessionLocal() as db:
        yield db

def owner_key(response: Response, kamero_owner: str = Cookie(default="")):
    if len(kamero_owner) != 64:
        kamero_owner = secrets.token_hex(32)
        response.set_cookie("kamero_owner", kamero_owner, httponly=True,
                            samesite="strict", max_age=31536000)
    return kamero_owner

def find_record(db, record_id, owner):
    record = db.query(RecognitionRecord).filter_by(id=record_id, owner=owner).first()
    if record is None:
        raise HTTPException(404, "Recognition record not found.")
    return record

@router.get("")
def history(owner=Depends(owner_key), db=Depends(session)):
    records = db.query(RecognitionRecord).filter_by(owner=owner).order_by(RecognitionRecord.id.desc()).limit(100)
    return [{"id": row.id, **row.payload} for row in records]

@router.delete("")
def clear_history(owner=Depends(owner_key), db=Depends(session)):
    db.query(RecognitionRecord).filter_by(owner=owner).delete()
    db.commit()
    return {"cleared": True}

class Feedback(BaseModel):
    value: str = Field(max_length=100)

@router.put("/{record_id}/parts/{part_index}/feedback")
def feedback(record_id: int, part_index: int, body: Feedback,
             owner=Depends(owner_key), db=Depends(session)):
    record = find_record(db, record_id, owner)
    data = dict(record.payload)
    parts = [dict(part) for part in data["parts"]]
    if part_index < 0 or part_index >= len(parts):
        raise HTTPException(404, "Detection not found.")
    parts[part_index]["user_feedback"] = body.value or None
    data["parts"] = parts
    record.payload = data
    db.commit()
    return {"saved": True}

@router.get("/{record_id}/export")
def export(record_id: int, owner=Depends(owner_key), db=Depends(session)):
    record = find_record(db, record_id, owner)
    csv_file = io.StringIO()
    writer = csv.writer(csv_file)
    writer.writerow(["part_number", "description", "confidence", "user_feedback"])
    for part in record.payload["parts"]:
        # Keep spreadsheet programs from interpreting user feedback as formulas.
        cells = [part["part_number"], part["description"], part["confidence"], part.get("user_feedback") or ""]
        writer.writerow(["'" + x if isinstance(x, str) and x.startswith(("=", "+", "-", "@")) else x for x in cells])
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("results.json", json.dumps(record.payload, ensure_ascii=False, indent=2))
        archive.writestr("results.csv", "\ufeff" + csv_file.getvalue())
        if record.image_path and Path(record.image_path).is_file():
            archive.write(record.image_path, "annotated.jpg")
    output.seek(0)
    return StreamingResponse(output, media_type="application/zip",
                             headers={"Content-Disposition": 'attachment; filename="kamero-results.zip"'})
