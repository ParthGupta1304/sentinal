# Sentinel

**A prompt regression gate. It catches prompt regressions in a pull request before they merge.**

Code has a test suite that runs on every PR and blocks the merge. Prompts have nothing. Teams
change a system prompt, swap a few-shot example, tighten an output format — and ship it with
no test, because the author checks the case they were fixing, not the cases they broke.

Sentinel runs an eval suite against both versions of a changed prompt, accounts for run-to-run
variance, and reports what actually moved. Then it **stops**. Merging is irreversible. A human
decides.

Built for the Agent Harness Hackathon (WeMakeDevs × TrueFoundry × Qodo).

---

## What it does

When a prompt file changes, Sentinel reads both versions, runs every eval case against each
one N times, and classifies each case as **worse**, **better**, **same**, or **unclear**.

A case is only **worse** when the median dropped *and* the drop exceeds the noise floor
observed on the unchanged (base) version. A drop inside that floor is **unclear**, shown
rather than hidden. A false regression is worse than a missed one.

The dashboard says it in a sentence a stranger can read:

> This change made 2 tests worse.
> Look at the tests below before you merge.

Click a test to see the current prompt vs the new prompt, with Passed/Failed in words. Raw
model JSON is behind “Show the model’s reply.”

On the demo fixture (`evals/regressions/clarity-judge-head.md`) that looks like this:

- **Empty submission** — worse. The new prompt still returns valid JSON, but invents a
  plausible score (16) instead of the promised fallback of 0.
- **No problem statement** — worse. Same failure: the insufficient-information line was
  deleted, so the judge guesses.
- The other eight tests stay the same. A credible gate reports what changed, not everything.

`compare` exits **2** when anything is worse, so it can gate CI.

---

## Architecture

Sentinel targets **ORCHESTRA**, an existing multi-agent project that judges hackathon
submissions. That choice is deliberate, not incidental: its judging prompts are real, not
invented for a demo, and a judging prompt is exactly the case where a regression is invisible
without evals — the output is a qualitative assessment, not a value you can diff.

There are two ways to run a comparison, and they share everything downstream of "get two
prompt strings." Path A is how a human runs one on a laptop. Path B is how it runs from a PR,
gated by a harness instead of a person's habit of remembering to run it.

**A — local / CI path.** No agent, no sandbox. You already have both prompt files.

```
you                 runner/src/compare.mjs
 │  --head <file>         │
 └───────────────────────>│  loads evals/suite.yaml + evals/cases/*.yaml
                           │  for each case, N runs per version:
                           │    subject model  → runner/src/run-case.js
                           │    judge model     → runner/src/judge.js   (assertions: runner/src/assertions.js)
                           │  variance.js:  classify() + summarize()
                           │  writes runs/{run_id}/verdict.json
                           v
                     web/server.mjs  (static Node server, no framework)
                           │  reads verdict.json; fetches a raw case file
                           │  from disk only when a human expands it
                           v
                     dashboard @ :4310
```

`compare` exits `2` when anything regressed, so path A is also how this gates a normal CI
job on a machine that has the model keys — no TrueForge required for that part.

**B — the agent, on TrueForge.** This is the one the hackathon is judging: the harness
enforcing a real stop, not the model choosing to be careful.

```
GitHub (ORCHESTRA)                TrueForge harness — agent: sentinel
 PR touches a prompt file   PR #    ┌──────────────────────────────────────────┐
 ─────────────────────────────────> │ MCP: GitHub                              │
                                     │  pull_request_read                       │
                                     │  get_file_contents (base ref, head ref)  │
                                     │  add_issue_comment           — free      │
                                     │  merge_pull_request           ⛔ approval-gated
                                     │  pull_request_review_write    ⛔ approval-gated
                                     └───────────────────┬───────────────────────┘
                                                          │ splits evals/suite.yaml cases
                                                          │ into batches of 3–5, spawns
                                                          │ one subagent per batch
                                                          v
                                     ┌──────────────────────────────────────────┐
                                     │ Subagent, in a Daytona sandbox            │
                                     │  writes + runs generated Python           │
                                     │   (deterministic assertion checks)        │
                                     │  calls subject + judge models             │
                                     │  writes raw output →                      │
                                     │   runs/{run_id}/{version}/{case_id}.json  │
                                     │  scores per `sentinel-scoring` skill      │
                                     │  returns only:                            │
                                     │   {case_id, scores[], median, spread}     │
                                     └───────────────────┬───────────────────────┘
                                                          │ compact results, never raw
                                                          │ model output — the
                                                          │ orchestrator's context stays
                                                          │ a scores table, not 90 replies
                                                          v
                              variance protocol (same rule as path A) → PR comment
                                                          │
                                             human says "merge it"
                                                          v
                                     merge_pull_request called → harness PAUSES
                                     tool.approval_required — Allow / Deny
                                                          │
                                                    a person decides
```

`file_downloads: true` on the sandbox is what lets a TrueForge run's raw case files land in
the same `runs/{run_id}/` layout path A writes, so the same dashboard reads either kind of
run without knowing which produced it.

### Why the sandbox is load-bearing, not decorative

15 cases × 2 prompt versions × 3 repeats is 90 model responses. Sentinel follows the pattern
TrueFoundry uses in their own agent: **the agent writes raw output to files and only reads
back scored summaries.** The orchestrator never sees 90 raw replies — it sees a scores table.
The sandbox also runs the deterministic assertions (§ eval design below) as real generated
code, not a described check.

### Why the gate is a harness property, not a model promise

Two actions are irreversible: merging the PR, and posting an approving review (which, with
auto-merge on, is the same thing). Both are registered as **approval-gated tools** on the
agent — not enforced by an instruction telling it to be careful. The first version of this
agent was told "do not merge," it agreed every time, and no approval event ever fired: a
model refusing on its own initiative is not the same as the harness pausing, because a person
never sees a checkpoint either way. Everything else — reading a PR, running evals, posting the
comment — is unrestricted, because it's reversible and it's how the evidence gets delivered.

### Evaluation design, in brief

An eval case is an input plus a list of expectations, checked two ways:

- **Assertions** (`runner/src/assertions.js`) — pure code, zero variance: valid JSON, required
  keys present, score in range, forbidden strings absent. About half the suite is this kind on
  purpose — format regressions are the most common real prompt regression, and an assertion
  can't produce a false positive.
- **Rubric scoring** (`runner/src/judge.js`) — a *different model family* than the subject
  scores one output at a time, blind to which version produced it, against an explicit
  criterion ("flags the missing demo video explicitly," not "is this good").

Neither is trusted on a single run. Every case runs `N=3` times per version; the **noise
floor** for a case is the spread already observed across its three runs on the unchanged base
version. A case is only **regressed** when the median dropped *and* the drop clears that
floor. A drop inside the floor is **inconclusive**, shown with its runs, never silently
rounded up into a regression — see [What calibration found](#what-calibration-found) for the
run where skipping this step would have made the *tests* the bug.

### What TrueForge does vs what we wrote

| Harness (TrueForge) | We wrote |
|---|---|
| GitHub MCP (read PR, read file at ref, comment, merge) | Eval cases, assertions, rubric judge, variance math |
| Sandbox (generated Python, result files, `file_downloads`) | Local runner that calls the subject and judge models |
| Approval gate on `merge_pull_request` and `pull_request_review_write` only | Dashboard that shows the diff a human can act on |
| Dynamic subagents, one batch of cases each | `sentinel-scoring` skill (the noise-floor protocol) |
| Sessions that survive a tab close | Calibration that proved the suite is stable |

The default TrueForge gate is `["@write", "@destructive"]`. Posting a PR comment is a write,
so that default would pause Sentinel *before* it reports. We gate two literal tool names and
nothing else — comment stays free, merge and approving-review stay held.

### Where this deviates from the original plan, on purpose

The plan called for a Next.js app on both ends. What's built instead:

- **Dashboard is a ~90-line static Node server** (`web/server.mjs`), not Next.js. The one
  screen that carries the demo needs exactly three things from a server — a run index, a
  verdict document, and a raw case file on demand — and a build step adds risk without adding
  capability.
- **Model calls run locally, not inside the sandbox.** TrueForge has no way to pass
  environment variables into a sandbox, and an API key in a prompt persists in the session's
  event history — not an option. The subject and judge are called by the local runner; the
  sandbox still executes the generated assertion code for real and holds the result files that
  never enter the agent's context.

---

## Try it in five minutes

Requires Node 22+ and an OpenAI and Anthropic API key.

```bash
git clone https://github.com/ParthGupta1304/sentinal.git && cd sentinal
npm install
cp .env.example .env        # fill in OPENAI_API_KEY, ANTHROPIC_API_KEY, GITHUB_PAT
```

You also need the target repository checked out next to this one, because the base prompt is
read from its working tree:

```bash
git clone https://github.com/ParthGupta1304/ORCHESTRA.git ../ORCHESTRA
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

Exits `2` when a case regressed beyond its noise floor.

**See it:**

```bash
npm run dashboard           # http://localhost:4310
```

Click a test that got worse. Current prompt vs new prompt.

### The agent, on TrueForge

```bash
npx @truefoundry/trueforge   # http://localhost:8790 — leave running
npm run setup                # model, GitHub MCP, scoring skill, gated merge tools
npm run smoke                # sandbox prints {"median": 4}; GitHub reads the prompt
```

Open TrueForge, pick the `sentinel` agent, give it an ORCHESTRA PR number that touches
`backend/prompts/`. It reads both versions through GitHub MCP, runs the suite (subagents
in the sandbox), comments the comparison, and **stops**. Ask it to merge: it calls
`merge_pull_request`, and the harness pauses until you allow or deny. That pause is the
product. Refusing to call the tool is not a gate.

---

## Repository layout

```
agent/       TrueForge config — instructions, setup, smoke, scoring skill
runner/      eval execution, scoring, variance math, tests
evals/       cases, harvested fixtures, regression fixtures
web/         the run view (http://localhost:4310)
```

| Command | What it does |
|---|---|
| `npm test` | 36 unit tests over the variance math and assertion checks |
| `npm run calibrate` | proves the suite is stable on the unchanged prompt |
| `npm run harvest` | fetches real repo fixtures in ORCHESTRA's own input format |
| `npm run setup` | configures the TrueForge agent, GitHub MCP, scoring skill |
| `npm run smoke` | one agent turn: sandbox + GitHub read. Exits 1 if the median is missing |
| `npm run dashboard` | the run view |

---

## Honest limitations

Two deliberate deviations from the original plan (local model calls, static dashboard) are
covered in [Architecture](#architecture). Beyond those:

**One repository, one prompt.** The suite targets ORCHESTRA's clarity judge.

**Pairwise preference scoring is not built.**

**Nothing detects score-band drift on `clarity-score-calibration`.** Unstable rubric criteria
were deleted rather than left failing. The gap is in the case file.

**Local compares have no pending merge call**, so the dashboard does not show live Approve /
Reject. Those buttons appear only when the run came from a TrueForge session. For the demo,
approve in the harness UI.

---

## What calibration found

Four passes over the unchanged prompt found a runner bug (the judge could not see the
submission), an API constraint (`claude-sonnet-5` rejects `temperature`), four criteria that
demanded behaviour the prompt never promised, and one case that flickered because the
*subject* sometimes returns an empty `improvements` array.

Full record in [CALIBRATION.md](./CALIBRATION.md).

---

## AI assistance

Built with AI coding assistants (Claude Code, Grok). A human curated every eval case,
investigated every calibration failure, and chose the gate design: the harness holds merge,
the agent is not allowed to “be careful” instead.

---

## Qodo Code Review Evidence

Required of every submission. Direct pushes to `main` do not count.

- Representative PR: https://github.com/ParthGupta1304/sentinal/pull/1
  Scoring skill, README that matches the running dashboard, field report, and TrueForge
  setup that loads the skill from this repo.
- What Qodo surfaced, and what we changed or dismissed, is on that PR thread. High
  findings get a fix or a written dismissal; Medium and Low are an engineering call.
- Follow-up: after this evidence section landed, `/agentic_review` was run again on the
  same PR so the trail shows review → decision → re-review of the final code.

---

## Where this goes

Prompt CI does not exist as a category the way code CI does. The path from here is a GitHub
App, hosted runs, and a suite that grows from production traffic. The runner and scoring
logic are decoupled from the dashboard so a hosted version reuses both. The interesting
long-term asset is the eval suite itself.
