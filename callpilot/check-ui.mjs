#!/usr/bin/env node
// Read-only UI regression checks using Chrome DevTools Protocol and Node built-ins.
// No test framework or npm dependencies. Every browser API mutation is blocked.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.argv.includes('--help')) {
  console.log('Usage: node callpilot/check-ui.mjs [--url http://localhost:3001] [--chrome /path/to/chrome] [--screenshots /tmp/yap-checks]');
  console.log('Needs Node 22+, Chrome, a running local Yap server, and a saved ended call with topics and decisions. API mutations are blocked.');
  process.exit(0);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? fallback : process.argv[i + 1];
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = new URL(arg('url', 'http://127.0.0.1:8768'));
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Use a local Yap server URL.');
const chrome = arg('chrome', process.env.CHROME_BIN) || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(existsSync);
if (!chrome) throw new Error('Chrome not found. Pass --chrome /path/to/chrome.');
if (typeof WebSocket === 'undefined') throw new Error('This check needs Node with global WebSocket support (Node 22+).');
const output = arg('screenshots');
if (output) mkdirSync(output, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'yap-ui-check-'));
let child, socket, session, nextId = 0;
const pending = new Map(), mutations = [], errors = [];
function send(method, params = {}, target = session) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({id, method, params, ...(target ? {sessionId:target} : {})}));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function until(expression) {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(expression)) return;
    await pause(100);
  }
  throw new Error('UI did not become ready: ' + expression);
}
async function click(selector) {
  await evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); if(!e) throw Error('Missing control: '+${JSON.stringify(selector)}); e.click(); })()`);
}
function assert(value, message) { if (!value) throw new Error(message); }
async function screenshot(name) {
  if (!output) return;
  const r = await send('Page.captureScreenshot', {format:'png'});
  writeFileSync(join(resolve(output), name+'.png'), Buffer.from(r.data,'base64'));
}
async function key(key, code = key) {
  await send('Input.dispatchKeyEvent', {type:'keyDown',key,code});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key,code});
}
async function main() {
  const response = await fetch(new URL('/api/calls', url), {signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('Cannot read calls: HTTP '+response.status);
  const calls = await response.json();
  const call = calls.find(c => c.endedAt && c.segmentCount && c.counts.checkpoints && c.topics.length);
  if (!call) throw new Error('Needs a saved, ended call with topics and decisions. Run a scripted call first.');
  child = spawn(chrome, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'], {stdio:['ignore','ignore','pipe']});
  const wsUrl = await new Promise((resolve,reject) => {
    let log='';
    const timer=setTimeout(()=>reject(new Error('Chrome did not start.')),15000);
    child.once('error',e=>{clearTimeout(timer);reject(e)});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Chrome exited before starting.'))});
    child.stderr.on('data',chunk=>{log+=chunk;const match=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);resolve(match[1])}});
  });
  socket = new WebSocket(wsUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
  socket.addEventListener('message', event => {
    const m=JSON.parse(event.data);
    if(m.id){const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return;}
    if(m.method==='Fetch.requestPaused'){
      const {requestId,request}=m.params;
      const safe=['GET','HEAD','OPTIONS'].includes(request.method);
      if(!safe)mutations.push(request.method+' '+request.url);
      send(safe?'Fetch.continueRequest':'Fetch.failRequest',safe?{requestId}:{requestId,errorReason:'BlockedByClient'},m.sessionId).catch(e=>errors.push(e.message));
    }
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const {targetId}=await send('Target.createTarget',{url:'about:blank'},null);
  session=(await send('Target.attachToTarget',{targetId,flatten:true},null)).sessionId;
  await send('Page.enable');await send('Runtime.enable');
  await send('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:new URL('/#/call/'+call.id,url).href});
  await until('!!document.querySelector(".view-tabs")');
  for(const [view,selector] of [['focus','#cue'],['rundown','#rundown'],['topics','#topicsView'],['script','.col.script'],['details','#detailPanel']]){
    await click(`[role="tab"][data-tab="${view}"]`);
    assert(await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().height>0`),view+' did not open');
    const visible = await evaluate(`['#cue','#rundown','#topicsView','.col.script','#detailPanel'].filter(s => document.querySelector(s).getBoundingClientRect().height>0)`);
    assert(visible.length===1, 'Views overlap: '+visible.join(', '));
    await key('Escape');
    assert(await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab===${JSON.stringify(view)}`),'Escape changed the view');
    assert(!await evaluate('document.documentElement.scrollWidth>innerWidth'),'Horizontal page overflow');
    await screenshot(view);
  }
  for(const [view,row] of [['rundown','.card'],['topics','.topic']]){
    await click(`[role="tab"][data-tab="${view}"]`);
    const button=row+(view==='rundown'?' .card-head':' .topic-row');
    await click(button);await pause(240);
    assert(await evaluate(`document.querySelector('${row} .disclosure-content').getBoundingClientRect().height>0`),'Disclosure did not open');
    assert(await evaluate(`getComputedStyle(document.querySelector('${button}')).textDecorationLine==='none'`),'Disclosure looks like a text link');
    await screenshot(view+'-expanded');
    await click(button);await pause(240);
    assert(await evaluate(`document.querySelector('${row} .disclosure-content').getBoundingClientRect().height===0`),'Disclosure did not close');
  }
  const related = await evaluate(`document.querySelector('.related-decision')?.dataset.cp || null`);
  if (related) {
    await evaluate(`(() => {const b=document.querySelector('.related-decision');const row=b.closest('.topic');if(!row.classList.contains('open'))row.querySelector('.topic-row').click();})()`);
    await click('.related-decision');
    assert(await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').dataset.tab==='rundown' && document.getElementById('cp-'+${JSON.stringify(related)}).classList.contains('open')`),'Topic link did not open its decision');
  }
  await key('t','KeyT');
  assert(await evaluate('document.activeElement.id==="askText"'),'T did not focus the composer');
  await screenshot('composer');
  await click('[role="tab"][data-tab="focus"]');
  await click('[data-act="copy-summary"]');
  await until('!!document.querySelector("#reviewView .review-text")');
  assert(await evaluate('document.querySelector("#reviewView .review-text").textContent.length>0'),'Empty copy preview');
  await screenshot('summary-preview');
  await click('[data-act="review-back"]');
  await click('[data-act="recap"]');
  await until('document.querySelector("#reviewView h1")?.textContent==="Record this call in memory"');
  assert(await evaluate('document.querySelector("#reviewView").textContent.includes("persistent memory")'),'Memory effect is not explained');
  await screenshot('memory-preview');
  await key('y','KeyY');
  for(const width of [800,500]){
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await click('[role="tab"][data-tab="rundown"]');
    assert(!await evaluate('document.documentElement.scrollWidth>innerWidth'),'Page overflows at '+width+'px');
    await screenshot('decisions-'+width);
  }
  // Replay live events entirely inside this browser. No call is started on the server.
  const fixtureCall = await fetch(new URL('/api/calls/'+call.id,url), {signal:AbortSignal.timeout(10000)}).then(r=>r.json());
  fixtureCall.endedAt=null;
  fixtureCall.checkpoints=fixtureCall.checkpoints.map(x=>({...x,status:'pending',threadId:null}));
  const snapshot={call:fixtureCall,pipeline:{transcribing:0,analyzing:false},settings:{autoRecap:false}};
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`window.EventSource = class extends EventTarget {
    constructor() { super(); window.__yapTestEvents=this; setTimeout(()=>this.dispatchEvent(new MessageEvent('snapshot',{data:JSON.stringify(${JSON.stringify(snapshot)})})),25); }
    close() {}
  };`});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:'about:blank'});
  await send('Page.navigate',{url:new URL('/#/live',url).href});
  await until('!!document.querySelector(".cue-q")');
  await evaluate(`window.__yapTestEvents.dispatchEvent(new MessageEvent('call',{data:JSON.stringify({id:${JSON.stringify(fixtureCall.id)},capture:{meAt:Date.now(),themAt:Date.now()}})}))`);
  assert(await evaluate('document.querySelector("#recordingLabel").textContent==="Recording"'),'Fresh audio not shown as recording');
  await evaluate("location.hash='#/settings'");
  await until('!!document.querySelector(".settings-grid")');
  assert(await evaluate('!document.querySelector("#recordingNotice").hidden'),'Recording warning missing outside call');
  assert(await evaluate('document.querySelector("#recordingNotice").getBoundingClientRect().bottom <= document.querySelector("#main").getBoundingClientRect().top'),'Recording warning overlaps content');
  await screenshot('recording-settings');
  await evaluate("location.hash='#/live'");
  await until('!!document.querySelector(".cue-q")');
  const question=await evaluate('document.querySelector(".decision-tile.selected .cue-q").textContent');
  const bounds=`JSON.stringify([...document.querySelectorAll('.tally,.callname,.room,.callacts,#coltabs,#strip,#cue,.decision-tile.selected .cue-go')].map(e=>{const r=e.getBoundingClientRect();return [r.x,r.width]}))`;
  const before=await evaluate(bounds);
  await screenshot('live-before');
  await click('[data-act="end"]');
  assert(await evaluate(`(() => {const e=document.querySelector('[data-act="end"]');return e.textContent==='End now?' && e.scrollWidth<=e.clientWidth;})()`),'End confirmation overflows');
  assert(await evaluate(bounds)===before,'End confirmation shifted header');
  await pause(200);
  await screenshot('end-confirmation');
  await pause(3600);

  fixtureCall.title='A much longer changing call title about reminders, billing, dates and agreements';
  fixtureCall.checkpoints.push({...fixtureCall.checkpoints[0],id:'ui-check-new',question:'Newly arrived decision',createdAt:Date.now()});
  if(fixtureCall.checkpoints.length>2)fixtureCall.checkpoints[1].status='running';
  await evaluate(`(() => {
    const c=${JSON.stringify(fixtureCall)};
    for(const [type,data] of [['call',c],['checkpoints',c.checkpoints],['pipeline',{transcribing:99,analyzing:true,lastError:'Test processing error'}]])
      window.__yapTestEvents.dispatchEvent(new MessageEvent(type,{data:JSON.stringify(data)}));
  })()`);
  assert(await evaluate('document.querySelector(".decision-tile.selected .cue-q").textContent')===question,'New arrival replaced the pinned decision');
  assert(await evaluate(bounds)===before,'Live update moved or resized a horizontal slot');
  await screenshot('live-after');
  await key('j','KeyJ');
  assert(await evaluate('document.querySelector(".decision-tile.selected .cue-q").textContent')!==question,'J did not advance to the next decision');
  await key('e','KeyE');
  assert(await evaluate('getComputedStyle(document.querySelector(".cue-edit")).position==="static"'),'Decision edit uses an overlay');
  await key('Escape');await key('Escape');
  const semanticCases = [
    ['pending','agent',null,'attention','Needs you'],
    ['sending','agent',null,'progress','Sending'],
    ['queued','agent',null,'progress','Queued'],
    ['running','agent',null,'progress','Working'],
    ['done','agent',null,'success','Done'],
    ['failed','agent',null,'problem','Failed'],
    ['kept','note',null,'success','Recorded'],
    ['kept','human',null,'attention','To do'],
    ['kept','human',Date.now(),'success','Done'],
    ['skipped','agent',null,'neutral','Skipped'],
    ['superseded','agent',null,'neutral','Replaced'],
  ];
  fixtureCall.checkpoints=semanticCases.map(([status,kind,doneAt],i)=>({...fixtureCall.checkpoints[0],id:'semantic-'+i,status,kind,doneAt,bookmark:false,question:`${kind}: ${status}`}));
  await evaluate(`window.__yapTestEvents.dispatchEvent(new MessageEvent('checkpoints',{data:JSON.stringify(${JSON.stringify(fixtureCall.checkpoints)})}))`);
  await click('[role="tab"][data-tab="rundown"]');
  for (const [i, test] of semanticCases.entries()) {
    const actual=await evaluate(`(() => {const e=document.querySelector('#cp-semantic-${i}');return [e.dataset.tone,e.querySelector('.semantic').textContent]})()`);
    assert(actual[0]===test[3] && actual[1]===test[4], 'Wrong meaning for '+test[0]+'/'+test[1]+': '+actual.join('/'));
  }
  await screenshot('semantic-states');
  for (const theme of ['light','dark']) {
    const ratios=await evaluate(`(() => {
      document.documentElement.dataset.theme=${JSON.stringify(theme)};
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      const luminance=rgb=>rgb.slice(0,3).map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((sum,x,i)=>sum+x*[.2126,.7152,.0722][i],0);
      return [...document.querySelectorAll('.card')].map(row=>{
        ctx.clearRect(0,0,1,1);ctx.fillStyle=getComputedStyle(document.body).backgroundColor;ctx.fillRect(0,0,1,1);
        ctx.fillStyle=getComputedStyle(row).backgroundColor;ctx.fillRect(0,0,1,1);
        const background=luminance([...ctx.getImageData(0,0,1,1).data]);
        ctx.fillStyle=getComputedStyle(row.querySelector('.semantic')).color;ctx.fillRect(0,0,1,1);
        const foreground=luminance([...ctx.getImageData(0,0,1,1).data]);
        return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05);
      });
    })()`);
    assert(Math.min(...ratios)>=4.5,theme+' status text contrast below 4.5:1: '+Math.min(...ratios));
    console.log(theme+' status contrast minimum: '+Math.min(...ratios).toFixed(2)+':1');
    await pause(200);
    await screenshot('semantic-'+theme);
  }

  // Replay a live history row without changing stored calls.
  await evaluate(`(() => {
    const original=window.fetch;
    const rows=${JSON.stringify(calls)};
    rows[0]={...rows[0],live:true,endedAt:null,startedAt:Date.now()-1000};
    window.fetch=(input,options)=>String(input)==='/api/calls'
      ? Promise.resolve(new Response(JSON.stringify(rows),{headers:{'Content-Type':'application/json'}}))
      : original(input,options);
    document.documentElement.dataset.theme='dark';
    window.__yapTestEvents.dispatchEvent(new MessageEvent('changed',{data:'{}'}));
    location.hash='#/history';
  })()`);
  await until('!!document.querySelector("[data-live-start]")');
  await pause(900);
  const historyClock=await evaluate('document.querySelector("[data-live-start]").textContent');
  const historyBounds=await evaluate('JSON.stringify([...document.querySelectorAll(".callrow")].map(e=>e.getBoundingClientRect().x))');
  await pause(1200);
  assert(await evaluate('document.querySelector("[data-live-start]").textContent')!==historyClock,'History timer stopped');
  assert(await evaluate('JSON.stringify([...document.querySelectorAll(".callrow")].map(e=>e.getBoundingClientRect().x))')===historyBounds,'History clock shifted rows');
  assert(await evaluate('[...document.querySelectorAll(".history .chip")].every(e=>e.scrollWidth<=e.clientWidth)'),'History filter overflow');
  await screenshot('history');
  console.log('PASS: history clock ticks without row movement; confirmation fits its fixed slot; history filters fit.');

  await evaluate(`(() => {
    const previousFetch=window.fetch;
    window.fetch=(input,options)=>String(input)==='/api/calls'
      ? Promise.resolve(new Response(JSON.stringify(${JSON.stringify(calls)}.map(c=>({...c,live:false,endedAt:c.endedAt || Date.now()}))),{headers:{'Content-Type':'application/json'}}))
      : previousFetch(input,options);
    window.__yapTestEvents.dispatchEvent(new MessageEvent('changed',{data:'{}'}));
    window.__yapTestEvents.dispatchEvent(new MessageEvent('call',{data:JSON.stringify({id:${JSON.stringify(fixtureCall.id)},endedAt:Date.now()})}));
    location.hash='#/live';
  })()`);
  await until('!!document.querySelector(".home-dashboard")');
  assert(await evaluate('document.querySelector("#recordingNotice").hidden'),'Ended call still shows recording');
  assert(await evaluate('document.querySelector(".new-call").textContent.includes("New call")'),'Home lacks new call CTA');
  assert(await evaluate('document.querySelectorAll(".home-stat").length===3'),'Home stats missing');
  assert(await evaluate('!document.querySelector(".callhead")'),'Home still displays last call');
  await pause(900);
  assert(await evaluate(`(() => {
    const head=document.querySelector('.call-table-heading>span:nth-child(3)');
    const row=document.querySelector('.call-table .dur');
    return !row || Math.abs(head.getBoundingClientRect().right-row.getBoundingClientRect().right)<3;
  })()`),'Table duration column is misaligned');
  await screenshot('home-dashboard');
  for(const width of [500,800]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
    assert(!await evaluate('document.documentElement.scrollWidth>innerWidth'),'Home overflows at '+width);
    await screenshot('home-'+width);
  }
  console.log('PASS: ended call returns to dashboard; New call and three meaningful counts; responsive home.');

  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate("location.hash='#/outcomes'");
  await until('!!document.querySelector(".ledger")');
  assert(!await evaluate('document.documentElement.scrollWidth>innerWidth'),'Outcomes overflows');
  await screenshot('outcomes');
  await send('Emulation.setDeviceMetricsOverride',{width:500,height:1000,deviceScaleFactor:1,mobile:false});
  assert(!await evaluate('document.documentElement.scrollWidth>innerWidth'),'Narrow outcomes overflows');
  await screenshot('outcomes-500');

  assert(mutations.length===0,'Unexpected mutation requests (blocked): '+mutations.join(', '));
  assert(errors.length===0,'Browser errors: '+errors.join('\n'));
  console.log('PASS: five distinct views; Escape stays; disclosures open/close; T composer; copy and memory previews; 500/800/1440px layouts; pinned live cue and stable slots under replayed updates; J/E shortcuts; all decision color meanings.');
  console.log('No API mutations requested. Agent execution, real audio and reconnect recovery were not tested.');
  if(output)console.log('Screenshots: '+resolve(output));
}
try { await main(); } catch(e) { console.error('FAIL: '+e.message);process.exitCode=1; }
finally {
  if(socket?.readyState===WebSocket.OPEN)await send('Browser.close',{},null).catch(()=>{});
  socket?.close();
  for(const p of pending.values())clearTimeout(p.timer);
  if(child && child.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),pause(2000)]);}
  rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}
