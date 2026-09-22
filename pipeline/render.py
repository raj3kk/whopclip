#!/usr/bin/env python3
"""
WhopClip video pipeline (v1 stub).

Full flow (implemented in v2):
  1. download(url)      - fetch influencer source video (yt-dlp)
  2. cut_916(src, start, end) - crop/scale to 1080x1920
  3. captions(src, text)      - burn karaoke-style captions (ffmpeg drawtext /
     libass), honoring safe zones: hook >=10% from top, captions above 78% height
  4. finalize()         - loudness normalize + faststart mp4

v1: function signatures + CLI plumbing only. The real edit parameters come
from the campaign requirements fetched per campaign.
"""
import argparse
import subprocess
import sys


def sh(cmd: list[str]) -> None:
    print("+", " ".join(cmd))
    # v1: dry-run only
    # subprocess.run(cmd, check=True)


def download(url: str, out: str) -> str:
    sh(["yt-dlp", "--no-check-certificate", "-o", out, url])
    return out


def cut_916(src: str, start: float, end: float, out: str) -> str:
    dur = end - start
    vf = "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920"
    sh(["ffmpeg", "-y", "-ss", str(start), "-i", src, "-t", str(dur),
        "-vf", vf, "-c:a", "aac", out])
    return out


def burn_captions(src: str, ass_file: str, out: str) -> str:
    sh(["ffmpeg", "-y", "-i", src, "-vf", f"ass={ass_file}",
        "-c:a", "copy", out])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="WhopClip render pipeline (v1 stub)")
    ap.add_argument("--url", required=True, help="influencer source video URL")
    ap.add_argument("--start", type=float, required=True)
    ap.add_argument("--end", type=float, required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    src = download(args.url, "/tmp/whopclip_src.mp4")
    cut = cut_916(src, args.start, args.end, "/tmp/whopclip_916.mp4")
    print(f"v1 stub complete (dry-run): {cut} -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
