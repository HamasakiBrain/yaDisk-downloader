export const ACTIVE = new Set(['scanning', 'selecting', 'waiting', 'fetching', 'packing', 'saving', 'cancelling']);
export function supportedPage(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && ['disk.yandex.ru', 'disk.yandex.com'].includes(u.hostname); } catch { return false; }
}
export function allowedDownload(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && [
      'disk.yandex.ru', 'disk.yandex.com', 'yandex.net', 'yandexusercontent.com'
    ].some(host => u.hostname === host || u.hostname.endsWith('.' + host));
  } catch { return false; }
}
export function samePage(a, b) {
  try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search; } catch { return false; }
}
export function archiveName(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return `yandex_disk_download_${local.toISOString().slice(0, 10)}.zip`;
}
// One path segment that cannot escape its ZIP folder.
export function safeSegment(value, fallback = '_') {
  const name = String(value).normalize('NFC').replace(/[\\/\x00-\x1f]/g, '_');
  return !name || /^\.+$/.test(name) ? fallback : name;
}
// `dir` is a '/'-joined chain of safeSegment() values; uniqueness is per full path.
export function uniqueName(value, used, dir = '') {
  const name = safeSegment(value, 'file'), prefix = dir ? dir + '/' : '';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let result = name, n = 2;
  while (used.has((prefix + result).toLocaleLowerCase('ru'))) result = `${stem} (${n++})${ext}`;
  used.add((prefix + result).toLocaleLowerCase('ru'));
  return prefix + result;
}
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Неизвестен';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']; let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${new Intl.NumberFormat('ru', { maximumFractionDigits: i ? 2 : 0 }).format(bytes)} ${units[i]}`;
}
export function publicJob(job) {
  if (!job) return null;
  const { files, pending, sourceUrl, publicLocation, ...state } = job;
  return state;
}
