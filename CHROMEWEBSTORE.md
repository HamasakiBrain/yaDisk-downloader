# Chrome Web Store Listing — Yandex Disk Downloader

Last Updated: 2026-11-11. Draft listing for a future Chrome Web Store submission.

## Store Listing

**Extension Name:** Yandex Disk Downloader

**Short Description:** Скачивайте файлы папки Яндекс Диска одним ZIP-архивом. Не связано с Яндексом.

**Detailed Description:** Сохраните файлы открытой папки Яндекс Диска одним ZIP. Для публичных ссылок расширение обходит все вложенные папки и сохраняет их структуру в архиве; в личном Диске берутся файлы текущего раздела. Показывает количество, размер и процесс сохранения, поддерживает русские имена и отмену операции. Ошибки отдельных файлов отображаются в отчете. Откройте папку на Диске, нажмите значок расширения и выберите «Скачать всё архивом». Данные не отправляются сторонним сервисам; логин и пароль не требуются.

Расширение не является продуктом Яндекса и не связано с компанией Яндекс. «Яндекс Диск» — товарный знак его владельца.

**Category:** Productivity

**Single Purpose:** Download the files of the open Yandex Disk folder as one ZIP archive (public links include nested folders).

**Primary Language:** Russian

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|---|---|---|---|
| Store icon | 128×128 PNG | Ready | icons/128.png |
| Screenshot | 1280×800 or 640×400 | Needed before publication | — |
| Promo tile | 440×280 | Optional, not created | — |

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| activeTab | permissions | Identify the active page after the user opens the extension; do not request browsing history. |
| scripting | permissions | Inject the bundled collector to inspect and select file rows after a user action. |
| downloads | permissions | Save the ZIP, observe completion, and cancel a related individual download when packing locally. |
| storage | permissions | Preserve task status across popup closure and service worker suspension in session storage. |
| offscreen | permissions | Stream files into a local ZIP without keeping the popup open. |
| alarms | permissions | Detect timed-out operations and refresh native download status after worker suspension. |
| https://disk.yandex.ru/* | host_permissions | Read and operate the current Russian Yandex Disk page. |
| https://disk.yandex.com/* | host_permissions | Read and operate the current international Yandex Disk page. |
| https://*.disk.yandex.ru/* | host_permissions | Fetch file bytes from Yandex Disk download servers. |
| https://*.disk.yandex.com/* | host_permissions | Fetch file bytes from international Disk download servers. |
| https://*.yandex.net/* | host_permissions | Read the official public-resource API and fetch Yandex CDN file responses. |
| https://*.yandexusercontent.com/* | host_permissions | Fetch file content when the official download link uses this Yandex content domain. |

## Privacy & Data Use

The extension processes names, paths, sizes, source-folder URLs and downloaded file content for the requested ZIP only. File metadata and task status are held in `chrome.storage.session`. Public-folder keys and paths are sent to Yandex's official API; file bytes are read from Yandex. Private-file requests can use browser-managed session cookies, without reading or storing them. Signed download URLs remain in memory and are not persisted. ZIP data and one staged file live in OPFS until cleanup; crash remnants are removed on the next local ZIP operation. No analytics or third-party collection.

- Data is not sold to third parties.
- Data is used only for the extension's single purpose.
- Data is not used for creditworthiness or lending.

**Privacy Policy:** PRIVACY.md. A public policy URL is still needed before store submission.

## Distribution and Developer Info

Local unpacked installation only. Publisher name, contact email, support URL, store screenshots and public privacy policy URL have not been supplied. Do not submit until these are provided and the relevant live account scenarios are verified.

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 1.1.1 | 2026-11-11 | Public links: recursive nested folders with preserved structure; download links taken from folder listings; rate-limit backoff; fixed virtualized-list gaps. | Draft |
| 1.1.0 | 2026-11-11 | Official public-folder enumeration; local streaming ZIP; native UI path; progress, cancellation and per-file errors. | Draft |

## Review Notes

Native DOM automation depends on Yandex UI and is not guaranteed for every account variant. Chrome does not identify the source tab in a DownloadItem; native download correlation requires an exact referrer and time window. Avoid other simultaneous downloads from the same folder. Public-folder ZIP building uses the official public API and is independent of DOM classification; nested folders are included there. In the private Disk view only the current section is downloaded.
