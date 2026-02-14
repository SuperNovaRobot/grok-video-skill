#!/usr/bin/env node
/**
 * Download a Grok Imagine MP4 in a Cloudflare-safe way by fetching it INSIDE the
 * already-authenticated browser tab, then streaming base64 chunks over CDP and
 * writing bytes directly to OUT_PATH.
 *
 * Usage:
 *   CDP_WS='<ws://127.0.0.1:18800/devtools/page/...>' \
 *   OUT_PATH='/path/to/scene_02.mp4' \
 *   node cdp_download_mp4.mjs
 *
 * Optional:
 *   SRC_URL='https://assets.grok.com/.../generated_video.mp4?...'
 *   CHUNK_CHARS='1000000'
 */

import fs from 'node:fs';
import path from 'node:path';

const wsUrl = process.env.CDP_WS;
const outPath = process.env.OUT_PATH;
const srcUrlEnv = process.env.SRC_URL;
const chunkChars = Number(process.env.CHUNK_CHARS || '1000000');

if (!wsUrl) throw new Error('CDP_WS env var required');
if (!outPath) throw new Error('OUT_PATH env var required');

fs.mkdirSync(path.dirname(outPath), { recursive: true });

let id = 0;
const pending = new Map();

function send(ws, method, params) {
  const msg = { id: ++id, method, params };
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => {
    pending.set(msg.id, { resolve, reject, method });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function evalJS(ws, expression, { awaitPromise = true } = {}) {
  return send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  }).then(r => {
    if (r.exceptionDetails) {
      throw new Error('Runtime.evaluate exception: ' + JSON.stringify(r.exceptionDetails));
    }
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
    // Ensure runtime is enabled (usually is)
    try { await send(ws, 'Runtime.enable', {}); } catch {}

    const srcUrl = srcUrlEnv || await evalJS(ws, `(() => {
      const v = document.querySelector('video');
      return v?.currentSrc || null;
    })()`);

    if (!srcUrl) throw new Error('Could not find video.currentSrc and no SRC_URL provided');

    // Strategy:
    // 1) Try in-page fetch -> dataURL (fast when CORS allows).
    // 2) If that fails (common when server blocks CORS), fall back to CDP Network
    //    capture of the MP4 response body (bypasses CORS because it’s browser network).

    let wrote = 0;

    async function tryInPageFetchToFile() {
      await evalJS(ws, `(() => {
        const src = ${JSON.stringify(srcUrl)};
        window.__oc_mp4 = { src, ready:false, err:null, b64:'', pos:0, chunk:${chunkChars} };
        (async () => {
          try {
            const r = await fetch(src, { credentials: 'include' });
            if (!r.ok) throw new Error('fetch failed ' + r.status);
            const blob = await r.blob();
            const fr = new FileReader();
            const p = new Promise((res, rej) => {
              fr.onload = () => res(fr.result);
              fr.onerror = () => rej(fr.error);
            });
            fr.readAsDataURL(blob);
            const dataUrl = await p;
            const b64 = String(dataUrl).split(',')[1] || '';
            window.__oc_mp4.b64 = b64;
            window.__oc_mp4.ready = true;
          } catch (e) {
            window.__oc_mp4.err = String(e && (e.stack||e.message||e));
          }
        })();
        return window.__oc_mp4;
      })()`);

      for (let i = 0; i < 120; i++) {
        const st = await evalJS(ws, `(() => {
          const d = window.__oc_mp4;
          if (!d) return { ok:false };
          return { ok:true, ready:d.ready, err:d.err, len:d.b64?.length||0, pos:d.pos||0, src:d.src };
        })()`);
        if (!st?.ok) throw new Error('Missing window.__oc_mp4');
        if (st.err) throw new Error('In-page fetch error: ' + st.err);
        if (st.ready) break;
        await sleep(250);
      }

      const meta = await evalJS(ws, `(() => ({ len: window.__oc_mp4?.b64?.length||0 }))()`);
      if (!meta?.len) throw new Error('No base64 data captured');

      const fd = fs.openSync(outPath, 'w');
      try {
        while (true) {
          const chunk = await evalJS(ws, `(() => {
            const d = window.__oc_mp4;
            if (!d || !d.b64) return { done:true, chunk:null, pos:0, len:0 };
            const start = d.pos || 0;
            const end = Math.min(start + d.chunk, d.b64.length);
            const part = d.b64.slice(start, end);
            d.pos = end;
            return { done: end >= d.b64.length, chunk: part, pos: d.pos, len: d.b64.length };
          })()`);

          if (!chunk?.chunk) {
            if (chunk?.done) break;
            throw new Error('Empty chunk without done=true');
          }

          const buf = Buffer.from(chunk.chunk, 'base64');
          fs.writeSync(fd, buf);
          wrote += buf.length;

          if (chunk.done) break;
        }
      } finally {
        fs.closeSync(fd);
      }

      return { ok: true, method: 'in-page-fetch' };
    }

    async function cdpFetchStreamToFile() {
      // Robust fallback: intercept the MP4 response via Fetch domain and stream it with IO.read.
      // Works even when media loads via range requests / CORS blocks JS fetch.

      let done = false;
      let mp4Url = null;
      let wroteLocal = 0;

      const fd = fs.openSync(outPath, 'w');

      const handler = async (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.method !== 'Fetch.requestPaused') return;

        const p = msg.params;
        const url = p.request?.url || '';
        const isMp4 = url.includes('.mp4') && (/share-videos|generated_video|assets\.grok\.com|imagine-public/i.test(url));

        // Always continue non-mp4 quickly.
        if (!isMp4 || done) {
          try {
            await send(ws, 'Fetch.continueRequest', { requestId: p.requestId });
          } catch {}
          return;
        }

        // We want the RESPONSE stage so we can read the body.
        if (!p.responseStatusCode) {
          try {
            await send(ws, 'Fetch.continueRequest', { requestId: p.requestId });
          } catch {}
          return;
        }

        mp4Url = url;

        try {
          const streamRes = await send(ws, 'Fetch.takeResponseBodyAsStream', { requestId: p.requestId });
          const stream = streamRes.stream;
          while (true) {
            const r = await send(ws, 'IO.read', { handle: stream });
            const data = r.data || '';
            const buf = r.base64Encoded ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
            if (buf.length) {
              fs.writeSync(fd, buf);
              wroteLocal += buf.length;
            }
            if (r.eof) break;
          }
          try { await send(ws, 'IO.close', { handle: stream }); } catch {}
          try { await send(ws, 'Fetch.continueRequest', { requestId: p.requestId }); } catch {}
          done = true;
        } catch (e) {
          try { await send(ws, 'Fetch.continueRequest', { requestId: p.requestId }); } catch {}
          done = true;
          throw e;
        }
      };

      ws.addEventListener('message', handler);
      try {
        await send(ws, 'Fetch.enable', {
          patterns: [
            { urlPattern: '*share-videos*', requestStage: 'Response' },
            { urlPattern: '*generated_video.mp4*', requestStage: 'Response' },
            { urlPattern: '*mp4*', requestStage: 'Response' },
          ],
        });

        // Trigger reload
        await evalJS(ws, `(() => {
          const v = document.querySelector('video');
          if (!v) return false;
          let s = v.currentSrc || v.src;
          // Force a new request (avoid cached media / previous requestId)
          const bust = 'ocbust=' + Date.now();
          s = s.includes('?') ? (s + '&' + bust) : (s + '?' + bust);
          v.src = s;
          v.load();
          v.play().catch(()=>{});
          return { forcedSrc: s };
        })()`);

        // Wait up to ~60s (prints a dot every ~2s so it’s not silent)
        for (let i = 0; i < 300; i++) {
          if (done) break;
          if (i % 10 === 0) process.stderr.write('.');
          await sleep(200);
        }
        process.stderr.write('\n');

        if (!done) throw new Error('CDP fetch-stream: timed out waiting for mp4');
        if (!wroteLocal) throw new Error('CDP fetch-stream: wrote 0 bytes');

        wrote = wroteLocal;
        return { ok: true, method: 'cdp-fetch-stream', mp4Url };
      } finally {
        ws.removeEventListener('message', handler);
        try { await send(ws, 'Fetch.disable', {}); } catch {}
        try { fs.closeSync(fd); } catch {}
      }
    }

    let method = null;
    try {
      const r1 = await tryInPageFetchToFile();
      method = r1.method;
    } catch (e) {
      // Expected sometimes due to CORS.
      process.stderr.write('[info] in-page fetch failed, falling back to CDP stream\n');
      const r2 = await cdpFetchStreamToFile();
      method = r2.method;
    }

    console.log(JSON.stringify({ ok: true, outPath, bytes: wrote, srcUrl, method }));
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
