#!/usr/bin/env node
/**
 * Harvest real submission inputs for the eval suite (§6.6 step 1).
 *
 * Synthetic inputs are drawn from the same distribution the model is already good at,
 * so they flatter it. These are real repositories, fetched through the same calls
 * ORCHESTRA's own parser makes, and formatted into the exact string its judges receive:
 *
 *     === GITHUB METADATA ===
 *     === LANGUAGE BREAKDOWN ===
 *     === README ===
 *     === FILE STRUCTURE ===
 *     === RECENT COMMITS (last 10) ===
 *
 * Matching that shape matters. A case built on a differently-shaped input is testing a
 * situation the prompt never sees in production.
 *
 *   node evals/harvest.mjs
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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
const headers = { Accept: 'application/vnd.github+json' };
if (env.GITHUB_PAT) headers.Authorization = `Bearer ${env.GITHUB_PAT}`;

async function gh(path, accept) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: accept ? { ...headers, Accept: accept } : headers,
  });
  if (!res.ok) return null;
  return accept === 'application/vnd.github.raw' ? res.text() : res.json();
}

/** Mirrors backend/pipeline/parser.js parseGithub, so fixtures match production inputs. */
async function parseGithub(repo) {
  const meta = await gh(`/repos/${repo}`);
  if (!meta) throw new Error(`could not fetch ${repo}`);

  let out = '\n=== GITHUB METADATA ===\n';
  out += `Description: ${meta.description || 'N/A'}\n`;
  out += `Primary Language: ${meta.language || 'N/A'}\n`;
  out += `Created At: ${meta.created_at}\n`;
  out += `Open Issues: ${meta.open_issues_count}\n\n`;

  const langs = await gh(`/repos/${repo}/languages`);
  if (langs && Object.keys(langs).length) {
    out += '=== LANGUAGE BREAKDOWN ===\n';
    out += Object.entries(langs).map(([l, b]) => `${l}: ${b} bytes`).join(', ') + '\n\n';
  }

  const readme = await gh(`/repos/${repo}/readme`, 'application/vnd.github.raw');
  if (readme) {
    const trimmed = readme.length > 10000
      ? readme.slice(0, 10000) + '... [truncated for length]'
      : readme;
    out += `=== README ===\n${trimmed}\n\n`;
  }

  const tree = await gh(`/repos/${repo}/git/trees/HEAD?recursive=1`);
  if (tree?.tree) {
    out += `=== FILE STRUCTURE ===\n${tree.tree.map((t) => t.path).join('\n')}\n\n`;
  }

  const commits = await gh(`/repos/${repo}/commits?per_page=10`);
  if (Array.isArray(commits)) {
    out += '=== RECENT COMMITS (last 10) ===\n';
    out += commits.map((c) => `- ${c.commit.author.date}: ${c.commit.message}`).join('\n') + '\n\n';
  }

  return out;
}

const REPOS = {
  // A substantial, well-documented project. The happy path.
  'rich-submission': 'ParthGupta1304/ORCHESTRA',
  // A smaller project with thinner documentation.
  'thin-submission': 'ParthGupta1304/CLARIX',
};

const dir = join(root, 'evals', 'fixtures');
mkdirSync(dir, { recursive: true });

for (const [name, repo] of Object.entries(REPOS)) {
  try {
    const content = await parseGithub(repo);
    writeFileSync(join(dir, `${name}.txt`), content);
    console.log(`${name.padEnd(18)} ${repo.padEnd(32)} ${content.length} chars`);
  } catch (err) {
    console.error(`${name.padEnd(18)} FAILED: ${err.message}`);
  }
}
