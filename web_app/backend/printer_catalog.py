"""Printer-scoped source catalogue. Folder indices are never model class IDs."""
import csv
from pathlib import Path
from sqlalchemy import Column, Integer, String, UniqueConstraint
from database import Base


class PrinterPart(Base):
    __tablename__ = "printer_parts"
    id = Column(Integer, primary_key=True)
    printer_model = Column(String, nullable=False, index=True)
    part_no = Column(Integer, nullable=False)
    part_number = Column(String, nullable=False, index=True)
    description = Column(String, nullable=False)
    __table_args__ = (UniqueConstraint("printer_model", "part_no"),)


def seed_printer_catalog(db):
    for model in ("E731", "E786"):
        path = Path(__file__).parent / "catalogs" / f"{model}_source.csv"
        with path.open(encoding="utf-8-sig", newline="") as source:
            for row in csv.DictReader(source):
                number = int(row["Part No."])
                part = db.query(PrinterPart).filter_by(printer_model=model, part_no=number).one_or_none()
                if part is None:
                    part = PrinterPart(printer_model=model, part_no=number)
                    db.add(part)
                part.part_number = row["SVC Part Number"].strip()
                part.description = row["Part Description"].strip()
    db.commit()
