// Yap Call Copilot: the command center behind a live call.
// Yap streams audio chunks here (your mic as "me", the Mac's output as "them"); they are
// transcribed by the same local whisper-server Yap already runs, a brain pass turns the
// transcript into a timeline of topics and checkpoints, and every checkpoint you approve
// becomes a chat in T3 Code. Audio never leaves the machine.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from './brain.mjs';
import { ask } from './ask.mjs';
import * as t3 from './t3.mjs';
import * as engines from './whisper.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(arg('port') || process.env.PORT || 8768);
const WHISPER = process.env.WHISPER_URL || 'http://127.0.0.1:8767';
const ROOT = process.env.CALLPILOT_ROOT || join(homedir(), 'Documents/GitHub');
const DATA = process.env.CALLPILOT_DATA || join(homedir(), 'Library/Application Support/Yap/calls');
mkdirSync(DATA, { recursive: true });

// ---------- settings ----------

// Options set from the command center. Environment variables only seed the defaults.
const SETTINGS_FILE = process.env.CALLPILOT_SETTINGS || join(homedir(), '.config/yap/callpilot-settings.json');
const SETTING_DEFAULTS = {
  autoRecap: process.env.CALLPILOT_RECAP !== '0',
  brainModel: process.env.CALLPILOT_BRAIN_MODEL || 'sonnet',
  agentModel: process.env.CALLPILOT_AGENT_MODEL || 'claude-opus-5-5',
  minConfidence: 0.45,
  language: 'en',
};
const SETTING_CHECKS = {
  autoRecap: (v) => typeof v === 'boolean',
  brainModel: (v) => typeof v === 'string' && /^[\w.:-]{1,60}$/.test(v),
  agentModel: (v) => typeof v === 'string' && /^[\w.:-]{1,60}$/.test(v),
  minConfidence: (v) => typeof v === 'number' && v >= 0 && v <= 1,
  language: (v) => v === 'en' || v === 'es',
};
const settings = { ...SETTING_DEFAULTS };
try {
  applySettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
} catch {}
function applySettings(patch) {
  for (const [k, v] of Object.entries(patch || {})) if (SETTING_CHECKS[k]?.(v)) settings[k] = v;
  t3.setAgentModel(settings.agentModel);
}
t3.setAgentModel(settings.agentModel);

// ---------- state ----------

let call = null; // the live or most recently viewed call
let draining = false; // the call just ended; chunks still in flight may land
const clients = new Set();
const pipeline = { transcribing: 0, analyzing: false, lastError: null, brainCost: 0, lastPassMs: 0 };

function newCall(title) {
  return {
    id: new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '-' + randomUUID().slice(0, 4),
    title: title || '',
    startedAt: Date.now(),
    endedAt: null,
    segments: [],
    islands: [],
    checkpoints: [],
    mood: [],
    analyzedThrough: -1,
    recap: null,
    capture: { me: 0, them: 0 },
  };
}

const callDir = (id) => join(DATA, id);

// Every call this process has touched, by id. The server is the only writer of call.json,
// so the copy in memory is the truth and past calls stay editable while another one is live.
const cache = new Map();
function getCall(id) {
  if (call && call.id === id) return call;
  if (cache.has(id)) return cache.get(id);
  const file = join(callDir(id), 'call.json');
  if (!existsSync(file)) return null;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    cache.set(id, c);
    return c;
  } catch {
    return null;
  }
}

function writeCall(c) {
  mkdirSync(callDir(c.id), { recursive: true });
  writeFileSync(join(callDir(c.id), 'call.json'), JSON.stringify(c));
}
const saveTimers = new Map();
/** The live call saves on a short delay (segments arrive in bursts); everything else at once. */
function saveCall(c) {
  if (c !== call) return writeCall(c);
  clearTimeout(saveTimers.get(c.id));
  saveTimers.set(c.id, setTimeout(() => {
    saveTimers.delete(c.id);
    writeCall(c);
  }, 500));
}
const save = () => call && saveCall(call);

/** Tells every open page what changed: fine-grained events for the live call, one "changed" for the rest. */
function touch(c, ...kinds) {
  if (c === call) {
    for (const k of kinds) emit(k, k === 'call' ? meta(c) : c[k]);
  }
  emit('changed', { id: c.id });
  saveCall(c);
}

function transcriptMarkdown(c) {
  const t = (ms) => {
    const s = Math.round((ms - c.startedAt) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const lines = c.segments.map((s) => `[${t(s.t)}] **${s.speaker === 'me' ? 'Me' : 'Them'}:** ${s.text}`);
  return `# ${c.title || 'Call'}\n\n${new Date(c.startedAt).toLocaleString('en-GB')}\n\n${lines.join('\n\n')}\n`;
}

function writeTranscript(c = call) {
  if (!c) return null;
  mkdirSync(callDir(c.id), { recursive: true });
  const file = join(callDir(c.id), 'transcript.md');
  writeFileSync(file, transcriptMarkdown(c));
  return file;
}

function emit(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
const emitPipeline = () => emit('pipeline', pipeline);

// ---------- transcription ----------

// Whisper fills silence and noise with stock phrases. Drop them.
const HALLUCINATIONS = [
  /^(thank you|thanks)( (so much|very much|for watching))?[.!]?$/i,
  /^(gracias|muchas gracias)( por ver(lo)?)?[.!]?$/i,
  /subt[ií]tulos/i,
  /amara\.org/i,
  /^\W*(music|música|musica|applause|aplausos|silence|silencio|risas|laughter)\W*$/i,
  /^[\s.…,!?¿¡-]*$/,
  /^(you|bye|adiós|hmm+|mm+)[.!]?$/i,
  /suscr[ií]bete|subscribe/i,
];

// One queue per side, each feeding its own engine, so both sides transcribe at once.
const queues = { me: [], them: [] };
const busy = { me: false, them: false };
const inflight = { me: null, them: null };
const backlog = () => queues.me.length + queues.them.length + (busy.me ? 1 : 0) + (busy.them ? 1 : 0);
const whisperIdle = () => !backlog() && !held.length;

function enqueueAudio(speaker, t0, dur, wav, themOpen = 0) {
  queues[speaker].push({ speaker, t0, dur, wav, themOpen });
  if (speaker === 'them') releaseHeld();
  pipeline.transcribing = backlog();
  emitPipeline();
  pump(speaker);
}

async function pump(speaker) {
  if (busy[speaker] || !queues[speaker].length) return;
  busy[speaker] = true;
  const job = queues[speaker].shift();
  inflight[speaker] = job;
  const started = Date.now();
  try {
    const text = await transcribe(job.wav, promptFor(job.speaker), engines.urlFor(speaker));
    if (text) ingest(job.speaker, text, job.t0, job.dur, job.themOpen);
    pipeline.lastError = null;
    pipeline.sttMs = Date.now() - started;
  } catch (e) {
    pipeline.lastError = 'whisper: ' + e.message;
  }
  busy[speaker] = false;
  inflight[speaker] = null;
  if (speaker === 'them') releaseHeld();
  pipeline.transcribing = backlog();
  emitPipeline();
  pump(speaker);
}

function promptFor(speaker) {
  // Recent words steer spelling, names and the language mix of the next chunk.
  // The fixed bilingual opener stops Whisper from translating Spanish into English when the
  // recent text happens to be English (it reads the prompt as the language to write in).
  const primer = 'Hola, ¿qué tal? Okay, let\'s do it. Vale, perfecto.';
  if (!call) return primer;
  const recent = call.segments.slice(-6).map((s) => s.text).join(' ');
  return primer + ' ' + recent.slice(-180);
}

async function transcribe(wav, prompt, base = WHISPER) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');
  form.append('temperature', '0.0');
  form.append('response_format', 'json');
  if (prompt) form.append('prompt', prompt);
  const res = await fetch(base + '/inference', { method: 'POST', body: form });
  if (!res.ok) throw new Error(String(res.status));
  const j = await res.json();
  return clean(j.text || '');
}

function clean(text) {
  const flat = text.replace(/\n/g, '').split(/\s+/).filter(Boolean).join(' ').trim();
  if (!flat || HALLUCINATIONS.some((r) => r.test(flat))) return '';
  return flat;
}

const words = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);

// ---------- echo ----------
// Without headphones the mic hears the other side through the speakers, so "me" gets a copy
// of what "them" said, starting a few ms later. The mic chunk is often shorter and finishes
// transcribing first, so checking only against "them" text already in hand lets most echoes
// through. Instead each "me" line waits until every "them" chunk that overlaps it has been
// transcribed (Yap says when a "them" chunk was still open as the mic chunk closed), then gets
// compared. A line that waited too long goes in anyway and is pulled back out if its "them"
// twin turns up before the brain reads it.

const HOLD_MAX_MS = 20_000;
const held = []; // { text, t, dur, themOpen, at }
let holdTimer = null;

function echoes(me, them) {
  if (them.t > me.t + me.dur + 2000 || them.t + them.dur < me.t - 2000) return false;
  const mine = new Set(words(me.text));
  if (!mine.size) return false;
  const theirs = new Set(words(them.text));
  let shared = 0;
  for (const w of mine) if (theirs.has(w)) shared++;
  // An echo starts within a speaker delay of the original; same start is strong evidence on its own.
  const aligned = Math.abs(me.t - them.t) < 800;
  if (mine.size < 2 && !aligned) return false;
  return shared / mine.size >= (aligned ? 0.5 : 0.6);
}

function isEcho(me, segments = call.segments.slice(-30)) {
  const theirs = segments.filter((s) => s.speaker === 'them');
  if (theirs.some((s) => echoes(me, s))) return true;
  // The two streams split at different pauses, so one mic chunk can span two "them" chunks.
  // Against their joined text, ask for more: enough words that common ones cannot carry it.
  const overlapping = theirs.filter((s) => s.t < me.t + me.dur + 1000 && s.t + s.dur > me.t - 1000);
  if (overlapping.length < 2) return false;
  const mine = new Set(words(me.text));
  if (mine.size < 4) return false;
  const joined = new Set(overlapping.flatMap((s) => words(s.text)));
  let shared = 0;
  for (const w of mine) if (joined.has(w)) shared++;
  return shared / mine.size >= 0.7;
}

/** Removes echoed "me" lines from a stored call and points topics and checkpoints at the lines that remain. */
function scrubEchoes(c) {
  const before = c.segments;
  const keep = before.map((s) => !(s.speaker === 'me' && isEcho(s, before)));
  const removed = keep.filter((k) => !k).length;
  if (!removed) return 0;
  const newIndex = [];
  let n = 0;
  for (let i = 0; i < before.length; i++) newIndex[i] = keep[i] ? n++ : -1;
  const last = n - 1;
  // A pointer at a removed line moves to the nearest kept line: forward for starts, back for ends.
  const fwd = (i) => { if (i == null) return i; for (let j = Math.max(0, i); j < before.length; j++) if (keep[j]) return newIndex[j]; return last; };
  const back = (i) => { if (i == null) return i; for (let j = Math.min(i, before.length - 1); j >= 0; j--) if (keep[j]) return newIndex[j]; return 0; };
  c.segments = before.filter((_, i) => keep[i]);
  c.segments.forEach((s, i) => (s.n = i));
  for (const i of c.islands || []) { i.firstSeg = fwd(i.firstSeg); i.lastSeg = Math.max(i.firstSeg, back(i.lastSeg)); }
  for (const x of c.checkpoints || []) if (x.atSeg != null) x.atSeg = back(x.atSeg);
  if (c.analyzedThrough != null) c.analyzedThrough = back(c.analyzedThrough);
  return removed;
}

/** True while a "them" chunk that could overlap [t, end] is queued, being transcribed, or still recording. */
function themPending(h) {
  const end = h.t + h.dur + 1000;
  if (queues.them.some((j) => j.t0 < end) || (inflight.them && inflight.them.t0 < end)) return true;
  if (!h.themOpen) return false;
  // Yap said a "them" chunk opened at themOpen and had not closed yet. Wait for it to arrive.
  const arrived = [...queues.them, inflight.them, ...call.segments.filter((s) => s.speaker === 'them').slice(-8).map((s) => ({ t0: s.t }))]
    .some((j) => j && j.t0 >= h.themOpen - 400);
  return !arrived;
}

function releaseHeld() {
  clearTimeout(holdTimer);
  if (!call) return (held.length = 0);
  for (let i = 0; i < held.length; i++) {
    const h = held[i];
    if (themPending(h) && Date.now() - h.at < HOLD_MAX_MS) continue;
    held.splice(i--, 1);
    if (!isEcho(h)) addSegment('me', h.text, h.t, h.dur);
  }
  if (held.length) holdTimer = setTimeout(releaseHeld, 500);
}

/** A "them" line arrived: drop "me" lines the brain has not read yet that turn out to be echoes. */
function dropLateEchoes() {
  let dropped = false;
  for (let i = call.segments.length - 1; i > call.analyzedThrough; i--) {
    const s = call.segments[i];
    if (s.speaker === 'me' && isEcho(s)) {
      call.segments.splice(i, 1);
      dropped = true;
    }
  }
  if (dropped) call.segments.forEach((s, i) => (s.n = i));
}

function ingest(speaker, text, t0, dur, themOpen = 0) {
  if (!call || (call.endedAt && !draining)) return null;
  if (speaker === 'me') {
    held.push({ text, t: t0, dur, themOpen, at: Date.now() });
    releaseHeld();
    return { held: true };
  }
  const seg = addSegment('them', text, t0, dur);
  if (seg) dropLateEchoes();
  releaseHeld();
  return seg;
}

function addSegment(speaker, text, t0 = Date.now(), dur = 0) {
  if (!call || (call.endedAt && !draining)) return null;
  const seg = { n: call.segments.length, speaker, text, t: t0, dur };
  // Chunks finish out of order across the two streams. Keep the transcript in time order.
  let at = call.segments.length;
  while (at > 0 && call.segments[at - 1].t > t0) at--;
  call.segments.splice(at, 0, seg);
  call.segments.forEach((s, i) => (s.n = i));
  if (at <= call.analyzedThrough) call.analyzedThrough = at - 1;
  emit('segments', call.segments.slice(-40));
  save();
  scheduleAnalysis();
  return seg;
}

// ---------- brain ----------

const MIN_NEW_WORDS = 25;
const MAX_WAIT_MS = 20_000;
let analysisTimer = null;
let lastPassAt = 0;

function newWords() {
  return call.segments.slice(call.analyzedThrough + 1).reduce((a, s) => a + s.text.split(/\s+/).length, 0);
}

function scheduleAnalysis() {
  if (!call || call.endedAt || pipeline.analyzing) return;
  const fresh = newWords();
  if (!fresh) return;
  const since = Date.now() - lastPassAt;
  if (fresh >= MIN_NEW_WORDS && since > 8000) return runAnalysis();
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => runAnalysis(), Math.max(1500, MAX_WAIT_MS - since));
}

async function runAnalysis({ final = false } = {}) {
  if (!call || pipeline.analyzing) return;
  if (!final && !newWords()) return;
  clearTimeout(analysisTimer);
  const target = call;
  const through = target.segments.length - 1;
  pipeline.analyzing = true;
  lastPassAt = Date.now();
  emitPipeline();
  try {
    const { data, cost, ms } = await analyze(target, { root: ROOT, lastSeg: target.analyzedThrough, final, model: settings.brainModel, language: settings.language });
    applyAnalysis(target, data, through);
    pipeline.brainCost += cost;
    pipeline.lastPassMs = ms;
    pipeline.lastError = null;
  } catch (e) {
    pipeline.lastError = 'brain: ' + e.message;
    console.error(e);
  }
  pipeline.analyzing = false;
  emitPipeline();
  if (target === call && !final) scheduleAnalysis();
}

function applyAnalysis(c, data, through) {
  c.analyzedThrough = Math.max(c.analyzedThrough, through);
  if (data.callTitle && !c.titleLocked) c.title = data.callTitle;

  // Map the brain's new-N ids to stable ids.
  const idMap = {};
  const known = new Map(c.islands.map((i) => [i.id, i]));
  const islands = [];
  for (const i of data.islands || []) {
    let id = i.id;
    if (!known.has(id)) {
      id = 'i' + randomUUID().slice(0, 6);
      idMap[i.id] = id;
    }
    const prev = known.get(id);
    islands.push({ ...prev, ...i, id, createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now() });
    known.delete(id);
  }
  // An island the brain dropped stays if it carries a checkpoint, so the timeline never loses decisions.
  for (const left of known.values()) {
    if (c.checkpoints.some((cp) => cp.islandId === left.id)) islands.push(left);
  }
  islands.sort((a, b) => a.firstSeg - b.firstSeg);
  c.islands = islands;

  for (const cp of data.checkpoints || []) {
    if (cp.confidence < settings.minConfidence) continue;
    const islandId = idMap[cp.islandId] || cp.islandId;
    // Guard against repeats the brain missed: same island, same kind, similar question, still open or decided.
    const dup = c.checkpoints.find(
      (o) => o.islandId === islandId && o.kind === cp.kind && o.id !== cp.replaces && similar(o.question, cp.question),
    );
    if (dup) continue;
    const replaced = cp.replaces && c.checkpoints.find((o) => o.id === cp.replaces);
    if (replaced && replaced.status === 'pending') replaced.status = 'superseded';
    const seg = c.segments[Math.min(cp.atSeg ?? through, c.segments.length - 1)];
    c.checkpoints.push({
      id: 'c' + randomUUID().slice(0, 6),
      ...cp,
      islandId,
      status: 'pending',
      at: seg?.t || Date.now(),
      createdAt: Date.now(),
    });
  }

  if (data.mood) c.mood.push({ t: Date.now(), ...data.mood });
  touch(c, 'call', 'islands', 'checkpoints', 'mood');
}

function similar(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return false;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.7;
}

// ---------- agent ----------

function excerpt(c, cp) {
  const island = c.islands.find((i) => i.id === cp.islandId);
  if (!island) return '';
  const from = Math.max(0, island.firstSeg);
  const to = Math.min(c.segments.length - 1, Math.max(island.lastSeg, cp.atSeg ?? 0) + 2);
  const lines = c.segments.slice(from, to + 1).map((s) => `${s.speaker === 'me' ? 'Me' : 'Them'}: ${s.text}`);
  const text = lines.join('\n');
  return text.length > 6000 ? '...\n' + text.slice(-6000) : text;
}

function taskMessage(c, cp) {
  const island = c.islands.find((i) => i.id === cp.islandId);
  const when = new Date(cp.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const intro = c.endedAt
    ? `Task from a call I had ("${c.title || 'call'}", ${new Date(c.startedAt).toLocaleDateString('en-GB')}, decided at ${when}). I approved it after the call`
    : `Task from a call I am on right now ("${c.title || 'call'}", decided at ${when}). I approved it mid-call`;
  return `${intro}, so run it without asking me questions; make sensible calls and list any assumptions at the end.

${cp.task}
${cp.repo ? `\nRepo: ${cp.repo}` : ''}
Decision: ${cp.conclusion}
${island ? `\nTopic: ${island.title}. ${island.summary}${island.points?.length ? '\n- ' + island.points.join('\n- ') : ''}` : ''}

Transcript of that part of the call (machine transcribed, expect errors):
"""
${excerpt(c, cp)}
"""

Follow the home repo and project rules. Do not push or deploy unless the task says so. Finish with a 1-3 sentence result.`;
}

async function dispatch(c, cp) {
  cp.status = 'sending';
  cp.error = null;
  cp.reply = '';
  touch(c, 'checkpoints');
  try {
    cp.threadId = await t3.startThread({
      root: ROOT,
      title: `Call: ${cp.question.replace(/\?$/, '')}`,
      text: taskMessage(c, cp),
    });
    cp.status = 'queued';
    cp.sentAt = Date.now();
  } catch (e) {
    cp.status = 'failed';
    cp.error = e.message;
  }
  touch(c, 'checkpoints');
}

const KINDS = ['agent', 'note', 'human'];

/** Every way a checkpoint changes hands: go, skip, restore, retry, done, undone, or a plain edit. */
async function decide(c, id, decision, edits = {}) {
  const cp = c?.checkpoints.find((x) => x.id === id);
  if (!cp) throw new Error('unknown checkpoint');
  const inFlight = ['sending', 'queued', 'running'].includes(cp.status);
  if (typeof edits.task === 'string' && edits.task.trim()) cp.task = edits.task;
  if (typeof edits.question === 'string' && edits.question.trim()) cp.question = edits.question.trim();
  if (typeof edits.conclusion === 'string') cp.conclusion = edits.conclusion.trim();
  if (KINDS.includes(edits.kind) && !cp.threadId) cp.kind = edits.kind;
  if (decision === 'go') {
    if (inFlight) return cp;
    cp.decidedAt = Date.now();
    if (cp.kind === 'agent') await dispatch(c, cp);
    else cp.status = 'kept'; // notes and to-dos ride along in the recap
  } else if (decision === 'skip') {
    if (inFlight) throw new Error('already with the agent');
    cp.decidedAt = Date.now();
    cp.status = 'skipped';
  } else if (decision === 'restore') {
    if (inFlight) throw new Error('already with the agent');
    cp.status = 'pending';
    cp.decidedAt = null;
    cp.doneAt = null;
  } else if (decision === 'retry') {
    if (cp.kind !== 'agent') throw new Error('only agent tasks can be retried');
    if (!inFlight) await dispatch(c, cp);
  } else if (decision === 'done') {
    cp.doneAt = Date.now();
  } else if (decision === 'undone') {
    cp.doneAt = null;
  }
  touch(c, 'checkpoints');
  return cp;
}

function manualCheckpoint(c, fields) {
  const cp = {
    id: 'c' + randomUUID().slice(0, 6),
    islandId: '',
    repo: '',
    confidence: 1,
    replaces: '',
    atSeg: c.segments.length - 1,
    manual: true,
    at: c.endedAt || Date.now(),
    createdAt: Date.now(),
    ...fields,
  };
  // Hang it on the topic being discussed at that moment, when there is one.
  const island = c.islands.find((i) => cp.atSeg >= i.firstSeg && cp.atSeg <= i.lastSeg && i.status === 'open')
    || [...c.islands].reverse().find((i) => cp.atSeg >= i.firstSeg);
  if (island && !c.endedAt) cp.islandId = island.id;
  c.checkpoints.push(cp);
  return cp;
}

/** A task you type or say to the command center, sent straight to the agent. */
async function manualTask(c, text) {
  if (!c) throw new Error('no call');
  if (!text) throw new Error('empty task');
  const cp = manualCheckpoint(c, {
    kind: 'agent',
    question: text.length > 80 ? text.slice(0, 77) + '...' : text,
    conclusion: c.endedAt ? 'Asked directly by Alex after the call.' : 'Asked directly by Alex during the call.',
    task: text + '\n\nUse the call transcript for context if needed: ' + writeTranscript(c),
    status: 'pending',
  });
  await dispatch(c, cp);
  return cp;
}

/** A note, a to-do or a bare bookmark dropped by hand. Kept at once, no question asked. */
function manualNote(c, text, kind) {
  if (!c) throw new Error('no call');
  const body = text || 'Bookmark';
  const cp = manualCheckpoint(c, {
    kind: kind === 'human' ? 'human' : 'note',
    question: body.length > 80 ? body.slice(0, 77) + '...' : body,
    conclusion: text ? body : 'Marked by hand to come back to.',
    task: body,
    status: 'kept',
    bookmark: !text,
    decidedAt: Date.now(),
  });
  touch(c, 'checkpoints');
  return cp;
}

// ---------- ask: quick questions about a call, kept as chats on the call ----------

const asking = new Map(); // chatId -> { cancel }
const chatMeta = (c, ch) => ({ ...ch, callId: c.id });

async function askCall(c, text, chatId) {
  if (!text) throw new Error('empty question');
  c.chats ||= [];
  let chat = chatId && c.chats.find((x) => x.id === chatId);
  if (chatId && !chat) throw new Error('no such chat');
  if (chat && asking.has(chat.id)) throw new Error('still answering');
  if (!chat) {
    chat = { id: randomUUID().slice(0, 8), title: text.length > 80 ? text.slice(0, 77) + '...' : text, createdAt: Date.now(), messages: [] };
    c.chats.unshift(chat);
  }
  const now = Date.now();
  chat.messages.push({ role: 'me', text, at: now });
  const answer = { role: 'ai', text: '', at: now, pending: true };
  chat.messages.push(answer);
  chat.updatedAt = now;
  touch(c, 'chats');
  emit('chat', chatMeta(c, chat));

  let last = 0;
  const job = ask(c, { ...chat, messages: chat.messages.slice(0, -1) }, {
    model: settings.brainModel,
    onDelta: (t) => {
      answer.text = t;
      if (Date.now() - last > 60) {
        last = Date.now();
        emit('chat-delta', { callId: c.id, chatId: chat.id, text: t });
      }
    },
  });
  asking.set(chat.id, job);
  job.done
    .then((r) => Object.assign(answer, { text: r.text, cost: r.cost, ms: r.ms }))
    .catch((e) => {
      answer.text = job.partial() || answer.text;
      answer.error = e.message;
    })
    .finally(() => {
      asking.delete(chat.id);
      delete answer.pending;
      chat.updatedAt = Date.now();
      touch(c, 'chats');
      emit('chat', chatMeta(c, chat));
    });
  return chatMeta(c, chat);
}

/** Every chat across calls, newest first, for the history list. */
function allChats() {
  const out = [];
  for (const id of callIds()) {
    const c = getCall(id);
    for (const ch of c?.chats || []) {
      out.push({ callId: c.id, callTitle: c.title, id: ch.id, title: ch.title, updatedAt: ch.updatedAt || ch.createdAt, turns: ch.messages.filter((m) => m.role === 'me').length, last: ch.messages.at(-1)?.text?.slice(0, 200) || '' });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Watch the chats every call started until they finish.
const ACTIVE = ['queued', 'running'];
setInterval(async () => {
  const all = new Set(cache.values());
  if (call) all.add(call);
  for (const c of all) {
    const live = c.checkpoints.filter((cp) => cp.threadId && ACTIVE.includes(cp.status));
    const recap = c.recap && ACTIVE.includes(c.recap.status) ? [c.recap] : [];
    if (!live.length && !recap.length) continue;
    let changed = false;
    for (const item of [...live, ...recap]) {
      try {
        const s = await t3.threadStatus(item.threadId);
        if (s.state !== item.status || s.reply !== item.reply) {
          Object.assign(item, { status: s.state, reply: s.reply, error: s.error || item.error });
          if (s.state === 'done' || s.state === 'failed') item.finishedAt = Date.now();
          changed = true;
        }
      } catch (e) {
        item.error = e.message;
      }
    }
    if (changed) touch(c, 'checkpoints', 'call');
  }
}, 3000);

function recapMessage(c, file) {
  const by = (pred) => c.checkpoints.filter(pred);
  const list = (items, fmt) => (items.length ? items.map(fmt).join('\n') : '- none');
  const slug = (c.title || 'call').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `A call just ended ("${c.title || 'call'}", ${new Date(c.startedAt).toLocaleString('en-GB')}, ${Math.round((endOf(c) - c.startedAt) / 60000)} min). Full transcript: ${file}

Topics:
${list(c.islands, (i) => `- ${i.title}: ${i.summary}`)}

Tasks I sent to agents during the call (each has its own T3 chat titled "Call: ..."):
${list(by((x) => x.threadId), (x) => `- ${x.question} [${x.status}]`)}

Decisions and facts I kept:
${list(by((x) => x.status === 'kept' && x.kind === 'note'), (x) => `- ${x.conclusion}`)}

To-dos for me:
${list(by((x) => x.status === 'kept' && x.kind === 'human'), (x) => `- ${x.question} ${x.conclusion}`)}

Skipped or never answered:
${list(by((x) => ['skipped', 'pending', 'superseded'].includes(x.status)), (x) => `- ${x.question}`)}

Record this call in memory: one entry with scripts/mem add calls/${slug} "<gist>" -r <repos the call touched, or home> -d "<decisions, numbers, names, open threads, to-dos, transcript path>". Read the transcript only if something above is unclear. Do not start any other work. Reply with a 3-line recap.`;
}

/** Opens the recap chat for a call. Runs by itself at the end of a call, or again on request. */
async function sendRecap(c) {
  if (c.recap && ['sending', ...ACTIVE].includes(c.recap.status)) return c.recap;
  const file = writeTranscript(c);
  c.recap = { status: 'sending' };
  touch(c, 'call');
  try {
    c.recap.threadId = await t3.startThread({ root: ROOT, title: `Call recap: ${c.title || 'call'}`, text: recapMessage(c, file) });
    c.recap.status = 'queued';
    c.recap.sentAt = Date.now();
  } catch (e) {
    c.recap = { status: 'failed', error: e.message };
  }
  touch(c, 'call');
  return c.recap;
}

async function endCall() {
  if (!call || call.endedAt) return call;
  const c = call;
  c.endedAt = Date.now();
  emit('call', meta(c));
  // Let in-flight chunks land, then one last pass over the whole call.
  const deadline = Date.now() + 20_000;
  draining = true;
  while (!whisperIdle() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  for (const h of held.splice(0)) if (!isEcho(h)) addSegment('me', h.text, h.t, h.dur);
  draining = false;
  while (pipeline.analyzing && Date.now() < deadline + 60_000) await new Promise((r) => setTimeout(r, 300));
  writeTranscript(c);
  if (c.segments.length) {
    c.endedAt = Date.now();
    await runAnalysis({ final: true });
  }
  writeTranscript(c);
  engines.stopLater();
  if (settings.autoRecap && !c.noRecap && c.segments.length >= 3) await sendRecap(c);
  touch(c, 'call');
  return c;
}

// ---------- history ----------

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** When a call stopped: its end, or the last thing heard if the server went away mid-call. */
function endOf(c) {
  if (c.endedAt) return c.endedAt;
  if (c === call) return Date.now();
  const last = c.segments[c.segments.length - 1];
  return last ? last.t + (last.dur || 0) : c.startedAt;
}

/** One row of the history: enough to draw the call without loading it. */
function summarize(c) {
  const count = (pred) => c.checkpoints.filter(pred).length;
  const talk = { me: 0, them: 0 };
  for (const s of c.segments) talk[s.speaker] += s.dur || s.text.split(/\s+/).length * 380;
  return {
    ...meta(c),
    live: c === call && !c.endedAt,
    interrupted: !c.endedAt && c !== call,
    durationMs: Math.max(0, endOf(c) - c.startedAt),
    // Where the talking stopped. A call left open for hours is still drawn at the length of its conversation.
    spokenMs: Math.max(0, (c.segments.length ? c.segments[c.segments.length - 1].t + (c.segments[c.segments.length - 1].dur || 0) : c.startedAt) - c.startedAt),
    starred: Boolean(c.starred),
    topics: c.islands.map((i) => i.title),
    talk,
    counts: {
      checkpoints: c.checkpoints.length,
      pending: count((x) => x.status === 'pending'),
      sent: count((x) => x.threadId),
      working: count((x) => ['sending', ...ACTIVE].includes(x.status)),
      done: count((x) => x.status === 'done'),
      failed: count((x) => x.status === 'failed'),
      kept: count((x) => x.status === 'kept'),
      todos: count((x) => x.kind === 'human' && x.status === 'kept' && !x.doneAt),
      chats: (c.chats || []).length,
    },
    // Speech blocks as [ms from start, ms long, 0 me | 1 them] and checkpoints as [ms from start, kind, status].
    strip: {
      segs: c.segments.map((s) => [s.t - c.startedAt, s.dur || 1500, s.speaker === 'me' ? 0 : 1]),
      cps: c.checkpoints.filter((x) => x.status !== 'superseded').map((x) => [x.at - c.startedAt, x.kind, x.status]),
    },
  };
}

function callIds() {
  return readdirSync(DATA)
    .filter((d) => !d.startsWith('.') && existsSync(join(DATA, d, 'call.json')))
    .sort()
    .reverse();
}

function listCalls() {
  return callIds().slice(0, 300).map(getCall).filter(Boolean).map(summarize);
}

/** Full-text search over every call: what was said, the topics and the checkpoints. Every word must match. */
function search(q) {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const match = (text) => {
    const f = fold(text);
    return terms.every((t) => f.includes(t));
  };
  const out = [];
  for (const id of callIds()) {
    const c = getCall(id);
    if (!c) continue;
    const hits = [];
    if (match(c.title)) hits.push({ type: 'call', text: c.title });
    for (const i of c.islands) {
      const text = [i.title, i.summary, ...(i.points || [])].join(' · ');
      if (match(text)) hits.push({ type: 'topic', text: `${i.title}. ${i.summary}`, n: i.firstSeg, t: c.segments[i.firstSeg]?.t });
    }
    for (const x of c.checkpoints) {
      if (match([x.question, x.conclusion, x.reply].join(' '))) hits.push({ type: 'checkpoint', kind: x.kind, status: x.status, text: x.question, more: x.conclusion, n: x.atSeg, t: x.at, cp: x.id });
    }
    for (const ch of c.chats || []) {
      const hit = ch.messages.find((m) => match(m.text));
      if (hit) hits.push({ type: 'chat', text: ch.title, more: hit.role === 'ai' ? hit.text.slice(0, 240) : '', chat: ch.id });
    }
    for (const s of c.segments) {
      if (match(s.text)) hits.push({ type: 'segment', speaker: s.speaker, text: s.text, n: s.n, t: s.t });
    }
    if (hits.length) out.push({ id: c.id, title: c.title, startedAt: c.startedAt, total: hits.length, hits: hits.slice(0, 12) });
    if (out.length >= 40) break;
  }
  return out;
}

/** Everything calls produced, across all of them: to-dos, decisions on record, agent work. */
function outcomes() {
  const out = [];
  for (const id of callIds()) {
    const c = getCall(id);
    if (!c) continue;
    for (const x of c.checkpoints) {
      if (x.status !== 'kept' && !x.threadId) continue;
      out.push({
        callId: c.id, callTitle: c.title, callAt: c.startedAt,
        id: x.id, kind: x.kind, status: x.status, question: x.question, conclusion: x.conclusion,
        repo: x.repo, at: x.at, doneAt: x.doneAt || null, reply: x.reply || '', error: x.error || null,
        bookmark: Boolean(x.bookmark), finishedAt: x.finishedAt || null,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

function exportMarkdown(c) {
  const mins = Math.round((endOf(c) - c.startedAt) / 60000);
  const by = (pred) => c.checkpoints.filter(pred);
  const sec = (title, lines) => (lines.length ? `## ${title}\n\n${lines.join('\n')}\n\n` : '');
  const head = `# ${c.title || 'Call'}\n\n${new Date(c.startedAt).toLocaleString('en-GB')}, ${mins} min\n\n`;
  const topics = c.islands.map((i) => `### ${i.title}\n\n${i.summary}\n${(i.points || []).map((p) => `- ${p}`).join('\n')}\n`);
  const body = transcriptMarkdown(c).split('\n').slice(4).join('\n');
  return head
    + sec('Topics', topics)
    + sec('Decisions', by((x) => x.kind === 'note' && x.status === 'kept').map((x) => `- ${x.conclusion}`))
    + sec('To-dos', by((x) => x.kind === 'human' && x.status === 'kept').map((x) => `- [${x.doneAt ? 'x' : ' '}] ${x.question.replace(/\?$/, '')}. ${x.conclusion}`))
    + sec('Agent tasks', by((x) => x.threadId).map((x) => `- ${x.question.replace(/\?$/, '')} (${x.status})${x.reply ? `\n  ${x.reply.replace(/\n+/g, '\n  ')}` : ''}`))
    + sec('Left open', by((x) => ['pending', 'skipped'].includes(x.status)).map((x) => `- ${x.question}`))
    + `## Transcript\n\n${body}`;
}

function trashCall(id) {
  const c = getCall(id);
  if (!c) throw new Error('not found');
  if (c === call && !c.endedAt) throw new Error('that call is live');
  mkdirSync(join(DATA, '.trash'), { recursive: true });
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  renameSync(callDir(id), join(DATA, '.trash', `${id}-${Date.now()}`));
  cache.delete(id);
  if (call === c) {
    call = null;
    emit('snapshot', snapshot());
  }
  emit('changed', { id, removed: true });
}

// ---------- http ----------

const meta = (c) =>
  c && {
    id: c.id,
    title: c.title,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    recap: c.recap,
    capture: c.capture,
    segmentCount: c.segments.length,
    starred: Boolean(c.starred),
  };

function snapshot() {
  return { call: call && { ...meta(call), segments: call.segments, islands: call.islands, checkpoints: call.checkpoints, mood: call.mood, chats: call.chats || [] }, pipeline, settings };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

async function body(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return Buffer.concat(chunks);
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let m0;
  try {
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    // Yap polls this to know when to capture, and its floating panel shows the pending checkpoint.
    if (req.method === 'GET' && p === '/api/state') {
      const live = call && !call.endedAt;
      const pending = live ? call.checkpoints.filter((c) => c.status === 'pending') : [];
      return json(res, 200, {
        active: Boolean(live),
        callId: call?.id || null,
        title: call?.title || '',
        startedAt: call?.startedAt || null,
        pending: pending.map(({ id, kind, question, conclusion }) => ({ id, kind, question, conclusion })),
        running: live ? call.checkpoints.filter((c) => ['sending', 'queued', 'running'].includes(c.status)).length : 0,
      });
    }
    if (req.method === 'POST' && p === '/api/calls/start') {
      const b = JSON.parse((await body(req)).toString() || '{}');
      if (call && !call.endedAt) return json(res, 200, meta(call));
      if (call) cache.set(call.id, call);
      call = newCall(b.title);
      if (b.title) call.titleLocked = true;
      if (b.recap === false) call.noRecap = true;
      lastPassAt = 0;
      engines.start().then(() => {
        pipeline.engines = engines.status();
        emitPipeline();
      });
      Object.assign(pipeline, { transcribing: 0, analyzing: false, lastError: null, brainCost: 0 });
      emit('snapshot', snapshot());
      emit('changed', { id: call.id });
      save();
      return json(res, 200, meta(call));
    }
    if (req.method === 'POST' && p === '/api/calls/end') {
      const c = call;
      json(res, 200, meta(c));
      if (c) endCall();
      return;
    }
    // A call the server lost mid-way (crash, restart) has no end. Close it where the talking stopped.
    if (req.method === 'POST' && (m0 = p.match(/^\/api\/calls\/([\w-]+)\/close$/))) {
      const c = getCall(m0[1]);
      if (!c) return json(res, 404, { error: 'not found' });
      if (!c.endedAt && c !== call) {
        c.endedAt = endOf(c);
        writeTranscript(c);
        touch(c, 'call');
      }
      return json(res, 200, meta(c));
    }
    if (req.method === 'POST' && p === '/api/audio') {
      const speaker = url.searchParams.get('stream') === 'them' ? 'them' : 'me';
      const wav = await body(req);
      if (!call || call.endedAt) return json(res, 200, { active: false });
      call.capture[speaker] = Date.now();
      enqueueAudio(speaker, Number(url.searchParams.get('t0')) || Date.now(), Number(url.searchParams.get('dur')) || 0, wav, Number(url.searchParams.get('themOpen')) || 0);
      return json(res, 200, { active: true });
    }
    // Capture heartbeat: Yap says which streams are alive even when nobody talks.
    if (req.method === 'POST' && p === '/api/capture') {
      const b = JSON.parse((await body(req)).toString() || '{}');
      if (call && !call.endedAt) {
        call.capture = { ...call.capture, ...b, at: Date.now() };
        emit('call', meta(call));
      }
      return json(res, 200, { active: Boolean(call && !call.endedAt) });
    }
    if (req.method === 'POST' && p === '/api/segments') {
      const b = JSON.parse((await body(req)).toString());
      const seg = ingest(b.speaker === 'them' ? 'them' : 'me', b.text, b.t || Date.now(), b.dur || 0, b.themOpen || 0);
      return json(res, 200, seg || { dropped: true });
    }
    let m;
    const read = async () => JSON.parse((await body(req)).toString() || '{}');
    // The Yap panel answers the live call's checkpoints here; the page uses the call-scoped routes below.
    if (req.method === 'POST' && (m = p.match(/^\/api\/checkpoints\/([\w-]+)\/(go|skip)$/))) {
      if (!call) return json(res, 404, { error: 'no call' });
      return json(res, 200, await decide(call, m[1], m[2], await read()));
    }
    if (req.method === 'POST' && p === '/api/tasks') {
      const b = await read();
      return json(res, 200, await manualTask(call, String(b.text || '').trim()));
    }
    if (req.method === 'POST' && p === '/api/title') {
      const b = await read();
      if (call) {
        call.title = String(b.title || '').trim();
        call.titleLocked = true;
        touch(call, 'call');
      }
      return json(res, 200, meta(call));
    }
    if (req.method === 'POST' && p === '/api/analyze') {
      runAnalysis();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/calls') return json(res, 200, listCalls());
    if (req.method === 'GET' && p === '/api/search') return json(res, 200, search(url.searchParams.get('q') || ''));
    if (req.method === 'GET' && p === '/api/outcomes') return json(res, 200, outcomes());
    if (req.method === 'GET' && p === '/api/chats') return json(res, 200, allChats());
    if (req.method === 'GET' && p === '/api/settings') return json(res, 200, settings);
    if (req.method === 'POST' && p === '/api/settings') {
      applySettings(await read());
      mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      emit('settings', settings);
      return json(res, 200, settings);
    }
    // Empty captures (a call started and stopped with nothing said) only clutter the history.
    if (req.method === 'POST' && p === '/api/calls/cleanup') {
      const empty = callIds().map(getCall).filter((c) => c && !c.segments.length && !(c === call && !c.endedAt));
      for (const c of empty) trashCall(c.id);
      return json(res, 200, { removed: empty.length });
    }

    // Past calls recorded before the echo hold went in: strip "me" lines that were the other side.
    if (req.method === 'POST' && p === '/api/calls/scrub-echoes') {
      const out = {};
      for (const c of callIds().map(getCall)) {
        if (!c || (c === call && !c.endedAt)) continue;
        const removed = scrubEchoes(c);
        if (!removed) continue;
        out[c.id] = removed;
        writeTranscript(c);
        touch(c, 'call', 'segments', 'islands', 'checkpoints');
      }
      return json(res, 200, { removed: out });
    }

    if ((m = p.match(/^\/api\/calls\/([\w-]+)(?:\/(.+))?$/)) && !['start', 'end', 'cleanup', 'scrub-echoes'].includes(m[1])) {
      const c = getCall(m[1]);
      const sub = m[2] || '';
      if (!c) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET' && !sub) return json(res, 200, c);
      if (req.method === 'GET' && sub === 'export.md') {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(exportMarkdown(c));
      }
      if (req.method === 'DELETE' && !sub) {
        trashCall(c.id);
        return json(res, 200, { ok: true });
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
      const b = await read();
      if (!sub) {
        if (typeof b.title === 'string') {
          c.title = b.title.trim();
          c.titleLocked = true;
        }
        if (typeof b.starred === 'boolean') c.starred = b.starred;
        touch(c, 'call');
        return json(res, 200, meta(c));
      }
      // Older pages switched the server onto a past call to look at it. Kept for them.
      if (sub === 'open') {
        if (call && !call.endedAt) return json(res, 409, { error: 'a call is live' });
        if (call) cache.set(call.id, call);
        call = c;
        emit('snapshot', snapshot());
        return json(res, 200, meta(call));
      }
      let k;
      if ((k = sub.match(/^checkpoints\/([\w-]+)\/(go|skip|restore|retry|done|undone|edit)$/))) {
        return json(res, 200, await decide(c, k[1], k[2], b));
      }
      if ((k = sub.match(/^checkpoints\/([\w-]+)\/followup$/))) {
        const cp = c.checkpoints.find((x) => x.id === k[1]);
        if (!cp?.threadId) return json(res, 404, { error: 'no chat for that checkpoint' });
        await t3.sendMessage(cp.threadId, String(b.text || ''));
        cp.status = 'queued';
        touch(c, 'checkpoints');
        return json(res, 200, cp);
      }
      if (sub === 'tasks') return json(res, 200, await manualTask(c, String(b.text || '').trim()));
      if (sub === 'notes') return json(res, 200, manualNote(c, String(b.text || '').trim(), b.kind));
      if (sub === 'recap') return json(res, 200, await sendRecap(c));
      if (sub === 'ask') return json(res, 200, await askCall(c, String(b.text || '').trim(), b.chatId || null));
      if ((k = sub.match(/^chats\/([\w-]+)\/(stop|delete)$/))) {
        const i = (c.chats || []).findIndex((x) => x.id === k[1]);
        if (i < 0) return json(res, 404, { error: 'no such chat' });
        if (k[2] === 'stop') asking.get(k[1])?.cancel();
        else {
          asking.get(k[1])?.cancel();
          c.chats.splice(i, 1);
          touch(c, 'chats');
        }
        return json(res, 200, { ok: true });
      }
      // Fix what Whisper misheard. An empty text removes the line.
      if ((k = sub.match(/^segments\/(\d+)$/))) {
        const seg = c.segments[Number(k[1])];
        if (!seg) return json(res, 404, { error: 'no such line' });
        seg.text = String(b.text || '').trim();
        seg.edited = true;
        if (c === call) emit('segments', c.segments);
        touch(c);
        if (c.endedAt) writeTranscript(c);
        return json(res, 200, seg);
      }
      return json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && p === '/api/retire') {
      if (call && !call.endedAt) return json(res, 409, { error: 'a call is live' });
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, {
        ok: true,
        t3: await t3.available(),
        whisper: await fetch(WHISPER).then(() => true, () => false),
        data: DATA,
        root: ROOT,
        brain: process.env.CALLPILOT_BRAIN === 'ollama' ? 'ollama' : 'claude',
      });
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      const file = join(HERE, 'ui', p === '/' ? 'index.html' : p.slice(1));
      if (!file.startsWith(join(HERE, 'ui')) || !existsSync(file)) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(readFileSync(file));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message });
  }
});

/**
 * Yap keeps talking to the command center it already found, so two of them means a call started
 * on the new page is never captured. The newcomer asks the old one to stop, unless it is mid-call.
 */
function retirePrevious(url) {
  for (const old of new Set([advertised()?.url, 'http://127.0.0.1:8768'])) {
    if (!old || old === url) continue;
    fetch(old + '/api/state', { signal: AbortSignal.timeout(1500) })
      .then((r) => r.json())
      .then((st) => !st.active && fetch(old + '/api/retire', { method: 'POST' }))
      .catch(() => {});
  }
}
function advertised() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.config/yap/callpilot.json'), 'utf8'));
  } catch {
    return null;
  }
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  // Yap reads this to find a command center that is already running (a dev server, say).
  // A scratch instance (tests, demos) sets CALLPILOT_QUIET so Yap never sends a real call to it.
  if (!process.env.CALLPILOT_QUIET) {
    retirePrevious(url);
    mkdirSync(join(homedir(), '.config/yap'), { recursive: true });
    writeFileSync(join(homedir(), '.config/yap/callpilot.json'), JSON.stringify({ url, pid: process.pid }));
  }
  console.log(`Call copilot on ${url}`);
});
