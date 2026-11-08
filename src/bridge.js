// Runs a command against window.__pafi in the page's MAIN world.
// Injects the page scripts on demand (e.g. the tab was open before the extension was installed).
const FILES = ['src/main.js', 'src/devtools.js'];

export async function runInTab(tabId, cmd, arg) {
  const call = () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (c, a) => (window.__pafi ? window.__pafi.run(c, a) : { notLoaded: true }),
      args: [cmd, arg === undefined ? null : arg],
    });
  const unknown = (r) => r && r.result && r.result.error && String(r.result.error).startsWith('Unknown command');

  let [res] = await call();
  if (res && res.result && (res.result.notLoaded || unknown(res))) {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: FILES });
    [res] = await call();
    // An older version of the page script is still loaded: it can't be replaced without a reload.
    if (unknown(res)) return { error: 'The extension was updated. Reload the page to use this tool.' };
  }
  return res ? res.result : null;
}

// ---------------------------------------------------------------------------
// Per-tab toggle persistence (chrome.storage.session), so overrides survive a page reload.
// Stored as `toggles:<tabId>` -> { host, reveal, unlock, optional, labels }. Only restored on the
// same host, so unlock/optional confirmed for one org never carry into another org in the same tab.
// ---------------------------------------------------------------------------
const togglesKey = (tabId) => `toggles:${tabId}`;

/** Host of a tab URL, or '' when the extension can't see it (not one of our hosts). */
export function hostOf(url) {
  try {
    return url ? new URL(url).host : '';
  } catch {
    return '';
  }
}

export async function tabHost(tabId) {
  try {
    return hostOf((await chrome.tabs.get(tabId)).url);
  } catch {
    return '';
  }
}

export async function clearToggles(tabId) {
  await chrome.storage.session.remove(togglesKey(tabId));
}

/** Saves the toggles from a page `status` result; removes the entry when none is on. */
export async function saveToggles(tabId, status, host) {
  if (!status || status.error || status.notLoaded) return;
  const t = {
    reveal: !!(status.reveal && status.reveal.active),
    unlock: !!(status.unlock && status.unlock.active),
    optional: !!(status.optional && status.optional.active),
    labels: !!status.labels,
  };
  if (!host || !Object.values(t).some(Boolean)) return clearToggles(tabId);
  await chrome.storage.session.set({ [togglesKey(tabId)]: { host, ...t } });
}

/** Stored toggles for this tab, or null. A different host drops the stored state. */
export async function loadToggles(tabId, host) {
  const key = togglesKey(tabId);
  const saved = (await chrome.storage.session.get(key))[key];
  if (!saved) return null;
  if (!host || saved.host !== host) {
    await clearToggles(tabId);
    return null;
  }
  return saved;
}
