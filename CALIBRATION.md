# Calibration record — 2026-08-30

PRD §6.6 step 4, the step §13 lists as the top risk and calls non-negotiable: run the suite
against the **unchanged** prompt and confirm every case passes consistently. A case that
fails or flickers on an unmodified prompt is a bad case, not a discovered bug.

Reproduce with `npm run calibrate` (add `--n 1` for a cheap pass, `--case <id>` for one case).

## Final state — passing

```
clarity-happy-path             assert 1.00 ±0.00   rubric 0.80 ±0.00
clarity-thin-submission        assert 1.00 ±0.00
clarity-empty-input            assert 1.00 ±0.00
clarity-prompt-injection       assert 1.00 ±0.00   rubric 1.00 ±0.00
clarity-truncated-deck         assert 1.00 ±0.00
clarity-oversized-input        assert 1.00 ±0.00
clarity-flags-absent-problem   assert 1.00 ±0.00
clarity-no-hallucination       assert 1.00 ±0.00   rubric 1.00 ±0.00
clarity-evidence-grounded      assert 1.00 ±0.00   rubric 1.00 ±0.00
clarity-score-calibration      assert 1.00 ±0.00   rubric 0.76 ±0.24
```

**All 43 assertion checks stable at 1.00 with zero spread**, across 10 cases × 3 runs. That
is the half of the suite the demo regression is designed to break.

`clarity-score-calibration` at ±0.24 sits just under the 0.25 flag threshold. It passes, but
it is the one case whose noise floor is wide enough to swallow a small real regression. Treat
its verdicts as weaker evidence than the rest.

## What four passes actually found

Calibration was not a formality. It found one API bug and, more importantly, one design bug
in the runner that no unit test would have caught.

### 1. The judge could not see the submission (the real bug)

`scoreRubric` sent the judge only the criterion and the output. Any criterion referring to
"the input" was therefore unanswerable, and the judge said so in its own justification:

> "impossible to verify it accurately describes this particular project"

It was not being fussy. It was refusing to certify a claim it had no way to check, and the
suite was scoring it down for being honest. Fixed by passing the case input to the judge.

**This does not weaken §6.3's blind-scoring rule.** Blindness is about which *version*
produced the output. The input is a fixed property of the eval case, byte-identical for base
and head, so it carries no signal about provenance.

The evidence had been visible from the first pass: every rubric scoring 5/5 had the
submission's facts written into the criterion text itself (`clarity-no-hallucination` spells
out "only a title, the word 'todo', one HTML file, and one commit"). Those cases were hand
-working around the bug without anyone noticing.

Effect: `clarity-happy-path` went 0.40 → 0.80 with spread collapsing to zero.

### 2. `temperature` is rejected by claude-sonnet-5

The first pass failed every rubric case with `400 temperature is deprecated for this model`.
The three cases that passed were the three with no rubric checks. §6.3's "judge temperature 0"
cannot be honored literally; stability comes from `thinking: {type: "disabled"}` instead. See
the note at the top of `runner/src/judge.js`.

### 3. Four criteria demanded behaviour the prompt never promises (§6.6 step 3)

- **`clarity-flags-absent-problem`** asked the judge to name a missing problem statement and
  still credit the architecture. Both scored 1/5 every run, because the submission contained
  no clarity-relevant content, so the prompt returned score 0 with its fixed fallback
  sentence — exactly as it promises. The criteria were asking it to violate its own contract.
  Rewritten as assertion-only, keeping the genuinely interesting finding: a submission can be
  content-rich and still have nothing this dimension can evaluate.

- **`clarity-score-calibration`** had a *malformed* criterion — conditional ("if the score is
  in the 9-14 band, then…"). The subject scored 15, the judge reported "not applicable", and
  scored it 1/5. On a 1-5 scale, "does not apply" and "fails" collapse to the same number.
  Restated unconditionally.

- **`clarity-happy-path`** and **`clarity-evidence-grounded`** required evidence to quote
  named features, files, or commits. The prompt asks for `"evidence": ["point 1", "point 2"]`
  and promises no such thing.

### 4. One case was removed because the subject, not the judge, was unstable

`clarity-thin-submission`'s rubric scored 1/5, 3/5, 5/5 — the widest spread in the suite. The
judge was consistent every time; **gpt-4o-mini returns an empty `improvements` array on
roughly one run in three** with no prompt change at all. That gives a noise floor of 0.80 on a
0-1 scale, so no drop could ever exceed it. Deleted rather than sharpened — the wording was
fine, the check was simply undetectable. Its five assertions remain.

Recorded as a finding about **ORCHESTRA, not Sentinel**: its clarity judge sometimes returns
no improvements at all. Arguably a real pre-existing weakness, but not a regression detector.

## The pattern worth reusing

Every criterion that scored a clean 5/5 names a **failure mode**. Every one that scored 1-3
asked for a **quality judgement** — "specific", "generic", "actionable". An adjective the
judge has to weigh produces a spread, because it is asking for an opinion; a named failure
produces a verdict.

## A note on the calibration script itself

The first pass reported "Stable" while four cases scored 1-2 out of 5. It only flagged high
spread, never a low median. A rubric that fails consistently on the baseline is just as broken
as one that flickers and is easier to miss, because it looks stable — it leaves no room to
detect a further drop and would read as a permanent regression on every future run.
`runner/src/calibrate.mjs` now flags a rubric median below 0.7.
