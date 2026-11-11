import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ZipWriter, BlobWriter, Uint8ArrayReader, ZipReader, Uint8ArrayWriter } from '@zip.js/zip.js';

// Offscreen documents are CDP targets of type "other"; without this Playwright
// detaches them and context.route never sees their fetches (real API gets hit).
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = '1';
await mkdir('artifacts/browser', { recursive: true });
const extension = path.resolve('dist/extension');
const context = await chromium.launchPersistentContext('', {
  executablePath: process.env.CHROMIUM_PATH || `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1223/chrome-win64/chrome.exe`,
  headless: true, acceptDownloads: true,
  downloadsPath: path.resolve('artifacts/browser/downloads'),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  ignoreDefaultArgs: ['--disable-extensions'], viewport: { width: 1100, height: 800 }
});
const errors = [], results = [];
console.log('Browser launched');
context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
context.on('console', message => { if(message.type()==='error') console.log('BROWSER ERROR',message.text()); });
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
  const id = new URL(worker.url()).host;
  console.log('Extension worker', id);
  const disk = await context.newPage();
  const cdp=await context.newCDPSession(disk);
  await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:path.resolve('artifacts/browser/downloads'),eventsEnabled:true});
  disk.on('download',download=>console.log('BROWSER DOWNLOAD',download.suggestedFilename()));
  let fixture, files = [], apiFiles = [], nestedFiles = [], missing = new Set(), delayed = false;
  const payload = file => Buffer.from(`binary\0${file.id} Привет!`);
  await context.route('https://disk.yandex.ru/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/native.zip') {
      console.log('Serving native ZIP');
      const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false, level: 0 });
      for (const file of files.filter(f => f.kind !== 'folder')) await writer.add(file.name, new Uint8ArrayReader(payload(file)));
      return route.fulfill({ contentType: 'application/zip', headers: { 'content-disposition': 'attachment; filename="native.zip"' }, body: Buffer.from(await (await writer.close()).arrayBuffer()) });
    }
    if (url.pathname.startsWith('/file/')) {
      const file = [...apiFiles, ...nestedFiles].find(f => f.id === url.pathname.slice(6)) || files.find(f => f.id === url.pathname.slice(6));
      if (delayed) await new Promise(r => setTimeout(r, 4000));
      if (!file || missing.has(file.id)) return route.fulfill({ status: 403, body: 'forbidden' });
      return route.fulfill({ contentType: 'application/octet-stream', headers: { 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` }, body: payload(file) });
    }
    return route.fulfill({ contentType: 'text/html', body: fixture });
  });
  await context.route('https://cloud-api.yandex.net/**', async route => {
    const url = new URL(route.request().url()), resourcePath = url.searchParams.get('path');
    if (url.pathname.endsWith('/download')) {
      const file = [...apiFiles, ...nestedFiles].find(f => f.path === resourcePath);
      return route.fulfill({ json: { method: 'GET', templated: false, href: `https://disk.yandex.ru/file/${file.id}` } });
    }
    if (resourcePath === '/nested') return route.fulfill({ json: { type: 'dir', name: 'nested', _embedded: { total: nestedFiles.length, items: nestedFiles.map(f => ({ type: 'file', name: f.name, path: f.path, size: payload(f).length })) } } });
    return route.fulfill({ json: { type: 'dir', name: 'public fixture', _embedded: { total: apiFiles.length + 1, items: [{ name: 'nested', path: '/nested', type: 'dir' }, ...apiFiles.map(f => ({ type: 'file', name: f.name, path: f.path, size: payload(f).length }))] } } });
  });
  const ui = await context.newPage();
  async function command(type, extra = {}) {
    const response = await Promise.race([ui.evaluate(message => chrome.runtime.sendMessage(message), { target: 'background', type, ...extra }),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error(`Command timeout: ${type}`)),20000);timer.unref();})]);
    if (!response?.ok) throw new Error(response?.error || `No response to ${type}`);
    return response;
  }
  async function state() { return (await command('STATE')).job; }
  async function until(predicate, timeout = 90000) {
    const started = Date.now(); let job,last, debugged=false;
    while (Date.now() - started < timeout) {
      job = await state();
      if(job?.phase!==last){console.log('STATE',job?.phase,job?.message,job?.pending);last=job?.phase;}
      if(job?.phase==='waiting'&&!debugged&&Date.now()-started>15000){debugged=true;console.log('DOWNLOAD DEBUG',await worker.evaluate(async()=>({downloads:(await chrome.downloads.search({limit:5})).map(({id,url,referrer,filename,mime,state,startTime})=>({id,url,referrer,filename,mime,state,startTime})),job:(await chrome.storage.session.get('job')).job})));console.log('PAGE DEBUG',await disk.evaluate(()=>({selected:document.querySelector('[data-selected-count]')?.outerHTML,button:document.querySelector('button')?.outerHTML,text:document.body.innerText.slice(0,500)})));}
      if (predicate(job)) return job;
      if (job?.phase === 'error') throw new Error(JSON.stringify(job));
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('Timed out: ' + JSON.stringify(job));
  }
  async function open(url, html) {
    console.log('Opening',url);
    fixture = html; await disk.goto(url);
    console.log('Fixture ready');
    const tab = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0], url);
    await ui.goto(`chrome-extension://${id}/popup.html`);
    console.log('Popup ready; scanning tab',tab?.id);
    await command('SCAN', { tabId: tab.id });
    return until(j => j?.phase === 'ready');
  }
  function listing(items, virtual = false, lazy = false) {
    return `<!doctype html><meta charset="utf-8"><style>.listing{height:320px;overflow-y:auto;position:relative}.listing-item{height:40px;display:flex;align-items:center}.spacer{height:${items.length*40}px}.rows{position:absolute;top:0;width:90%}</style><button id="download">Скачать</button><span data-selected-count="0"></span><main class="listing"><div class="spacer"></div><div class="rows"></div></main><script>
      const items=${JSON.stringify(items)}, selected=new Set(), listing=document.querySelector('.listing');window.renderLog=[]; let loaded=${lazy ? 20 : items.length};
      function render(){const start=${virtual ? 'Math.max(0,Math.floor(listing.scrollTop/40)-1)' : '0'},end=${virtual ? 'Math.min(loaded,start+12)' : 'loaded'};const holder=document.querySelector('.rows');holder.style.top=(start*40)+'px';holder.replaceChildren();document.querySelector('.spacer').style.height=(loaded*40)+'px';
      window.renderLog.push([start,end,listing.scrollTop,loaded]);for(let i=start;i<end;i++){const item=items[i],el=document.createElement('div');el.className='listing-item listing-item_type_'+(item.kind==='folder'?'dir':'file');el.dataset.id=item.id;el.dataset.name=item.name;el.dataset.size=item.size??'';el.setAttribute('aria-selected',String(selected.has(item.id)));const box=document.createElement('input');box.type='checkbox';box.checked=selected.has(item.id);box.onchange=()=>{if(box.checked)selected.add(item.id);else selected.delete(item.id);el.setAttribute('aria-selected',String(box.checked));document.querySelector('[data-selected-count]').dataset.selectedCount=selected.size;};el.append(box,document.createTextNode(item.name));holder.append(el);}}
      listing.onscroll=()=>{render();${lazy ? "if(listing.scrollTop+listing.clientHeight>=listing.scrollHeight-10&&loaded<items.length)setTimeout(()=>{loaded=Math.min(items.length,loaded+20);render();},350);" : ''}};
      document.querySelector('#download').onclick=()=>{const a=document.createElement('a');a.href=selected.size>1?'/native.zip':'/file/'+[...selected][0];document.body.append(a);a.click();a.remove();};render();</script>`;
  }
  async function verifyArchive(job, expected) {
    const bytes = await readFile(job.filename);
    const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
    const entries = await reader.getEntries(); assert.equal(entries.length, expected.length);
    assert.equal(new Set(entries.map(e => e.filename)).size, expected.length);
    for (let i = 0; i < entries.length; i++) assert.deepEqual(Buffer.from(await entries[i].getData(new Uint8ArrayWriter())), payload(expected[i]));
    await reader.close();
  }
  async function lastEntryName(job) {
    const reader = new ZipReader(new Uint8ArrayReader(await readFile(job.filename)), { useWebWorkers: false });
    const name = (await reader.getEntries()).at(-1).filename; await reader.close(); return name;
  }
  files = Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: `Документ ${i}.pdf` })); files.push({ id: 'folder', name: 'Вложенная папка', kind: 'folder' });
  let job = await open('https://disk.yandex.ru/client/disk/fixture-five', listing(files)); assert.equal(job.total, 5); assert.equal(job.folders, 1);
  await command('START'); job = await until(j => j?.phase === 'complete'); await verifyArchive(job, files.slice(0,5));
  results.push('Native selection and ZIP save: 5 files, folder excluded');console.log(results.at(-1));

  files = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `Файл ${i}.png` }));
  job = await open('https://disk.yandex.ru/client/disk/fixture-virtual', listing(files,true,true));
  if(job.total!==100)console.log('VIRTUAL DEBUG',await disk.evaluate(()=>window.renderLog),await worker.evaluate(async()=>(await chrome.storage.session.get('job')).job.files.map(f=>f.id)));
  assert.equal(job.total,100);
  results.push('Virtualized and lazy-loaded list: all 100 stable IDs collected');console.log(results.at(-1));

  apiFiles = Array.from({ length: 100 }, (_,i) => ({ id: String(i), name: i<2 ? 'Одинаковое имя.jpg' : `Файл ${i}.${['pdf','docx','xlsx','jpg','png','mp4','zip'][i%7]}`, path: `/file-${i}` }));
  nestedFiles = [{ id: 'inner', name: 'Одинаковое имя.jpg', path: '/nested/inner' }];
  job = await open('https://disk.yandex.ru/d/public-fixture', '<main class="listing">Public layout with no DOM resource attributes</main>'); assert.equal(job.total,101); assert.equal(job.folders,1);
  await command('START'); job=await until(j=>j?.phase==='complete'); await verifyArchive(job,[...apiFiles,...nestedFiles]);
  assert.equal(await lastEntryName(job), 'nested/Одинаковое имя.jpg');
  nestedFiles = [];
  results.push('Local OPFS ZIP: 100 public files + 1 in nested folder, duplicate Cyrillic names, seven formats, exact bytes, folder structure');console.log(results.at(-1));

  apiFiles = apiFiles.slice(0,5); missing=new Set(['1','3']);
  await open('https://disk.yandex.ru/d/partial-fixture','<main class="listing"></main>');await command('START');job=await until(j=>j?.phase==='partial');
  assert.equal(job.completed,3);assert.equal(job.failures.length,2);await verifyArchive(job,apiFiles.filter(f=>!missing.has(f.id)));
  results.push('Partial failure: 3 saved files, 2 HTTP 403 errors, valid ZIP');console.log(results.at(-1));

  apiFiles=[];job=await open('https://disk.yandex.ru/d/empty-fixture','<main class="listing"></main>');assert.equal(job.total,0);assert.equal((await ui.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'START'}))).ok,false);
  results.push('Empty folder: zero files, cannot start ZIP');console.log(results.at(-1));

  apiFiles=[{id:'cancel',name:'cancel.bin',path:'/cancel'}];missing=new Set();delayed=true;
  await open('https://disk.yandex.ru/d/cancel-fixture','<main class="listing"></main>');await command('START');await until(j=>j?.phase==='fetching');await command('CANCEL');assert.equal((await state()).phase,'cancelled');
  results.push('Cancellation: aborts local operation, no success state');console.log(results.at(-1));
  await new Promise(r=>setTimeout(r,500));delayed=false;

  assert.deepEqual(errors,[]);
  await writeFile('artifacts/browser/results.json',JSON.stringify({results,errors},null,2));
  console.log(`PASS ${results.length} browser scenarios`);
} catch(error) { console.error('TEST FAILED',error); throw error; }
finally { console.log('Closing browser'); await context.close(); }
