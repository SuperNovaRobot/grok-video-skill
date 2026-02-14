#!/usr/bin/env node
/**
 * Type prompt into Grok Imagine "Make a video" textbox and click "Make video".
 * Works via CDP Runtime.evaluate so it doesn't depend on OpenClaw browser act/type.
 *
 * Usage:
 *   CDP_WS='ws://127.0.0.1:18800/devtools/page/<targetId>' \
 *   PROMPT_FILE='/path/to/prompt.txt' \
 *   node cdp_make_video.mjs
 */

import fs from 'node:fs';

const wsUrl = process.env.CDP_WS;
const promptFile = process.env.PROMPT_FILE;
if (!wsUrl) throw new Error('CDP_WS required');
if (!promptFile) throw new Error('PROMPT_FILE required');
const prompt = fs.readFileSync(promptFile, 'utf8');

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
  return send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    .then(r => {
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

    const res = await evalJS(ws, `(() => {
      const prompt = ${JSON.stringify(prompt)};
      // find the video prompt textarea (post page)
      let ta = document.querySelector('textarea[placeholder*="customize video"], textarea[aria-label*="customize"], textarea');

      // If we're not on a post page, try to click the "Video" mode toggle first.
      if (!location.href.includes('/imagine/post/')) {
        const tabs = [...document.querySelectorAll('button, [role=tab]')];
        const videoTab = tabs.find(b => /^\s*video\s*$/i.test(b.textContent||'') || /video/i.test(b.getAttribute('aria-label')||''));
        if (videoTab) videoTab.click();
      }

      ta = document.querySelector('textarea[placeholder*="customize video"], textarea[aria-label*="customize"], textarea');

      const btns = [...document.querySelectorAll('button')];

      // If on /imagine, the composer can be contenteditable instead of textarea.
      if (!ta) {
        const ce = document.querySelector('[contenteditable="true"]');
        if (ce) {
          ce.focus();
          // Clear and set
          document.execCommand?.('selectAll', false);
          document.execCommand?.('insertText', false, prompt);
          ce.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // some builds use a <p> placeholder inside a div; try nearest editable parent
          const p = [...document.querySelectorAll('p')].find(x => /type to imagine/i.test(x.textContent||''));
          const host = p?.closest('[contenteditable="true"], textarea, [role="textbox"]');
          if (host) {
            host.focus();
            host.textContent = prompt;
            host.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            return { ok:false, err:'no textarea or contenteditable composer found', href: location.href };
          }
        }
      } else {
        ta.focus();
        ta.value = prompt;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // find make video button (post page)
      const mk = btns.find(b => /make video/i.test(b.textContent||'') || /make a video/i.test(b.textContent||'') || /make video/i.test(b.getAttribute('aria-label')||''));
      if (mk) { mk.click(); return { ok:true, clicked:true, mode:'post-make-video' }; }

      // Submit button on /imagine
      const submit = btns.find(b => /submit/i.test(b.getAttribute('aria-label')||'') || /submit/i.test(b.title||'') || b.type==='submit');
      if (submit && !submit.disabled) { submit.click(); return { ok:true, clicked:true, mode:'imagine-submit' }; }

      return { ok:false, err:'no Make video/Submit button found', buttons: btns.length, href: location.href };
    })()`);

    if (!res?.ok) throw new Error('make_video failed: ' + (res?.err || JSON.stringify(res)));

    console.log(JSON.stringify({ ok:true }));
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
