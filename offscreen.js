import { buildArchive } from './zip-manager.js';
import { allowedDownload } from './shared.js';
import { listPublic, publicDownload } from './public-api.js';
let current;
async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (!response?.ok) throw new Error(response?.error || 'Фоновый процесс не отвечает.');
  return response;
}
function task(id) {
  const result = { id, controller: new AbortController(), progress: new Set(), running: true };
  result.heartbeat = setInterval(() => { void send('HEARTBEAT').catch(() => {}); }, 15000);
  return result;
}
async function cleanup(value) {
  if (value.url) URL.revokeObjectURL(value.url);
  if (value.root) await value.root.removeEntry(`ydd-${value.id}`, { recursive: true }).catch(() => {});
  clearInterval(value.heartbeat);
  if (current === value) current = null;
}
async function uiLink(value, file) {
  const waiting = Promise.withResolvers ? Promise.withResolvers() : (() => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; })();
  value.link = { fileId: file.id, ...waiting };
  // Attach immediately: cancellation can arrive during the selection command.
  waiting.promise.catch(() => {});
  const onAbort = () => waiting.reject(value.controller.signal.reason);
  value.controller.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => waiting.reject(new Error('Диск не начал скачивание файла. Проверьте доступ и авторизацию.')), 120000);
  try {
    const result = await send('RESOLVE', { id: value.id, fileId: file.id });
    if (result.url) return result.url;
    return await waiting.promise;
  } finally { clearTimeout(timer); value.controller.signal.removeEventListener('abort', onAbort); value.link = null; }
}
async function execute(value, files, location) {
  try {
    value.root = await navigator.storage.getDirectory();
    for await (const [name] of value.root.entries()) if (name.startsWith('ydd-') && name !== `ydd-${value.id}`) await value.root.removeEntry(name, { recursive: true });
    let lastProgress = 0;
    const links = new Map();
    const result = await buildArchive(files, {
      root: value.root, jobId: value.id, signal: value.controller.signal,
      resolveUrl: file => location ? publicDownload(location, file, { signal: AbortSignal.any([value.controller.signal, AbortSignal.timeout(600000)]), links }) : uiLink(value, file),
      fetchFile: async (url, sink, signal, progress, file) => {
        if (!allowedDownload(url)) throw new Error('Адрес скачивания не принадлежит поддерживаемым доменам Яндекса.');
        const combined = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
        const response = await fetch(url, { credentials: location ? 'omit' : 'include', signal: combined, cache: 'no-store', redirect: 'follow' });
        if (!allowedDownload(response.url)) { await response.body?.cancel(); throw new Error('Недопустимое перенаправление скачивания.'); }
        if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? 'Нет доступа или истекла авторизация.' : `HTTP ${response.status}`); }
        if (!response.body) throw new Error('Сервер вернул пустой поток.');
        if (/text\/html/i.test(response.headers.get('content-type') || '') && !/\.html?$/i.test(file.name)) { await response.body.cancel(); throw new Error('Вместо файла получена HTML-страница. Проверьте доступ и авторизацию.'); }
        let bytes = 0;
        await response.body.pipeThrough(new TransformStream({ transform(chunk, controller) { bytes += chunk.byteLength; progress(bytes); controller.enqueue(chunk); } })).pipeTo(sink, { signal: combined });
      },
      onProgress: progress => {
        if (progress.currentBytes !== undefined && Date.now() - lastProgress < 400) return;
        lastProgress = Date.now();
        const pending = (async () => { try { await send('PROGRESS', { id: value.id, progress }); } catch { value.controller.abort(); } })();
        value.progress.add(pending);
        void (async () => { await pending; value.progress.delete(pending); })();
      }
    });
    await Promise.all(value.progress);
    value.controller.signal.throwIfAborted();
    value.url = URL.createObjectURL(result.file);
    await send('SAVE', { id: value.id, url: value.url, completed: result.completed, failures: result.failures });
    value.running = false;
  } catch (error) {
    if (!value.controller.signal.aborted) await send('ERROR', { id: value.id, error: error.name === 'QuotaExceededError' ? 'Недостаточно места во временном хранилище браузера.' : error.message }).catch(() => {});
    await cleanup(value);
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'offscreen' || (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) return;
  if (message.type === 'SCAN_PUBLIC') {
    if (current) { reply({ ok: false, error: 'Дождитесь завершения предыдущей операции.' }); return; }
    const value = current = task(message.id);
    void (async () => {
      try {
        const result = await listPublic(message.location, { signal: AbortSignal.any([value.controller.signal, AbortSignal.timeout(240000)]) });
        reply({ ok: true, ...result });
      } catch (error) { reply({ ok: false, error: error.message }); }
      finally { await cleanup(value); }
    })();
    return true;
  }
  if (message.type === 'BUILD') {
    if (current) { reply({ ok: false, error: 'ZIP-упаковка уже запущена.' }); return; }
    const value = current = task(message.job.id);
    void execute(value, message.job.files, message.job.location); reply({ ok: true });
  } else if (current?.id === message.id && message.type === 'LINK') {
    if (current.link?.fileId !== message.fileId || !allowedDownload(message.url)) { reply({ ok: false }); return; }
    current.link.resolve(message.url); reply({ ok: true });
  } else if (current?.id === message.id && message.type === 'CANCEL') {
    current.controller.abort();
    if (!current.running) void cleanup(current);
    reply({ ok: true });
  } else if (current?.id === message.id && message.type === 'RELEASE') {
    void cleanup(current); reply({ ok: true });
  } else reply({ ok: true });
});
