# Field report: we built CI for prompts, and the first bug was in the tests

**Sentinel** is a prompt regression gate. It runs an eval suite against both versions of a
changed prompt, accounts for run-to-run noise, and stops before merge. Built in a week for
the Agent Harness Hackathon (WeMakeDevs × TrueFoundry × Qodo).

Repo: https://github.com/ParthGupta1304/sentinal

## The job we gave the agent

ORCHESTRA is a multi-agent hackathon judge. Its clarity prompt is a real file,
`backend/prompts/clarity-judge.md`. When that file changes, nothing in CI notices. The
output is a qualitative assessment, so regressions are invisible: JSON still parses, the
score still looks plausible, and `chiefJudge` quietly keys its confidence off a fallback
sentence that is no longer there.

Sentinel’s job: read the PR, run 10 cases against both versions, N=3, and only call a drop
a regression when it **exceeds** the spread observed on the unchanged prompt. Then stop.
A human merges.

## What TrueForge handled

- **GitHub MCP** — read the PR, read the file at both refs, comment, merge.
- **Sandbox** — generated assertion code and result files. Writes outside the working
  directory are rejected (`/tmp` fails on purpose).
- **Approval** — `merge_pull_request` and `pull_request_review_write` only. The harness
  default of `@write` would have paused us before posting the findings, which defeats the
  product.
- **Subagents** — one batch of cases each. They return `{case_id, scores, median, spread}`,
  never raw output.
- **Sessions** — close the tab, reopen, the turn is still there.
- **Skill** — `sentinel-scoring`, the noise-floor protocol, loaded into the sandbox.

We wrote the evals, the variance math, and a dashboard that says “This change made 2 tests
worse” instead of a lab plot.

## What broke along the way

**The judge could not see the submission.** We sent it the criterion and the output.
Any rubric that mentioned “the input” was unanswerable. The judge said so in its own
justification rather than guessing, and we scored it down for being honest. Fix: pass the
case input. Blindness is about *which version* produced the output, not about hiding the
fixed case.

**`temperature` is rejected by `claude-sonnet-5`.** The first calibration pass failed every
rubric case with HTTP 400. Stability comes from disabling thinking, not from temperature 0.

**Four criteria demanded behaviour the prompt never promised.** Including one that punished
the judge for returning its documented fallback on empty input. Those are bad cases, not
discovered bugs. Deleted or rewritten.

**The subject, not the judge, flickered.** `gpt-4o-mini` returns an empty `improvements`
array on roughly one run in three with no prompt change. Noise floor 0.80 on a 0–1 scale:
no drop could ever exceed it. Deleted the rubric rather than keep a check that can never
produce a verdict.

**A self-gate is not a gate.** An early instruction said “do not merge.” The model
dutifully refused. No `tool.approval_required` event ever fired. The human never saw a
checkpoint. The instructions now say: when a human asks you to merge, *call the tool*.
The harness holds it.

**An unknown `--case` used to exit 0.** Compare ran zero cases, wrote `verdict: clean`,
and would have passed CI. Calibrate already rejected the typo. Compare now does too.

## The demo regression

Someone “tightens” the prompt by deleting the line that says: if there is nothing to
evaluate, return score 0 with a fixed sentence. JSON still parses. Production would look
fine — ORCHESTRA’s parser even strips code fences and can send broken JSON to GPT-4o to
repair. Sentinel asserts on the **raw** string.

Measured: empty submission 1.00 → 0.80, no-problem-statement 1.00 → 0.67, eight tests
flat. Exit 2. On a cheap re-run, the new prompt scored the empty submission **16**.

That is the whole product in one number.

## What we would do next

A GitHub App instead of a laptop runner. A suite that grows from production traffic.
The eval cases are the asset that does not move to a competitor.
