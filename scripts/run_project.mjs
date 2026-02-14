#!/usr/bin/env node
/*
Run a Grok Imagine multi-scene project deterministically.

- Uses existing CDP scripts in this repo:
  - cdp_attach_image.mjs
  - cdp_make_video.mjs
  - cdp_wait_for_video.mjs
  - cdp_download_mp4.mjs
- Extracts tail frames via extract_tail_frames.py (10-from-last seed)
- Concats via concat_videos.sh

Usage:
  node scripts/run_project.mjs --project projects/bb_nova_intro_v1.json --cdp-ws "ws://127.0.0.1:18800/devtools/page/..." --out outputs/my_run --anchor /abs/path/to/anchor.png

Resumable:
- If videos/scene_XX.mp4 exists and tail/scene_XX/frame_001.png exists, skips that scene.
*/

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(' ')}`);
}

function shCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
  if (r.status !== 0) throw new Error(`command failed: ${cmd} ${args.join(' ')}`);
  return (r.stdout || '').trim();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writePromptFile(tmpDir, idx, prompt) {
  const p = path.join(tmpDir, `scene_${String(idx).padStart(2, '0')}.txt`);
  fs.writeFileSync(p, prompt, 'utf-8');
  return p;
}

function existsNonEmpty(p) {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

function buildPrompt({ idx, scene, say, how, defaults }) {
  const lines = [];
  lines.push(`Scene ${idx}:`);
  lines.push(
    `SCENE: ${defaults.characterLock} ${scene} ${defaults.style}. ${defaults.negatives}`
  );
  lines.push(`WHAT SHE SAYS: "${say}"`);
  lines.push(`HOW SHE SAYS IT: ${how}`);
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const out = { };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--cdp-ws') out.cdpWs = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--anchor') out.anchor = argv[++i];
    else if (a === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (a === '--help') out.help = true;
    else die(`Unknown arg: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.project || !args.cdpWs || !args.out || !args.anchor) {
    console.log(`Usage:\n  node scripts/run_project.mjs --project <json> --cdp-ws <ws://...> --out <dir> --anchor <png> [--timeout-ms 300000]`);
    process.exit(args.help ? 0 : 2);
  }

  const projectPath = path.resolve(args.project);
  const outDir = path.resolve(args.out);
  const repoDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

  const proj = JSON.parse(fs.readFileSync(projectPath, 'utf-8'));
  const timeoutMs = args.timeoutMs || 300000;

  const videosDir = path.join(outDir, 'videos');
  const tailDir = path.join(outDir, 'tail');
  const framesDir = path.join(outDir, 'frames');
  const outputDir = path.join(outDir, 'output');
  const tmpDir = path.join(outDir, 'tmp_prompts');

  [videosDir, tailDir, framesDir, outputDir, tmpDir].forEach(ensureDir);

  // copy anchor
  const anchorOut = path.join(framesDir, 'scene_00_anchor.png');
  fs.copyFileSync(path.resolve(args.anchor), anchorOut);

  const runlog = path.join(outDir, 'runlog.md');
  if (!existsNonEmpty(runlog)) {
    fs.writeFileSync(
      runlog,
      `# Grok video run log\n\n- project: ${proj.name || path.basename(projectPath)}\n- started_at: ${new Date().toISOString()}\n- seed_strategy: tailFrames=${proj.seed?.tailFrames ?? 10}, pickFromTail=${proj.seed?.pickFromTail ?? 1}\n- anchor: ${anchorOut}\n\n`,
      'utf-8'
    );
  }

  let seedPath = anchorOut;
  for (let i = 0; i < proj.scenes.length; i++) {
    const idx = i + 1;
    const s = proj.scenes[i];
    const mp4 = path.join(videosDir, `scene_${String(idx).padStart(2, '0')}.mp4`);
    const tailSceneDir = path.join(tailDir, `scene_${String(idx).padStart(2, '0')}`);
    const seedOut = path.join(framesDir, `scene_${String(idx).padStart(2, '0')}_seed.png`);

    const tailSeed = path.join(tailSceneDir, `frame_${String(proj.seed?.pickFromTail ?? 1).padStart(3, '0')}.png`);

    const already = existsNonEmpty(mp4) && existsNonEmpty(tailSeed) && existsNonEmpty(seedOut);
    if (already) {
      console.log(`scene_${String(idx).padStart(2, '0')}: skip (already exists)`);
      seedPath = seedOut;
      continue;
    }

    ensureDir(tailSceneDir);

    const prompt = buildPrompt({ idx, scene: s.scene, say: s.say, how: s.how, defaults: proj.defaults });
    const promptFile = writePromptFile(tmpDir, idx, prompt);

    // Navigate to imagine (best-effort) by reusing the existing helper if present
    const nav = path.join(outDir, 'cdp_nav_url_timeout.mjs');
    if (!fs.existsSync(nav)) {
      // vendor a tiny nav helper into outDir for portability
      fs.writeFileSync(nav, `#!/usr/bin/env node\nconst wsUrl=process.env.CDP_WS; const url=process.env.URL; const timeoutMs=Number(process.env.TIMEOUT_MS||30000);\nlet id=0; const pending=new Map();\nfunction send(ws,method,params){const msg={id:++id,method,params};ws.send(JSON.stringify(msg));return new Promise((res,rej)=>pending.set(msg.id,{res,rej}));}\nasync function evalJS(ws,expression){const r=await send(ws,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});return r.result?.value;}\nconst ws=new WebSocket(wsUrl);\nconst timer=setTimeout(()=>{console.log(JSON.stringify({ok:false,err:'timeout'}));try{ws.close();}catch{}process.exit(2);}, timeoutMs);\nws.addEventListener('message',ev=>{const d=JSON.parse(ev.data);if(d.id&&pending.has(d.id)){const p=pending.get(d.id);pending.delete(d.id);d.error?p.rej(new Error(d.error.message)):p.res(d.result);}});\nws.addEventListener('open',async()=>{try{await evalJS(ws,`+"`"+`(()=>{location.href=${JSON.stringify(url)};return true;})()`+"`"+`);clearTimeout(timer);console.log(JSON.stringify({ok:true,url}));ws.close();}catch(e){clearTimeout(timer);console.log(JSON.stringify({ok:false,err:String(e)}));try{ws.close();}catch{}process.exit(1);}});\n`, 'utf-8');
      fs.chmodSync(nav, 0o755);
    }

    // 1) go imagine
    sh('node', [nav], { env: { ...process.env, CDP_WS: args.cdpWs, URL: 'https://grok.com/imagine', TIMEOUT_MS: '30000' } });

    // 2) attach seed
    sh('node', [path.join(repoDir, 'scripts/cdp_attach_image.mjs')], { env: { ...process.env, CDP_WS: args.cdpWs, IMG_PATH: seedPath } });

    // 3) make video (twice to handle imagine->post)
    sh('node', [path.join(repoDir, 'scripts/cdp_make_video.mjs')], { env: { ...process.env, CDP_WS: args.cdpWs, PROMPT_FILE: promptFile } });
    try { sh('node', [path.join(repoDir, 'scripts/cdp_make_video.mjs')], { env: { ...process.env, CDP_WS: args.cdpWs, PROMPT_FILE: promptFile } }); } catch {}

    // 4) wait
    sh('node', [path.join(repoDir, 'scripts/cdp_wait_for_video.mjs')], { env: { ...process.env, CDP_WS: args.cdpWs, TIMEOUT_MS: String(timeoutMs) } });

    // 5) download
    if (fs.existsSync(mp4)) fs.unlinkSync(mp4);
    sh('node', [path.join(repoDir, 'scripts/cdp_download_mp4.mjs')], { env: { ...process.env, CDP_WS: args.cdpWs, OUT_PATH: mp4 } });

    // 6) tail frames
    sh('python3', [path.join(repoDir, 'scripts/extract_tail_frames.py'), mp4, tailSceneDir, '--frames', String(proj.seed?.tailFrames ?? 10)]);

    // 7) seed out
    fs.copyFileSync(tailSeed, seedOut);

    fs.appendFileSync(runlog, `## Scene ${idx}\n\n\n\`\`\`\n${prompt}\`\`\`\n\n- mp4: ${mp4}\n- seed: ${seedOut}\n\n`, 'utf-8');

    console.log(`scene_${String(idx).padStart(2, '0')}: OK`);
    seedPath = seedOut;
  }

  // concat all present
  const finalMp4 = path.join(outputDir, 'final.mp4');
  sh('bash', [path.join(repoDir, 'scripts/concat_videos.sh'), videosDir, finalMp4]);
  const dur = shCapture('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', finalMp4], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(JSON.stringify({ ok: true, finalMp4, duration: dur }));
}

main().catch(e => {
  console.error(String(e?.stack || e));
  process.exit(1);
});
