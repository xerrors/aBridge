import { createServer } from "node:http";

/** Owned targets for real-engine browser acceptance; no accounts or external sites. */
export async function browserTasks() {
  const submissions: unknown[] = [];
  const html = `<!doctype html><meta charset="utf-8"><title>aBridge browser tasks</title>
<style>body{font:18px system-ui;margin:25px}input,select,button{margin:8px;padding:8px}#scroll{height:100px;overflow:auto}#long{white-space:pre-wrap}</style>
<h1>Browser execution fixture</h1><input id="name" aria-label="Name"><input id="qty" aria-label="Quantity">
<input id="number" type="number" value="123"><input id="email" type="email" value="old@example.com">
<select id="city"><option value="sh">Shanghai</option><option value="bj">Beijing</option></select>
<button id="save">Save</button><button id="later">Load delayed</button><output id="status">Idle</output>
<div id="like" title="点赞（Q）" style="width:100px;height:40px;cursor:pointer">1.7万</div>
<table id="table"><tr><th>Item</th><th>Price</th></tr><tr><td>Apple</td><td>12</td></tr><tr><td>Pear</td><td>15</td></tr></table>
<iframe id="csp-frame" src="/csp-frame"></iframe>
<iframe id="frame" srcdoc="<input id=framed aria-label=Framed><script>window.trusted=false;document.getElementById('framed').oninput=e=>window.trusted=e.isTrusted</script>"></iframe>
<div id="scroll"><div style="height:900px">Scroll area</div></div><div id="long">${"Long page content. ".repeat(1200)}</div>
<script>
window.events=[];window.rows=[];window.hold=null;
let pressedAt=0,pressedTrusted=false;
document.getElementById('like').onmousedown=e=>{pressedAt=performance.now();pressedTrusted=e.isTrusted};
document.getElementById('like').onmouseup=e=>{window.hold={ms:performance.now()-pressedAt,trusted:pressedTrusted&&e.isTrusted};};
for(const id of ['name','qty'])document.getElementById(id).addEventListener('input',e=>events.push({type:'input',trusted:e.isTrusted}));
document.getElementById('save').onclick=async e=>{
 const row={name:document.getElementById('name').value,qty:document.getElementById('qty').value,city:document.getElementById('city').value,trusted:e.isTrusted};
 await fetch('/submit',{method:'POST',body:JSON.stringify(row)});rows.push(row);document.getElementById('status').textContent='Saved '+rows.length;
};
document.getElementById('later').onclick=()=>setTimeout(()=>{const x=document.createElement('p');x.id='ready';x.textContent='Ready';document.body.append(x)},250);
</script>`;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === "/csp-frame") {
        response
          .writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": "script-src 'none'",
          })
          .end('<input id="locked" value="CSP protected"><p id="frame-text">Strict frame content</p>');
      } else if (request.method === "POST" && request.url === "/submit") {
        let body = "";
        for await (const chunk of request) {
          body += String(chunk);
          if (body.length > 4096) throw Error("Fixture body too large");
        }
        submissions.push(JSON.parse(body));
        response.writeHead(200).end("OK");
      } else if (request.url === "/state") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(submissions));
      } else {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
      }
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture listen failed");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    submissions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
