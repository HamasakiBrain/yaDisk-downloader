import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || `${process.env.LOCALAPPDATA}/ms-playwright/chromium-1223/chrome-win64/chrome.exe`, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4500);
  const result = await page.evaluate(() => ({ url: location.href, title: document.title, text: document.body.innerText.slice(0,10000), items: [...document.querySelectorAll('.listing-item,[data-resource-id],[data-id]')].slice(0,12).map(e=>e.outerHTML.slice(0,22000)) }));
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/public-page.json', JSON.stringify(result, null, 2));
  await writeFile('artifacts/public-page.html', await page.content());
  await page.screenshot({ path: 'artifacts/public-page.png', fullPage: true });
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
