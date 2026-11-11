import { allowedDownload, samePage } from './shared.js';

// Chrome does not expose a source tab ID. Require an exact referrer and a
// narrowly scoped, explicitly armed expectation; never claim arbitrary downloads.
export function matchesDownload(item, job) {
  const p = job?.pending;
  if (!p || !allowedDownload(item.finalUrl || item.url) || !samePage(item.referrer, job.sourceUrl)) return false;
  const time = Date.parse(item.startTime);
  if (!Number.isFinite(time) || time < p.since - 1000 || time > p.until) return false;
  const name = (item.filename || '').split(/[\\/]/).pop().normalize('NFC');
  return p.kind === 'native' ? /\.zip$/i.test(name) || (!name && /application\/(zip|x-zip-compressed)/i.test(item.mime || '')) : name === p.name.normalize('NFC');
}
export async function inspectDownload(id) {
  const [item] = await chrome.downloads.search({ id });
  if (!item) throw new Error('Загрузка исчезла из списка Chrome.');
  return item;
}
export async function cancelDownload(id) {
  if (id == null) return;
  try { await chrome.downloads.cancel(id); } catch { /* Already complete or cancelled. */ }
}
