#!/usr/bin/env python3
"""
WhopClip VM render worker — the piece that supplies video_url + cover_url.

The chain parks at the `render` stage until THIS worker reports. Pipeline:

  GET /api/render/next  (x-cron-secret: WHOPCLIP_CRON_SECRET) -> claim spec
    -> download ONLY spec.authorized_source (fail closed otherwise)
         * youtu.be/youtube.com -> yt-dlp (datacenter-safe flags)
         * direct https (S3 bucket URLs etc.) -> streamed download
         * bare @handle / non-URL -> REFUSE (not downloadable)
    -> transcribe with faster-whisper (whop-edit-env)
    -> pick best segment: hook-text keywords first, else densest speech
       window within the brief's duration cap
    -> render 1080x1920 via clip_factory (face-track, hook >=10.4% from top,
       karaoke captions above the IG overlay zone)
    -> validate (1080x1920, 3s..15min, within cap)
    -> ffmpeg-extract a REAL cover frame (720x1280 JPEG, ~2s, hook visible)
    -> upload MP4 + cover to catbox.moe (free, anonymous, no key)
    -> POST /api/render/result { id, ok, video_url, cover_url }

FAIL-CLOSED: no authorized source / no speech / invalid output / no cover
-> ok=false with the reason (the chain then fails with that reason instead
of hanging). cover_url is REQUIRED for ok=true — no placeholder, ever.

Secrets: only the server's CRON_SECRET value (passed in the local env var
WHOPCLIP_CRON_SECRET). Never touches Whop/IG sessions.

Usage:
  WHOPCLIP_CRON_SECRET=... python3 worker/render_worker.py --once
  WHOPCLIP_CRON_SECRET=... python3 worker/render_worker.py --loop
  python3 worker/render_worker.py --dry-run --spec-json /tmp/spec.json
      # no server calls: render locally, print local paths
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

BASE = os.environ.get("WHOPCLIP_BASE", "https://whopclip.vercel.app").rstrip("/")
SECRET = os.environ.get("WHOPCLIP_CRON_SECRET", "")
FACTORY_DIR = os.path.expanduser("~/workspace/whop-clipping")
VENV = os.path.expanduser("~/workspace/whop-edit-env/bin")
VENV_PY = os.path.join(VENV, "python")
YTDLP = os.path.join(VENV, "yt-dlp")
WORKDIR = os.path.expanduser("~/workspace/whopclip-fresh/worker/out")

W, H = 1080, 1920

# httpx (huggingface_hub, used by faster-whisper model download) chokes on
# bracketed IPv6 entries in no_proxy — same fix as clip_factory.
for _var in ("no_proxy", "NO_PROXY"):
    _val = os.environ.get(_var)
    if _val:
        os.environ[_var] = ",".join(p for p in _val.split(",") if "[" not in p)


def log(*a):
    print(f"[render-worker {time.strftime('%H:%M:%S')}]", *a, flush=True)


def run(cmd, timeout=600):
    log("$", " ".join(str(c) for c in cmd[:5]), "..." if len(cmd) > 5 else "")
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(
            f"cmd failed ({p.returncode}): {' '.join(str(c) for c in cmd[:4])}\n{p.stderr[-1500:]}")
    return p.stdout


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"x-cron-secret": SECRET, "Content-Type": "application/json",
                 "User-Agent": "whopclip-render-worker"},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            if r.status == 204:
                return None
            raw = r.read()
            return json.loads(raw.decode()) if raw else None
    except urllib.error.HTTPError as e:
        if e.code == 204:
            return None
        raise


def download_source(url, out_path, max_bytes=600 * 1024 * 1024):
    """Download ONLY the authorized source URL."""
    log("downloading authorized source:", url[:110])
    if "youtu" in url:
        out_tmpl = out_path + ".%(ext)s"
        run([YTDLP, "--no-check-certificate", "--js-runtimes", "node",
             "--extractor-args", "youtube:player_client=android",
             "-f", "bv*[height<=1080]+ba/b[height<=1080]/b",
             "--merge-output-format", "mp4", "-o", out_tmpl, url],
            timeout=900)
        for cand in (out_path + ".mp4", out_path + ".webm", out_path + ".mkv"):
            if os.path.exists(cand):
                shutil.move(cand, out_path)
                break
        else:
            import glob
            got = glob.glob(out_path + ".*")
            if not got:
                raise RuntimeError("yt-dlp produced no file")
            shutil.move(got[0], out_path)
    else:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=180) as r, open(out_path, "wb") as f:
            total = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                total += len(chunk)
                if total > max_bytes:
                    raise RuntimeError("source larger than 600MB — refusing")
    size = os.path.getsize(out_path)
    if size < 10_000:
        raise RuntimeError("downloaded source suspiciously small")
    log("source downloaded:", size, "bytes")
    return out_path


def ffprobe_duration(path):
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True)
    try:
        return float(p.stdout.strip())
    except ValueError:
        return 0.0


def transcribe(audio_path):
    code = (
        "import json,sys; from faster_whisper import WhisperModel;"
        "m=WhisperModel('base', device='cpu', compute_type='int8');"
        "segs,_=m.transcribe(sys.argv[1], language='en');"
        "print(json.dumps([{'s':s.start,'e':s.end,'t':s.text.strip()} for s in segs if s.text.strip()]))"
    )
    out = subprocess.run(
        [VENV_PY, "-c", code, audio_path],
        capture_output=True, text=True, timeout=1200)
    if out.returncode != 0:
        raise RuntimeError(f"transcribe failed: {out.stderr[-800:]}")
    return json.loads(out.stdout.strip() or "[]")


def pick_segment(segments, cap_s, hook_hint=""):
    """Best [start,end] within cap_s: hook keywords first, else densest
    speech window. Returns None when there is no speech."""
    if not segments:
        return None
    words = []
    for s in segments:
        for w in s["t"].split():
            words.append((s["s"], s["e"], w))
    if not words:
        return None
    total = segments[-1]["e"]
    cap = min(cap_s or 60, 90)
    if hook_hint:
        keys = [k.lower() for k in re.findall(r"[a-zA-Z]{4,}", hook_hint)]
        for (s0, _e0, w) in words:
            if any(k in w.lower() for k in keys):
                start = max(0.0, s0 - 2)
                return (round(start, 1), round(min(total, start + cap), 1))
    step, best, t = 2.0, None, 0.0
    while t + cap <= total + 1:
        n = sum(1 for (s0, _e0, _w) in words if t <= s0 < t + cap)
        if best is None or n > best[2]:
            best = (t, t + cap, n)
        t += step
    if best is None:
        return (0.0, round(min(cap, total), 1))
    return (round(best[0], 1), round(best[1], 1))


def build_profile(hook_text):
    """clip_factory profile: hook overlay top-center (>=10.4% safe zone)."""
    profile = {
        "text_overlays": [
            {"text": (hook_text or "Watch this")[:90], "position": "top-center",
             "font_size": 64}
        ],
        "effects": {"ken_burns": True, "punch_zoom": False, "emphasis_pulse": False},
    }
    fd, path = tempfile.mkstemp(suffix=".json", prefix="wc_profile_")
    with os.fdopen(fd, "w") as f:
        json.dump(profile, f)
    return path


def render_clip(src, seg, hook_text, out_path):
    start, end = seg
    profile_path = build_profile(hook_text)
    run([VENV_PY, os.path.join(FACTORY_DIR, "clip_factory.py"),
         "--src", src, "--start", str(start), "--end", str(end),
         "--out", out_path, "--profile", profile_path],
        timeout=1800)
    p = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", out_path],
        capture_output=True, text=True)
    try:
        w, h = (int(x) for x in p.stdout.strip().split(",")[:2])
    except ValueError:
        raise RuntimeError("could not probe render dimensions")
    if (w, h) != (W, H):
        raise RuntimeError(f"render is {w}x{h}, expected 1080x1920")
    dur = ffprobe_duration(out_path)
    if not (3 <= dur <= 15 * 60):
        raise RuntimeError(f"render duration {dur:.1f}s out of IG bounds (3s..15min)")
    log(f"render ok: 1080x1920, {dur:.1f}s")
    return dur


def extract_cover(clip_path, clip_dur, dest):
    """REAL cover frame: ~2s in (hook visible), 720x1280 JPEG."""
    css = max(1.0, min(2.0, clip_dur - 1))
    run(["ffmpeg", "-y", "-v", "error", "-ss", str(css), "-i", clip_path,
         "-frames:v", "1", "-vf", "scale=720:1280", "-q:v", "3", dest],
        timeout=120)
    with open(dest, "rb") as f:
        magic = f.read(3)
    if magic != b"\xff\xd8\xff":
        raise RuntimeError("cover is not a valid JPEG")
    if os.path.getsize(dest) < 5_000:
        raise RuntimeError("cover JPEG suspiciously small")
    log("cover ok:", os.path.getsize(dest), "bytes")
    return dest


def upload_catbox(path):
    """Free anonymous upload (no key). Returns the public https URL."""
    import http.client
    import mimetypes
    boundary = "----wcboundary" + str(int(time.time() * 1000))
    fname = os.path.basename(path)
    ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
    with open(path, "rb") as f:
        data = f.read()
    if len(data) > 190 * 1024 * 1024:
        raise RuntimeError("file too large for catbox (190MB cap)")
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"reqtype\"\r\n\r\nfileupload\r\n"
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"fileToUpload\"; "
        f"filename=\"{fname}\"\r\nContent-Type: {ctype}\r\n\r\n"
    ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
    conn = http.client.HTTPSConnection("catbox.moe", timeout=180)
    conn.request("POST", "/user/api.php", body,
                 {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    resp = conn.getresponse()
    text = resp.read().decode().strip()
    if resp.status != 200 or not text.startswith("https://"):
        raise RuntimeError(f"catbox upload failed: HTTP {resp.status} {text[:120]}")
    log("uploaded:", text)
    return text


def process_spec(spec, dry_run=False):
    sid = spec["id"]
    log(f"=== spec {sid} ({spec.get('campaign_name')}) ===")
    source = (spec.get("authorized_source") or "").strip()
    # FAIL-CLOSED: only http(s) URLs are downloadable.
    if not re.match(r"^https?://", source):
        raise RuntimeError(
            f"authorized source '{source[:60]}' is not a downloadable URL — refusing to guess footage")

    workdir = os.path.join(WORKDIR, sid)
    os.makedirs(workdir, exist_ok=True)
    src = os.path.join(workdir, "source.bin")
    out = os.path.join(workdir, "clip.mp4")
    cover = os.path.join(workdir, "cover.jpg")

    req = spec.get("requirements") or {}
    cap_s = req.get("video_max_duration_s") or 35

    download_source(source, src)
    if ffprobe_duration(src) < 3:
        raise RuntimeError("source shorter than 3s")
    segments = transcribe(src)
    if not segments:
        raise RuntimeError("transcription empty — no speech found in source")
    log(f"transcribed {len(segments)} segments")
    seg = pick_segment(segments, cap_s, spec.get("hook_text", ""))
    if not seg:
        raise RuntimeError("could not pick a speech segment")
    log(f"segment {seg[0]}s -> {seg[1]}s (cap {cap_s}s)")
    clip_dur = render_clip(src, seg, spec.get("hook_text", ""), out)
    extract_cover(out, clip_dur, cover)

    if dry_run:
        log("DRY RUN — files kept locally:")
        log("  video:", out)
        log("  cover:", cover)
        return out, cover
    video_url = upload_catbox(out)
    cover_url = upload_catbox(cover)
    return video_url, cover_url


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="single claim attempt then exit")
    ap.add_argument("--loop", action="store_true", help="poll forever (60s)")
    ap.add_argument("--dry-run", action="store_true", help="no server calls")
    ap.add_argument("--spec-json", help="local RenderSpec JSON (with --dry-run)")
    args = ap.parse_args()

    if args.dry_run:
        if not args.spec_json:
            ap.error("--dry-run needs --spec-json")
        spec = json.load(open(args.spec_json))
        try:
            process_spec(spec, dry_run=True)
            log("dry-run complete")
        except Exception as e:
            log("dry-run FAILED:", type(e).__name__, str(e)[:300])
            sys.exit(1)
        return

    if not SECRET:
        log("WHOPCLIP_CRON_SECRET not set — refusing to run")
        return 2
    os.makedirs(WORKDIR, exist_ok=True)

    def one_cycle():
        try:
            res = api("GET", "/api/render/next")
        except Exception as e:
            log("poll error:", str(e)[:200])
            return
        if not res or not res.get("spec"):
            log("queue empty")
            return
        spec = res["spec"]
        try:
            video_url, cover_url = process_spec(spec)
            api("POST", "/api/render/result",
                {"id": spec["id"], "ok": True,
                 "video_url": video_url, "cover_url": cover_url})
            log("done", spec["id"])
        except Exception as e:
            log("FAILED", spec["id"], str(e)[:200])
            try:
                api("POST", "/api/render/result",
                    {"id": spec["id"], "ok": False, "error": str(e)[:500]})
            except Exception as e2:
                log("result post failed:", str(e2)[:200])

    if args.loop:
        log("loop mode: polling every 60s")
        while True:
            one_cycle()
            time.sleep(60)
    else:
        one_cycle()


if __name__ == "__main__":
    sys.exit(main() or 0)
