// Service worker: keyboard shortcuts -> page commands, and re-applying toggles after a page reload.
import { runInTab, saveToggles, loadToggles, clearToggles, hostOf } from './bridge.js';

const MAP = {
  'toggle-picker': 'picker',
  'toggle-labels': 'labels',
  'toggle-reveal': 'reveal',
  'reset-toggles': 'reset',
};

chrome.commands.onCommand.addListener(async (command, tab) => {
  const cmd = MAP[command];
  if (!cmd || !tab || !tab.id) return;
  try {
    await runInTab(tab.id, cmd);
    if (cmd === 'reset') await clearToggles(tab.id);
    if (cmd !== 'picker') await saveToggles(tab.id, await runInTab(tab.id, 'status'), hostOf(tab.url));
  } catch (e) {
    console.warn('[PA Inspector]', e);
  }
});

// Keep toggles on across reloads: when the tab finishes loading, re-apply what was on for this tab + host.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  try {
    const saved = await loadToggles(tabId, hostOf(tab && tab.url));
    if (!saved || !(saved.reveal || saved.unlock || saved.optional || saved.labels)) return;
    const { reveal, unlock, optional, labels } = saved;
    await runInTab(tabId, 'restore', { reveal, unlock, optional, labels });
  } catch (e) {
    console.warn('[PA Inspector] restore', e);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearToggles(tabId).catch(() => {});
});
