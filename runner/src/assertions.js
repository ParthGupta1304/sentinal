'use strict';

/**
 * Deterministic assertions from PRD §6.2. Pure code, no model involved, zero variance.
 *
 * Every check here takes the RAW model response string. That is deliberate and it is
 * the single easiest thing to get wrong in this project.
 *
 * ORCHESTRA's judges do not return raw output — they return
 * `parseAgentOutput(response.choices[0].message.content, openai)`, and that helper
 * strips markdown code fences and, if the JSON still will not parse, sends it to
 * GPT-4o to be repaired. Both layers exist to make production resilient, and both
 * launder exactly the format regressions these assertions exist to catch. A suite
 * that calls the judge *function* would report a prompt that lost "no code fences"
 * as passing. So the runner calls the model directly and asserts on what it said.
 *
 * Each check returns { pass, detail }. Scores are 1 for pass and 0 for fail, which
 * gives them a noise floor of zero in the variance protocol (§6.5).
 */

function parseJson(raw) {
  try {
    return { ok: true, value: JSON.parse(raw.trim()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const checks = {
  /** Output parses as JSON with no repair, no fence stripping, no second call. */
  output_is_valid_json(raw) {
    const parsed = parseJson(raw);
    return parsed.ok
      ? { pass: true, detail: 'parsed as JSON' }
      : { pass: false, detail: `did not parse: ${parsed.error}` };
  },

  /**
   * The prompt says "no markdown, no code fences". A prompt edit that drops that
   * instruction is the classic invisible regression: ORCHESTRA's fence stripper
   * hides it in production, so nothing breaks until something downstream cares.
   */
  no_code_fences(raw) {
    return raw.includes('```')
      ? { pass: false, detail: 'output contains a markdown code fence' }
      : { pass: true, detail: 'no code fences' };
  },

  json_has_keys(raw, { keys }) {
    const parsed = parseJson(raw);
    if (!parsed.ok) return { pass: false, detail: 'output is not JSON' };
    const missing = keys.filter((k) => !(k in parsed.value));
    return missing.length === 0
      ? { pass: true, detail: `all ${keys.length} keys present` }
      : { pass: false, detail: `missing: ${missing.join(', ')}` };
  },

  /** Score must be a number within the dimension's declared range. */
  score_in_range(raw, { min = 0, max }) {
    const parsed = parseJson(raw);
    if (!parsed.ok) return { pass: false, detail: 'output is not JSON' };
    const score = parsed.value.score;
    if (typeof score !== 'number' || Number.isNaN(score)) {
      return { pass: false, detail: `score is ${typeof score}, not a number` };
    }
    return score >= min && score <= max
      ? { pass: true, detail: `score ${score} within [${min}, ${max}]` }
      : { pass: false, detail: `score ${score} outside [${min}, ${max}]` };
  },

  /** A named field must equal an exact value, e.g. dimension or max_score. */
  field_equals(raw, { field, value }) {
    const parsed = parseJson(raw);
    if (!parsed.ok) return { pass: false, detail: 'output is not JSON' };
    const actual = parsed.value[field];
    return actual === value
      ? { pass: true, detail: `${field} === ${JSON.stringify(value)}` }
      : { pass: false, detail: `${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}` };
  },

  field_in_enum(raw, { field, values }) {
    const parsed = parseJson(raw);
    if (!parsed.ok) return { pass: false, detail: 'output is not JSON' };
    const actual = parsed.value[field];
    return values.includes(actual)
      ? { pass: true, detail: `${field} = ${JSON.stringify(actual)}` }
      : { pass: false, detail: `${field} is ${JSON.stringify(actual)}, not one of ${values.join('|')}` };
  },

  /**
   * A string array field must contain an entry with the given substring. This is the
   * behavioral check: the judge prompts promise that on insufficient input they score 0
   * and put a specific sentence into `improvements`. That is a behaviour the prompt
   * explicitly commits to, so it is fair to assert rather than to judge (§6.6 step 3).
   */
  array_field_contains(raw, { field, substring }) {
    const parsed = parseJson(raw);
    if (!parsed.ok) return { pass: false, detail: 'output is not JSON' };
    const arr = parsed.value[field];
    if (!Array.isArray(arr)) {
      return { pass: false, detail: `${field} is ${typeof arr}, not an array` };
    }
    const hit = arr.some((item) => typeof item === 'string' && item.includes(substring));
    return hit
      ? { pass: true, detail: `${field} contains "${substring}"` }
      : { pass: false, detail: `${field} does not mention "${substring}"` };
  },

  /** Guards against leaked instructions and placeholders like [TODO] (§6.2). */
  not_contains(raw, { patterns }) {
    const found = patterns.filter((p) => raw.toLowerCase().includes(p.toLowerCase()));
    return found.length === 0
      ? { pass: true, detail: 'no forbidden patterns' }
      : { pass: false, detail: `contains forbidden: ${found.join(', ')}` };
  },

  output_length_within(raw, { min = 0, max }) {
    const n = raw.length;
    return n >= min && n <= max
      ? { pass: true, detail: `${n} chars within [${min}, ${max}]` }
      : { pass: false, detail: `${n} chars outside [${min}, ${max}]` };
  },
};

/** Run one assertion spec against a raw response. Unknown check names are a hard error. */
function runAssertion(raw, spec) {
  const fn = checks[spec.check];
  if (!fn) {
    throw new Error(
      `Unknown assertion "${spec.check}". Available: ${Object.keys(checks).join(', ')}`
    );
  }
  const { pass, detail } = fn(raw, spec);
  return { check: spec.check, pass, detail, score: pass ? 1 : 0 };
}

module.exports = { checks, runAssertion };
