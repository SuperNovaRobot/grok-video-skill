#!/usr/bin/env node
/**
 * Attach a local image file to Grok Imagine by injecting a Data URL into the page
 * (chunked, safe for large images), then using DataTransfer to set input[type=file].
 *
 * This avoids flaky OS file pickers and avoids huge one-shot page.evaluate payloads.
 *
 * Usage:
 *   CDP_WS='ws://127.0.0.1:18800/devtools/page/<targetId>' \
 *   IMG_PATH='/abs/path/to/image.png' \
 *   node cdp_attach_image.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const wsUrl = process.env.CDP_WS;
const imgPath = process.env.IMG_PATH;
const chunkChars = Number(process.env.CHUNK_CHARS || '120000');

if (!wsUrl) throw new Error('CDP_WS env var required');
if (!imgPath) throw new Error('IMG_PATH env var required');

const ext = path.extname(imgPath).toLowerCase();
const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
  : ext === '.webp' ? 'image/webp'
  : ext === '.gif' ? 'image/gif'
  : 'image/png';

const b64 = fs.readFileSync(imgPath).toString('base64');
const dataUrl = `data:${mime};base64,${b64}`;
const chunks = [];
for (let i = 0; i < dataUrl.length; i += chunkChars) chunks.push(dataUrl.slice(i, i + chunkChars));

let id = 0;
const pending = new Map();

function send(ws, method, params) {
  const msg = { id: ++id, method, params };
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject, method });
  });
}

function evalJS(ws, expression) {
  return send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  }).then(r => {
    if (r.exceptionDetails) throw new Error('Runtime.evaluate exception: ' + JSON.stringify(r.exceptionDetails));
    return r.result?.value;
  });
}

const ws = new WebSocket(wsUrl);
ws.addEventListener('message', (ev) => {
  const data = JSON.parse(ev.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject, method } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(`${method} error: ${data.error.message}`));
    else resolve(data.result);
  }
});

ws.addEventListener('open', async () => {
  try {
    try { await send(ws, 'Runtime.enable', {}); } catch {}

    await evalJS(ws, `(() => {
      window.__oc_img_parts = [];
      window.__oc_img_dataurl = '';
      return true;
    })()`);

    for (let i = 0; i < chunks.length; i++) {
      const c = JSON.stringify(chunks[i]);
      await evalJS(ws, `(() => { window.__oc_img_parts.push(${c}); return window.__oc_img_parts.length; })()`);
    }

    const attached = await evalJS(ws, `(() => {
      window.__oc_img_dataurl = window.__oc_img_parts.join('');
      return { len: window.__oc_img_dataurl.length, parts: window.__oc_img_parts.length };
    })()`);

    const res = await evalJS(ws, `(() => (async () => {
      const dataUrl = window.__oc_img_dataurl;
      if (!dataUrl) return { ok:false, err:'missing dataUrl' };

      // Find (or reveal) file input
      // Poll for input (UI can render lazily)
      let input = null;
      for (let i = 0; i < 20; i++) {
        input = document.querySelector('input[type=file]');
        if (input) break;
        await new Promise(r => setTimeout(r, 250));
      }

      if (!input) {
        // Try clicking the Attach button to reveal the file input
        const btns = [...document.querySelectorAll('button')];
        const attachBtn = btns.find(b => /^\s*attach\s*$/i.test(b.textContent||'') || /attach/i.test(b.getAttribute('aria-label')||''));
        if (attachBtn) attachBtn.click();
        for (let i = 0; i < 20; i++) {
          input = document.querySelector('input[type=file]');
          if (input) break;
          await new Promise(r => setTimeout(r, 250));
        }
      }

      if (!input) return { ok:false, err:'no input[type=file]' };

      const r = await fetch(dataUrl);
      const blob = await r.blob();
      const file = new File([blob], 'seed.png', { type: blob.type || 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      return { ok:true, fileName: file.name, fileSize: file.size, fileType: file.type, inputName: input.name, filesLen: input.files.length };
    })())()`);

    if (!res?.ok) throw new Error('Attach failed: ' + (res?.err || JSON.stringify(res)));

    console.log(JSON.stringify({ ok: true, injected: attached, attach: res }));
    ws.close();
  } catch (e) {
    console.error(String(e && (e.stack || e.message || e)));
    try { ws.close(); } catch {}
    process.exit(1);
  }
});

ws.addEventListener('error', (e) => {
  console.error('WebSocket error', e);
  process.exit(1);
});
