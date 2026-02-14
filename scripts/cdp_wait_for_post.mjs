#!/usr/bin/env node
// Wait until the current tab URL is a Grok Imagine post page.
// Usage:
//   CDP_WS=ws://... TIMEOUT_MS=30000 node scripts/cdp_wait_for_post.mjs

const wsUrl = process.env.CDP_WS;
const timeoutMs = Number(process.env.TIMEOUT_MS || 30000);
if (!wsUrl) {
  console.error('CDP_WS is required');
  process.exit(2);
}

let id = 0;
const pending = new Map();

function send(ws, method, params) {
  const msg = { id: ++id, method, params };
  ws.send(JSON.stringify(msg));
  return new Promise((resolve, reject) => pending.set(msg.id, { resolve, reject, method }));
}

const ws = new WebSocket(wsUrl);
ws.addEventListener('message', (ev) => {
  const d = JSON.parse(ev.data);
  if (d.id && pending.has(d.id)) {
    const p = pending.get(d.id);
    pending.delete(d.id);
    if (d.error) p.reject(new Error(`${p.method} error: ${d.error.message}`));
    else p.resolve(d.result);
  }
});

async function evalJS(expression) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  return r.result?.value;
}

ws.addEventListener('open', async () => {
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const href = await evalJS('location.href');
      if (typeof href === 'string' && href.includes('/imagine/post/')) {
        console.log(JSON.stringify({ ok: true, href }));
        ws.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.log(JSON.stringify({ ok: false, err: 'timeout', href: await evalJS('location.href') }));
    ws.close();
    process.exit(2);
  } catch (e) {
    console.error(String(e && (e.stack || e.message || e)));
    try { ws.close(); } catch {}
    process.exit(1);
  }
});
