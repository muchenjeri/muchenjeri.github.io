// Muchenjeri Journal for the browser: the same journal as the Android app, kept in this
// browser's IndexedDB and synced to the same hidden Google Drive folder.
import { openIdb } from './store.js';
import { LocalJournal } from './local.js';
import { SyncEngine, AuthRequiredError, OfflineError, isDirty } from './engine.js';
import { DriveClient } from './drive.js';
import { GoogleAuth } from './auth.js';
import { md5Blob } from './md5.js';
import { photoTakenAt, insertPhrase, matchEntry, duration } from './util.js';
import { exportJournal } from './archive.js';
import { strip, segments, paragraphs, toggle as toggleFormat } from './markup.js';
import { ICONS } from './icons.js';

// ---------- tiny DOM helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const icon = (name) => h('span', { class: 'ico', 'aria-hidden': 'true', html: `<svg viewBox="0 0 24 24"><path d="${ICONS[name]}"/></svg>` });
const view = () => document.getElementById('view');

const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtShortDay = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDateTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const startOfDayKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

let toastTimer;
function toast(text, action = null, ms = 5000) {
  const t = document.getElementById('toast');
  t.replaceChildren(h('span', {}, text), ...(action ? [h('button', { onclick: () => { t.classList.remove('show'); action.run(); } }, action.label)] : []));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

function dialog(build) {
  return new Promise((resolve) => {
    const d = h('dialog');
    const close = (v) => { d.close(); d.remove(); resolve(v); };
    d.append(...build(close));
    d.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    document.body.append(d);
    d.showModal();
  });
}
const confirmDialog = (title, text, ok, danger = false) => dialog((close) => [
  h('h3', {}, title), h('p', {}, text),
  h('div', { class: 'actions' },
    h('button', { class: 'text-btn', onclick: () => close(false) }, 'Cancel'),
    h('button', { class: `text-btn${danger ? ' danger' : ''}`, onclick: () => close(true) }, ok)),
]);

// ---------- app state ----------
let journal, auth, engine;
const state = { entries: [], atts: [], lastSyncAt: null, lastError: null, lastWarning: null, syncing: false, month: null, selectedDay: dayKey(Date.now()), query: '' };
const counts = (id) => {
  let photos = 0, audio = 0;
  for (const a of state.atts) if (a.entryId === id && a.removedAt == null) a.kind === 'photo' ? photos++ : audio++;
  return { photos, audio };
};
const active = () => state.entries.filter((e) => e.deletedAt == null && e.purgedAt == null).sort((a, b) => b.entryAt - a.entryAt);
const pendingCount = () => state.entries.filter(isDirty).length;

async function reload() {
  [state.entries, state.atts] = await Promise.all([journal.allEntries(), journal.allAttachments()]);
  state.lastSyncAt = (await journal.getMeta('lastSyncAt')) ?? null;
}

// ---------- sync ----------
let syncTimer = null, tokenTimer = null;
function scheduleSync(delay = 8000) {
  clearTimeout(syncTimer);
  renderStatus();
  if (!auth.connected || !auth.hasValidToken) return;
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  clearTimeout(syncTimer);
  if (!auth.connected || !auth.hasValidToken || state.syncing) return renderStatus();
  state.syncing = true;
  renderStatus();
  try {
    const r = await engine.sync();
    if (r.errors.length) state.lastError = r.errors[0];
    else {
      state.lastError = null;
      state.lastWarning = r.warnings[0] ?? null;
      await journal.setMeta('lastSyncAt', Date.now());
    }
  } catch (e) {
    if (!(e instanceof AuthRequiredError) && !(e instanceof OfflineError)) state.lastError = e.message || String(e);
  } finally {
    state.syncing = false;
    await reload();
    renderStatus();
    if (currentRoute.name !== 'entry') render();
  }
}

async function signInAndSync() {
  try {
    await auth.signIn();
    state.lastError = null;
    armTokenTimer();
    await runSync();
  } catch (e) {
    toast(`Couldn't connect: ${e.message}`);
  }
}

function armTokenTimer() {
  clearTimeout(tokenTimer);
  if (auth.hasValidToken) tokenTimer = setTimeout(() => renderStatus(), auth.expiresAt - 60_000 - Date.now() + 1000);
}

function syncLook() {
  const n = pendingCount();
  if (!auth.connected) return { icon: 'cloudOff', label: 'Not backed up', cls: '' };
  if (!auth.hasValidToken) return { icon: 'sync', label: 'Sign in to sync', cls: 'action' };
  if (state.syncing) return { icon: 'sync', label: 'Syncing', cls: '' };
  if (state.lastError) return { icon: 'error', label: 'Sync error', cls: 'error' };
  if (n > 0) return { icon: 'cloudUp', label: 'Waiting to sync', cls: '' };
  return { icon: 'cloudDone', label: 'Synced', cls: '' };
}

function renderStatus() {
  const b = document.getElementById('sync-status');
  const look = syncLook();
  b.className = `status-btn ${look.cls}`;
  b.replaceChildren(icon(look.icon), h('span', {}, look.label));
  b.onclick = () => (look.cls === 'action' ? signInAndSync() : (location.hash = '#/settings'));
  const s = document.getElementById('settings-sync');
  if (s) s.replaceWith(syncSection());
}

// ---------- routing ----------
let currentRoute = { name: 'timeline' };
let lastListHash = '#/'; // where Done/Back in the editor returns to
let leaveView = null;

function parseRoute() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const params = new URLSearchParams(qs ?? '');
  if (parts[0] === 'entry' && parts[1]) return { name: 'entry', id: parts[1], day: params.get('day') };
  if (['calendar', 'search', 'settings', 'trash'].includes(parts[0])) return { name: parts[0] };
  return { name: 'timeline' };
}

async function route() {
  if (leaveView) { await leaveView(); leaveView = null; }
  currentRoute = parseRoute();
  if (currentRoute.name !== 'entry') lastListHash = location.hash || '#/';
  document.body.classList.toggle('editing', currentRoute.name === 'entry');
  for (const a of document.querySelectorAll('#tabs a')) a.classList.toggle('active', a.dataset.tab === currentRoute.name);
  window.scrollTo(0, 0);
  render();
}

function render() {
  const r = currentRoute;
  if (r.name === 'entry') return; // the editor renders itself once (renderEditor)
  const v = view();
  if (r.name === 'timeline') v.replaceChildren(...timelineView());
  if (r.name === 'calendar') v.replaceChildren(...calendarView());
  if (r.name === 'search') searchView(v);
  if (r.name === 'settings') v.replaceChildren(...settingsView());
  if (r.name === 'trash') v.replaceChildren(...trashView());
}

const newEntry = (day) => { location.hash = `#/entry/${crypto.randomUUID()}${day ? `?day=${day}` : ''}`; };
const fab = (day) => h('button', { class: 'fab', title: 'New entry', 'aria-label': 'New entry', onclick: () => newEntry(day) }, icon('edit'));

// ---------- lists ----------
function entryCard(e, { showDate = false, onclick } = {}) {
  const c = counts(e.id);
  const preview = strip(e.body).replace(/\s+/g, ' ').trim().slice(0, 400);
  return h('button', { class: 'card', onclick: onclick ?? (() => { location.hash = `#/entry/${e.id}`; }) },
    h('div', { class: 'meta' },
      h('span', {}, showDate ? `${fmtShortDay(e.entryAt)} · ${fmtTime(e.entryAt)}` : fmtTime(e.entryAt)),
      h('span', { class: 'spacer' }),
      c.photos ? h('span', { class: 'ind', title: `${c.photos} photos` }, icon('photo'), c.photos) : null,
      c.audio ? h('span', { class: 'ind', title: `${c.audio} voice notes` }, icon('mic'), c.audio) : null,
      isDirty(e) ? h('span', { class: 'ind', title: 'Not backed up yet' }, icon('cloudUp')) : null),
    e.title.trim() ? h('h3', {}, e.title) : null,
    preview ? h('p', {}, preview) : null);
}

function grouped(entries) {
  const out = [];
  let last = null;
  for (const e of entries) {
    const k = dayKey(e.entryAt);
    if (k !== last) { out.push(h('div', { class: 'day-header' }, fmtDay(e.entryAt))); last = k; }
    out.push(entryCard(e));
  }
  return out;
}

function timelineView() {
  const list = active();
  if (!list.length) return [h('p', { class: 'empty' }, 'No entries yet. Click the pencil button to write one.'), fab()];
  return [...grouped(list), fab()];
}

function calendarView() {
  const sel = state.selectedDay;
  if (!state.month) state.month = sel.slice(0, 7);
  const [y, m] = state.month.split('-').map(Number);
  const days = new Set(active().map((e) => dayKey(e.entryAt)));
  let firstDow = 1;
  try { firstDow = new Intl.Locale(navigator.language).getWeekInfo?.().firstDay ?? new Intl.Locale(navigator.language).weekInfo?.firstDay ?? 1; } catch { /* default Monday */ }
  const first = new Date(y, m - 1, 1);
  const lead = (first.getDay() - (firstDow % 7) + 7) % 7;
  const len = new Date(y, m, 0).getDate();
  const today = dayKey(Date.now());
  const shift = (delta) => { const d = new Date(y, m - 1 + delta, 1); state.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; render(); };

  const grid = h('div', { class: 'cal-grid' });
  for (let i = 0; i < 7; i++) {
    const d = new Date(2024, 0, 7 + ((firstDow % 7) + i)); // 7 Jan 2024 was a Sunday
    grid.append(h('div', { class: 'dow' }, d.toLocaleDateString(undefined, { weekday: 'narrow' })));
  }
  for (let i = 0; i < lead; i++) grid.append(h('div'));
  for (let d = 1; d <= len; d++) {
    const key = `${state.month}-${String(d).padStart(2, '0')}`;
    grid.append(h('button', {
      class: `cal-day${key === sel ? ' selected' : ''}${key === today ? ' today' : ''}${days.has(key) ? ' has' : ''}`,
      onclick: () => { state.selectedDay = key; render(); },
    }, String(d), h('span', { class: 'dot' })));
  }
  const dayEntries = active().filter((e) => dayKey(e.entryAt) === sel);
  return [
    h('div', { class: 'cal-head' },
      h('button', { class: 'icon-btn', title: 'Previous month', onclick: () => shift(-1) }, icon('chevronLeft')),
      h('input', { type: 'month', value: state.month, 'aria-label': 'Month', onchange: (ev) => { if (ev.target.value) { state.month = ev.target.value; render(); } } }),
      h('button', { class: 'icon-btn', title: 'Next month', onclick: () => shift(1) }, icon('chevronRight'))),
    grid,
    h('div', { class: 'day-header' }, fmtDay(startOfDayKey(sel))),
    ...(dayEntries.length ? dayEntries.map((e) => entryCard(e)) : [h('p', { class: 'empty' }, 'No entries on this day.')]),
    fab(sel !== today ? sel : null),
  ];
}

function searchView(v) {
  let results = v.querySelector('#results');
  if (!results) {
    const input = h('input', { type: 'search', placeholder: 'Search titles and text', value: state.query, 'aria-label': 'Search' });
    input.addEventListener('input', () => { state.query = input.value; fill(); });
    results = h('div', { id: 'results' });
    v.replaceChildren(h('label', { class: 'search-box' }, icon('search'), input), results);
    setTimeout(() => input.focus(), 0);
  }
  fill();
  function fill() {
    const q = state.query.trim();
    if (!q) return results.replaceChildren(h('p', { class: 'empty' }, "Searches every entry's title and text. Works offline."));
    const hits = [];
    for (const e of active()) { const shown = { ...e, body: strip(e.body) }; const r = matchEntry(shown, q); if (r) hits.push([shown, r]); }
    if (!hits.length) return results.replaceChildren(h('p', { class: 'empty' }, `No entries match “${q}”.`));
    results.replaceChildren(h('div', { class: 'meta' }, `${hits.length} ${hits.length === 1 ? 'entry' : 'entries'}`), ...hits.map(([e, ranges]) => searchCard(e, ranges)));
  }
}

function searchCard(e, ranges) {
  // ranges index into `${title}\n${body}`; show a snippet of the body around the first body match.
  const text = `${e.title}\n${e.body}`;
  const bodyStart = e.title.length + 1;
  const first = ranges.filter(([s]) => s >= bodyStart).sort((a, b) => a[0] - b[0])[0];
  const from = first ? Math.max(bodyStart, first[0] - 60) : bodyStart;
  const to = Math.min(text.length, from + 260);
  const p = h('p');
  let pos = from;
  if (from > bodyStart) p.append('…');
  for (const [s, en] of ranges.filter(([s, en]) => s >= from && en <= to).sort((a, b) => a[0] - b[0])) {
    if (s < pos) continue;
    p.append(text.slice(pos, s).replace(/\s+/g, ' '), h('mark', {}, text.slice(s, en)));
    pos = en;
  }
  p.append(text.slice(pos, to).replace(/\s+/g, ' '));
  if (to < text.length) p.append('…');
  const c = counts(e.id);
  return h('button', { class: 'card', onclick: () => { location.hash = `#/entry/${e.id}`; } },
    h('div', { class: 'meta' }, h('span', {}, `${fmtShortDay(e.entryAt)} · ${fmtTime(e.entryAt)}`), h('span', { class: 'spacer' }),
      c.photos ? h('span', { class: 'ind' }, icon('photo'), c.photos) : null, c.audio ? h('span', { class: 'ind' }, icon('mic'), c.audio) : null),
    e.title.trim() ? h('h3', {}, e.title) : null, p);
}

function trashView() {
  const list = state.entries.filter((e) => e.deletedAt != null && e.purgedAt == null).sort((a, b) => b.deletedAt - a.deletedAt);
  const open = async (e) => {
    const choice = await dialog((close) => [
      h('h3', {}, 'Deleted entry'),
      h('p', {}, 'Restore it to your journal, or delete it permanently from this browser, your phone and Google Drive. Permanent deletion can’t be undone.'),
      h('div', { class: 'actions' },
        h('button', { class: 'text-btn danger', onclick: () => close('purge') }, 'Delete permanently'),
        h('button', { class: 'text-btn', onclick: () => close('restore') }, 'Restore')),
    ]);
    if (choice === 'restore') await journal.restore(e.id);
    if (choice === 'purge') await journal.purge(e.id);
  };
  return [
    h('div', { class: 'editor-bar' },
      h('a', { class: 'icon-btn', href: '#/settings', title: 'Back' }, icon('back')),
      h('b', { style: 'flex:1;font-size:1.1rem' }, 'Recently deleted'),
      list.length ? h('button', {
        class: 'text-btn danger',
        onclick: async () => {
          if (await confirmDialog('Delete all permanently?', `${list.length} entries will be removed everywhere. This can’t be undone.`, 'Delete all', true)) {
            for (const e of list) await journal.purge(e.id);
          }
        },
      }, 'Delete all') : null),
    h('p', { class: 'sub' }, 'Deleted entries stay here, and on Drive, until you delete them permanently.'),
    ...(list.length ? list.map((e) => entryCard(e, { showDate: true, onclick: () => open(e) })) : [h('p', { class: 'empty' }, 'Nothing here.')]),
  ];
}

// ---------- settings ----------
function syncSection() {
  const look = syncLook();
  const n = pendingCount();
  return h('div', { class: 'section', id: 'settings-sync' },
    h('h2', {}, 'Sync'),
    h('div', { class: `row meta ${look.cls === 'error' ? 'error-text' : ''}`, style: 'font-size:1rem' }, icon(look.icon),
      h('b', {}, !auth.connected ? 'Not connected — saved in this browser only' : look.label)),
    h('div', { class: 'row' }, 'Last successful sync', h('div', { class: 'sub' }, state.lastSyncAt ? fmtDateTime(state.lastSyncAt) : 'Never')),
    h('div', { class: 'row' }, 'Waiting to back up', h('div', { class: 'sub' },
      n === 0 ? (auth.connected ? 'Nothing — every entry is on Drive' : 'Nothing yet') : `${n} ${n === 1 ? 'entry' : 'entries'}`)),
    state.lastError ? h('div', { class: 'row error-text' }, state.lastError) : null,
    state.lastWarning ? h('div', { class: 'row sub' }, state.lastWarning) : null,
    auth.connected && !auth.hasValidToken
      ? h('button', { class: 'btn', onclick: signInAndSync }, 'Sign in to sync')
      : h('button', { class: 'btn', disabled: !auth.connected || state.syncing, onclick: runSync }, 'Sync now'));
}

function settingsView() {
  const theme = (() => { try { return localStorage.getItem('mj-theme') ?? 'system'; } catch { return 'system'; } })();
  const setTheme = (t) => {
    try { t === 'system' ? localStorage.removeItem('mj-theme') : localStorage.setItem('mj-theme', t); } catch { /* ignore */ }
    if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    render();
  };
  const trashCount = state.entries.filter((e) => e.deletedAt != null && e.purgedAt == null).length;
  return [
    h('div', { class: 'section' },
      h('h2', {}, 'Google Drive'),
      auth.connected
        ? [h('div', { class: 'row' }, 'Connected', h('div', { class: 'sub' }, auth.email ?? 'Google account connected')),
          h('button', {
            class: 'btn outline',
            onclick: async () => {
              if (await confirmDialog('Disconnect Google Drive?', 'Entries stay in this browser and on Drive. New changes won’t be backed up until you connect again.', 'Disconnect')) {
                auth.signOut(); render(); renderStatus();
              }
            },
          }, 'Disconnect')]
        : [h('p', { class: 'sub' }, 'Entries are saved in this browser. Connect the same Google account as on your phone to sync with it and back up to Google Drive.'),
          h('button', { class: 'btn', onclick: signInAndSync }, 'Connect Google Drive')]),
    syncSection(),
    h('div', { class: 'section' },
      h('h2', {}, 'Backup'),
      h('div', { class: 'row link', onclick: doExport }, 'Export journal',
        h('div', { class: 'sub' }, 'Save every entry, photo and voice note as a ZIP file (Markdown + JSON). To import an export, use the phone app.')),
      h('div', { class: 'row link', onclick: () => { location.hash = '#/trash'; } }, 'Recently deleted',
        h('div', { class: 'sub' }, trashCount ? `${trashCount} ${trashCount === 1 ? 'entry' : 'entries'}` : 'Empty'))),
    h('div', { class: 'section' },
      h('h2', {}, 'Appearance'),
      h('div', { class: 'seg' }, ...['system', 'light', 'dark'].map((t) =>
        h('button', { class: theme === t ? 'on' : '', onclick: () => setTheme(t) }, t[0].toUpperCase() + t.slice(1))))),
    h('div', { class: 'section privacy' },
      h('h2', {}, 'This browser'),
      h('p', { id: 'storage-info' }, 'Checking storage…'),
      h('p', {}, 'Tip: in Edge, use the “App available — Install” button in the address bar (or … › Apps › Install this site as an app) to open the journal in its own window.')),
    h('div', { class: 'section privacy' },
      h('h2', {}, 'Privacy'),
      h('p', {}, 'Your journal is stored in this browser on this computer and, once connected, in a hidden app folder in your own Google Drive — the same folder your phone uses. The app can only see that folder, not your other Drive files. There is no server, analytics, advertising or tracking. The web page is served by GitHub Pages, but your journal never goes there.'),
      h('p', {}, 'Dictation in the browser uses its online speech service (Microsoft’s in Edge, Google’s in Chrome); the phone app can dictate on-device instead. Voice notes are recordings only and are never transcribed.'),
      h('p', {}, h('a', { href: '../muchenjeri-journal/privacy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy'))),
  ];
}

async function updateStorageInfo() {
  const el = document.getElementById('storage-info');
  if (!el || !navigator.storage) return;
  const persisted = await navigator.storage.persisted?.();
  const est = await navigator.storage.estimate?.();
  const mb = est ? (est.usage / 1048576).toFixed(1) : '?';
  el.textContent = `Using ${mb} MB. ${persisted ? 'Storage is persistent: the browser won’t clear it to free space.' : 'Storage is not marked persistent yet; installing the app usually fixes this. Your entries are still backed up to Drive.'}`;
}

async function doExport() {
  try {
    toast('Preparing export…', null, 60000);
    const r = await exportJournal(journal);
    const name = `Muchenjeri-Journal-${dayKey(Date.now())}.zip`;
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] });
        const w = await handle.createWritable();
        await w.write(r.blob);
        await w.close();
      } catch (e) {
        if (e.name === 'AbortError') return toast('Export cancelled');
        throw e;
      }
    } else {
      const url = URL.createObjectURL(r.blob);
      h('a', { href: url, download: name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    toast(`Exported ${r.entries} entries and ${r.attachments} attachments.${r.missing ? ` ${r.missing} attachments haven’t downloaded to this browser yet.` : ''}`);
  } catch (e) {
    toast(`Export failed: ${e.message}`);
  }
}

// ---------- editor ----------
async function renderEditor(id, day) {
  const existing = await journal.entry(id);
  let saved = existing ? { title: existing.title, body: existing.body } : null;
  let entry = existing;
  const entryAtIfNew = day ? startOfDayKey(day) + (Date.now() - startOfDayKey(dayKey(Date.now()))) : null;
  const urls = [];
  let saveTimer = null;
  let saving = Promise.resolve();
  let recorder = null, dictation = null;

  const titleEl = h('input', { class: 'title-input', placeholder: 'Title (optional)', value: existing?.title ?? '', 'aria-label': 'Title' });
  const bodyEl = h('textarea', { class: 'body-input', placeholder: 'Write…', 'aria-label': 'Entry text' });
  bodyEl.value = existing?.body ?? '';
  const dateBtn = h('button', { class: 'date', title: 'Change date and time' });
  const banners = h('div');
  const attsEl = h('div');
  const grow = () => { bodyEl.style.height = 'auto'; bodyEl.style.height = `${bodyEl.scrollHeight}px`; };

  const flush = (force = false) => {
    clearTimeout(saveTimer);
    saveTimer = null;
    const t = titleEl.value, b = bodyEl.value;
    if (!saved && !force && !t.trim() && !b.trim()) return saving;
    if (saved && saved.title === t && saved.body === b) return saving;
    saved = { title: t, body: b };
    saving = saving.then(() => journal.saveText(id, t, b, entryAtIfNew)).catch((e) => toast(`Couldn't save: ${e.message}`));
    return saving;
  };
  const schedule = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => flush(), 600); };
  titleEl.addEventListener('input', schedule);
  bodyEl.addEventListener('input', () => { grow(); schedule(); });

  const updateHeader = () => {
    const at = entry?.entryAt ?? entryAtIfNew ?? Date.now();
    const status = !entry ? 'New entry' : !auth.connected ? 'Saved in this browser only' : isDirty(entry) ? 'Saved · waiting to back up' : entry.remoteRev ? 'Backed up to Google Drive' : 'Saved';
    dateBtn.replaceChildren(h('b', {}, `${fmtShortDay(at)} · ${fmtTime(at)}`), h('small', {}, status));
  };

  const renderAttachments = async () => {
    const atts = await journal.activeAttachments(id);
    urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    const photos = atts.filter((a) => a.kind === 'photo');
    const voices = atts.filter((a) => a.kind === 'audio');
    const photoRow = h('div', { class: 'photos' });
    const blobs = await Promise.all(photos.map((a) => journal.getBlob(a.fileName)));
    photos.forEach((a, i) => {
      const blob = blobs[i];
      const displayable = blob && !/heic|heif/i.test(a.mimeType);
      let content;
      if (displayable) { const u = URL.createObjectURL(blob); urls.push(u); content = h('img', { src: u, alt: 'Photo', loading: 'lazy' }); }
      else if (blob) content = h('div', { class: 'placeholder' }, icon('photo'), `${a.mimeType.split('/')[1]?.toUpperCase() ?? 'Photo'} (can’t preview here)`);
      else content = h('div', { class: 'placeholder' }, icon('cloudDown'), 'Downloading from Drive…');
      photoRow.append(h('div', { class: 'thumb', role: 'button', tabindex: '0', title: 'View photo',
        onclick: () => { if (displayable) lightbox(photos, blobs, i); else if (blob) downloadBlob(blob, a.fileName); },
        onkeydown: (ev) => { if (ev.key === 'Enter') ev.currentTarget.click(); } },
      content,
      h('button', { class: 'remove', title: 'Remove photo', 'aria-label': 'Remove photo', onclick: (ev) => { ev.stopPropagation(); removeAtt(a); } }, icon('close'))));
    });
    const voiceEls = await Promise.all(voices.map(async (a) => {
      const blob = await journal.getBlob(a.fileName);
      let player;
      if (blob) { const u = URL.createObjectURL(blob); urls.push(u); player = h('audio', { controls: true, preload: 'metadata', src: u }); }
      else player = h('small', { style: 'flex:1' }, 'Downloading from Drive…');
      return h('div', { class: 'voice' },
        h('span', { class: 'label' }, icon('mic'), 'Voice note'), player,
        h('small', {}, duration(a.durationMs)),
        h('button', { class: 'icon-btn', title: 'Remove voice note', onclick: () => removeAtt(a) }, icon('close')));
    }));
    attsEl.replaceChildren(photos.length ? photoRow : '', ...voiceEls);
  };

  const removeAtt = async (a) => {
    const what = a.kind === 'photo' ? 'photo' : 'voice note';
    if (await confirmDialog(`Remove ${what}?`, `It will be removed from this entry, your phone and Google Drive. Export your journal first if you want to keep a copy.`, 'Remove', true)) {
      await journal.removeAttachment(a.id);
    }
  };

  const ensureSaved = async () => { await flush(true); entry = await journal.entry(id); };

  const addPhotos = async (files) => {
    if (!files.length) return;
    await ensureSaved();
    let taken = null;
    for (const file of files) {
      try {
        const mimeType = file.type || 'image/jpeg';
        const extension = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? mimeType.split('/')[1] ?? 'jpg').toLowerCase().replace('jpeg', 'jpg');
        const t = await photoTakenAt(file);
        if (t != null) taken = taken == null ? t : Math.min(taken, t);
        await journal.addAttachment(id, { blob: file, kind: 'photo', mimeType, extension, md5: await md5Blob(file), takenAt: t });
      } catch (e) {
        toast(`Couldn't add ${file.name}: ${e.message}`);
      }
    }
    entry = await journal.entry(id);
    if (taken != null && entry && Math.abs(taken - entry.entryAt) > 30 * 60000) {
      const ok = await confirmDialog('Use the photo’s date?', `This photo was taken ${fmtDateTime(taken)}. Change this entry’s date to match?`, 'Change date');
      if (ok) await journal.setEntryAt(id, taken);
    }
  };

  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (ev) => { addPhotos([...ev.target.files]); ev.target.value = ''; } });

  // Voice notes
  const recBtnLabel = h('span', {}, 'Voice note');
  const recBtn = h('button', { class: 'tool', onclick: () => (recorder ? stopRecording(true) : startRecording()) }, icon('mic'), recBtnLabel);
  async function startRecording() {
    if (dictation) stopDictation();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { return toast(`Microphone not available: ${e.message}`); }
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => window.MediaRecorder?.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 96000 } : {});
    const chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
    const started = Date.now();
    const timerEl = h('b', {}, '0:00');
    const tick = setInterval(() => { timerEl.textContent = duration(Date.now() - started); }, 250);
    const banner = h('div', { class: 'banner rec' }, h('span', { class: 'dotrec' }), h('span', { class: 'grow' }, 'Recording voice note ', timerEl),
      h('button', { class: 'text-btn', onclick: () => stopRecording(false) }, 'Discard'),
      h('button', { class: 'text-btn', onclick: () => stopRecording(true) }, 'Save'));
    banners.append(banner);
    recorder = { rec, stream, chunks, started, tick, banner, type: (rec.mimeType || type || 'audio/webm').split(';')[0] };
    rec.start(1000);
    recBtnLabel.textContent = 'Stop';
  }
  function stopRecording(keep) {
    const r = recorder;
    if (!r) return Promise.resolve();
    recorder = null;
    clearInterval(r.tick);
    r.banner.remove();
    recBtnLabel.textContent = 'Voice note';
    return new Promise((resolve) => {
      r.rec.onstop = async () => {
        r.stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(r.chunks, { type: r.type });
        if (keep && blob.size > 0) {
          await ensureSaved();
          await journal.addAttachment(id, {
            blob, kind: 'audio', mimeType: r.type, extension: r.type.includes('mp4') ? 'm4a' : 'webm',
            md5: await md5Blob(blob), durationMs: Date.now() - r.started,
          });
        }
        resolve();
      };
      r.rec.stop();
    });
  }

  // Dictation (Web Speech API)
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const dictLabel = h('span', {}, 'Dictate');
  const dictBtn = h('button', { class: 'tool', disabled: !SR, title: SR ? 'Speech becomes text (uses the browser’s online speech service)' : 'This browser has no speech recognition', onclick: () => (dictation ? stopDictation() : startDictation()) }, icon('dictate'), dictLabel);
  function startDictation() {
    if (recorder) stopRecording(true);
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language;
    const partial = h('span', { class: 'partial' }, 'Listening…');
    const banner = h('div', { class: 'banner dictate' }, icon('dictate'), h('span', { class: 'grow' }, 'Dictating — speech becomes text (online speech service)'),
      h('button', { class: 'text-btn', onclick: stopDictation }, 'Stop'), partial);
    banners.append(banner);
    dictation = { rec, banner, active: true };
    dictLabel.textContent = 'Stop';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) {
          const [text, cursor] = insertPhrase(bodyEl.value, bodyEl.selectionStart, bodyEl.selectionEnd, r[0].transcript);
          bodyEl.value = text;
          bodyEl.setSelectionRange(cursor, cursor);
          grow();
          schedule();
        } else interim += r[0].transcript;
      }
      partial.textContent = interim || 'Listening…';
    };
    rec.onerror = (ev) => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      const msg = { 'not-allowed': 'Microphone permission is needed for dictation.', network: 'Dictation needs an internet connection in the browser. You can keep typing or record a voice note.' }[ev.error];
      toast(msg ?? `Dictation stopped (${ev.error}).`);
      stopDictation();
    };
    rec.onend = () => { if (dictation?.rec === rec && dictation.active) { try { rec.start(); } catch { stopDictation(); } } };
    rec.start();
  }
  function stopDictation() {
    const d = dictation;
    if (!d) return;
    dictation = null;
    d.active = false;
    try { d.rec.stop(); } catch { /* already stopped */ }
    d.banner.remove();
    dictLabel.textContent = 'Dictate';
  }

  const done = async () => {
    if (recorder) await stopRecording(true);
    stopDictation();
    await flush();
    location.hash = lastListHash;
  };

  const changeDate = async () => {
    const at = entry?.entryAt ?? entryAtIfNew ?? Date.now();
    const d = new Date(at - new Date(at).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const input = h('input', { type: 'datetime-local', value: d });
    const value = await dialog((close) => [h('h3', {}, 'Date and time'), input,
      h('div', { class: 'actions' }, h('button', { class: 'text-btn', onclick: () => close(null) }, 'Cancel'),
        h('button', { class: 'text-btn', onclick: () => close(input.value) }, 'Save'))]);
    if (!value) return;
    await ensureSaved();
    await journal.setEntryAt(id, new Date(value).getTime());
  };

  const menuWrap = h('div', { style: 'position:relative' });
  const toggleMenu = () => {
    const open = menuWrap.querySelector('.menu');
    if (open) return open.remove();
    const menu = h('div', { class: 'menu' },
      h('button', { onclick: () => { menu.remove(); changeDate(); } }, icon('event'), 'Change date and time'),
      h('button', {
        onclick: async () => {
          menu.remove();
          clearTimeout(saveTimer);
          if (saved || titleEl.value.trim() || bodyEl.value.trim()) {
            await flush(true);
            await journal.moveToTrash(id);
            toast('Moved to Recently deleted', { label: 'Undo', run: () => journal.restore(id) });
          }
          location.hash = lastListHash;
        },
      }, icon('delete'), 'Move to Recently deleted'));
    menuWrap.append(menu);
    setTimeout(() => document.addEventListener('click', function off(ev) { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', off); } }), 0);
  };
  menuWrap.append(h('button', { class: 'icon-btn', title: 'More', 'aria-label': 'More', onclick: toggleMenu }, icon('more')));

  const onKey = (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); done(); }
    if (ev.key === 'Escape' && !document.querySelector('dialog[open], .lightbox')) done();
  };
  document.addEventListener('keydown', onKey);

  // Changes from sync (or another tab): refresh the text only if you haven't typed since the last save.
  const offChange = journal.onChange(async () => {
    entry = await journal.entry(id);
    updateHeader();
    renderAttachments();
    if (entry && saveTimer == null && saved && titleEl.value === saved.title && bodyEl.value === saved.body &&
        (entry.title !== saved.title || entry.body !== saved.body)) {
      saved = { title: entry.title, body: entry.body };
      titleEl.value = entry.title;
      bodyEl.value = entry.body;
      grow();
    }
    readBtn.hidden = reading || !entry;
    if (reading) renderReading();
  });

  // Hidden formatting: Ctrl+B / Ctrl+I wrap the selection in **bold** / *italic*.
  bodyEl.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
    const marker = { b: '**', i: '*' }[ev.key.toLowerCase()];
    if (!marker) return;
    ev.preventDefault();
    const old = bodyEl.value;
    const r = toggleFormat(old, bodyEl.selectionStart, bodyEl.selectionEnd, marker);
    // Replace only the changed region with insertText so Ctrl+Z can undo it.
    let a = 0;
    while (a < old.length && a < r.text.length && old[a] === r.text[a]) a++;
    let b = 0;
    while (b < old.length - a && b < r.text.length - a && old[old.length - 1 - b] === r.text[r.text.length - 1 - b]) b++;
    bodyEl.setSelectionRange(a, old.length - b);
    if (!document.execCommand('insertText', false, r.text.slice(a, r.text.length - b))) {
      bodyEl.value = r.text;
      bodyEl.dispatchEvent(new Event('input'));
    }
    bodyEl.setSelectionRange(r.selStart, r.selEnd);
  });

  // Reading mode: the entry laid out like a book page; nothing to type into.
  let reading = !!existing;
  const readingHead = h('header', { class: 'reading-head' });
  const readingBody = h('article', { class: 'reading' });
  const formatted = (text) => segments(text).map((s) =>
    s.bold && s.italic ? h('strong', {}, h('em', {}, s.text)) : s.bold ? h('strong', {}, s.text) : s.italic ? h('em', {}, s.text) : s.text);
  function renderReading() {
    const at = entry?.entryAt ?? entryAtIfNew ?? Date.now();
    const status = !entry ? '' : !auth.connected ? 'Saved in this browser only' : isDirty(entry) ? 'Saved · waiting to back up' : entry.remoteRev ? 'Backed up to Google Drive' : 'Saved';
    readingHead.replaceChildren(...[
      h('div', { class: 'reading-date' }, `${fmtDay(at)} · ${fmtTime(at)}`),
      h('div', { class: 'reading-status' }, status),
      titleEl.value.trim() ? h('h1', { class: 'reading-title' }, titleEl.value) : null].filter(Boolean));
    const paras = paragraphs(bodyEl.value);
    readingBody.replaceChildren(...(paras.length ? paras.map((p) => {
      if (p.sceneBreak) return h('div', { class: 'scene-break', 'aria-hidden': 'true' }, '⁂');
      if (p.heading) return h(`h${p.heading + 1}`, { class: `reading-h${p.spaceBefore ? ' gap' : ''}` }, ...formatted(p.text));
      return h('p', { class: [p.indent ? 'indent' : '', p.spaceBefore ? 'gap' : ''].join(' ').trim() || null }, ...formatted(p.text));
    }) : [h('p', { class: 'empty' }, 'Nothing written yet. Click the pencil to write.')]));
  }

  const editBtn = h('button', { class: 'icon-btn done-btn', title: 'Edit (E)', 'aria-label': 'Edit', onclick: () => setMode(false) }, icon('edit'));
  const readBtn = h('button', { class: 'icon-btn', title: 'Reading mode', 'aria-label': 'Reading mode', onclick: () => setMode(true) }, icon('book'));
  const doneBtn = h('button', { class: 'icon-btn done-btn', title: 'Done (Ctrl+Enter)', 'aria-label': 'Done', onclick: done }, icon('check'));
  const bar = h('div', { class: 'editor-bar' },
    h('button', { class: 'icon-btn', title: 'Back', 'aria-label': 'Back', onclick: done }, icon('back')),
    dateBtn, h('span', { class: 'bar-spacer' }), editBtn, readBtn, doneBtn, menuWrap);
  const tools = h('div', { class: 'editor-tools' },
    h('button', { class: 'tool', onclick: () => fileInput.click() }, icon('photo'), 'Photo'),
    recBtn, dictBtn, fileInput,
    h('span', { class: 'kbd-hint' }, 'Saved automatically · Ctrl+B bold · Ctrl+I italic · Ctrl+Enter when done'));

  async function setMode(toReading) {
    if (toReading) {
      if (recorder) await stopRecording(true);
      stopDictation();
      await flush();
      entry = await journal.entry(id);
    }
    reading = toReading;
    document.body.classList.toggle('reading-mode', reading);
    dateBtn.hidden = reading;
    editBtn.hidden = !reading;
    readBtn.hidden = reading || !entry;
    doneBtn.hidden = reading;
    if (reading) {
      renderReading();
      view().replaceChildren(bar, banners, readingHead, attsEl, readingBody);
    } else {
      view().replaceChildren(bar, banners, titleEl, attsEl, bodyEl, tools);
      setTimeout(() => { grow(); bodyEl.focus(); bodyEl.setSelectionRange(bodyEl.value.length, bodyEl.value.length); }, 0);
    }
  }
  const onReadKey = (ev) => {
    if (reading && ev.key.toLowerCase() === 'e' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !document.querySelector('dialog[open], .lightbox')) {
      ev.preventDefault();
      setMode(false);
    }
  };
  document.addEventListener('keydown', onReadKey);

  dateBtn.onclick = changeDate;
  updateHeader();
  renderAttachments();
  await setMode(reading);

  editorFlush = () => flush();
  leaveView = async () => {
    if (recorder) await stopRecording(true);
    stopDictation();
    await flush();
    offChange();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('keydown', onReadKey);
    document.body.classList.remove('reading-mode');
    urls.forEach((u) => URL.revokeObjectURL(u));
    editorFlush = null;
  };
}
let editorFlush = null;

function downloadBlob(blob, name) {
  const u = URL.createObjectURL(blob);
  h('a', { href: u, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}

function lightbox(photos, blobs, start) {
  const items = photos.map((a, i) => ({ a, blob: blobs[i] })).filter((x) => x.blob && !/heic|heif/i.test(x.a.mimeType));
  let i = Math.max(0, items.findIndex((x) => x.a.id === photos[start].id));
  const img = h('img', { alt: 'Photo' });
  const count = h('span', { class: 'lb-count' });
  let url = null;
  const show = () => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(items[i].blob);
    img.src = url;
    box.classList.remove('zoomed');
    count.textContent = items.length > 1 ? `${i + 1} / ${items.length}` : '';
  };
  const close = () => { box.remove(); URL.revokeObjectURL(url); document.removeEventListener('keydown', key); };
  const step = (d) => { i = (i + d + items.length) % items.length; show(); };
  const key = (ev) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    if (ev.key === 'ArrowRight') step(1);
    if (ev.key === 'ArrowLeft') step(-1);
  };
  const box = h('div', { class: 'lightbox', onclick: (ev) => { if (ev.target === box) close(); } }, img, count,
    h('button', { class: 'icon-btn lb-btn lb-close', title: 'Close', onclick: close }, icon('close')),
    items.length > 1 ? h('button', { class: 'icon-btn lb-btn lb-prev', title: 'Previous', onclick: () => step(-1) }, icon('chevronLeft')) : null,
    items.length > 1 ? h('button', { class: 'icon-btn lb-btn lb-next', title: 'Next', onclick: () => step(1) }, icon('chevronRight')) : null);
  img.onclick = () => box.classList.toggle('zoomed');
  document.addEventListener('keydown', key);
  document.body.append(box);
  show();
}

// ---------- boot ----------
async function boot() {
  for (const el of document.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));
  journal = new LocalJournal(await openIdb());
  auth = new GoogleAuth();
  engine = new SyncEngine(journal, new DriveClient(() => auth.getToken(), (t) => auth.invalidate(t)));
  auth.onChange(() => { renderStatus(); armTokenTimer(); });

  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('muchenjeri-journal') : null;
  let refreshQueued = false;
  const refresh = () => {
    if (refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(async () => {
      refreshQueued = false;
      await reload();
      renderStatus();
      if (currentRoute.name !== 'entry' && currentRoute.name !== 'search') render();
      if (currentRoute.name === 'search') render();
    });
  };
  journal.onChange((isLocal) => {
    refresh();
    if (isLocal) { scheduleSync(); channel?.postMessage('changed'); }
  });
  if (channel) channel.onmessage = () => refresh();

  window.addEventListener('hashchange', async () => {
    await route();
    if (currentRoute.name === 'entry') await renderEditor(currentRoute.id, currentRoute.day);
    if (currentRoute.name === 'settings') updateStorageInfo();
  });
  window.addEventListener('online', () => scheduleSync(1000));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') editorFlush?.();
    else scheduleSync(1000);
  });
  window.addEventListener('pagehide', () => editorFlush?.());
  setInterval(() => scheduleSync(0), 5 * 60 * 1000);

  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  await reload();
  armTokenTimer();
  await route();
  if (currentRoute.name === 'entry') await renderEditor(currentRoute.id, currentRoute.day);
  if (currentRoute.name === 'settings') updateStorageInfo();
  renderStatus();
  scheduleSync(500);
}

boot().catch((e) => {
  view().replaceChildren(h('p', { class: 'empty error-text' }, `The journal couldn't start: ${e.message}`));
  console.error(e);
});
