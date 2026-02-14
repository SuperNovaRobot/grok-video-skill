#!/usr/bin/env python3
"""Base64-encode a file as a data URL.

Usage:
  b64_file.py /path/to/file.png

Prints a data: URL to stdout.
"""

import base64
import mimetypes
import sys
from pathlib import Path

p = Path(sys.argv[1])
if not p.exists():
    raise SystemExit(f"not found: {p}")

mime, _ = mimetypes.guess_type(str(p))
mime = mime or "application/octet-stream"
b = base64.b64encode(p.read_bytes()).decode("ascii")
print(f"data:{mime};base64,{b}")
