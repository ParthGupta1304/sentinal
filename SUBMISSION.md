# Submission pack — Agent Harness Hackathon

Deadline: **30 August 2026, 8:00 PM London** (00:30 IST 31 Aug).
Form: https://forms.gle/PxGLsWW1HPyroQ5u9

You can be **considered** for all three judged tracks. You can **win only one** of them,
plus blog / swag / star raffle / certificate / interview.

---

## Form fields (paste)

**Public repo:** https://github.com/ParthGupta1304/sentinal

**What the agent does, how it uses TrueForge (short write-up):**

Sentinel is a prompt regression gate. When a PR changes a judging prompt, the TrueForge
agent reads both versions through the GitHub MCP, runs a 10-case eval suite (subagents in
the sandbox, scored with the `sentinel-scoring` skill), comments the comparison, and
stops. `merge_pull_request` is approval-gated: the harness pauses until a human allows
it. The local runner and dashboard show the case-level diff, including a demo regression
where deleting one fallback line makes the model invent a score of 16 on an empty
submission. Model calls run locally (sandbox cannot take env vars); the sandbox still
runs generated assertion code and holds raw outputs.

**Blog post URL:** publish `FIELD-REPORT.md` first, then paste the URL here.

**Demo video:** record from the script below. Keep keys off screen.

**AI disclosure:** Built with Claude Code and Grok. Eval cases and the gate design were
curated by a human. Calibration failures were investigated by hand.

---

## Demo script (~3 minutes)

Before recording: `npx @truefoundry/trueforge` on :8790, `npm run setup`, dashboard on
:4310 with `run-1788081188898` (or a fresh compare) loaded. Terminal font large. No `.env`.

| Time | What is on screen | What you say |
|---|---|---|
| 0:00 | Dashboard headline | Prompt changes ship with no test. |
| 0:15 | TrueForge, sentinel agent | This agent watches a real judging prompt in ORCHESTRA. |
| 0:30 | Tool call: GitHub `get_file_contents` | It reads both versions through MCP. Not a mock. |
| 0:45 | `sandbox.created`, Python running | Generated code runs in the sandbox. `/tmp` is rejected. |
| 1:05 | Close the TrueForge tab, reopen | Session is still there. We did not write that. |
| 1:25 | Dashboard: 2 tests worse | Empty submission and no problem statement. The rest stayed the same. |
| 1:40 | Click Empty submission | Current prompt: score 0. New prompt: score 16. JSON still valid. |
| 2:00 | Back to TrueForge. “Merge it.” | It calls `merge_pull_request`. The harness pauses. That is the gate. |
| 2:20 | Deny, then allow if you want | We wrote the evals. TrueForge did MCP, sandbox, pause, session. |
| 2:40 | Black | One line: a false regression is worse than a missed one. |

If you cannot get a live PR in time: run `npm run smoke` on camera (sandbox + GitHub
read), then the dashboard compare, then in TrueForge type “merge pull request 1 on
ParthGupta1304/ORCHESTRA” so the approval event still fires.

---

## X post (Radio Traffic)

Post this with a 10–20s clip of the dashboard expand, or of the harness pause.
Tags required: **WeMakeDevs, TrueFoundry, Qodo**.

```
Prompt changes ship with no test.

I built Sentinel: it runs evals on both versions of a prompt, ignores noise, and
stops before merge. TrueForge holds the irreversible call. We don't.

Deleting one "redundant" line made the judge score an empty submission 16/20.
JSON still parsed. Production would have shipped it.

@WeMakeDevs @truefoundry @QodoAI
https://github.com/ParthGupta1304/sentinal
```

Post a second if you can: the calibration finding (judge couldn't see the input).

---

## You still have to click

1. Install Qodo on this repo (app.qodo.ai → GitHub → sentinal), then comment
   `/agentic_review` on the qualifying PR if it does not start itself.
2. Record the video.
3. Publish FIELD-REPORT.md (Hashnode / Dev.to / Ghost — anywhere public).
4. Post the X thread.
5. Submit the Google form.
6. Confirm TrueForge is starred: https://github.com/truefoundry/trueforge
   (already starred on the ParthGupta1304 account used for `gh`).
