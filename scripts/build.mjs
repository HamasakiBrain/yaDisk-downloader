import { mkdir, copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { ZipWriter, BlobWriter, Uint8ArrayReader } from '@zip.js/zip.js';
const root = new URL('../', import.meta.url), dist = new URL('dist/extension/', root);
await mkdir(new URL('vendor/', root), { recursive: true });
await mkdir(new URL('icons/', root), { recursive: true });
await copyFile(new URL('node_modules/@zip.js/zip.js/dist/zip-native.js', root), new URL('vendor/zip.js', root));
await copyFile(new URL('node_modules/@zip.js/zip.js/LICENSE', root), new URL('vendor/LICENSE', root));
// Generate the small geometric extension icon with no image service or fonts.
function crc(data) { let c = 0xffffffff; for (const byte of data) { c ^= byte; for (let i=0;i<8;i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const t=Buffer.from(type), out=Buffer.alloc(12+data.length); out.writeUInt32BE(data.length); t.copy(out,4); data.copy(out,8); out.writeUInt32BE(crc(Buffer.concat([t,data])),8+data.length); return out; }
for (const size of [16,32,48,128]) {
  const pixels=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const u=x/size,v=y/size, shaft=u>.44&&u<.56&&v>.22&&v<.59, tip=v>.45&&v<.72&&Math.abs(u-.5)<(.72-v)*.85, line=v>.77&&v<.83&&u>.25&&u<.75;
    const ink=shaft||tip||line, i=y*(size*4+1)+1+x*4; pixels.set(ink?[32,36,45,255]:[255,214,50,255],i);
  }
  const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(size);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  await writeFile(new URL(`icons/${size}.png`,root),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
const files=['manifest.json','background.js','content.js','shared.js','public-api.js','popup.html','popup.css','popup.js','zip-manager.js','download-manager.js','offscreen.html','offscreen.js','README.md','PRIVACY.md','vendor/zip.js','vendor/LICENSE',...[16,32,48,128].map(n=>`icons/${n}.png`)];
await mkdir(dist,{recursive:true});
const zip=new ZipWriter(new BlobWriter('application/zip'),{level:0,useWebWorkers:false});
for(const file of files){await mkdir(new URL(file.includes('/')?file.slice(0,file.lastIndexOf('/')+1):'./',dist),{recursive:true});await copyFile(new URL(file,root),new URL(file,dist));await zip.add(file,new Uint8ArrayReader(await readFile(new URL(file,root))));}
await writeFile(new URL('dist/yandex-disk-downloader.zip',root),Buffer.from(await (await zip.close()).arrayBuffer()));
console.log(`Built ${files.length} files: dist/extension and dist/yandex-disk-downloader.zip`);
