# Kamero web app: E877 recognition and saved results

This integration builds on shared `main` commit `22f8852`. It preserves Kirill's async
SQLAlchemy engine, sessions, catalogue API and five database tables. Recognition is
still limited to **E877** using the existing detection weights. No classifier or
new E731/E786 model has been added.

## Run locally

From the repository root (Python 3.13 was used for verification):

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r web_app/backend/requirements
.\.venv\Scripts\python -m uvicorn app:app --app-dir web_app/backend --host 127.0.0.1 --port 8004
```

Open http://127.0.0.1:8004/. Keep the terminal running. This address is local to your
computer, not a public deployment. The checkpoint must be at `models/best_v26_det.pt`.
The model path now resolves from the repository root regardless of working directory.

## Database and storage

On first startup the bundled catalogue is copied to `web_app/backend/runtime/`.
The tracked source database is not modified. Set `KAMERO_DATA_DIR` to an absolute
directory if you want a different persistent location; protect/back up this directory.
It contains `PrinterPartCatalogue.db` and `images/`.

Startup creates missing tables without dropping the catalogue or changing the
columns of Kirill's five tables. Two additive tables are registered:

| Table | Purpose |
|---|---|
| `recognition_logs` | One image recognition: selected printer, date, original decoded image, dimensions, status |
| `part_predictions` | One row per detected part, referencing the log and catalogue part |
| `recognition_contexts` (new) | One-to-one log metadata: browser owner hash, original filename, model version |
| `prediction_feedback` (new) | One current correction per prediction, with update timestamp |

Existing `printer_parts`, `printer_models`, and `part_compatibilities` remain the
source of catalogue information. Compatibility returned to the UI includes every
linked printer, not just the selected E877 model.

A no-detection upload creates one log and zero prediction rows. The database stores
bounding boxes as **pixel `[x_min,y_min,x_max,y_max]`** in `bounding_box_cords` (existing
column spelling retained). API responses also supply normalized centre
`[cx,cy,width,height]` in `bbox_norm`. Detector labels are matched to part numbers;
catalogue `class_id` is not assumed to equal a detector index.

The runtime copy is initialized only once. Later changes to the bundled catalogue
do not automatically overwrite an existing runtime database. Back up runtime data
and use a reviewed catalogue import/migration when updating it. Old browser-only
history and the separate legacy `RecognitionRecord` database are not migrated.

## Request flow

1. `main.js` checks file type/size and prepares a preview; it submits the original image.
2. `POST /detect` checks E877, the 10 MiB limit, actual JPEG/PNG content and the
   existing 20-million-pixel limit. Pillow fixes EXIF orientation and converts RGB.
3. YOLO runs in a worker thread with the existing inference lock and E877 class filter.
4. Python saves a normalized PNG and writes one log, its context and N predictions
   in one DB transaction. On a persistence failure, the transaction rolls back and
   the newly created image is removed.
5. The response supplies record/prediction IDs, descriptions, compatibility and boxes.
   JavaScript displays the image, highlights boxes and sends correction requests.

There is no separate server pre-validation endpoint in this version: the server
validates on `POST /detect` before inference. The UI preview does not mean the server
has already accepted the file.

## Saved-result API

| Method and path | Purpose |
|---|---|
| `GET /api/results` | Latest 100 recognitions for this browser |
| `GET /api/results/{id}` | Reopen one saved result |
| `GET /api/results/{id}/image` | Owner-checked decoded original image |
| `PUT /api/results/{id}/predictions/{prediction_id}/feedback` | JSON `{"value":"PART-NUMBER"}`, `"none"` for unknown, `""` to clear |
| `GET /api/results/{id}/export` | Python-generated ZIP with `annotated.png`, `results.json`, `results.csv` |
| `DELETE /api/results` | Delete this browser's logs, predictions, feedback, contexts and image files |

Feedback uses a stable database prediction ID, so sorting the UI by confidence does
not attach corrections to a different part. It does not overwrite the model prediction,
change catalogue information or retrain the model. Corrections must be reviewed before
use as labels. ZIP annotations are regenerated in Python; they do not include the UI's
current zoom or selection highlight.

An HttpOnly, SameSite cookie identifies a browser; only its hash is stored in the DB.
This is not account authentication or cross-device history. Losing the cookie loses
access to the old records. Existing unowned logs are not exposed. Public production
deployment still needs a retention policy, resource limits and account/access design.

## Verification and demo

```powershell
.\.venv\Scripts\python -m pip install pytest httpx
.\.venv\Scripts\python -m pytest tests/test_saved_results.py -q
```

The deterministic integration test uses an isolated catalogue copy and covers multiple
predictions, coordinate conversion, compatibility, invalid uploads, corrections,
restart persistence, ZIP content, owner isolation, rollback and complete record deletion.
It does not measure model accuracy.

Actual browser verification on 2026-11-06 used `5456.jpg`: YOLO detected
`3SJ00-60110` at confidence `0.9519677162`. Upload, DB rows, correction persistence after
reload, reopening the image, ZIP JSON/CSV/PNG and denial to another browser passed.
A blank image produced a saved no-detection result. A malformed JPG could not enable
recognition. No labelled accuracy/precision/recall or full printer coverage is claimed.

For a live demo: select E877, upload a supported sample, start recognition, select a
correction, reload, open History, choose Open result, and download its ZIP. Do not use
`?demo` to demonstrate real inference: that mode is simulated and cannot persist results.

## Code walkthrough

1. `frontend/assets/scripts/main.js`: `setFile`, `callApi`, `show` — upload and rendering.
2. `backend/detection_api.py`: `decode_image`, `detect` — checks, inference and persistence call.
3. `backend/result_api.py`: `save_recognition`, `result_data` — DB transaction and response.
4. `backend/result_api.py`: `feedback`, `export`, `clear_history` — saved-result operations.
5. `frontend/assets/scripts/main.js`: `openHistory`, `renderHistory`, `feedbackUI` — API callers.

Korean presenter notes: [INTEGRATION_KO.md](INTEGRATION_KO.md).
