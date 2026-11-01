const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const fixture = require('./api-fixtures');
const ext = path.resolve(__dirname, '..');
const out = process.argv[2] || __dirname;
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
(async () => {
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 1200, height: 800 } });
  const apiCalls = [];
  await ctx.route('https://contoso.crm.dynamics.com/**', (r) => {
    const url = r.request().url();
    if (url.includes('/api/data/')) {
      apiCalls.push({ method: r.request().method(), url });
      const body = fixture(url);
      return body ? r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
        : r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { message: 'not in fixtures' } }) });
    }
    return r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'mock-form.html'), 'utf8') });
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('pageerror', e));
  await page.goto('https://contoso.crm.dynamics.com/main.aspx?etn=account');
  await page.waitForFunction(() => !!window.__pafi);
  assert(true, 'content script injected in MAIN world');
  const run = (c, a) => page.evaluate(([c, a]) => window.__pafi.run(c, a), [c, a === undefined ? null : a]);
  const shadowText = () => page.evaluate(() => document.querySelector('pafi-overlay').shadowRoot.querySelector('.devpanel')?.innerText || '');
  const waitText = (t) => page.waitForFunction((t) => (document.querySelector('pafi-overlay').shadowRoot.querySelector('.devpanel')?.innerText || '').includes(t), t, { timeout: 5000 })
    .then(() => true, () => false);

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

  // Dev tools: events
  r = await run('dev', { tab: 'events' }); assert(r.active && r.tab === 'events', 'dev panel opens on events');
  assert(await waitText('Contoso.Account.onPhoneChange'), 'events: form XML handler listed');
  let txt = await shadowText();
  assert(txt.includes('new_/scripts/account.js') && txt.includes('3 handler(s)') && !txt.includes('Mscrm.Internal'), 'events: 3 handlers + library, internal handlers skipped');
  r = await run('monitor', true); assert(r.active && /Watching 2 form handler/.test(r.summary), 'monitor: ' + r.summary);
  await page.evaluate(() => {
    const a = Xrm.Page.data.entity.attributes.get('telephone1');
    a.addOnChange(function myRuntimeHandler() {});
    a.fireOnChange();
  });
  let log = await run('monitorLog');
  const phone = log.find((e) => e.name === 'Contoso.Account.onPhoneChange');
  assert(phone && phone.source === 'telephone1' && phone.ms >= 10, 'monitor: form handler timed ' + JSON.stringify(phone));
  assert(log.some((e) => e.name === 'myRuntimeHandler' && e.kind === 'handler'), 'monitor: runtime-registered handler timed');
  assert(log.some((e) => e.kind === 'event' && e.name === 'onchange' && e.source === 'telephone1'), 'monitor: onchange event marker');
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(out, 'events.png') });
  await run('monitor', false);
  assert(await page.evaluate(() => !document.getElementById('ClientApiFrame_crm').contentWindow.Contoso.Account.onPhoneChange.__pafiWrapped), 'monitor off restores handlers');
  await page.evaluate(() => Xrm.Page.data.entity.attributes.get('telephone1').fireOnChange());
  assert((await run('monitorLog')).filter((e) => e.name === 'Contoso.Account.onPhoneChange').length === 1, 'monitor off: no more logging');

  // Logic
  await run('dev', { tab: 'logic', field: 'telephone1' });
  assert(await waitText('Require phone for big accounts'), 'logic: business rule listed for telephone1');
  txt = await shadowText();
  assert(txt.includes('requirement') && txt.includes('new_fx') && !txt.includes('new_revenuex2'), 'logic: filtered by field (rule action, formula dep)');
  await run('dev', { tab: 'logic', field: 'revenue' });
  await waitText('new_revenuex2');
  txt = await shadowText();
  assert(txt.includes('new_revenuex2') && txt.includes('Calculated') && txt.includes('ownerid'), 'logic: calculated column depends on revenue; control id mapped to attribute');
  await page.screenshot({ path: path.join(out, 'logic.png') });

  // Options
  await run('dev', { tab: 'options' });
  assert(await waitText('Click a value'), 'options: metadata loaded');
  txt = await shadowText();
  assert(txt.includes('Retail') && txt.includes('hidden on form') && txt.includes('local: industrycode'), 'options: values, hidden-on-form tag, option set name');
  await page.screenshot({ path: path.join(out, 'options.png') });

  // Lookups
  await run('dev', { tab: 'lookups' });
  assert(await waitText('aaaa-1'), 'lookups: GUID shown');
  txt = await shadowText();
  assert(txt.includes('systemuser, team') && txt.includes('1234abcd-0000-0000-0000-000000000001'), 'lookups: targets + record id');
  await page.screenshot({ path: path.join(out, 'lookups.png') });

  // Process
  await run('dev', { tab: 'process' });
  assert(await waitText('new_accountsalesprocess'), 'process: BPF table from Web API');
  txt = await shadowText();
  assert(txt.includes('Qualify') && txt.includes('aaaa0001-0000-0000-0000-000000000002') && txt.includes('cccc0001-0000-0000-0000-000000000001'), 'process: stages, stage ids, instance id');
  await page.screenshot({ path: path.join(out, 'process.png') });
  r = await run('dev'); assert(!r.active, 'dev panel closes');
  assert(apiCalls.length > 0 && apiCalls.every((c) => c.method === 'GET'), `Web API: ${apiCalls.length} call(s), all GET`);

  // Picker card "Logic" button
  await run('picker');
  const pb = await page.locator('[data-id="telephone1-FieldSectionItemContainer"] input').boundingBox();
  await page.mouse.click(pb.x + 5, pb.y + 5);
  await page.evaluate(() => [...document.querySelector('pafi-overlay').shadowRoot.querySelectorAll('.card .btn')].find((b) => b.textContent === 'Logic').click());
  assert(await waitText('Require phone for big accounts'), 'picker card Logic button opens filtered logic tab');
  await run('dev');

  // restore
  await run('unlock'); await run('optional');
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
  await pop.waitForSelector('#envbar:not([hidden])');
  assert(await pop.getAttribute('#envbar', 'class') === 'envbar prod', 'guardrail: untagged contoso org treated as production');
  await pop.click('label:has(#unlock)');
  await pop.waitForSelector('#guard:not([hidden])');
  assert(!(await run('status')).unlock.active, 'guardrail: unlock blocked until confirmed');
  await pop.screenshot({ path: path.join(out, 'popup-guard.png'), fullPage: true });
  await pop.click('#guard-cancel');
  assert(!(await pop.isChecked('#unlock')), 'guardrail: cancel leaves unlock off');
  await pop.click('label:has(#unlock)');
  await pop.click('#guard-go');
  await pop.waitForFunction(() => document.getElementById('unlock').checked);
  assert((await run('status')).unlock.active, 'guardrail: confirm turns unlock on');
  await pop.click('label:has(#unlock)'); // turning off is never blocked
  await pop.waitForFunction(() => !document.getElementById('unlock').checked);
  await pop.selectOption('#env-tag', 'dev');
  await pop.waitForFunction(() => document.getElementById('envbar').className === 'envbar dev');
  await pop.click('label:has(#optional)');
  await pop.waitForFunction(() => document.getElementById('optional').checked);
  assert(await pop.isHidden('#guard'), 'guardrail: dev-tagged environment is not blocked');
  await pop.click('label:has(#optional)');
  await pop.screenshot({ path: path.join(out, 'popup.png'), fullPage: true });
  await ctx.close();
})();
