#!/usr/bin/env python3
"""Assemble base64 chunks (optionally a data: URL prefix) into a binary file.

Usage:
  python3 assemble_b64_chunks.py /tmp/chunks_dir out.mp4

Expects files named chunk_000.txt, chunk_001.txt, ... containing raw base64 text.
The first chunk may start with 'data:video/mp4;base64,' (or any data:*;base64,) prefix.
"""

import base64
import os
import re
import sys
from pathlib import Path


def main():
    if len(sys.argv) != 3:
        print(__doc__.strip())
        sys.exit(2)

    chunks_dir = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    if not chunks_dir.exists():
        raise SystemExit(f"Chunks dir not found: {chunks_dir}")

    chunk_files = sorted(chunks_dir.glob("chunk_*.txt"))
    if not chunk_files:
        raise SystemExit(f"No chunk_*.txt files in {chunks_dir}")

    b64_parts: list[str] = []
    for p in chunk_files:
        s = p.read_text(encoding="utf-8").strip()
        if not s:
            continue
        b64_parts.append(s)

    if not b64_parts:
        raise SystemExit("All chunks empty")

    b64 = "".join(b64_parts)

    # Strip any data URL prefix
    m = re.match(r"^data:[^;]+;base64,", b64)
    if m:
        b64 = b64[m.end():]

    # Base64 decode (handle missing padding)
    pad = (-len(b64)) % 4
    if pad:
        b64 += "=" * pad

    data = base64.b64decode(b64, validate=False)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    print(f"Wrote {len(data)} bytes -> {out_path}")


if __name__ == "__main__":
    main()
