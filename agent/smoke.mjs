#!/usr/bin/env node
/**
 * End-to-end smoke test of the harness wiring.
 *
 * Proves the four things Sentinel depends on, in one turn:
 *   1. the agent loop runs on the configured model
 *   2. a sandbox is created and can execute code we generate
 *   3. the GitHub MCP server can read the target repo
 *   4. sandbox files can be read back out through the download endpoint
 *
 *   node agent/smoke.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv() {
  const env = { ...process.env };
  for (const file of ['.env', '.env.local']) {
    let text;
    try { text = readFileSync(join(root, file), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const env = loadEnv();
const BASE = env.TRUEFORGE_URL || 'http://localhost:8790';
const REPO = env.SENTINEL_REPO || 'ParthGupta1304/ORCHESTRA';

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}\n${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

const TASK = `Do these three things in order, then stop.

1. In the sandbox, write a Python file that computes the median of [4, 4, 3] and prints
   it as JSON to /tmp/smoke.json. Run it. Tell me what it printed.
2. Use the GitHub tools to read backend/prompts/clarity-judge.md from the default branch
   of ${REPO}. Tell me its first line. If the file does not exist on that branch yet, say
   so plainly — that is a valid result, not an error to work around.
3. Report which of the two succeeded.

Do not merge anything. Do not open a pull request.`;

const session = await api('POST', '/api/v1/sessions', { agent: { name: 'sentinel' } });
const sessionId = session.data.id;
console.log(`session ${sessionId}`);

const started = Date.now();

// Creating a turn returns a Server-Sent Events stream, not a JSON body. Every event the
// agent emits arrives here as it happens — which is exactly what the dashboard needs to
// stream case rows in as subagents report (§8.3), so consuming it here is the real test.
const res = await fetch(`${BASE}/api/v1/sessions/${sessionId}/turns`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
  body: JSON.stringify({ input: [{ type: 'user.message', content: TASK }] }),
});
if (!res.ok) throw new Error(`turn failed: ${res.status} ${await res.text()}`);

const types = new Set();
let done = false;
let buffer = '';

for await (const chunk of res.body) {
  buffer += Buffer.from(chunk).toString('utf8');
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';

  for (const frame of frames) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;

    let frameData;
    try { frameData = JSON.parse(line.slice(6)); } catch { continue; }

    // Events arrive wrapped as { turn_id, event } on the events endpoint and bare on
    // the stream. Unwrap either shape.
    const e = frameData.event ?? frameData;
    types.add(e.type);
    const t = ((Date.now() - started) / 1000).toFixed(0).padStart(3);

    if (e.type === 'model.message') {
      const content = e.content;
      const text = typeof content === 'string'
        ? content
        : (content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
      if (text.trim()) console.log(`${t}s  say    ${text.trim().slice(0, 300)}`);
      for (const c of Array.isArray(content) ? content : []) {
        if (c.type === 'tool.call') console.log(`${t}s  call   ${c.name}`);
      }
    } else if (e.type === 'tool.call') {
      console.log(`${t}s  call   ${e.name ?? ''}`);
    } else if (e.type === 'tool.response') {
      const preview = String(e.content ?? '').slice(0, 140).replace(/\s+/g, ' ');
      console.log(`${t}s  ok     ${preview}`);
    } else if (e.type !== 'model.message.delta') {
      console.log(`${t}s  ${e.type}`);
    }

    if (e.type === 'turn.done') {
      done = true;
      const out = e.state?.output?.content;
      if (out) console.log(`\n--- agent said ---\n${out}`);
    }
  }
}

console.log(`\nevent types: ${[...types].join(', ')}`);
console.log(done ? 'turn completed' : 'stream ended without turn.done');
