/** Opt-in real browser acceptance. Uses ego-browser and owned local pages only. */
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { browserTasks } from "./fixtures/browser-tasks.js";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(root, ".local/browser-live-"));
const fixture = await browserTasks();
try {
  for (const [name, entry] of [
    ["bridge", "apps/browser/src/bridge.ts"],
    ["runtime", "apps/server/src/browser-runtime.ts"],
  ]) {
    await build({
      entryPoints: [join(root, entry)],
      outfile: join(temporary, name + ".mjs"),
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      plugins: [
        {
          name: "protocol",
          setup(b) {
            b.onResolve({ filter: /^@abridge\/protocol$/ }, () => ({
              path: join(root, "packages/protocol/src/index.ts"),
            }));
          },
        },
      ],
    });
  }
  const script = `
const {BrowserBridge}=await import(${JSON.stringify(join(temporary, "bridge.mjs"))});
const {BrowserRuntime}=await import(${JSON.stringify(join(temporary, "runtime.mjs"))});
const assert=(await import('node:assert/strict')).default;
const task=await taskSpace('aBridge browser execution acceptance');
console.log(JSON.stringify({taskSpaceId:task.spaceId}));
const pages=new Map();let next=1;
const event=()=>({listeners:[],addListener(f){this.listeners.push(f)},removeListener(f){this.listeners=this.listeners.filter(x=>x!==f)},emit(...a){for(const f of this.listeners)f(...a)}});
const updates=event(),removed=event(),cdpEvents=event();
const chrome={tabs:{onUpdated:updates,onRemoved:removed,
async create({url}){const id=next++,p=await task.newPage();pages.set(id,p);await p.goto(url);return {id,url,status:'complete'}},
async get(id){const p=pages.get(id);if(!p)throw Error('Missing tab');return {id,url:await p.url(),title:await p.title(),status:'complete'}},
async update(id,{url}){updates.emit(id,{status:'loading',url});await pages.get(id).goto(url);return this.get(id)},
async remove(id){await pages.get(id).close();pages.delete(id);removed.emit(id)}},
debugger:{onDetach:event(),onEvent:cdpEvents,async attach(){},async detach(){},async sendCommand({tabId},method,params){const p=pages.get(tabId);const result=await p.cdp(method,params);for(const e of await p.events())cdpEvents.emit({tabId},e.method,e.params);return result}}};
const bridge=new BrowserBridge(chrome),runtime=new BrowserRuntime();const keepAlive=setInterval(()=>{},1000);
let request=0;async function call(method,params={}){const r=await bridge.dispatch({id:'live-'+(++request),method,session_id:'live',params});if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.result}
try {
 await call('open',{url:${JSON.stringify(fixture.url)}});
 const result=await runtime.run('live',
  "for(let i=0;i<3;i++){await page.locator('#name').fill('Item '+i);await page.locator('#qty').fill(String(i+1));await page.locator('#city').select(['bj']);await page.locator('#save').click();await page.wait({selector:'#status',text:'Saved '+(i+1)});}state.count=3;return await page.evaluate('window.rows');",
  call,new AbortController().signal);
 assert.equal(result.value.length,3);assert.equal(result.value[2].name,'Item 2');assert.ok(result.value.every(r=>r.trusted));
 console.log('PASS batch form loop: 3 native trusted submissions');
 const fields=await runtime.run('live',${JSON.stringify("await page.locator('#number').fill('456');await page.locator('#email').fill('new@example.com');await page.locator('#name').fill('');return await page.evaluate(()=>({number:document.getElementById('number').value,email:document.getElementById('email').value,name:document.getElementById('name').value}));")},call,new AbortController().signal);assert.deepEqual(fields.value,{number:'456',email:'new@example.com',name:''});console.log('PASS number/email replacement and empty fill');
 const state=await runtime.run('live','return state.count;',call,new AbortController().signal);assert.equal(state.value,3);console.log('PASS persistent state');
 await call('locate_act',{selector:'#later',action:{type:'click'}});await call('wait',{selector:'#ready',state:'visible',timeout_ms:3000});console.log('PASS delayed condition wait');
 const first=await call('read',{selector:'#long',limit:1000});let content=first.text,offset=first.next_offset;while(offset!==null){const p=await call('read',{snapshot_id:first.snapshot_id,offset,limit:1000});content+=p.text;offset=p.next_offset}assert.equal(content,'Long page content. '.repeat(1200));console.log('PASS long text snapshot pagination');
 const table=await call('read',{selector:'#table',mode:'tables'});assert.equal(table.rows.length,3);assert.equal(table.rows[1].cells[0].text,'Apple');console.log('PASS structured table extraction');
 await call('locate_act',{selector:'#name',action:{type:'fill',text:'replace'}});await call('locate_act',{selector:'#name',action:{type:'press',key:'End'}});await call('locate_act',{selector:'#name',action:{type:'press',key:'Backspace'}});const typed=await call('evaluate',{expression:"document.getElementById('name').value"});assert.equal(typed.value,'replac');console.log('PASS keyboard editing');
 await call('locate_act',{selector:'#scroll',action:{type:'scroll',delta_y:250}});await call('wait',{selector:'#scroll',state:'visible'});const scrolled=await call('evaluate',{expression:"new Promise(resolve=>{const deadline=Date.now()+1500;const poll=()=>{const value=document.getElementById('scroll').scrollTop;if(value>0||Date.now()>deadline)resolve(value);else setTimeout(poll,20)};poll()})"});assert.ok(scrolled.value>0);console.log('PASS scroll');
 const frame=await runtime.run('live',${JSON.stringify("await page.frameLocator('#frame').locator('#framed').fill('Frame value');return await page.frameLocator('#frame').evaluate(() => ({value:document.getElementById('framed').value,trusted:window.trusted}));")},call,new AbortController().signal);assert.equal(frame.value.value,'Frame value');assert.equal(frame.value.trusted,true);console.log('PASS same-origin iframe trusted input');
 const csp=await runtime.run('live',${JSON.stringify("await page.frameLocator('#csp-frame').locator('#locked').fill('CSP fill');await page.frameLocator('#csp-frame').wait({selector:'#locked',state:'value',value:'CSP fill'});const text=await page.frameLocator('#csp-frame').read({selector:'#frame-text'});const realm=await page.frameLocator('#csp-frame').evaluate(function(){return this===window && document.querySelector('#locked').value==='CSP fill'});return {text:text.text,realm};")},call,new AbortController().signal);assert.equal(csp.value.text,'Strict frame content');assert.equal(csp.value.realm,true);console.log('PASS CSP iframe read/wait/input and correct realm');
 await bridge.stop();await runtime.closeAll();clearInterval(keepAlive);console.log('ALL LIVE TASKS PASSED');
}catch(error){await bridge.stop();await runtime.closeAll();clearInterval(keepAlive);console.log('LIVE FAILURE '+error.stack);throw error}
`;
  let taskSpaceId: number | undefined;
  const status = await new Promise<number>((resolve, reject) => {
    const child = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      output += chunk.toString();
      const match = output.match(/"taskSpaceId":(\d+)/);
      if (match) taskSpaceId = Number(match[1]);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
    child.stdin.end(script);
  });
  process.exitCode = status;
  if (!status && taskSpaceId !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = spawn("ego-browser", ["nodejs"], { stdio: ["pipe", "inherit", "inherit"] });
      cleanup.on("error", reject);
      cleanup.on("exit", (code) => (code === 0 ? resolve() : reject(Error("Browser task cleanup failed"))));
      cleanup.stdin.end(`const task=await taskSpace(${taskSpaceId});await task.finish({keep:[]});`);
    });
  }
  if (!status && fixture.submissions.length !== 3) throw Error("Expected three server-confirmed submissions");
} finally {
  await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
