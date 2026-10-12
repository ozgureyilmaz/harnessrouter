# 2-minute pitch/demo playbook

## Positioning

**harnessrouter** — *one agent session. multiple specialized execution environments.*

Problem: Different tasks need different execution capabilities. Developer agents can use tools, but switching runtimes/harnesses often loses continuity and structured evidence.

Solution: A local MCP execution gateway that determines eligible routes, uses OpenAI Decisions to select a specialist harness and its compatible model profile, then returns verified artifacts to the same Codex session.

## Live script

| Time | Screen/action | Proof |
|---|---|---|
| 0:00–0:15 | "One Codex session, multiple specialist harnesses" + Mermaid architecture | Clarity and value |
| 0:15–0:35 | Ask Codex to inspect configured public website | live Decisions route `pi-browser:configured` |
| 0:35–0:55 | Pi browser runs, produces screenshot + style observations | independent Pi process and artifact |
| 0:55–1:20 | Codex asks router to produce matching 16:9 hero illustration using first result | second Decision, `fal-creative:*` and model profile |
| 1:20–1:45 | fal-creative selects/uses optimized parameters, executes queue, image returns | genuine fal request ID, result image, budget/verification log |
| 1:45–2:00 | Show two trace IDs and future marketplace diagram | same-session interoperability + vision |

**Live generation may take longer than allotted pitch time:** Pre-run one full end-to-end execution and capture a *genuine recorded trace* as backup. During pitch, clearly label a recording as a previous run; do not simulate current activity. If real fal generation is queued, show current request ID/status and prerecorded verified result labelled accurately.

## On-screen console layout

```text
┌────────────────────────┬────────────────────────┬────────────────────────┐
│ codex task             │ harnessrouter traces   │ real browser/artifacts │
│ "inspect site and ..." │ eligible route IDs     │ Pi screenshot          │
│                        │ decisions choice      │ generated hero image   │
│                        │ model profile         │                        │
│                        │ verified + duration   │                        │
└────────────────────────┴────────────────────────┴────────────────────────┘
```

## Example task prompt (replace URL with safe reachable site)

> Visit `https://example.com` in an isolated browser, summarize the visual design using only observed evidence, save a screenshot, then create a minimal 16:9 hero illustration in a matching style. Use harnessrouter to delegate each subtask and include both route selections and verified artifacts in the final answer.

For a better design demo, substitute a user-owned/public landing page if it is up and reachable. Avoid prompting unknown third-party sites to trigger logins or forms.

## Fallback order

1. Live two-harness demo works → use it.
2. Pi works, fal queued → show real request ID and prior recorded real artifact.
3. Provider down → show labeled **previous successful trace recording**, plus current outage evidence.
4. Offline/untested → do not claim live integration; demo only verified subset and architecture.

## Judge Q&A

**Is this just tool routing?** No: Pi is a separate agent runtime controlled over RPC; custom creative harness has its own execution lifecycle, state, policies, model-aware optimization, verifier and artifact management. Router returns a common result from both.

**Does Decisions automatically pick every model?** No. It chooses from the eligible **configured route IDs** that we provide, each binding harness and model profile.

**Is it actually more efficient?** Interoperability is what this MVP proves. Cost/latency/quality improvements are hypotheses tested with same-task baselines; we show measured data only.

**What about marketplaces?** Versioned registry proves a shape that could become a marketplace. Uploading and executing third-party harness code is a security problem reserved for later.

**How much did the router cost?** Decisions pricing is very low per token, but total cost includes Pi provider and fal media generation. Show actual measured usage or mark unknown.
