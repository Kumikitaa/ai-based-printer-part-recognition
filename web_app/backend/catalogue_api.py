import logging
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from database import AsyncSessionLocal, PartCompatibility, PrinterModel, PrinterPart

router = APIRouter(prefix="/api", tags=["Catalogue"])
logger = logging.getLogger(__name__)


async def get_session() -> AsyncIterator[AsyncSession]:
    try:
        async with AsyncSessionLocal() as session:
            yield session
    except SQLAlchemyError as exc:
        logger.exception("Catalogue database query failed")
        raise HTTPException(503, "Catalogue database unavailable. Check database setup and try again.") from exc


Session = Annotated[AsyncSession, Depends(get_session)]


class ModelSummary(BaseModel):
    id: int
    name: str
    part_count: int


class CompatibleModel(BaseModel):
    id: int
    name: str


class PartPreview(BaseModel):
    id: int
    class_id: int
    serial_number: str
    part_desc: str
    compatible_models: list[CompatibleModel]


class CataloguePage(BaseModel):
    items: list[PartPreview]
    total: int
    page: int
    page_size: int


@router.get("/health")
async def health(session: Session):
    for table in (PrinterModel, PrinterPart, PartCompatibility):
        await session.execute(select(table).limit(1))
    return {"status": "ok", "service": "catalogue"}


@router.get("/models", response_model=list[str])
async def recognition_models(session: Session):
    return (await session.scalars(select(PrinterModel.name).order_by(PrinterModel.name))).all()


@router.get("/catalogue/models", response_model=list[ModelSummary])
async def catalogue_models(session: Session):
    rows = await session.execute(
        select(PrinterModel.id, PrinterModel.name,
               func.count(PartCompatibility.part_id).label("part_count"))
        .outerjoin(PartCompatibility, PartCompatibility.printer_model_id == PrinterModel.id)
        .group_by(PrinterModel.id, PrinterModel.name)
        .order_by(PrinterModel.name)
    )
    return rows.mappings().all()


@router.get("/catalogue/parts", response_model=CataloguePage)
async def catalogue_parts(session: Session, q: Annotated[str, Query(max_length=200)] = "",
                          model_id: Annotated[int | None, Query(ge=1)] = None, page: Annotated[int, Query(ge=1)] = 1,
                          page_size: Annotated[int, Query(ge=1, le=100)] = 20,):
    filters = []

    if model_id is not None:
        if await session.get(PrinterModel, model_id) is None:
            raise HTTPException(404, "Printer model not found.")

        filters.append(select(PartCompatibility.part_id).where(
            PartCompatibility.part_id == PrinterPart.id,
            PartCompatibility.printer_model_id == model_id
        ).exists())

    if search := q.strip():
        escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{escaped}%"
        filters.append(or_(PrinterPart.serial_number.ilike(pattern, escape="\\"),
                           PrinterPart.part_desc.ilike(pattern, escape="\\")))

    total = await session.scalar(select(func.count()).select_from(PrinterPart).where(*filters))
    parts = (await session.scalars(
        select(PrinterPart).where(*filters)
        .order_by(PrinterPart.serial_number, PrinterPart.id)
        .offset((page - 1) * page_size).limit(page_size)
    )).all()

    compatible = {part.id: [] for part in parts}

    if parts:
        rows = await session.execute(
            select(PartCompatibility.part_id, PrinterModel.id, PrinterModel.name)
            .join(PrinterModel, PrinterModel.id == PartCompatibility.printer_model_id)
            .where(PartCompatibility.part_id.in_(compatible))
            .order_by(PrinterModel.name)
        )
        for part_id, printer_id, name in rows:
            compatible[part_id].append(CompatibleModel(id=printer_id, name=name))

    return CataloguePage(
        items=[PartPreview(id=p.id, class_id=p.class_id, serial_number=p.serial_number,
                           part_desc=p.part_desc, compatible_models=compatible[p.id]) for p in parts],
        total=total, page=page, page_size=page_size,
    )