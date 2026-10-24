import json
import unittest
from pathlib import Path


class PublicExportTests(unittest.TestCase):
    def test_public_snapshot_contract(self):
        root = Path(__file__).resolve().parent.parent
        data = json.loads((root / "docs/catalogue.json").read_text(encoding="utf-8"))
        self.assertEqual(set(data), {"datasets", "details"})
        for dataset in data["datasets"]:
            detail = data["details"][str(dataset["id"])]
            self.assertEqual(len(detail["parts"]), detail["summary"]["parts"])
            self.assertEqual(len(detail["assets"]), detail["summary"]["files"])
            known = {p["part_no"] for p in detail["parts"]}
            for asset in detail["assets"]:
                self.assertEqual(set(asset), {"name", "folder", "size_bytes", "source_url", "parts"})
                self.assertTrue(asset["source_url"].startswith("https://drive.google.com/"))
                self.assertTrue({p["part_no"] for p in asset["parts"]} <= known)
