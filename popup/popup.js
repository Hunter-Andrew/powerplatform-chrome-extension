import { runInTab } from '../src/bridge.js';
import { classify, setTag, LABELS } from '../src/env.js';

const $ = (id) => document.getElementById(id);
let tabId = null;
let env = null; // result of classify(host)

function flash(msg) {
  document.querySelectorAll('.flash').forEach((f) => f.remove());
  const el = document.createElement('div');
  el.className = 'flash';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

async function copy(text, label) {
  if (!text) return;
  await navigator.clipboard.writeText(text);
  flash(`Copied ${label || text}`);
}

function notice(msg) {
  $('notice').hidden = !msg;
  $('notice').textContent = msg || '';
}

const run = (cmd, arg) => runInTab(tabId, cmd, arg);

function setCount(id, st, idleText, verb) {
  $(id).textContent = st.active ? `${st.count} ${verb}` : idleText;
}

async function refreshStatus() {
  const st = await run('status');
  if (!st) return;
  const pill = $('status');
  if (st.hasForm) {
    pill.textContent = 'Form detected';
    pill.className = 'status ok';
  } else if (st.hasXrm) {
    pill.textContent = 'No form open';
    pill.className = 'status warn';
    notice('Open a record form to use the form tools.');
  } else {
    pill.textContent = 'Not a model-driven app';
    pill.className = 'status warn';
    notice('Xrm was not found on this page. Open a Power Apps model-driven app (Dynamics 365) record.');
  }
  document.querySelectorAll('[data-needs-form]').forEach((el) => {
    el.classList.toggle('disabled', !st.hasForm);
  });
  $('labels').checked = st.labels;
  $('reveal').checked = st.reveal.active;
  $('unlock').checked = st.unlock.active;
  $('optional').checked = st.optional.active;
  setCount('reveal-count', st.reveal, 'tabs, sections & fields', 'item(s) revealed');
  setCount('unlock-count', st.unlock, 'enable disabled controls', 'field(s) unlocked');
  setCount('optional-count', st.optional, 'clear required levels', 'field(s) made optional');
  return st;
}

function fillDl(dl, rows) {
  dl.replaceChildren();
  rows.forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = Array.isArray(v) ? v.join(', ') : String(v);
    dd.className = 'copy';
    dd.title = 'Click to copy';
    dd.addEventListener('click', () => copy(dd.textContent, k.toLowerCase()));
    dl.append(dt, dd);
  });
}

async function refreshEnv(host) {
  if (!host) return;
  env = await classify(host);
  const bar = $('envbar');
  bar.hidden = false;
  bar.className = `envbar ${env.effective}`;
  $('env-host').textContent = host;
  $('env-host').title = env.tag
    ? `Marked as ${LABELS[env.tag]}`
    : `Not marked yet. Guessed ${LABELS[env.guess]} from the org name; choose a type to override.`;
  const sel = $('env-tag');
  sel.options[0].textContent = `Auto (${LABELS[env.guess]})`;
  sel.value = env.tag || '';
}

async function refreshInfo() {
  const info = await run('info');
  if (!info) return;
  try {
    await refreshEnv(info.env && info.env.clientUrl ? new URL(info.env.clientUrl).host : '');
  } catch (e) {
    console.warn(e);
  }
  if (info.record) {
    const r = info.record;
    $('record-section').hidden = false;
    fillDl($('record'), [
      ['Entity', r.entity],
      ['Entity set', r.entitySet],
      ['Record ID', r.id || '(new record)'],
      ['Name', r.primaryName],
      ['Form', r.formName],
      ['Form ID', r.formId],
      ['Form type', r.formType + (r.isDirty ? ' · unsaved changes' : '')],
    ]);
    $('copy-url').disabled = !r.recordUrl;
    $('open-api').disabled = !r.webApiUrl;
    $('copy-url').onclick = () => copy(r.recordUrl, 'record URL');
    $('open-api').onclick = () => chrome.tabs.create({ url: r.webApiUrl });
  }
  if (info.env) {
    const e = info.env;
    $('env-section').hidden = false;
    fillDl($('env'), [
      ['Org', e.org],
      ['URL', e.clientUrl],
      ['Version', e.version],
      ['App', e.app && `${e.app} (${e.appUniqueName})`],
      ['App ID', e.appId],
      ['User', e.user],
      ['User ID', e.userId],
      ['Roles', e.roles],
    ]);
  }
}

async function toggle(cmd) {
  const res = await run(cmd);
  if (res && res.error) notice(res.error);
  await refreshStatus();
}

function bindToggle(id, cmd) {
  $(id).addEventListener('change', () => toggle(cmd));
}

// Production guardrail: confirm before tools that let you change data you normally can't.
const GUARDED = {
  unlock: 'Unlocking read-only fields lets you edit values the app normally protects. If you save the record, those values are written to production.',
  optional: 'Clearing required levels lets you save records with required fields left empty. If you save the record, that data is written to production.',
};

function bindGuardedToggle(id, cmd) {
  $(id).addEventListener('change', () => {
    const turningOn = $(id).checked;
    if (!turningOn || !env || !env.isProd) return toggle(cmd);
    $(id).checked = false;
    $('guard-text').textContent = `${env.host} is ${env.tag ? 'marked as Production' : 'treated as Production (not marked as Dev or Test)'}. ${GUARDED[cmd]}`;
    $('guard').hidden = false;
    $('guard-go').onclick = async () => {
      $('guard').hidden = true;
      await toggle(cmd);
    };
    $('guard-cancel').onclick = () => { $('guard').hidden = true; };
  });
}

async function showShortcuts() {
  const cmds = await chrome.commands.getAll();
  cmds.forEach((c) => {
    const el = document.querySelector(`kbd[data-shortcut="${c.name}"]`);
    if (el) el.textContent = c.shortcut || '';
  });
}

async function init() {
  const param = new URLSearchParams(location.search).get('tabId');
  if (param) {
    tabId = Number(param);
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
  }

  showShortcuts();
  $('shortcuts').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  bindToggle('labels', 'labels');
  bindToggle('reveal', 'reveal');
  bindGuardedToggle('unlock', 'unlock');
  bindGuardedToggle('optional', 'optional');

  $('env-tag').addEventListener('change', async () => {
    if (!env) return;
    await setTag(env.host, $('env-tag').value || null);
    await refreshEnv(env.host);
  });

  document.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', async () => {
    const res = await run('dev', { tab: b.dataset.dev });
    if (res && res.error) return notice(res.error);
    window.close();
  }));

  $('picker').addEventListener('click', async () => {
    const res = await run('picker');
    if (res && res.error) return notice(res.error);
    window.close(); // get out of the way so the user can click on the form
  });
  $('panel').addEventListener('click', async () => {
    const res = await run('panel');
    if (res && res.error) return notice(res.error);
    window.close();
  });

  try {
    await refreshStatus();
    await refreshInfo();
  } catch (err) {
    $('status').textContent = 'Unavailable';
    $('status').className = 'status warn';
    $('main').classList.add('disabled');
    notice('This extension only works on Power Apps / Dynamics 365 pages (*.dynamics.com).');
    console.warn(err);
  }
}

init();
