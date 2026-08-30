#!/usr/bin/env node
/**
 * Configure the local TrueForge harness for Sentinel.
 *
 * The harness is normally configured through its web UI, but every UI action has an
 * HTTP equivalent. Doing it in code means a stranger can clone this repo, add keys,
 * run one command, and have the same agent we demoed — which is the README's promise.
 *
 *   node agent/setup.mjs
 *
 * Idempotent: every call is a PUT or a delete-then-create, so re-running it reconciles
 * rather than duplicating.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// --- env --------------------------------------------------------------------

function loadEnv() {
  const env = { ...process.env };
  for (const file of ['.env', '.env.local']) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

const env = loadEnv();
const BASE = env.TRUEFORGE_URL || 'http://localhost:8790';

const required = ['ANTHROPIC_API_KEY', 'GITHUB_PAT'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}. Copy .env.example and fill it in.`);
  process.exit(1);
}

// --- http -------------------------------------------------------------------

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}\n${text.slice(0, 600)}`);
  }
  return text ? JSON.parse(text) : null;
}

// --- config -----------------------------------------------------------------

/**
 * The judge and orchestrator run on Anthropic. This is not a preference: ORCHESTRA's
 * judges run on gpt-4o-mini, and a model grading its own family's output measures
 * self-consistency rather than quality. Different provider is a correctness constraint.
 */
const MODEL = 'anthropic/claude-sonnet-5';

/**
 * Tools that pause for human approval.
 *
 * These are literal names on purpose. The harness default is ["@write", "@destructive"],
 * and posting a PR comment counts as a write — so the default would pause Sentinel right
 * before it posts its findings. That inverts the whole point: reading, running, and
 * reporting are free; only the two irreversible actions stop for a human.
 */
const GATED = ['merge_pull_request', 'pull_request_review_write'];

async function main() {
  console.log(`TrueForge at ${BASE}`);

  await api('PUT', '/api/v1/settings/model-providers', {
    manifest: {
      type: 'anthropic',
      auth: { api_key: env.ANTHROPIC_API_KEY },
      models: [{
        model_id: 'claude-sonnet-5',
        name: 'claude-sonnet-5',
        properties: { context_length: 200000, max_output_tokens: 64000 },
      }],
    },
  });
  console.log('  model provider: anthropic');

  // Skills are git-backed SKILL.md packs. The harness clones this repo into the
  // sandbox; the agent loads the scoring protocol when it runs the suite.
  await api('PUT', '/api/v1/settings/skills', {
    manifest: {
      type: 'git',
      name: 'sentinel-scoring',
      url: 'https://github.com/ParthGupta1304/sentinal',
      path: 'agent/skills/sentinel-scoring',
      ref: env.SENTINEL_SKILL_REF || 'main',
      description: 'Score eval cases with the noise-floor protocol. A drop is a regression only when it exceeds the base version\'s observed spread.',
    },
  });
  console.log('  skill: sentinel-scoring');

  await api('PUT', '/api/v1/settings/mcp-servers', {
    manifest: {
      type: 'remote',
      name: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      description: 'Read PRs, read files at a ref, post comments, review and merge.',
      auth: { type: 'header', headers: { Authorization: `Bearer ${env.GITHUB_PAT}` } },
    },
  });
  console.log('  mcp server: github');

  const manifest = {
    model: { name: MODEL, params: { temperature: 0 } },
    instructions: readFileSync(join(here, 'instructions.md'), 'utf8'),
    mcp_servers: [{ name: 'github', require_approval_for_tools: GATED }],
    skills: [{ name: 'sentinel-scoring' }],
    config: {
      // Required for skills and for running generated assertion code (§5.3, §6.2).
      sandbox: { enabled: true, file_downloads: true },
      // One subagent per batch of eval cases (§5.4).
      dynamic_sub_agents: { enabled: true },
    },
  };

  // Agents are created, not upserted, so replace any existing one.
  const existing = await api('GET', '/api/v1/agents');
  const prior = (existing.data || []).find((a) => a.name === 'sentinel');
  if (prior) {
    await api('DELETE', `/api/v1/agents/${prior.id ?? prior.name}`);
    console.log('  removed previous sentinel agent');
  }

  const created = await api('POST', '/api/v1/agents', { name: 'sentinel', manifest });
  console.log('  agent: sentinel');
  console.log(`\nGated tools: ${GATED.join(', ')}`);
  console.log('Everything else, including add_issue_comment, runs without approval.');
  console.log(`\nOpen ${BASE} and pick the sentinel agent.`);
  return created;
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
