import os
from datetime import datetime, timezone
import asyncio
from typing import List
from sqlalchemy import String, DateTime, JSON, text, ForeignKey
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Create directory where database will reside
db_directory = os.path.join(os.path.dirname(os.path.abspath(__file__)), "database")
if not os.path.exists(db_directory):
    os.makedirs(db_directory)

# Establish connections
db_path = os.path.join(db_directory, "PrinterPartCatalogue.db")

engine = create_async_engine(f"sqlite+aiosqlite:///{db_path}")
async def check_connection():
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))
        print("Connection successful")

# Asynchronous database session for FastAPI integration
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False
)

# Database Tables
class Base(DeclarativeBase):
    pass


class PrinterModel(Base):
    __tablename__ = "printer_models"
    id: Mapped[int] = mapped_column(primary_key=True)                           # Primary key
    name: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)  # Printer model name (e.g., E731)


class PrinterPart(Base):
    __tablename__ = "printer_parts"
    id: Mapped[int] = mapped_column(primary_key=True)                               # Primary key
    class_id: Mapped[int] = mapped_column(unique=True, nullable=False, index=True)  # ID number which AI model uses to identify a type of printer part (e.g., 1 = Imaging drum)
    serial_number: Mapped[str] = mapped_column(String(30), nullable=False)          # Serial number used to distinguish between printer parts (e.g., 5QJ98-60111)
    part_desc: Mapped[str] = mapped_column(String(100), nullable=False)             # Description used to characterize printer part (e.g., Exit unit)


# Association table between PrinterModel and PrinterPart tables
class PartCompatibility(Base):
    __tablename__ = "part_compatibilities"
    part_id: Mapped[int] = mapped_column(ForeignKey("printer_parts.id", ondelete="CASCADE"), primary_key=True)            # First Foreign key = PrinterPart's Primary key
    printer_model_id: Mapped[int] = mapped_column(ForeignKey("printer_models.id", ondelete="CASCADE"), primary_key=True)  # Second Foreign key = PrinterModel's Primary key


class RecognitionLog(Base):
    __tablename__ = "recognition_logs"
    id: Mapped[int] = mapped_column(primary_key=True)                                                                                           # Primary key
    printer_model_id: Mapped[int] = mapped_column(ForeignKey("printer_models.id", ondelete="RESTRICT"), nullable=False, index=True)      # Printer model upon which recognition was done
    created_date: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc).replace(tzinfo=None), nullable=False)   # Time recognition was performed
    image_path: Mapped[str] = mapped_column(String(500), nullable=False)                                                                        # Path to an image
    image_dimensions: Mapped[List[int]] = mapped_column(JSON)                                                                                   # Width and height of an image
    status: Mapped[str] = mapped_column(String(50))                                                                                             # Status (e.g., no-detection or completed)


class PartPrediction(Base):
    __tablename__ = "part_predictions"
    id: Mapped[int] = mapped_column(primary_key=True)                                                                                       # Primary key
    recognition_id: Mapped[int] = mapped_column(ForeignKey("recognition_logs.id", ondelete="RESTRICT"), nullable=False, index=True)  # Foreign key = RecognitionLog's Primary Key
    part_id: Mapped[int] = mapped_column(ForeignKey("printer_parts.id", ondelete="RESTRICT"), nullable=False, index=True)            # Foreign key = PrinterPart's Primary Key
    bounding_box_cords: Mapped[List[float]] = mapped_column(JSON, nullable=False)                                                           # Coordinates of a bounding box (x_min, y_min, x_max, y_max)
    detector_confidence: Mapped[float] = mapped_column(nullable=False)                                                                      # Confidence score from detection module
    classifier_confidence: Mapped[float] = mapped_column(nullable=True)                                                                     # Confidence score from classification module


# Initialize database (create tables, assign relationships)
async def init_db():
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

# Main function
async def main():
    try:
        await check_connection()
        await init_db()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
