# Sources, verification status & known assumptions

Prepared **2026-10-12**. Official documentation references below describe the implementation sources; this repository and local runtime were inspected. The current environment reports configured OpenAI/fal credentials, Pi `openai-codex/gpt-5.5`, Chrome, Decisions access, and a $5 session cap. Secret values were not printed. Current budget/health and fresh run evidence are recorded in `docs/BUILD_LOG.md` and `demo/native-mcp-verification.json`.

## Official technical sources

1. **OpenAI Decisions API** — `choice` / `predicate` / `score`, `gpt-6-luna`, request structure, response `confidence`, pricing ($0.10 per 1M input tokens, subject to processing caveats). https://developers.openai.com/api/docs/guides/decisions
2. **Codex MCP documentation** — local stdio registration and configuration. https://developers.openai.com/codex/mcp
3. **OpenAI developer documentation MCP** — optional docs lookup service. https://developers.openai.com/learn/docs-mcp
4. **Pi RPC Mode** — long-running Pi subprocess, JSONL commands and events, `pi --mode rpc --no-session`; SDK alternative. https://pi.dev/docs/latest/rpc
5. **pi-browser-use package** — third-party package; verify current version, permissions, Node requirements, installed version/source before installation. https://pi.dev/packages/pi-browser-use
6. **fal queue and async inference** — request IDs, submit/status/result, cancel. https://fal.ai/docs/model-endpoints/queue
7. **fal JavaScript SDK + image model API example** — `@fal-ai/client` with `FAL_KEY`; verify exact endpoint and schema. https://fal.ai/models/fal-ai/flux/schnell/api
8. **Hackathon source** — Build Anything with Codex, event rules, 2-min pitch, $50 fal credit *claim* after check-in; not proof account is credited. https://luma.com/2muyi4f3
9. **Research motivation:** HM-ROUTER: Joint Model and Harness Routing for Agentic Systems. https://arxiv.org/abs/2609.32213
10. **Research motivation:** Harness Learning Enables Generalizable Test-Time Adaptation. https://arxiv.org/abs/2609.35738
11. **User-supplied participant guide:** https://slushd-hack-guide.vercel.app/participants/openai ; remote viewer returned an error, **contents not verified**. Use official Luma page and in-person organizer guidance as source of truth.

## Verified versus to verify

| Item | State |
|---|---|
| Decisions API supports fixed-choice routing; app supplies eligible route IDs | Official docs checked; real historical and fresh selection traces exist |
| `gpt-6-luna` is the router decision model | Official docs checked; task execution uses separately configured Pi/fal models |
| Pi RPC subprocess and controlled browser extension | Implemented and exercised with a fresh public-page run |
| `pi-browser-use` third-party extension | Audited and not installed; current adapter uses the first-party restricted extension |
| fal queue and generated artifact retrieval | Implemented; fresh fal run produced and decoded an image |
| `fal-creative` improves speed, cost, or quality | **NOT PROVEN**; one small comparison is insufficient and art was not human-graded |
| Local route health and provider credentials | Present in current non-billable precheck; secret values withheld |
| Native Codex MCP result/metering contract | Fresh native schema 1.2 browser/image responses and get_run match persisted results, including usage/cost components and criterion statuses. Earlier stale 1.1 runs remain historical. |
| Current session cap | $5 configured; latest native health read reports $4.768 remaining after final P0 verification. This is a cap balance, not invoice data. |

## Important conceptual constraints

- Decisions does **not** execute harnesses or discover all model/runtime combos for you.
- `confidence` does not mean probability of successful execution.
- Avoid two dependent Decisions questions in one API request; provide a single choice over valid combined routes, or separate dependent calls.
- Pi agent model settings and fal generation model IDs are distinct. `gpt-6-luna` being decision model does not imply it runs selected tasks.
- Quality optimization is conditional on validated policy, endpoint data and independent outcome measurement; it is not an automatic property of using a harness.
- HM-ROUTER is external related work, not evidence of this MVP's expected percentage improvements.
