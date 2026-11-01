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
