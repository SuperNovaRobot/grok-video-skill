#!/usr/bin/env node
/**
 * Wait until current page is a grok imagine post with a <video> element loaded.
 * Usage:
 *   CDP_WS=... node cdp_wait_for_video.mjs
 */
const wsUrl = process.env.CDP_WS;
const timeoutMs = Number(process.env.TIMEOUT_MS || '90000');
if (!wsUrl) throw new Error('CDP_WS required');
let id=0; const pending=new Map();
function send(ws, method, params){ const msg={id:++id,method,params}; ws.send(JSON.stringify(msg)); return new Promise((res,rej)=>pending.set(msg.id,{res,rej,method})); }
function evalJS(ws, expression){
  return send(ws,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}).then(r=>{
    if(r.exceptionDetails) throw new Error('eval exception');
    return r.result?.value;
  });
}
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
const ws=new WebSocket(wsUrl);
ws.addEventListener('message', ev=>{
  const data=JSON.parse(ev.data);
  if(data.id && pending.has(data.id)){
    const p=pending.get(data.id); pending.delete(data.id);
    if(data.error) p.rej(new Error(data.error.message)); else p.res(data.result);
  }
});
ws.addEventListener('open', async()=>{
  const start=Date.now();
  try{
    while(Date.now()-start < timeoutMs){
      const st = await evalJS(ws, `(() => {
        const href = location.href;
        const v = document.querySelector('video');
        return { href, hasVideo: !!v, src: v?.currentSrc || v?.src || null };
      })()`);
      // Only treat as ready when we are on a post page (avoids false positives from previews)
      if(st?.href?.includes('/imagine/post/') && st?.hasVideo && st?.src && /\.mp4/.test(st.src)){
        console.log(JSON.stringify({ok:true, href: st.href, src: st.src}));
        ws.close();
        return;
      }
      await sleep(1000);
    }
    throw new Error('timeout waiting for video');
  }catch(e){
    console.error(String(e&& (e.stack||e.message||e)));
    try{ws.close();}catch{}
    process.exit(1);
  }
});
ws.addEventListener('error', e=>{ console.error('ws error', e); process.exit(1); });
