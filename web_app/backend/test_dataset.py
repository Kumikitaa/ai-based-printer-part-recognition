import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from database import Base, Part, DetectionLog
from dataset_catalog import import_inventory, summary, Dataset, DatasetAsset, DatasetPart, DatasetAssetPart
from dataset_api import router


def fixture():
    mapping = {"source": "test mapping", "parts": [
        {"part_no": n, "svc_number": f"TEST-{n}", "description": f"Part {n}"} for n in (1, 2)]}
    nodes = [{"id": "f", "name": "Part_1", "parent_id": "root", "mime_type": "application/vnd.google-apps.folder"}]
    for i in (1, 2):
        nodes.append({"id": str(i), "name": "1&2_1.mp4", "parent_id": "f", "mime_type": "video/mp4",
                      "size_bytes": 100, "url": f"https://drive.google.com/file/d/test{i}/view"})
    return {"schema_version": 1, "root_id": "root", "source_url": "https://drive.google.com/",
            "name": "test", "collected_at": "2026-10-15", "complete_listing": True, "nodes": nodes}, mapping


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_engine("sqlite:///" + str(Path(self.temp.name) / "test.db"),
                                    connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine)
        self.manifest, self.mapping = fixture()

    def tearDown(self):
        self.engine.dispose()
        self.temp.cleanup()

    def test_idempotency_separation_and_candidates(self):
        with self.sessions.begin() as db:
            db.add(Part(class_id=1, serial_number="TEST-1", part_desc="legacy"))
            db.add(DetectionLog(result=[{"class": 1}]))
            did = import_inventory(db, self.manifest, self.mapping)
            import_inventory(db, self.manifest, self.mapping)
            s = summary(db, did)
            self.assertEqual((s["files"], s["parts"], s["duplicate_candidate_groups"]), (2, 2, 1))
            self.assertEqual(db.query(DatasetAssetPart).count(), 4)
            self.assertEqual(db.query(Part).count(), 1)
            self.assertEqual(db.query(DetectionLog).count(), 1)
            self.assertEqual(s["annotation_status"], "not_provided")
            self.assertEqual(s["split_status"], "unassigned")

    def test_invalid_import_rolls_back(self):
        self.manifest["nodes"][-1]["name"] = "99_1.mp4"
        with self.assertRaises(ValueError), self.sessions.begin() as db:
            import_inventory(db, self.manifest, self.mapping)
        with self.sessions() as db:
            self.assertEqual(db.query(Dataset).count(), 0)
            self.assertEqual(db.query(DatasetAsset).count(), 0)

    def test_invalid_parent_duplicate_id_and_partial_listing(self):
        for change in ("parent", "duplicate", "partial"):
            bad = copy.deepcopy(self.manifest)
            if change == "parent": bad["nodes"][-1]["parent_id"] = "missing"
            if change == "duplicate": bad["nodes"].append(bad["nodes"][-1])
            if change == "partial": bad["complete_listing"] = False
            with self.assertRaises(ValueError), self.sessions.begin() as db:
                import_inventory(db, bad, self.mapping)

    def test_metadata_update_preserves_source_rows(self):
        with self.sessions.begin() as db:
            did = import_inventory(db, self.manifest, self.mapping)
            self.mapping["parts"][0]["description"] = "Updated"
            self.manifest["nodes"].pop()
            import_inventory(db, self.manifest, self.mapping)
            self.assertEqual(summary(db, did)["files"], 2)
            self.assertEqual(db.query(DatasetPart).filter_by(part_no=1).one().description, "Updated")

    def test_api_filters_pagination_and_errors(self):
        with self.sessions.begin() as db:
            did = import_inventory(db, self.manifest, self.mapping)
        app = FastAPI()
        app.include_router(router)
        with patch("database.SessionLocal", self.sessions), TestClient(app) as client:
            self.assertEqual(len(client.get("/api/datasets").json()["datasets"]), 1)
            base = f"/api/datasets/{did}"
            self.assertEqual(client.get(base + "/summary").json()["files"], 2)
            self.assertEqual(len(client.get(base + "/parts").json()["parts"]), 2)
            result = client.get(base + "/assets?part_no=2&limit=1&offset=1").json()
            self.assertEqual(result["total"], 2)
            self.assertEqual(len(result["assets"]), 1)
            self.assertEqual(len(result["assets"][0]["parts"]), 2)
            self.assertEqual(client.get(base + "/assets?part_no=3").json()["total"], 0)
            self.assertEqual(client.get(base + "/assets?limit=201").status_code, 422)
            self.assertEqual(client.get("/api/datasets/999/summary").status_code, 404)
