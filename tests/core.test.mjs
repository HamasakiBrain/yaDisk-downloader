import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedDownload, supportedPage, uniqueName, publicJob } from '../shared.js';
import { publicLocation, listPublic, publicDownload } from '../public-api.js';
import { matchesDownload } from '../download-manager.js';
import { buildArchive } from '../zip-manager.js';
import { ZipReader, BlobReader, Uint8ArrayWriter } from '@zip.js/zip.js';

test('domain allowlist rejects deceptive hosts and credentials', () => {
  for(const url of ['https://evil.test','https://disk.yandex.ru.evil.test/x','http://disk.yandex.ru/x','https://user:pass@disk.yandex.ru/a','javascript:alert(1)']) assert.equal(allowedDownload(url),false);
  assert.equal(allowedDownload('https://downloader.disk.yandex.ru/disk/file'),true);
  assert.equal(supportedPage('https://disk.yandex.com/client/disk'),true);
});
test('public path parsing preserves current folder and Unicode', () => {
  assert.deepEqual(publicLocation('https://disk.yandex.ru/d/abc/%D1%82%D0%B5%D1%81%D1%82'),{publicKey:'https://disk.yandex.ru/d/abc',path:'/тест'});
  assert.equal(publicLocation('https://disk.yandex.ru/d/abc?path=%2Fa%2Bb').path,'/a+b');
  assert.equal(publicLocation('https://disk.yandex.ru/client/disk'),null);
});
test('unique names retain extensions, normalize Unicode and flatten traversal', () => {
  const used=new Set();
  assert.equal(uniqueName('Смета.xlsx',used),'Смета.xlsx');
  assert.equal(uniqueName('Смета.xlsx',used),'Смета (2).xlsx');
  assert.equal(uniqueName('Смета (2).xlsx',used),'Смета (2) (2).xlsx');
  assert.equal(uniqueName('../nested/file.txt',used),'.._nested_file.txt');
});
test('download matching requires exact source, bounded time and expected name', () => {
  const job={sourceUrl:'https://disk.yandex.ru/client/disk/Docs',pending:{kind:'native',since:10000,until:20000}};
  const item={url:'https://downloader.disk.yandex.ru/a',referrer:job.sourceUrl,startTime:new Date(12000).toISOString(),filename:'C:\\Downloads\\archive.zip'};
  assert.equal(matchesDownload(item,job),true);
  assert.equal(matchesDownload({...item,referrer:'https://disk.yandex.ru/client/disk/Other'},job),false);
  assert.equal(matchesDownload({...item,startTime:new Date(30000).toISOString()},job),false);
  assert.equal(matchesDownload({...item,filename:'file.pdf'},job),false);
});
test('public state excludes signed URLs and source descriptors', () => {
  assert.deepEqual(publicJob({id:'a',files:[{url:'secret'}],sourceUrl:'source',pending:{},publicLocation:{publicKey:'key'}}),{id:'a'});
});
test('public API paginates every folder and recurses with safe folder chains', async () => {
  const calls=[];
  const fetchImpl=async (url,options)=>{
    calls.push({url,options});const path=url.searchParams.get('path'),offset=Number(url.searchParams.get('offset'));
    if(path==='/sub/..') return Response.json({type:'dir',name:'..',_embedded:{items:[{type:'file',name:'deep.txt',path:'/sub/../deep.txt',size:1}],total:1}});
    if(path==='/sub') return Response.json({type:'dir',name:'sub',_embedded:{items:[{type:'dir',name:'..',path:'/sub/..'},{type:'file',name:'0.txt',path:'/sub/0.txt',size:1}],total:2}});
    const items=offset===0?[{type:'dir',name:'sub',path:'/sub'},...Array.from({length:49},(_,i)=>({type:'file',name:`${i}.txt`,path:`/${i}.txt`,size:1}))]:Array.from({length:51},(_,i)=>({type:'file',name:`${i+49}.txt`,path:`/${i+49}.txt`,size:1}));
    return Response.json({type:'dir',name:'root',_embedded:{items,total:101}});
  };
  const result=await listPublic({publicKey:'https://disk.yandex.ru/d/abc',path:'/'},{fetchImpl});
  assert.equal(result.files.length,102);assert.equal(result.folders,2);assert.equal(result.totalBytes,102);
  assert.deepEqual(result.files.slice(100).map(f=>[f.dir,f.name]),[['sub','0.txt'],['sub/_','deep.txt']]);
  assert.equal(calls[1].url.searchParams.get('offset'),'50');assert.ok(calls.every(c=>c.options.credentials==='omit'));
  const used=new Set();
  assert.equal(uniqueName('0.txt',used),'0.txt');assert.equal(uniqueName('0.txt',used,'sub'),'sub/0.txt');assert.equal(uniqueName('0.txt',used,'sub'),'sub/0 (2).txt');
});
test('incomplete API listing and forbidden download links fail closed',async()=>{
  await assert.rejects(listPublic({publicKey:'key',path:'/'},{fetchImpl:async()=>Response.json({type:'dir',_embedded:{items:[],total:4}})}),/не вернул все/);
  await assert.rejects(publicDownload({publicKey:'key'},{path:'/a'},{fetchImpl:async()=>Response.json({method:'GET',href:'https://evil.test/a'})}),/допустимую/);
});
function memoryDirectory() {
  const entries=new Map();
  return {
    async getDirectoryHandle(name){if(!entries.has(name))entries.set(name,memoryDirectory());return entries.get(name);},
    async getFileHandle(name){if(!entries.has(name))entries.set(name,{data:new Blob(),async createWritable(){const chunks=[];const self=this;return new WritableStream({write(chunk){chunks.push(chunk);},close(){self.data=new Blob(chunks);}});},async getFile(){return this.data;}});return entries.get(name);},
    async removeEntry(name){entries.delete(name);}
  };
}
test('ZIP preserves 100 mixed files byte for byte, including Unicode and duplicate names',async()=>{
  const types=['pdf','docx','xlsx','jpg','png','mp4','zip'];
  const files=Array.from({length:100},(_,i)=>({id:String(i),name:i<2?'Кириллица.jpg':`Файл ${i}.${types[i%7]}`,size:257}));
  const data=new Map(files.map((f,i)=>[f.id,Uint8Array.from({length:257},(_,n)=>(n+i)%256)]));
  const result=await buildArchive(files,{root:memoryDirectory(),jobId:'test',signal:new AbortController().signal,resolveUrl:async f=>f.id,fetchFile:async(id,sink)=>{const writer=sink.getWriter();await writer.write(data.get(id));await writer.close();},onProgress(){}});
  assert.equal(result.completed,100);assert.deepEqual(result.failures,[]);
  const reader=new ZipReader(new BlobReader(result.file),{useWebWorkers:false});const entries=await reader.getEntries();assert.equal(entries.length,100);assert.equal(entries[1].filename,'Кириллица (2).jpg');
  for(let i=0;i<100;i++)assert.deepEqual(await entries[i].getData(new Uint8ArrayWriter()),data.get(String(i)));
  await reader.close();
});
test('a failed HTTP stream never becomes a truncated ZIP entry; later files survive',async()=>{
  const files=[{id:'bad',name:'bad.bin',size:4},{id:'ok',name:'good.bin',size:4}];
  const result=await buildArchive(files,{root:memoryDirectory(),jobId:'partial',signal:new AbortController().signal,resolveUrl:async f=>f.id,fetchFile:async(id,sink)=>{const writer=sink.getWriter();await writer.write(new Uint8Array([1,2,3,4]));if(id==='bad'){await writer.abort();throw new Error('network disconnected');}await writer.close();},onProgress(){}});
  assert.equal(result.completed,1);assert.equal(result.failures[0].name,'bad.bin');
  const reader=new ZipReader(new BlobReader(result.file),{useWebWorkers:false});assert.deepEqual((await reader.getEntries()).map(f=>f.filename),['good.bin']);await reader.close();
});
test('truncated content and cancellation cannot produce success',async()=>{
  const options={root:memoryDirectory(),jobId:'short',signal:new AbortController().signal,resolveUrl:async()=>'',fetchFile:async(_,sink)=>{const w=sink.getWriter();await w.write(new Uint8Array([1]));await w.close();},onProgress(){}};
  await assert.rejects(buildArchive([{id:'a',name:'a',size:3}],options),/Размер скачанного/);
  const controller=new AbortController();controller.abort();await assert.rejects(buildArchive([{id:'a',name:'a'}],{...options,root:memoryDirectory(),signal:controller.signal}),{name:'AbortError'});
});
test('rate-limited API calls are retried instead of failing the file',async()=>{
  let n=0;
  const fetchImpl=async()=>++n<3?new Response('',{status:429,headers:{'retry-after':'0'}}):Response.json({method:'GET',href:'https://downloader.disk.yandex.ru/a'});
  assert.equal(await publicDownload({publicKey:'key'},{path:'/a'},{fetchImpl}),'https://downloader.disk.yandex.ru/a');assert.equal(n,3);
});
test('public download links come from one listing per folder, not per-file /download calls',async()=>{
  const calls=[];
  const fetchImpl=async url=>{calls.push(url.pathname);return url.pathname.endsWith('/download')?Response.json({method:'GET',href:'https://downloader.disk.yandex.ru/fallback'}):Response.json({type:'dir',_embedded:{total:3,items:[{type:'file',name:'a',path:'/d/a',file:'https://downloader.disk.yandex.ru/a'},{type:'file',name:'b',path:'/d/b',file:'https://downloader.disk.yandex.ru/b'},{type:'file',name:'c',path:'/d/c',file:'https://evil.test/c'}]}});};
  const links=new Map(),loc={publicKey:'key',path:'/'};
  assert.equal(await publicDownload(loc,{path:'/d/a'},{fetchImpl,links}),'https://downloader.disk.yandex.ru/a');
  assert.equal(await publicDownload(loc,{path:'/d/b'},{fetchImpl,links}),'https://downloader.disk.yandex.ru/b');
  assert.equal(calls.length,1);
  assert.equal(await publicDownload(loc,{path:'/d/c'},{fetchImpl,links}),'https://downloader.disk.yandex.ru/fallback');
});
