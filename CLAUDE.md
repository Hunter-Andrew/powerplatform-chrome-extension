# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Power Apps Form Inspector: a Chrome MV3 extension with developer tools for Power Apps model-driven / Dynamics 365 forms. Plain JavaScript, no build step, no `package.json`, no dependencies. See README.md for the user-facing feature list.

## Rules for this repo

- **Keep README.md up to date**: whenever a feature, shortcut, permission, file or install/test step changes, update the README in the same commit.
- Run the end-to-end test after changes (see below).
- For releases, bump `version` in `manifest.json` **and** `window.__pafi.version` in `src/main.js`; they must match.
- Everything that talks to Dataverse must stay **read-only**: Web API calls are GET only (the test asserts this), and form overrides go through the client-side `Xrm` API only.

## Commands

```
node test/run.js [screenshotDir]   # end-to-end test (the only test suite)
zip -r dist/pp-form-inspector.zip manifest.json src popup icons README.md LICENSE   # package
```

- The test uses the preinstalled Playwright Chromium (`require('playwright')`), loads the extension unpacked, and serves `test/mock-form.html` for every `https://contoso.crm.dynamics.com/**` request. `/api/data/` requests are answered from `test/api-fixtures.js` (unknown URLs get a 404).
- Pass a `screenshotDir` outside the repo; it defaults to `test/`, which leaves PNGs in the working tree.
- It's one sequential script with no test runner, so there's no way to run a single case. Failures print `FAIL <msg>` and set the exit code to 1; it keeps going after a failure. To focus on one area, temporarily comment out unrelated blocks (later blocks depend on state from earlier ones, e.g. the popup section expects `reveal` to be on).
- Proxy errors about `www.google.com` / `contoso.crm.dynamics.com` during the run are harmless noise.

## Architecture

Three execution contexts talk through one command bus:

1. **Page MAIN world** (`src/main.js`, then `src/devtools.js`): injected as MAIN-world content scripts (Chrome 111+) so they can reach `window.Xrm`. `main.js` builds `window.__pafi = { version, lib, run(cmd, arg) }` with a `commands` map (`status`, `info`, `reveal`, `unlock`, `optional`, `labels`, `picker`, `panel`). Both files are IIFEs guarded against double-loading (`if (window.__pafi) return`, `P.devtoolsLoaded`).
2. **`src/devtools.js` extends main.js** through `__pafi.lib`: it reuses helpers (`safe`, `getControls`, `h`, `copy`, `toast`, `getRoot`, ...) and plugs in with `lib.register(name, fn)` (adds `dev`, `monitor`, `monitorLog`), `lib.addCardAction` (buttons on the picker card, e.g. "Logic") and `lib.addStatus` (extra fields in `status`). New page-side features should follow this pattern instead of reaching into main.js internals. Because of this dependency it must load after main.js; keep the order the same in `manifest.json` and in `FILES` in `src/bridge.js`.
3. **Extension contexts** (popup, service worker): never touch the page directly. They call `runInTab(tabId, cmd, arg)` from `src/bridge.js` (an ES module shared by `popup/popup.js` and `src/background.js`), which runs `window.__pafi.run(cmd, arg)` via `chrome.scripting.executeScript({ world: 'MAIN' })`. If `__pafi` is missing it injects both files on demand. If the command is unknown (an older page script is still loaded after an update) it returns an "extension was updated, reload" error. Return values must be structured-cloneable plain data.

Other pieces:

- `src/background.js` only maps `manifest.json` `commands` (keyboard shortcuts) to page commands. Adding a shortcut means editing both.
- `src/env.js` (popup only) runs the production guardrail: per-host tags in `chrome.storage.sync` under `envTags`, otherwise guessed from the org subdomain (`NONPROD` regex); anything unrecognized counts as production. The popup asks for confirmation before turning on `unlock`/`optional` in production. Turning them off is never blocked.
- UI on the page is drawn inside a Shadow DOM host element `<pafi-overlay>` (cards, badges, panels, the `.devpanel`), never in the app's React DOM. Tests query through `document.querySelector('pafi-overlay').shadowRoot`.
- The picker maps DOM to components via Unified Interface attributes (`data-id="<control>-FieldSectionItemContainer"`, `data-control-name`, `data-lp-id`, `section[data-id]`, `data-id="tablist-<tab>"`), then checks each candidate against `Xrm` so only real names are reported.
- Toggles (`reveal`, `unlock`, `optional`) record exactly what they changed in `state` so turning them off restores only that. Keep this invariant when adding overrides.
- The Events monitor wraps named handler functions in the form's script frames (`ClientApiFrame*` iframes), marked with `__pafiWrapped` / `__pafiOrig`, and patches `addOnChange` / `addOnSave` / etc. while it's on. Turning it off must restore the originals (the test checks this).
- `devtools.js` Web API calls go through one `api(path)` helper (`/api/data/v9.2/`, GET, same-origin credentials). Missing privileges should degrade only the affected tab.

## Testing new behavior

`test/mock-form.html` is a hand-written fake UCI form: a `def` object of tabs/sections/fields drives both the DOM and a fake `Xrm` (attributes, controls, BPF, option sets, lookups), plus a `ClientApiFrame_crm` iframe holding the form script functions. New features usually need matching additions to the mock `Xrm`, and to `test/api-fixtures.js` if they hit the Web API.
