// One-time: issue a local bearer token so Yap can open chats in T3 Code.
// Uses T3 Code's own CLI, bundled in the app. The token stays in ~/.config/yap/t3-token (0600).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const app = process.env.T3_APP || '/Applications/T3 Code (Alpha).app';
const bin = join(app, 'Contents/MacOS', app.split('/').pop().replace(/\.app$/, ''));
const server = join(app, 'Contents/Resources/app.asar/apps/server/dist/bin.mjs');
const out = execFileSync(
  bin,
  [server, 'auth', 'session', 'issue', '--base-dir', join(homedir(), '.t3'), '--label', 'yap call copilot', '--ttl', '3650d', '--token-only', '--log-level', 'none'],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' },
).trim();
if (!out) throw new Error('T3 did not return a token');
mkdirSync(join(homedir(), '.config/yap'), { recursive: true });
writeFileSync(join(homedir(), '.config/yap/t3-token'), out + '\n', { mode: 0o600 });
console.log('T3 token saved to ~/.config/yap/t3-token');
