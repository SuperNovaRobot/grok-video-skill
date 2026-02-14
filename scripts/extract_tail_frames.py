#!/usr/bin/env python3
"""Extract the last N frames from a video into a folder.

Why:
- Grok sometimes ends on a motion-blurred/transition frame.
- Using the *absolute last* frame can be a bad seed.

This extracts a small tail window and you can pick e.g. frame_005.png.

Usage:
  python3 extract_tail_frames.py in.mp4 out_dir --frames 15
  python3 extract_tail_frames.py in.mp4 out_dir --seconds 0.6 --fps 30

Defaults:
- frames=15 (if not specified)
- fps=30 (only used with --seconds)
"""

import argparse
import os
import subprocess


def run(cmd):
    subprocess.check_call(cmd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input')
    ap.add_argument('out_dir')
    ap.add_argument('--frames', type=int, default=15, help='How many final frames to extract')
    ap.add_argument('--seconds', type=float, default=None, help='Tail window (seconds). If set, extracts seconds*fps frames')
    ap.add_argument('--fps', type=int, default=30, help='FPS used when --seconds is provided')
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    # Determine how many frames to pull
    n = args.frames
    if args.seconds is not None:
        n = max(1, int(round(args.seconds * args.fps)))

    # ffmpeg select last N frames: select between(n, total-N, total-1)
    # We use -vsync 0 to avoid duplication.
    # Note: This relies on frame count; ffmpeg handles it.
    out_pat = os.path.join(args.out_dir, 'frame_%03d.png')

    cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error',
        '-i', args.input,
        '-vf', f"select='between(n,\\,max(0\\,N-{n})\\,N-1)',setpts=N/FRAME_RATE/TB",
        '-vsync', '0',
        out_pat,
    ]

    # The expression above uses N (frame count) which isn't available directly in select.
    # So we do a robust approach: reverse, take first n frames, reverse back.
    # (More reliable across ffmpeg builds)
    tmp_pat = os.path.join(args.out_dir, 'tmp_%03d.png')
    cmd = [
        'ffmpeg', '-hide_banner', '-loglevel', 'error',
        '-i', args.input,
        '-vf', f"reverse,fps={args.fps},trim=0:{(n/args.fps):.6f},reverse",
        '-vsync', '0',
        tmp_pat,
    ]

    # Extract
    run(cmd)

    # Rename tmp_### to frame_### in sorted order
    files = sorted([f for f in os.listdir(args.out_dir) if f.startswith('tmp_') and f.endswith('.png')])
    for i, f in enumerate(files, start=1):
        src = os.path.join(args.out_dir, f)
        dst = os.path.join(args.out_dir, f'frame_{i:03d}.png')
        os.replace(src, dst)

    print(os.path.join(args.out_dir, f'frame_{len(files):03d}.png'))


if __name__ == '__main__':
    main()
