// The brain: reads the live transcript and keeps a timeline of topics ("islands").
// When a topic lands on a conclusion that implies work, it raises a checkpoint, the
// "should we go with this?" question. Runs through the local Claude Code CLI by default,
// or a local Ollama model when CALLPILOT_BRAIN=ollama.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['callTitle', 'islands', 'checkpoints', 'mood'],
  properties: {
    callTitle: { type: 'string', description: 'Short title for the whole call, 3-7 words.' },
    islands: {
      type: 'array',
      description: 'The full, current list of topics in order of first appearance.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'summary', 'status', 'points', 'firstSeg', 'lastSeg'],
        properties: {
          id: { type: 'string', description: 'Existing id, or new-1, new-2... for a new topic.' },
          title: { type: 'string' },
          summary: { type: 'string', description: 'Two sentences max: where this topic stands now.' },
          status: { type: 'string', enum: ['open', 'concluded'] },
          points: { type: 'array', items: { type: 'string' }, description: 'Up to 5 facts, numbers, names, constraints.' },
          firstSeg: { type: 'integer' },
          lastSeg: { type: 'integer' },
        },
      },
    },
    checkpoints: {
      type: 'array',
      description: 'Only NEW checkpoints raised in this pass. Usually empty.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['islandId', 'kind', 'question', 'conclusion', 'task', 'repo', 'confidence', 'replaces', 'atSeg'],
        properties: {
          islandId: { type: 'string' },
          kind: { type: 'string', enum: ['agent', 'note', 'human'] },
          question: { type: 'string', description: 'Yes/no question, 12 words max, what Alex approves.' },
          conclusion: { type: 'string', description: 'What was decided, 1-2 sentences.' },
          task: { type: 'string', description: 'Self-contained brief for the agent. Empty for note.' },
          repo: { type: 'string', description: 'Repo name from the list, or empty.' },
          confidence: { type: 'number' },
          replaces: { type: 'string', description: 'Id of an earlier checkpoint this supersedes, or empty.' },
          atSeg: { type: 'integer', description: 'Segment where the conclusion was reached.' },
        },
      },
    },
    mood: {
      type: 'object',
      additionalProperties: false,
      required: ['me', 'them', 'note'],
      properties: {
        me: { $ref: '#/$defs/feel' },
        them: { $ref: '#/$defs/feel' },
        note: { type: 'string', description: 'One short line on the room, e.g. "warm, they want a date".' },
      },
    },
  },
  $defs: {
    feel: {
      type: 'object',
      additionalProperties: false,
      required: ['score', 'label'],
      properties: {
        score: { type: 'number', description: '-1 very negative .. 0 neutral .. 1 very positive' },
        label: { type: 'string', description: 'One or two words: engaged, skeptical, rushed, excited...' },
      },
    },
  },
};

const SYSTEM = `You are the live copilot on a call Alex is having. The transcript streams in as you work. It is machine transcribed, mostly Mexican Spanish and English, often mixed in one sentence, and full of small errors: infer what was meant, never repeat a transcription error.

Speakers: ME is Alex. THEM is everyone on the other side (one or more people, not separated).

Each pass you return the whole state:

1. islands. An island is one coherent subject: a feature, a bug, a price, a plan, a person to contact. Group by subject, not by time; a subject that comes back later continues its island. Keep them coarse: 3 to 12 for an hour. Small talk and greetings are not islands. Keep ids stable: return every existing island with its id, add new ones as new-1, new-2. Status becomes concluded once the subject is settled or dropped. Write titles and summaries in English, keep names, products and numbers exactly as said.

2. checkpoints. This is the point of the whole system, so be precise. A checkpoint is the moment a subject reaches a conclusion. Raise one only when:
   - the people agreed or decided something ("vale", "sale", "órale", "perfecto", "va", "let's do it", "ok so we'll", "yes go ahead", an assignment like "can you", "te lo mando"), or the conversation clearly moved on from a settled subject, and
   - the conclusion is concrete enough to act on or worth keeping.
   Never raise one while the subject is still being debated or when the decision is only a guess. One subject can produce more than one checkpoint only if they are separate decisions.
   Never repeat a checkpoint listed under CHECKPOINTS. If the decision behind one materially changed, raise a new one with replaces set to the old id.
   kind:
   - agent: work an AI engineer with full access to Alex's code repos, email drafts, docs and the web can do now: build or fix something, research, draft an email or message, write a plan or spec, prepare a quote.
   - note: a decision or fact worth remembering with no work attached, or a commitment the other side made.
   - human: only Alex can do it (call someone, show up, pay).
   question: a yes/no question Alex answers with one tap mid-call. 12 words max. Start with a verb. Example: "Build the CSV export for the clinic dashboard?"
   task (agent kind): a complete brief the agent can run without hearing the call: what to do, the details and constraints mentioned, the definition of done, the repo if it is clear. Write it in English. For note and human kinds, task is a one-line record.
   confidence: 0..1 that this really is a decided, actionable checkpoint.

3. mood: how each side sounds right now, judged from wording.

Base every claim on the transcript. Segment numbers are in brackets.`;

function reposContext(root) {
  const file = join(root, 'repos.tsv');
  if (!existsSync(file)) return '';
  const rows = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .map(([name, , , summary]) => `- ${name}: ${summary || ''}`);
  return rows.length ? `REPOS Alex works on:\n${rows.join('\n')}\n` : '';
}

const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Word budget for the raw transcript; older text is represented by island summaries. */
const FULL_WORDS = 7000;
const TAIL_WORDS = 3500;

export function buildPrompt(call, { root, lastSeg, final, language }) {
  const segs = call.segments;
  const line = (s) => `[${s.n} ${fmtTime(s.t - call.startedAt)} ${s.speaker === 'me' ? 'ME' : 'THEM'}] ${s.text}`;
  let words = 0;
  let from = segs.length;
  const total = segs.reduce((a, s) => a + s.text.split(/\s+/).length, 0);
  const budget = total > FULL_WORDS ? TAIL_WORDS : Infinity;
  while (from > 0 && words < budget) words += segs[--from].text.split(/\s+/).length;

  const islands = call.islands.map(({ id, title, summary, status, points, firstSeg, lastSeg: l }) => ({
    id, title, summary, status, points, firstSeg, lastSeg: l,
  }));
  const checkpoints = call.checkpoints.map(({ id, islandId, kind, question, status }) => ({ id, islandId, kind, question, status }));
  const older = from > 0 ? `(Segments before #${segs[from].n} are summarized by the islands above.)\n` : '';
  const transcript = segs
    .slice(from)
    .map((s) => (s.n === lastSeg + 1 ? '--- NEW SINCE LAST PASS ---\n' : '') + line(s))
    .join('\n');

  return `${reposContext(root)}
CALL started ${new Date(call.startedAt).toLocaleString('en-GB')}${call.title ? `, current title: ${call.title}` : ''}.

ISLANDS (current state):
${JSON.stringify(islands)}

CHECKPOINTS already raised (do not repeat):
${JSON.stringify(checkpoints)}

TRANSCRIPT:
${older}${transcript}

${final
    ? 'The call has ENDED. Mark every island concluded. Raise checkpoints for every settled subject with a clear next step that has none yet.'
    : 'The call is LIVE. Focus on the new segments. Raise a checkpoint only for conclusions actually reached.'}${language === 'es'
    ? '\nWrite callTitle, island titles, summaries and points, checkpoint questions and conclusions, and the mood labels and note in Mexican Spanish. Agent task briefs stay in English.'
    : ''}`;
}

function runClaude(prompt, model = 'sonnet') {
  const cwd = mkdtempSync(join(tmpdir(), 'yap-brain-'));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CLAUDE_BIN || 'claude',
      [
        '-p', '--model', model, '--output-format', 'json', '--setting-sources', 'local',
        '--tools', '', '--strict-mcp-config', '--no-session-persistence',
        '--json-schema', JSON.stringify(SCHEMA), '--system-prompt', SYSTEM,
      ],
      { cwd, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'yap-callpilot' } },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(j.result || 'brain error'));
        const data = j.structured_output ?? JSON.parse(j.result);
        resolve({ data, cost: j.total_cost_usd || 0, ms: j.duration_ms || 0 });
      } catch (e) {
        reject(new Error(`brain exit ${code}: ${(err || out).slice(0, 400)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

async function runOllama(prompt) {
  const started = Date.now();
  const res = await fetch((process.env.OLLAMA_HOST || 'http://127.0.0.1:11434') + '/api/chat', {
    method: 'POST',
    body: JSON.stringify({
      model: process.env.CALLPILOT_BRAIN_MODEL || 'qwen3:14b',
      stream: false,
      format: SCHEMA,
      options: { temperature: 0.2, num_ctx: 32768 },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const j = await res.json();
  return { data: JSON.parse(j.message.content), cost: 0, ms: Date.now() - started };
}

export async function analyze(call, opts) {
  const prompt = buildPrompt(call, opts);
  return process.env.CALLPILOT_BRAIN === 'ollama' ? runOllama(prompt) : runClaude(prompt, opts.model);
}
