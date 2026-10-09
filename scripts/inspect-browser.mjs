import { chromium } from '@playwright/test';
import console from 'node:console';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE:', m.text());
});
page.on('requestfailed', (r) => console.log('FAILED:', r.url(), r.failure()));
await page.goto('http://127.0.0.1:5173/');
await page.waitForTimeout(3000);
console.log((await page.locator('body').innerText()).slice(0, 2000));
await page.screenshot({ path: 'test-results/inspect.png' });
await browser.close();
