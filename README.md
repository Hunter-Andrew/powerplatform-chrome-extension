# powerplatform-chrome-extension

Chrome extension aid for Power Platform developers.

The extension is **Power Apps Form Inspector**: developer tools for Power Apps model-driven apps / Dynamics 365 forms.

## Features

| Feature | What it does |
|---|---|
| **Pick element** (`Alt+Shift+I`) | Works like the DevTools element picker. Hover over a field, section or tab to highlight it, then click it. The logical name is copied to your clipboard and a card shows its details: control name, label, type, value, required level, visible/disabled state, and parent section/tab. A subgrid shows its target entity and current view. |
| **Show logical names** (`Alt+Shift+L`) | Puts a badge on every tab (purple), section (blue) and field (green) on the form. Click a badge to copy its name. When a control name differs from its attribute name, the badge shows both, e.g. `ownerid (header_ownerid)`. |
| **All fields panel** | Lists every attribute on the form, with a search box, Dirty and Hidden filters, values, types and required/dirty tags. You can click to copy, jump to a field, or copy the whole record as JSON. |
| **Reveal hidden** (`Alt+Shift+H`) | Shows every hidden tab, section and field. Each revealed item gets a dashed orange outline (and an orange badge). Toggle it off to re-hide exactly what was revealed. |
| **Unlock read-only fields** | Turns on disabled controls. Toggle off to lock them again. |
| **Make all fields optional** | Sets every required level to `none`, so you can save without filling required fields. Toggle off to restore the original levels. |
| **Record info** | Shows entity, entity set, record ID, form name/ID and form type. Includes **Copy record URL** and **Open in Web API** (opens `/api/data/v9.2/<set>(<id>)`). |
| **Environment info** | Shows org unique name, URL, version, app name/ID, user, user ID and security roles. Click any value to copy it. |

All overrides happen **client-side only**. They use the standard `Xrm` client API (`setVisible`, `setDisabled`, `setRequiredLevel`) and nothing is written to the form definition. Navigating to another record resets them.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, which also works).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Pin the extension, then open a model-driven app record.

You can change shortcuts at `chrome://extensions/shortcuts`.

## How it works

- `src/main.js` runs in the page's **MAIN world** (needs Chrome 111+) so it can reach `window.Xrm`. It exposes `window.__pafi.run(cmd)`.
- The popup and the keyboard shortcuts call it through `chrome.scripting.executeScript` (`src/bridge.js`). If the script isn't on the page yet (for example, the tab was open before you installed the extension), the bridge injects it on demand.
- The picker maps DOM to components using Unified Interface attributes (`data-id="<control>-FieldSectionItemContainer"`, `data-control-name`, `data-lp-id`, `section[data-id]`, `data-id="tablist-<tab>"`). It then **checks each candidate against `Xrm`**, so it only reports names that actually exist on the form.
- The overlays are drawn in a Shadow DOM layer and never touch the app's React DOM.

Host permissions cover `*.dynamics.com`, plus the GCC High/DoD (`microsoftdynamics.us`, `appsplatform.us`), Germany and China clouds.

## Tests

`test/` has a mock UCI form with a fake `Xrm`. To run it end-to-end with Playwright:

```
node test/run.js [screenshotDir]
```

## Repository layout

```
manifest.json        Extension manifest (MV3)
src/main.js          Page-world script: Xrm access, picker, overlays, panel, overrides
src/bridge.js        Runs commands in the page via chrome.scripting (shared by popup + worker)
src/background.js    Service worker: keyboard shortcuts
popup/               Toolbar popup (HTML/CSS/JS)
icons/               Extension icons
test/                Mock UCI form + Playwright end-to-end test
```

## Packaging

```
zip -r dist/pp-form-inspector.zip manifest.json src popup icons README.md LICENSE
```

## License

MIT, see [LICENSE](LICENSE).
