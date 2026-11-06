"""API/SQLite integration tests with deterministic detections, not accuracy tests."""
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import zipfile

from fastapi.testclient import TestClient
from PIL import Image
import pytest

TEST_DATA = tempfile.TemporaryDirectory(prefix="kamero-tests-")
os.environ["KAMERO_DATA_DIR"] = TEST_DATA.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "web_app/backend"))
import app as application
import result_api
from database import db_path


class FakeDetector:
    names = {17: "3SJ00-60110"}
    version = "test-double-not-a-real-model"
    empty = False

    def predict(self, image, allowed):
        assert allowed == [17]
        if self.empty:
            return []
        return [{"class_id": 17, "confidence": .91, "bbox_norm": [.5, .5, .4, .2]},
                {"class_id": 17, "confidence": .72, "bbox_norm": [.2, .2, .1, .1]}]


def png():
    stream = io.BytesIO()
    Image.new("RGB", (100, 80), "white").save(stream, format="PNG")
    return stream.getvalue()


def upload(client, content=None, model="E877"):
    return client.post("/detect", data={"printer_model": model},
        files={"file": ("test.png", png() if content is None else content, "image/png")})


def counts():
    with sqlite3.connect(db_path) as db:
        return [db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in
                ("recognition_logs", "part_predictions", "recognition_contexts", "prediction_feedback")]


def test_full_persistence_workflow(monkeypatch):
    detector = FakeDetector()
    async def load(app):
        app.state.e877_detector = detector
    monkeypatch.setattr(application, "load_detector", load)
    with TestClient(application.app) as client:
        # A part may be compatible with more than the selected recognition model.
        with sqlite3.connect(db_path) as db:
            db.execute("INSERT OR IGNORE INTO part_compatibilities(part_id, printer_model_id) "
                       "SELECT p.id,m.id FROM printer_parts p,printer_models m "
                       "WHERE p.serial_number='3SJ00-60110' AND m.name='E731'")
        baseline = counts()
        for payload, model, status in [(b"not an image", "E877", 400),
                                        (b"", "E877", 400), (png(), "E786", 400),
                                        (b"x" * (10 * 1024 * 1024 + 1), "E877", 413)]:
            assert upload(client, payload, model).status_code == status
        assert counts() == baseline
        response = upload(client)
        assert response.status_code == 200, response.text
        record = response.json()
        record_id = record["record_id"]
        prediction = record["parts"][0]
        pid = prediction["prediction_id"]
        assert prediction["compatibility"] == ["E731", "E877"]
        assert prediction["bbox_xyxy_pixels"] == pytest.approx([30, 32, 70, 48])
        assert prediction["bbox_norm"] == pytest.approx([.5, .5, .4, .2])
        assert counts() == [baseline[0]+1, baseline[1]+2, baseline[2]+1, baseline[3]]
        feedback_url = f"/api/results/{record_id}/predictions/{pid}/feedback"
        assert client.put(feedback_url, json={"value": "bad-part"}).status_code == 422
        assert client.put(feedback_url, json={"value": "3SJ00-60110"}).status_code == 200
        assert client.get(f"/api/results/{record_id}").json()["parts"][0]["user_feedback"] == "3SJ00-60110"
        assert client.put(feedback_url, json={"value": ""}).status_code == 200
        assert client.get(f"/api/results/{record_id}").json()["parts"][0]["user_feedback"] is None
        assert client.put(feedback_url, json={"value": "none"}).status_code == 200
        assert client.get(f"/api/results/{record_id}").json()["parts"][0]["user_feedback"] == "none"
        archive = zipfile.ZipFile(io.BytesIO(client.get(f"/api/results/{record_id}/export").content))
        assert set(archive.namelist()) == {"results.json", "results.csv", "annotated.png"}
        assert json.loads(archive.read("results.json"))["parts"][0]["user_feedback"] == "none"
        assert "none" in archive.read("results.csv").decode("utf-8-sig")
        Image.open(io.BytesIO(archive.read("annotated.png"))).verify()
        assert client.get(record["image_url"]).status_code == 200
        cookies = dict(client.cookies)
        # Empty recognition is persisted, and its predictions table has no rows.
        detector.empty = True
        empty = upload(client).json()
        assert empty["status"] == "no-detection" and empty["parts"] == []
        assert client.put(f'/api/results/{empty["record_id"]}/predictions/{pid}/feedback',
                          json={"value": "none"}).status_code == 404
        # Database failure must roll back the recognition and remove its image.
        before_images = set(result_api.IMAGE_DIR.glob("*.png"))
        before_counts = counts()
        original = result_api.result_data
        async def fail(*args):
            from sqlalchemy.exc import SQLAlchemyError
            raise SQLAlchemyError("injected failure")
        monkeypatch.setattr(result_api, "result_data", fail)
        assert upload(client).status_code == 503
        monkeypatch.setattr(result_api, "result_data", original)
        assert counts() == before_counts
        assert set(result_api.IMAGE_DIR.glob("*.png")) == before_images
    # A new application lifespan still sees stored results with the same browser cookie.
    with TestClient(application.app) as restarted:
        restarted.cookies.update(cookies)
        history = restarted.get("/api/results").json()
        assert any(r["record_id"] == record_id for r in history)
        assert restarted.get(f"/api/results/{record_id}").json()["parts"][0]["user_feedback"] == "none"
        # A different browser cannot read, export, edit, or delete our records.
        restarted.cookies.clear()
        assert restarted.get("/api/results").json() == []
        for suffix in ("", "/image", "/export"):
            assert restarted.get(f"/api/results/{record_id}" + suffix).status_code == 404
        assert restarted.put(feedback_url, json={"value": "none"}).status_code == 404
        assert restarted.delete("/api/results").status_code == 200
        assert counts() == before_counts
        restarted.cookies.update(cookies)
        assert restarted.delete("/api/results").status_code == 200
        assert counts() == baseline
        assert not list(result_api.IMAGE_DIR.glob("*.png"))
        assert restarted.get(f"/api/results/{record_id}").status_code == 404
        with sqlite3.connect(db_path) as db:
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            assert db.execute("SELECT COUNT(*) FROM printer_parts").fetchone()[0] == 86
