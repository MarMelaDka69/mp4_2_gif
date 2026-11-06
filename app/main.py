import os
from pathlib import Path
from uuid import UUID, uuid4

from celery.result import AsyncResult
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.tasks import INPUT_DIR, OUTPUT_DIR, celery_app, convert_mp4_to_gif

app = FastAPI(title="Async MP4 to GIF", version="1.0.0")
STATIC_DIR = Path(__file__).resolve().parent / "static"
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def homepage():
    return FileResponse(STATIC_DIR / "index.html", media_type="text/html")


MAX_UPLOAD_BYTES = int(os.getenv("MAX_UPLOAD_MB", "50")) * 1024 * 1024


def valid_job_id(value: str) -> str:
    try:
        parsed = UUID(value)
        if str(parsed) != value or parsed.version != 4:
            raise ValueError("Not a canonical UUID4")
        return value
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid job ID")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/jobs", status_code=202)
async def create_job(file: UploadFile = File(...)):
    if Path(file.filename or "").suffix.lower() != ".mp4":
        raise HTTPException(400, "Only .mp4 files are accepted")
    job_id = str(uuid4())
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    target = INPUT_DIR / f"{job_id}.mp4"
    size = 0
    try:
        with target.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "File too large")
                out.write(chunk)
        if size == 0:
            raise HTTPException(400, "Empty file")
        # Celery messages contain only the ID, never the MP4 itself.
        convert_mp4_to_gif.apply_async(args=[job_id], task_id=job_id)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    return {"task_id": job_id, "status": "PENDING", "status_url": f"/jobs/{job_id}"}


@app.get("/jobs/{job_id}")
def job_status(job_id: str):
    valid_job_id(job_id)
    result = AsyncResult(job_id, app=celery_app)
    source = INPUT_DIR / f"{job_id}.mp4"
    destination = OUTPUT_DIR / f"{job_id}.gif"
    if not source.exists() and not destination.exists() and result.state == "PENDING":
        raise HTTPException(404, "Job not found")
    response = {"task_id": job_id, "status": result.state}
    if result.successful():
        response["download_url"] = f"/jobs/{job_id}/download"
    elif result.failed():
        response["error"] = str(result.result)
    return response


@app.get("/jobs/{job_id}/download")
def download(job_id: str):
    valid_job_id(job_id)
    result = AsyncResult(job_id, app=celery_app)
    destination = OUTPUT_DIR / f"{job_id}.gif"
    if not destination.is_file() or not result.successful():
        raise HTTPException(404, "GIF is not ready or result has expired")
    return FileResponse(destination, media_type="image/gif", filename=destination.name)
