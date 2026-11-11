import { ACTIVE, formatBytes, supportedPage } from './shared.js';
const $ = id => document.getElementById(id);
let tabId, job, polling = false;
async function request(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ target: 'background', type, ...extra });
  if (!result?.ok) throw new Error(result?.error || 'Расширение не отвечает.');
  return result;
}
function notice(error) { $('notice').textContent = error.message; $('notice').hidden = false; }
function render(next) {
  job = next;
  if (!job) return;
  const active = ACTIVE.has(job.phase);
  document.body.dataset.phase = job.phase;
  $('count').textContent = job.phase === 'scanning' ? '…' : job.total;
  $('size').textContent = job.phase === 'scanning' ? '…' : formatBytes(job.totalBytes);
  $('start').disabled = job.phase !== 'ready' || !job.total;
  $('refresh').disabled = active;
  $('cancel').hidden = !active;
  $('show').hidden = !['complete', 'partial'].includes(job.phase);
  $('status').textContent = job.message;
  if (job.phase === 'fetching') $('status').textContent = 'Скачиваем файлы для ZIP…';
  if (job.phase === 'packing') $('status').textContent = 'Добавляем файл в архив…';
  if (Number.isFinite(job.percent)) $('progress').value = job.percent; else $('progress').removeAttribute('value');
  $('percent').textContent = Number.isFinite(job.percent) ? `${job.percent}%` : '';
  const completedLabel = job.mode === 'native' && active ? 'Файлов в архиве' : 'Скачано файлов';
  $('done').textContent = job.total ? `${completedLabel}: ${job.mode === 'native' && active ? job.total : job.completed} / ${job.total}` : '';
  $('current').textContent = active ? job.currentFile || '' : '';
  $('errors').replaceChildren();
  for (const failure of job.failures || []) { const li = document.createElement('li'); li.textContent = `${failure.name}: ${failure.error}`; $('errors').append(li); }
  $('errors').hidden = !job.failures?.length;
  if (job.failures?.length) $('done').textContent += ` · Ошибок: ${job.failures.length}`;
  $('scope').textContent = job.recursive
    ? `Все файлы, включая вложенные папки${job.folders ? ` (${job.folders})` : ''}. Структура папок сохраняется в ZIP.`
    : `Только файлы текущего раздела. Папки не включаются.${job.folders ? ` Пропущено папок: ${job.folders}.` : ''}`;
}
async function state() {
  if (polling) return;
  polling = true;
  try { render((await request('STATE')).job); } catch (error) { notice(error); } finally { polling = false; }
}
async function scan() {
  $('notice').hidden = true; $('refresh').disabled = true; $('start').disabled = true;
  $('status').textContent = 'Собираем файлы с прокруткой…';
  try { await request('SCAN', { tabId }); await state(); } catch (error) { notice(error); $('refresh').disabled = false; }
}
$('start').addEventListener('click', async () => { $('start').disabled = true; try { await request('START'); await state(); } catch (error) { notice(error); } });
$('refresh').addEventListener('click', scan);
$('diagnose').addEventListener('click', async () => {
  try { const result = await request('DIAGNOSTICS', { tabId }); $('diagnostics').value = JSON.stringify(result.diagnostics, null, 2); $('diagnostics').hidden = false; $('diagnostics').select(); }
  catch (error) { notice(error); }
});
$('cancel').addEventListener('click', async () => { try { await request('CANCEL'); await state(); } catch (error) { notice(error); } });
$('show').addEventListener('click', () => { void request('SHOW').catch(notice); });
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); tabId = tab?.id;
  const result = await request('STATE');
  if (result.job && ACTIVE.has(result.job.phase)) render(result.job);
  else if (!supportedPage(tab?.url)) { $('status').textContent = 'Откройте папку на Яндекс Диске.'; $('refresh').disabled = true; $('progress').value = 0; }
  else if (result.job?.tabId === tabId && ['ready','complete','partial','error','cancelled'].includes(result.job?.phase)) render(result.job);
  else await scan();
} catch (error) { notice(error); }
setInterval(() => { if (job && ACTIVE.has(job.phase)) void state(); }, 600);
