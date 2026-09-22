#!/usr/bin/env python3
"""
WhopClip video pipeline.

  1. verify_source(url, allowed_domains) - checkpoint 4: only download from
     authorized influencer sources. Anything else -> refuse (fail-closed).
  2. download(url, out)                  - yt-dlp fetch
  3. quality_check(path)                 - ffprobe: resolution/duration/codec;
     raises unless the source is usable
  4. cut_916(src, start, end, out)       - crop/scale to 1080x1920
  5. make_ass(lines, out)                - karaoke captions honoring safe zones:
       hook >=10% from top (MarginV 200 @1920), captions above 78% height
  6. burn_captions(src, ass, out)        - libass burn-in

Usage:
  render.py --url URL --start 12.5 --end 42.5 --out clip.mp4 \
      --allow-domain cdn.influencer.com --captions captions.txt
"""
import argparse
import json
import subprocess
import sys
import urllib.parse

# Checkpoint 5 — safe zones (percent of 1920 height)
HOOK_TOP_MARGIN_PX = 200      # 10.4% from top
CAPTION_BOTTOM_MARGIN_PX = 430  # captions sit above ~78% height
TARGET_W, TARGET_H = 1080, 1920


def sh(cmd: list[str], capture: bool = False) -> str:
    r = subprocess.run(cmd, check=True, capture_output=capture, text=True)
    return r.stdout if capture else ""


def verify_source(url: str, allowed_domains: list[str]) -> str:
    """Checkpoint 4: refuse to download from non-authorized sources."""
    host = urllib.parse.urlparse(url).hostname or ""
    if not allowed_domains:
        raise SystemExit("refusing: no --allow-domain given (fail-closed)")
    ok = any(host == d or host.endswith("." + d) for d in allowed_domains)
    if not ok:
        raise SystemExit(f"refusing: {host} not in authorized sources {allowed_domains}")
    return host


def download(url: str, out: str) -> str:
    sh(["yt-dlp", "--no-check-certificate", "-f",
        "bv[height<=1080]+ba/b[height<=1080]/b", "-o", out, url])
    return out


def quality_check(path: str) -> dict:
    """Checkpoint 4: ffprobe gate — raises unless the source is usable."""
    raw = sh(["ffprobe", "-v", "error", "-select_streams", "v:0",
              "-show_entries", "stream=width,height,avg_frame_rate,codec_name",
              "-show_entries", "format=duration", "-of", "json", path], capture=True)
    info = json.loads(raw)
    st = (info.get("streams") or [{}])[0]
    w, h = int(st.get("width", 0)), int(st.get("height", 0))
    dur = float((info.get("format") or {}).get("duration", 0) or 0)
    if w < 640 or h < 640:
        raise SystemExit(f"quality_check failed: too small {w}x{h}")
    if dur < 3:
        raise SystemExit(f"quality_check failed: too short ({dur:.1f}s)")
    print(f"quality OK: {w}x{h} {dur:.1f}s {st.get('codec_name')}")
    return {"width": w, "height": h, "duration": dur}


def cut_916(src: str, start: float, end: float, out: str) -> str:
    dur = end - start
    if dur <= 0:
        raise SystemExit("end must be after start")
    vf = f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase,crop={TARGET_W}:{TARGET_H}"
    sh(["ffmpeg", "-y", "-ss", str(start), "-i", src, "-t", str(dur),
        "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "aac", "-movflags", "+faststart", out])
    return out


def make_ass(lines: list[tuple[float, float, str]], out: str,
             hook: str = "") -> str:
    """Write an .ass subtitle file.
    lines: [(start_s, end_s, text)] — bottom captions (above 78% height).
    hook: optional top hook line (>=10% from top). Karaoke \\kf per word
    is intentionally simple: whole-line timing (words split evenly)."""
    def esc(t: str) -> str:
        return t.replace("{", "\\{").replace("}", "\\}")

    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Italic, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,DejaVu Sans,72,&H00FFFFFF,&H80000000,&H80000000,1,0,8,60,60,%d,1
Style: Cap,DejaVu Sans,64,&H00FFFFFF,&H80000000,&H80000000,1,0,2,60,60,%d,1

[Events]
Format: Layer, Start, End, Style, Text
""" % (HOOK_TOP_MARGIN_PX, CAPTION_BOTTOM_MARGIN_PX)

    def ts(s: float) -> str:
        h, rem = divmod(max(0, s), 3600)
        m, sec = divmod(rem, 60)
        return f"{int(h)}:{int(m):02d}:{sec:05.2f}"

    evts = []
    if hook:
        evts.append(f"Dialogue: 0,0:00:00.00,{ts(lines[-1][1] if lines else 5)},Hook,{esc(hook)}")
    for i, (a, b, t) in enumerate(lines):
        words = esc(t).split()
        n = max(1, len(words))
        span_ms = max(1, int((b - a) * 1000 / n))
        kara = "".join(f"{{\\kf{span_ms}}}{w} " for w in words).strip()
        evts.append(f"Dialogue: 0,{ts(a)},{ts(b)},Cap,{kara}")

    with open(out, "w") as f:
        f.write(header + "\n".join(evts) + "\n")
    return out


def burn_captions(src: str, ass_file: str, out: str) -> str:
    sh(["ffmpeg", "-y", "-i", src, "-vf", f"ass='{ass_file}'",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-c:a", "copy", "-movflags", "+faststart", out])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="WhopClip render pipeline")
    ap.add_argument("--url", required=True)
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--allow-domain", action="append", default=[],
                    help="authorized source domain (repeatable)")
    ap.add_argument("--captions", default="",
                    help="lines file: START END TEXT per line")
    ap.add_argument("--hook", default="", help="top hook text")
    ap.add_argument("--skip-download", action="store_true",
                    help="treat --url as a local file (testing)")
    args = ap.parse_args()

    if args.skip_download:
        src = args.url
    else:
        verify_source(args.url, args.allow_domain)
        src = download(args.url, "/tmp/whopclip_src.mp4")
    quality_check(src)

    req_dur = args.end - args.start
    if req_dur > 0:
        tmp = "/tmp/whopclip_916.mp4"
        cut_916(src, args.start, args.end, tmp)
    else:
        tmp = src

    final = tmp
    if args.captions or args.hook:
        lines = []
        if args.captions:
            with open(args.captions) as f:
                for ln in f:
                    parts = ln.strip().split(maxsplit=2)
                    if len(parts) == 3:
                        lines.append((float(parts[0]), float(parts[1]), parts[2]))
        ass = make_ass(lines, "/tmp/whopclip.ass", hook=args.hook)
        final = "/tmp/whopclip_cap.mp4"
        burn_captions(tmp, ass, final)

    sh(["cp", final, args.out])
    info = quality_check(args.out)
    assert info["width"] == TARGET_W and info["height"] == TARGET_H, \
        f"output not 1080x1920: {info['width']}x{info['height']}"
    print(f"RENDER OK: {args.out} 1080x1920")
    return 0


if __name__ == "__main__":
    sys.exit(main())
