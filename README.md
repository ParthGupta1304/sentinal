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

## What TrueForge does vs what we wrote

| Harness | We wrote |
|---|---|
| GitHub MCP (read PR, read file at ref, comment, merge) | Eval cases, assertions, rubric judge, variance math |
| Sandbox (generated Python, result files) | Local runner that calls the subject and judge models |
| Approval on `merge_pull_request` and `pull_request_review_write` only | Dashboard that shows the diff a human can act on |
| Dynamic subagents, one batch of cases each | `sentinel-scoring` skill (the noise-floor protocol) |
| Sessions that survive a tab close | Calibration that proved the suite is stable |

The default TrueForge gate is `["@write", "@destructive"]`. Posting a PR comment is a write,
so that default would pause Sentinel *before* it reports. We gate two literal tool names and
nothing else.

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

**Model calls run locally, not in the sandbox.** TrueForge exposes no way to pass environment
variables into a sandbox, and putting an API key in a prompt is not an option — it persists in
the session's event history. The subject and judge are called by the local runner. The sandbox
still executes generated assertion code and holds result files that never enter the agent's
context.

**One repository, one prompt.** The suite targets ORCHESTRA's clarity judge.

**Pairwise preference scoring is not built.**

**The dashboard is a static server**, not a Next.js app. One screen carries the demo.

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

- Representative PR: **(filled in on the qualifying PR — see the pull request that adds this section)**
- What Qodo surfaced, and what we changed or dismissed, is recorded on that PR.
- The same PR has a follow-up review against the final code (`/agentic_review` after the
  README and skill landed).

---

## Where this goes

Prompt CI does not exist as a category the way code CI does. The path from here is a GitHub
App, hosted runs, and a suite that grows from production traffic. The runner and scoring
logic are decoupled from the dashboard so a hosted version reuses both. The interesting
long-term asset is the eval suite itself.
