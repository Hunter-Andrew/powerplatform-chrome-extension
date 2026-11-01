/*
 * Power Apps Form Inspector — developer panel (page-world script, loaded after main.js).
 *
 * Adds a tabbed "Dev tools" panel with:
 *   - Events:   handlers registered on the form (from the form XML) + a live monitor that logs which fire, with timings
 *   - Logic:    business rules and calculated / rollup / formula columns, and which fields they touch
 *   - Options:  option set values with their integer codes
 *   - Lookups:  lookup values with GUIDs, entity sets and Web API filters
 *   - Process:  business process flow, stages, steps and their GUIDs
 *
 * Everything here is read-only. Web API calls are GETs against the current org with the user's own session.
 */
(() => {
  'use strict';
  const P = window.__pafi;
  if (!P || !P.lib || P.devtoolsLoaded) return;
  P.devtoolsLoaded = true;

  const L = P.lib;
  const { safe, cleanId, getFC, forEachCol, getTabs, getControls, h, copy, toast } = L;

  // ---------------------------------------------------------------------------
  // Web API (read-only)
  // ---------------------------------------------------------------------------
  const clientUrl = () => safe(() => window.Xrm.Utility.getGlobalContext().getClientUrl(), '') || location.origin;
  const apiBase = () => `${clientUrl()}/api/data/v9.2/`;

  async function api(path) {
    const res = await fetch(apiBase() + path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
      },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = await res.json();
        msg = (j.error && j.error.message) || msg;
      } catch { /* not json */ }
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  const FV = '@OData.Community.Display.V1.FormattedValue';
  const label = (l) => safe(() => l.UserLocalizedLabel.Label, '') || safe(() => l.LocalizedLabels[0].Label, '') || '';

  function apiError(err, what, privilege) {
    const denied = err && (err.status === 403 || /privilege|prv/i.test(String(err.message)));
    return h('div', { className: 'err' },
      `Could not load ${what}: ${err && err.message ? err.message : err}`,
      denied && privilege ? h('div', null, `This needs the ${privilege} privilege.`) : null);
  }

  const entitySets = {};
  async function entitySet(logicalName) {
    if (!logicalName) return '';
    if (entitySets[logicalName] !== undefined) return entitySets[logicalName];
    try {
      const md = await window.Xrm.Utility.getEntityMetadata(logicalName, []);
      entitySets[logicalName] = md.EntitySetName || '';
    } catch {
      entitySets[logicalName] = '';
    }
    return entitySets[logicalName];
  }

  const recordUrl = (etn, id) => `${clientUrl()}/main.aspx?pagetype=entityrecord&etn=${encodeURIComponent(etn)}&id=${cleanId(id)}`;
  const openTab = (url) => window.open(url, '_blank', 'noopener');

  const entityName = (fc) => safe(() => fc.data.entity.getEntityName(), '');
  const formId = (fc) => cleanId(safe(() => fc.ui.formSelector.getCurrentItem().getId(), ''));

  /** Map a control id (as used in form XML / business rules) to its attribute logical name. */
  function attrOfControl(fc, id) {
    const c = safe(() => fc.ui.controls.get(id), null);
    const a = c && safe(() => c.getAttribute && c.getAttribute(), null);
    return (a && safe(() => a.getName(), '')) || id;
  }

  // ---------------------------------------------------------------------------
  // XAML helpers (business rules + calculated / rollup definitions)
  // ---------------------------------------------------------------------------
  const ACTION_LABELS = {
    GetEntityProperty: 'reads',
    SetEntityProperty: 'sets value',
    SetDisplayMode: 'lock / unlock',
    SetVisibility: 'show / hide',
    SetFieldRequiredLevel: 'requirement',
    SetMessage: 'error message',
    SetDefaultValue: 'default value',
    Recommendation: 'recommendation',
  };

  /** Returns [{ entity, field, action }] for every field reference in a XAML string. */
  function xamlRefs(xaml) {
    const out = [];
    if (!xaml) return out;
    const tagRe = /<(?:[\w.-]+:)?([A-Za-z]+)\b([^>]*)>/g;
    let m;
    while ((m = tagRe.exec(xaml))) {
      const tag = m[1];
      const attrs = m[2];
      const get = (n) => {
        const r = new RegExp(`\\b${n}="([^"]*)"`).exec(attrs);
        return r ? r[1] : '';
      };
      const field = get('Attribute') || get('ControlId') || get('AttributeName');
      if (!field || /[\s[\]()]/.test(field)) continue;
      out.push({ entity: get('EntityName'), field, action: ACTION_LABELS[tag] || tag });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Events: form XML handlers + live monitor
  // ---------------------------------------------------------------------------
  const events = {
    loaded: null, // { formName, libraries: [{name}], handlers: [...] } | { error }
    loading: null,
    runtime: [], // handlers registered with addOnChange / addOnSave / ... while the monitor was on
  };

  function parseFormXml(xml, fc) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const libraries = [...doc.querySelectorAll('formLibraries > Library')].map((l) => ({
      name: l.getAttribute('name') || '',
      id: cleanId(l.getAttribute('libraryUniqueId') || ''),
    }));
    const handlers = [];
    doc.querySelectorAll('event').forEach((ev) => {
      const evName = ev.getAttribute('name') || '';
      let target = 'form';
      let targetKind = 'form';
      if (ev.getAttribute('attribute')) {
        target = ev.getAttribute('attribute');
        targetKind = 'field';
      } else {
        const ctl = ev.parentElement && ev.parentElement.closest('control');
        const tab = ev.parentElement && ev.parentElement.closest('tab');
        if (ctl) {
          target = attrOfControl(fc, ctl.getAttribute('id') || '');
          targetKind = 'control';
        } else if (tab) {
          target = tab.getAttribute('name') || '';
          targetKind = 'tab';
        }
      }
      ev.querySelectorAll(':scope > Handlers > Handler').forEach((hd) => {
        handlers.push({
          event: evName,
          target,
          targetKind,
          functionName: hd.getAttribute('functionName') || '',
          library: hd.getAttribute('libraryName') || '',
          enabled: hd.getAttribute('enabled') !== 'false',
          passContext: hd.getAttribute('passExecutionContext') === 'true',
          parameters: hd.getAttribute('parameters') || '',
          id: cleanId(hd.getAttribute('handlerUniqueId') || ''),
        });
      });
    });
    const order = { onload: 0, onsave: 1, onchange: 2, tabstatechange: 3 };
    handlers.sort((a, b) => (order[a.event.toLowerCase()] ?? 9) - (order[b.event.toLowerCase()] ?? 9) ||
      a.target.localeCompare(b.target));
    return { libraries, handlers };
  }

  async function loadEvents(force) {
    const fc = getFC();
    if (!fc) throw new Error('No model-driven form found on this page.');
    const key = formId(fc);
    if (!force && events.loaded && events.loaded.key === key) return events.loaded;
    if (!force && events.loading) return events.loading;
    events.loading = (async () => {
      try {
        if (!key) throw new Error('Could not read the current form id.');
        const r = await api(`systemforms(${key})?$select=name,formxml`);
        events.loaded = { key, formName: r.name, ...parseFormXml(r.formxml || '', fc) };
      } catch (error) {
        events.loaded = { key, error };
      } finally {
        events.loading = null;
      }
      return events.loaded;
    })();
    return events.loading;
  }

  const monitor = {
    active: false,
    t0: 0,
    log: [], // { t, kind: 'handler'|'event', name, source, ms, result, error }
    restores: [], // functions that undo our hooks
    listeners: new Set(),
  };

  function logEntry(entry) {
    monitor.log.push({ t: performance.now() - monitor.t0, ...entry });
    if (monitor.log.length > 2000) monitor.log.shift();
    monitor.listeners.forEach((fn) => safe(() => fn()));
  }

  function ctxSource(ctx) {
    if (!ctx || typeof ctx !== 'object' || typeof ctx.getEventSource !== 'function') return '';
    const src = safe(() => ctx.getEventSource(), null);
    let name = safe(() => src.getName(), '');
    if (!name && src && typeof src.getEntityName === 'function') name = safe(() => src.getEntityName(), 'form');
    const args = safe(() => ctx.getEventArgs(), null);
    const saveMode = args && safe(() => args.getSaveMode(), null);
    const depth = safe(() => ctx.getDepth(), null);
    return [name, saveMode != null ? `saveMode ${saveMode}` : '', depth > 1 ? `depth ${depth}` : ''].filter(Boolean).join(' · ');
  }

  /** Wrap fn so each call is logged with its duration (async handlers are timed until they settle). */
  function timed(fn, name, fallbackSource) {
    if (fn.__pafiWrapped) return fn;
    const wrapped = function (...args) {
      const start = performance.now();
      const source = ctxSource(args[0]) || fallbackSource || '';
      const done = (result, error) => logEntry({ kind: 'handler', name, source, ms: performance.now() - start, result, error });
      let r;
      try {
        r = fn.apply(this, args);
      } catch (e) {
        done('threw', String((e && e.message) || e));
        throw e;
      }
      if (r && typeof r.then === 'function') {
        r.then(() => done('resolved'), (e) => done('rejected', String((e && e.message) || e)));
      } else {
        done('ok');
      }
      return r;
    };
    wrapped.__pafiWrapped = true;
    wrapped.__pafiOrig = fn;
    return wrapped;
  }

  /** Same-origin windows where form scripts may live (UCI loads them into a ClientApiFrame iframe). */
  function scriptWindows() {
    const wins = [];
    const visit = (w, depth) => {
      if (depth > 3) return;
      try {
        void w.document; // throws when cross-origin
      } catch {
        return;
      }
      wins.push(w);
      for (let i = 0; i < w.frames.length; i++) visit(w.frames[i], depth + 1);
    };
    visit(window, 0);
    // Prefer the client API frame(s): that is where UCI evaluates form libraries.
    return wins.sort((a, b) => Number(/ClientApi/i.test(safe(() => b.frameElement.id + b.name, ''))) -
      Number(/ClientApi/i.test(safe(() => a.frameElement.id + a.name, ''))));
  }

  function resolveFn(path) {
    const parts = path.split('.').filter(Boolean);
    if (!parts.length) return null;
    for (const w of scriptWindows()) {
      let owner = w;
      for (let i = 0; i < parts.length - 1 && owner; i++) owner = safe(() => owner[parts[i]], null);
      const key = parts[parts.length - 1];
      const fn = owner && safe(() => owner[key], null);
      if (typeof fn === 'function') return { owner, key, fn };
    }
    return null;
  }

  function wrapFormHandlers(loaded) {
    const seen = new Set();
    let wrapped = 0;
    const missing = [];
    (loaded.handlers || []).forEach((hd) => {
      if (!hd.functionName || seen.has(hd.functionName)) return;
      seen.add(hd.functionName);
      const hit = resolveFn(hd.functionName);
      if (!hit) {
        if (hd.enabled) missing.push(hd.functionName);
        return;
      }
      if (hit.fn.__pafiWrapped) return;
      const where = loaded.handlers.filter((x) => x.functionName === hd.functionName).map((x) => `${x.event} ${x.target}`);
      const w = timed(hit.fn, hd.functionName, where.join(', '));
      try {
        hit.owner[hit.key] = w;
        if (hit.owner[hit.key] !== w) return;
        wrapped++;
        monitor.restores.push(() => { if (hit.owner[hit.key] === w) hit.owner[hit.key] = hit.fn; });
      } catch { /* read-only property */ }
    });
    return { wrapped, missing };
  }

  /** Patch obj[addName]/obj[removeName] so handlers registered from now on are timed too. */
  function hookRegistration(obj, addName, removeName, label) {
    if (!obj || typeof obj[addName] !== 'function') return;
    const origAdd = obj[addName];
    const origRemove = typeof obj[removeName] === 'function' ? obj[removeName] : null;
    const map = new Map();
    const add = function (fn, ...rest) {
      if (typeof fn !== 'function' || fn.__pafiMarker) return origAdd.call(this, fn, ...rest);
      const fname = fn.name || '(anonymous)';
      events.runtime.push({ event: addName, target: label, functionName: fname });
      const w = timed(fn, fname, `${addName} ${label}`);
      map.set(fn, w);
      return origAdd.call(this, w, ...rest);
    };
    const remove = function (fn, ...rest) {
      return origRemove.call(this, map.get(fn) || fn, ...rest);
    };
    try {
      obj[addName] = add;
      if (origRemove) obj[removeName] = remove;
      monitor.restores.push(() => {
        if (obj[addName] === add) obj[addName] = origAdd;
        if (origRemove && obj[removeName] === remove) obj[removeName] = origRemove;
      });
    } catch { /* frozen */ }
  }

  /** Add our own (last-in-chain) listeners so every event shows up in the log even if handlers can't be wrapped. */
  function addMarker(obj, addName, removeName, name, sourceFn) {
    if (!obj || typeof obj[addName] !== 'function') return;
    const marker = (ctx) => logEntry({ kind: 'event', name, source: (sourceFn && safe(() => sourceFn(ctx), '')) || ctxSource(ctx) });
    marker.__pafiMarker = true;
    try {
      obj[addName](marker);
      monitor.restores.push(() => safe(() => obj[removeName](marker)));
    } catch { /* ignore */ }
  }

  async function startMonitor() {
    const fc = getFC();
    if (!fc) return { error: 'No model-driven form found on this page.' };
    if (monitor.active) return { active: true };
    monitor.active = true;
    monitor.t0 = performance.now();
    events.runtime = [];
    logEntry({ kind: 'info', name: 'Monitor started' });

    const loaded = await loadEvents();
    let summary = '';
    if (loaded.error) {
      summary = 'Form XML unavailable, so only events and runtime-registered handlers are logged.';
    } else {
      const { wrapped, missing } = wrapFormHandlers(loaded);
      summary = `Watching ${wrapped} form handler function(s)` +
        (missing.length ? `; not found yet: ${missing.join(', ')}` : '');
    }

    const data = fc.data;
    const entity = data.entity;
    forEachCol(entity.attributes, (a) => {
      const n = safe(() => a.getName(), '');
      addMarker(a, 'addOnChange', 'removeOnChange', 'onchange', () => n);
      hookRegistration(a, 'addOnChange', 'removeOnChange', n);
    });
    addMarker(entity, 'addOnSave', 'removeOnSave', 'onsave');
    addMarker(entity, 'addOnPostSave', 'removeOnPostSave', 'onpostsave');
    addMarker(data, 'addOnLoad', 'removeOnLoad', 'data onload');
    hookRegistration(entity, 'addOnSave', 'removeOnSave', 'form');
    hookRegistration(entity, 'addOnPostSave', 'removeOnPostSave', 'form');
    hookRegistration(data, 'addOnLoad', 'removeOnLoad', 'data');
    hookRegistration(fc.ui, 'addOnLoad', 'removeOnLoad', 'form ui');
    getTabs(fc).forEach((t) => {
      const n = safe(() => t.getName(), '');
      addMarker(t, 'addTabStateChange', 'removeTabStateChange', 'tabstatechange', () => n);
      hookRegistration(t, 'addTabStateChange', 'removeTabStateChange', n);
    });
    const proc = data.process;
    if (proc) {
      addMarker(proc, 'addOnStageChange', 'removeOnStageChange', 'bpf stagechange',
        () => safe(() => proc.getActiveStage().getName(), ''));
      addMarker(proc, 'addOnStageSelected', 'removeOnStageSelected', 'bpf stageselected',
        (ctx) => safe(() => ctx.getEventArgs().getStage().getName(), ''));
      addMarker(proc, 'addOnProcessStatusChange', 'removeOnProcessStatusChange', 'bpf statuschange',
        () => safe(() => proc.getStatus(), ''));
      ['addOnStageChange', 'addOnStageSelected', 'addOnProcessStatusChange'].forEach((n) =>
        hookRegistration(proc, n, n.replace(/^add/, 'remove'), 'process'));
    }
    logEntry({ kind: 'info', name: summary });
    toast('Event monitor on');
    return { active: true, summary };
  }

  function stopMonitor() {
    if (!monitor.active) return { active: false };
    [...monitor.restores].reverse().forEach((fn) => safe(fn));
    monitor.restores = [];
    monitor.active = false;
    logEntry({ kind: 'info', name: 'Monitor stopped' });
    toast('Event monitor off');
    return { active: false };
  }

  // ---------------------------------------------------------------------------
  // Logic: business rules + calculated / rollup / formula columns
  // ---------------------------------------------------------------------------
  const logic = { key: null, data: null, loading: null };

  async function loadLogic(force) {
    const fc = getFC();
    if (!fc) throw new Error('No model-driven form found on this page.');
    const etn = entityName(fc);
    if (!force && logic.key === etn && logic.data) return logic.data;
    if (!force && logic.loading) return logic.loading;
    logic.loading = (async () => {
      const out = { rules: null, rulesError: null, columns: null, columnsError: null };
      const rulesP = api(`workflows?$select=name,workflowid,statecode,processtriggerformid,xaml,description,modifiedon` +
        `&$filter=category eq 2 and type eq 1 and primaryentity eq '${etn}'&$orderby=name`)
        .then((r) => {
          out.rules = r.value.map((w) => {
            const refs = xamlRefs(w.xaml).filter((x) => !x.entity || x.entity === etn);
            const fields = {};
            refs.forEach(({ field, action }) => {
              const f = attrOfControl(fc, field);
              (fields[f] = fields[f] || new Set()).add(action);
            });
            return {
              id: w.workflowid,
              name: w.name,
              description: w.description || '',
              active: w.statecode === 1,
              state: w[`statecode${FV}`] || (w.statecode === 1 ? 'Activated' : 'Draft'),
              formId: cleanId(w._processtriggerformid_value || ''),
              fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, [...v]])),
              xaml: w.xaml || '',
            };
          });
        })
        .catch((e) => { out.rulesError = e; });

      const colsP = api(`EntityDefinitions(LogicalName='${etn}')/Attributes?$select=LogicalName,SourceType,AttributeType,DisplayName`)
        .then(async (r) => {
          const all = r.value;
          const names = all.map((a) => ({ name: a.LogicalName, label: label(a.DisplayName) }));
          const derived = all.filter((a) => a.SourceType === 1 || a.SourceType === 2 || a.SourceType === 3);
          const details = await Promise.all(derived.map((a) =>
            api(`EntityDefinitions(LogicalName='${etn}')/Attributes(LogicalName='${a.LogicalName}')`).catch(() => null)));
          out.columns = derived.map((a, i) => {
            const d = details[i] || {};
            const def = d.FormulaDefinition || '';
            let deps;
            let guessed = false;
            if (a.SourceType === 3 || (def && !def.trim().startsWith('<'))) {
              // Power Fx formula: match logical or display names that appear as words in the expression.
              guessed = true;
              deps = names.filter((n) => n.name !== a.LogicalName &&
                [n.name, n.label].some((s) => s && new RegExp(`(^|[^\\w'])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w'])`, 'i').test(def)))
                .map((n) => n.name);
            } else {
              deps = [...new Set(xamlRefs(def)
                .filter((x) => x.action === 'reads' || x.action === 'GetEntityProperty' || x.entity)
                .map((x) => (x.entity && x.entity !== etn ? `${x.entity}.${x.field}` : x.field))
                .filter((x) => x !== a.LogicalName))];
            }
            return {
              name: a.LogicalName,
              label: label(a.DisplayName),
              kind: ({ 1: 'Calculated', 2: 'Rollup', 3: 'Formula' })[a.SourceType],
              type: a.AttributeType,
              definition: def,
              deps,
              guessed,
            };
          }).sort((x, y) => x.name.localeCompare(y.name));
        })
        .catch((e) => { out.columnsError = e; });

      await Promise.all([rulesP, colsP]);
      logic.key = etn;
      logic.data = out;
      logic.loading = null;
      return out;
    })();
    return logic.loading;
  }

  // ---------------------------------------------------------------------------
  // Options: option sets with integer codes
  // ---------------------------------------------------------------------------
  const OPTION_TYPES = ['optionset', 'multiselectoptionset', 'boolean'];
  const optionMeta = { key: null, data: null, loading: null };

  async function loadOptionMetadata() {
    const fc = getFC();
    const etn = entityName(fc);
    if (optionMeta.key === etn && optionMeta.data) return optionMeta.data;
    if (optionMeta.loading) return optionMeta.loading;
    optionMeta.loading = (async () => {
      const casts = ['PicklistAttributeMetadata', 'MultiSelectPicklistAttributeMetadata', 'StateAttributeMetadata',
        'StatusAttributeMetadata', 'BooleanAttributeMetadata'];
      const map = {};
      let error = null;
      await Promise.all(casts.map((cast) =>
        api(`EntityDefinitions(LogicalName='${etn}')/Attributes/Microsoft.Dynamics.CRM.${cast}` +
          `?$select=LogicalName,DisplayName&$expand=OptionSet`)
          .then((r) => r.value.forEach((a) => {
            const os = a.OptionSet || {};
            const opts = os.Options
              ? os.Options.map((o) => ({ value: o.Value, text: label(o.Label), color: o.Color || '', state: o.State }))
              : [os.FalseOption, os.TrueOption].filter(Boolean).map((o) => ({ value: o.Value, text: label(o.Label) }));
            map[a.LogicalName] = {
              label: label(a.DisplayName),
              type: cast.replace('AttributeMetadata', ''),
              optionSet: os.Name || '',
              global: !!os.IsGlobal,
              options: opts,
            };
          }))
          .catch((e) => { error = error || e; })));
      optionMeta.key = etn;
      optionMeta.data = { map, error: Object.keys(map).length ? null : error };
      optionMeta.loading = null;
      return optionMeta.data;
    })();
    return optionMeta.loading;
  }

  function formOptionFields(fc) {
    const rows = [];
    forEachCol(fc.data.entity.attributes, (a) => {
      const type = safe(() => a.getAttributeType(), '');
      if (!OPTION_TYPES.includes(type)) return;
      const ctrls = [];
      forEachCol(safe(() => a.controls, null), (c) => ctrls.push(c));
      const attrOpts = safe(() => a.getOptions(), null);
      const ctlOpts = ctrls.map((c) => safe(() => c.getOptions(), null)).find((o) => Array.isArray(o));
      rows.push({
        name: safe(() => a.getName(), ''),
        label: ctrls.map((c) => safe(() => c.getLabel(), '')).find(Boolean) || '',
        type,
        value: safe(() => a.getValue(), null),
        options: Array.isArray(attrOpts) ? attrOpts.map((o) => ({ value: o.value, text: o.text })) : null,
        controlValues: Array.isArray(ctlOpts) ? ctlOpts.map((o) => o.value) : null,
      });
    });
    return rows.sort((x, y) => x.name.localeCompare(y.name));
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------
  function formLookups(fc) {
    const rows = [];
    forEachCol(fc.data.entity.attributes, (a) => {
      if (safe(() => a.getAttributeType(), '') !== 'lookup') return;
      const ctrls = [];
      forEachCol(safe(() => a.controls, null), (c) => ctrls.push(c));
      const targets = ctrls.map((c) => safe(() => c.getEntityTypes(), null)).find((t) => Array.isArray(t) && t.length) || [];
      const v = safe(() => a.getValue(), null);
      rows.push({
        name: safe(() => a.getName(), ''),
        label: ctrls.map((c) => safe(() => c.getLabel(), '')).find(Boolean) || '',
        targets,
        values: Array.isArray(v) ? v.map((x) => ({ id: cleanId(x.id), name: x.name || '', entityType: x.entityType || '' })) : [],
      });
    });
    return rows.sort((x, y) => x.name.localeCompare(y.name));
  }

  // ---------------------------------------------------------------------------
  // Business process flow
  // ---------------------------------------------------------------------------
  function readProcess(fc) {
    const proc = safe(() => fc.data.process, null);
    if (!proc) return null;
    const active = safe(() => proc.getActiveProcess(), null);
    if (!active) return { none: true, proc };
    const activeStage = safe(() => proc.getActiveStage(), null);
    const selectedStage = safe(() => proc.getSelectedStage(), null);
    const pathIds = new Set();
    forEachCol(safe(() => proc.getActivePath(), null), (s) => pathIds.add(cleanId(safe(() => s.getId(), ''))));
    const stages = [];
    forEachCol(safe(() => active.getStages(), null), (s) => {
      const steps = [];
      forEachCol(safe(() => s.getSteps(), null), (st) => steps.push({
        name: safe(() => st.getName(), ''),
        attribute: safe(() => st.getAttribute(), ''),
        required: !!safe(() => st.isRequired(), false),
      }));
      const id = cleanId(safe(() => s.getId(), ''));
      stages.push({
        id,
        name: safe(() => s.getName(), ''),
        entity: safe(() => s.getEntityName(), ''),
        category: safe(() => s.getCategory().getValue(), ''),
        status: safe(() => s.getStatus(), ''),
        onPath: pathIds.has(id),
        steps,
      });
    });
    return {
      proc,
      id: cleanId(safe(() => active.getId(), '')),
      name: safe(() => active.getName(), ''),
      instanceId: cleanId(safe(() => proc.getInstanceId(), '')),
      instanceName: safe(() => proc.getInstanceName(), ''),
      status: safe(() => proc.getStatus(), ''),
      activeStageId: cleanId(safe(() => activeStage.getId(), '')),
      selectedStageId: cleanId(safe(() => selectedStage.getId(), '')),
      stages,
    };
  }

  async function loadProcessExtras(p) {
    const out = { enabled: null, bpfEntity: '', entitySet: '', traversed: [], error: null };
    await Promise.all([
      new Promise((resolve) => {
        try {
          p.proc.getEnabledProcesses((m) => {
            out.enabled = Object.entries(m || {}).map(([id, name]) => ({ id: cleanId(id), name }));
            resolve();
          });
          setTimeout(resolve, 4000);
        } catch {
          resolve();
        }
      }),
      (async () => {
        try {
          const wf = await api(`workflows(${p.id})?$select=uniquename,name`);
          out.bpfEntity = wf.uniquename || '';
          out.entitySet = await entitySet(out.bpfEntity);
          if (out.entitySet && p.instanceId) {
            const inst = await api(`${out.entitySet}(${p.instanceId})?$select=traversedpath,activestagestartedon`);
            out.traversed = String(inst.traversedpath || '').split(',').map(cleanId).filter(Boolean);
            out.stageStarted = inst.activestagestartedon || '';
          }
        } catch (e) {
          out.error = e;
        }
      })(),
    ]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Panel UI
  // ---------------------------------------------------------------------------
  const CSS = `
    .devpanel .tabs { display: flex; gap: 2px; padding: 0 10px; border-bottom: 1px solid #e5e7eb; background: #f9fafb; }
    .devpanel .tabs button { border: 0; background: none; padding: 8px 10px; cursor: pointer; font-size: 12px; color: #4b5563; border-bottom: 2px solid transparent; }
    .devpanel .tabs button.on { color: #111827; border-bottom-color: #742774; font-weight: 600; }
    .devpanel .body { overflow: auto; flex: 1; padding: 0 0 20px; }
    .devpanel h3 { font-size: 12px; margin: 14px 10px 6px; color: #374151; display: flex; align-items: center; gap: 8px; }
    .devpanel h3 .sp { flex: 1; }
    .devpanel .note { margin: 6px 10px; color: #6b7280; font-size: 11px; }
    .devpanel .err { margin: 8px 10px; padding: 6px 8px; background: #fef2f2; color: #991b1b; border-radius: 4px; }
    .devpanel .box { margin: 8px 10px; border: 1px solid #e5e7eb; border-radius: 6px; }
    .devpanel .box > .bh { display: flex; gap: 6px; align-items: center; padding: 6px 8px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; border-radius: 6px 6px 0 0; flex-wrap: wrap; }
    .devpanel .box > .bb { padding: 6px 8px; }
    .devpanel .mono, .devpanel td.mono { font-family: Consolas, "Cascadia Mono", monospace; }
    .devpanel .cp { cursor: copy; }
    .devpanel .cp:hover { background: #eef2ff; }
    .devpanel table td, .devpanel table th { padding: 3px 8px; font-size: 12px; text-align: left; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
    .devpanel table th { background: #f9fafb; color: #374151; font-weight: 600; position: sticky; top: 0; }
    .devpanel tr.cur td { background: #ecfdf5; }
    .devpanel tr.off td { color: #9ca3af; }
    .devpanel tr.err td { background: #fef2f2; }
    .devpanel tr.ev td { color: #6b7280; }
    .devpanel tr.info td { color: #6b7280; font-style: italic; }
    .devpanel .hit { background: #fef3c7; border-radius: 3px; }
    .devpanel .tag.ok { background: #d1fae5; color: #065f46; }
    .devpanel .tag.warn { background: #fef3c7; color: #92400e; }
    .devpanel .tag.act { background: #ede9fe; color: #5b21b6; }
    .devpanel .lnk { color: #4338ca; cursor: pointer; }
    .devpanel .lnk:hover { text-decoration: underline; }
    .devpanel pre { margin: 6px 0 0; max-height: 200px; overflow: auto; background: #f9fafb; padding: 6px; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
    .devpanel .chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .devpanel .chip { font-family: Consolas, "Cascadia Mono", monospace; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: #f3f4f6; cursor: copy; }
    .devpanel .chip.hit { background: #fde68a; }
    .devpanel .stage { margin: 6px 10px; border: 1px solid #e5e7eb; border-left: 4px solid #d1d5db; border-radius: 4px; }
    .devpanel .stage.onpath { border-left-color: #a78bfa; }
    .devpanel .stage.active { border-left-color: #059669; }
  `;

  const TABS = [
    ['events', 'Events'],
    ['logic', 'Logic'],
    ['options', 'Options'],
    ['lookups', 'Lookups'],
    ['process', 'Process'],
  ];

  let dev = null; // { el, body, tab, field, search }

  function closeDev() {
    if (!dev) return;
    monitor.listeners.delete(dev.onLog);
    dev.el.remove();
    dev = null;
  }
  L.closeDev = closeDev;

  const cp = (text, lbl, cls) => h('span', {
    className: `${cls || 'mono'} cp`, title: 'Click to copy', onclick: () => copy(text, lbl),
  }, String(text));
  const btn = (text, onclick, title) => h('button', { className: 'btn', onclick, title }, text);
  const tag = (text, cls) => h('span', { className: `tag ${cls || ''}` }, text);
  const muted = (t) => h('span', { className: 'muted' }, t || '—');

  function openDev(arg) {
    const opts = typeof arg === 'string' ? { tab: arg } : (arg || {});
    const fc = getFC();
    if (!fc) return { error: 'No model-driven form found on this page.' };
    if (dev && (arg === null || arg === undefined)) {
      closeDev();
      return { active: false };
    }
    if (!dev) {
      safe(() => L.closePanel());
      L.closeCard();
      L.ensureHost();
      const root = L.getRoot();
      if (!root.querySelector('style[data-pafi-dev]')) {
        root.appendChild(h('style', { 'data-pafi-dev': '1' }, CSS));
      }
      const tabsEl = h('div', { className: 'tabs' });
      const body = h('div', { className: 'body' });
      const el = h('div', { className: 'panel devpanel' },
        h('div', { className: 'head' },
          h('span', { className: 'pill', style: { background: '#742774' } }, 'Dev tools'),
          h('span', { className: 'title' }, entityName(fc)),
          btn('Refresh', () => { if (dev) { dev.force = true; show(dev.tab); } }, 'Reload data for this tab'),
          h('button', { className: 'x', title: 'Close', onclick: closeDev }, '×')),
        tabsEl,
        body);
      dev = { el, body, tabsEl, tab: null, field: '', onLog: null };
      TABS.forEach(([id, text]) => tabsEl.appendChild(h('button', { 'data-tab': id, onclick: () => { dev.field = ''; show(id); } }, text)));
      root.appendChild(el);
    }
    dev.field = opts.field || '';
    show(opts.tab || dev.tab || 'events');
    return { active: true, tab: dev.tab };
  }

  function show(tab) {
    if (!dev) return;
    dev.tab = tab;
    dev.tabsEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === tab));
    if (dev.onLog) monitor.listeners.delete(dev.onLog);
    dev.onLog = null;
    const force = !!dev.force;
    dev.force = false;
    dev.body.replaceChildren();
    const renderers = { events: renderEvents, logic: renderLogic, options: renderOptions, lookups: renderLookups, process: renderProcess };
    Promise.resolve(renderers[tab](dev.body, force)).catch((e) => dev && dev.body.appendChild(h('div', { className: 'err' }, String(e && e.message || e))));
  }

  const loading = (body, what) => {
    const n = h('div', { className: 'note' }, `Loading ${what}…`);
    body.appendChild(n);
    return n;
  };

  // --- Events tab ------------------------------------------------------------
  async function renderEvents(body, force) {
    const logBody = h('tbody');
    const monBtn = btn(monitor.active ? 'Stop monitor' : 'Start monitor', async () => {
      if (monitor.active) stopMonitor(); else await startMonitor();
      monBtn.textContent = monitor.active ? 'Stop monitor' : 'Start monitor';
    });
    const drawLog = () => {
      const rows = monitor.log.slice(-500).reverse();
      logBody.replaceChildren(...rows.map((e) => h('tr', { className: e.error ? 'err' : (e.kind === 'event' ? 'ev' : (e.kind === 'info' ? 'info' : '')) },
        h('td', { className: 'mono' }, `+${(e.t / 1000).toFixed(3)}s`),
        h('td', null, e.kind === 'event' ? `⚑ ${e.name}` : (e.kind === 'info' ? e.name : h('span', { className: 'mono' }, e.name))),
        h('td', { className: 'mono' }, e.source || ''),
        h('td', { className: 'mono' }, e.ms !== undefined ? `${e.ms.toFixed(1)} ms` : ''),
        h('td', null, e.error ? `${e.result}: ${e.error}` : (e.result || '')))));
    };
    dev.onLog = drawLog;
    monitor.listeners.add(drawLog);

    body.append(
      h('h3', null, 'Live monitor', h('span', { className: 'sp' }), monBtn,
        btn('Clear', () => { monitor.log = []; drawLog(); }),
        btn('Copy log', () => copy(monitor.log.map((e) => [`+${(e.t / 1000).toFixed(3)}s`, e.kind, e.name, e.source || '',
          e.ms !== undefined ? `${e.ms.toFixed(1)}ms` : '', e.result || '', e.error || ''].join('\t')).join('\n'), 'log'))),
      h('div', { className: 'note' }, 'Logs each handler call with its source and duration (async handlers are timed until their promise settles). ' +
        '⚑ rows are the event itself, recorded after the other handlers in the chain. The form\'s OnLoad usually runs before the ' +
        'monitor can hook in, so open another record in the same app (or use Refresh in the app) with the monitor on to catch it.'),
      h('div', { className: 'box' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Handler / event'), h('th', null, 'Source'), h('th', null, 'Duration'), h('th', null, 'Result'))),
        logBody)));
    drawLog();

    const listHolder = h('div');
    body.appendChild(listHolder);
    const note = loading(listHolder, 'form event handlers');
    const loaded = await loadEvents(force);
    note.remove();
    if (!dev || dev.body !== body) return;
    if (loaded.error) {
      listHolder.appendChild(apiError(loaded.error, 'the form definition', 'Read on System Form (prvReadSystemForm)'));
    } else {
      const libs = loaded.libraries;
      listHolder.append(
        h('h3', null, `Registered handlers · ${loaded.formName || ''}`, h('span', { className: 'sp' }),
          muted(`${loaded.handlers.length} handler(s), ${libs.length} librar${libs.length === 1 ? 'y' : 'ies'}`)),
        loaded.handlers.length
          ? h('div', { className: 'box' }, h('table', null,
            h('thead', null, h('tr', null, h('th', null, 'Event'), h('th', null, 'Target'), h('th', null, 'Function'), h('th', null, 'Library'), h('th', null, ''))),
            h('tbody', null, loaded.handlers.map((hd) => h('tr', { className: hd.enabled ? '' : 'off' },
              h('td', null, hd.event),
              h('td', null, hd.targetKind === 'form' ? muted('form') : cp(hd.target, hd.targetKind)),
              h('td', null, cp(hd.functionName, 'function')),
              h('td', null, h('span', { className: 'mono lnk', title: 'Open web resource', onclick: () => openTab(`${clientUrl()}/WebResources/${hd.library}`) }, hd.library)),
              h('td', null,
                !hd.enabled ? tag('disabled') : null,
                hd.passContext ? tag('context', 'act') : null,
                hd.parameters ? h('span', { className: 'tag', title: hd.parameters }, 'params') : null))))))
          : h('div', { className: 'note' }, 'No custom handlers are registered on this form.'),
        libs.length ? h('h3', null, 'Form libraries') : null,
        libs.length ? h('div', { className: 'box' }, h('div', { className: 'bb chips' }, libs.map((l) =>
          h('span', { className: 'chip', title: 'Open web resource', onclick: () => openTab(`${clientUrl()}/WebResources/${l.name}`) }, l.name)))) : null);
    }
    if (events.runtime.length) {
      listHolder.append(h('h3', null, 'Registered at runtime (while monitoring)'),
        h('div', { className: 'box' }, h('table', null, h('tbody', null, events.runtime.map((r) =>
          h('tr', null, h('td', null, r.event), h('td', { className: 'mono' }, r.target), h('td', { className: 'mono' }, r.functionName)))))));
    }
  }

  // --- Logic tab -------------------------------------------------------------
  function fieldFilter(body, placeholder, onChange) {
    const input = h('input', { type: 'search', placeholder, value: dev.field || '' });
    input.addEventListener('input', () => { dev.field = input.value.trim(); onChange(); });
    body.appendChild(h('div', { className: 'tools' }, input));
    return input;
  }

  async function renderLogic(body, force) {
    const fc = getFC();
    const etn = entityName(fc);
    const thisForm = formId(fc);
    const out = h('div');
    fieldFilter(body, 'Filter by field logical name (e.g. creditlimit)…', () => draw());
    body.appendChild(out);
    const note = loading(out, 'business rules and calculated columns');
    const data = await loadLogic(force);
    note.remove();
    if (!dev || dev.body !== body) return;

    function draw() {
      const q = (dev.field || '').toLowerCase();
      const matchField = (f) => !q || f.toLowerCase().includes(q);
      out.replaceChildren();

      // Business rules
      out.appendChild(h('h3', null, 'Business rules'));
      if (data.rulesError) {
        out.appendChild(apiError(data.rulesError, 'business rules', 'Read on Process (prvReadWorkflow)'));
      } else {
        const rules = data.rules.filter((r) => !q || Object.keys(r.fields).some(matchField));
        if (!rules.length) out.appendChild(h('div', { className: 'note' }, q ? `No business rules touch "${dev.field}".` : `No business rules on ${etn}.`));
        rules.forEach((r) => {
          const scope = !r.formId ? 'Entity / all forms' : (r.formId === thisForm ? 'This form' : 'Another form');
          const pre = h('pre', { hidden: true }, r.xaml);
          out.appendChild(h('div', { className: 'box' },
            h('div', { className: 'bh' },
              h('b', null, r.name),
              tag(r.state, r.active ? 'ok' : 'warn'),
              tag(scope, r.formId && r.formId !== thisForm ? '' : 'act'),
              h('span', { style: { flex: '1' } }),
              btn('Copy ID', () => copy(r.id, 'workflow id')),
              btn('XAML', () => { pre.hidden = !pre.hidden; })),
            h('div', { className: 'bb' },
              r.description ? h('div', { className: 'note', style: { margin: '0 0 6px' } }, r.description) : null,
              h('table', null, h('tbody', null, Object.entries(r.fields).sort().map(([f, acts]) =>
                h('tr', null,
                  h('td', null, h('span', { className: `mono cp${q && matchField(f) ? ' hit' : ''}`, onclick: () => copy(f, 'field') }, f)),
                  h('td', null, acts.map((a) => tag(a, a === 'reads' ? '' : 'act'))))))),
              pre)));
        });
      }

      // Calculated / rollup / formula columns
      out.appendChild(h('h3', null, 'Calculated, rollup and formula columns'));
      if (data.columnsError) {
        out.appendChild(apiError(data.columnsError, 'column metadata', 'read access to table metadata'));
      } else {
        const cols = data.columns.filter((c) => !q || matchField(c.name) || c.deps.some(matchField));
        if (!cols.length) out.appendChild(h('div', { className: 'note' }, q ? `No calculated columns use "${dev.field}".` : `No calculated, rollup or formula columns on ${etn}.`));
        cols.forEach((c) => {
          const pre = h('pre', { hidden: true }, c.definition || '(definition not returned)');
          out.appendChild(h('div', { className: 'box' },
            h('div', { className: 'bh' },
              h('span', { className: `mono cp${q && matchField(c.name) ? ' hit' : ''}`, onclick: () => copy(c.name, 'field') }, h('b', null, c.name)),
              c.label ? muted(c.label) : null,
              tag(c.kind, 'act'), tag(c.type),
              h('span', { style: { flex: '1' } }),
              btn('Definition', () => { pre.hidden = !pre.hidden; })),
            h('div', { className: 'bb' },
              h('div', { className: 'note', style: { margin: '0 0 4px' } }, c.guessed ? 'Uses (matched by name in the formula):' : 'Uses:'),
              c.deps.length ? h('div', { className: 'chips' }, c.deps.map((d) =>
                h('span', { className: `chip${q && matchField(d) ? ' hit' : ''}`, onclick: () => copy(d, 'field') }, d))) : muted('no field references found'),
              pre)));
        });
      }
    }
    draw();
  }

  // --- Options tab -----------------------------------------------------------
  async function renderOptions(body) {
    const fc = getFC();
    const out = h('div');
    const notOnForm = h('input', { type: 'checkbox' });
    const input = fieldFilter(body, 'Filter by field, label or value…', () => draw());
    input.parentElement.appendChild(h('label', null, notOnForm, 'Include fields not on form'));
    notOnForm.addEventListener('change', () => draw());
    body.appendChild(out);
    const formRows = formOptionFields(fc);
    let meta = { map: {}, error: null };
    const metaNote = h('div', { className: 'note' }, 'Loading option set metadata…');
    body.insertBefore(metaNote, out);

    function draw() {
      const q = (dev.field || '').toLowerCase();
      const names = new Set(formRows.map((r) => r.name));
      const rows = formRows.map((r) => ({ ...r, meta: meta.map[r.name], onForm: true }));
      if (notOnForm.checked) {
        Object.entries(meta.map).forEach(([name, m]) => {
          if (!names.has(name)) rows.push({ name, label: m.label, type: m.type, value: null, options: null, controlValues: null, meta: m, onForm: false });
        });
        rows.sort((x, y) => x.name.localeCompare(y.name));
      }
      out.replaceChildren();
      let shown = 0;
      rows.forEach((r) => {
        const options = (r.meta && r.meta.options.length ? r.meta.options : r.options) || [];
        const cur = Array.isArray(r.value) ? r.value : [r.value];
        const hitField = !q || r.name.toLowerCase().includes(q) || (r.label || '').toLowerCase().includes(q);
        const opts = hitField ? options : options.filter((o) => String(o.value).includes(q) || (o.text || '').toLowerCase().includes(q));
        if (!opts.length && !hitField) return;
        shown++;
        const allowed = r.controlValues ? new Set(r.controlValues.map(String)) : null;
        out.appendChild(h('div', { className: 'box' },
          h('div', { className: 'bh' },
            cp(r.name, 'logical name'),
            r.label ? muted(r.label) : null,
            tag((r.meta && r.meta.type) || r.type),
            r.meta && r.meta.optionSet ? h('span', { className: `tag ${r.meta.global ? 'act' : ''}`, title: 'Option set name' }, `${r.meta.global ? 'global' : 'local'}: ${r.meta.optionSet}`) : null,
            r.onForm ? null : tag('not on form', 'warn'),
            h('span', { style: { flex: '1' } }),
            r.onForm ? h('span', { className: 'mono' }, `= ${r.value === null || r.value === undefined ? 'null' : (Array.isArray(r.value) ? `[${r.value.join(', ')}]` : r.value)}`) : null),
          options.length
            ? h('table', null, h('tbody', null, opts.map((o) => h('tr', { className: cur.some((v) => String(v) === String(o.value)) ? 'cur' : '' },
              h('td', { style: { width: '90px' } }, cp(o.value, `${r.name} value`)),
              h('td', null, o.color ? h('span', { style: { display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', background: o.color, marginRight: '6px' } }) : null,
                h('span', { className: 'cp', onclick: () => copy(o.text, 'label') }, o.text || ''),
                allowed && !allowed.has(String(o.value)) ? h('span', { className: 'tag', title: 'Removed from this form\'s control (e.g. by removeOption)' }, 'hidden on form') : null,
                o.state !== undefined && o.state !== null ? h('span', { className: 'tag', title: 'statecode' }, `state ${o.state}`) : null)))))
            : h('div', { className: 'bb muted' }, 'Options not available'),
        ));
      });
      if (!shown) out.appendChild(h('div', { className: 'note' }, 'No option set fields match.'));
    }
    draw();
    meta = await loadOptionMetadata();
    if (!dev || dev.body !== body) return;
    metaNote.replaceWith(meta.error
      ? apiError(meta.error, 'option set metadata (showing what the form provides)', 'read access to table metadata')
      : h('div', { className: 'note' }, 'Click a value or label to copy it. Green rows are the current value.'));
    draw();
  }

  // --- Lookups tab -----------------------------------------------------------
  async function renderLookups(body) {
    const fc = getFC();
    const etn = entityName(fc);
    const id = cleanId(safe(() => fc.data.entity.getId(), ''));
    const rows = formLookups(fc);
    const out = h('div');
    fieldFilter(body, 'Filter by field, name, entity or GUID…', () => draw());
    body.appendChild(out);
    const sets = {};
    const types = new Set([etn, ...rows.flatMap((r) => r.values.map((v) => v.entityType))]);
    await Promise.all([...types].map(async (t) => { sets[t] = await entitySet(t); }));
    if (!dev || dev.body !== body) return;

    function draw() {
      const q = (dev.field || '').toLowerCase();
      out.replaceChildren(
        h('h3', null, 'This record'),
        h('div', { className: 'box' }, h('div', { className: 'bh' },
          h('b', null, etn), id ? cp(id, 'record id') : muted('(new record)'),
          h('span', { style: { flex: '1' } }),
          id && sets[etn] ? btn('Web API', () => openTab(`${apiBase()}${sets[etn]}(${id})`)) : null)),
        h('h3', null, `Lookups on form · ${rows.length}`));
      const filtered = rows.filter((r) => !q || [r.name, r.label, ...r.targets, ...r.values.flatMap((v) => [v.id, v.name, v.entityType])]
        .some((s) => String(s).toLowerCase().includes(q)));
      filtered.forEach((r) => {
        out.appendChild(h('div', { className: 'box' },
          h('div', { className: 'bh' },
            cp(r.name, 'logical name'),
            r.label ? muted(r.label) : null,
            h('span', { style: { flex: '1' } }),
            r.targets.length ? h('span', { className: 'muted', title: 'Target tables' }, `→ ${r.targets.join(', ')}`) : null),
          h('div', { className: 'bb' }, r.values.length ? h('table', null, h('tbody', null, r.values.map((v) => h('tr', null,
            h('td', null, v.name || muted('(no name)'), ' ', muted(v.entityType)),
            h('td', null, cp(v.id, 'GUID')),
            h('td', { style: { whiteSpace: 'nowrap', textAlign: 'right' } },
              btn('Filter', () => copy(`_${r.name}_value eq ${v.id}`, 'Web API filter'), `Copy _${r.name}_value eq <guid>`),
              ' ',
              btn('Open', () => openTab(recordUrl(v.entityType, v.id)), 'Open the record in a new tab'),
              ' ',
              sets[v.entityType] ? btn('Web API', () => openTab(`${apiBase()}${sets[v.entityType]}(${v.id})`)) : null)))))
            : muted('(empty)'))));
      });
      if (!filtered.length) out.appendChild(h('div', { className: 'note' }, 'No lookups match.'));
    }
    draw();
  }

  // --- Process tab -----------------------------------------------------------
  async function renderProcess(body) {
    const fc = getFC();
    const p = readProcess(fc);
    if (!p) {
      body.appendChild(h('div', { className: 'note' }, 'This form has no business process flow API (formContext.data.process).'));
      return;
    }
    if (p.none) {
      body.appendChild(h('div', { className: 'note' }, 'No business process flow is active on this record.'));
      return;
    }
    const stageName = (sid) => (p.stages.find((s) => s.id === sid) || {}).name || sid;
    const extrasHolder = h('div');
    body.append(
      h('h3', null, 'Active process'),
      h('div', { className: 'box' }, h('table', null, h('tbody', null,
        [['Process', p.name, null], ['Process ID', p.id, 'process id'], ['Instance', p.instanceName, null],
          ['Instance ID', p.instanceId, 'instance id'], ['Status', p.status, null],
          ['Active stage', p.activeStageId ? `${stageName(p.activeStageId)}` : '', null],
          ['Active stage ID', p.activeStageId, 'stage id'],
          ['Selected stage ID', p.selectedStageId !== p.activeStageId ? p.selectedStageId : '', 'stage id']]
          .filter(([, v]) => v)
          .map(([k, v, c]) => h('tr', null, h('td', { className: 'muted', style: { width: '130px' } }, k), h('td', null, c ? cp(v, c) : v)))))),
      extrasHolder,
      h('h3', null, `Stages · ${p.stages.length}`));
    p.stages.forEach((s, i) => {
      body.appendChild(h('div', { className: `stage${s.onPath ? ' onpath' : ''}${s.id === p.activeStageId ? ' active' : ''}` },
        h('div', { className: 'bh', style: { display: 'flex', gap: '6px', alignItems: 'center', padding: '6px 8px', flexWrap: 'wrap' } },
          h('b', null, `${i + 1}. ${s.name}`),
          s.id === p.activeStageId ? tag('active', 'ok') : null,
          s.onPath ? null : tag('not on active path'),
          tag(s.entity), s.status ? tag(s.status) : null,
          s.category !== '' && s.category !== null ? h('span', { className: 'tag', title: 'Stage category (stagecategory)' }, `category ${s.category}`) : null,
          h('span', { style: { flex: '1' } }),
          cp(s.id, 'stage id')),
        s.steps.length ? h('table', null, h('tbody', null, s.steps.map((st) => h('tr', null,
          h('td', null, st.name), h('td', null, st.attribute ? cp(st.attribute, 'field') : muted('')),
          h('td', null, st.required ? tag('required', 'warn') : null))))) : null));
    });

    const note = loading(extrasHolder, 'process details');
    const x = await loadProcessExtras(p);
    note.remove();
    if (!dev || dev.body !== body) return;
    const rows = [];
    if (x.bpfEntity) rows.push(['BPF table', cp(x.bpfEntity, 'BPF table')]);
    if (x.traversed.length) {
      rows.push(['Traversed path', h('div', { className: 'chips' }, x.traversed.map((sid) =>
        h('span', { className: 'chip', title: sid, onclick: () => copy(sid, 'stage id') }, stageName(sid))))]);
    }
    if (x.stageStarted) rows.push(['Stage started', String(x.stageStarted)]);
    if (x.enabled && x.enabled.length) {
      rows.push(['Enabled flows', h('div', null, x.enabled.map((e) => h('div', null,
        e.name, ' ', cp(e.id, 'process id'), e.id === p.id ? tag('active', 'ok') : null)))]);
    }
    if (rows.length) {
      extrasHolder.appendChild(h('div', { className: 'box' }, h('table', null, h('tbody', null, rows.map(([k, v]) =>
        h('tr', null, h('td', { className: 'muted', style: { width: '130px' } }, k), h('td', null, v))))),
      x.entitySet && p.instanceId ? h('div', { className: 'bb' }, btn('Open instance in Web API', () => openTab(`${apiBase()}${x.entitySet}(${p.instanceId})`))) : null));
    }
    if (x.error) extrasHolder.appendChild(apiError(x.error, 'the process instance', 'Read on Process and on the BPF table'));
  }

  // ---------------------------------------------------------------------------
  // Wire-up
  // ---------------------------------------------------------------------------
  L.register('dev', openDev);
  L.register('monitor', (on) => {
    const want = typeof on === 'boolean' ? on : !monitor.active;
    return want ? startMonitor() : stopMonitor();
  });
  L.register('monitorLog', () => monitor.log.map((e) => ({ ...e })));
  L.addStatus((out) => {
    out.dev = dev ? dev.tab : null;
    out.monitor = monitor.active;
  });
  L.addCardAction((info) => (info.kind === 'Field'
    ? h('button', { className: 'btn', title: 'Business rules and calculated columns that touch this field',
      onclick: () => openDev({ tab: 'logic', field: info.primary }) }, 'Logic')
    : null));

  // Exposed for tests.
  P._dev = { xamlRefs, parseFormXml };
})();
