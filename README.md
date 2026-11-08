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
| **Reset** (`Alt+Shift+D`) | The **↺ Reset** button at the top of the popup turns every toggle off at once: re-hides, re-locks and restores required levels exactly as each toggle does, hides the logical-name badges, cancels the picker and stops the Events monitor. Enabled only while a toggle is on. |
| **Record info** | Shows entity, entity set, record ID, form name/ID and form type. Includes **Copy record URL** and **Open in Web API** (opens `/api/data/v9.2/<set>(<id>)`). |
| **Environment info** | Shows org unique name, URL, version, app name/ID, user, user ID and security roles. Click any value to copy it. |
| **Production guardrail** | The popup shows which environment you're on, color-coded (red = production, amber = test, green = dev). Before **Unlock read-only fields** or **Make all fields optional** turns on in production, it asks you to confirm. Pick the environment type from the drop-down to mark it. Unmarked orgs are guessed from their name (e.g. `contoso-dev`, `contoso-uat`); anything that doesn't look like dev or test is treated as production. Marks are saved per host in Chrome sync storage. |

### Developer tools panel

The **Developer tools** buttons in the popup open a side panel on the form with five tabs. Everything in it is read-only.

| Tab | What it does |
|---|---|
| **Events** | Lists every handler registered on the form (OnLoad, OnSave, OnChange, TabStateChange, ...) with its function, library, enabled flag and "pass execution context" flag, plus the form's libraries (click to open the web resource). **Start monitor** logs every handler call live, with the field or event that triggered it, its duration (async handlers are timed until their promise settles) and any error it throws. Handlers added in code with `addOnChange`, `addOnSave`, `addOnLoad`, `addTabStateChange` and the BPF `addOnStage...` methods while the monitor is on are logged too. ⚑ rows mark the event itself. **Copy log** copies it as tab-separated text. |
| **Logic** | Lists the table's business rules (state, scope and every field each rule reads, sets, locks, hides, requires or shows a message on) and its calculated, rollup and formula columns (with the fields they use). Type a field name to see only what touches it, or click **Logic** on a field's picker card. |
| **Options** | Lists every option set, multi-select and Yes/No field with each option's integer value and label, the current value, the option set name (global or local) and options removed from this form's control. Click a value to copy it. Tick **Include fields not on form** to see all of the table's option set fields. |
| **Lookups** | Lists every lookup on the form with its target tables and current value(s): name, table and GUID. Buttons copy a Web API filter (`_parentaccountid_value eq <guid>`), open the record, or open it in the Web API. |
| **Process** | Shows the active business process flow: process ID, instance ID, status, active stage, the traversed path, the other flows enabled for the record, and every stage with its stage ID, table, category and steps (field, required). |

**Events monitor limits.** The form's OnLoad usually runs before the monitor can hook in. Turn the monitor on, then open another record in the same app to catch OnLoad. Form handlers are timed by wrapping the named functions in the page's script frames. If a handler can't be found by name, it's shown in the monitor summary, and you still see the ⚑ event rows.

All overrides happen **client-side only**. They use the standard `Xrm` client API (`setVisible`, `setDisabled`, `setRequiredLevel`) and nothing is written to the form definition.

**Toggles stay on in the tab.** Once you turn on Reveal hidden, Unlock read-only fields, Make all fields optional or Show logical names, it stays on in that browser tab until you turn it off (or use **Reset**): when you open another record or form, when you reload the page, and when the form hides, locks or requires something later (slow loading, OnLoad scripts, tabs that load on demand). The state is kept per tab and per host in Chrome session storage, which is cleared when the tab or the browser closes. It's only restored on the same org: if you open a different org in that tab, the saved state is dropped, so an Unlock you confirmed for a dev org never carries into production.

## Permissions and privileges

The extension only uses the `activeTab`, `scripting` and `storage` permissions, plus host access to Dynamics domains. `storage` holds your environment marks (sync storage) and which toggles are on in each tab (session storage, cleared when the browser closes). Most tools use only the client-side `Xrm` API and work for any user who can open the form.

The Developer tools panel also makes **read-only Web API GET requests** with your own session. It never writes anything. If a privilege is missing, that part of the panel shows an error and the rest keeps working:

| Data | Web API request | Privilege needed |
|---|---|---|
| Form event handlers and libraries (Events) | `systemforms(<formid>)?$select=formxml` | Read on **System Form** (most security roles have this) |
| Business rules (Logic) | `workflows?$filter=category eq 2 ...` | Read on **Process**. Use organization level to see rules owned by other users. |
| Calculated, rollup and formula columns (Logic), option set names and options not on the form (Options) | `EntityDefinitions(...)/Attributes` | None. Every user can read table metadata. |
| BPF table and traversed path (Process) | `workflows(<id>)`, `<bpf entity set>(<instance id>)` | Read on **Process** and on the BPF table |

Stages, steps, option values and lookups come from the client API, so they show up even without these privileges. System Administrator is not required.

## Install (unpacked)

1. Open `chrome://extensions` (or `edge://extensions`, which also works).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Pin the extension, then open a model-driven app record.

Default shortcuts: `Alt+Shift+I` pick element, `Alt+Shift+L` logical names, `Alt+Shift+H` reveal hidden, `Alt+Shift+D` reset all toggles. Chrome doesn't assign a suggested shortcut that's already taken, so check `chrome://extensions/shortcuts`; you can change them there too.

## How it works

- `src/main.js` runs in the page's **MAIN world** (needs Chrome 111+) so it can reach `window.Xrm`. It exposes `window.__pafi.run(cmd)`. `src/devtools.js` loads right after it and adds the Developer tools panel commands (`dev`, `monitor`).
- The popup and the keyboard shortcuts call it through `chrome.scripting.executeScript` (`src/bridge.js`). If the script isn't on the page yet (for example, the tab was open before you installed the extension), the bridge injects it on demand.
- After each toggle change the popup and the service worker save the toggles for the tab (`chrome.storage.session`, key `toggles:<tabId>`, with the host). When the tab finishes loading, the service worker sends them back to the page with the `restore` command. On the page, the toggles are the desired state: while any is on, a 500 ms tick re-applies it to whatever is currently hidden, disabled or required and records what it changed, so turning it off restores only that.
- The picker maps DOM to components using Unified Interface attributes (`data-id="<control>-FieldSectionItemContainer"`, `data-control-name`, `data-lp-id`, `section[data-id]`, `data-id="tablist-<tab>"`). It then **checks each candidate against `Xrm`**, so it only reports names that actually exist on the form.
- The overlays are drawn in a Shadow DOM layer and never touch the app's React DOM.

Host permissions cover `*.dynamics.com`, plus the GCC High/DoD (`microsoftdynamics.us`, `appsplatform.us`), Germany and China clouds.

## Tests

`test/` has a mock UCI form with a fake `Xrm` (including a BPF, option sets, lookups and a `ClientApiFrame` with form scripts) and canned Web API responses (`test/api-fixtures.js`). The test also checks that every Web API call is a GET. To run it end-to-end with Playwright:

```
node test/run.js [screenshotDir]
```

## Repository layout

```
manifest.json        Extension manifest (MV3)
src/main.js          Page-world script: Xrm access, picker, overlays, panel, overrides
src/devtools.js      Page-world script: Developer tools panel (events, logic, options, lookups, process)
src/env.js           Environment classification for the production guardrail (popup)
src/bridge.js        Runs commands in the page via chrome.scripting; saves per-tab toggles (shared by popup + worker)
src/background.js    Service worker: keyboard shortcuts, re-applies toggles after a page reload
popup/               Toolbar popup (HTML/CSS/JS)
icons/               Extension icons
test/                Mock UCI form, Web API fixtures + Playwright end-to-end test
```

## Packaging

```
zip -r dist/pp-form-inspector.zip manifest.json src popup icons README.md LICENSE
```

## License

MIT, see [LICENSE](LICENSE).
