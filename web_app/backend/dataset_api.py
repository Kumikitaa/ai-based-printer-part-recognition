"""Read-only dataset API, usable without loading recognition weights."""
from fastapi import APIRouter, Depends, HTTPException, Query
import database
from dataset_catalog import Dataset, DatasetPart, DatasetFolder, DatasetAsset, DatasetAssetPart, summary

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


def session():
    with database.SessionLocal() as db:
        yield db


def require_dataset(db, dataset_id):
    if db.get(Dataset, dataset_id) is None:
        raise HTTPException(404, "Dataset not found")


@router.get("")
def datasets(db=Depends(session)):
    return {"datasets": [{"id": d.id, "name": d.name, "collected_at": d.collected_at,
                           "mapping_source": d.mapping_source} for d in db.query(Dataset).order_by(Dataset.id)]}


@router.get("/{dataset_id}/summary")
def dataset_summary(dataset_id: int, db=Depends(session)):
    require_dataset(db, dataset_id)
    return summary(db, dataset_id)


@router.get("/{dataset_id}/parts")
def parts(dataset_id: int, db=Depends(session)):
    require_dataset(db, dataset_id)
    return {"parts": [{"part_no": p.part_no, "svc_number": p.svc_number, "description": p.description}
                     for p in db.query(DatasetPart).filter_by(dataset_id=dataset_id).order_by(DatasetPart.part_no)]}


@router.get("/{dataset_id}/assets")
def assets(dataset_id: int, part_no: int | None = Query(None, ge=1),
           offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200), db=Depends(session)):
    require_dataset(db, dataset_id)
    query = db.query(DatasetAsset).filter_by(dataset_id=dataset_id)
    if part_no is not None:
        query = query.filter(DatasetAsset.id.in_(
            db.query(DatasetAssetPart.asset_id).join(DatasetPart).filter(
                DatasetPart.dataset_id == dataset_id, DatasetPart.part_no == part_no)))
    total = query.count()
    rows = query.order_by(DatasetAsset.id).offset(offset).limit(limit).all()
    folders = {f.id: f.name for f in db.query(DatasetFolder).filter_by(dataset_id=dataset_id)}
    result = []
    for a in rows:
        inferred = db.query(DatasetPart.part_no, DatasetAssetPart.evidence).join(
            DatasetAssetPart, DatasetAssetPart.part_id == DatasetPart.id).filter(
                DatasetAssetPart.asset_id == a.id).order_by(DatasetPart.part_no).all()
        result.append({"id": a.id, "name": a.name, "folder": folders[a.folder_id],
                       "size_bytes": a.size_bytes, "source_url": a.source_url,
                       "candidate_group": a.candidate_group, "content_verified": False,
                       "parts": [{"part_no": n, "evidence": e} for n, e in inferred]})
    return {"total": total, "offset": offset, "limit": limit, "assets": result}
