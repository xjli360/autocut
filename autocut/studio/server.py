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

# Shared by live preview (CSS) and burned export (Pillow): names must map to
# fonts that exist both as browser families and as font files on disk.
FONT_PATHS = {
    "PingFang SC": "/System/Library/Fonts/PingFang.ttc",
    "Hiragino Sans GB": "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "Songti SC": "/System/Library/Fonts/Supplemental/Songti.ttc",
    "Kaiti SC": "/System/Library/Fonts/Supplemental/Kaiti.ttc",
    "Arial Unicode MS": "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
}

DEFAULT_SUB_STYLE = {
    "font": "PingFang SC",
    "size": 4.5,  # % of video height
    "color": "#ffffff",
    "stroke": "#141414",
    "posv": 5,  # baseline offset from the bottom, % of video height
}


def _hex_rgba(value: str, alpha: int = 255) -> Tuple[int, int, int, int]:
    value = (value or "").lstrip("#")
    if len(value) != 6:
        return (255, 255, 255, alpha)
    try:
        return (
            int(value[0:2], 16),
            int(value[2:4], 16),
            int(value[4:6], 16),
            alpha,
        )
    except ValueError:
        return (255, 255, 255, alpha)


def _ffprobe(video_path: str) -> Tuple[float, bool, int, int]:
    """Return (duration_seconds, has_audio_stream, width, height)."""
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height",
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
    streams = info.get("streams", [])
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    width = height = 0
    for s in streams:
        if s.get("codec_type") == "video":
            width, height = int(s.get("width", 0)), int(s.get("height", 0))
            break
    return duration, has_audio, width, height


class Project:
    """One opened media file: transcript state + background ASR/export jobs."""

    def __init__(self, video_path: str, device: Optional[str] = None):
        self.video_path = os.path.abspath(video_path)
        if not os.path.exists(self.video_path):
            raise FileNotFoundError(self.video_path)
        self.device = device
        self.duration, self.has_audio, self.width, self.height = _ffprobe(
            self.video_path
        )
        self.sidecar = self.video_path + ".autocut.json"
        self.segments: List[Dict[str, Any]] = []
        self.sub_style: Dict[str, Any] = dict(DEFAULT_SUB_STYLE)
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
            self.sub_style.update(data.get("sub_style", {}))
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
            "sub_style": self.sub_style,
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

    def update_style(self, style: Dict[str, Any]):
        with self._lock:
            for key in DEFAULT_SUB_STYLE:
                if key in style:
                    self.sub_style[key] = style[key]
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

            entries = self._retimed_entries(ranges)
            srt_text = self._compose_srt(entries)

            graph = []
            for i, (s, e) in enumerate(ranges):
                graph.append(
                    f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}]"
                )
                if self.has_audio:
                    graph.append(
                        f"[0:a]atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS[a{i}]"
                    )
            pairs = "".join(
                f"[v{i}][a{i}]" if self.has_audio else f"[v{i}]"
                for i in range(len(ranges))
            )
            a_flag = 1 if self.has_audio else 0
            graph.append(
                f"{pairs}concat=n={len(ranges)}:v=1:a={a_flag}[outv]"
                + ("[outa]" if self.has_audio else "")
            )
            # Burn subtitles by overlaying pre-rendered PNGs: works with any
            # ffmpeg build (no libass/freetype needed, this Mac's lacks both).
            v_label = "outv"
            overlay_inputs: List[str] = []
            subs_dir = None
            if opts.get("burn_subs", False) and entries:
                subs_dir = tempfile.mkdtemp(prefix="autocut_subs_")
                posv = float(self.sub_style.get("posv", 5))
                margin = max(8, int(self.height * posv / 100))
                for k, (a, b, png) in enumerate(
                    self._render_sub_images(entries, subs_dir)
                ):
                    overlay_inputs += ["-loop", "1", "-i", png]
                    nxt = f"ov{k}"
                    # shortest=1: the looped PNG inputs are infinite, without it
                    # the overlay chain never reaches EOF and ffmpeg runs forever
                    graph.append(
                        f"[{v_label}][{k + 1}:v]overlay=x=(W-w)/2:y=H-h-{margin}"
                        f":shortest=1:enable='between(t,{a:.3f},{b:.3f})'[{nxt}]"
                    )
                    v_label = nxt

            with tempfile.NamedTemporaryFile(
                "w", suffix=".txt", delete=False
            ) as script:
                script.write(";\n".join(graph))
                script_path = script.name

            cmd = (
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-i",
                    self.video_path,
                ]
                + overlay_inputs
                + [
                    "-filter_complex_script",
                    script_path,
                    "-map",
                    f"[{v_label}]",
                ]
            )
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
                # hard cap as a second guard against non-terminating inputs
                "-t",
                f"{total:.3f}",
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
            if subs_dir:
                import shutil

                shutil.rmtree(subs_dir, ignore_errors=True)
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr.read()[-800:])

            if opts.get("srt", True) and srt_text.strip():
                with open(os.path.splitext(output)[0] + ".srt", "wb") as f:
                    f.write(srt_text.encode("utf-8"))

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

    def _retimed_entries(
        self, ranges: List[Tuple[float, float]]
    ) -> List[Tuple[float, float, str]]:
        """Kept sentences mapped onto the output timeline: [(start, end, text)]."""
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

        entries = []
        for seg in self.segments:
            if seg["deleted"]:
                continue
            a, b = to_out(seg["start"]), to_out(seg["end"])
            if a is None or b is None or b - a < 0.05:
                continue
            entries.append((a, b, seg["text"]))
        return entries

    @staticmethod
    def _compose_srt(entries: List[Tuple[float, float, str]]) -> str:
        import datetime

        import srt as srt_lib

        subs = [
            srt_lib.Subtitle(
                index=i,
                start=datetime.timedelta(seconds=a),
                end=datetime.timedelta(seconds=b),
                content=text,
            )
            for i, (a, b, text) in enumerate(entries, start=1)
        ]
        return srt_lib.compose(subs) if subs else ""

    def _render_sub_images(
        self, entries: List[Tuple[float, float, str]], out_dir: str
    ) -> List[Tuple[float, float, str]]:
        """Render each subtitle as a transparent PNG (white text with dark
        outline, wrapped to the video width). Returns [(start, end, png)]."""
        from PIL import Image, ImageDraw, ImageFont

        style = self.sub_style
        width = self.width or 1280
        height = self.height or 720
        size_pct = float(style.get("size", 4.5))
        font_size = max(12, int(height * size_pct / 100))
        fill = _hex_rgba(style.get("color", "#ffffff"))
        stroke_fill = _hex_rgba(style.get("stroke", "#141414"), alpha=230)

        candidates = [FONT_PATHS.get(style.get("font", ""), "")] + list(
            FONT_PATHS.values()
        ) + ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
        font = None
        for path in candidates:
            if path and os.path.exists(path):
                font = ImageFont.truetype(path, font_size)
                break
        if font is None:
            font = ImageFont.load_default(size=font_size)

        stroke = max(2, font_size // 9)
        max_text_w = int(width * 0.88)

        def wrap(text: str) -> List[str]:
            lines, cur = [], ""
            for ch in text:
                if font.getlength(cur + ch) > max_text_w and cur:
                    lines.append(cur)
                    cur = ch
                else:
                    cur += ch
            return lines + [cur] if cur else lines

        results = []
        line_h = int(font_size * 1.35)
        for k, (a, b, text) in enumerate(entries):
            lines = wrap(text) or [text]
            img_w = min(
                width, int(max(font.getlength(l) for l in lines)) + stroke * 2 + 8
            )
            img_h = line_h * len(lines) + stroke * 2 + 8
            img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
            draw = ImageDraw.Draw(img)
            for i, line in enumerate(lines):
                lw = font.getlength(line)
                draw.text(
                    ((img_w - lw) / 2, stroke + 4 + i * line_h),
                    line,
                    font=font,
                    fill=fill,
                    stroke_width=stroke,
                    stroke_fill=stroke_fill,
                )
            png = os.path.join(out_dir, f"sub_{k:04d}.png")
            img.save(png)
            results.append((a, b, png))
        return results

    # ---------- snapshots ----------

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "name": os.path.basename(self.video_path),
                "path": self.video_path,
                "duration": self.duration,
                "has_audio": self.has_audio,
                "segments": self.segments,
                "sub_style": dict(self.sub_style),
                "fonts": list(FONT_PATHS),
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

    @app.put("/api/style")
    async def put_style(request: Request):
        body = await request.json()
        project.update_style(body or {})
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
