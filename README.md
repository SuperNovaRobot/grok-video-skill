# grok-video-skill

OpenClaw skill: Grok Imagine multi-scene video generation (CDP-first, Cloudflare-proof downloads).

## Deterministic runner (idler/orchestrator)

This repo includes a resumable runner that executes a JSON project plan scene-by-scene.

### 1) Create a project JSON
See: `projects/bb_nova_intro_v1.json`

### 2) Run
You need a Grok Imagine tab open in the OpenClaw-managed browser.

Get the CDP wsUrl with OpenClaw `browser.tabs` (profile=openclaw), then:

```bash
node scripts/run_project.mjs \
  --project projects/bb_nova_intro_v1.json \
  --cdp-ws "ws://127.0.0.1:18800/devtools/page/<TAB_ID>" \
  --out /home/clawdbot/clawd/outputs/grok-video/my_run \
  --anchor /abs/path/to/anchor.png
```

Outputs:
- `videos/scene_XX.mp4`
- `tail/scene_XX/frame_001.png…frame_010.png`
- `frames/scene_XX_seed.png` (defaults to **10-from-last**)
- `output/final.mp4`

Resumable: re-run the command; completed scenes are skipped.
