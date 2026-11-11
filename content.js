(() => {
  if (globalThis.__yddInstalled) return;
  globalThis.__yddInstalled = true;
  const ROW = '.listing-item, [data-resource-id][data-type], [role="row"][data-id], [role="option"][data-id]';
  let cancelled = false, busy = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const rows = () => [...document.querySelectorAll(ROW)].filter(el => visible(el) && !el.parentElement.closest(ROW));
  const check = url => {
    if (cancelled) throw new Error('Операция отменена.');
    if (location.href !== url) throw new Error('Открытый раздел изменился. Запустите поиск заново.');
  };
  function describe(el) {
    const id = el.getAttribute('data-resource-id') || el.getAttribute('data-id') || el.getAttribute('data-path');
    const type = el.getAttribute('data-type') || el.getAttribute('data-resource-type');
    const folder = /^(dir|folder|directory)$/.test(type || '') || /listing-item_type_(dir|folder)(\s|$)/.test(el.className) || !!el.querySelector('.file-icon_dir, .file-icon_type_dir, .file-icon_type_folder, [data-type="dir"], [data-type="folder"]');
    const file = type === 'file' || /listing-item_type_file(\s|$)/.test(el.className) || !!el.querySelector('.file-icon:not(.file-icon_dir):not(.file-icon_type_dir):not(.file-icon_type_folder)');
    const title = el.querySelector('.listing-item__title, .listing-item__name, [data-resource-name], [data-testid="resource-name"], .listing-item__info .clamped-text, .listing-item__fields .clamped-text');
    const name = el.getAttribute('data-name') || el.getAttribute('data-title') || title?.getAttribute('data-resource-name') || title?.getAttribute('title') || title?.textContent?.trim() || el.getAttribute('title');
    const rawSize = el.getAttribute('data-size') || el.querySelector('[data-size]')?.getAttribute('data-size');
    const anchor = [...el.querySelectorAll('a[download], a[data-download-url], a[href]')].find(a => a.hasAttribute('download') || a.hasAttribute('data-download-url'));
    return { id, name, kind: folder ? 'folder' : file ? 'file' : 'unknown', size: rawSize != null && /^\d+$/.test(rawSize) ? Number(rawSize) : null, url: anchor?.getAttribute('data-download-url') || anchor?.href || null };
  }
  function diagnostics() {
    return { version: 1, pathKind: location.pathname.startsWith('/d/') ? 'public' : 'client', listingCount: document.querySelectorAll('.listing, [role="grid"], [role="listbox"]').length, rowCount: rows().length,
      samples: rows().slice(0, 5).map(el => {
        const data = describe(el);
        return { tag: el.tagName, classes: el.getAttribute('class'), attributeNames: el.getAttributeNames(), type: el.getAttribute('data-type'), resourceType: el.getAttribute('data-resource-type'), hasId: !!data.id, hasName: !!data.name, detectedKind: data.kind,
          children: [...el.querySelectorAll('*')].slice(0, 45).map(child => ({ tag: child.tagName, classes: child.getAttribute('class'), attributes: child.getAttributeNames(), role: child.getAttribute('role') })) };
      }) };
  }
  function scroller() {
    let el = rows()[0]?.parentElement;
    while (el && el !== document.body) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  }
  function selected(el) {
    const box = el.querySelector('input[type="checkbox"], [role="checkbox"]');
    return el.getAttribute('aria-selected') === 'true' || el.classList.contains('listing-item_selected') || box?.checked === true || box?.getAttribute('aria-checked') === 'true';
  }
  async function setSelected(el, value) {
    if (selected(el) === value) return;
    const box = el.querySelector('input[type="checkbox"], [role="checkbox"], .listing-item__checkbox');
    if (!box) throw new Error('Не найден безопасный элемент выделения файла. Интерфейс Диска изменился.');
    box.click();
    for (let i = 0; i < 12 && selected(el) !== value; i++) await sleep(50);
    if (selected(el) !== value) throw new Error('Диск не подтвердил выделение. Обновите страницу.');
  }
  async function sweep(url, visit) {
    const scroll = scroller(), original = scroll.scrollTop, started = Date.now();
    const pulse = setInterval(() => { void chrome.runtime.sendMessage({ target: 'background', type: 'PULSE' }).catch(() => {}); }, 15000);
    // Scroll events are coalesced per frame; a hidden or throttled tab may never
    // fire them, leaving stale virtual rows. Dispatch one so the list re-renders.
    const move = top => { scroll.scrollTop = top; (scroll === document.scrollingElement ? document : scroll).dispatchEvent(new Event('scroll')); };
    let bottom = 0, previous = null;
    try {
      move(0); await sleep(250);
      while (true) {
        check(url);
        if (Date.now() - started > 240000) throw new Error('Список загружается слишком долго. Сбор остановлен без скачивания неполного списка.');
        const current = rows(), ids = new Set(current.map(el => describe(el).id));
        // Consecutive passes must overlap, otherwise rows between them were never seen.
        if (previous?.size && ids.size && ![...ids].some(id => previous.has(id))) throw new Error('Список прокрутился с пропуском строк. Не переключайте вкладку во время сбора и повторите.');
        previous = ids;
        let batch = 0;
        for (const el of current) {
          check(url); await visit(el, describe(el));
          if (++batch % 20 === 0) {
            if (globalThis.scheduler?.yield) await scheduler.yield();
            else await sleep(0);
          }
        }
        const loading = [...document.querySelectorAll('[aria-busy="true"], .listing__spin, .listing__loader')].some(visible);
        const atBottom = scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 3;
        bottom = atBottom && !loading ? bottom + 1 : 0;
        if (bottom >= 5) break;
        if (!atBottom) move(scroll.scrollTop + Math.max(100, scroll.clientHeight * 0.7));
        await sleep(atBottom ? 600 : 180);
      }
    } finally { clearInterval(pulse); move(original); }
  }
  async function scan() {
    const url = location.href;
    if (/\/client\/(trash|journal)/.test(location.pathname)) throw new Error('Этот раздел не поддерживает скачивание. Откройте папку с файлами.');
    if (document.querySelector('input[type="password"], form[action*="passport"]') || /passport\./.test(location.hostname)) throw new Error('Войдите в Яндекс Диск и откройте папку.');
    if (!rows().length && !document.querySelector('.listing, .listing-empty, [data-testid="listing"], [role="grid"], [role="listbox"]')) throw new Error('Список файлов не найден. Дождитесь загрузки Диска и войдите в аккаунт.');
    const found = new Map(); const unknown = new Set();
    await sweep(url, async (el, data) => {
      if (!data.id || !data.name || data.kind === 'unknown') {
        if (!data.id) unknown.add('идентификатор');
        if (!data.name) unknown.add('имя');
        if (data.kind === 'unknown') unknown.add('тип файла или папки');
        return;
      }
      if (found.has(data.id) && found.get(data.id).name !== data.name) throw new Error('Список файлов изменился во время поиска. Повторите поиск.');
      found.set(data.id, data);
    });
    if (unknown.size) throw new Error(`Не удалось распознать: ${[...unknown].join(', ')}. Нажмите «Диагностика» и передайте отчет разработчику. Скачивание остановлено, чтобы не создать неполный архив.`);
    const files = [...found.values()].filter(f => f.kind === 'file');
    return { files, sourceUrl: url, folders: found.size - files.length, totalBytes: files.every(f => f.size !== null) ? files.reduce((n, f) => n + f.size, 0) : null };
  }
  async function selectFiles(files) {
    const url = location.href, wanted = new Set(files.map(f => f.id)), seen = new Set();
    let directUrl = null;
    // Clear all existing selections, including folders and virtualized rows.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sweep(url, async el => setSelected(el, false));
    await sweep(url, async (el, data) => {
      if (data.kind === 'unknown' || !data.id) throw new Error('Неизвестный элемент списка. Повторите поиск.');
      if (wanted.has(data.id)) {
        const expected = files.find(f => f.id === data.id);
        if (data.kind !== 'file' || expected.name !== data.name) throw new Error('Файл изменился. Повторите поиск.');
        await setSelected(el, true); seen.add(data.id);
        if (files.length === 1) directUrl = data.url;
      }
    });
    if (seen.size !== wanted.size) throw new Error('Часть файлов исчезла из текущего списка. Повторите поиск.');
    await sweep(url, async (el, data) => {
      if (selected(el) !== wanted.has(data.id)) throw new Error('Не удалось проверить выделение всех файлов. Скачивание не запущено.');
    });
    const countEl = document.querySelector('[data-selected-count], .listing-toolbar__selected-count');
    if (countEl) {
      const count = Number((countEl.getAttribute('data-selected-count') || countEl.textContent).match(/\d+/)?.[0]);
      if (count !== files.length) throw new Error('Количество выделенных файлов не совпадает со списком.');
    }
    check(url);
    return { selected: seen.size, directUrl };
  }
  function downloadButton() {
    return [...document.querySelectorAll('button, a, [role="button"]')].find(el => {
      if (!visible(el) || el.closest(ROW) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent).trim();
      return /^(скачать|download)$/i.test(label) || el.getAttribute('data-key') === 'download';
    });
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message.target !== 'content') return;
    if (message.type === 'CANCEL') { cancelled = true; reply({ ok: true }); return; }
    if (message.type === 'PING') { reply({ ok: true }); return; }
    if (busy) { reply({ ok: false, error: 'Дождитесь завершения текущего действия на странице.' }); return; }
    cancelled = false; busy = true;
    void (async () => {
      try {
        if (message.sourceUrl) check(message.sourceUrl);
        let result;
        if (message.type === 'SCAN') result = await scan();
        else if (message.type === 'DIAGNOSTICS') result = { diagnostics: diagnostics() };
        else if (message.type === 'CAN_DOWNLOAD') result = { available: !!downloadButton() };
        else if (message.type === 'SELECT') result = await selectFiles(message.files);
        else if (message.type === 'CLICK_DOWNLOAD') {
          const button = downloadButton();
          if (!button) throw new Error('Кнопка «Скачать» недоступна. Возможно, скачивание запрещено владельцем или интерфейс изменился.');
          button.click(); result = {};
        } else throw new Error('Неизвестная команда.');
        reply({ ok: true, ...result });
      } catch (error) { reply({ ok: false, error: error.message }); }
      finally { busy = false; }
    })();
    return true;
  });
})();
