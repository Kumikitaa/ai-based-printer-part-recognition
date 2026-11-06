import uvicorn
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from catalogue_api import router
from detection_api import router as detection_router, load_detector
from database import engine, init_db
from result_api import router as result_router

FRONTEND = Path(__file__).resolve().parent / "../frontend"


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await init_db()
        await load_detector(app)
        yield
    finally:
        await engine.dispose()

app = FastAPI(title="System API", lifespan=lifespan)
app.include_router(router)
app.include_router(detection_router)
app.include_router(result_router)
app.mount("/assets", StaticFiles(directory=FRONTEND / "assets"), name="assets")


@app.get("/", include_in_schema=False)
async def frontend():
    return FileResponse(FRONTEND / "index.html")


# python -m uvicorn app:app --reload
if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
