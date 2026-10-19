# Product specification — harnessrouter v0.1

## Problem

Agent sessions are frequently configured around a default set of tools and execution assumptions. Browser automation, coding, and creative generation can require different tool surfaces, model affordances, context handling, permissions, latency/budget and verification procedures. Manually switching contexts loses continuity and hides comparison data.

## Target user & job-to-be-done

**Developers using Codex**: "Keep my agent session as orchestrator, but delegate a task to a more appropriate specialist agent harness and receive trustworthy, inspectable results."

## North-star claim

Task-aware execution across *multiple actual harness runtimes*, not merely a tool/API dispatch table. MVP validates interoperability; optimization remains a measured hypothesis.

## Explicit scope

- Input: user prompt or Codex-derived subtask, requirements, allowed domains, desired artifact, acceptance criteria, max cost and timeout.
- Output: route selection, execution result, artifact records, and structured trace.
- Available: Pi-browser (remote process), fal-creative (custom specialist), host defer.
- Decision: one `choice` from filtered eligible `(harness, configured model/profile)` routes.
- Composition: Codex explicitly calls router twice: inspect style → generate visual with passed findings.

## User stories & acceptance

**US1:** Given a public URL, Codex asks `route_task` to inspect it. Router chooses a Pi-browser profile, Pi independently navigates and supplies factual text + screenshot. **Accept** screenshot exists, title/URL validated, execution trace IDs correlate.

**US2:** Given a constrained 16:9 hero image request, Codex asks `route_task` to generate. Router chooses a fal-creative profile, custom harness validates options, prepares model-specific generation, handles queue lifecycle, verifies file. **Accept** nonempty valid image, verified endpoint, request ID, budget not exceeded.

**US3:** Given a combined task, Codex uses US1 output as context for US2. **Accept** two trace IDs, valid route selection for each step (Decisions when multiple routes remain, not_required when only one remains), both verified artifacts from the same host session, and matching parent/observation provenance.

**US4:** Given an unsupported/sensitive task, router doesn't silently invent a compatible route. **Accept** explicit `no_eligible_route` / `defer_to_host` / `permission_required`, no paid side-effect.

**US5:** Given temporary provider/API failure, return distinguishable error with audit evidence. **Accept** no fabricated "completed" outcome or repeated charged call.

## Non-goals for the event

- Harness marketplace, untrusted user-uploaded code execution or hosted multi-tenant platform.
- Browser agent implementation from scratch, arbitrary Claude Code/OpenCode integrations, infrastructure-heavy distributed queue.
- Statistical proof of the best harness across tasks and models.
- Unlimited video generation, post-production image editing UI, sophisticated visual quality scoring.

## Differentiate harness versus tool

- **Tool:** one invocation such as `fal.subscribe()` or browser navigate.
- **Harness:** self-contained specialized policy and lifecycle: execution loop, tool set, allowed models, context strategy, constraints/permissions, failure recovery, result verification, trace/artifact production.
- **Router:** discovers eligible harness routes and selects which harness+model profile receives a task.

`fal-creative` must implement a real specialization layer on top of fal, not simply renaming the API call. The small controlled agent-style lifecycle is enough for the current product scope; more LLM calls are not necessarily better.

## Success metrics

Primary: valid end-to-end handoffs, verified artifacts, failure rate. Secondary: route correctness on labeled fixtures, task success, end-to-end latency, incremental fees vs direct API, decision overhead. **Do not assert efficiency gains without controlled comparisons.**
