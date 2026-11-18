// The command center page. One module, no build step: state, a few region renderers, and
// one delegated handler per event type. The server is the only source of truth; this file
// draws what it says and posts decisions back.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- icons: one authored set, 24 grid, 1.75 stroke ----------

const ICON = {
  live: '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><path d="M6.6 6.6a7.6 7.6 0 0 0 0 10.8M17.4 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  history: '<circle cx="12" cy="12" r="8.2"/><path d="M12 7.6V12l3 2"/>',
  outcomes: '<path d="M4 6.6l1.7 1.7L9 5M4 13.1l1.7 1.7L9 11.5M12.5 7H20M12.5 13.5H20M4.5 19.5H20"/>',
  settings: '<path d="M4 7h8.5M17.5 7H20M4 17h2.5M11.5 17H20"/><circle cx="15" cy="7" r="2.3"/><circle cx="9" cy="17" r="2.3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  more: '<circle cx="5.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  agent: '<path d="M13 3.5L5.5 13.5h5.7L10.5 20.5l8-10.5h-5.6z"/>',
  note: '<path d="M7 4h10v16l-5-3.7L7 20z"/>',
  human: '<circle cx="12" cy="8.2" r="3.4"/><path d="M5.2 20c.6-3.7 3.3-5.8 6.8-5.8s6.200 2.100 6.800 5.800"/>',
  undo: '<path d="M8 6L4 10l4 4"/><path d="M4 10h10a5.500 5.500 0 0 1 0 11h-3"/>',
  retry: '<path d="M19.5 12a7.500 7.500 0 1 1-2.200-5.300"/><path d="M19.500 4.500v4h-4"/>',
  trash: '<path d="M5 7h14M10 7V4.500h4V7M7 7l.800 12.500h8.400L17 7"/>',
  edit: '<path d="M5 19l.8-3.600L16.500 4.700a1.800 1.800 0 0 1 2.600 0l.2.200a1.800 1.800 0 0 1 0 2.600L8.600 18.200z"/>',
  quote: '<path d="M5 5v8h11M12.500 9.500L16 13l-3.500 3.500"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  target: '<circle cx="12" cy="12" r="7.500"/><circle cx="12" cy="12" r="2.200" fill="currentColor" stroke="none"/>',
  send: '<path d="M4.500 12L20 5l-6 15.500-2.600-6.300z"/>',
  stop: '<rect x="6.500" y="6.500" width="11" height="11" rx="2"/>',
  play: '<path d="M8 5.500v13l10.500-6.500z"/>',
  mail: '<rect x="3.500" y="5.500" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ''}</svg>`;

// ---------- state ----------

const PREF_DEFAULTS = { theme: 'dark', density: 'comfortable', chime: true, mood: true, expandSettled: false };
const prefs = { ...PREF_DEFAULTS, ...JSON.parse(localStorage.getItem('callpilot.prefs') || '{}') };
function setPref(key, value) {
  prefs[key] = value;
  localStorage.setItem('callpilot.prefs', JSON.stringify(prefs));
  applyPrefs();
}
function applyPrefs() {
  const root = document.documentElement;
  if (prefs.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  root.dataset.density = prefs.density;
}

const freshUi = () => ({
  topic: null, filter: 'all', find: '', speaker: 'all', cue: null, editing: null, tab: 'focus', chat: null,
  topicOrder: [], open: new Set(), toggled: new Set(), follow: true, mode: 'task', drafts: {}, lastCue: null,
});

const S = {
  live: null, // the server's current call: on air, or the one that just ended
  past: null, // a call opened from history
  pipeline: {},
  settings: {},
  health: null,
  calls: null,
  outcomes: null,
  route: { view: 'live' },
  ui: freshUi(),
  history: { q: '', filter: 'all', results: null },
  ledger: { hideDone: false },
  unseen: new Set(),
  connected: true,
};

const KIND = {
  agent: { label: 'Agent task', go: 'Start agent task', icon: 'agent' },
  note: { label: 'Decision', go: 'Keep on record', icon: 'note' },
  human: { label: 'Your to-do', go: 'Keep as my to-do', icon: 'human' },
};
const STATUS = {
  pending: 'Needs you', sending: 'Sending', queued: 'Queued', running: 'Working', done: 'Done',
  failed: 'Failed', skipped: 'Skipped', kept: 'Kept', superseded: 'Replaced',
};
const WORKING = ['sending', 'queued', 'running'];

// Color describes the user's next step, not the item category.
function meaning(x) {
 if (x.status === 'failed') return {tone:'problem', label:'Failed', icon:'retry'};
 if (x.status === 'pending') return {tone:'attention', label:'Needs you', icon:'target'};
 if (WORKING.includes(x.status)) return {tone:'progress', label:STATUS[x.status], icon:'agent'};
 if (x.status === 'kept' && x.kind === 'human' && !x.doneAt) return {tone:'attention',label:'To do',icon:'human'};
 if (x.status === 'done' || (x.status === 'kept' && x.doneAt)) return {tone:'success',label:'Done',icon:'check'};
 if (x.status === 'kept') return {tone:'success',label:x.bookmark ? 'Bookmarked' : 'Recorded',icon:x.bookmark ? 'note' : 'check'};
 return {tone:'neutral',label:STATUS[x.status] || 'Unknown',icon:x.status === 'superseded' ? 'undo' : 'x'};
}
function stateLabel(state) {
 return `<span class="pill semantic" data-tone="${state.tone}">${icon(state.icon)}<span>${esc(state.label)}</span></span>`;
}
function colorKey() {
 return `<details class="color-key"><summary>What the colors mean</summary><div><span data-tone="attention">${icon('target')}Orange · needs you</span><span data-tone="progress">${icon('agent')}Blue · in progress</span><span data-tone="success">${icon('check')}Green · recorded or done</span><span data-tone="problem">${icon('retry')}Red · needs repair</span><span data-tone="neutral">${icon('x')}Gray · inactive or informational</span></div></details>`;
}
function topicResult(c, topic) {
 const items = c.checkpoints.filter(x => x.islandId === topic.id && x.status !== 'superseded');
 const active = items.filter(x => !['skipped','superseded'].includes(x.status));
 const ranked = ['problem','attention','progress','success'];
 const tone = ranked.find(t => active.some(x => meaning(x).tone === t)) || 'neutral';
 const states = {problem:['Needs repair','retry'],attention:['Needs you','target'],progress:['In progress','agent'],success:['Recorded','check'],neutral:[topic.status === 'open' ? 'Open discussion' : 'Discussed','note']};
 let [label,ic] = states[tone];
 if (tone === 'attention' && !active.some(x => x.status === 'pending')) { label='To do'; ic='human'; }
 if (tone === 'success' && active.length && active.every(x => meaning(x).label === 'Done')) { label='Done'; ic='check'; }
 const counts = [['agent','agent task'],['note','decision'],['human','to-do']].map(([kind,label]) => {const n=active.filter(x=>x.kind===kind).length;return n ? plural(n,label) : '';}).filter(Boolean).join(' · ');
 return {items,tone,label,icon:ic,counts:counts || (items.length ? 'Decisions skipped' : 'No actions recorded')};
}


/** The call on screen: the live desk's, or one opened from history. */
function cur() {
  if (S.route.view === 'live') return S.live && !S.live.endedAt ? S.live : null;
  if (S.route.view === 'call') return S.live?.id === S.route.id ? S.live : S.past?.id === S.route.id ? S.past : null;
  return null;
}
const onAir = (c = cur()) => Boolean(c && !c.endedAt && c === S.live);
const endOf = (c) => {
  if (c.endedAt) return c.endedAt;
  if (c === S.live) return Date.now();
  const last = c.segments[c.segments.length - 1];
  return last ? last.t + (last.dur || 0) : c.startedAt;
};

// ---------- formatting ----------

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0');
};
const rel = (c, t) => clock(t - c.startedAt);
const span = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return Math.max(1, Math.round(ms / 1000)) + ' s';
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60 ? (m % 60) + ' min' : '');
};
const hm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayKey = (t) => new Date(t).toDateString();
function dayLabel(t) {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
const dateShort = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Escaped text with every search term wrapped in <mark>, accents ignored. */
function marked(text, query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return esc(text);
  const folded = fold(text);
  if (folded.length !== text.length) return esc(text); // combining marks would shift offsets
  const hits = [];
  for (const term of terms) {
    let at = folded.indexOf(term);
    while (at >= 0) {
      hits.push([at, at + term.length]);
      at = folded.indexOf(term, at + term.length);
    }
  }
  if (!hits.length) return esc(text);
  hits.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of hits) {
    if (a < pos) continue;
    out += esc(text.slice(pos, a)) + '<mark>' + esc(text.slice(a, b)) + '</mark>';
    pos = b;
  }
  return out + esc(text.slice(pos));
}

// ---------- server ----------

async function api(path, body, method) {
  const res = await fetch(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Request failed (' + res.status + ')');
  return j;
}
const callApi = (sub, body) => api(`/api/calls/${cur().id}${sub}`, body ?? {});

function toast(message, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button class="link">${esc(action.label)}</button>` : ''}`;
  if (action) {
    el.querySelector('button').addEventListener('click', () => {
      el.remove();
      action.run();
    });
  }
  $('#toasts').append(el);
  setTimeout(() => el.remove(), action ? 6000 : 3200);
}
const fail = (e) => toast(e.message || String(e));

function chime() {
  if (!prefs.chime) return;
  try {
    const ctx = new AudioContext();
    for (const [freq, at] of [[660, 0], [990, 0.09]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + at);
      o.stop(ctx.currentTime + at + 0.32);
    }
  } catch {}
}

let listTimer = null;
function refreshLists(now) {
  clearTimeout(listTimer);
  listTimer = setTimeout(async () => {
    S.calls = await api('/api/calls').catch(() => S.calls || []);
    renderNav();
    if (S.route.view === 'history' && !S.history.q) renderHistory();
    if (S.route.view === 'live' && (!S.live || S.live.endedAt)) renderStandby();
    if (S.route.view === 'outcomes') loadOutcomes();
  }, now ? 0 : 700);
}
async function loadOutcomes() {
  S.outcomes = await api('/api/outcomes').catch(() => S.outcomes || []);
  if (S.route.view === 'outcomes') renderOutcomes();
}
async function loadHealth() {
  S.health = await api('/api/health').catch(() => null);
  renderHealth();
  if (S.route.view === 'settings') renderSettings();
  if (S.route.view === 'live' && (!S.live || S.live.endedAt)) renderStandby();
}
async function loadPast(id) {
  try {
    const c = await api('/api/calls/' + id);
    if (S.route.view === 'call' && S.route.id === id) {
      S.past = c;
      render();
      if (S.route.seg != null) requestAnimationFrame(() => jumpTo(S.route.seg));
      if (S.route.cp) requestAnimationFrame(() => openCard(S.route.cp));
    }
  } catch {
    if (S.route.view === 'call' && S.route.id === id) {
      S.past = null;
      $('#main').innerHTML = `<section class="page"><div class="blank"><h1>That call is gone</h1><p>It may have been removed. The rest of the history is still here.</p><a class="btn" href="#/history">${icon('left')}Back to history</a></div></section>`;
    }
  }
}

function connect() {
  const es = new EventSource('/api/events');
  const onLive = (fn) => (e) => {
    if (!S.live) return;
    fn(JSON.parse(e.data));
  };
  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    const changedCall = d.call?.id !== S.live?.id;
    S.live = d.call;
    S.pipeline = d.pipeline;
    S.settings = d.settings || S.settings;
    S.connected = true;
    if (changedCall && S.route.view === 'live') S.ui = freshUi();
    render();
    refreshLists();
  });
  es.addEventListener('call', onLive((m) => {
    if (S.live.id !== m.id) return;
    Object.assign(S.live, m);
    if (S.route.view === 'live' && S.live.endedAt) { render(); return; }
    renderNav();
    if (cur() === S.live) {
      renderHead();
      renderStrip();
      renderCue();
    }
  }));
  es.addEventListener('segments', onLive((tail) => {
    const first = tail[0]?.n ?? 0;
    S.live.segments = S.live.segments.slice(0, first).concat(tail);
    if (cur() === S.live) {
      renderStrip();
      renderTranscript();
      renderHeadFacts();
    }
  }));
  es.addEventListener('islands', onLive((islands) => {
    S.live.islands = islands;
    if (cur() === S.live) {
      renderStrip();
      renderRundown();
      renderTranscript();
      renderHeadFacts();
    }
  }));
  es.addEventListener('checkpoints', onLive((cps) => {
    noteChanges(S.live.checkpoints, cps);
    S.live.checkpoints = cps;
    renderNav();
    if (cur() === S.live) renderWork();
  }));
  es.addEventListener('mood', onLive((mood) => {
    S.live.mood = mood;
    if (cur() === S.live) {
      renderHead();
      renderStrip();
    }
  }));
  // Ask: answers stream in as deltas, then the whole chat lands once it settles.
  const callById = (id) => [S.live, S.past].find((c) => c?.id === id);
  es.addEventListener('chat', (e) => {
    const ch = JSON.parse(e.data);
    const c = callById(ch.callId);
    if (!c) return;
    c.chats ||= [];
    const i = c.chats.findIndex((x) => x.id === ch.id);
    if (i >= 0) c.chats[i] = ch;
    else c.chats.unshift(ch);
    if (cur() === c) renderAsk();
  });
  es.addEventListener('chat-delta', (e) => {
    const d = JSON.parse(e.data);
    const ch = callById(d.callId)?.chats?.find((x) => x.id === d.chatId);
    const m = ch?.messages.at(-1);
    if (!m || m.role !== 'ai') return;
    m.text = d.text;
    if (cur()?.id === d.callId) renderAsk();
  });
  es.addEventListener('pipeline', (e) => {
    S.pipeline = JSON.parse(e.data);
    if (cur() === S.live) renderPipeline();
  });
  es.addEventListener('settings', (e) => {
    S.settings = JSON.parse(e.data);
    if (S.route.view === 'settings') renderSettings();
  });
  es.addEventListener('changed', (e) => {
    const { id, removed } = JSON.parse(e.data);
    refreshLists();
    if (S.route.view === 'call' && S.route.id === id && S.live?.id !== id) {
      if (removed) location.hash = '#/history';
      else api('/api/calls/' + id).then((c) => {
        if (S.route.id !== id) return;
        noteChanges(S.past?.checkpoints || [], c.checkpoints);
        S.past = c;
        renderCall();
      }).catch(() => {});
    }
  });
  es.onopen = () => {
    if (!S.connected) {
      S.connected = true;
      renderHealth();
      renderPipeline();
    }
  };
  es.onerror = () => {
    S.connected = false;
    renderHealth();
    renderPipeline();
  };
}

/** A new cue chimes; agent work that finishes stays marked until you have looked at it. */
function noteChanges(before, after) {
  const old = new Map(before.map((c) => [c.id, c.status]));
  let fresh = false;
  for (const c of after) {
    const was = old.get(c.id);
    if (c.status === 'pending' && was !== 'pending') fresh = true;
    if ((c.status === 'done' || c.status === 'failed') && was && was !== c.status) S.unseen.add(c.id);
  }
  if (fresh) chime();
}

// ---------- routing ----------

function parseRoute() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const q = new URLSearchParams(qs || '');
  const view = ['live', 'history', 'outcomes', 'settings', 'call'].includes(parts[0]) ? parts[0] : 'live';
  return { view, id: parts[1] || null, seg: q.has('seg') ? Number(q.get('seg')) : null, cp: q.get('cp') };
}

function go() {
  const prev = S.route;
  S.route = parseRoute();
  if (S.route.view === 'call' && S.live?.id === S.route.id && !S.live.endedAt) {
    // The call on air lives on the live desk, not in history.
    location.replace('#/live');
    return;
  }
  if (S.route.view !== prev.view || S.route.id !== prev.id) {
    S.ui = freshUi();
    if (S.route.view === 'call' && S.live?.id !== S.route.id) {
      if (S.past?.id !== S.route.id) S.past = null;
      loadPast(S.route.id);
    }
    if (S.route.view === 'outcomes') loadOutcomes();
    if (S.route.view === 'settings' || S.route.view === 'live') loadHealth();
  }
  render();
  const c = cur();
  if (c && S.route.seg != null) requestAnimationFrame(() => jumpTo(S.route.seg));
  if (c && S.route.cp) requestAnimationFrame(() => openCard(S.route.cp));
}
window.addEventListener('hashchange', go);

// ---------- shell ----------

function renderRecordingNotice() {
  const el = $('#recordingNotice'), c = S.live;
  if (!el) return;
  const active = Boolean(c && !c.endedAt);
  el.hidden = !active;
  if (!active) return;
  const cap = c.capture || {};
  const fresh = t => Boolean(t && Date.now() - t < 8000);
  const mic = fresh(cap.meAt || cap.me), system = fresh(cap.themAt || cap.them);
  const label = !S.connected ? 'Connection lost' : cap.error ? 'Capture problem' : mic || system ? 'Recording' : 'Call active';
  const source = !S.connected ? 'Recording status unknown' : cap.error ? 'Check audio capture' : mic && system ? 'Microphone and call audio' : mic ? 'Microphone audio' : system ? 'Call audio' : 'Waiting for audio';
  const set = (id, value) => { const node = $(id); if (node.textContent !== value) node.textContent = value; };
  set('#recordingLabel', label);
  set('#recordingSources', source);
  set('#recordingClock', clock(Math.max(0, Date.now() - c.startedAt)));
  el.setAttribute('aria-label', `${label}. ${source}. Return to call`);
}

function renderNav() {
  renderRecordingNotice();
  const live = S.live && !S.live.endedAt;
  const pending = live ? S.live.checkpoints.filter((c) => c.status === 'pending').length : 0;
  const todos = (S.calls || []).reduce((n, c) => n + c.counts.todos, 0);
  const v = S.route.view === 'call' ? 'history' : S.route.view;
  const tab = (id, label, ic, extra = '') =>
    `<a href="#/${id}" class="tab ${v === id ? 'on' : ''}" ${v === id ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${extra}</a>`;
  $('#nav').innerHTML =
    tab('live', live ? 'Live call' : 'Home', 'live', live ? `<i class="lamp air" title="On air"></i>${pending ? `<b class="count cue">${pending}</b>` : ''}` : '') +
    tab('history', 'History', 'history', S.calls?.length ? `<b class="count">${S.calls.length}</b>` : '') +
    tab('outcomes', 'Outcomes', 'outcomes', todos ? `<b class="count">${todos}</b>` : '') +
    tab('settings', 'Settings', 'settings');
  document.title = (pending ? `(${pending}) ` : '') + (live ? 'On air: ' + (S.live.title || 'Untitled call') : 'Yap Call Copilot');
}

function renderHealth() {
  const h = S.health;
  const lamp = (ok, label, bad) => `<span class="health-item ${ok ? '' : 'down'}" title="${esc(ok ? label + ' is ready' : bad)}"><i class="lamp ${ok ? 'ok' : 'off'}"></i>${label}</span>`;
  $('#health').innerHTML = !S.connected
    ? `<span class="health-item down"><i class="lamp off"></i>Reconnecting to Yap</span>`
    : h
      ? lamp(h.whisper, 'Transcription', 'Local transcription is offline. Open Yap to start it.') + lamp(h.t3, 'T3 Code', 'T3 Code is not connected. Approved tasks cannot be sent.')
      : '';
}

function render() {
  renderNav();
  const main = $('#main');
  const v = S.route.view;
  const c = cur();
  const key = v === 'live' ? (c ? 'call:' + c.id : 'standby') : v === 'call' ? (c ? 'call:' + c.id : 'loading') : v;
  const fresh = main.dataset.key !== key;
  main.dataset.key = key;
  if (c) {
    if (fresh) mountCall();
    renderCall();
  } else if (v === 'live') {
    renderStandby();
  } else if (v === 'call') {
    main.innerHTML = `<section class="page"><div class="skeleton-rows">${'<div class="skeleton"></div>'.repeat(6)}</div></section>`;
  } else if (v === 'history') {
    if (fresh) mountHistory();
    renderHistory();
  } else if (v === 'outcomes') {
    renderOutcomes();
  } else {
    renderSettings();
  }
}

/** Replaces a region's markup unless you are typing in it; then it waits for you to finish. */
function paint(el, html) {
  if (!el) return;
  const a = document.activeElement;
  if (a && el.contains(a) && (a.matches('input, textarea, select') || a.isContentEditable)) {
    el.dataset.stale = '1';
    return;
  }
  if (el.id === 'rundown' && el.innerHTML && S.ui.tab === 'rundown' && !S.ui.interacting && onAir(cur())) { el.dataset.update = '1'; $('#refreshRecord').hidden = false; return; }
  delete el.dataset.stale;
  el.innerHTML = html;
}
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if ($('[data-stale]') && cur()) renderCall();
  }, 0);
});

// ---------- standby (no call) ----------

function renderStandby() {
  const main = $('#main');
  if (main.dataset.key !== 'standby') return;
  const calls = (S.calls || []).filter(c => c.segmentCount || c.counts?.checkpoints);
  const sum = key => calls.reduce((n,c) => n+(c.counts?.[key] || 0),0);
  const pending = sum('pending'), todos = sum('todos'), working = sum('working');
  const recent = calls.slice(0,4);
  const waiting = calls.filter(c => c.counts.pending).slice(0,3);
  paint(main, `<section class="page home-dashboard">
    <div class="home-welcome"><div><h1>Home</h1><p>Your calls, decisions and work in progress.</p></div><div class="home-start"><button class="btn new-call" data-act="start">${icon('play')}New call</button><p>Uses your microphone and Mac audio.</p></div></div>
    <div class="home-stats" aria-label="Across your saved calls">
      <a href="#/history" class="home-stat"><span>Awaiting your decision ${icon('target')}</span><strong>${pending}</strong><span>Review open agreements ${icon('chevron')}</span></a>
      <a href="#/outcomes" class="home-stat"><span>Your unfinished to-dos ${icon('human')}</span><strong>${todos}</strong><span>See what needs doing ${icon('chevron')}</span></a>
      <a href="#/outcomes" class="home-stat"><span>Agent tasks in progress ${icon('agent')}</span><strong>${working}</strong><span>Follow the work ${icon('chevron')}</span></a>
    </div>
    ${waiting.length ? `<section class="home-waiting"><div class="home-section-title"><h2>Pick up where you left off</h2><a href="#/history">All calls ${icon('chevron')}</a></div><div class="home-resume-grid">${waiting.map(c => `<a class="home-resume" href="#/call/${c.id}"><span>${dateShort(c.startedAt)}</span><h3>${esc(c.title || 'Untitled call')}</h3><p>${plural(c.counts.pending,'decision')} waiting ${icon('chevron')}</p></a>`).join('')}</div></section>` : ''}
    <section class="home-recent"><div class="home-section-title"><h2>Recent calls</h2><a href="#/history">View history ${icon('chevron')}</a></div>${recent.length ? `<div class="call-table">${callTableHeading()}${recent.map(c => callRow(c,Math.max(300000,c.spokenMs))).join('')}</div>` : '<p class="home-empty">Your first call starts here. Agreements become quick yes/no decisions, then tasks or notes.</p>'}</section>
    <p class="home-footnote">${S.health && !S.health.whisper ? 'Local transcription is offline. Open Yap to connect it.' : 'Keep Yap open for audio capture.'} <a href="#/settings">Check setup</a></p>
  </section>`);
}

// ---------- call view ----------

function mountCall() {
  $('#main').innerHTML = `<section class="call">
    <header class="callhead" id="callhead"></header>
    <div class="coltabs" id="coltabs"></div><button class="btn panel-close" id="panelClose" data-act="panel-close" hidden>Close <kbd>esc</kbd></button><button class="btn refresh-record" id="refreshRecord" data-act="refresh-record" hidden>Updates available</button>
    <div class="cols" id="cols">
      <section id="detailPanel" hidden></section><section id="askView" hidden></section><section id="topicsView" hidden></section><section id="reviewView" hidden></section>
      <section class="col main" aria-label="Topics and decisions">
        <div class="mainscroll">
          <div class="timeline" id="strip"></div>
          <div id="cue"></div>
          <div id="rundown"></div>
        </div>
      </section>
      <section class="col script" aria-label="Transcript">
        <div class="colhead" id="scripthead"></div>
        <div class="transcript" id="transcript"></div>
        <div class="jumpwrap"><button class="btn small primary" id="jump" data-act="follow" hidden>Jump to live</button></div>
        
      </section>
      <section class="compose-view" id="composeView" hidden><h1>Write a task</h1><p>Give an agent instructions, keep a note, or add something to your own to-do list.</p><form class="composer" id="composer" data-form="compose"></form></section>
    </div>
  </section>`;
  $('#transcript').addEventListener('scroll', () => {
    const el = $('#transcript');
    const follow = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (follow !== S.ui.follow) {
      S.ui.follow = follow;
      renderScriptHead();
    }
  });
  renderComposer();
}

function renderCall() {
  if (!cur() || !$('#callhead')) return;
  renderHead();
  renderStrip();
  renderWork();
  renderScriptHead();
  renderTranscript();
}
/** Everything that hangs off the checkpoints. */
function renderWork() {
  renderCue();
  renderRundown();
  renderStrip();
  renderHeadFacts();
  renderTabs();
}

function talkSplit(c) {
  const t = { me: 0, them: 0 };
  for (const s of c.segments) t[s.speaker] += s.dur || s.text.split(/\s+/).length * 380;
  const total = t.me + t.them;
  return total ? Math.round((t.me / total) * 100) : null;
}

function renderHead() {
  const c = cur();
  const el = $('#callhead');
  if (!c || !el) return;
  const live = onAir(c);
  const interrupted = !c.endedAt && !live;
  const m = (c.mood || [])[c.mood.length - 1];
  const feel = (k, who) => m?.[k]?.label ? `<span class="feel ${k}"><span>${who}</span><b>${esc(m[k].label)}</b>${trend(c, k)}</span>` : '';
  paint(el, `
    <div class="tally ${live ? 'air' : ''}">
      <span class="tally-state"><i class="lamp ${live ? 'air' : interrupted ? 'warn' : 'off'}"></i>${live ? 'On air' : interrupted ? 'Interrupted' : 'Ended'}</span>
      <span class="clock" id="clock">${clock(endOf(c) - c.startedAt)}</span>
    </div>
    <div class="callname">
      <input id="title" class="title" value="${esc(c.title)}" placeholder="Untitled call" spellcheck="false" aria-label="Call title" data-change="title">
      <div class="facts" id="facts"></div>
    </div>
    <button class="room" data-act="tab" data-tab="details" aria-label="Processing status"><div class="pipeline" id="pipeline"></div></button>
    <div class="callacts">
      <button class="btn icononly ${c.starred ? 'starred' : ''}" data-act="star" aria-label="${c.starred ? 'Remove star' : 'Star this call'}" aria-pressed="${Boolean(c.starred)}" data-tip="${c.starred ? 'Starred' : 'Star this call'}">${icon('star')}</button>
      <button class="btn icononly" data-menu="export" aria-label="Export" data-tip="Export and copy">${icon('download')}</button>
      <button class="btn icononly" data-menu="call" aria-label="More actions" data-tip="More">${icon('more')}</button>
      ${live
        ? `<button class="btn danger" data-act="end">${icon('stop')}End call</button>`
        : interrupted
          ? `<button class="btn" data-act="close-call">Close this call</button>`
          : S.live && !S.live.endedAt ? `<a class="btn" href="#/live"><i class="lamp air"></i>Back to live</a>` : `<button class="btn primary" data-act="start">${icon('play')}New call</button>`}
    </div>`);
  renderHeadFacts();
  renderPipeline();
}

function streams(c) {
  const cap = c.capture || {};
  const freshAt = (t) => t && Date.now() - t < 8000;
  return `<span class="stream ${freshAt(cap.meAt) ? 'on' : ''}"><i class="lamp ${freshAt(cap.meAt) ? 'ok' : 'off'}"></i>You</span>
    <span class="stream ${freshAt(cap.themAt) ? 'on' : ''}"><i class="lamp ${freshAt(cap.themAt) ? 'ok' : 'off'}"></i>Them</span>`;
}

/** Which way a side's mood moved over the last few passes. */
function trend(c, k) {
  const pts = (c.mood || []).slice(-4).map((x) => x[k]?.score ?? 0);
  if (pts.length < 2) return '';
  const d = pts[pts.length - 1] - pts[0];
  const dir = d > 0.15 ? 'up' : d < -0.15 ? 'down' : 'flat';
  return `<i class="trend ${dir}" aria-label="${dir === 'up' ? 'warming' : dir === 'down' ? 'cooling' : 'steady'}"></i>`;
}

function renderHeadFacts() {
 const c = cur(), el = $('#facts');
 if (c && el) el.textContent = `${dateShort(c.startedAt)}, ${hm(c.startedAt)}`;
}

function renderPipeline() {
  const c = cur();
  const el = $('#pipeline');
  if (!c || !el) return;
  const p = S.pipeline || {};
  const bits = [];
  if (onAir(c)) {
    if (p.transcribing) bits.push(`<span class="busy">Transcribing${p.transcribing > 1 ? ' ' + p.transcribing : ''}</span>`);
    if (p.analyzing) bits.push('<span class="busy">Reading the call</span>');
    if (c.capture?.error) bits.push(`<span class="err" data-tip="${esc(c.capture.error)}">Capture problem</span>`);
    if (p.lastError) bits.push(`<span class="err" data-tip="${esc(p.lastError)}">${p.lastError.startsWith('whisper') ? 'Transcription failed' : 'Copilot pass failed'}</span>`);
  } else if (c === S.live && (p.analyzing || p.transcribing)) {
    bits.push('<span class="busy">Final pass</span>');
  }
  el.textContent = !S.connected ? 'Reconnecting' : onAir(c) && c.capture?.error ? 'Capture problem' : c === S.live && p.lastError ? 'Processing problem' : bits.length ? (!onAir(c) ? 'Final pass' : p.analyzing ? 'Analyzing' : 'Transcribing') : onAir(c) ? 'Listening' : '';
  el.dataset.tone = !S.connected || c.capture?.error || (c === S.live && p.lastError) ? 'problem' : bits.length ? 'progress' : 'neutral';
}

setInterval(() => {
  renderRecordingNotice();
  // History clocks are local text updates, independent of incoming speech/events.
  document.querySelectorAll('[data-live-start]').forEach(el => {
    el.textContent = clock(Math.max(0, Date.now() - Number(el.dataset.liveStart)));
  });
  const c = cur();
  if (!onAir(c)) return;
  const el = $('#clock');
  if (el) el.textContent = clock(Date.now() - c.startedAt);
  const st = $('#streams');
  if (st) st.innerHTML = streams(c);
  renderStripNow();
}, 1000);

// ---------- timeline: the call's topics in order, on one bar ----------

function renderStrip() {
  const c = cur(), el = $('#strip');
  if (!c || !el) return;
  const topic = [...c.islands].filter(i => i.status === 'open').sort((a,b) => b.lastSeg-a.lastSeg)[0] || [...c.islands].sort((a,b) => b.lastSeg-a.lastSeg)[0];
  el.innerHTML = `<span class="now-label">${onAir(c) ? 'Discussing now' : 'Call record'}</span><h2>${esc(onAir(c) ? topic?.title || 'Listening for the first topic' : c.title || 'Untitled call')}</h2>`;
}
let lastStripDraw = 0;

function renderStripNow() {
  if (Date.now() - lastStripDraw < 5000) return;
  lastStripDraw = Date.now();
  renderStrip();
}

// ---------- cue band: the decision waiting for you ----------

function pendingCues(c) {
  // Oldest first: arrivals append without displacing a decision being read.
  return c.checkpoints.filter((x) => x.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
}
function currentCue(c = cur()) {
  if (!c) return null;
  const list = pendingCues(c);
  const selected = list.find((x) => x.id === S.ui.cue) || list[0] || null;
  S.ui.cue = selected?.id || null;
  return selected;
}

function decisionHome(c) {
  const selected = currentCue(c);
  const items = [...c.checkpoints].sort((a,b) => a.createdAt-b.createdAt);
  const pending = pendingCues(c).length;
  const tiles = items.map(x => {
    const k = KIND[x.kind] || KIND.agent, state = meaning(x);
    const needs = x.status === 'pending', active = selected?.id === x.id;
    const effect = x.kind === 'agent' ? 'Starts an agent with call context' : x.kind === 'human' ? 'Adds to your personal to-dos' : 'Keeps this agreement on record';
    const yes = x.kind === 'agent' ? 'Do it' : x.kind === 'human' ? 'Add to-dos' : 'Keep it';
    return `<article class="decision-tile ${active ? 'selected' : ''}" data-cp="${x.id}" data-tone="${state.tone}">
      <div class="tile-top"><span>${icon(k.icon)}${esc(k.label)}</span>${stateLabel(state)}</div>
      <h2 class="cue-q">${esc(x.question || x.conclusion)}</h2>
      <p class="tile-effect">${needs ? effect : esc(state.label)}${needs && x.repo ? ` · ${esc(x.repo)}` : ''}</p>
      <div class="tile-actions">${needs ? `<button class="cue-go" data-act="home-go" data-cp="${x.id}" aria-label="${esc(yes+': '+x.question)}">${yes}${active ? '<kbd>Y</kbd>' : ''}</button><button class="cue-skip" data-act="cp-skip" data-cp="${x.id}">Skip${active ? '<kbd>N</kbd>' : ''}</button>` : `<span class="tile-result">${stateLabel(state)}</span>`}<button class="tile-details" data-act="cp-open" data-cp="${x.id}">Details</button></div>
    </article>`;
  }).join('');
  return `<section class="decision-home"><div class="home-heading"><div><h1>${pending ? 'Your next decisions' : items.length ? 'All caught up' : 'Listening for agreements'}</h1><p>${pending ? `${pending} waiting. Choose what happens next.` : items.length ? 'Your decisions stay here as the work progresses.' : 'Decisions will appear here as you talk.'}</p></div><div class="home-keys"><kbd>Y</kbd> take <kbd>N</kbd> skip <button data-act="cue-next">Next <kbd>J</kbd></button><button data-act="cue-edit">Edit <kbd>E</kbd></button></div></div><div class="decision-grid">${tiles || '<p class="home-empty">Keep talking. You can also write a task with <kbd>T</kbd>.</p>'}</div>${c.endedAt ? '<div class="overview-actions"><button class="btn" data-act="copy-summary">Preview summary</button><button class="btn" data-act="followup">Draft a follow-up…</button><button class="btn" data-act="recap">Record in memory…</button></div>' : ''}</section>`;
}

function renderCue() {
  const c = cur();
  const el = $('#cue');
  if (!c || !el) return;
  if (!S.ui.editing) return paint(el, decisionHome(c));
  const list = pendingCues(c);
  const top = currentCue(c);
  // After the call the open decisions wait under their topics; the big card is for the live moment.
  if (!top || (!onAir(c) && !S.ui.editing)) {
    S.ui.lastCue = null;
    return paint(el, c.endedAt ? wrap(c) : '<section class="cue-empty"><h2>No decision waiting</h2><p>Keep talking. Agreements will appear here.</p></section>');
  }
  const k = KIND[top.kind] || KIND.agent;
  const at = list.indexOf(top);
  const editing = S.ui.editing === top.id;
  const arriving = S.ui.lastCue !== top.id;
  S.ui.lastCue = top.id;
  const island = c.islands.find((i) => i.id === top.islandId);
  paint(el, `<section class="cueband ${arriving ? 'arrive' : ''}" data-cp="${top.id}" aria-label="Decision waiting for you">
    <div class="cue-say">
      <h2 class="cue-q">${esc(top.question)}</h2>
      <p class="cue-why"><button class="link" data-act="cp-open" data-cp="${top.id}">Details and source</button></p>
      <p class="cue-meta">${icon(k.icon)}<span>${esc(k.label)}</span>${top.repo ? `<span>${esc(top.repo)}</span>` : ''}${island ? `<span>${esc(island.title)}</span>` : ''}<button class="cue-time" data-act="seg-jump" data-n="${top.atSeg}">at ${rel(c, top.at)}</button>${c.endedAt ? '<span>left open</span>' : ''}</p>
    </div>
    <div class="cue-acts">
      <button class="cue-go" data-act="cue-go">${esc(k.go)}<kbd>Y</kbd></button>
      <button class="cue-skip" data-act="cue-skip">Skip<kbd>N</kbd></button>
      <div class="cue-more">
        <button data-act="cue-edit" aria-expanded="${editing}">${editing ? 'Close' : 'Edit'}<kbd>E</kbd></button>
        <span class="cue-count">${at + 1} of ${list.length}</span><button data-act="cue-next" aria-label="Next cue" ${list.length < 2 ? 'disabled' : ''}>Next<kbd>J</kbd></button>
      </div>
    </div>
    ${editing ? `<div class="cue-edit">
      <label>Question<input data-draft="question" value="${esc(S.ui.drafts.question ?? top.question)}"></label>
      <fieldset class="seg-control" aria-label="Kind">${Object.entries(KIND).map(([id, kk]) => `<label><input type="radio" name="cuekind" value="${id}" data-draft="kind" ${(S.ui.drafts.kind ?? top.kind) === id ? 'checked' : ''}><span>${kk.label}</span></label>`).join('')}</fieldset>
      <label class="wide">Instructions for the agent<textarea data-draft="task" rows="6" spellcheck="false">${esc(S.ui.drafts.task ?? top.task)}</textarea></label>
    </div>` : ''}
  </section>`);
}

/** After the call: what it produced, in one band, with the things you usually do next. */
function wrap(c) {
 const open = c.checkpoints.filter(x => x.status === 'pending').length;
 const kept = c.checkpoints.filter(x => x.status === 'kept').length;
 const sent = c.checkpoints.filter(x => x.threadId).length;
 return `<section class="overview"><h1>What came out of this call</h1><p class="overview-counts"><span data-tone="${open ? 'attention' : 'neutral'}">${open} awaiting your decision</span> · <span data-tone="${kept ? 'success' : 'neutral'}">${kept} kept</span> · ${plural(sent, 'agent task')}</p><button class="btn" data-act="tab" data-tab="rundown">Review decisions ${icon('chevron')}</button><div class="overview-topics">${c.islands.map(i => {const r=topicResult(c,i);return `<section data-tone="${r.tone}"><h2>${esc(i.title)}</h2><p>${esc(i.summary)}</p><button class="overview-topic-link" data-act="open-topic" data-topic="${i.id}">${stateLabel(r)}<span>${esc(r.counts)}</span>${icon('chevron')}</button></section>`;}).join('') || '<p>No topics recorded.</p>'}</div><div class="overview-actions"><button class="btn" data-act="copy-summary">Preview summary</button><button class="btn" data-act="followup">Draft a follow-up…</button><button class="btn" data-act="recap">Record in memory…</button></div></section>`;
}
const FILTERS = {
 all: ['All', () => true], needs: ['Needs you', x => ['attention','problem'].includes(meaning(x).tone)],
 agents: ['Agent tasks', x => x.kind === 'agent'], kept: ['Kept', x => x.status === 'kept'], skipped: ['Skipped', x => ['skipped','superseded'].includes(x.status)],
};


function card(c, x) {
  const k = KIND[x.kind] || KIND.agent;
  const open = S.ui.open.has(x.id);
  const done = x.kind === 'human' && x.doneAt;
  const teaser = x.error && x.status === 'failed' ? x.error : x.reply || (x.kind !== 'agent' ? x.conclusion : '');
  const act = (name, label, ic, cls = '') => `<button class="btn small ${cls}" data-act="${name}" data-cp="${x.id}">${ic ? icon(ic) : ''}${label}</button>`;
  const acts = [];
  if (x.status === 'pending') acts.push(act('cp-go', k.go, 'check', 'primary'), act('cp-skip', 'Skip', 'x'));
  if (x.status === 'failed') acts.push(act('cp-retry', 'Try again', 'retry', 'primary'));
  if (['skipped', 'superseded'].includes(x.status)) acts.push(act('cp-restore', 'Restore decision', 'undo'));
  if (x.status === 'kept' && x.kind === 'human') acts.push(act(done ? 'cp-undone' : 'cp-done', done ? 'Not done yet' : 'Mark done', 'check', done ? '' : 'primary'));
  if (x.status === 'kept') acts.push(act('cp-restore', 'Reopen', 'undo'));
  if (x.kind !== 'agent' && x.status === 'kept') acts.push(act('cp-agent', 'Hand to an agent', 'agent'));
  acts.push(act('cp-jump', 'Show in transcript', 'target'));

  return `<article data-tone="${meaning(x).tone}" class="card st-${x.status} ${open ? 'open' : ''} ${S.unseen.has(x.id) ? 'unseen' : ''} ${done ? 'ticked' : ''}" data-cp="${x.id}" id="cp-${x.id}">
    <button class="card-head" data-act="cp-toggle" data-cp="${x.id}" aria-expanded="${open}">
      <span class="disclosure-arrow">${icon("chevron")}</span>
      <span class="card-q">${esc(x.question)}<span class="row-kind">${icon(k.icon)}${k.label}</span></span>
      ${stateLabel(meaning(x))}
    </button>
    
    <div class="disclosure-content" ${open ? '' : 'inert'}><div><div class="card-body">
      <dl>
        <dt>${x.kind === 'agent' ? 'Decided' : k.label}</dt><dd>${esc(x.conclusion)}</dd>
        ${x.kind === 'agent' && x.task ? `<dt>Agent instructions</dt><dd><p class="field-help">This is the task the agent will receive, together with the call context.</p><div class="brief">${esc(x.task)}</div><button class="text-button" data-act="cp-copy" data-cp="${x.id}">Copy these instructions</button></dd>` : ''}
        ${x.reply ? `<dt>Agent</dt><dd class="reply">${esc(x.reply)}</dd>` : ''}
        ${x.error ? `<dt>Error</dt><dd class="err">${esc(x.error)}</dd>` : ''}
      </dl>
      ${x.threadId && ['done', 'failed'].includes(x.status) ? `<form class="followup" data-form="followup" data-cp="${x.id}"><input name="text" placeholder="Reply to this agent" autocomplete="off" aria-label="Reply to this agent"><button class="btn small">${icon('send')}Send</button></form>` : ''}
      <div class="card-acts">${acts.join('')}</div>
    </div></div></div>
    <footer class="card-foot"><button data-act="seg-jump" data-n="${x.atSeg}">${rel(c, x.at)}</button>${x.repo ? `<span>${esc(x.repo)}</span>` : ''}${x.manual ? '<span>by hand</span>' : ''}${x.finishedAt ? `<span>finished ${hm(x.finishedAt)}</span>` : ''}</footer>
  </article>`;
}

// ---------- topics: each subject of the call with the decisions it produced ----------

const topicOpen = (i) => S.ui.toggled.has(i.id);

function renderRundown() {
 const c = cur(), el = $('#rundown');
 if (!c || !el) return;
 const all = c.checkpoints, filter = FILTERS[S.ui.filter];
 const chips = Object.entries(FILTERS).map(([id,[label,p]]) => `<button class="chip ${S.ui.filter === id ? 'on' : ''}" data-act="filter" data-filter="${id}" aria-pressed="${S.ui.filter === id}">${label}<b>${all.filter(p).length}</b></button>`).join('');
 paint(el, `<div class="view-heading"><div><h1>Decisions</h1><p>See what needs you, what is running, and what is on record.</p></div>${colorKey()}</div><div class="chips">${chips}</div><div class="record-decisions">${all.filter(filter[1]).map(x => card(c,x)).join('') || '<p class="empty-record">No decisions in this view.</p>'}</div>`);
 renderTopics();
}
const renderDesk = renderRundown;
function renderTopics() {
 const c = cur(), el = $('#topicsView');
 if (!c || !el) return;
 if (S.ui.tab === 'topics' && el.innerHTML && !S.ui.interacting) { el.dataset.update = '1'; $('#refreshRecord').hidden = false; return; }
 delete el.dataset.update;
 for (const i of c.islands) if (!S.ui.topicOrder.includes(i.id)) S.ui.topicOrder.push(i.id);
 el.innerHTML = `<div class="view-heading"><div><h1>Topics</h1><p>The discussion, and what came out of it.</p></div>${colorKey()}</div><div class="topic-list">` + [...c.islands].sort((a,b) => S.ui.topicOrder.indexOf(a.id)-S.ui.topicOrder.indexOf(b.id)).map(i => {
 const open = S.ui.toggled.has(i.id), result = topicResult(c,i);
 return `<section class="topic ${open ? 'open' : ''}" data-tone="${result.tone}" data-topic="${i.id}"><button class="topic-row" data-act="topic-fold" data-topic="${i.id}" aria-expanded="${open}"><span class="disclosure-arrow">${icon('chevron')}</span><span class="topic-text"><span class="topic-title">${esc(i.title)}</span><span class="topic-summary">${esc(i.summary || 'No summary yet.')}</span><span class="topic-result">${esc(result.counts)}</span></span>${stateLabel(result)}</button><div class="disclosure-content" ${open ? '' : 'inert'}><div><div class="topic-body"><p>${esc(i.summary)}</p><ul>${(i.points || []).map(p => `<li>${esc(p)}</li>`).join('')}</ul>${result.items.length ? `<div class="topic-decisions"><h3>From this discussion</h3>${result.items.map(x => `<button class="related-decision" data-act="cp-open" data-cp="${x.id}">${icon(KIND[x.kind]?.icon || 'note')}<span>${esc(x.question)}</span>${stateLabel(meaning(x))}${icon('chevron')}</button>`).join('')}</div>` : ''}<button class="btn" data-act="topic" data-topic="${i.id}">Show this topic in transcript</button></div></div></div></section>`;
 }).join('') + '</div>';
}


function renderTabs() {
 const c = cur(), el = $('#coltabs');
 if (!c || !el) return;
 const tab = S.ui.tab;
 el.innerHTML = `<div class="view-tabs" role="tablist" aria-label="Call views">${[['focus',onAir(c) ? 'Live call' : 'Overview'],['ask','Ask'],['rundown','Decisions'],['topics','Topics'],['script','Transcript'],['details','Details']].map(([id,label]) => `<button role="tab" data-act="tab" data-tab="${id}" aria-selected="${tab === id}" class="${tab === id ? 'on' : ''}">${label}</button>`).join('')}</div><button class="btn write-task ${tab === 'compose' ? 'on' : ''}" data-act="compose-open">Write a task <kbd>T</kbd></button>`;
 $('#cols').dataset.tab = tab;
 $('#main').classList.toggle('is-live', onAir(c));
 for (const [id,view] of [['askView','ask'],['detailPanel','details'],['topicsView','topics'],['composeView','compose'],['reviewView','review']]) $('#'+id).hidden = tab !== view;
 $('#panelClose').hidden = true;
 $('#refreshRecord').hidden = !(['rundown','topics'].includes(tab) && $(tab === 'topics' ? '#topicsView' : '#rundown').dataset.update);
 renderDetails();
 renderAsk();
}


// ---------- ask ----------

const ASK_STARTERS = [
  'List every item we talked about',
  'What did they agree to or commit to?',
  'What questions were left open?',
  'What did they say about price, timing and next steps?',
];

/** Answers come back as light Markdown with [#n] citations to transcript lines. */
function askMarkdown(c, text) {
  const cite = (nums) => nums.map((n) => {
    const s = c.segments.find((x) => (x.n ?? c.segments.indexOf(x)) === n);
    return s ? `<button class="ask-cite" data-act="ask-cite" data-n="${n}" data-tip="${esc(s.text.slice(0, 160))}">${clock(s.t - c.startedAt)}</button>` : '';
  }).join('');
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[((?:#\d+(?:\s*[-–]\s*#?\d+)?[\s,;]*)+)\]/g, (_, inner) => {
      const nums = [];
      for (const [, a, b] of inner.matchAll(/#(\d+)(?:\s*[-–]\s*#?(\d+))?/g)) {
        nums.push(Number(a));
        if (b && Number(b) > Number(a)) nums.push(Number(b));
      }
      return cite(nums);
    });
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)/), ol = line.match(/^\s*\d+[.)]\s+(.*)/), h = line.match(/^#{1,4}\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (list !== tag) { close(); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (!line.trim()) close();
    else { close(); out.push(h ? `<h3>${inline(h[1])}</h3>` : `<p>${inline(line)}</p>`); }
  }
  close();
  return out.join('');
}

function mountAsk(el) {
  el.innerHTML = `<div class="ask">
    <aside class="ask-list" id="askList" aria-label="Questions about this call"></aside>
    <div class="ask-main">
      <div class="ask-thread" id="askThread" aria-live="polite"></div>
      <form class="ask-form" id="askForm" data-form="ask">
        <textarea id="askInput" name="text" rows="2" placeholder="Ask anything about this call" aria-label="Ask about this call"></textarea>
        <div class="composer-foot"><span><kbd>↵</kbd> ask · <kbd>⇧↵</kbd> new line</span><span class="ask-buttons"><button type="button" class="btn" data-act="ask-stop" id="askStop" hidden>${icon('stop')}Stop</button><button class="btn primary" id="askSend">${icon('send')}Ask</button></span></div>
      </form>
    </div>
  </div>`;
}

function renderAsk() {
  const c = cur(), el = $('#askView');
  if (!c || !el || el.hidden) return;
  if (!el.firstChild) mountAsk(el);
  const chats = c.chats || [];
  let chat = chats.find((x) => x.id === S.ui.chat);
  if (S.ui.chat && !chat) S.ui.chat = null;
  const busy = chat?.messages.at(-1)?.pending;
  $('#askList').innerHTML = `<button class="btn ask-new ${chat ? '' : 'on'}" data-act="ask-new">${icon('edit')}New question</button>${chats.length ? `<div class="ask-past">${chats.map((x) => `<button class="ask-item ${x.id === S.ui.chat ? 'on' : ''}" data-act="ask-open" data-chat="${x.id}"><span>${esc(x.title)}</span><em>${x.messages.at(-1)?.pending ? 'Answering' : dayLabel(x.updatedAt || x.createdAt) + ', ' + hm(x.updatedAt || x.createdAt)}</em></button>`).join('')}</div>` : ''}`;
  const thread = $('#askThread');
  const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
  const key = chat ? chat.id : 'new';
  const switched = thread.dataset.chat !== key;
  thread.dataset.chat = key;
  if (!chat) {
    thread.innerHTML = `<div class="ask-empty"><h1>Ask about this call</h1><p>Answers come from the transcript, topics and decisions, with links to the moments they cite.</p><div class="ask-starters">${ASK_STARTERS.map((q) => `<button class="btn" data-act="ask-suggest">${esc(q)}</button>`).join('')}</div></div>`;
  } else {
    thread.innerHTML = `<div class="ask-head"><h2>${esc(chat.title)}</h2><span><button class="btn small bare" data-act="ask-copy">${icon('copy')}Copy answer</button><button class="btn small bare" data-act="ask-delete">${icon('trash')}Delete</button></span></div>` + chat.messages.map((m) => m.role === 'me'
      ? `<div class="ask-msg me"><p>${esc(m.text)}</p></div>`
      : `<div class="ask-msg ai ${m.pending ? 'pending' : ''}">${m.text ? askMarkdown(c, m.text) : m.pending ? '<p class="ask-wait">Reading the call</p>' : ''}${m.error ? `<p class="ask-error">${esc(m.error === 'stopped' ? 'Stopped.' : m.error)}</p>` : ''}</div>`).join('');
  }
  if (switched || nearBottom) thread.scrollTop = thread.scrollHeight;
  $('#askStop').hidden = !busy;
  $('#askSend').disabled = !!busy;
  $('#askInput').placeholder = chat ? 'Ask a follow-up' : 'Ask anything about this call';
}

async function askSend(text) {
  const c = cur();
  if (!c || !text) return;
  const r = await callApi('/ask', { text, chatId: S.ui.chat });
  c.chats ||= [];
  const i = c.chats.findIndex((x) => x.id === r.id);
  if (i >= 0) c.chats[i] = r;
  else c.chats.unshift(r);
  S.ui.chat = r.id;
  renderAsk();
}

function openAsk(text) {
  S.ui.tab = 'ask';
  renderTabs();
  const box = $('#askInput');
  if (text) askSend(text).catch(fail);
  else box?.focus();
}

function renderDetails() {
 const c = cur(), el = $('#detailPanel');
 if (!c || !el || el.hidden) return;
 const m = c.mood?.at(-1), p = S.pipeline;
 paint(el, `<h2>Call details</h2><dl><dt>Capture</dt><dd>${streams(c)} ${esc(c.capture?.error || '')}</dd><dt>Processing</dt><dd>${p.transcribing || 0} queued · ${p.analyzing ? 'Analyzing' : 'Idle'}</dd><dt>Last error</dt><dd>${esc(p.lastError || 'None')}</dd><dt>Brain cost</dt><dd>$${Number(p.brainCost || 0).toFixed(3)}</dd><dt>Timing</dt><dd>Analysis ${p.lastPassMs || 0} ms · transcription ${p.sttMs || 0} ms</dd><dt>Room</dt><dd>${esc(m ? `You: ${m.me.label}. Them: ${m.them.label}. ${m.note}` : 'No assessment yet')}</dd><dt>Memory recording</dt><dd>${esc(c.recap?.status || 'Not started')}. Automatic recording at call end is ${S.settings.autoRecap ? 'on' : 'off'}. <a class="link" href="#/settings">Change in settings</a></dd><dd>${esc(c.recap?.reply || c.recap?.error || '')}</dd></dl>`);
}

function openCard(id) {
  const c = cur();
  const x = c?.checkpoints.find((y) => y.id === id);
  if (!x) return;
  S.ui.open.add(id);
  S.unseen.delete(id);
  S.ui.toggled.add(x.islandId);
  if (!FILTERS[S.ui.filter][1](x)) S.ui.filter = 'all';
  S.ui.tab = 'rundown';
  S.ui.interacting = true;
  renderRundown();
  S.ui.interacting = false;
  renderTabs();
  renderStrip();
  const el = $('#cp-' + id);
  if (el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flash(el);
  }
}
function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

// ---------- transcript ----------

function renderScriptHead() {
  const c = cur();
  const el = $('#scripthead');
  if (!c || !el) return;
  const topic = c.islands.find((i) => i.id === S.ui.topic);
  const sp = (id, label) => `<label><input type="radio" name="speaker" value="${id}" data-change="speaker" ${S.ui.speaker === id ? 'checked' : ''}><span>${label}</span></label>`;
  paint(el, `<h2>Transcript</h2>
    <label class="find">${icon('search')}<input id="find" type="search" placeholder="Find in this call" value="${esc(S.ui.find)}" data-input="find" aria-label="Find in this call" autocomplete="off"><kbd>/</kbd></label>
    <fieldset class="seg-control small" aria-label="Speaker">${sp('all', 'All')}${sp('me', 'You')}${sp('them', 'Them')}</fieldset>
    ${topic ? `<button class="chip on topicchip" data-act="topic" data-topic="${topic.id}" aria-label="Stop showing only ${esc(topic.title)}"><span>${esc(topic.title)}</span>${icon('x')}</button>` : ''}`);
  const jump = $('#jump');
  if (jump) jump.hidden = !(onAir(c) && !S.ui.follow);
}

function renderTranscript(reset) {
  const c = cur();
  const el = $('#transcript');
  if (!c || !el) return;
  if (!reset && !S.ui.follow && onAir(c)) return;
  const topic = c.islands.find((i) => i.id === S.ui.topic);
  const q = S.ui.find.trim();
  const terms = fold(q).split(/\s+/).filter(Boolean);
  const filtering = Boolean(topic || q || S.ui.speaker !== 'all');
  const cueAt = new Map();
  for (const x of c.checkpoints) if (x.status !== 'superseded') cueAt.set(x.atSeg, [...(cueAt.get(x.atSeg) || []), x]);
  const startOf = new Map();
  for (const i of c.islands) if (!startOf.has(i.firstSeg)) startOf.set(i.firstSeg, i);
  let html = '';
  let prev = null;
  let shown = 0;
  for (const s of c.segments) {
    if (topic && (s.n < topic.firstSeg || s.n > topic.lastSeg)) continue;
    if (S.ui.speaker !== 'all' && s.speaker !== S.ui.speaker) continue;
    if (terms.length && !terms.every((t) => fold(s.text).includes(t))) continue;
    shown++;
    const isl = startOf.get(s.n);
    if (isl && !filtering) {
      html += `<button class="mark-topic" data-act="topic" data-topic="${isl.id}"><span>${esc(isl.title)}</span></button>`;
      prev = null;
    }
    const lead = prev !== s.speaker;
    html += `<div class="seg ${s.speaker} ${lead ? 'lead' : ''} ${s.edited ? 'edited' : ''}" data-n="${s.n}" data-time="${s.t}" data-speaker="${s.speaker}">
      <span class="tc">${rel(c, s.t)}</span>
      <div class="said">${lead ? `<b class="who">${s.speaker === 'me' ? 'You' : 'Them'}</b>` : ''}<span class="text" data-text="${s.n}">${marked(s.text, q)}</span></div>
      <span class="seg-acts"><button data-act="seg-quote" data-n="${s.n}" aria-label="Make a task from this line" data-tip="Make a task from this">${icon('quote')}</button><button data-act="seg-edit" data-n="${s.n}" aria-label="Fix this line" data-tip="Fix the transcription">${icon('edit')}</button></span>
    </div>`;
    prev = s.speaker;
    for (const x of cueAt.get(s.n) || []) {
      html += `<button data-tone="${meaning(x).tone}" class="mark-cue st-${x.status}" data-act="cp-open" data-cp="${x.id}">${icon(KIND[x.kind]?.icon || 'agent')}<span>${esc(x.question)}</span><em>${meaning(x).label}</em></button>`;
      prev = null;
    }
  }
  if (!c.segments.length) {
    html = `<div class="teach"><b>${onAir(c) ? 'Waiting for the first words.' : 'Nothing was said.'}</b><p>${onAir(c) ? 'Your side comes from the mic, theirs from the Mac\'s audio. Lines appear a few seconds after they are spoken. The two lamps in the header show which side is being heard.' : 'This call ended before any speech was transcribed.'}</p></div>`;
  } else if (!shown) {
    html = `<div class="teach"><b>No lines match.</b><p>${q ? `Nothing in this call contains "${esc(q)}".` : 'Nothing under this filter.'} <button class="link" data-act="clear-find">Show everything</button></p></div>`;
  } else if (filtering) {
    html = `<p class="found">${plural(shown, 'line')} of ${c.segments.length}. <button class="link" data-act="clear-find">Show everything</button></p>` + html;
  }
  if (onAir(c)) html += `<div class="listening ${S.pipeline?.transcribing ? 'busy' : ''}"><i></i><i></i><i></i><span>${S.pipeline?.transcribing ? 'Transcribing' : 'Listening'}</span></div>`;
  if (el.querySelector('[contenteditable="true"]')) return;
  el.innerHTML = html;
  if ((S.ui.follow && onAir(c) && !filtering) || (reset && onAir(c))) el.scrollTop = el.scrollHeight;
  else if (reset) el.scrollTop = 0;
}

function jumpTo(n) {
  const c = cur();
  if (!c || n == null || n < 0) return;
  renderTranscript(true);
  let row = $(`.seg[data-n="${n}"]`);
  if (!row) {
    Object.assign(S.ui, { topic: null, find: '', speaker: 'all' });
    renderScriptHead();
    renderTranscript(true);
    renderRundown();
    renderStrip();
    row = $(`.seg[data-n="${n}"]`);
  }
  if (!row) return;
  S.ui.tab = 'script';
  renderTabs();
  S.ui.follow = false;
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  flash(row);
  renderScriptHead();
}

const MODES = {
  task: ['Task', 'Tell an agent what to do. It starts now, with the transcript as context.', 'Start agent task'],
  note: ['Note', 'A decision or a fact to keep on record. It goes into the recap.', 'Keep note'],
  human: ['To-do', 'Something only you can do. It lands in Outcomes.', 'Add to-do'],
};
function renderComposer() {
  const el = $('#composer');
  if (!el) return;
  const m = MODES[S.ui.mode];
  const text = $('#askText')?.value || '';
  el.innerHTML = `<fieldset class="seg-control small" aria-label="What to add">${Object.entries(MODES).map(([id, [label]]) => `<label><input type="radio" name="mode" value="${id}" data-change="mode" ${S.ui.mode === id ? 'checked' : ''}><span>${label}</span></label>`).join('')}</fieldset>
    <textarea id="askText" name="text" rows="2" placeholder="${esc(m[1])}" aria-label="${esc(m[0])}">${esc(text)}</textarea>
    <div class="composer-foot"><span><kbd>↵</kbd> send · <kbd>⇧↵</kbd> new line · <kbd>B</kbd> drops a bookmark</span><button class="btn primary">${icon('send')}${m[2]}</button></div>`;
}

// ---------- history ----------

function mountHistory() {
  $('#main').innerHTML = `<section class="page history">
    <header class="pagehead">
      <h1>History</h1>
      <label class="find big">${icon('search')}<input id="hq" type="search" placeholder="Search everything said, every topic and every cue" value="${esc(S.history.q)}" data-input="hq" aria-label="Search all calls" autocomplete="off"><kbd>/</kbd></label>
    </header>
    <div id="historyBody"></div>
  </section>`;
}

function stripMini(c, scale) {
  const d = Math.max(1, c.spokenMs || c.durationMs);
  const w = Math.max(1.5, Math.min(100, (d / scale) * 100));
  const lane = (who) => c.strip.segs.filter((s) => s[2] === who).map((s) => `<i style="left:${((s[0] / d) * 100).toFixed(2)}%;width:max(1px,${((s[1] / d) * 100).toFixed(2)}%)"></i>`).join('');
  const cps = c.strip.cps.map((x) => `<b class="st-${x[2]}" style="left:${Math.min(100, Math.max(0, (x[0] / d) * 100)).toFixed(2)}%"></b>`).join('');
  return `<div class="mini" style="width:${w.toFixed(2)}%" aria-hidden="true"><div class="me">${lane(0)}</div><div class="them">${lane(1)}</div><div class="marks">${cps}</div></div>`;
}

function callTableHeading() {
  return '<div class="call-table-heading" aria-hidden="true"><span>Time</span><span>Call</span><span>Duration</span><span>Outcomes</span><span></span></div>';
}

function callRow(c, scale) {
  const n = c.counts;
  const stat = (ic, value, label, cls = '') => value ? `<span class="stat ${cls}" data-tip="${label}">${icon(ic)}${value}</span>` : '';
  return `<div class="callrow ${c.live ? 'live' : ''}">
    <a class="callrow-main" href="${c.live ? '#/live' : '#/call/' + c.id}">
      <span class="tc">${hm(c.startedAt)}</span>
      <span class="callrow-name"><b>${esc(c.title || 'Untitled call')}</b><span>${c.live ? 'On air now' : c.interrupted ? 'Interrupted' : esc(c.topics.slice(0, 4).join(' · ') || 'No topics')}</span></span>
      <span class="callrow-strip">${stripMini(c, scale)}</span>
      <span class="dur">${c.live ? '<i class="lamp air"></i>' : ''}${c.live ? `<span data-live-start="${Number(c.startedAt)}">${clock(Math.max(0, Date.now() - c.startedAt))}</span>` : span(c.spokenMs || c.durationMs)}</span>
      <span class="stats">${stat('agent', n.sent, 'Tasks sent to agents')}${stat('note', n.kept, 'Kept decisions and to-dos')}${stat('human', n.todos, 'To-dos still open', 'cue')}${n.pending ? `<span class="stat cue" data-tip="Cues never answered">${n.pending} open</span>` : ''}</span>
    </a>
    <button class="btn icononly bare ${c.starred ? 'starred' : ''}" data-act="row-star" data-id="${c.id}" aria-label="${c.starred ? 'Remove star' : 'Star'}" aria-pressed="${c.starred}">${icon('star')}</button>
    <button class="btn icononly bare" data-menu="row" data-id="${c.id}" aria-label="More actions for ${esc(c.title || 'this call')}">${icon('more')}</button>
  </div>`;
}

function renderHistory() {
  const el = $('#historyBody');
  if (!el) return;
  if (S.history.q.trim()) return renderResults();
  const calls = S.calls;
  if (!calls) return (el.innerHTML = `<div class="skeleton-rows">${'<div class="skeleton"></div>'.repeat(6)}</div>`);
  const real = calls.filter((c) => c.segmentCount || c.live);
  const empty = calls.filter((c) => !c.segmentCount && !c.live);
  const F = { all: ['All', () => true], starred: ['Starred', (c) => c.starred], open: ['Open ends', (c) => c.counts.todos || c.counts.pending || c.counts.failed], work: ['With agent work', (c) => c.counts.sent] };
  const shown = real.filter(F[S.history.filter][1]);
  const scale = Math.max(300_000, ...shown.map((c) => c.spokenMs));
  const totalMs = real.reduce((a, c) => a + c.spokenMs, 0);
  const sum = (k) => real.reduce((a, c) => a + c.counts[k], 0);
  let rows = '';
  let day = '';
  for (const c of shown) {
    if (dayKey(c.startedAt) !== day) {
      if (day) rows += '</div>';
      day = dayKey(c.startedAt);
      const sameDay = shown.filter((x) => dayKey(x.startedAt) === day);
      rows += `<h2 class="day"><span>${dayLabel(c.startedAt)}</span><em>${plural(sameDay.length, 'call')}, ${span(sameDay.reduce((a, x) => a + x.spokenMs, 0))}</em></h2><div class="call-table">${callTableHeading()}`;
    }
    rows += callRow(c, scale);
  }
  if (day) rows += '</div>';
  el.innerHTML = `
    <div class="history-bar">
      <div class="chips" role="group" aria-label="Filter calls">${Object.entries(F).map(([id, [label, pred]]) => `<button class="chip ${S.history.filter === id ? 'on' : ''}" data-act="hfilter" data-filter="${id}" aria-pressed="${S.history.filter === id}">${label}<b>${real.filter(pred).length}</b></button>`).join('')}</div>
      <p class="totals">${real.length ? `${plural(real.length, 'call')} · ${span(totalMs)} of conversation · ${plural(sum('sent'), 'task')} sent to agents · ${plural(sum('todos'), 'to-do')} open` : ''}</p>
    </div>
    ${rows ? `<div class="scale-note">Each strip is drawn to the same scale: the full width is ${span(scale)}. White is you, blue is them, marks are cues.</div>${rows}` : `<div class="teach wide"><b>${real.length ? 'No calls under this filter.' : 'No calls yet.'}</b><p>${real.length ? '' : 'Every call you run is kept here with its transcript, topics, decisions and the work it started. Search reaches all of it.'}</p>${real.length ? '' : `<a class="btn primary" href="#/live">${icon('play')}Go to the live desk</a>`}</div>`}
    ${empty.length ? `<div class="empties"><span>${plural(empty.length, 'empty capture')} with nothing said.</span><button class="link" data-act="cleanup">Remove ${empty.length === 1 ? 'it' : 'them'}</button></div>` : ''}`;
}

let searchSeq = 0;
async function runSearch() {
  const q = S.history.q.trim();
  const seq = ++searchSeq;
  if (!q) {
    S.history.results = null;
    return renderHistory();
  }
  const results = await api('/api/search?q=' + encodeURIComponent(q)).catch(() => []);
  if (seq !== searchSeq) return;
  S.history.results = results;
  renderResults();
}

function renderResults() {
  const el = $('#historyBody');
  if (!el) return;
  const r = S.history.results;
  const q = S.history.q.trim();
  if (!r) return (el.innerHTML = `<div class="skeleton-rows">${'<div class="skeleton"></div>'.repeat(4)}</div>`);
  const TYPE = { call: 'Title', topic: 'Topic', checkpoint: 'Cue', segment: '' };
  const total = r.reduce((a, c) => a + c.total, 0);
  el.innerHTML = r.length
    ? `<p class="totals">${plural(total, 'match', 'matches')} in ${plural(r.length, 'call')} for "${esc(q)}"</p>` + r.map((c) => `<section class="result">
        <a class="result-call" href="#/call/${c.id}"><b>${marked(c.title || 'Untitled call', q)}</b><span>${dayLabel(c.startedAt)}, ${hm(c.startedAt)}</span></a>
        ${c.hits.filter((h) => h.type !== 'call').map((h) => `<a class="hit ${h.type} ${h.speaker || ''}" href="#/call/${c.id}?${h.type === 'checkpoint' ? 'cp=' + h.cp : 'seg=' + (h.n ?? 0)}">
          <span class="tc">${h.t ? clock(h.t - c.startedAt) : ''}</span>
          <span class="hit-tag">${h.type === 'segment' ? (h.speaker === 'me' ? 'You' : 'Them') : TYPE[h.type]}</span>
          <span class="hit-text">${marked(h.text, q)}</span>
        </a>`).join('')}
        ${c.total > c.hits.length ? `<a class="hit more" href="#/call/${c.id}"><span></span><span></span><span>${c.total - c.hits.length} more in this call</span></a>` : ''}
      </section>`).join('')
    : `<div class="teach wide"><b>Nothing matches "${esc(q)}".</b><p>Search looks at every line of every transcript, the topics and the cues, and ignores accents. Every word has to appear in the same line.</p></div>`;
}

// ---------- outcomes: what calls produced ----------

function renderOutcomes() {
  const main = $('#main');
  const all = S.outcomes;
  if (!all) return (main.innerHTML = `<section class="page"><div class="skeleton-rows">${'<div class="skeleton"></div>'.repeat(6)}</div></section>`);
  const todos = all.filter((x) => x.kind === 'human' && x.status === 'kept');
  const notes = all.filter((x) => x.kind === 'note' && x.status === 'kept');
  const work = all.filter((x) => x.kind === 'agent');
  const openTodos = todos.filter((x) => !x.doneAt);
  const from = (x) => `<a class="from" href="#/call/${x.callId}?cp=${x.id}">${esc(x.callTitle || 'Untitled call')}, ${dateShort(x.callAt)}</a>`;
  const item = (x, body) => `<li data-tone="${meaning(x).tone}" class="out ${x.doneAt ? 'ticked' : ''} st-${x.status}">${body}</li>`;
  const todoList = (S.ledger.hideDone ? openTodos : todos).map((x) => item(x, `
      <button class="tick" role="checkbox" aria-checked="${Boolean(x.doneAt)}" data-act="out-tick" data-call="${x.callId}" data-cp="${x.id}" aria-label="${x.doneAt ? 'Mark as not done' : 'Mark as done'}">${icon('check')}</button>
      <div><b>${esc(x.question.replace(/\?$/, ''))}</b>${x.conclusion && x.conclusion !== x.question ? `<p>${esc(x.conclusion)}</p>` : ''}${from(x)}</div>`)).join('');
  const noteList = notes.map((x) => item(x, `<span class="out-ic">${icon('note')}</span><div><b>${esc(x.bookmark ? 'Bookmark' : x.conclusion)}</b>${x.bookmark || x.question === x.conclusion ? '' : `<p>${esc(x.question)}</p>`}${from(x)}</div>`)).join('');
  const workList = work.map((x) => item(x, `${stateLabel(meaning(x))}<div><b>${esc(x.question.replace(/\?$/, ''))}</b>${x.reply ? `<p class="clamp">${esc(x.reply)}</p>` : x.error ? `<p class="err">${esc(x.error)}</p>` : ''}${from(x)}</div>`)).join('');
  const blank = (title, text) => `<div class="teach"><b>${title}</b><p>${text}</p></div>`;
  main.innerHTML = `<section class="page outcomes">
    <header class="pagehead"><h1>Outcomes</h1><p class="lede">Track your to-dos, saved agreements and agent work.</p></header>
    <div class="ledger">
      <section>
        <div class="ledger-head"><h2>Yours to do</h2><span>${openTodos.length} open</span>${todos.length > openTodos.length ? `<label class="check"><input type="checkbox" data-change="hide-done" ${S.ledger.hideDone ? 'checked' : ''}><span>Hide done</span></label>` : ''}</div>
        ${todoList ? `<ul>${todoList}</ul>` : blank('Nothing waiting on you.', 'When a call ends with something only you can do (call someone, send a number, show up), take the cue and it is kept here until you tick it.')}
      </section>
      <section>
        <div class="ledger-head"><h2>Decisions on record</h2><span>${notes.length}</span></div>
        ${noteList ? `<ul>${noteList}</ul>` : blank('No decisions kept yet.', 'Prices, dates and agreements you keep during a call are listed here, each linked to the moment it was said.')}
      </section>
      <section>
        <div class="ledger-head"><h2>Agent work</h2><span>${work.filter((x) => WORKING.includes(x.status)).length} running</span></div>
        ${workList ? `<ul>${workList}</ul>` : blank('No tasks sent yet.', 'Each task you approve opens a chat in T3 Code. Its status and answer show here and on the call it came from.')}
      </section>
    </div>
  </section>`;
}

// ---------- settings ----------

const SHORTCUTS = [
  ['Y', 'Take the cue on screen'], ['N', 'Skip it'], ['E', 'Edit the cue before taking it'], ['J', 'Next waiting cue'],
  ['B', 'Drop a bookmark at this moment'], ['T', 'Write a task, note or to-do'], ['/', 'Find in the call, or search history'],
  ['Esc', 'Clear the filter or close what is open'], ['1 2 3 4', 'Live, History, Outcomes, Settings'], ['⌘K', 'Search and commands'],
];

function renderSettings() {
  const main = $('#main');
  if (main.dataset.key !== 'settings') return;
  const s = S.settings;
  const h = S.health;
  const choice = (name, value, options, scope) => `<fieldset class="seg-control" aria-label="${name}">${options.map(([id, label]) => `<label><input type="radio" name="${name}" value="${id}" data-change="${scope}" ${String(value) === String(id) ? 'checked' : ''}><span>${label}</span></label>`).join('')}</fieldset>`;
  const toggle = (name, on, scope) => `<label class="switch"><input type="checkbox" name="${name}" data-change="${scope}" ${on ? 'checked' : ''}><i></i></label>`;
  const row = (title, help, control) => `<div class="set"><div><b>${title}</b><p>${help}</p></div><div class="set-control">${control}</div></div>`;
  const withCurrent = (opts, value) => (opts.some(([id]) => id === value) || !value ? opts : [...opts, [value, value]]);
  paint(main, `<section class="page settings">
    <header class="pagehead"><h1>Settings</h1></header>
    <div class="settings-grid">
      <div>
        <h2>Copilot</h2>
        ${row('Brain model', 'Reads the transcript every few sentences. Faster models raise cues sooner, larger ones miss less.', choice('brainModel', s.brainModel, withCurrent([['haiku', 'Haiku'], ['sonnet', 'Sonnet'], ['opus', 'Opus']], s.brainModel), 'server'))}
        ${row('Writes in', 'Language of topics, summaries and cue questions. Agent briefs stay in English.', choice('language', s.language, [['en', 'English'], ['es', 'Español']], 'server'))}
        ${row('Cue sensitivity', 'How sure the copilot must be that something was decided before it interrupts you.', `<div class="range"><input type="range" name="minConfidence" min="0.2" max="0.9" step="0.05" value="${s.minConfidence ?? 0.45}" data-change="server" aria-label="Cue sensitivity"><output>${Math.round((s.minConfidence ?? 0.45) * 100)}%</output></div>`)}
        <h2>Agents</h2>
        ${row('Agent model', 'The model that runs each approved task in T3 Code.', choice('agentModel', s.agentModel, withCurrent([['claude-haiku-5-5', 'Haiku 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-opus-5-5', 'Opus 5.5']], s.agentModel), 'server'))}
        ${row('Recap when a call ends', 'Opens one last chat that records the call in memory: decisions, numbers, open threads.', toggle('autoRecap', s.autoRecap, 'server'))}
        <h2>This window</h2>
        ${row('Theme', 'Dark keeps the window quiet beside a video call. Auto follows the system.', choice('theme', prefs.theme, [['dark', 'Dark'], ['light', 'Light'], ['auto', 'Auto']], 'pref'))}
        ${row('Density', 'Compact fits more rows on a laptop screen.', choice('density', prefs.density, [['comfortable', 'Comfortable'], ['compact', 'Compact']], 'pref'))}
        ${row('Sound on a new cue', 'Two short tones when a decision needs you.', toggle('chime', prefs.chime, 'pref'))}
      </div>
      <div>
        <h2>Keyboard</h2>
        <dl class="keys">${SHORTCUTS.map(([k, what]) => `<div><dt>${k.split(' ').map((x) => `<kbd>${x}</kbd>`).join('')}</dt><dd>${what}</dd></div>`).join('')}</dl>
        <h2>System</h2>
        <dl class="system">
          <div><dt>Local transcription</dt><dd>${h ? `<i class="lamp ${h.whisper ? 'ok' : 'off'}"></i>${h.whisper ? 'Running' : 'Offline. Open Yap.'}` : 'Checking'}</dd></div>
          <div><dt>T3 Code</dt><dd>${h ? `<i class="lamp ${h.t3 ? 'ok' : 'off'}"></i>${h.t3 ? 'Connected' : 'Not connected. Run node callpilot/setup-t3.mjs'}` : 'Checking'}</dd></div>
          <div><dt>Calls are stored in</dt><dd class="path">${esc(h?.data || '')}</dd></div>
          <div><dt>Agents work in</dt><dd class="path">${esc(h?.root || '')}</dd></div>
          <div><dt>Brain spend this session</dt><dd>$${(S.pipeline?.brainCost || 0).toFixed(2)}</dd></div>
        </dl>
        <p class="fine">Audio is transcribed on this Mac and never stored. Removed calls move to a .trash folder beside the others.</p>
      </div>
    </div>
  </section>`);
}

// ---------- actions ----------

async function decide(id, act, edits = {}) {
  const c = cur();
  const cp = c?.checkpoints.find((x) => x.id === id);
  if (!cp) return;
  const before = cp.status;
  if (act === 'go') cp.status = cp.kind === 'agent' ? 'sending' : 'kept';
  if (act === 'skip') cp.status = 'skipped';
  if (act === 'restore') cp.status = 'pending';
  if (S.ui.editing === id) {
    S.ui.editing = null;
    S.ui.drafts = {};
  }
  document.activeElement?.blur?.();
  renderWork();
  try {
    await api(`/api/calls/${c.id}/checkpoints/${id}/${act}`, edits);
    if (act === 'skip') toast('Skipped.', { label: 'Undo', run: () => decide(id, 'restore') });
    if (act === 'go') toast(cp.kind === 'agent' ? 'Sent to an agent.' : cp.kind === 'human' ? 'Added to your to-dos.' : 'Kept on record.');
  } catch (e) {
    cp.status = before;
    renderWork();
    fail(e);
  }
}

function cueEdits(cp) {
  const d = S.ui.drafts;
  const edits = {};
  if (d.task != null && d.task !== cp.task) edits.task = d.task;
  if (d.question != null && d.question !== cp.question) edits.question = d.question;
  if (d.kind && d.kind !== cp.kind) edits.kind = d.kind;
  return edits;
}

/** A destructive button asks once more in place: the first click arms it, the second runs it. */
function armed(el, label) {
  if (el.dataset.armed) return true;
  el.dataset.armed = '1';
  const old = el.innerHTML;
  el.innerHTML = label;
  el.classList.add('armed');
  setTimeout(() => {
    if (!el.isConnected) return;
    delete el.dataset.armed;
    el.innerHTML = old;
    el.classList.remove('armed');
  }, 3500);
  return false;
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    toast('The browser blocked the clipboard.');
    return false;
  }
}
const exportText = (id) => fetch(`/api/calls/${id}/export.md`).then((r) => r.text());

function download(id, title) {
  const a = document.createElement('a');
  a.href = `/api/calls/${id}/export.md`;
  a.download = (title || 'call').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() + '.md';
  a.click();
}

const FOLLOWUP = 'Draft the follow-up message I should send to the other side of this call: what we agreed, what happens next and by when. Write it in the language they spoke and in my voice (read wiki/writing-voice.md first). Reply with the draft only, do not send anything.';


let review = null;
async function prepareReviewCall(id) {
 if (cur()?.id === id) return;
 const c = await api('/api/calls/'+id);
 S.route = {view:'call', id, seg:null, cp:null};
 S.past = c; S.ui = freshUi();
 location.hash = '#/call/'+id;
 render();
}
function showReview({title, help, text, label, run}) {
 const back = S.ui.tab === 'review' ? review?.back || 'focus' : S.ui.tab;
 review = {back, text, run};
 S.ui.tab = 'review'; renderTabs();
 $('#reviewView').innerHTML = `<button class="text-button" data-act="review-back">${icon('left')} Back</button><h1>${esc(title)}</h1><p class="review-help">${esc(help)}</p><pre class="review-text">${esc(text)}</pre><button class="btn review-confirm" data-act="review-confirm">${esc(label)}</button>`;
}
async function reviewExport(id, part = 'summary') {
 const text = await exportText(id);
 await prepareReviewCall(id);
 const body = part === 'summary' ? text.split('## Transcript')[0].trim() : part === 'transcript' ? text.split('## Transcript')[1]?.trim() || '' : text;
 showReview({title: part === 'summary' ? 'Call summary' : part === 'transcript' ? 'Transcript text' : 'Full call record', help:'Review the text below. Copying puts exactly this text on your clipboard.', text:body, label:'Copy this text', run:() => copy(body, 'Copied the text shown above.')});
}
async function reviewAgent(kind, id = cur()?.id) {
 const c = await api('/api/calls/'+id);
 await prepareReviewCall(id);
 const recap = kind === 'recap';
 showReview({title:recap ? 'Record this call in memory' : 'Draft a follow-up', help:recap ? 'Starts a T3 Code agent that writes this call to your persistent memory. This changes your memory records.' : 'Starts a T3 Code agent to draft a message using this call. It will not send the message.', text:recap ? 'The agent receives the transcript path, topic summaries, approved work, kept decisions, your to-dos and unanswered decisions. It is instructed to create a memory entry.\n\n' + (await exportText(id)).split('## Transcript')[0] : FOLLOWUP + '\n\nCall: '+c.title, label:recap ? 'Start agent and write to memory' : 'Start drafting agent', run:() => api(`/api/calls/${id}/${recap ? 'recap' : 'tasks'}`, recap ? {} : {text:FOLLOWUP}).then(() => toast(recap ? 'Memory agent started.' : 'Drafting agent started.'))});
}
function reviewTask(id, action = 'go') {
 const cp = cur().checkpoints.find(x => x.id === id);
 if (cp.kind !== 'agent') return decide(id, action);
 const callId = cur().id;
 showReview({title:'Start this agent task', help:'Starts work in T3 Code using these instructions and the related call context.', text:cp.task, label:'Start agent task', run:() => api(`/api/calls/${callId}/checkpoints/${id}/${action}`, {}).then(() => toast('Agent task started.'))});
}

const ACT = {
 'open-topic'(el) { S.ui.tab='topics'; S.ui.toggled.add(el.dataset.topic); S.ui.interacting=true; renderTopics(); S.ui.interacting=false; renderTabs(); $(`.topic[data-topic="${el.dataset.topic}"]`)?.scrollIntoView({block:'nearest'}); },
 'review-back'() { S.ui.tab = review.back; renderTabs(); },
 async 'review-confirm'(el) { el.disabled = true; try { const result = await review.run(); if (result === false) el.disabled = false; else el.textContent = 'Done'; } catch(e) { el.disabled = false; fail(e); } },
  'refresh-record'() { delete $('#rundown').dataset.update; renderRundown(); $('#refreshRecord').hidden = true; },
  'panel-close'() { S.ui.tab = 'focus'; $('#refreshRecord').hidden = true; renderTabs(); },
  'ask-new'() { S.ui.chat = null; renderAsk(); $('#askInput').focus(); },
  'ask-open'(el) { S.ui.chat = el.dataset.chat; renderAsk(); },
  'ask-suggest'(el) { askSend(el.textContent).catch(fail); },
  'ask-cite'(el) { jumpTo(Number(el.dataset.n)); },
  'ask-stop'() { if (S.ui.chat) callApi(`/chats/${S.ui.chat}/stop`).catch(fail); },
  'ask-copy'() { const m = cur()?.chats?.find((x) => x.id === S.ui.chat)?.messages.filter((x) => x.role === 'ai').at(-1); if (m?.text) copy(m.text.replace(/\s*\[#[^\]]*\]/g, ''), 'Answer copied.'); },
  'ask-delete'() {
    const c = cur(), id = S.ui.chat;
    if (!id) return;
    callApi(`/chats/${id}/delete`).then(() => { c.chats = (c.chats || []).filter((x) => x.id !== id); S.ui.chat = null; renderAsk(); }).catch(fail);
  },
  'compose-open'() { S.ui.tab = 'compose'; renderTabs(); $('#askText').focus(); },
  palette: () => openPalette(),
  async start() {
    try {
      await api('/api/calls/start', {});
      location.hash = '#/live';
    } catch (e) {
      fail(e);
    }
  },
  async end(el) {
    if (!armed(el, 'End now?')) return;
    await api('/api/calls/end', {}).catch(fail);
  },
  'close-call': () => callApi('/close').then(() => toast('Closed where the talking stopped.')).catch(fail),
  star() {
    const c = cur();
    c.starred = !c.starred;
    renderHead();
    callApi('', { starred: c.starred }).catch(fail);
  },
  async 'row-star'(el) {
    const row = S.calls.find((c) => c.id === el.dataset.id);
    await api('/api/calls/' + row.id, { starred: !row.starred }).catch(fail);
    refreshLists(true);
  },
  'home-go'(el) {
    const cp = cur()?.checkpoints.find(x => x.id === el.dataset.cp);
    if (cp?.status === 'pending') decide(cp.id, 'go');
  },
  'cue-go'() {
    const cp = currentCue();
    if (cp) { if (S.ui.tab === 'focus') decide(cp.id, 'go', cueEdits(cp)); else reviewTask(cp.id); }
  },
  'cue-skip'() {
    const cp = currentCue();
    if (cp) decide(cp.id, 'skip');
  },
  'cue-edit'() {
    const cp = currentCue();
    if (!cp) return;
    S.ui.tab = 'focus'; renderTabs();
    S.ui.editing = S.ui.editing === cp.id ? null : cp.id;
    S.ui.drafts = {};
    document.activeElement?.blur?.();
    renderCue();
    $('.cue-edit textarea')?.focus();
  },
  'cue-next'() {
    const list = pendingCues(cur());
    if (list.length < 2) return;
    const at = list.indexOf(currentCue());
    S.ui.cue = list[(at + 1) % list.length].id;
    S.ui.editing = null;
    S.ui.drafts = {};
    renderCue();
  },
  'cp-toggle'(el) {
    const id = el.dataset.cp;
    S.ui.cue = id;
    S.ui.open.has(id) ? S.ui.open.delete(id) : S.ui.open.add(id);
    S.unseen.delete(id);
    const row = el.closest('.card');
    row.classList.toggle('open', S.ui.open.has(id));
    el.setAttribute('aria-expanded', String(S.ui.open.has(id)));
    row.querySelector('.disclosure-content').inert = !S.ui.open.has(id);
  },
  'cp-open': (el) => openCard(el.dataset.cp),
  'cp-go': (el) => reviewTask(el.dataset.cp),
  'cp-skip': (el) => decide(el.dataset.cp, 'skip'),
  'cp-restore': (el) => decide(el.dataset.cp, 'restore'),
  'cp-retry': (el) => reviewTask(el.dataset.cp, 'retry'),
  'cp-done': (el) => decide(el.dataset.cp, 'done'),
  'cp-undone': (el) => decide(el.dataset.cp, 'undone'),
  async 'cp-agent'(el) {
    const cp = cur().checkpoints.find((x) => x.id === el.dataset.cp);
    const text = `${cp.question.replace(/\?$/, '')}. ${cp.conclusion}`;
    const callId = cur().id;
    showReview({title:'Hand this to an agent', help:'Starts a new task in T3 Code using these instructions and the call context.', text, label:'Start agent task', run:() => api(`/api/calls/${callId}/tasks`, {text}).then(() => toast('Agent task started.'))});
  },
  'cp-jump'(el) {
    const cp = cur().checkpoints.find((x) => x.id === el.dataset.cp);
    jumpTo(cp.atSeg);
  },
  'cp-copy'(el) {
    const cp = cur().checkpoints.find((x) => x.id === el.dataset.cp);
    copy(cp.task, 'Agent instructions copied.');
  },
  topic(el) {
    const id = el.dataset.topic;
    S.ui.topic = S.ui.topic === id ? null : id;
    renderStrip();
    renderRundown();
    renderScriptHead();
    renderTranscript(true);
    if (S.ui.topic) {
      S.ui.tab = 'script';
      renderTabs();
    }
  },
  'topic-fold'(el) {
    const id = el.dataset.topic;
    S.ui.toggled.has(id) ? S.ui.toggled.delete(id) : S.ui.toggled.add(id);
    const row = el.closest('.topic');
    row.classList.toggle('open', S.ui.toggled.has(id));
    el.setAttribute('aria-expanded', String(S.ui.toggled.has(id)));
    row.querySelector('.disclosure-content').inert = !S.ui.toggled.has(id);
  },
  'seg-jump': (el) => jumpTo(Number(el.dataset.n)),
  'seg-quote'(el) {
    const s = cur().segments[Number(el.dataset.n)];
    const box = $('#askText');
    S.ui.mode = 'task';
    S.ui.tab = 'compose';
    renderTabs();
    renderComposer();
    const t = $('#askText');
    t.value = `${box?.value ? box.value + '\n' : ''}About "${s.text}": `;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  },
  'seg-edit'(el) {
    const n = Number(el.dataset.n);
    const text = $(`[data-text="${n}"]`);
    const row = el.closest('.seg');
    const segment = cur().segments.find(s => s.t === Number(row.dataset.time) && s.speaker === row.dataset.speaker);
    if (!segment) return toast('This line changed. Refresh the transcript.');
    const original = segment.text;
    text.textContent = original;
    text.contentEditable = 'true';
    text.focus();
    getSelection().selectAllChildren(text);
    const finish = async (save) => {
      text.removeEventListener('keydown', onKey);
      text.removeEventListener('blur', onBlur);
      text.contentEditable = 'false';
      const next = text.textContent.trim();
      if (save && next && next !== original) {
        const current = cur().segments.find(s => s.t === segment.t && s.speaker === segment.speaker && s.text === original);
        if (!current) return toast('This line changed. Open it again to edit.');
        current.text = next;
        await callApi('/segments/' + current.n, { text: next }).then(() => toast('Line corrected.')).catch(fail);
      }
      renderTranscript();
    };
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    };
    const onBlur = () => finish(true);
    text.addEventListener('keydown', onKey);
    text.addEventListener('blur', onBlur);
  },
  filter(el) {
    S.ui.filter = el.dataset.filter;
    S.ui.tab = 'rundown';
    renderTabs();
    renderDesk();
  },
  hfilter(el) {
    S.history.filter = el.dataset.filter;
    renderHistory();
  },
  tab(el) {
    renderRundown();
    S.ui.tab = el.dataset.tab;
    renderTopics();
    renderTabs();
  },
  follow() {
    S.ui.follow = true;
    renderTranscript(true);
    const el = $('#transcript');
    el.scrollTop = el.scrollHeight;
    renderScriptHead();
  },
  'clear-find'() {
    Object.assign(S.ui, { topic: null, find: '', speaker: 'all' });
    renderScriptHead();
    renderTranscript(true);
    renderRundown();
    renderStrip();
  },
  bookmark() {
    const c = cur();
    if (!c) return;
    callApi('/notes', { text: '' }).then(() => toast(`Bookmark at ${clock(endOf(c) - c.startedAt)}.`)).catch(fail);
  },
  followup: () => reviewAgent('followup').catch(fail),
  recap: () => reviewAgent('recap').catch(fail),
  'copy-summary': () => reviewExport(cur().id).catch(fail),
  async cleanup() {
    const r = await api('/api/calls/cleanup', {}).catch(fail);
    if (r) toast(`Removed ${plural(r.removed, 'empty capture')}.`);
    refreshLists(true);
  },
  'out-tick'(el) {
    const x = S.outcomes.find((o) => o.id === el.dataset.cp && o.callId === el.dataset.call);
    const act = x.doneAt ? 'undone' : 'done';
    x.doneAt = x.doneAt ? null : Date.now();
    renderOutcomes();
    api(`/api/calls/${x.callId}/checkpoints/${x.id}/${act}`, {}).catch(fail);
  },
  menu(el) {
    $('#menu').hidePopover();
    MENU[el.dataset.do]?.(el.dataset.id, el);
  },
};

// Menus: one popover, filled on demand and placed under the button that opened it.
const MENU = {
  download: (id) => download(id, (S.calls || []).find((c) => c.id === id)?.title || cur()?.title),
  'copy-summary': id => reviewExport(id).catch(fail),
  'copy-transcript': id => reviewExport(id, 'transcript').catch(fail),
  'copy-all': id => reviewExport(id, 'all').catch(fail),
  recap: id => reviewAgent('recap', id).catch(fail),
  followup: id => reviewAgent('followup', id).catch(fail),
  bookmark: () => ACT.bookmark(),
  rename: () => {
    const t = $('#title');
    t?.focus();
    t?.select();
  },
  open: (id) => (location.hash = '#/call/' + id),
  async remove(id) {
    try {
      await api('/api/calls/' + id, undefined, 'DELETE');
      toast('Call removed. It is in the .trash folder if you need it back.');
      if (S.route.view !== 'history') location.hash = '#/history';
      refreshLists(true);
    } catch (e) {
      fail(e);
    }
  },
};

function showMenu(button) {
  const id = button.dataset.id || cur()?.id;
  const c = cur();
  const item = (what, label, ic, cls = '') => `<button class="${cls}" data-act="menu" data-do="${what}" data-id="${id}">${icon(ic)}${label}</button>`;
  const sets = {
    export: [item('download', 'Download as Markdown', 'download'), item('copy-summary', 'Preview and copy summary', 'copy'), item('copy-transcript', 'Preview and copy transcript', 'copy'), item('copy-all', 'Preview and copy everything', 'copy')],
    call: [
      item('rename', 'Rename', 'edit'),
      onAir(c) ? item('bookmark', 'Drop a bookmark here', 'note') : '',
      item('followup', 'Draft the follow-up message', 'mail'),
      item('recap', c?.recap ? 'Record in memory…' : 'Record in memory…', 'retry'),
      onAir(c) ? '' : '<hr>' + item('remove', 'Remove this call', 'trash', 'danger'),
    ],
    row: [item('open', 'Open', 'chevron'), item('download', 'Download as Markdown', 'download'), item('copy-summary', 'Preview and copy summary', 'copy'), item('recap', 'Record in memory…', 'retry'), '<hr>', item('remove', 'Remove this call', 'trash', 'danger')],
  };
  const menu = $('#menu');
  menu.innerHTML = sets[button.dataset.menu].join('');
  menu.showPopover();
  const r = button.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  menu.style.top = Math.min(innerHeight - menu.offsetHeight - 8, r.bottom + 6) + 'px';
}

// ---------- events ----------

document.addEventListener('click', (e) => {
  const menuBtn = e.target.closest('[data-menu]');
  if (menuBtn) return showMenu(menuBtn);
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  S.ui.interacting = true;
  ACT[el.dataset.act]?.(el, e);
  S.ui.interacting = false;
});

document.addEventListener('mouseover', (e) => {
  const cardEl = e.target.closest?.('.card.unseen');
  if (cardEl) {
    S.unseen.delete(cardEl.dataset.cp);
    cardEl.classList.remove('unseen');
    $(`.flag[data-cp="${cardEl.dataset.cp}"]`)?.classList.remove('unseen');
  }
});

let findTimer = null;
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.draft) S.ui.drafts[t.dataset.draft] = t.value;
  if (t.dataset.input === 'find') {
    S.ui.find = t.value;
    clearTimeout(findTimer);
    findTimer = setTimeout(() => renderTranscript(true), 120);
  }
  if (t.dataset.input === 'hq') {
    S.history.q = t.value;
    clearTimeout(findTimer);
    findTimer = setTimeout(runSearch, 180);
  }
  if (t.name === 'minConfidence') t.nextElementSibling.textContent = Math.round(t.value * 100) + '%';
});

document.addEventListener('change', (e) => {
  const t = e.target;
  const scope = t.dataset.change;
  if (!scope) return;
  const value = t.type === 'checkbox' ? t.checked : t.type === 'range' ? Number(t.value) : t.value;
  if (scope === 'title') {
    const c = cur();
    c.title = t.value.trim();
    callApi('', { title: c.title }).catch(fail);
  } else if (scope === 'speaker') {
    S.ui.speaker = value;
    renderTranscript(true);
  } else if (scope === 'mode') {
    S.ui.mode = value;
    renderComposer();
    $('#askText').focus();
  } else if (scope === 'hide-done') {
    S.ledger.hideDone = value;
    renderOutcomes();
  } else if (scope === 'pref') {
    setPref(t.name, value);
  } else if (scope === 'server') {
    S.settings[t.name] = value;
    api('/api/settings', { [t.name]: value }).then(() => toast('Saved.')).catch(fail);
  }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const kind = form.dataset.form;
  if (kind === 'start') {
    try {
      await api('/api/calls/start', { title: form.title.value.trim() || undefined });
    } catch (err) {
      fail(err);
    }
  } else if (kind === 'compose') {
    const box = $('#askText');
    const text = box.value.trim();
    if (!text) return box.focus();
    box.value = '';
    try {
      if (S.ui.mode === 'task') await callApi('/tasks', { text });
      else await callApi('/notes', { text, kind: S.ui.mode });
      toast(S.ui.mode === 'task' ? 'Sent to an agent.' : S.ui.mode === 'human' ? 'Added to your to-dos.' : 'Note kept.');
    } catch (err) {
      box.value = text;
      fail(err);
    }
  } else if (kind === 'ask') {
    const box = $('#askInput');
    const text = box.value.trim();
    if (!text) return box.focus();
    box.value = '';
    try {
      await askSend(text);
    } catch (err) {
      box.value = text;
      fail(err);
    }
  } else if (kind === 'followup') {
    const input = form.text;
    const text = input.value.trim();
    if (!text) return;
    try {
      await callApi(`/checkpoints/${form.dataset.cp}/followup`, { text });
      input.value = '';
      input.blur();
      toast('Sent to the agent.');
    } catch (err) {
      fail(err);
    }
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return openPalette();
  }
  const t = e.target;
  if (t.id === 'askText' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    return $('#composer').requestSubmit();
  }
  if (t.id === 'askInput' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    return $('#askForm').requestSubmit();
  }
  const typing = t.closest?.('input, textarea, select, [contenteditable="true"]');
  if (e.key === 'Escape') {
    if ($('#palette').open) return;
    if (typing) return t.blur();
    if (S.ui.editing) return ACT['cue-edit']();
    if (cur() && (S.ui.topic || S.ui.find || S.ui.speaker !== 'all')) return ACT['clear-find']();
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey || $('#palette').open) return;
  const key = e.key.toLowerCase();
  const views = { 1: 'live', 2: 'history', 3: 'outcomes', 4: 'settings' };
  if (views[key]) return (location.hash = '#/' + views[key]);
  if (key === '/' && cur()) { S.ui.tab = 'script'; renderTabs(); }
  if (key === '/') {
    const box = $('#find') || $('#hq');
    if (box) {
      e.preventDefault();
      box.focus();
      box.select();
    }
    return;
  }
  if (!cur()) return;
  const map = { y: 'cue-go', n: 'cue-skip', e: 'cue-edit', j: 'cue-next', b: 'bookmark' };
  if (map[key]) {
    if (key !== 'b' && !['focus', 'rundown'].includes(S.ui.tab)) return;
    if (key !== 'b' && S.ui.tab === 'rundown' && !S.ui.open.has(S.ui.cue)) return;
    e.preventDefault();
    return ACT[map[key]]();
  }
  if (key === 't') {
    e.preventDefault();
    ACT['compose-open']();
  }
  if (key === 'a') {
    e.preventDefault();
    openAsk();
  }
});

// ---------- tooltip ----------

const tip = $('#tip');
document.addEventListener('pointerover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el || !el.dataset.tip) return (tip.hidden = true);
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const below = r.top < 60;
  tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  tip.style.top = (below ? r.bottom + 8 : r.top - tip.offsetHeight - 8) + 'px';
});
document.addEventListener('pointerdown', () => (tip.hidden = true));
document.addEventListener('scroll', () => (tip.hidden = true), true);

// ---------- palette ----------

const P = { items: [], at: 0 };

function commands() {
  const c = cur();
  const list = [
    { label: 'Go to the live desk', hint: '1', icon: 'live', run: () => (location.hash = '#/live') },
    { label: 'Go to history', hint: '2', icon: 'history', run: () => (location.hash = '#/history') },
    { label: 'Go to outcomes', hint: '3', icon: 'outcomes', run: () => (location.hash = '#/outcomes') },
    { label: 'Go to settings', hint: '4', icon: 'settings', run: () => (location.hash = '#/settings') },
  ];
  if (S.live && !S.live.endedAt) list.unshift({ label: 'End the call', icon: 'stop', run: () => api('/api/calls/end', {}).catch(fail) });
  else list.unshift({ label: 'Start a call', icon: 'play', run: ACT.start });
  if (c) {
    list.push(
      { label: 'Ask about this call', hint: 'A', icon: 'search', run: () => openAsk() },
      { label: 'Drop a bookmark at this moment', hint: 'B', icon: 'note', run: ACT.bookmark },
      { label: 'Draft the follow-up message', icon: 'mail', run: ACT.followup },
      { label: 'Download this call as Markdown', icon: 'download', run: () => download(c.id, c.title) },
      { label: 'Copy the summary of this call', icon: 'copy', run: ACT['copy-summary'] },
      { label: 'Copy the transcript of this call', icon: 'copy', run: () => MENU['copy-transcript'](c.id) },
    );
  }
  list.push(
    { label: `Switch to the ${document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'} theme`, icon: 'settings', run: () => setPref('theme', document.documentElement.dataset.theme === 'light' ? 'dark' : 'light') },
    { label: `Switch to ${prefs.density === 'compact' ? 'comfortable' : 'compact'} density`, icon: 'settings', run: () => setPref('density', prefs.density === 'compact' ? 'comfortable' : 'compact') },
  );
  return list;
}

function paletteItems(q) {
  const f = fold(q.trim());
  const hit = (label) => !f || f.split(/\s+/).every((t) => fold(label).includes(t));
  const items = commands().filter((x) => hit(x.label));
  for (const c of S.calls || []) {
    if (!c.segmentCount || !hit((c.title || 'Untitled call') + ' ' + c.topics.join(' '))) continue;
    items.push({ label: c.title || 'Untitled call', sub: `${dayLabel(c.startedAt)}, ${hm(c.startedAt)} · ${span(c.durationMs)}`, icon: 'history', run: () => (location.hash = c.live ? '#/live' : '#/call/' + c.id) });
    if (items.length > 40) break;
  }
  if (f && cur()) items.unshift({ label: `Ask this call: "${q.trim()}"`, icon: 'send', run: () => openAsk(q.trim()) });
  if (f) {
    items.push({
      label: `Search every call for "${q.trim()}"`, icon: 'search',
      run() {
        S.history.q = q.trim();
        S.history.results = null;
        if (S.route.view === 'history') {
          $('#hq').value = S.history.q;
          renderHistory();
        } else location.hash = '#/history';
        runSearch();
      },
    });
  }
  return items;
}

function renderPalette() {
  const q = $('#paletteInput').value;
  P.items = paletteItems(q);
  P.at = Math.min(P.at, Math.max(0, P.items.length - 1));
  $('#paletteList').innerHTML = P.items.map((x, i) =>
    `<button role="option" aria-selected="${i === P.at}" class="${i === P.at ? 'on' : ''}" data-i="${i}">${icon(x.icon)}<span><b>${esc(x.label)}</b>${x.sub ? `<em>${esc(x.sub)}</em>` : ''}</span>${x.hint ? `<kbd>${x.hint}</kbd>` : ''}</button>`).join('') || '<p class="palette-none">No command or call matches.</p>';
  $('#paletteList .on')?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  const d = $('#palette');
  if (d.open) return d.close();
  $('#paletteInput').value = '';
  P.at = 0;
  d.showModal();
  renderPalette();
}
function runPalette(i) {
  const x = P.items[i];
  if (!x) return;
  $('#palette').close();
  x.run();
}
$('#paletteInput').addEventListener('input', () => {
  P.at = 0;
  renderPalette();
});
$('#palette').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    P.at = (P.at + (e.key === 'ArrowDown' ? 1 : -1) + P.items.length) % Math.max(1, P.items.length);
    renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    runPalette(P.at);
  }
});
$('#palette').addEventListener('click', (e) => {
  if (e.target === $('#palette')) return $('#palette').close();
  const b = e.target.closest('[data-i]');
  if (b) runPalette(Number(b.dataset.i));
});

// ---------- boot ----------

applyPrefs();
S.route = parseRoute();
if (S.route.view === 'call') loadPast(S.route.id);
if (S.route.view === 'outcomes') loadOutcomes();
render();
connect();
refreshLists(true);
loadHealth();
setInterval(loadHealth, 20_000);
