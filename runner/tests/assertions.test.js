'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAssertion } = require('../src/assertions');

// A well-formed clarity-judge response, the shape backend/prompts/clarity-judge.md asks for.
const GOOD = JSON.stringify({
  dimension: 'clarity',
  score: 17,
  max_score: 20,
  evidence: ['problem stated in the first paragraph', 'user persona is named'],
  strengths: ['sharp problem framing'],
  improvements: ['quantify the pain point'],
  confidence: 'high',
});

// The same content wrapped in a markdown fence — what a prompt looks like after it
// loses its "no code fences" instruction. ORCHESTRA's parseAgentOutput strips this
// silently, which is exactly why the runner asserts on the raw string instead.
const FENCED = '```json\n' + GOOD + '\n```';

const run = (raw, spec) => runAssertion(raw, spec);

test('output_is_valid_json: passes on clean JSON', () => {
  assert.equal(run(GOOD, { check: 'output_is_valid_json' }).pass, true);
});

test('output_is_valid_json: fails on fenced output, which is the point', () => {
  const r = run(FENCED, { check: 'output_is_valid_json' });
  assert.equal(r.pass, false);
  assert.equal(r.score, 0);
});

test('output_is_valid_json: fails on prose preamble', () => {
  assert.equal(run('Here is my evaluation:\n' + GOOD, { check: 'output_is_valid_json' }).pass, false);
});

test('no_code_fences: catches the fence even when the JSON inside is fine', () => {
  assert.equal(run(GOOD, { check: 'no_code_fences' }).pass, true);
  assert.equal(run(FENCED, { check: 'no_code_fences' }).pass, false);
});

test('json_has_keys: passes when the full schema is present', () => {
  const spec = {
    check: 'json_has_keys',
    keys: ['dimension', 'score', 'max_score', 'evidence', 'strengths', 'improvements', 'confidence'],
  };
  assert.equal(run(GOOD, spec).pass, true);
});

test('json_has_keys: names the missing keys in the detail', () => {
  const partial = JSON.stringify({ dimension: 'clarity', score: 17 });
  const r = run(partial, { check: 'json_has_keys', keys: ['dimension', 'score', 'confidence'] });
  assert.equal(r.pass, false);
  assert.match(r.detail, /confidence/);
});

test('score_in_range: enforces the dimension ceiling', () => {
  assert.equal(run(GOOD, { check: 'score_in_range', max: 20 }).pass, true);
  const over = JSON.stringify({ score: 24 });
  assert.equal(run(over, { check: 'score_in_range', max: 20 }).pass, false);
});

test('score_in_range: a stringified score is a failure, not a pass', () => {
  const stringy = JSON.stringify({ score: '17' });
  const r = run(stringy, { check: 'score_in_range', max: 20 });
  assert.equal(r.pass, false);
  assert.match(r.detail, /not a number/);
});

test('score_in_range: accepts the boundary values', () => {
  assert.equal(run(JSON.stringify({ score: 0 }), { check: 'score_in_range', max: 20 }).pass, true);
  assert.equal(run(JSON.stringify({ score: 20 }), { check: 'score_in_range', max: 20 }).pass, true);
});

test('field_equals: catches a drifted dimension name or max_score', () => {
  assert.equal(run(GOOD, { check: 'field_equals', field: 'dimension', value: 'clarity' }).pass, true);
  assert.equal(run(GOOD, { check: 'field_equals', field: 'max_score', value: 20 }).pass, true);
  assert.equal(run(GOOD, { check: 'field_equals', field: 'max_score', value: 25 }).pass, false);
});

test('field_in_enum: confidence must be one of the three allowed values', () => {
  const spec = { check: 'field_in_enum', field: 'confidence', values: ['high', 'medium', 'low'] };
  assert.equal(run(GOOD, spec).pass, true);
  assert.equal(run(JSON.stringify({ confidence: 'very high' }), spec).pass, false);
});

test('array_field_contains: the behavioral check on insufficient input', () => {
  // clarity-judge.md promises this exact sentence when there is nothing to evaluate.
  const empty = JSON.stringify({
    dimension: 'clarity',
    score: 0,
    improvements: ['No clarity-relevant assets were provided for evaluation.'],
  });
  const spec = {
    check: 'array_field_contains',
    field: 'improvements',
    substring: 'No clarity-relevant assets were provided',
  };
  assert.equal(run(empty, spec).pass, true);

  // A prompt that lost the instruction scores it low and says something generic instead.
  const drifted = JSON.stringify({ score: 3, improvements: ['Add more detail about the problem.'] });
  assert.equal(run(drifted, spec).pass, false);
});

test('array_field_contains: a non-array field fails rather than throwing', () => {
  const r = run(JSON.stringify({ improvements: 'a string' }), {
    check: 'array_field_contains', field: 'improvements', substring: 'x',
  });
  assert.equal(r.pass, false);
  assert.match(r.detail, /not an array/);
});

test('not_contains: catches leaked instructions and placeholders', () => {
  const spec = { check: 'not_contains', patterns: ['[TODO]', 'You are the'] };
  assert.equal(run(GOOD, spec).pass, true);
  const leaked = JSON.stringify({ evidence: ['You are the Clarity Judge on the Orchestra panel'] });
  assert.equal(run(leaked, spec).pass, false);
});

test('not_contains: matching is case-insensitive', () => {
  const r = run('the output has a todo in it', { check: 'not_contains', patterns: ['TODO'] });
  assert.equal(r.pass, false);
});

test('output_length_within: flags a truncated or runaway response', () => {
  assert.equal(run(GOOD, { check: 'output_length_within', min: 50, max: 4000 }).pass, true);
  assert.equal(run('{}', { check: 'output_length_within', min: 50, max: 4000 }).pass, false);
});

test('every check returns a 1/0 score, giving assertions a zero noise floor', () => {
  const pass = run(GOOD, { check: 'output_is_valid_json' });
  const fail = run(FENCED, { check: 'output_is_valid_json' });
  assert.equal(pass.score, 1);
  assert.equal(fail.score, 0);
});

test('an unknown check name is a hard error, not a silent pass', () => {
  assert.throws(() => run(GOOD, { check: 'output_is_vibes_based' }), /Unknown assertion/);
});
