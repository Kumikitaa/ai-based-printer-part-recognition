import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, String, DateTime, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import declarative_base, sessionmaker, mapped_column
from sqlalchemy.dialects.sqlite import JSON 

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

DB_PATH = os.path.join(DATA_DIR, "local.db")
DB_URL = f"sqlite:///{DB_PATH}"

@event.listens_for(Engine, "connect")
def sqlite_foreign_keys(connection, record):
    import sqlite3
    if isinstance(connection, sqlite3.Connection):
        connection.execute("PRAGMA foreign_keys=ON")


engine = create_engine(DB_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class Part(Base):
    __tablename__ = "parts"
    id = Column(Integer, primary_key=True, index=True)
    class_id = Column(Integer, unique=True, nullable=True, index=True)
    serial_number = Column(String(100), nullable=True)
    part_desc = Column(String(100), unique=True, nullable=False)


class DetectionLog(Base):
    __tablename__ = "detection_logs"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.now, nullable=False)
    image_url = Column(String(500), nullable=True)
    result = Column(JSON)


class ClassificationLog(Base):
    __tablename__ = "classification_logs"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.now, nullable=False)
    image_url = Column(String(500), nullable=True)
    result = mapped_column(JSON)


def init_db():
    import dataset_catalog  # Register additive dataset tables; legacy catalogue stays separate.
    Base.metadata.create_all(bind=engine)


def clear_detection_history(db):
    """Delete all detection logs, bounding boxes, and feedbacks. Parts are preserved."""
    db.query(ClassificationLog).delete()
    db.query(DetectionLog).delete()
    db.commit()


if __name__ == "__main__":
    init_db()
    print(f"DB initialized: {DB_PATH}")
