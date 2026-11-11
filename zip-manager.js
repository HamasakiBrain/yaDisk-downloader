import './vendor/zip.js';
import { uniqueName } from './shared.js';
const { ZipWriter } = globalThis.zip;

// Stage a single file on disk before adding it: a failed HTTP stream must not
// leave a truncated ZIP entry. Both staging and the final ZIP live in OPFS.
export async function buildArchive(files, { signal, resolveUrl, fetchFile, onProgress, root, jobId }) {
  const dir = await root.getDirectoryHandle(`ydd-${jobId}`, { create: true });
  const output = await dir.getFileHandle('archive.zip', { create: true });
  const writable = await output.createWritable();
  const writer = new ZipWriter(writable, { level: 0, useWebWorkers: false });
  const failures = [], names = new Set(); let completed = 0, attempted = 0;
  try {
    for (const file of files) {
      signal.throwIfAborted();
      let staged;
      const label = file.dir ? `${file.dir}/${file.name}` : file.name;
      try {
        onProgress({ phase: 'fetching', currentFile: label, completed, attempted, failures });
        const url = await resolveUrl(file);
        signal.throwIfAborted();
        staged = await dir.getFileHandle('current-file', { create: true });
        const sink = await staged.createWritable();
        try { await fetchFile(url, sink, signal, bytes => onProgress({ currentBytes: bytes }), file); }
        catch (error) { try { await sink.abort(); } catch {} throw error; }
        const downloaded = await staged.getFile();
        if (file.size !== null && file.size !== undefined && downloaded.size !== file.size) throw new Error('Размер скачанного файла не совпадает с исходным. Возможно, файл изменился или загрузка оборвалась.');
      } catch (error) {
        signal.throwIfAborted();
        if (error.name === 'QuotaExceededError') throw error;
        failures.push({ name: label, error: error.message });
        attempted++;
        onProgress({ completed, attempted, failures });
        continue;
      }
      // An output/quota/ZIP error is fatal: continuing after a partial write
      // could produce a corrupt archive and a misleading success report.
      onProgress({ phase: 'packing' });
      const source = await staged.getFile();
      await writer.add(uniqueName(file.name, names, file.dir), source.stream(), { signal });
      completed++; attempted++;
      await dir.removeEntry('current-file');
      onProgress({ completed, attempted, failures });
    }
    if (!completed) throw new Error('Не удалось скачать ни одного файла. ' + failures.map(f => `${f.name}: ${f.error}`).join('; '));
    signal.throwIfAborted();
    await writer.close();
    return { file: await output.getFile(), completed, failures };
  } catch (error) {
    try { await writable.abort(); } catch {}
    throw error;
  }
}
