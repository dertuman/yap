// Dedicated Whisper engines for calls: one per side, so you and them transcribe in parallel
// and dictation keeps Yap's own engine (port 8767) to itself. Started when a call starts,
// kept warm for a while after it ends. Everything runs on this Mac (Metal GPU).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.WHISPER_BIN || '/opt/homebrew/bin/whisper-server';
const MODELS = join(homedir(), 'Library/Application Support/Yap/models');
const FALLBACK = process.env.WHISPER_URL || 'http://127.0.0.1:8767';
const IDLE_MS = 15 * 60_000;

/** Strongest model on disk unless one is named: full large-v3 beats turbo on accents and code-switching. */
export function callModel() {
  if (process.env.CALLPILOT_WHISPER_MODEL) return process.env.CALLPILOT_WHISPER_MODEL;
  for (const name of ['ggml-large-v3.bin', 'ggml-large-v3-q5_0.bin', 'ggml-large-v3-turbo.bin', 'ggml-large-v3-turbo-q5_0.bin']) {
    const p = join(MODELS, name);
    if (existsSync(p)) return p;
  }
  return null;
}

const engines = {
  me: { port: 8769, proc: null, ready: false },
  them: { port: 8770, proc: null, ready: false },
};
let idleTimer = null;

async function alive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function start() {
  clearTimeout(idleTimer);
  const model = callModel();
  if (!model || !existsSync(BIN)) return;
  await Promise.all(
    Object.values(engines).map(async (e) => {
      if (e.proc && !e.proc.killed) return;
      if (await alive(e.port)) return void (e.ready = true); // left over from an earlier run
      e.ready = false;
      e.proc = spawn(BIN, [
        '-m', model, '--host', '127.0.0.1', '--port', String(e.port), '--language', 'auto',
        '-t', process.env.CALLPILOT_WHISPER_THREADS || '6',
        '-bs', process.env.CALLPILOT_WHISPER_BEAM || '5', '-bo', '5',
      ], { stdio: 'ignore' });
      e.proc.on('exit', () => {
        e.proc = null;
        e.ready = false;
      });
      for (let i = 0; i < 120 && e.proc; i++) {
        if (await alive(e.port)) {
          e.ready = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }),
  );
}

export function stopLater() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stopNow, IDLE_MS);
}

export function stopNow() {
  for (const e of Object.values(engines)) {
    e.proc?.kill();
    e.proc = null;
    e.ready = false;
  }
}

/** Where a chunk from this side goes: its own engine once loaded, Yap's shared one until then. */
export function urlFor(speaker) {
  const e = engines[speaker];
  return e?.ready ? `http://127.0.0.1:${e.port}` : FALLBACK;
}

export function status() {
  const model = callModel();
  return {
    model: model ? model.split('/').pop() : null,
    me: engines.me.ready,
    them: engines.them.ready,
  };
}

process.on('exit', stopNow);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
