/*
 * Power Apps Form Inspector — page-world script.
 * Runs in the page's MAIN world so it can talk to the Xrm client API.
 * The popup / background worker call window.__pafi.run(command, arg).
 */
(() => {
  'use strict';
  if (window.__pafi) return;

  const COLORS = {
    tab: '#8b5cf6',
    section: '#2563eb',
    control: '#059669',
    hidden: '#f59e0b',
  };

  const state = {
    formKey: null,
    revealActive: false,
    revealed: [], // { kind, name }
    unlockActive: false,
    unlocked: [], // control names
    optionalActive: false,
    optional: [], // { name, level }
    labels: false,
    picking: false,
  };

  const safe = (fn, fallback) => {
    try {
      const v = fn();
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  };

  const cleanId = (id) => (id ? String(id).replace(/[{}]/g, '').toLowerCase() : '');

  // ---------------------------------------------------------------------------
  // Xrm helpers
  // ---------------------------------------------------------------------------
  function getFC() {
    const page = safe(() => window.Xrm.Page, null);
    const ok = safe(
      () => !!(page && page.ui && page.ui.controls && page.ui.tabs && page.data && page.data.entity &&
        typeof page.ui.controls.get === 'function'),
      false,
    );
    return ok ? page : null;
  }

  function forEachCol(col, fn) {
    if (!col) return;
    if (typeof col.forEach === 'function') {
      col.forEach(fn);
    } else if (typeof col.get === 'function') {
      (col.get() || []).forEach(fn);
    }
  }

  function getTabs(fc) {
    const out = [];
    forEachCol(fc.ui.tabs, (t) => out.push(t));
    return out;
  }

  function getSections(fc) {
    const out = [];
    getTabs(fc).forEach((tab) => forEachCol(tab.sections, (s) => out.push({ section: s, tab })));
    return out;
  }

  function getControls(fc) {
    const out = [];
    forEachCol(fc.ui.controls, (c) => out.push(c));
    return out;
  }

  function lookup(fc, kind, name) {
    if (!fc) return null;
    if (kind === 'tab') return safe(() => fc.ui.tabs.get(name), null);
    if (kind === 'section') {
      const hit = getSections(fc).find(({ section }) => safe(() => section.getName()) === name);
      return hit ? hit.section : null;
    }
    return safe(() => fc.ui.controls.get(name), null);
  }

  function formKey(fc) {
    const entity = safe(() => fc.data.entity.getEntityName(), '');
    const id = cleanId(safe(() => fc.data.entity.getId(), ''));
    const formId = safe(() => fc.ui.formSelector.getCurrentItem().getId(), '');
    return `${entity}|${formId}|${id}`;
  }

  /** Reset per-form state when the user navigates to another record/form. */
  function syncForm(fc) {
    const key = fc ? formKey(fc) : null;
    if (key === state.formKey) return;
    // A new record being saved (empty id -> guid) is still the same form.
    const prev = state.formKey ? state.formKey.split('|') : null;
    const next = key ? key.split('|') : null;
    const sameUnsaved = prev && next && prev[0] === next[0] && prev[1] === next[1] && prev[2] === '';
    if (!sameUnsaved) {
      state.revealActive = false;
      state.revealed = [];
      state.unlockActive = false;
      state.unlocked = [];
      state.optionalActive = false;
      state.optional = [];
    }
    state.formKey = key;
  }

  // ---------------------------------------------------------------------------
  // DOM <-> form component mapping (Unified Interface)
  // ---------------------------------------------------------------------------
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));

  function controlEl(name) {
    const n = esc(name);
    return (
      document.querySelector(`[data-id="${n}-FieldSectionItemContainer"]`) ||
      document.querySelector(`[data-control-name="${n}"]`) ||
      document.querySelector(`[data-id="dataSetRoot_${n}"]`) ||
      document.querySelector(`[data-id="${n}_container"]`) ||
      document.querySelector(`[data-id="${n}"]`)
    );
  }

  function sectionEl(name) {
    const n = esc(name);
    return document.querySelector(`section[data-id="${n}"]`) || document.querySelector(`[data-id="${n}"]`);
  }

  function tabEl(name) {
    const n = esc(name);
    return document.querySelector(`[data-id="tablist-${n}"]`);
  }

  function elFor(kind, name) {
    if (kind === 'tab') return tabEl(name);
    if (kind === 'section') return sectionEl(name);
    return controlEl(name);
  }

  /** Candidate control names that a DOM node might represent. */
  function controlCandidates(node) {
    const out = [];
    const cn = node.getAttribute('data-control-name');
    if (cn) out.push(cn);
    const id = node.getAttribute('data-id');
    if (id) {
      const suffixes = ['-FieldSectionItemContainer', '_container', '.fieldControl'];
      const prefixes = ['dataSetRoot_'];
      let matched = false;
      suffixes.forEach((s) => {
        if (id.endsWith(s)) {
          out.push(id.slice(0, -s.length));
          matched = true;
        }
      });
      prefixes.forEach((p) => {
        if (id.startsWith(p)) {
          out.push(id.slice(p.length));
          matched = true;
        }
      });
      if (!matched && !id.startsWith('tablist-')) out.push(id);
    }
    const lp = node.getAttribute('data-lp-id');
    if (lp) {
      // e.g. "MscrmControls.FieldControls.TextBoxControl|name.fieldControl|account"
      const parts = lp.split('|');
      if (parts[1]) out.push(parts[1].split('.')[0]);
    }
    return out;
  }

  /** Walk up from a DOM node and find the innermost field / section / tab it belongs to. */
  function identify(target, fc) {
    const sections = getSections(fc);
    for (let n = target; n && n !== document.documentElement; n = n.parentElement) {
      if (n.nodeType !== 1) continue;

      for (const cand of controlCandidates(n)) {
        const c = safe(() => fc.ui.controls.get(cand), null);
        if (c) return { kind: 'control', name: cand, obj: c, el: controlEl(cand) || n };
      }

      const id = n.getAttribute('data-id');
      if (!id) continue;

      if (id.startsWith('tablist-')) {
        const name = id.slice('tablist-'.length);
        const t = safe(() => fc.ui.tabs.get(name), null);
        if (t) return { kind: 'tab', name, obj: t, el: n };
      }

      const sec = sections.find(({ section }) => safe(() => section.getName()) === id);
      if (sec) return { kind: 'section', name: id, obj: sec.section, el: n };

      const tabName = id.replace(/^tabpanel-/, '');
      const t = safe(() => fc.ui.tabs.get(tabName), null);
      if (t) return { kind: 'tab', name: tabName, obj: t, el: tabEl(tabName) || n };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Describing components
  // ---------------------------------------------------------------------------
  function fmtValue(attr) {
    if (!attr) return '';
    const v = safe(() => attr.getValue(), null);
    if (v === null || v === undefined) return '(null)';
    const type = safe(() => attr.getAttributeType(), '');
    if (type === 'lookup' && Array.isArray(v)) {
      return v.map((l) => `${l.name || ''} [${l.entityType || ''}: ${cleanId(l.id)}]`).join('; ');
    }
    if (type === 'optionset' || type === 'boolean' || type === 'multiselectoptionset') {
      const text = safe(() => attr.getText(), null);
      const raw = Array.isArray(v) ? v.join(', ') : String(v);
      return text !== null && text !== undefined ? `${raw} (${Array.isArray(text) ? text.join(', ') : text})` : raw;
    }
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  const wasRevealed = (kind, name) => state.revealed.some((r) => r.kind === kind && r.name === name);

  function describe(hit) {
    const { kind, name, obj } = hit;
    if (kind === 'control') {
      const attr = safe(() => obj.getAttribute && obj.getAttribute(), null);
      const parentSection = safe(() => obj.getParent(), null);
      const parentTab = safe(() => parentSection.getParent(), null);
      const controlType = safe(() => obj.getControlType(), '');
      const rows = [
        ['Logical name', attr ? safe(() => attr.getName(), '') : '', true],
        ['Control name', name, true],
        ['Label', safe(() => obj.getLabel(), '')],
        ['Control type', controlType],
      ];
      if (attr) {
        rows.push(['Attribute type', [safe(() => attr.getAttributeType(), ''), safe(() => attr.getFormat(), '')].filter(Boolean).join(' / ')]);
        rows.push(['Value', fmtValue(attr), true]);
        rows.push(['Required', safe(() => attr.getRequiredLevel(), '')]);
        rows.push(['Dirty', String(safe(() => attr.getIsDirty(), ''))]);
        rows.push(['Submit mode', safe(() => attr.getSubmitMode(), '')]);
      }
      if (controlType === 'subgrid') {
        rows.push(['Grid entity', safe(() => obj.getEntityName(), ''), true]);
        rows.push(['View', safe(() => obj.getViewSelector().getCurrentView().name, '')]);
      }
      rows.push(['Visible', String(safe(() => obj.getVisible(), ''))]);
      rows.push(['Disabled', String(safe(() => obj.getDisabled(), ''))]);
      if (parentSection) rows.push(['Section', safe(() => parentSection.getName(), ''), true]);
      if (parentTab) rows.push(['Tab', safe(() => parentTab.getName(), ''), true]);
      const primary = (attr && safe(() => attr.getName(), '')) || name;
      return { kind: 'Field', primary, rows, hidden: wasRevealed('control', name) };
    }

    if (kind === 'section') {
      const tab = safe(() => obj.getParent(), null);
      const ctrls = [];
      forEachCol(safe(() => obj.controls, null), (c) => ctrls.push(safe(() => c.getName(), '')));
      return {
        kind: 'Section',
        primary: name,
        hidden: wasRevealed('section', name),
        rows: [
          ['Name', name, true],
          ['Label', safe(() => obj.getLabel(), '')],
          ['Visible', String(safe(() => obj.getVisible(), ''))],
          ['Tab', safe(() => tab.getName(), ''), true],
          ['Controls', `${ctrls.length}: ${ctrls.join(', ')}`, true],
        ],
      };
    }

    const secs = [];
    forEachCol(safe(() => obj.sections, null), (s) => secs.push(safe(() => s.getName(), '')));
    return {
      kind: 'Tab',
      primary: name,
      hidden: wasRevealed('tab', name),
      rows: [
        ['Name', name, true],
        ['Label', safe(() => obj.getLabel(), '')],
        ['Visible', String(safe(() => obj.getVisible(), ''))],
        ['Display state', safe(() => obj.getDisplayState(), '')],
        ['Sections', `${secs.length}: ${secs.join(', ')}`, true],
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Overlay UI (shadow DOM so the app's CSS can't interfere)
  // ---------------------------------------------------------------------------
  let host = null;
  let root = null;
  let layer = null;

  const CSS_TEXT = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
    .layer { position: fixed; inset: 0; pointer-events: none; }
    .badge {
      position: fixed; pointer-events: auto; cursor: copy;
      font-size: 11px; line-height: 15px; padding: 0 5px; border-radius: 3px;
      color: #fff; white-space: nowrap; box-shadow: 0 1px 3px rgba(0,0,0,.35);
      font-family: Consolas, "Cascadia Mono", monospace; max-width: 340px; overflow: hidden; text-overflow: ellipsis;
      opacity: .92;
    }
    .badge:hover { opacity: 1; z-index: 5; max-width: none; }
    .outline { position: fixed; pointer-events: none; border: 2px dashed ${COLORS.hidden}; border-radius: 3px; background: rgba(245,158,11,.06); }
    .hl { position: fixed; pointer-events: none; border: 2px solid; border-radius: 3px; transition: all .05s; }
    .hl-label {
      position: fixed; pointer-events: none; color: #fff; font-size: 12px; padding: 2px 6px; border-radius: 3px;
      font-family: Consolas, "Cascadia Mono", monospace; white-space: nowrap; box-shadow: 0 1px 4px rgba(0,0,0,.4);
    }
    .banner {
      position: fixed; top: 8px; left: 50%; transform: translateX(-50%); pointer-events: none;
      background: #1f2937; color: #fff; font-size: 12px; padding: 6px 12px; border-radius: 16px;
      box-shadow: 0 2px 8px rgba(0,0,0,.35);
    }
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); pointer-events: none;
      background: #111827; color: #fff; font-size: 13px; padding: 8px 14px; border-radius: 6px;
      box-shadow: 0 4px 14px rgba(0,0,0,.35); animation: fade 2s forwards;
    }
    @keyframes fade { 0%,75% { opacity: 1 } 100% { opacity: 0 } }
    .card, .panel {
      position: fixed; pointer-events: auto; background: #fff; color: #1f2937;
      border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,.25);
      font-size: 12px;
    }
    .card { width: 380px; max-height: 70vh; overflow: auto; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; position: sticky; top: 0; background: #fff; }
    .pill { color: #fff; font-size: 11px; padding: 1px 7px; border-radius: 10px; font-weight: 600; }
    .pill.hidden { background: ${COLORS.hidden}; }
    .title { font-family: Consolas, "Cascadia Mono", monospace; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .btn { border: 1px solid #d1d5db; background: #f9fafb; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px; color: #1f2937; }
    .btn:hover { background: #eef2ff; border-color: #6366f1; }
    .x { border: 0; background: none; cursor: pointer; font-size: 16px; color: #6b7280; padding: 0 4px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 4px 10px; vertical-align: top; border-bottom: 1px solid #f3f4f6; }
    td.k { color: #6b7280; white-space: nowrap; width: 1%; }
    td.v { font-family: Consolas, "Cascadia Mono", monospace; word-break: break-all; }
    td.v.copy { cursor: copy; }
    td.v.copy:hover { background: #eef2ff; }
    .panel { top: 0; right: 0; bottom: 0; width: min(760px, 95vw); border-radius: 0; display: flex; flex-direction: column; }
    .tools { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-bottom: 1px solid #e5e7eb; }
    .tools input[type=search] { flex: 1; padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 12px; }
    .tools label { display: flex; gap: 4px; align-items: center; white-space: nowrap; color: #374151; }
    .list { overflow: auto; flex: 1; }
    .list table td { padding: 3px 8px; }
    .list th { position: sticky; top: 0; background: #f9fafb; text-align: left; padding: 5px 8px; font-weight: 600; border-bottom: 1px solid #e5e7eb; color: #374151; }
    .list td.n { font-family: Consolas, "Cascadia Mono", monospace; cursor: copy; color: #4338ca; }
    .list td.n:hover { text-decoration: underline; }
    .list td.val { font-family: Consolas, "Cascadia Mono", monospace; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .list tr.dirty td { background: #fffbeb; }
    .muted { color: #9ca3af; }
    .tag { font-size: 10px; padding: 0 5px; border-radius: 8px; background: #e5e7eb; color: #374151; margin-left: 4px; }
    .tag.req { background: #fee2e2; color: #991b1b; }
    .tag.rec { background: #dbeafe; color: #1e40af; }
    .go { cursor: pointer; color: #6b7280; font-size: 16px; padding: 0 4px; }
    .go:hover { color: #111827; }
    .count { color: #6b7280; padding: 0 10px 0 0; white-space: nowrap; }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('pafi-overlay');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    root.appendChild(style);
    layer = document.createElement('div');
    layer.className = 'layer';
    root.appendChild(layer);
    document.documentElement.appendChild(host);
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.entries(attrs).forEach(([k, v]) => {
        if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'className') el.className = v;
        else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
      });
    }
    children.flat().forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return el;
  }

  function toast(msg) {
    ensureHost();
    root.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { className: 'toast' }, msg);
    root.appendChild(t);
    setTimeout(() => t.remove(), 2100);
  }

  async function copy(text, label) {
    if (text === null || text === undefined || text === '') return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(String(text));
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    toast(ok ? `Copied ${label ? label + ': ' : ''}${text}` : 'Could not access clipboard');
  }

  // ---------------------------------------------------------------------------
  // Badges + revealed outlines (positioned overlay, refreshed on a timer)
  // ---------------------------------------------------------------------------
  const nodes = new Map(); // key -> element
  let renderTimer = null;
  let rafPending = false;

  function visibleRect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return null;
    return r;
  }

  function badgeText(kind, name, obj) {
    if (kind !== 'control') return name;
    const attr = safe(() => obj.getAttribute && obj.getAttribute(), null);
    const attrName = attr ? safe(() => attr.getName(), '') : '';
    if (attrName) return attrName === name ? attrName : `${attrName} (${name})`;
    const type = safe(() => obj.getControlType(), '');
    return type ? `${type}: ${name}` : name;
  }

  function render() {
    rafPending = false;
    const fc = getFC();
    syncForm(fc);
    if (!fc || (!state.labels && !state.revealActive)) {
      clearRendered();
      return;
    }
    ensureHost();
    const seen = new Set();
    const put = (key, cls, setup, update) => {
      let el = nodes.get(key);
      if (!el) {
        el = h('div', { className: cls });
        setup(el);
        layer.appendChild(el);
        nodes.set(key, el);
      }
      update(el);
      seen.add(key);
    };

    // Dashed outlines around things we revealed.
    if (state.revealActive) {
      state.revealed.forEach(({ kind, name }) => {
        const r = visibleRect(elFor(kind, name));
        if (!r) return;
        put(`o:${kind}:${name}`, 'outline', () => {}, (el) => {
          Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        });
      });
    }

    if (state.labels) {
      const items = [];
      getTabs(fc).forEach((t) => items.push(['tab', safe(() => t.getName(), ''), t]));
      getSections(fc).forEach(({ section }) => items.push(['section', safe(() => section.getName(), ''), section]));
      getControls(fc).forEach((c) => items.push(['control', safe(() => c.getName(), ''), c]));
      items.forEach(([kind, name, obj]) => {
        if (!name) return;
        const r = visibleRect(elFor(kind, name));
        if (!r) return;
        const text = badgeText(kind, name, obj);
        const hidden = wasRevealed(kind, name);
        put(`b:${kind}:${name}`, 'badge', (el) => {
          el.textContent = text;
          el.title = `${kind === 'control' ? 'Field' : kind[0].toUpperCase() + kind.slice(1)}: ${text}${hidden ? ' (hidden on form)' : ''}\nClick to copy`;
          el.style.background = hidden ? COLORS.hidden : COLORS[kind];
          el.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const attr = kind === 'control' ? safe(() => obj.getAttribute && obj.getAttribute(), null) : null;
            copy((attr && safe(() => attr.getName(), '')) || name);
          });
        }, (el) => {
          // tabs: badge under the tab header; sections: top-left; fields: top-left above label
          let top = kind === 'tab' ? r.bottom - 2 : r.top - (kind === 'section' ? 0 : 8);
          top = Math.max(0, top);
          Object.assign(el.style, { left: `${Math.max(0, r.left)}px`, top: `${top}px` });
        });
      });
    }

    for (const [key, el] of nodes) {
      if (!seen.has(key)) {
        el.remove();
        nodes.delete(key);
      }
    }
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(render);
  }

  function clearRendered() {
    nodes.forEach((el) => el.remove());
    nodes.clear();
  }

  function updateRenderLoop() {
    const active = state.labels || state.revealActive;
    if (active && !renderTimer) {
      renderTimer = setInterval(scheduleRender, 500);
      window.addEventListener('scroll', scheduleRender, true);
      window.addEventListener('resize', scheduleRender);
    } else if (!active && renderTimer) {
      clearInterval(renderTimer);
      renderTimer = null;
      window.removeEventListener('scroll', scheduleRender, true);
      window.removeEventListener('resize', scheduleRender);
    }
    scheduleRender();
  }

  // ---------------------------------------------------------------------------
  // God-mode actions
  // ---------------------------------------------------------------------------
  function toggleReveal() {
    const fc = getFC();
    syncForm(fc);
    if (!fc) return { error: 'No model-driven form found on this page.' };

    if (state.revealActive) {
      // Re-hide in reverse order (controls, sections, tabs).
      [...state.revealed].reverse().forEach(({ kind, name }) => {
        const obj = lookup(fc, kind, name);
        safe(() => obj.setVisible(false));
      });
      const n = state.revealed.length;
      state.revealed = [];
      state.revealActive = false;
      updateRenderLoop();
      toast(`Re-hid ${n} item(s)`);
      return { active: false, count: n };
    }

    const changed = [];
    const showIfHidden = (kind, obj) => {
      const name = safe(() => obj.getName(), '');
      if (!name || typeof obj.getVisible !== 'function' || typeof obj.setVisible !== 'function') return;
      if (safe(() => obj.getVisible(), true) === false) {
        try {
          obj.setVisible(true);
          changed.push({ kind, name });
        } catch { /* some control types refuse */ }
      }
    };
    getTabs(fc).forEach((t) => showIfHidden('tab', t));
    getSections(fc).forEach(({ section }) => showIfHidden('section', section));
    getControls(fc).forEach((c) => showIfHidden('control', c));

    state.revealed = changed;
    state.revealActive = true;
    updateRenderLoop();
    const counts = ['tab', 'section', 'control'].map((k) => changed.filter((c) => c.kind === k).length);
    toast(changed.length
      ? `Revealed ${counts[0]} tab(s), ${counts[1]} section(s), ${counts[2]} field(s)`
      : 'Nothing hidden on this form');
    return { active: true, count: changed.length, tabs: counts[0], sections: counts[1], controls: counts[2] };
  }

  function toggleUnlock() {
    const fc = getFC();
    syncForm(fc);
    if (!fc) return { error: 'No model-driven form found on this page.' };
    if (state.unlockActive) {
      state.unlocked.forEach((name) => safe(() => fc.ui.controls.get(name).setDisabled(true)));
      const n = state.unlocked.length;
      state.unlocked = [];
      state.unlockActive = false;
      toast(`Re-locked ${n} field(s)`);
      return { active: false, count: n };
    }
    const changed = [];
    getControls(fc).forEach((c) => {
      if (typeof c.getDisabled !== 'function' || typeof c.setDisabled !== 'function') return;
      if (safe(() => c.getDisabled(), false) === true) {
        try {
          c.setDisabled(false);
          changed.push(c.getName());
        } catch { /* ignore */ }
      }
    });
    state.unlocked = changed;
    state.unlockActive = true;
    toast(changed.length ? `Unlocked ${changed.length} field(s)` : 'No locked fields on this form');
    return { active: true, count: changed.length };
  }

  function toggleOptional() {
    const fc = getFC();
    syncForm(fc);
    if (!fc) return { error: 'No model-driven form found on this page.' };
    if (state.optionalActive) {
      state.optional.forEach(({ name, level }) => safe(() => fc.data.entity.attributes.get(name).setRequiredLevel(level)));
      const n = state.optional.length;
      state.optional = [];
      state.optionalActive = false;
      toast(`Restored requirement on ${n} field(s)`);
      return { active: false, count: n };
    }
    const changed = [];
    forEachCol(fc.data.entity.attributes, (a) => {
      const level = safe(() => a.getRequiredLevel(), 'none');
      if (level && level !== 'none') {
        try {
          a.setRequiredLevel('none');
          changed.push({ name: a.getName(), level });
        } catch { /* ignore */ }
      }
    });
    state.optional = changed;
    state.optionalActive = true;
    toast(changed.length ? `Made ${changed.length} field(s) optional` : 'No required fields on this form');
    return { active: true, count: changed.length };
  }

  function toggleLabels(force) {
    state.labels = typeof force === 'boolean' ? force : !state.labels;
    updateRenderLoop();
    if (!getFC()) {
      state.labels = false;
      updateRenderLoop();
      return { error: 'No model-driven form found on this page.' };
    }
    return { active: state.labels };
  }

  // ---------------------------------------------------------------------------
  // Picker (click-to-inspect)
  // ---------------------------------------------------------------------------
  let hlBox = null;
  let hlLabel = null;
  let banner = null;
  let cursorStyle = null;
  let current = null;

  const inOverlay = (e) => host && e.composedPath().includes(host);

  function drawHighlight(hit) {
    ensureHost();
    if (!hlBox) {
      hlBox = h('div', { className: 'hl' });
      hlLabel = h('div', { className: 'hl-label' });
      root.appendChild(hlBox);
      root.appendChild(hlLabel);
    }
    const r = hit && hit.el ? hit.el.getBoundingClientRect() : null;
    if (!r || r.width < 1) {
      hlBox.style.display = 'none';
      hlLabel.style.display = 'none';
      return;
    }
    const color = COLORS[hit.kind];
    Object.assign(hlBox.style, {
      display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      borderColor: color, background: `${color}1a`,
    });
    const kindLabel = hit.kind === 'control' ? 'Field' : hit.kind[0].toUpperCase() + hit.kind.slice(1);
    hlLabel.textContent = `${kindLabel} · ${badgeText(hit.kind, hit.name, hit.obj)}`;
    const top = r.top > 26 ? r.top - 24 : r.bottom + 4;
    Object.assign(hlLabel.style, { display: 'block', left: `${Math.max(4, r.left)}px`, top: `${top}px`, background: color });
  }

  function onMove(e) {
    if (inOverlay(e)) return;
    const fc = getFC();
    if (!fc) return;
    current = identify(e.target, fc);
    drawHighlight(current);
  }

  function swallow(e) {
    if (inOverlay(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (inOverlay(e)) return;
    swallow(e);
    const fc = getFC();
    const hit = fc ? identify(e.target, fc) : null;
    if (!hit) {
      toast('Not a field, section or tab — keep hovering, or press Esc to cancel');
      return;
    }
    stopPicking();
    const info = describe(hit);
    copy(info.primary, info.kind === 'Field' ? 'logical name' : `${info.kind.toLowerCase()} name`);
    showCard(info, hit.el ? hit.el.getBoundingClientRect() : null);
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      swallow(e);
      stopPicking();
    }
  }

  const POINTER_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'];

  function startPicking() {
    if (!getFC()) return { error: 'No model-driven form found on this page.' };
    closeCard();
    ensureHost();
    state.picking = true;
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    POINTER_EVENTS.forEach((t) => window.addEventListener(t, swallow, true));
    cursorStyle = document.createElement('style');
    cursorStyle.textContent = '* { cursor: crosshair !important; }';
    document.head.appendChild(cursorStyle);
    banner = h('div', { className: 'banner' }, 'Click a field, section or tab to get its logical name · Esc to cancel');
    root.appendChild(banner);
    return { active: true };
  }

  function stopPicking() {
    state.picking = false;
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    POINTER_EVENTS.forEach((t) => window.removeEventListener(t, swallow, true));
    if (cursorStyle) cursorStyle.remove();
    if (banner) banner.remove();
    if (hlBox) hlBox.remove();
    if (hlLabel) hlLabel.remove();
    cursorStyle = banner = hlBox = hlLabel = null;
    current = null;
    return { active: false };
  }

  function togglePicker() {
    return state.picking ? stopPicking() : startPicking();
  }

  // ---------------------------------------------------------------------------
  // Info card
  // ---------------------------------------------------------------------------
  let card = null;
  let cardKeyHandler = null;
  const cardActions = []; // extra header buttons added by src/devtools.js: (info, closeCard) => element | null

  function closeCard() {
    if (card) card.remove();
    card = null;
    if (cardKeyHandler) window.removeEventListener('keydown', cardKeyHandler, true);
    cardKeyHandler = null;
  }

  function showCard(info, rect) {
    closeCard();
    ensureHost();
    const color = COLORS[info.kind === 'Field' ? 'control' : info.kind.toLowerCase()];
    card = h('div', { className: 'card' },
      h('div', { className: 'head' },
        h('span', { className: 'pill', style: { background: color } }, info.kind),
        info.hidden ? h('span', { className: 'pill hidden', title: 'Hidden on the form; shown by "Reveal hidden"' }, 'hidden') : null,
        h('span', { className: 'title', title: info.primary }, info.primary),
        h('button', { className: 'btn', onclick: () => copy(info.primary) }, 'Copy'),
        ...cardActions.map((fn) => safe(() => fn(info, closeCard), null)),
        h('button', { className: 'btn', onclick: () => { closeCard(); startPicking(); } }, 'Pick another'),
        h('button', { className: 'x', title: 'Close (Esc)', onclick: closeCard }, '×'),
      ),
      h('table', null, info.rows.map(([k, v, copyable]) =>
        h('tr', null,
          h('td', { className: 'k' }, k),
          h('td', {
            className: `v${copyable && v ? ' copy' : ''}`,
            title: copyable && v ? 'Click to copy' : null,
            onclick: copyable && v ? () => copy(v, k.toLowerCase()) : null,
          }, v === '' || v === null || v === undefined ? h('span', { className: 'muted' }, '—') : String(v)),
        ),
      )),
    );
    root.appendChild(card);
    const cw = 380;
    const ch = Math.min(card.offsetHeight, innerHeight * 0.7);
    let left = rect ? rect.left : innerWidth / 2 - cw / 2;
    let top = rect ? rect.bottom + 8 : 80;
    if (top + ch > innerHeight - 8) top = rect ? Math.max(8, rect.top - ch - 8) : 8;
    left = Math.min(Math.max(8, left), innerWidth - cw - 8);
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    cardKeyHandler = (e) => { if (e.key === 'Escape') closeCard(); };
    window.addEventListener('keydown', cardKeyHandler, true);
  }

  // ---------------------------------------------------------------------------
  // All-fields panel
  // ---------------------------------------------------------------------------
  let panel = null;

  function flash(kind, name) {
    const fc = getFC();
    const obj = lookup(fc, kind, name);
    const el = elFor(kind, name);
    if (kind === 'control' && obj) {
      const sec = safe(() => obj.getParent(), null);
      const tab = safe(() => sec.getParent(), null);
      if (tab) safe(() => tab.setFocus());
      safe(() => obj.setFocus());
    }
    setTimeout(() => {
      const target = elFor(kind, name) || el;
      if (!target) {
        toast(`${name} is not rendered on the form (hidden or not on this form)`);
        return;
      }
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => {
        const r = visibleRect(target);
        if (!r) return;
        ensureHost();
        const f = h('div', { className: 'hl', style: {
          left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
          borderColor: COLORS[kind], background: `${COLORS[kind]}33`,
        } });
        root.appendChild(f);
        setTimeout(() => f.remove(), 1200);
      }, 350);
    }, 150);
  }

  function collectFields(fc) {
    const rows = [];
    forEachCol(fc.data.entity.attributes, (a) => {
      const ctrls = [];
      forEachCol(safe(() => a.controls, null), (c) => ctrls.push(c));
      const label = ctrls.map((c) => safe(() => c.getLabel(), '')).find(Boolean) || '';
      const visible = ctrls.some((c) => safe(() => c.getVisible(), false));
      rows.push({
        name: safe(() => a.getName(), ''),
        label,
        type: safe(() => a.getAttributeType(), ''),
        value: fmtValue(a),
        required: safe(() => a.getRequiredLevel(), 'none'),
        dirty: !!safe(() => a.getIsDirty(), false),
        controls: ctrls.map((c) => safe(() => c.getName(), '')),
        onForm: ctrls.length > 0,
        visible,
      });
    });
    rows.sort((x, y) => x.name.localeCompare(y.name));
    return rows;
  }

  function closePanel() {
    if (panel) panel.remove();
    panel = null;
  }

  function togglePanel() {
    if (panel) {
      closePanel();
      return { active: false };
    }
    const fc = getFC();
    if (!fc) return { error: 'No model-driven form found on this page.' };
    safe(() => window.__pafi.lib.closeDev && window.__pafi.lib.closeDev());
    ensureHost();
    let rows = collectFields(fc);
    const search = h('input', { type: 'search', placeholder: 'Filter by logical name, label, type or value…' });
    const dirtyOnly = h('input', { type: 'checkbox' });
    const hiddenOnly = h('input', { type: 'checkbox' });
    const count = h('span', { className: 'count' });
    const tbody = h('tbody');

    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const filtered = rows.filter((r) =>
        (!dirtyOnly.checked || r.dirty) &&
        (!hiddenOnly.checked || !r.visible) &&
        (!q || [r.name, r.label, r.type, r.value].some((s) => String(s).toLowerCase().includes(q))));
      count.textContent = `${filtered.length} / ${rows.length}`;
      tbody.replaceChildren(...filtered.map((r) =>
        h('tr', { className: r.dirty ? 'dirty' : '' },
          h('td', { className: 'n', title: 'Click to copy', onclick: () => copy(r.name, 'logical name') }, r.name),
          h('td', null, r.label || h('span', { className: 'muted' }, '—'),
            r.required === 'required' ? h('span', { className: 'tag req' }, 'required') : null,
            r.required === 'recommended' ? h('span', { className: 'tag rec' }, 'recommended') : null,
            r.dirty ? h('span', { className: 'tag' }, 'dirty') : null,
            !r.visible ? h('span', { className: 'tag' }, 'hidden') : null),
          h('td', null, r.type),
          h('td', { className: 'val', title: r.value, onclick: () => copy(r.value, 'value'), style: { cursor: 'copy' } }, r.value),
          h('td', null, r.controls[0]
            ? h('span', { className: 'go', title: 'Scroll to field', onclick: () => flash('control', r.controls[0]) }, '⌖')
            : null),
        )));
    };

    search.addEventListener('input', draw);
    dirtyOnly.addEventListener('change', draw);
    hiddenOnly.addEventListener('change', draw);

    const entity = safe(() => fc.data.entity.getEntityName(), '');
    panel = h('div', { className: 'panel' },
      h('div', { className: 'head' },
        h('span', { className: 'pill', style: { background: COLORS.control } }, 'Fields'),
        h('span', { className: 'title' }, entity),
        h('button', { className: 'btn', title: 'Re-read values from the form', onclick: () => { rows = collectFields(getFC() || fc); draw(); } }, 'Refresh'),
        h('button', { className: 'btn', title: 'Copy all fields as JSON', onclick: () => {
          const obj = {};
          forEachCol((getFC() || fc).data.entity.attributes, (a) => { obj[a.getName()] = safe(() => a.getValue(), null); });
          copy(JSON.stringify(obj, null, 2), 'JSON');
        } }, 'Copy JSON'),
        h('button', { className: 'x', title: 'Close', onclick: closePanel }, '×'),
      ),
      h('div', { className: 'tools' },
        search,
        h('label', null, dirtyOnly, 'Dirty'),
        h('label', null, hiddenOnly, 'Hidden'),
        count,
      ),
      h('div', { className: 'list' },
        h('table', null,
          h('thead', null, h('tr', null,
            h('th', null, 'Logical name'), h('th', null, 'Label'), h('th', null, 'Type'), h('th', null, 'Value'), h('th', null, ''))),
          tbody)),
    );
    root.appendChild(panel);
    draw();
    search.focus();
    return { active: true };
  }

  // ---------------------------------------------------------------------------
  // Record / environment info (for the popup)
  // ---------------------------------------------------------------------------
  async function getInfo() {
    const X = window.Xrm;
    const out = { hasXrm: !!X, env: null, record: null };
    const gc = safe(() => X.Utility.getGlobalContext(), null);
    if (gc) {
      out.env = {
        clientUrl: safe(() => gc.getClientUrl(), ''),
        version: safe(() => gc.getVersion(), ''),
        org: safe(() => gc.organizationSettings.uniqueName, ''),
        orgId: cleanId(safe(() => gc.organizationSettings.organizationId, '')),
        user: safe(() => gc.userSettings.userName, ''),
        userId: cleanId(safe(() => gc.userSettings.userId, '')),
        roles: safe(() => gc.userSettings.roles.get().map((r) => r.name), []),
        app: '',
        appId: '',
        appUniqueName: '',
      };
      try {
        const app = await gc.getCurrentAppProperties();
        out.env.app = app.displayName || '';
        out.env.appId = cleanId(app.appId);
        out.env.appUniqueName = app.uniqueName || '';
      } catch { /* not in an app */ }
    }
    const fc = getFC();
    if (fc) {
      const entity = safe(() => fc.data.entity.getEntityName(), '');
      const id = cleanId(safe(() => fc.data.entity.getId(), ''));
      let entitySet = '';
      try {
        const md = await X.Utility.getEntityMetadata(entity, []);
        entitySet = md.EntitySetName || '';
      } catch { /* ignore */ }
      const clientUrl = out.env ? out.env.clientUrl : location.origin;
      const formItem = safe(() => fc.ui.formSelector.getCurrentItem(), null);
      const formTypes = { 0: 'Undefined', 1: 'Create', 2: 'Update', 3: 'Read Only', 4: 'Disabled', 6: 'Bulk Edit' };
      out.record = {
        entity,
        id,
        entitySet,
        primaryName: safe(() => fc.data.entity.getPrimaryAttributeValue(), ''),
        formName: safe(() => formItem.getLabel(), ''),
        formId: cleanId(safe(() => formItem.getId(), '')),
        formType: formTypes[safe(() => fc.ui.getFormType(), 0)] || '',
        isDirty: !!safe(() => fc.data.entity.getIsDirty(), false),
        recordUrl: id ? `${clientUrl}/main.aspx?${out.env && out.env.appId ? `appid=${out.env.appId}&` : ''}pagetype=entityrecord&etn=${entity}&id=${id}` : '',
        webApiUrl: id && entitySet ? `${clientUrl}/api/data/v9.2/${entitySet}(${id})` : '',
      };
    }
    return out;
  }

  const statusExtras = []; // (out) => void, from src/devtools.js

  function status() {
    const fc = getFC();
    syncForm(fc);
    const out = {
      hasXrm: !!window.Xrm,
      hasForm: !!fc,
      reveal: { active: state.revealActive, count: state.revealed.length },
      unlock: { active: state.unlockActive, count: state.unlocked.length },
      optional: { active: state.optionalActive, count: state.optional.length },
      labels: state.labels,
      picking: state.picking,
      panel: !!panel,
    };
    statusExtras.forEach((fn) => safe(() => fn(out)));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------
  const commands = {
    status,
    info: getInfo,
    reveal: toggleReveal,
    unlock: toggleUnlock,
    optional: toggleOptional,
    labels: toggleLabels,
    picker: togglePicker,
    panel: togglePanel,
  };

  window.__pafi = {
    version: '1.1.0',
    // Shared helpers for src/devtools.js (loaded right after this file).
    lib: {
      safe, cleanId, getFC, forEachCol, getTabs, getSections, getControls, lookup, fmtValue,
      h, ensureHost, getRoot: () => root, toast, copy, flash, closeCard, closePanel: () => closePanel(),
      register: (name, fn) => { commands[name] = fn; },
      addCardAction: (fn) => cardActions.push(fn),
      addStatus: (fn) => statusExtras.push(fn),
    },
    run(cmd, arg) {
      const fn = commands[cmd];
      if (!fn) return { error: `Unknown command: ${cmd}` };
      try {
        return fn(arg);
      } catch (err) {
        return { error: String((err && err.message) || err) };
      }
    },
  };
})();
