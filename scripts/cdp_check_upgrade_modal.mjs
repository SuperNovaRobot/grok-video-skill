#!/usr/bin/env node
// Returns {ok:true, upgrade:true|false}
const wsUrl = process.env.CDP_WS;
if (!wsUrl) { console.error('CDP_WS required'); process.exit(2); }
let id=0; const pending=new Map();
function send(ws,method,params){const msg={id:++id,method,params};ws.send(JSON.stringify(msg));return new Promise((res,rej)=>pending.set(msg.id,{res,rej,method}));}
const ws=new WebSocket(wsUrl);
ws.addEventListener('message',ev=>{const d=JSON.parse(ev.data);if(d.id&&pending.has(d.id)){const p=pending.get(d.id);pending.delete(d.id);d.error?p.rej(new Error(`${p.method} error: ${d.error.message}`)):p.res(d.result);}});
async function evalJS(expression){const r=await send(ws,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});return r.result?.value;}
ws.addEventListener('open',async()=>{
  try{
    const res = await evalJS(`(()=>{
      const txt = (document.body && document.body.innerText) ? document.body.innerText : '';
      const upgrade = /upgrade to supergrok|supergrok/i.test(txt);
      const dlg = !!document.querySelector('[role=dialog], dialog');
      return { upgrade, hasDialog: dlg, href: location.href };
    })()`);
    console.log(JSON.stringify({ok:true, ...res}));
    ws.close();
  } catch(e){
    console.error(String(e&& (e.stack||e.message||e)));
    try{ws.close();}catch{}
    process.exit(1);
  }
});
