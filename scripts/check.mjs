import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const manifest=JSON.parse(await readFile('manifest.json','utf8'));
if(manifest.manifest_version!==3) throw new Error('Expected Manifest V3');
for(const file of ['background.js','content.js','shared.js','public-api.js','popup.js','download-manager.js','zip-manager.js','offscreen.js']) {
  const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'}); if(result.status) throw new Error(result.stderr);
}
for(const file of [manifest.action.default_popup,manifest.background.service_worker,...Object.values(manifest.icons),'vendor/zip.js']) await access(file);
if(manifest.permissions.includes('cookies')||manifest.host_permissions.includes('<all_urls>')) throw new Error('Excessive permissions');
console.log('Manifest assets and JavaScript syntax OK');
