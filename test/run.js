const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ext = path.resolve(__dirname, '..');
const out = process.argv[2] || __dirname;
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
(async () => {
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1200, height: 800 } });
  await ctx.route('https://contoso.crm.dynamics.com/**', r => r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'mock-form.html'), 'utf8') }));
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('pageerror', e));
  await page.goto('https://contoso.crm.dynamics.com/main.aspx?etn=account');
  await page.waitForFunction(() => !!window.__pafi);
  assert(true, 'content script injected in MAIN world');
  const run = (c) => page.evaluate((c) => window.__pafi.run(c), c);

  let r = await run('reveal');
  assert(r.active && r.tabs === 1 && r.sections === 1 && r.controls === 1, 'reveal: ' + JSON.stringify(r));
  assert(await page.isVisible('[data-id="secretfield-FieldSectionItemContainer"]'), 'hidden field now visible');
  r = await run('unlock'); assert(r.count === 2, 'unlock count 2');
  r = await run('optional'); assert(r.count === 2, 'optional count 2');
  r = await run('labels'); assert(r.active, 'labels on');
  await page.waitForTimeout(700);
  const badges = await page.evaluate(() => [...document.querySelector('pafi-overlay').shadowRoot.querySelectorAll('.badge')].map(b => b.textContent));
  assert(badges.includes('ownerid (header_ownerid)') && badges.includes('SUMMARY_TAB') && badges.includes('ACCOUNT_INFORMATION'), 'badges: ' + badges.join(', '));
  await page.screenshot({ path: path.join(out, 'labels.png') });
  await run('labels');

  // Picker
  await run('picker');
  await page.mouse.move(0, 0);
  const box = await page.locator('[data-id="telephone1-FieldSectionItemContainer"] input').boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.click(box.x + 5, box.y + 5);
  const card = await page.evaluate(() => document.querySelector('pafi-overlay').shadowRoot.querySelector('.card .title')?.textContent);
  assert(card === 'telephone1', 'picker field -> ' + card);
  await page.screenshot({ path: path.join(out, 'picker.png') });
  await page.keyboard.press('Escape');
  await run('picker');
  const sb = await page.locator('section[data-id="HIDDEN_SECTION"]').boundingBox();
  await page.mouse.click(sb.x + sb.width - 10, sb.y + 5);
  const card2 = await page.evaluate(() => document.querySelector('pafi-overlay').shadowRoot.querySelector('.card .title')?.textContent);
  assert(card2 === 'HIDDEN_SECTION', 'picker section -> ' + card2);
  await page.keyboard.press('Escape');
  await run('picker');
  await page.click('[data-id="tablist-DETAILS_TAB"]');
  const card3 = await page.evaluate(() => document.querySelector('pafi-overlay').shadowRoot.querySelector('.card .title')?.textContent);
  assert(card3 === 'DETAILS_TAB', 'picker tab -> ' + card3);
  await page.keyboard.press('Escape');

  r = await run('panel'); assert(r.active, 'panel open');
  await page.screenshot({ path: path.join(out, 'panel.png') });
  await run('panel');

  const info = await run('info');
  assert(info.record.webApiUrl.endsWith('/api/data/v9.2/accounts(1234abcd-0000-0000-0000-000000000001)'), 'webApiUrl');

  // restore
  r = await run('reveal'); assert(!r.active && r.count === 3, 're-hide');
  assert(!(await page.isVisible('[data-id="secretfield-FieldSectionItemContainer"]')), 'field hidden again');

  // popup (opened as a tab bound to the form tab)
  await run('reveal');
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://contoso.crm.dynamics.com/*' }))[0].id);
  const pop = await ctx.newPage();
  pop.on('pageerror', e => console.error('popup error', e));
  await pop.setViewportSize({ width: 360, height: 760 });
  await pop.goto(`chrome-extension://${extId}/popup/popup.html?tabId=${tabId}`);
  await pop.waitForSelector('#record dd');
  assert(await pop.isChecked('#reveal'), 'popup reflects reveal state');
  await pop.screenshot({ path: path.join(out, 'popup.png'), fullPage: true });
  await ctx.close();
})();
