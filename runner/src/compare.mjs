#!/usr/bin/env node
/**
 * Compare two versions of a prompt across the eval suite — the thing Sentinel exists to do.
 *
 * Runs every case against both versions, N times each, then classifies each case with the
 * variance protocol in §6.5: a case is a regression only when its median dropped AND the
 * drop exceeds the noise floor observed on the base version. Anything else is inconclusive,
 * reported with its runs shown rather than hidden.
 *
 *   node runner/src/compare.mjs --base <path> --head <path>
 *   node runner/src/compare.mjs --head evals/regressions/clarity-judge-head.md
 *
 * Base defaults to the prompt in the target repo's working tree.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadSuite } = require('./cases.js');
const { runCase } = require('./run-case.js');
const { classify, summarize } = require('./variance.js');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
  if (!env[key]) {
    console.error(`Missing ${key} in .env.`);
    process.exit(1);
  }
}

const evalsDir = join(root, 'evals');
const suite = loadSuite(evalsDir);

const basePath = argOf('--base')
  ?? join(root, '..', 'ORCHESTRA', 'ORCHESTRA', suite.target.prompt);
const headPath = argOf('--head');

if (!headPath) {
  console.error('Pass --head <path to the changed prompt>.');
  process.exit(1);
}
for (const [label, p] of [['base', basePath], ['head', headPath]]) {
  if (!existsSync(p)) {
    console.error(`${label} prompt not found: ${p}`);
    process.exit(1);
  }
}

const basePrompt = readFileSync(basePath, 'utf8');
const headPrompt = readFileSync(headPath, 'utf8');

if (basePrompt === headPrompt) {
  console.error('base and head are identical — nothing to compare.');
  process.exit(1);
}

const only = argOf('--case');
const cases = only ? suite.cases.filter((c) => c.id === only) : suite.cases;
if (only && cases.length === 0) {
  console.error(`No case named "${only}". Available: ${suite.cases.map((c) => c.id).join(', ')}`);
  process.exit(1);
}
const n = Number(argOf('--n') ?? suite.runs_per_case ?? 3);
const runId = argOf('--run-id') ?? `run-${Date.now()}`;

console.log(`Sentinel — comparing ${cases.length} case(s), N=${n} per version\n`);
console.log(`  base  ${basePath}`);
console.log(`  head  ${headPath}`);
console.log(`  run   ${runId}\n`);

const started = Date.now();
const verdicts = [];

for (const testCase of cases) {
  process.stdout.write(`${testCase.id.padEnd(30)} `);

  const versions = {};
  for (const [version, promptTemplate] of [['base', basePrompt], ['head', headPrompt]]) {
    versions[version] = await runCase({
      testCase,
      promptTemplate,
      version,
      runId,
      n,
      outDir: join(root, 'runs'),
      subject: suite.subject,
      judge: suite.judge,
      openaiKey: env.OPENAI_API_KEY,
      anthropicKey: env.ANTHROPIC_API_KEY,
      onRun: () => process.stdout.write(version === 'base' ? '.' : ':'),
    });
  }

  // Assertions and rubrics are classified independently and never averaged. They live on
  // different scales and, more importantly, assertions carry a zero noise floor by
  // construction while rubrics do not — merging them would let a stable rubric mask a
  // flipped assertion, which is the more serious signal (§6.2).
  const perCheck = [];
  for (const kind of ['assertion', 'rubric']) {
    const b = versions.base[kind];
    const h = versions.head[kind];
    if (!b || !h) continue;
    perCheck.push({ kind, ...classify(b.scores, h.scores) });
  }

  // The case takes the most serious outcome across its check kinds. A regressed assertion
  // is not softened by a flat rubric.
  const rank = { regressed: 0, inconclusive: 1, flat: 2, improved: 3 };
  const worst = perCheck.slice().sort((a, b) => rank[a.outcome] - rank[b.outcome])[0];

  verdicts.push({
    case_id: testCase.id,
    outcome: worst.outcome,
    checks: perCheck,
    base_ref: versions.base.output_ref,
    head_ref: versions.head.output_ref,
  });

  const label = { regressed: 'REGRESSED', improved: 'improved', flat: 'flat', inconclusive: 'inconclusive' };
  const detail = perCheck
    .map((c) => `${c.kind.slice(0, 6)} ${c.baseMedian.toFixed(2)}→${c.headMedian.toFixed(2)} (floor ${c.noiseFloor.toFixed(2)})`)
    .join('  ');
  console.log(`  ${label[worst.outcome].padEnd(12)} ${detail}`);
}

const summary = summarize(verdicts);

console.log(`\n${'='.repeat(78)}`);
console.log(`Verdict: ${summary.verdict}   (${((Date.now() - started) / 1000).toFixed(0)}s)`);
console.log('='.repeat(78));
console.log(
  `\n${summary.counts.regressed} regressed    ${summary.counts.improved} improved    ` +
  `${summary.counts.flat} flat    ${summary.counts.inconclusive} inconclusive\n`
);

for (const v of verdicts) {
  if (v.outcome === 'flat') continue;
  console.log(`  ${v.case_id}  —  ${v.outcome}`);
  for (const c of v.checks) {
    if (c.outcome === 'flat') continue;
    console.log(
      `      ${c.kind}: ${c.baseMedian.toFixed(2)} → ${c.headMedian.toFixed(2)}, ` +
      `delta ${c.delta.toFixed(2)}, noise floor ${c.noiseFloor.toFixed(2)} ` +
      `${Math.abs(c.delta) > c.noiseFloor ? '(outside the band)' : '(inside the band)'}`
    );
  }
}

// Persist for the dashboard. Raw model outputs stay in the sandbox files referenced by
// base_ref / head_ref and are fetched on demand when a human expands a case (§7).
const outDir = join(root, 'runs', runId);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'verdict.json'), JSON.stringify({
  run_id: runId,
  base_path: basePath,
  head_path: headPath,
  verdict: summary.verdict,
  counts: summary.counts,
  cases: verdicts,
  finished_at: Date.now(),
}, null, 2));

console.log(`\nrunId ${runId}  ·  verdict written to runs/${runId}/verdict.json`);

// Non-zero when the comparison found a real regression, so this can gate CI directly.
process.exit(summary.counts.regressed > 0 ? 2 : 0);
