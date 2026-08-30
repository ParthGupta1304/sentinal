# Sentinel

**A prompt regression gate. It catches prompt regressions in a pull request before they merge.**

Code has a test suite that runs on every PR and blocks the merge. Prompts have nothing. Teams
change a system prompt, swap a few-shot example, tighten an output format — and ship it with
no test, because the author checks the case they were fixing, not the cases they broke.

Sentinel runs an eval suite against both versions of a changed prompt, accounts for run-to-run
variance, and reports what actually moved. Then it stops, because merging is irreversible and
a human should decide.

Built for the Agent Harness Hackathon (WeMakeDevs × TrueFoundry × Qodo).

---

## What it does

When a prompt file changes, Sentinel reads both versions, runs every eval case against each
one N times, and classifies each case:

```
2 cases regressed beyond noise
2 regressed   0 improved   8 flat   0 inconclusive

case                          noise band      base → head   floor   outcome
clarity-happy-path            ──────┃──────    1.00 → 1.00   0.00    flat
clarity-empty-input           ───┃──────┃──    1.00 → 0.80   0.00    regressed
clarity-flags-absent-problem  ──┃───────┃──    1.00 → 0.67   0.00    regressed
```

The output is not a score. It is a diff at the level of individual test cases, with the real
model outputs shown side by side.

### The part that makes it trustworthy

The same prompt run twice produces different outputs, and a judge model scores identical
outputs differently. So "base scored 4, head scored 3" means nothing on its own.

Every case runs N times per version. The **noise floor** for a case is the spread observed on
the *base* version — how much it moves when nothing changed. A case is reported as
**regressed** only when the median dropped *and* the drop exceeds that floor. A drop inside
the floor is **inconclusive**, shown with its runs rather than hidden.

A false regression is worse than a missed one, because it destroys trust in the gate. When a
result is ambiguous, Sentinel says so.

---

## Try it in five minutes

Requires Node 22+ and an OpenAI and Anthropic API key.

```bash
git clone <this repo> && cd sentinel
npm install
cp .env.example .env        # fill in OPENAI_API_KEY, ANTHROPIC_API_KEY, GITHUB_PAT
```

You also need the target repository checked out next to this one, because the base prompt is
read from its working tree:

```bash
git clone https://github.com/ParthGupta1304/ORCHESTRA ../ORCHESTRA
npm run harvest             # fetch real submission fixtures from GitHub
```

**Confirm the suite is stable before trusting any comparison:**

```bash
npm run calibrate           # ~90s, runs every case against the unchanged prompt
```

**Then compare a changed prompt against it:**

```bash
node runner/src/compare.mjs --head evals/regressions/clarity-judge-head.md
```

Exits `2` when a case regressed beyond its noise floor, so it can gate CI directly.

**See it:**

```bash
node web/server.mjs         # http://localhost:4310
```

Click any row to expand the two raw outputs side by side.

---

## Repository layout

```
agent/       TrueForge configuration — instructions, setup, smoke test
runner/      eval execution, scoring, variance math, tests
evals/       cases, harvested fixtures, regression fixtures
web/         the run view
```

| Command | What it does |
|---|---|
| `npm test` | 36 unit tests over the variance math and assertion checks |
| `npm run calibrate` | §6.6 step 4 — proves the suite is stable on the unchanged prompt |
| `npm run harvest` | fetches real repo fixtures in ORCHESTRA's own input format |
| `npm run setup` | configures the TrueForge agent, model provider, and GitHub MCP |
| `npm run smoke` | one end-to-end agent turn: sandbox, GitHub read, report |

---

## How the gate works

`merge_pull_request` and `pull_request_review_write` are registered with the harness as
approval-gated tools. When the agent calls either, TrueForge pauses the run *before* the tool
executes and emits `tool.approval_required`. A human allows or denies; only then does it run.

Two details that are easy to get wrong, and both were:

**The gate belongs to the harness, not the agent.** An early version of the instructions told
the agent "do not merge". It dutifully refused — and no approval event ever fired, because the
tool was never called. That is a self-gate wearing the costume of a real one: the human never
sees a checkpoint, and the safety property becomes a matter of the model's judgement instead
of a property of the system. The instructions now tell the agent to call the tool when asked
and let the harness hold it.

**The default gate configuration is wrong for this product.** TrueForge defaults to
`["@write", "@destructive"]`, and posting a PR comment is a write — so the agent would pause
before reporting its own findings. Sentinel gates two literal tool names and nothing else.
Reading, running evals, and commenting are free; only the irreversible actions stop.

---

## Honest limitations

**Model calls run locally, not in the sandbox.** TrueForge exposes no way to pass environment
variables into a sandbox, and putting an API key in a prompt is not an option — it persists in
the session's event history. So the subject and judge models are called by the local runner,
which holds the keys. The sandbox still does the work §5.3 asks of it: executing generated
assertion code and holding result files that never enter the agent's context. This is the
escalation the PRD anticipated (§13): run locally, keep the sandbox for assertion execution,
and say so here.

**One repository, one prompt directory, one prompt.** The suite targets ORCHESTRA's clarity
judge. Nothing generalises automatically.

**Pairwise preference scoring is not built.** §6.4 makes it conditional on the other two
scoring modes being finished early. They were not.

**The dashboard is a static server, not the Next.js app** described in the PRD. One screen
carries the demo; a build step would have added risk without adding capability.

**Nothing detects score-band drift on `clarity-score-calibration`.** Its rubric criteria could
not be made stable across calibration runs and were removed rather than left failing. The gap
is recorded in the case file.

---

## What calibration found

Calibration is not a formality — it is the difference between a gate and a noise generator.
Four passes over the unchanged prompt found:

- **The judge could not see the submission.** Any criterion referring to "the input" was
  unanswerable, and the judge said so in its own justification rather than guessing. Every
  rubric that scored well had been hand-working around this by restating the submission inside
  the criterion text.
- **`temperature` is rejected by `claude-sonnet-5`**, so §6.3's "judge temperature 0" cannot be
  honoured literally. Stability comes from disabling thinking instead.
- **Four criteria demanded behaviour the prompt never promised**, including one that punished
  the judge for correctly returning its own documented fallback.
- **One case was unstable because the *subject* was**, not the judge: gpt-4o-mini returns an
  empty `improvements` array on roughly one run in three. Deleted, since a check that can never
  produce a verdict is not worth its cost.

Full record in [CALIBRATION.md](./CALIBRATION.md).

---

## Where this goes

Prompt CI does not exist as a category the way code CI does, and the teams who need it most
ship fastest. The path from here is a GitHub App rather than a local runner, hosted runs, and
a suite that grows from production traffic instead of hand-written cases.

The runner and scoring logic are decoupled from the dashboard so a hosted version reuses both.
The interesting long-term asset is the eval suite itself — the thing a team cannot easily move
to a competitor.
