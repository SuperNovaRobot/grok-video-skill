#!/usr/bin/env node
// Best-effort dismiss of modal/popups (Escape + click background)
const wsUrl = process.env.CDP_WS;
if (!wsUrl) { console.error('CDP_WS required'); process.exit(2); }
let id=0; const pending=new Map();
function send(ws,method,params){const msg={id:++id,method,params};ws.send(JSON.stringify(msg));return new Promise((res,rej)=>pending.set(msg.id,{res,rej,method}));}
const ws=new WebSocket(wsUrl);
ws.addEventListener('message',ev=>{const d=JSON.parse(ev.data);if(d.id&&pending.has(d.id)){const p=pending.get(d.id);pending.delete(d.id);d.error?p.rej(new Error(`${p.method} error: ${d.error.message}`)):p.res(d.result);}});
async function evalJS(expression){const r=await send(ws,'Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});return r.result?.value;}
ws.addEventListener('open',async()=>{
  try{
    try{ await send(ws,'Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27}); }catch{}
    try{ await send(ws,'Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27}); }catch{}
    await evalJS(`(()=>{
      // click near top-left to close overlays
      const ev = new MouseEvent('click',{bubbles:true,clientX:10,clientY:10});
      document.elementFromPoint(10,10)?.dispatchEvent(ev);
      return true;
    })()`);
    console.log(JSON.stringify({ok:true}));
    ws.close();
  } catch(e){
    console.error(String(e&& (e.stack||e.message||e)));
    try{ws.close();}catch{}
    process.exit(1);
  }
});
