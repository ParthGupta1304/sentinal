#!/usr/bin/env node
/**
 * Calibration pass — PRD §6.6 step 4.
 *
 * Runs the whole suite against the CURRENT, UNCHANGED prompt and reports which cases are
 * stable and which flicker. A case that fails or varies on an unmodified prompt is a bad
 * case, not a discovered bug, and it has to be fixed or deleted before any comparison is
 * trustworthy.
 *
 * This is the step people skip, and §13 lists suite instability as the top risk: if the
 * suite is not stable on the baseline, every pull request looks like a regression and no
 * amount of dashboard polish rescues it.
 *
 *   node runner/src/calibrate.mjs                     # full suite, N from suite.yaml
 *   node runner/src/calibrate.mjs --n 1               # cheap smoke pass
 *   node runner/src/calibrate.mjs --case clarity-empty-input
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { loadSuite } = require('./cases.js');
const { runCase } = require('./run-case.js');

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
    console.error(`Missing ${key} in .env. Copy .env.example and fill it in.`);
    process.exit(1);
  }
}

const evalsDir = join(root, 'evals');
const suite = loadSuite(evalsDir);

const only = argOf('--case');
const cases = only ? suite.cases.filter((c) => c.id === only) : suite.cases;
if (only && cases.length === 0) {
  console.error(`No case named "${only}". Available: ${suite.cases.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

const n = Number(argOf('--n') ?? suite.runs_per_case ?? 3);

// The prompt is read from the local working tree. Calibration deliberately does not need
// GitHub, a PR, or the harness — it is about the suite, not about any change.
const promptPath = argOf('--prompt')
  ?? join(root, '..', 'ORCHESTRA', 'ORCHESTRA', suite.target.prompt);
if (!existsSync(promptPath)) {
  console.error(`Prompt not found: ${promptPath}\nPass --prompt <path> to point at it.`);
  process.exit(1);
}
const promptTemplate = readFileSync(promptPath, 'utf8');

console.log(`Calibrating ${cases.length} case(s), N=${n}, against the unchanged prompt.`);
console.log(`  prompt  ${promptPath}`);
console.log(`  subject ${suite.subject.model} @ temp ${suite.subject.temperature}`);
console.log(`  judge   ${suite.judge.model}, thinking ${suite.judge.thinking ?? 'default'}\n`);

const runId = `calibrate-${Date.now()}`;
const results = [];
const started = Date.now();

for (const testCase of cases) {
  process.stdout.write(`${testCase.id.padEnd(30)} `);
  try {
    const result = await runCase({
      testCase,
      promptTemplate,
      version: 'base',
      runId,
      n,
      outDir: join(root, 'runs'),
      subject: suite.subject,
      judge: suite.judge,
      openaiKey: env.OPENAI_API_KEY,
      anthropicKey: env.ANTHROPIC_API_KEY,
      onRun: () => process.stdout.write('.'),
    });
    results.push({ testCase, result });

    const a = result.assertion;
    const r = result.rubric;
    const parts = [];
    if (a) parts.push(`assert ${a.median.toFixed(2)} ±${a.spread.toFixed(2)}`);
    if (r) parts.push(`rubric ${r.median.toFixed(2)} ±${r.spread.toFixed(2)}`);
    console.log(`  ${parts.join('  ')}`);
  } catch (err) {
    console.log(`  ERROR ${err.message}`);
    results.push({ testCase, error: err });
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log(`Calibration report   (${((Date.now() - started) / 1000).toFixed(0)}s)`);
console.log('='.repeat(78));

const problems = [];

for (const { testCase, result, error } of results) {
  if (error) {
    problems.push(`${testCase.id}: errored — ${error.message}`);
    continue;
  }

  const a = result.assertion;
  // An assertion that varies across runs of an UNCHANGED prompt is the dangerous case.
  // Assertions carry a zero noise floor, so any flicker becomes a false regression later.
  if (a && a.spread > 0) {
    const failing = collectFlickeringChecks(result.output_ref);
    problems.push(
      `${testCase.id}: assertions flicker (spread ${a.spread.toFixed(2)}) — ${failing}\n` +
      `    Fix: demote the unstable check from "assertion" to "rubric" in the case file. ` +
      `Do not widen its range until it passes; that hollows out the case.`
    );
  } else if (a && a.median < 1) {
    const failing = collectFlickeringChecks(result.output_ref);
    problems.push(
      `${testCase.id}: assertions fail consistently on the unchanged prompt — ${failing}\n` +
      `    Fix: the expectation is wrong, not the prompt. Correct or delete the check.`
    );
  }

  const r = result.rubric;
  // Rubric spread is expected and is what the noise band draws. Only flag it when it is
  // wide enough to swallow any plausible real regression.
  if (r && r.spread > 0.25) {
    problems.push(
      `${testCase.id}: rubric noise is high (spread ${r.spread.toFixed(2)} on a 0-1 scale).\n` +
      `    Fix: the criterion is probably too vague to score the same way twice. Sharpen it.`
    );
  }

  // A rubric that scores low on the UNCHANGED prompt is just as broken as one that
  // flickers, and is easier to miss because it looks stable. It means the criterion is
  // asking for behaviour the prompt never promised (§6.6 step 3) — so it fails on the
  // baseline, leaves almost no room to detect a further drop, and would read as a
  // permanent regression the moment it is compared against anything.
  if (r && r.median < 0.7) {
    problems.push(
      `${testCase.id}: rubric scores low on the unchanged prompt (median ${r.median.toFixed(2)}, ` +
      `about ${(r.median * 5).toFixed(1)}/5).\n` +
      `    Fix: the criterion is demanding behaviour the prompt does not actually promise. ` +
      `Rewrite it to match the prompt's real contract, or delete the case. Do not leave it ` +
      `failing on the baseline — every future run would report it as regressed.`
    );
  }
}

function collectFlickeringChecks(ref) {
  try {
    const data = JSON.parse(readFileSync(join(root, ref), 'utf8'));
    const byCheck = new Map();
    for (const run of data.runs) {
      for (const a of run.assertions) {
        if (!byCheck.has(a.check)) byCheck.set(a.check, []);
        byCheck.get(a.check).push(a.pass);
      }
    }
    const unstable = [...byCheck.entries()]
      .filter(([, passes]) => passes.some((p) => p !== passes[0]) || !passes[0])
      .map(([check, passes]) => `${check} [${passes.map((p) => (p ? 'pass' : 'FAIL')).join(', ')}]`);
    return unstable.join('; ') || 'see the run file';
  } catch {
    return 'see the run file';
  }
}

if (problems.length === 0) {
  console.log('\nStable. Every case passed consistently across all runs.');
  console.log('The suite is safe to compare a pull request against.');
} else {
  console.log(`\n${problems.length} problem(s) to resolve before this suite can gate a PR:\n`);
  for (const p of problems) console.log(`  - ${p}\n`);
}

console.log(`Raw outputs: runs/${runId}/base/`);
process.exit(problems.length === 0 ? 0 : 1);
