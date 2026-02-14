#!/usr/bin/env python3
"""Extract the last frame of a video to a PNG using ffmpeg.

Usage:
  extract_last_frame.py <input.mp4> <output.png>

Strategy:
- Probe duration
- Seek to (duration - 0.10s)
- Export a single frame
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def sh(cmd: list[str]) -> str:
    return subprocess.check_output(cmd, stderr=subprocess.STDOUT).decode("utf-8", errors="replace")


def main():
    if len(sys.argv) != 3:
        print("Usage: extract_last_frame.py <input.mp4> <output.png>", file=sys.stderr)
        sys.exit(2)

    inp = Path(sys.argv[1])
    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)

    if not inp.exists():
        raise SystemExit(f"Input not found: {inp}")

    # duration (seconds)
    probe = sh(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(inp),
        ]
    )
    j = json.loads(probe)
    dur = float((j.get("format") or {}).get("duration") or 0.0)
    if dur <= 0.2:
        raise SystemExit(f"Bad duration from ffprobe: {dur}")

    ts = max(dur - 0.10, 0.0)

    # Extract frame
    subprocess.check_call(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{ts:.3f}",
            "-i",
            str(inp),
            "-vframes",
            "1",
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            str(out),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    if not out.exists() or out.stat().st_size < 10_000:
        raise SystemExit(f"Output frame looks wrong: {out} ({out.stat().st_size if out.exists() else 'missing'})")

    print(str(out))


if __name__ == "__main__":
    main()
