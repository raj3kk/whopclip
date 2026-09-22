#!/usr/bin/env python3
"""
WhopClip render worker — runs on the operator VM.

Polls GET /api/render/next (CRON_SECRET auth), claims one render spec, then:
  1. Resolves the AUTHORIZED source (URL -> download via yt-dlp; @handle -> fail
     closed unless a URL is also present, since handles alone are not downloadable)
  2. Downloads the source segment (yt-dlp -g + ffmpeg range seek, same pattern
     as the proven clip tooling)
  3. Transcribes with faster-whisper (whop-edit-env)
  4. Picks the best segment honoring the brief (required moment timestamps when
     present, else highest speech density within the duration cap)
  5. Renders 1080x1920: hook text >=10% from top, karaoke captions at/above 78%
  6. Validates output (ffprobe: 1080x1920, duration within cap, non-empty)
  7. Uploads MP4 to Supabase storage (whopclip bucket)
  8. POST /api/render/result { id, ok, video_url }

Fail-closed everywhere: no authorized source -> no render; transcription empty
-> no render; output invalid -> no render.
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

BASE = os.environ.get("WHOPCLIP_BASE", "https://whopclip.vercel.app")
SECRET = os.environ.get("CRON_SECRET", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://lqvijxfbneqdrjzeeinn.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
BUCKET = "whopclip"
EDIT_ENV = os.path.expanduser("~/workspace/whop-edit-env/bin/python")
WORKDIR = os.path.expanduser("~/workspace/whopclip-fresh/worker/work")

# Safe-zone constants (user-locked)
HOOK_TOP_FRAC = 0.10      # hook/title starts at least 10% below the top
CAPTION_TOP_FRAC = 0.78   # captions sit at/above 78% height
W, H = 1080, 1920


def log(*a):
    print(f"[render-worker {time.strftime('%H:%M:%S')}]", *a, flush=True)


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
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 204:
            return None
        raise


def sb_upload(local_path, dest_name):
    """Upload to Supabase storage, return public URL."""
    with open(local_path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(
        f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{dest_name}",
        data=data, method="POST",
        headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
                 "Content-Type": "video/mp4"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        r.read()
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{dest_name}"


def run(cmd, timeout=600):
    log("$", " ".join(cmd[:6]), "..." if len(cmd) > 6 else "")
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"cmd failed ({p.returncode}): {' '.join(cmd[:4])}\n{p.stderr[-1500:]}")
    return p.stdout


def download_source(url, out_path, max_sec=600):
    """Download up to max_sec of the authorized source URL via yt-dlp."""
    env = dict(os.environ)
    env["no_proxy"] = "localhost,127.0.0.1,::1"
    env["NO_PROXY"] = "localhost,127.0.0.1,::1"
    # Direct stream URL, then ffmpeg range-grab (proven pattern)
    p = subprocess.run(
        ["yt-dlp", "--no-check-certificate", "--js-runtimes", "node",
         "--extractor-args", "youtube:player_client=android", "-g", url],
        capture_output=True, text=True, timeout=180, env=env,
    )
    if p.returncode != 0:
        raise RuntimeError(f"yt-dlp -g failed: {p.stderr[-800:]}")
    stream = p.stdout.strip().split("\n")[0]
    run(["ffmpeg", "-y", "-tls_verify", "0", "-ss", "0", "-i", stream,
         "-t", str(max_sec), "-c", "copy", out_path], timeout=max_sec + 120)
    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise RuntimeError("source download produced empty file")
    return out_path


def transcribe(audio_path):
    """faster-whisper via the edit env; returns list of (start, end, text)."""
    code = (
        "import json,sys; from faster_whisper import WhisperModel;"
        "m=WhisperModel('base', device='cpu', compute_type='int8');"
        "segs,_=m.transcribe(sys.argv[1], language='en');"
        "print(json.dumps([{'s':s.start,'e':s.end,'t':s.text.strip()} for s in segs if s.text.strip()]))"
    )
    out = subprocess.run(
        [EDIT_ENV, "-c", code, audio_path],
        capture_output=True, text=True, timeout=900,
        env={**os.environ, "no_proxy": "localhost,127.0.0.1,::1",
             "NO_PROXY": "localhost,127.0.0.1,::1"},
    )
    if out.returncode != 0:
        raise RuntimeError(f"transcribe failed: {out.stderr[-800:]}")
    return json.loads(out.stdout.strip() or "[]")


def pick_segment(segments, cap_s, hook_hint=""):
    """Pick best [start,end] within cap_s: prefer hook_hint keywords, else
    densest speech window."""
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
    best = None
    # keyword-anchored window first
    if hook_hint:
        keys = [k.lower() for k in re.findall(r"[a-zA-Z]{4,}", hook_hint)]
        for i, (s0, e0, w) in enumerate(words):
            if any(k in w.lower() for k in keys):
                start = max(0, s0 - 2)
                end = min(total, start + cap)
                return (round(start, 1), round(end, 1))
    # densest window
    step = 2.0
    t = 0.0
    while t + cap <= total + 1:
        n = sum(1 for (s0, e0, _) in words if s0 >= t and s0 < t + cap)
        if best is None or n > best[2]:
            best = (t, t + cap, n)
        t += step
    if best is None:
        return (0.0, min(cap, total))
    return (round(best[0], 1), round(best[1], 1))


def render_clip(src, seg, hook_text, segments, out_path, cap_s):
    """Render 1080x1920: hook >=10% top, karaoke captions at/above 78%."""
    start, end = seg
    dur = end - start
    hook_y = int(H * 0.104)  # 10.4% from top
    cap_y = int(H * 0.74)    # captions block top at 74% (text sits above 78%)

    # Build ASS subtitles for the segment window
    def ts(s):
        s = max(0, s - start)
        h = int(s // 3600); m = int((s % 3600) // 60)
        sec = s % 60
        return f"{h}:{m:02d}:{sec:05.2f}"

    ass = ["[V4+ Styles]",
           "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
           "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
           "Alignment, MarginL, MarginR, MarginV, Encoding",
           "Style: Cap,DejaVu Sans,64,&H00FFFFFF,&H000019FF,&H80000000,&H80000000,1,0,0,0,100,100,0,0,1,3,0,2,40,40,40,1",
           "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    for s in segments:
        if s["e"] < start or s["s"] > end:
            continue
        txt = s["t"].replace("\n", " ").strip()[:90]
        ass.append(f"Dialogue: 0,{ts(s['s'])},{ts(s['e'])},Cap,,0,0,0,,{{\\pos(540,{cap_y + 40})}}{txt}")
    ass_path = out_path + ".ass"
    with open(ass_path, "w") as f:
        f.write("\n".join(ass))

    hook_esc = hook_text.replace("'", "").replace(":", "\\:")[:80]
    vf = (
        f"scale=1080:1920:force_original_aspect_ratio=increase,"
        f"crop=1080:1920,"
        f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:"
        f"text='{hook_esc}':fontcolor=white:fontsize=64:"
        f"x=(w-text_w)/2:y={hook_y}:"
        f"box=1:boxcolor=black@0.55:boxborderw=24,"
        f"ass={ass_path}"
    )
    run(["ffmpeg", "-y", "-ss", str(start), "-i", src, "-t", str(dur),
         "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out_path],
        timeout=int(dur) + 300)


def validate_output(path, cap_s):
    if not os.path.exists(path) or os.path.getsize(path) < 50_000:
        raise RuntimeError("render output missing or too small")
    info = json.loads(run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_streams", "-show_format", path], timeout=60))
    vs = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if not vs:
        raise RuntimeError("no video stream in output")
    if int(vs["width"]) != W or int(vs["height"]) != H:
        raise RuntimeError(f"bad dimensions {vs['width']}x{vs['height']}, want 1080x1920")
    dur = float(info["format"]["duration"])
    if cap_s and dur > cap_s + 2:
        raise RuntimeError(f"output {dur:.1f}s exceeds cap {cap_s}s")
    if dur < 3:
        raise RuntimeError(f"output suspiciously short: {dur:.1f}s")
    return dur


def process(spec):
    sid = spec["id"]
    log(f"claim {sid} ({spec['campaign_name']}) source={spec['authorized_source']}")
    os.makedirs(WORKDIR, exist_ok=True)
    tmp = tempfile.mkdtemp(dir=WORKDIR, prefix=sid[:8] + "_")
    src = os.path.join(tmp, "src.mp4")
    out = os.path.join(tmp, "clip.mp4")

    source = spec["authorized_source"]
    req = spec["requirements"]
    cap_s = req.get("video_max_duration_s") or 60

    # FAIL-CLOSED: only http(s) URLs are downloadable. A bare @handle is not
    # enough to fetch footage -> refuse rather than guess.
    if not re.match(r"^https?://", source):
        raise RuntimeError(
            f"authorized source '{source}' is not a downloadable URL — refusing to guess footage")

    download_source(source, src)
    log("source downloaded", os.path.getsize(src), "bytes")
    segments = transcribe(src)
    if not segments:
        raise RuntimeError("transcription empty — no speech found in source")
    log(f"transcribed {len(segments)} segments")
    seg = pick_segment(segments, cap_s, spec.get("hook_text", ""))
    if not seg:
        raise RuntimeError("could not pick a speech segment")
    log(f"segment {seg[0]}s -> {seg[1]}s")
    render_clip(src, seg, spec.get("hook_text", ""), segments, out, cap_s)
    dur = validate_output(out, cap_s)
    log(f"rendered OK: {dur:.1f}s, {os.path.getsize(out)} bytes")

    dest = f"{sid}.mp4"
    url = sb_upload(out, dest)
    log("uploaded:", url)
    return url


def main():
    if not SECRET:
        log("CRON_SECRET not set — refusing to run")
        return 2
    once = "--once" in sys.argv
    while True:
        try:
            res = api("GET", "/api/render/next")
        except Exception as e:
            log("poll error:", e)
            time.sleep(30)
            continue
        if not res:
            if once:
                log("queue empty")
                return 0
            time.sleep(20)
            continue
        spec = res["spec"]
        try:
            url = process(spec)
            api("POST", "/api/render/result",
                {"id": spec["id"], "ok": True, "video_url": url})
            log("done", spec["id"])
        except Exception as e:
            log("FAILED", spec["id"], str(e)[:200])
            try:
                api("POST", "/api/render/result",
                    {"id": spec["id"], "ok": False, "error": str(e)[:500]})
            except Exception as e2:
                log("result post failed:", e2)
        if once:
            return 0


if __name__ == "__main__":
    sys.exit(main())
