import { ACTIVE, archiveName, supportedPage, allowedDownload, publicJob } from './shared.js';
import { matchesDownload, inspectDownload, cancelDownload } from './download-manager.js';
import { publicLocation } from './public-api.js';

const readJob = async () => (await chrome.storage.session.get('job')).job || null;
async function mutate(fn) {
  return navigator.locks.request('ydd-state', async () => {
    const next = fn(await readJob());
    if (next) await chrome.storage.session.set({ job: next });
    return next;
  });
}
async function patch(id, changes) {
  return mutate(job => job?.id === id && ACTIVE.has(job.phase) ? { ...job, ...changes, updatedAt: Date.now() } : job);
}
async function active(id) {
  const job = await readJob();
  if (job?.id !== id || !ACTIVE.has(job.phase) || job.phase === 'cancelling') throw new Error('Операция остановлена.');
  return job;
}
async function content(job, type, extra = {}) {
  const result = await chrome.tabs.sendMessage(job.tabId, { target: 'content', type, sourceUrl: job.sourceUrl, ...extra });
  if (!result?.ok) throw new Error(result?.error || 'Нет ответа от вкладки. Обновите Яндекс Диск.');
  return result;
}
async function ensureContent(tabId) {
  try { await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'PING' }); }
  catch { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); }
}
async function hidden(type, data = {}) { return chrome.runtime.sendMessage({ target: 'offscreen', type, ...data }); }
async function offscreen() {
  await navigator.locks.request('ydd-offscreen', async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Потоковая сборка ZIP в хранилище браузера и сохранение через Blob URL.' });
  });
}
async function release(job) {
  await content(job, 'CANCEL').catch(() => {});
  await hidden('CANCEL', { id: job.id }).catch(() => {});
  await cancelDownload(job.downloadId);
}
async function fail(id, error) {
  const job = await readJob();
  if (job?.id !== id || !ACTIVE.has(job.phase) || job.phase === 'cancelling') return;
  await patch(id, { phase: 'error', pending: null, message: error.message || String(error) });
  await release(job);
}
async function finishScan(job, result, location) {
  const files = result.files.map(({ id, name, size, path, revision, dir }) => ({ id, name, size, ...(path ? { path, revision, dir } : {}) }));
  await patch(job.id, { phase: 'ready', files, publicLocation: location, recursive: !!location, total: files.length, totalBytes: result.totalBytes, folders: result.folders, folderName: result.folderName, message: files.length ? 'Готово к скачиванию' : 'В этом разделе нет файлов. Откройте нужную папку на Диске.', percent: 0 });
}
async function scanTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!supportedPage(tab.url)) throw new Error('Откройте папку на disk.yandex.ru или disk.yandex.com.');
  const location = publicLocation(tab.url);
  const job = await mutate(current => {
    if (current && ACTIVE.has(current.phase)) throw new Error('Уже выполняется операция. Дождитесь завершения или отмените её.');
    return { id: crypto.randomUUID(), tabId, sourceUrl: tab.url, phase: 'scanning', total: 0, completed: 0, attempted: 0, failures: [], percent: null, updatedAt: Date.now(), message: location ? 'Получаем список публичной папки…' : 'Собираем файлы с прокруткой…' };
  });
  void performScan(job, location); return {};
}
async function performScan(job, location) {
  try {
    await ensureContent(job.tabId);
    if (location) {
      await offscreen(); await active(job.id);
      const result = await hidden('SCAN_PUBLIC', { id: job.id, location });
      if (!result?.ok) throw new Error(result?.error || 'Не удалось получить список публичной папки.');
      await finishScan(job, result, location);
    } else await finishScan(job, await content(job, 'SCAN'), null);
  } catch (error) { await fail(job.id, error); }
}
async function run(id) {
  try {
    let job = await active(id);
    // Public links are listed recursively via the API; the page only shows the
    // current level, so Yandex's own selection-based ZIP cannot cover them.
    if (job.publicLocation) return await runLocal(job);
    const duplicates = new Set(job.files.map(f => f.name.toLocaleLowerCase('ru'))).size !== job.total;
    if (job.total > 1 && !duplicates) {
      await content(job, 'SELECT', { files: job.files });
      if ((await content(job, 'CAN_DOWNLOAD')).available) {
        job = await active(id);
        await patch(id, { phase: 'waiting', mode: 'native', pending: { kind: 'native', since: Date.now(), until: Date.now() + 120000 }, message: 'Яндекс Диск готовит ZIP…', percent: null });
        await content(job, 'CLICK_DOWNLOAD'); return;
      }
    }
    await runLocal(job);
  } catch (error) { await fail(id, error); }
}
async function runLocal(job) {
  await active(job.id);
  await patch(job.id, { phase: 'fetching', mode: 'local', pending: null, message: 'Скачиваем файлы для локального ZIP…', percent: 0 });
  await offscreen(); await active(job.id);
  const response = await hidden('BUILD', { job: { id: job.id, files: job.files, location: job.publicLocation } });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось запустить ZIP-упаковку.');
}
async function resolveFile(job, fileId) {
  const file = job.files.find(f => f.id === fileId);
  if (!file) throw new Error('Файл отсутствует в снимке списка.');
  const selection = await content(job, 'SELECT', { files: [file] });
  await active(job.id);
  if (allowedDownload(selection.directUrl)) return { url: selection.directUrl };
  await patch(job.id, { pending: { kind: 'file', fileId, name: file.name, since: Date.now(), until: Date.now() + 25000 } });
  await content(job, 'CLICK_DOWNLOAD'); return { pending: true };
}
async function trackDownload(item, job) {
  if (job.pending.kind === 'file') {
    await cancelDownload(item.id);
    const response = await hidden('LINK', { id: job.id, fileId: job.pending.fileId, url: item.finalUrl || item.url });
    await patch(job.id, { pending: null }); return response?.ok;
  }
  await patch(job.id, { downloadId: item.id, pending: null, phase: 'saving', message: 'Сохраняем ZIP на компьютер…' });
  await refreshDownload(); return true;
}
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  void (async () => {
    try {
      const job = await readJob();
      if (job?.downloadId === item.id && job.mode === 'native') { suggest({ filename: job.archiveName, conflictAction: 'uniquify' }); return; }
      if (matchesDownload(item, job)) {
        const native = job.pending.kind === 'native';
        if (await trackDownload(item, job)) { suggest(native ? { filename: job.archiveName, conflictAction: 'uniquify' } : undefined); return; }
      }
      suggest();
    } catch { suggest(); }
  })();
  return true;
});
async function refreshDownload() {
  let job = await readJob();
  if (job?.pending && ACTIVE.has(job.phase)) {
    const candidates = await chrome.downloads.search({ startedAfter: new Date(job.pending.since - 1000).toISOString() });
    const related = candidates.filter(item => matchesDownload(item, job));
    if (related.length === 1) { await trackDownload(related[0], job); return; }
  }
  if (job?.phase !== 'saving' || job.downloadId == null) return;
  try {
    const item = await inspectDownload(job.downloadId);
    if (item.state === 'complete') {
      await patch(job.id, { phase: job.failures.length ? 'partial' : 'complete', completed: job.mode === 'native' ? job.total : job.completed, attempted: job.total, percent: 100, message: job.failures.length ? 'ZIP сохранён. Некоторые файлы пропущены.' : 'Архив успешно создан и сохранён!', filename: item.filename });
      await hidden('RELEASE', { id: job.id }).catch(() => {});
      await content(job, 'CANCEL').catch(() => {});
    } else if (item.state === 'interrupted') throw new Error(`Chrome прервал сохранение: ${item.error || 'неизвестная ошибка'}`);
    else await patch(job.id, { percent: item.totalBytes > 0 ? Math.min(99, Math.floor(item.bytesReceived / item.totalBytes * 100)) : null, receivedBytes: item.bytesReceived });
  } catch (error) { await fail(job.id, error); }
}
async function changedTab(tabId, url) {
  const job = await readJob();
  if (job?.tabId === tabId && ACTIVE.has(job.phase) && (!url || url !== job.sourceUrl)) await fail(job.id, new Error(url ? 'Раздел Яндекс Диска изменился.' : 'Вкладка Яндекс Диска закрыта.'));
}
chrome.downloads.onCreated.addListener(item => { void (async () => { const job = await readJob(); if (matchesDownload(item, job)) await trackDownload(item, job); })().catch(() => {}); });
chrome.downloads.onChanged.addListener(delta => { if (delta.state || delta.error || delta.filename) void refreshDownload(); });
chrome.tabs.onRemoved.addListener(tabId => { void changedTab(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.url) void changedTab(tabId, change.url).catch(() => {}); });
chrome.alarms.create('ydd-watch', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { void (async () => {
  const job = await readJob();
  if (job?.phase === 'waiting' && job.pending?.until < Date.now()) await fail(job.id, new Error('Диск не начал скачивание ZIP. Проверьте доступ и ограничения загрузок.'));
  if (['scanning', 'selecting', 'fetching', 'packing'].includes(job?.phase) && Date.now() - job.updatedAt > 360000) await fail(job.id, new Error('Операция прервана браузером. Обновите список и повторите.'));
  await refreshDownload();
})().catch(() => {}); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target !== 'background') return;
  const popup = sender.url === chrome.runtime.getURL('popup.html');
  const worker = sender.url === chrome.runtime.getURL('offscreen.html');
  const page = sender.tab && supportedPage(sender.url);
  void (async () => {
    try {
      let data;
      if (page && message.type === 'PULSE') {
        const job = await readJob(); if (job?.tabId === sender.tab.id) await patch(job.id, {}); data = {};
      } else if (!popup && !worker) throw new Error('Недопустимый источник команды.');
      else data = await handle(message, popup);
      reply({ ok: true, ...data });
    } catch (error) { reply({ ok: false, error: error.message }); }
  })();
  return true;
});
async function handle(message, popup) {
  if (popup && message.type === 'SCAN') return scanTab(message.tabId);
  if (popup && message.type === 'STATE') { await refreshDownload(); return { job: publicJob(await readJob()) }; }
  if (popup && message.type === 'START') {
    const job = await mutate(current => {
      if (!current || current.phase !== 'ready' || !current.total) throw new Error('Сначала найдите файлы.');
      return { ...current, archiveName: archiveName(), phase: 'selecting', updatedAt: Date.now(), message: 'Проверяем файлы перед скачиванием…' };
    });
    void run(job.id); return {};
  }
  if (popup && message.type === 'CANCEL') {
    const job = await mutate(current => current && ACTIVE.has(current.phase) ? { ...current, phase: 'cancelling', message: 'Останавливаем операцию…' } : current);
    if (job?.phase === 'cancelling') { await release(job); await patch(job.id, { phase: 'cancelled', pending: null, message: 'Операция отменена.' }); }
    return {};
  }
  if (popup && message.type === 'SHOW') { const job = await readJob(); if (job?.downloadId != null) chrome.downloads.show(job.downloadId); return {}; }
  if (popup && message.type === 'DIAGNOSTICS') {
    const tab = await chrome.tabs.get(message.tabId);
    if (!supportedPage(tab.url)) throw new Error('Откройте Яндекс Диск.');
    await ensureContent(tab.id); return content({ tabId: tab.id, sourceUrl: tab.url }, 'DIAGNOSTICS');
  }
  if (!popup && message.type === 'HEARTBEAT') { const job = await readJob(); if (job) await patch(job.id, {}); return {}; }
  if (popup) throw new Error('Неизвестная команда.');
  const job = await active(message.id);
  if (message.type === 'RESOLVE') return resolveFile(job, message.fileId);
  if (message.type === 'PROGRESS') {
    const { phase, currentFile, completed, attempted, failures, currentBytes } = message.progress;
    const changes = Object.fromEntries(Object.entries({ phase, currentFile, completed, attempted, failures, currentBytes }).filter(([,v]) => v !== undefined));
    if (attempted !== undefined) changes.percent = Math.min(95, Math.floor(attempted / job.total * 95));
    await patch(job.id, changes); return {};
  }
  if (message.type === 'SAVE') {
    if (!message.url.startsWith(`blob:${chrome.runtime.getURL('')}`)) throw new Error('Некорректный URL архива.');
    await patch(job.id, { phase: 'saving', completed: message.completed, failures: message.failures, percent: 99, message: 'Сохраняем ZIP на компьютер…' });
    const downloadId = await chrome.downloads.download({ url: message.url, filename: job.archiveName, conflictAction: 'uniquify', saveAs: false });
    const latest = await readJob();
    if (latest?.id !== job.id || !ACTIVE.has(latest.phase) || latest.phase === 'cancelling') { await cancelDownload(downloadId); return {}; }
    await patch(job.id, { downloadId }); await refreshDownload(); return {};
  }
  if (message.type === 'ERROR') { await fail(job.id, new Error(message.error)); return {}; }
  throw new Error('Неизвестная команда.');
}
