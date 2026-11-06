import os
import subprocess
from pathlib import Path

from celery import Celery

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
INPUT_DIR = DATA_DIR / "input"
OUTPUT_DIR = DATA_DIR / "output"

celery_app = Celery("video_tasks", broker=REDIS_URL, backend=REDIS_URL)
celery_app.conf.update(
    task_track_started=True,
    result_expires=86400,
    worker_prefetch_multiplier=1,
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
)


@celery_app.task(bind=True, name="convert_mp4_to_gif")
def convert_mp4_to_gif(self, job_id: str):
    # Path built only from validated server-generated UUID task IDs.
    source = INPUT_DIR / f"{job_id}.mp4"
    destination = OUTPUT_DIR / f"{job_id}.gif"
    temp = OUTPUT_DIR / f"{job_id}.tmp.gif"
    try:
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                "-threads", "1", "-filter_threads", "1",
                "-i", str(source),
                "-filter_complex",
                "fps=10,scale=480:-1:flags=lanczos,split[s0][s1];"
                "[s0]palettegen[p];[s1][p]paletteuse",
                "-an", "-loop", "0", str(temp),
            ],
            check=True, capture_output=True, text=True, timeout=600,
        )
        temp.replace(destination)
        return {"filename": destination.name}
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Conversion exceeded the 10-minute limit") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"FFmpeg error: {exc.stderr[-1200:]}") from exc
    finally:
        temp.unlink(missing_ok=True)
