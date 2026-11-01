// Runs a command against window.__pafi in the page's MAIN world.
// Injects main.js on demand (e.g. the tab was open before the extension was installed).
export async function runInTab(tabId, cmd, arg) {
  const call = () =>
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (c, a) => (window.__pafi ? window.__pafi.run(c, a) : { notLoaded: true }),
      args: [cmd, arg === undefined ? null : arg],
    });

  let [res] = await call();
  if (res && res.result && res.result.notLoaded) {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['src/main.js'] });
    [res] = await call();
  }
  return res ? res.result : null;
}
