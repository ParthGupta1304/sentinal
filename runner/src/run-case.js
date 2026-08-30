'use strict';

/**
 * Run one eval case against one prompt version, N times, and score it.
 *
 * This is the unit of work a subagent performs (§5.4), and it is also what the
 * calibration pass runs directly. Deliberately one code path: what gets calibrated is
 * exactly what ships in the sandbox.
 *
 * Raw model responses are written to files. The compact scored result is what comes back
 * — the orchestrator never sees 90 raw responses (§5.3).
 */

const fs = require('node:fs');
const path = require('node:path');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const { runAssertion } = require('./assertions');
const { scoreRubric } = require('./judge');
const { median, spread } = require('./variance');
const { renderPrompt } = require('./cases');

const MODEL_CALL_TIMEOUT_MS = 90_000;

/**
 * Call the subject model and return the RAW response string.
 *
 * This deliberately does not go through ORCHESTRA's judge functions. Those return
 * parseAgentOutput(...), which strips code fences and, failing that, sends the output to
 * GPT-4o to be repaired. Both behaviours are good for production and fatal for an eval:
 * they repair exactly the format regressions the assertions exist to detect.
 */
async function callSubject({ client, model, temperature, prompt }) {
  const res = await client.chat.completions.create(
    {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
    },
    { timeout: MODEL_CALL_TIMEOUT_MS }
  );
  return res.choices[0].message.content ?? '';
}

/**
 * Score one raw response against a case's expectations.
 *
 * Assertions and rubrics are on different scales — 0/1 versus 1-5 — so they are kept in
 * separate buckets and never averaged together. Mixing them would let a strong rubric
 * score mask a failed assertion, and a failed assertion is the more serious signal.
 */
async function scoreResponse({ raw, testCase, judgeClient, judgeModel }) {
  const assertions = testCase.assertions.map((spec) => runAssertion(raw, spec));

  const rubrics = [];
  for (const spec of testCase.rubrics) {
    const result = await scoreRubric({
      client: judgeClient,
      model: judgeModel,
      output: raw,
      // The case input, so the judge can check claims against what the model was actually
      // given. Identical across versions, so it reveals nothing about provenance.
      input: testCase.input,
      criterion: spec.criterion,
    });
    rubrics.push({ criterion: spec.criterion, weight: spec.weight ?? 1, ...result });
  }

  // Assertions collapse to a pass rate so a case with seven checks and a case with three
  // are on the same 0-1 scale. Any failure moves it off 1, and with zero variance across
  // runs that is enough for the noise floor to make the verdict decisive.
  const assertionScore = assertions.length
    ? assertions.filter((a) => a.pass).length / assertions.length
    : null;

  // Rubrics are weighted, then normalised to 0-1 so both buckets read the same way.
  let rubricScore = null;
  if (rubrics.length) {
    const totalWeight = rubrics.reduce((s, r) => s + r.weight, 0);
    const weighted = rubrics.reduce((s, r) => s + r.score * r.weight, 0);
    rubricScore = weighted / totalWeight / 5;
  }

  return { assertions, rubrics, assertionScore, rubricScore };
}

/**
 * Run one case against one prompt version N times.
 *
 * Returns the compact shape the orchestrator consumes. `outputRefs` are file paths, not
 * contents: the dashboard fetches them on demand when a human expands a case (§8.3).
 */
async function runCase({
  testCase,
  promptTemplate,
  version,
  runId,
  n,
  outDir,
  subject,
  judge,
  openaiKey,
  anthropicKey,
  onRun,
}) {
  const subjectClient = new OpenAI({ apiKey: openaiKey });
  const judgeClient = new Anthropic({ apiKey: anthropicKey });

  const prompt = renderPrompt(promptTemplate, { content: testCase.input });
  const dir = path.join(outDir, runId, version);
  fs.mkdirSync(dir, { recursive: true });

  const runs = [];
  for (let i = 0; i < n; i++) {
    const raw = await callSubject({
      client: subjectClient,
      model: subject.model,
      temperature: subject.temperature,
      prompt,
    });

    const scored = await scoreResponse({
      raw,
      testCase,
      judgeClient,
      judgeModel: judge.model,
    });

    runs.push({ index: i, raw, ...scored });
    if (onRun) onRun({ index: i, ...scored });
  }

  const file = path.join(dir, `${testCase.id}.json`);
  fs.writeFileSync(file, JSON.stringify({
    case_id: testCase.id,
    version,
    run_id: runId,
    prompt_chars: prompt.length,
    runs: runs.map((r) => ({
      index: r.index,
      raw: r.raw,
      assertions: r.assertions,
      rubrics: r.rubrics,
      assertion_score: r.assertionScore,
      rubric_score: r.rubricScore,
    })),
  }, null, 2));

  const assertionScores = runs.map((r) => r.assertionScore).filter((s) => s !== null);
  const rubricScores = runs.map((r) => r.rubricScore).filter((s) => s !== null);

  return {
    case_id: testCase.id,
    version,
    // Kept separate on purpose: assertions have a zero noise floor and rubrics do not,
    // so they are classified independently and never averaged into one number.
    assertion: assertionScores.length
      ? { scores: assertionScores, median: median(assertionScores), spread: spread(assertionScores) }
      : null,
    rubric: rubricScores.length
      ? { scores: rubricScores, median: median(rubricScores), spread: spread(rubricScores) }
      : null,
    output_ref: path.relative(process.cwd(), file),
  };
}

module.exports = { runCase, scoreResponse, callSubject };
