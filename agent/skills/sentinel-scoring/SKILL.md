---
name: sentinel-scoring
description: >
  Score Sentinel eval cases and classify them with the noise-floor protocol.
  Use when running the eval suite, comparing base vs head prompts, or writing
  the PR comment. A case is a regression only when the median dropped AND the
  drop exceeds the base version's observed spread.
---

# Sentinel scoring

You score eval cases. You do not decide whether a prompt change should merge.

## Scores

- **Assertions** (deterministic, no model): each check is 1 if it passes, 0 if it fails. Median of those 0/1 scores is the case score. Noise floor is always 0. A flipped assertion is always a real regression.
- **Rubrics** (judge model, different family from the subject): score 1–5 against one explicit criterion, then divide by 5 so it sits on the same 0–1 scale as assertions. Blind: the judge does not know which version produced the output. It may see the case input; that input is identical for base and head.

Never average assertion scores with rubric scores. Classify each kind on its own, then take the most serious outcome for the case (`regressed` > `inconclusive` > `flat` > `improved`).

## Variance protocol

Every case runs N times per version (N from `evals/suite.yaml`, default 3).

1. Median of the N scores. Even N: average the two middle values.
2. Spread = max − min. A single run has spread 0.
3. **Noise floor** = spread observed on the **base** version only.
4. Delta = head median − base median.
5. Classify:
   - delta = 0 → `flat`
   - |delta| **exceeds** the floor and delta < 0 → `regressed`
   - |delta| **exceeds** the floor and delta > 0 → `improved`
   - |delta| ≤ floor → `inconclusive`

A drop **exactly equal** to the floor is inconclusive, not a regression. When a result is ambiguous, report inconclusive. A false regression is worse than a missed one.

## What you return

Subagents return only compact results, never raw model output:

```
{case_id, version, scores: [...], median, spread}
```

Raw responses live in `runs/{run_id}/{version}/{case_id}.json` (relative path; the sandbox rejects `/tmp` and `/sandbox`).

## What you write on the PR

Counts first, then a line per case that did not stay flat, with base median, head median, and noise floor. Name the inputs that broke.

Write "2 cases regressed beyond noise", never "Regressions detected!".
