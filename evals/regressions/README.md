# Regression fixtures

Modified versions of `backend/prompts/clarity-judge.md` used to prove Sentinel detects a
real regression without needing a pull request open. Each is a plain file, so the whole
detection path can be exercised locally:

```
node runner/src/compare.mjs --head evals/regressions/clarity-judge-head.md
```

`compare.mjs` exits **2** when a case regresses beyond its noise floor, so it can gate CI
directly.

## `clarity-judge-head.md` — the demo regression

Deletes one line: the instruction to return score 0 with
`'No clarity-relevant assets were provided for evaluation.'` when the input has nothing to
evaluate.

This is what a prompt regression actually looks like in practice. Someone tightening a
prompt removes a line that reads as redundant. Nothing crashes, the JSON still parses, and
every format check still passes. The judge simply stops returning the promised fallback and
invents a plausible-looking low score instead.

That is the damaging part, and it is invisible without an eval: `chiefJudge` keys its
confidence tier off whether any judge returned a fallback score, so a judge that quietly
stops returning one corrupts the confidence tier of every submission it touches, while each
individual output looks entirely reasonable.

Expected: the two cases that exercise the insufficient-information path regress. The rest
stay flat, which is the point — a credible gate reports what changed, not everything.

## `clarity-judge-head-format.md` — the catastrophic regression

Deletes the same line **and** the output-format contract
(`Return ONLY valid JSON. No markdown, no code fences...`).

Measured effect: gpt-4o-mini begins wrapping its response in a ` ```json ` fence
immediately. Every case fails, because the format assertions appear in all of them —
10 regressed, 0 flat.

Two things worth knowing from this fixture:

1. **It was not obvious the model would break.** It might have kept emitting bare JSON out
   of habit at temperature 0.2. It does not. Worth having measured rather than assumed.
2. **In production this regression is silent.** `backend/utils.js` strips code fences and,
   failing that, sends the output to GPT-4o to be repaired. Both layers are good for
   resilience and both hide the fault — which is exactly why the runner asserts on the raw
   model response instead of calling ORCHESTRA's judge functions.

Kept because it is the honest illustration of why the format assertions exist, but it makes
a poor demo: an all-red board shows nothing about the noise floor, since every verdict is
decisive.
