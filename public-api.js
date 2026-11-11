import { supportedPage, allowedDownload, safeSegment } from './shared.js';
const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
export function publicLocation(value) {
  if (!supportedPage(value)) return null;
  const url = new URL(value), match = url.pathname.match(/^\/(d|i)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const path = url.searchParams.get('path') || (match[3] ? decodeURIComponent(match[3]) : '/');
  if (!path.startsWith('/') || path.includes('\0')) throw new Error('Некорректный путь публичной папки.');
  return { publicKey: `${url.origin}/${match[1]}/${match[2]}`, path };
}
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}
let lastCall = 0, gap = 250;
async function apiRequest(location, endpoint, parameters, { signal, fetchImpl = fetch } = {}) {
  const url = new URL(API + endpoint);
  url.search = new URLSearchParams({ public_key: location.publicKey, path: location.path, ...parameters });
  let response;
  // Yandex rate-limits public API bursts with 429: pace calls, widen the pace
  // for all later calls after a 429 and back off (Retry-After, else 1, 2, 4… s).
  // Note: module-level pace, fine for one job at a time.
  for (let attempt = 0; ; attempt++) {
    await wait(Math.max(0, lastCall + gap - Date.now()), signal);
    lastCall = Date.now();
    response = await fetchImpl(url, { signal, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (response.status !== 429 || attempt >= 10) break;
    gap = Math.min(Math.max(gap * 2, 1000), 8000);
    await response.body?.cancel();
    const header = response.headers.get('retry-after'), retryAfter = header === null ? NaN : Number(header);
    await wait(Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 60) * 1000 : Math.min(2 ** attempt, 30) * 1000, signal);
  }
  if (!response.ok) throw new Error({ 401: 'Требуется авторизация.', 403: 'Скачивание запрещено или ограничено владельцем.', 404: 'Публичный ресурс недоступен или удалён.', 429: 'Превышен лимит запросов Яндекса. Повторите позже.' }[response.status] || `Ошибка Яндекс Диска: HTTP ${response.status}.`);
  return response.json();
}
// Walks the whole tree breadth-first; each file keeps its folder chain in `dir`.
export async function listPublic(location, options = {}) {
  const files = [], queue = [[location.path, '']]; let folders = 0, folderName;
  while (queue.length) {
    const [path, dir] = queue.shift();
    const { data, items } = await listDir({ ...location, path }, options);
    if (path === location.path) {
      folderName = data.name;
      if (data.type === 'file') return { files: [descriptor(data)], folders: 0, folderName, totalBytes: Number.isFinite(data.size) ? data.size : null };
    }
    for (const item of items) {
      if (item.type === 'dir') { folders++; queue.push([item.path, dir ? `${dir}/${safeSegment(item.name)}` : safeSegment(item.name)]); }
      else files.push(descriptor(item, dir));
    }
    if (files.length + folders > 100000) throw new Error('Слишком много объектов в публичной папке (более 100 000).');
  }
  return { files, folders, folderName, totalBytes: files.every(f => f.size !== null) ? files.reduce((sum, f) => sum + f.size, 0) : null };
}
async function listDir(location, options) {
  const found = new Map(); let offset = 0, expectedTotal;
  while (true) {
    options.signal?.throwIfAborted();
    const data = await apiRequest(location, '', { limit: '1000', offset: String(offset), sort: 'name', fields: 'name,type,path,size,revision,_embedded.items.name,_embedded.items.type,_embedded.items.path,_embedded.items.size,_embedded.items.revision,_embedded.items.file,_embedded.total,_embedded.offset' }, options);
    if (data.type === 'file') return { data, items: [] };
    if (data.type !== 'dir' || !Array.isArray(data._embedded?.items) || !Number.isSafeInteger(data._embedded.total)) throw new Error('Яндекс вернул неполное описание списка.');
    const { items, total } = data._embedded;
    if (expectedTotal !== undefined && total !== expectedTotal) throw new Error('Содержимое папки изменилось во время поиска. Обновите список.');
    expectedTotal = total;
    if (items.length === 0 && offset < total) throw new Error('Яндекс не вернул все элементы списка.');
    for (const item of items) {
      if (!['file', 'dir'].includes(item.type) || typeof item.path !== 'string' || !item.path.startsWith('/') || !item.name) throw new Error('Не удалось распознать элемент публичной папки.');
      if (found.has(item.path)) throw new Error('Содержимое папки изменилось: получены повторяющиеся элементы.');
      found.set(item.path, item);
    }
    offset += items.length;
    if (offset >= total) return { data, items: [...found.values()] };
    if (offset > 100000) throw new Error('Слишком много объектов в одном разделе (более 100 000).');
  }
}
function descriptor(item, dir = '') {
  if (typeof item.path !== 'string' || !item.name) throw new Error('У файла отсутствует имя или стабильный путь.');
  return { id: item.path, name: item.name, dir, path: item.path, size: Number.isFinite(item.size) ? item.size : null, revision: item.revision ?? null };
}
// Download links arrive with the folder listing: one API call per folder instead
// of one /download call per file, which Yandex answers with 429 in bursts.
// `options.links` is an in-memory per-job cache (never persisted).
// Note: links are signed and expire; fetched lazily per folder, so only a
// folder that takes hours to download could outlive them (then the file errors).
export async function publicDownload(location, file, options = {}) {
  const cache = options.links;
  if (cache) {
    const parent = file.path.slice(0, file.path.lastIndexOf('/')) || '/';
    if (!cache.has(parent)) cache.set(parent, listDir({ ...location, path: parent }, options)
      .then(({ items }) => new Map(items.map(item => [item.path, item.file])))
      .catch(error => { cache.delete(parent); throw error; }));
    const href = (await cache.get(parent)).get(file.path);
    if (href && allowedDownload(href)) return href;
  }
  const result = await apiRequest({ ...location, path: file.path }, '/download', {}, options);
  if (result.method !== 'GET' || result.templated || !allowedDownload(result.href)) throw new Error('Яндекс не предоставил допустимую ссылку скачивания.');
  return result.href;
}
