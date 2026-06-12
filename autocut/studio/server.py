import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from typing import Any, Dict, List, Optional, Tuple

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
SIDECAR_VERSION = 1


def _ffprobe(video_path: str) -> Tuple[float, bool]:
    """Return (duration_seconds, has_audio_stream)."""
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "json",
            video_path,
        ],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {out.stderr.strip()}")
    info = json.loads(out.stdout)
    duration = float(info["format"]["duration"])
    has_audio = any(s.get("codec_type") == "audio" for s in info.get("streams", []))
    return duration, has_audio


class Project:
    """One opened media file: transcript state + background ASR/export jobs."""

    def __init__(self, video_path: str, device: Optional[str] = None):
        self.video_path = os.path.abspath(video_path)
        if not os.path.exists(self.video_path):
            raise FileNotFoundError(self.video_path)
        self.device = device
        self.duration, self.has_audio = _ffprobe(self.video_path)
        self.sidecar = self.video_path + ".autocut.json"
        self.segments: List[Dict[str, Any]] = []
        self.asr = {"state": "idle", "error": None, "elapsed": 0.0}
        self.export = {"state": "idle", "progress": 0.0, "output": None, "error": None}
        self._lock = threading.Lock()
        self._load_sidecar()

    # ---------- persistence ----------

    def _load_sidecar(self):
        if not os.path.exists(self.sidecar):
            return
        try:
            with open(self.sidecar, encoding="utf-8") as f:
                data = json.load(f)
            self.segments = data.get("segments", [])
            if self.segments:
                self.asr["state"] = "done"
        except Exception as e:  # corrupted sidecar should not block opening
            logging.warning(f"Ignore broken sidecar {self.sidecar}: {e}")

    def _save_sidecar(self):
        data = {
            "version": SIDECAR_VERSION,
            "media": os.path.basename(self.video_path),
            "duration": self.duration,
            "segments": self.segments,
        }
        with open(self.sidecar, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)

    # ---------- transcribe ----------

    def start_transcribe(self):
        with self._lock:
            if self.asr["state"] in ("loading", "running"):
                return
            self.asr = {"state": "loading", "error": None, "elapsed": 0.0}
        threading.Thread(target=self._transcribe_job, daemon=True).start()

    def _transcribe_job(self):
        tic = time.time()
        try:
            from .. import utils
            from ..funasr_model import FunASRModel

            model = FunASRModel()
            model.load(self.device)
            with self._lock:
                self.asr["state"] = "running"
                self.asr["elapsed"] = time.time() - tic
            audio = utils.load_audio(self.video_path, sr=16000)
            sentences = model.transcribe(audio)
            with self._lock:
                self.segments = [
                    {
                        "id": i,
                        "start": round(s["start"], 3),
                        "end": round(s["end"], 3),
                        "text": s["text"],
                        "deleted": False,
                    }
                    for i, s in enumerate(sentences)
                ]
                self.asr = {
                    "state": "done",
                    "error": None,
                    "elapsed": time.time() - tic,
                }
                self._save_sidecar()
        except Exception as e:
            logging.exception("transcribe failed")
            with self._lock:
                self.asr = {
                    "state": "error",
                    "error": str(e),
                    "elapsed": time.time() - tic,
                }

    def update_deleted(self, deleted_ids: List[int]):
        deleted = set(deleted_ids)
        with self._lock:
            for s in self.segments:
                s["deleted"] = s["id"] in deleted
            self._save_sidecar()

    # ---------- cutting math ----------

    def keep_ranges(
        self, mode: str = "precise", bridge_gap: float = 1.0, pad: float = 0.25
    ) -> List[Tuple[float, float]]:
        """Time ranges of the source video that stay in the export.

        precise: cut exactly the spans of deleted sentences (CapCut behavior,
                 untouched silence is kept).
        compact: keep only kept sentences padded by `pad`; a gap shorter than
                 `bridge_gap` between two kept sentences is bridged so natural
                 pauses survive while long silence is dropped (autocut behavior).
        """
        kept = [s for s in self.segments if not s["deleted"]]
        if mode == "compact":
            ranges = [
                [max(0.0, s["start"] - pad), min(self.duration, s["end"] + pad)]
                for s in kept
            ]
            merged: List[List[float]] = []
            for r in ranges:
                if merged and r[0] - merged[-1][1] <= bridge_gap:
                    merged[-1][1] = max(merged[-1][1], r[1])
                else:
                    merged.append(r)
            result = merged
        else:
            cut_spans = sorted(
                [s["start"], s["end"]] for s in self.segments if s["deleted"]
            )
            merged_cuts: List[List[float]] = []
            for r in cut_spans:
                if merged_cuts and r[0] <= merged_cuts[-1][1] + 0.01:
                    merged_cuts[-1][1] = max(merged_cuts[-1][1], r[1])
                else:
                    merged_cuts.append(r)
            result, cursor = [], 0.0
            for s, e in merged_cuts:
                if s > cursor:
                    result.append([cursor, s])
                cursor = max(cursor, e)
            if cursor < self.duration:
                result.append([cursor, self.duration])
        return [(s, e) for s, e in result if e - s > 0.05]

    # ---------- export ----------

    def start_export(self, opts: Dict[str, Any]):
        with self._lock:
            if self.export["state"] == "running":
                return
            self.export = {
                "state": "running",
                "progress": 0.0,
                "output": None,
                "error": None,
            }
        threading.Thread(target=self._export_job, args=(opts,), daemon=True).start()

    def _output_path(self) -> str:
        base, _ = os.path.splitext(self.video_path)
        candidate, n = f"{base}_cut.mp4", 2
        while os.path.exists(candidate):
            candidate = f"{base}_cut{n}.mp4"
            n += 1
        return candidate

    def _export_job(self, opts: Dict[str, Any]):
        try:
            ranges = self.keep_ranges(
                mode=opts.get("mode", "precise"),
                bridge_gap=float(opts.get("bridge_gap", 1.0)),
            )
            if not ranges:
                raise RuntimeError("没有可保留的内容：所有句子都被删除了")
            output = self._output_path()
            total = sum(e - s for s, e in ranges)

            lines = []
            for i, (s, e) in enumerate(ranges):
                lines.append(
                    f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}];"
                )
                if self.has_audio:
                    lines.append(
                        f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}];"
                    )
            pairs = "".join(
                f"[v{i}][a{i}]" if self.has_audio else f"[v{i}]"
                for i in range(len(ranges))
            )
            a_flag = 1 if self.has_audio else 0
            lines.append(
                f"{pairs}concat=n={len(ranges)}:v=1:a={a_flag}[outv]"
                + ("[outa]" if self.has_audio else "")
            )

            with tempfile.NamedTemporaryFile(
                "w", suffix=".txt", delete=False
            ) as script:
                script.write("\n".join(lines))
                script_path = script.name

            cmd = [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-i",
                self.video_path,
                "-filter_complex_script",
                script_path,
                "-map",
                "[outv]",
            ]
            if self.has_audio:
                cmd += ["-map", "[outa]", "-c:a", "aac", "-b:a", "192k"]
            cmd += [
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "18",
                "-movflags",
                "+faststart",
                "-progress",
                "pipe:1",
                output,
            ]

            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
            )
            for line in proc.stdout:
                m = re.match(r"out_time_us=(\d+)", line.strip())
                if m:
                    done = int(m.group(1)) / 1e6
                    with self._lock:
                        self.export["progress"] = min(0.99, done / max(total, 0.01))
            proc.wait()
            os.unlink(script_path)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.read()[-800:])

            if opts.get("srt", True):
                self._write_retimed_srt(ranges, output)

            with self._lock:
                self.export = {
                    "state": "done",
                    "progress": 1.0,
                    "output": output,
                    "error": None,
                }
        except Exception as e:
            logging.exception("export failed")
            with self._lock:
                self.export = {
                    "state": "error",
                    "progress": 0.0,
                    "output": None,
                    "error": str(e),
                }

    def _write_retimed_srt(self, ranges: List[Tuple[float, float]], output: str):
        """Subtitles for the exported video, with removed spans squeezed out."""
        import datetime

        import srt as srt_lib

        prefix = []  # output start time of each range
        acc = 0.0
        for s, e in ranges:
            prefix.append(acc)
            acc += e - s

        def to_out(t: float) -> Optional[float]:
            for (s, e), off in zip(ranges, prefix):
                if t < s:
                    return off
                if t <= e:
                    return off + (t - s)
            return None

        subs, idx = [], 1
        for seg in self.segments:
            if seg["deleted"]:
                continue
            a, b = to_out(seg["start"]), to_out(seg["end"])
            if a is None or b is None or b - a < 0.05:
                continue
            subs.append(
                srt_lib.Subtitle(
                    index=idx,
                    start=datetime.timedelta(seconds=a),
                    end=datetime.timedelta(seconds=b),
                    content=seg["text"],
                )
            )
            idx += 1
        srt_path = os.path.splitext(output)[0] + ".srt"
        with open(srt_path, "wb") as f:
            f.write(srt_lib.compose(subs).encode("utf-8"))

    # ---------- snapshots ----------

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "name": os.path.basename(self.video_path),
                "path": self.video_path,
                "duration": self.duration,
                "has_audio": self.has_audio,
                "segments": self.segments,
                "asr": dict(self.asr),
                "export": dict(self.export),
            }

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {"asr": dict(self.asr), "export": dict(self.export)}


def create_app(project: Project):
    from fastapi import FastAPI, Request
    from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
    from fastapi.staticfiles import StaticFiles

    app = FastAPI(title="AutoCut Studio")
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    @app.get("/api/project")
    def get_project():
        return JSONResponse(project.snapshot())

    @app.get("/api/status")
    def get_status():
        return JSONResponse(project.status())

    @app.post("/api/transcribe")
    def post_transcribe():
        project.start_transcribe()
        return {"ok": True}

    @app.put("/api/segments")
    async def put_segments(request: Request):
        body = await request.json()
        project.update_deleted(body.get("deleted_ids", []))
        return {"ok": True}

    @app.post("/api/export")
    async def post_export(request: Request):
        body = await request.json()
        project.start_export(body or {})
        return {"ok": True}

    @app.post("/api/reveal")
    def post_reveal():
        output = project.export.get("output")
        if output and sys.platform == "darwin":
            subprocess.run(["open", "-R", output])
        return {"ok": True}

    CHUNK = 1024 * 1024

    def iter_file(path: str, start: int, end: int):
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                data = f.read(min(CHUNK, remaining))
                if not data:
                    break
                remaining -= len(data)
                yield data

    @app.get("/media")
    def media(request: Request):
        path = project.video_path
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or "video/mp4"
        range_header = request.headers.get("range")
        if not range_header:
            return StreamingResponse(
                iter_file(path, 0, size - 1),
                media_type=ctype,
                headers={"Accept-Ranges": "bytes", "Content-Length": str(size)},
            )
        m = re.match(r"bytes=(\d*)-(\d*)", range_header)
        start = int(m.group(1)) if m.group(1) else 0
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        return StreamingResponse(
            iter_file(path, start, end),
            status_code=206,
            media_type=ctype,
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(end - start + 1),
            },
        )

    return app


def run_studio(args):
    import uvicorn

    video = args.inputs[0]
    port = getattr(args, "studio_port", 8765)
    project = Project(video, device=args.device)
    app = create_app(project)

    url = f"http://127.0.0.1:{port}"
    logging.info(f"AutoCut Studio: {url}  ({video})")
    if not getattr(args, "no_browser", False):
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
