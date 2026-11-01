// Keyboard shortcuts -> page commands.
import { runInTab } from './bridge.js';

const MAP = {
  'toggle-picker': 'picker',
  'toggle-labels': 'labels',
  'toggle-reveal': 'reveal',
};

chrome.commands.onCommand.addListener(async (command, tab) => {
  const cmd = MAP[command];
  if (!cmd || !tab || !tab.id) return;
  try {
    await runInTab(tab.id, cmd);
  } catch (e) {
    console.warn('[PA Inspector]', e);
  }
});
