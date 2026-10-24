r"""Run with .venv\Scripts\python.exe -m unittest discover -s app -p test_integration.py."""
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import database
import main


class Array:
    def __init__(self, values): self.values = np.array(values)
    def cpu(self): return self
    def numpy(self): return self.values


class Boxes:
    xywhn = Array([[.5, .5, .4, .2], [.2, .2, .1, .1]])
    conf = Array([.92, .45])
    cls = Array([0, 999])


class Result:
    boxes = Boxes()
    names = {0: "0", 999: "unmapped"}
    def plot(self): return np.zeros((100, 200, 3), dtype=np.uint8)


class IntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.engine = create_engine('sqlite:///' + str(Path(cls.temp.name) / 'test.db'),
                                   connect_args={'check_same_thread': False})
        database.engine = cls.engine
        database.SessionLocal = sessionmaker(bind=cls.engine)
        main.SessionLocal = database.SessionLocal
        main.IMAGES_DIR = cls.temp.name
        cls.client = TestClient(main.app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        cls.engine.dispose()
        cls.temp.cleanup()

    def upload(self, content=None, **data):
        if content is None:
            buf = io.BytesIO()
            Image.new('RGB', (200, 100), 'white').save(buf, format='PNG')
            content = buf.getvalue()
        return self.client.post('/detect', files={'file': ('test.png', content, 'image/png')}, data=data)

    def test_static_catalogue_and_scope(self):
        for route in ['/', '/static/kamero.js', '/static/kamero.css', '/api/health']:
            self.assertEqual(self.client.get(route).status_code, 200)
        self.assertEqual(len(self.client.get('/api/parts').json()['parts']), 40)
        self.assertFalse(self.client.get('/api/models').json()['filtering_supported'])

    def test_detection_contract_and_persistence(self):
        with patch.object(main, 'model_det', return_value=[Result()]):
            response = self.upload(printer_model=main.PRINTER_SCOPE)
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data['parts'][0]['part_number'], '5PN77-67001')
        self.assertEqual(data['parts'][0]['bbox_norm'], [.5, .5, .4, .2])
        self.assertEqual(data['parts'][1]['part_number'], 'unmapped')
        with database.SessionLocal() as db:
            self.assertIsNotNone(db.get(database.DetectionLog, data['record_id']))

    def test_invalid_uploads(self):
        self.assertEqual(self.upload(b'not an image').status_code, 415)
        self.assertEqual(self.upload(b'x' * (main.MAX_UPLOAD_BYTES + 1)).status_code, 413)
        self.assertEqual(self.upload(printer_model='invented printer').status_code, 422)

    def test_real_model_inference(self):
        response = self.upload()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('parts', response.json())
        self.assertEqual(response.json()['model_version'], 'best_v26_det.pt')


if __name__ == '__main__':
    unittest.main()
