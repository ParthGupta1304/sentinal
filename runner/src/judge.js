'use strict';

/**
 * Rubric scoring by a judge model (§6.3).
 *
 * Rules that are not negotiable, and why each is enforced here rather than trusted:
 *
 *   - The judge is a different family from the subject. ORCHESTRA runs gpt-4o-mini, so
 *     the judge runs Claude. A model grading its own family measures self-consistency.
 *   - The judge scores one output against one explicit criterion. Vague criteria produce
 *     noise, so "is this good" is not a criterion this function will accept.
 *   - The judge is blind to which version produced the output. It never sees "base" or
 *     "head", a filename, or a diff. This is checked below, because a leak here does not
 *     throw — it quietly biases every score in the run.
 *   - Minimum sampling variance.
 *
 * On that last rule: §6.3 says "judge temperature 0", and that is not literally possible
 * here. claude-sonnet-5 removed `temperature`, `top_p`, and `top_k` — sending a non-default
 * value returns 400, which is how the first calibration run failed. Every case with a
 * rubric check errored; the three that passed were the three with no rubric checks.
 *
 * What temperature 0 was actually for is run-to-run stability, and on this model that comes
 * from disabling thinking rather than from a sampling parameter. Adaptive thinking is on by
 * default and would add a variable-length reasoning pass before each score, which is both
 * slower across ~90 judge calls and a source of exactly the variance the setting exists to
 * remove. Scoring one output against one explicit criterion does not need it.
 *
 * Worth stating plainly: temperature 0 never guaranteed identical outputs on any model. The
 * noise floor in §6.5 exists because judge scores vary regardless, and it is what actually
 * protects the verdict.
 */

const JUDGE_SYSTEM = `You score a single piece of model output against a single criterion.

You are shown the input that produced the output, so that you can check claims against it.
The input is identical for every version under comparison and tells you nothing about which
version produced the output you are scoring.

Return ONLY a JSON object, no prose and no code fences:
{"score": <integer 1-5>, "justification": "<one sentence>"}

The scale:
5 - fully satisfies the criterion
4 - satisfies it with a minor gap
3 - partially satisfies it
2 - largely fails it
1 - does not satisfy it at all

Score only the criterion you are given. Do not reward or penalise anything else about the
output, including its formatting, length, or tone, unless the criterion asks about it.`;

/**
 * Words that would tell the judge which side of the comparison it is looking at.
 * Blind scoring is the whole basis for trusting a rubric delta, so a leak is a hard error.
 */
const LEAKS = [
  /\bbase\s+version\b/i,
  /\bhead\s+version\b/i,
  /\bbefore\b.*\bafter\b/i,
  /\bold\s+prompt\b/i,
  /\bnew\s+prompt\b/i,
  /\bthe\s+diff\b/i,
];

function assertBlind(text, label) {
  for (const pattern of LEAKS) {
    if (pattern.test(text)) {
      throw new Error(
        `Blind scoring violated: ${label} matches ${pattern}. The judge must not be able ` +
        `to tell which prompt version produced an output (§6.3).`
      );
    }
  }
}

/**
 * Score one output against one criterion. Returns { score, justification }.
 *
 * `output` is the raw model response, `input` is the submission that produced it, and
 * `criterion` is the rubric line from the case file. Nothing else is sent — no case id,
 * no version, no filename.
 *
 * Showing the judge the input was a correctness fix, not a convenience. Without it, a
 * criterion like "the evidence describes this submission" is unanswerable: the judge has
 * nothing to compare the evidence against, so it reasons that the claim is unverifiable
 * and scores low. During calibration that produced a stable 2/5 on an unchanged prompt,
 * and the judge said so in its own justification — "impossible to verify it accurately
 * describes this particular project".
 *
 * This does not weaken §6.3's blind-scoring rule. Blindness is about which *version*
 * produced the output. The input is a fixed property of the eval case and is byte-identical
 * for base and head, so it carries no signal about provenance.
 */
async function scoreRubric({ client, model, output, input, criterion }) {
  if (!criterion || criterion.trim().length < 15) {
    throw new Error(`Rubric criterion is too vague to score consistently: "${criterion}"`);
  }
  assertBlind(criterion, 'criterion');

  const submission = (input ?? '').trim();
  const inputSection = submission
    ? `Input that was given to the model:\n${submission}\n\n`
    : `Input that was given to the model:\n(empty)\n\n`;

  const userMessage =
    `${inputSection}Criterion:\n${criterion.trim()}\n\nOutput to score:\n${output}`;
  assertBlind(criterion, 'criterion');

  const res = await client.messages.create({
    model,
    max_tokens: 300,
    // See the note at the top of this file: no temperature on this model, and thinking
    // off is what buys stability. max_tokens caps thinking plus response together, so
    // leaving thinking on would also starve the 300 tokens this reply needs.
    thinking: { type: 'disabled' },
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = res.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
  const parsed = parseJudgeReply(text);

  return { ...parsed, raw: text };
}

function parseJudgeReply(text) {
  // The judge is told not to use fences, but a judge that does is a formatting slip on
  // our side of the system, not a regression in the prompt under test. Recover quietly.
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`Judge did not return JSON: ${text.slice(0, 200)}`);
    obj = JSON.parse(m[0]);
  }

  const score = Number(obj.score);
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    throw new Error(`Judge returned an out-of-range score: ${JSON.stringify(obj)}`);
  }
  return { score, justification: String(obj.justification ?? '').trim() };
}

module.exports = { scoreRubric, parseJudgeReply, assertBlind, JUDGE_SYSTEM };
