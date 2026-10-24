"""Dataset metadata only: importing this module never downloads or runs a model."""
import argparse
import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Column, Integer, String, ForeignKey, UniqueConstraint, Boolean, func
from database import Base, SessionLocal, engine, init_db


class Dataset(Base):
    __tablename__ = "datasets"
    id = Column(Integer, primary_key=True)
    source_id = Column(String, unique=True, nullable=False)
    name = Column(String, nullable=False)
    source_url = Column(String, nullable=False)
    collected_at = Column(String, nullable=False)
    manifest_sha256 = Column(String, nullable=False)
    mapping_sha256 = Column(String, nullable=False)
    mapping_source = Column(String, nullable=False)
    complete_listing = Column(Boolean, nullable=False)


class DatasetPart(Base):
    __tablename__ = "dataset_parts"
    id = Column(Integer, primary_key=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), nullable=False, index=True)
    part_no = Column(Integer, nullable=False)
    svc_number = Column(String, nullable=False)
    description = Column(String, nullable=False)
    __table_args__ = (UniqueConstraint("dataset_id", "part_no"),)


class DatasetFolder(Base):
    __tablename__ = "dataset_folders"
    id = Column(Integer, primary_key=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), nullable=False, index=True)
    remote_id = Column(String, nullable=False)
    name = Column(String, nullable=False)
    __table_args__ = (UniqueConstraint("dataset_id", "remote_id"),)


class DatasetAsset(Base):
    __tablename__ = "dataset_assets"
    id = Column(Integer, primary_key=True)
    dataset_id = Column(Integer, ForeignKey("datasets.id"), nullable=False, index=True)
    folder_id = Column(Integer, ForeignKey("dataset_folders.id"), nullable=False)
    remote_id = Column(String, nullable=False)
    name = Column(String, nullable=False)
    mime_type = Column(String, nullable=False)
    size_bytes = Column(Integer, nullable=False)
    source_url = Column(String, nullable=False)
    modified_time = Column(String)
    # A conservative grouping hint, NOT a content checksum or proven duplicate.
    candidate_group = Column(String, nullable=False, index=True)
    __table_args__ = (UniqueConstraint("dataset_id", "remote_id"),)


class DatasetAssetPart(Base):
    __tablename__ = "dataset_asset_parts"
    asset_id = Column(Integer, ForeignKey("dataset_assets.id"), primary_key=True)
    part_id = Column(Integer, ForeignKey("dataset_parts.id"), primary_key=True)
    evidence = Column(String, nullable=False)  # filename / folder; never visual annotation


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def validate(manifest, mapping):
    if manifest.get("schema_version") != 1 or manifest.get("complete_listing") is not True:
        raise ValueError("A complete schema_version=1 inventory is required.")
    for field in ("root_id", "source_url", "name", "collected_at"):
        if not isinstance(manifest.get(field), str) or not manifest[field]:
            raise ValueError(f"Missing manifest field: {field}")
    rows = mapping["parts"]
    numbers = [r["part_no"] for r in rows]
    if not numbers or len(set(numbers)) != len(numbers) or any(type(n) is not int or n < 1 for n in numbers):
        raise ValueError("Part numbers must be unique positive integers.")
    if not mapping.get("source") or any(not r.get("svc_number") or not r.get("description") for r in rows):
        raise ValueError("Mapping source, SVC number and description are required.")
    nodes = manifest["nodes"]
    ids = [n["id"] for n in nodes]
    if len(ids) != len(set(ids)):
        raise ValueError("Duplicate remote IDs in inventory.")
    folders = {n["id"]: n for n in nodes if n["mime_type"] == "application/vnd.google-apps.folder"}
    for n in nodes:
        if not n["id"] or not n["name"]:
            raise ValueError("Empty node ID/name.")
        if n["id"] in folders:
            if n["parent_id"] != manifest["root_id"]:
                raise ValueError("This importer expects one level of source folders.")
        elif n["parent_id"] not in folders or type(n["size_bytes"]) is not int or n["size_bytes"] < 0:
            raise ValueError("Invalid file parent or size.")
    return folders


def inferred_numbers(filename, folder, known):
    match = re.fullmatch(r"(\d+(?:[&-]\d+)*)_\d+\.mp4", filename, flags=re.I)
    if match:
        numbers = set(map(int, re.split(r"[&-]", match[1])))
        if not numbers <= known:
            raise ValueError(f"Filename refers to an unknown part: {filename}")
        return numbers, "filename"
    match = re.fullmatch(r"Part_(\d+)", folder)
    if match:
        number = int(match[1])
        if number not in known:
            raise ValueError(f"Unknown folder part: {folder}")
        return {number}, "folder"
    return set(), "unassigned"


def import_inventory(db, manifest, mapping):
    """Caller owns the transaction. Re-import updates metadata without deleting source rows."""
    folders = validate(manifest, mapping)
    dataset = db.query(Dataset).filter_by(source_id=manifest["root_id"]).one_or_none()
    if dataset is None:
        dataset = Dataset(source_id=manifest["root_id"])
        db.add(dataset)
    dataset.name = manifest["name"]
    dataset.source_url = manifest["source_url"]
    dataset.collected_at = manifest["collected_at"]
    dataset.manifest_sha256 = digest(manifest)
    dataset.mapping_sha256 = digest(mapping)
    dataset.mapping_source = mapping["source"]
    dataset.complete_listing = True
    db.flush()
    parts = {p.part_no: p for p in db.query(DatasetPart).filter_by(dataset_id=dataset.id)}
    for row in mapping["parts"]:
        part = parts.get(row["part_no"])
        if part is None:
            part = DatasetPart(dataset_id=dataset.id, part_no=row["part_no"])
            db.add(part)
            parts[part.part_no] = part
        part.svc_number, part.description = row["svc_number"], row["description"]
    db.flush()
    folder_rows = {f.remote_id: f for f in db.query(DatasetFolder).filter_by(dataset_id=dataset.id)}
    for remote_id, node in folders.items():
        folder = folder_rows.get(remote_id)
        if folder is None:
            folder = DatasetFolder(dataset_id=dataset.id, remote_id=remote_id)
            db.add(folder)
            folder_rows[remote_id] = folder
        folder.name = node["name"]
    db.flush()
    assets = {a.remote_id: a for a in db.query(DatasetAsset).filter_by(dataset_id=dataset.id)}
    # Existing source rows absent from a new listing are retained; never silently remove data.
    for node in manifest["nodes"]:
        if node["id"] in folders:
            continue
        asset = assets.get(node["id"])
        if asset is None:
            asset = DatasetAsset(dataset_id=dataset.id, remote_id=node["id"])
            db.add(asset)
        asset.folder_id = folder_rows[node["parent_id"]].id
        asset.name, asset.mime_type, asset.size_bytes = node["name"], node["mime_type"], node["size_bytes"]
        asset.source_url, asset.modified_time = node["url"], node.get("modified_time")
        asset.candidate_group = digest([node["name"], node["size_bytes"]])
        db.flush()
        db.query(DatasetAssetPart).filter_by(asset_id=asset.id).delete()
        numbers, evidence = inferred_numbers(node["name"], folders[node["parent_id"]]["name"], set(parts))
        for number in numbers:
            db.add(DatasetAssetPart(asset_id=asset.id, part_id=parts[number].id, evidence=evidence))
    db.flush()
    return dataset.id


def summary(db, dataset_id):
    assets = db.query(DatasetAsset).filter_by(dataset_id=dataset_id)
    groups = (db.query(DatasetAsset.candidate_group, func.count(DatasetAsset.id))
              .filter_by(dataset_id=dataset_id).group_by(DatasetAsset.candidate_group).all())
    return {
        "dataset_id": dataset_id,
        "parts": db.query(DatasetPart).filter_by(dataset_id=dataset_id).count(),
        "folders": db.query(DatasetFolder).filter_by(dataset_id=dataset_id).count(),
        "files": assets.count(),
        "total_bytes": db.query(func.coalesce(func.sum(DatasetAsset.size_bytes), 0)).filter(
            DatasetAsset.dataset_id == dataset_id).scalar(),
        "candidate_groups": len(groups),
        "duplicate_candidate_groups": sum(count > 1 for _, count in groups),
        "unassigned_files": assets.filter(~DatasetAsset.id.in_(db.query(DatasetAssetPart.asset_id))).count(),
        "download_status": "metadata_only",
        "annotation_status": "not_provided",
        "split_status": "unassigned",
        "part_evidence": "document mapping; video contents not visually verified",
    }


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inventory", type=Path)
    parser.add_argument("--mapping", type=Path, default=Path(__file__).parent / "catalogs/e783_parts.json")
    args = parser.parse_args()
    manifest = json.loads(args.inventory.read_text(encoding="utf-8"))
    mapping = json.loads(args.mapping.read_text(encoding="utf-8"))
    validate(manifest, mapping)
    db_path = Path(engine.url.database)
    if db_path.exists():
        backup = db_path.parent / "backups"
        backup.mkdir(exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        with sqlite3.connect(db_path) as source, sqlite3.connect(backup / f"before_dataset_{stamp}.db") as target:
            source.backup(target)
    init_db()
    with SessionLocal.begin() as db:
        dataset_id = import_inventory(db, manifest, mapping)
        print(json.dumps(summary(db, dataset_id), indent=2))

