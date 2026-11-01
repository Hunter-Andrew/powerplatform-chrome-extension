# Project notes

- Chrome MV3 extension for Power Apps model-driven app developers (see README.md).
- **Keep README.md up to date**: whenever a feature, shortcut, permission, file or install/test step changes, update the README in the same commit.
- Run the end-to-end test after changes: `node test/run.js [screenshotDir]` (uses the preinstalled Playwright Chromium; mock form lives in `test/mock-form.html`).
- Bump `version` in `manifest.json` (and `window.__pafi.version` in `src/main.js`) for releases.
