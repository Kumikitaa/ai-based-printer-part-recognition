# Recognition demo
Run from the repository root:
    python -m pip install -r requirements-demo.txt
    python -m uvicorn demo_app:app --app-dir web_app/backend --host 127.0.0.1 --port 8002
Place the provided detection weights at models/best_v26_det.pt.
Open http://127.0.0.1:8002/.

The demo entry point serves the shared frontend. Photo selection calls /api/v1/validate. After successful validation, Start recognition sends the photo to /api/v1/analyze. The server validates again, runs YOLO, retrieves part details, and stores detections.
E731/E786 select catalogue lookup; both use the same legacy detector.
Current inputs are JPG/PNG up to 10 MB.
Local browser checks passed for a detected part, a blank PNG, and a damaged JPG.
This branch introduces demo_app.py separately because main.py contains existing classification endpoints.
Model weights and local databases are supplied separately.
