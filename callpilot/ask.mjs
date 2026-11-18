// Ask: a quick consultation about one call. Alex asks a question ("what use cases did he
// mention?"), the model reads the whole transcript plus the topics and decisions, and answers
// with segment citations. Each chat is a thread kept on the call, so the history stays with it.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYSTEM = `You answer Alex's questions about a call he had. You get the full transcript, the topics the copilot extracted and the decisions raised.

The transcript is machine transcribed, mostly Mexican Spanish and English, often mixed, with errors: infer what was meant and never repeat a transcription error as fact. ME is Alex. THEM is everyone on the other side (one or more people, not separated).

Rules:
- Answer from the call. If the call does not say it, say so plainly, then add what you can infer and mark it as inference.
- Lead with the answer. Short paragraphs or a tight list. No preamble, no closing offer.
- Cite the lines you rely on as [#n] using the segment numbers, e.g. "He wants offline mode [#41]". Cite sparingly: one or two per claim.
- Keep names, products, numbers and prices exactly as said.
- Answer in the language of the question.
- Never use em dashes. No emoji.`;

const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** ~400k chars is far inside the model's window and covers a multi-hour call. */
const MAX_CHARS = 400_000;

export function callContext(c) {
  const lines = c.segments.map((s) => `[#${s.n ?? c.segments.indexOf(s)} ${fmtTime(s.t - c.startedAt)} ${s.speaker === 'me' ? 'ME' : 'THEM'}] ${s.text}`);
  let transcript = lines.join('\n');
  if (transcript.length > MAX_CHARS) transcript = '(earlier lines cut for length)\n' + transcript.slice(-MAX_CHARS);
  const topics = c.islands.map((i) => `- ${i.title}: ${i.summary}${i.points?.length ? ` (${i.points.join('; ')})` : ''}`).join('\n');
  const decisions = c.checkpoints
    .filter((x) => x.status !== 'superseded')
    .map((x) => `- [${x.kind}, ${x.status}] ${x.question}${x.conclusion ? ` Decided: ${x.conclusion}` : ''}${x.reply ? ` Agent result: ${x.reply.slice(0, 400)}` : ''}`)
    .join('\n');
  return `CALL: ${c.title || 'Untitled'}, ${new Date(c.startedAt).toLocaleString('en-GB')}${c.endedAt ? `, ended after ${fmtTime(c.endedAt - c.startedAt)}` : ', still live'}.

TOPICS:
${topics || '(none yet)'}

DECISIONS:
${decisions || '(none yet)'}

TRANSCRIPT:
${transcript || '(nothing said yet)'}`;
}

function prompt(c, chat) {
  const turns = chat.messages.filter((m) => m.text);
  const last = turns.at(-1);
  const earlier = turns.slice(0, -1).map((m) => `${m.role === 'me' ? 'ALEX' : 'YOU'}: ${m.text}`).join('\n\n');
  return `${callContext(c)}

${earlier ? `EARLIER IN THIS CHAT:\n${earlier}\n\n` : ''}ALEX ASKS: ${last.text}`;
}

/**
 * Streams an answer. onDelta gets the text so far; resolves with { text, cost, ms }.
 * Returns { done, cancel }.
 */
export function ask(c, chat, { model = 'sonnet', onDelta } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'yap-ask-'));
  const child = spawn(
    process.env.CLAUDE_BIN || 'claude',
    [
      '-p', '--model', model, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--setting-sources', 'local', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
      '--system-prompt', SYSTEM,
    ],
    { cwd, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'yap-callpilot' } },
  );
  let text = '';
  let buf = '';
  let err = '';
  let result = null;
  const done = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const ev = j.type === 'stream_event' ? j.event : null;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
          text += ev.delta.text;
          onDelta?.(text);
        } else if (j.type === 'result') {
          result = j;
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (result && !result.is_error) {
        return resolve({ text: (result.result || text).trim(), cost: result.total_cost_usd || 0, ms: result.duration_ms || 0 });
      }
      if (child.killed && !result) return reject(new Error(text ? 'stopped' : 'Stopped before an answer.'));
      reject(new Error(result?.result || `ask exit ${code}: ${(err || text).slice(0, 300)}`));
    });
    child.stdin.end(prompt(c, chat));
  });
  return { done, cancel: () => child.kill('SIGTERM'), partial: () => text };
}
