#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: concat_videos.sh <videos_dir> <output.mp4>" >&2
  exit 2
fi

VIDEOS_DIR="$1"
OUT="$2"

if [[ ! -d "$VIDEOS_DIR" ]]; then
  echo "Videos dir not found: $VIDEOS_DIR" >&2
  exit 1
fi

TMP_LIST="/tmp/grok_video_concat_$$.txt"

# Collect scene_XX.mp4 in order
ls -1 "$VIDEOS_DIR"/scene_*.mp4 >/dev/null 2>&1 || {
  echo "No scene_*.mp4 files in $VIDEOS_DIR" >&2
  exit 1
}

rm -f "$TMP_LIST"
for f in $(ls -1 "$VIDEOS_DIR"/scene_*.mp4 | sort); do
  echo "file '$f'" >> "$TMP_LIST"
done

mkdir -p "$(dirname "$OUT")"

ffmpeg -f concat -safe 0 -i "$TMP_LIST" -c copy -y "$OUT" >/dev/null 2>&1

rm -f "$TMP_LIST"

echo "$OUT"
