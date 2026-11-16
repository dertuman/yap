// Drives T3 Code through its local HTTP API: one chat per approved task, plus a recap chat.
// Auth is a bearer token issued once by `t3 auth session issue` (see README), kept in
// ~/.config/yap/t3-token. Nothing here leaves the machine except what T3 itself sends to the model.
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_FILE = join(homedir(), '.config/yap/t3-token');
const RUNTIME_FILE = join(homedir(), '.t3/userdata/server-runtime.json');

function origin() {
  if (process.env.T3_ORIGIN) return process.env.T3_ORIGIN;
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')).origin;
  } catch {
    return 'http://127.0.0.1:3773';
  }
}

function token() {
  if (process.env.T3_TOKEN) return process.env.T3_TOKEN;
  return existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : null;
}

async function call(path, body) {
  const t = token();
  if (!t) throw new Error('No T3 token. Run: node callpilot/setup-t3.mjs');
  const res = await fetch(origin() + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`T3 ${path} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const now = () => new Date().toISOString();

let model = process.env.CALLPILOT_AGENT_MODEL || 'claude-opus-5-5';
/** The command center's settings pick the model the agent chats run on. */
export const setAgentModel = (m) => {
  if (m) model = m;
};
export const agentModel = () => ({
  instanceId: process.env.CALLPILOT_AGENT_PROVIDER || 'claudeAgent',
  model,
  options: [],
});

// CALLPILOT_T3=mock stands in for T3 Code: chats "run" for a few seconds and answer with a
// canned line. For demos and tests of the command center, so nothing real is dispatched.
const MOCK = process.env.CALLPILOT_T3 === 'mock';
const mockThreads = new Map();

let projectCache = null;
/** The T3 project whose folder is the workspace root (the home repo by default). */
export async function projectId(root) {
  if (process.env.CALLPILOT_T3_PROJECT) return process.env.CALLPILOT_T3_PROJECT;
  if (projectCache?.root === root) return projectCache.id;
  const shell = await call('/api/orchestration/shell');
  const match = shell.projects.find((p) => p.workspaceRoot === root && !p.deletedAt);
  if (!match) throw new Error(`No T3 project for ${root}. Add that folder as a project in T3 Code.`);
  projectCache = { root, id: match.id };
  return match.id;
}

export async function available() {
  if (MOCK) return true;
  try {
    // The session endpoint answers 200 for a revoked token too; only `authenticated` tells.
    const s = await call('/api/auth/session');
    return s?.authenticated === true;
  } catch {
    return false;
  }
}

/** Opens a new chat in T3 Code and sends the first message. Returns the thread id. */
export async function startThread({ root, title, text }) {
  const threadId = randomUUID();
  if (MOCK) {
    mockThreads.set(threadId, { at: Date.now(), title });
    return threadId;
  }
  const modelSelection = agentModel();
  const common = { runtimeMode: 'full-access', interactionMode: 'default' };
  await call('/api/orchestration/dispatch', {
    type: 'thread.create',
    commandId: randomUUID(),
    threadId,
    projectId: await projectId(root),
    title: title.slice(0, 90),
    modelSelection,
    ...common,
    branch: null,
    worktreePath: null,
    createdAt: now(),
  });
  await call('/api/orchestration/dispatch', {
    type: 'thread.turn.start',
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: 'user', text, attachments: [] },
    modelSelection,
    ...common,
    createdAt: now(),
  });
  return threadId;
}

/** Sends a follow-up message into an existing chat. */
export async function sendMessage(threadId, text) {
  if (MOCK) return void mockThreads.set(threadId, { ...mockThreads.get(threadId), at: Date.now(), followup: text });
  await call('/api/orchestration/dispatch', {
    type: 'thread.turn.start',
    commandId: randomUUID(),
    threadId,
    message: { messageId: randomUUID(), role: 'user', text, attachments: [] },
    modelSelection: agentModel(),
    runtimeMode: 'full-access',
    interactionMode: 'default',
    createdAt: now(),
  });
}

/** Status of a chat: queued | running | done | failed, plus the latest assistant text. */
export async function threadStatus(threadId) {
  if (MOCK) {
    const t = mockThreads.get(threadId) || { at: 0, title: '' };
    const age = Date.now() - t.at;
    const done = `Done. ${t.followup ? 'Applied your follow-up: ' + t.followup : t.title.replace(/^Call( recap)?: /, '')}. Changed 3 files in the repo, tests pass. Assumed the existing date filter component is reused.`;
    if (age < 2500) return { state: 'queued', reply: '', streaming: false, error: null, title: t.title };
    if (age < 11000) return { state: 'running', reply: 'Reading the repo and the transcript excerpt...', streaming: true, error: null, title: t.title };
    return { state: 'done', reply: done, streaming: false, error: null, title: t.title };
  }
  const { thread } = await call(`/api/orchestration/threads/${threadId}`);
  const turn = thread.latestTurn;
  const assistant = [...(thread.messages || [])].reverse().find((m) => m.role === 'assistant');
  let state = 'queued';
  if (turn?.state === 'running' || thread.session?.activeTurnId) state = 'running';
  else if (turn?.state === 'completed') state = 'done';
  else if (turn?.state === 'error' || turn?.state === 'interrupted') state = 'failed';
  return {
    state,
    reply: assistant?.text?.trim() || '',
    streaming: Boolean(assistant?.streaming),
    error: thread.session?.lastError || null,
    title: thread.title,
  };
}
