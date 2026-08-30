'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { median, spread, noiseFloor, classify, summarize } = require('../src/variance');

test('median: odd length takes the middle value', () => {
  assert.equal(median([4, 4, 3]), 4);
  assert.equal(median([1, 5, 3]), 3);
  assert.equal(median([5]), 5);
});

test('median: even length averages the two middle values (§9.3)', () => {
  assert.equal(median([3, 4]), 3.5);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([5, 1, 4, 2]), 3);
});

test('median: does not mutate its input', () => {
  const scores = [5, 1, 3];
  median(scores);
  assert.deepEqual(scores, [5, 1, 3]);
});

test('median: rejects empty input rather than returning NaN', () => {
  assert.throws(() => median([]), /non-empty/);
});

test('spread: max minus min, zero for a single run', () => {
  assert.equal(spread([4, 4, 3]), 1);
  assert.equal(spread([5, 5, 5]), 0);
  assert.equal(spread([4]), 0);
  assert.equal(spread([1, 5]), 4);
});

test('noiseFloor: taken from the base version only (§6.5 step 3)', () => {
  // The PRD's worked example: base runs of 4, 4, 3 give a noise floor of 1.
  assert.equal(noiseFloor([4, 4, 3]), 1);
});

test('classify: a drop larger than the noise floor is a regression', () => {
  // base median 4 (floor 1), head median 2 -> drop of 2 exceeds 1.
  const r = classify([4, 4, 3], [2, 2, 2]);
  assert.equal(r.outcome, 'regressed');
  assert.equal(r.delta, -2);
  assert.equal(r.noiseFloor, 1);
});

test('classify: BOUNDARY — a drop exactly equal to the noise floor is inconclusive', () => {
  // This is the off-by-one that decides whether the gate is credible.
  // §6.5 step 4 says the drop must *exceed* the floor. Equal is not exceeding.
  const r = classify([4, 4, 3], [3, 3, 3]);
  assert.equal(r.noiseFloor, 1);
  assert.equal(r.delta, -1);
  assert.equal(r.outcome, 'inconclusive');
});

test('classify: a drop inside the noise floor is inconclusive', () => {
  const r = classify([5, 3, 4], [3.5, 3.5, 3.5]);
  assert.equal(r.noiseFloor, 2);
  assert.equal(r.outcome, 'inconclusive');
});

test('classify: a rise larger than the noise floor is an improvement', () => {
  const r = classify([3, 3, 3], [5, 5, 5]);
  assert.equal(r.outcome, 'improved');
  assert.equal(r.delta, 2);
});

test('classify: BOUNDARY — a rise exactly equal to the noise floor is inconclusive', () => {
  const r = classify([4, 4, 3], [5, 5, 5]);
  assert.equal(r.noiseFloor, 1);
  assert.equal(r.delta, 1);
  assert.equal(r.outcome, 'inconclusive');
});

test('classify: identical medians are flat even when the runs are noisy', () => {
  const r = classify([5, 3, 4], [3, 5, 4]);
  assert.equal(r.outcome, 'flat');
  assert.equal(r.delta, 0);
});

test('classify: assertions have a zero noise floor, so any flip is decisive (§6.2)', () => {
  // Assertions score 1 (pass) or 0 (fail) and never vary between runs.
  const failed = classify([1, 1, 1], [0, 0, 0]);
  assert.equal(failed.noiseFloor, 0);
  assert.equal(failed.outcome, 'regressed');

  const fixed = classify([0, 0, 0], [1, 1, 1]);
  assert.equal(fixed.outcome, 'improved');

  const stable = classify([1, 1, 1], [1, 1, 1]);
  assert.equal(stable.outcome, 'flat');
});

test('classify: a wildly noisy base swallows a real-looking drop', () => {
  // Base ran 5, 1, 3 -> floor of 4. Head median 1 is a drop of 2, well inside it.
  // Reporting this as a regression is exactly the false positive §10 forbids.
  const r = classify([5, 1, 3], [1, 1, 1]);
  assert.equal(r.noiseFloor, 4);
  assert.equal(r.outcome, 'inconclusive');
});

test('classify: reports both spreads so the UI can draw the band and the ticks (§8.2)', () => {
  const r = classify([4, 4, 3], [2, 3, 2]);
  assert.equal(r.baseMedian, 4);
  assert.equal(r.headMedian, 2);
  assert.equal(r.baseSpread, 1);
  assert.equal(r.headSpread, 1);
});

test('summarize: any regression makes the whole run a regression', () => {
  const s = summarize([
    { outcome: 'flat' }, { outcome: 'regressed' }, { outcome: 'improved' }, { outcome: 'inconclusive' },
  ]);
  assert.equal(s.verdict, 'regressions');
  assert.deepEqual(s.counts, { improved: 1, regressed: 1, flat: 1, inconclusive: 1 });
});

test('summarize: inconclusive outranks clean when nothing regressed', () => {
  const s = summarize([{ outcome: 'flat' }, { outcome: 'inconclusive' }]);
  assert.equal(s.verdict, 'inconclusive');
});

test('summarize: clean only when every case is flat or improved', () => {
  const s = summarize([{ outcome: 'flat' }, { outcome: 'improved' }, { outcome: 'flat' }]);
  assert.equal(s.verdict, 'clean');
  assert.equal(s.counts.regressed, 0);
});
