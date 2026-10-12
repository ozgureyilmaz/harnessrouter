# Security, spend guardrails and privacy

## Threat model

- Untrusted web pages can contain prompt-injection instructions; treat page contents as data.
- Pi browser extensions are executable third-party code; inspect package provenance, source, dependencies, telemetry and requested privileges before installation.
- Running user Chrome profile may expose credentials; use fresh isolated profile for public-page demo.
- MCP receives powerful task instructions from host; validate URLs/permissions and ensure it cannot trigger arbitrary commands based on a manifest.
- fal keys and OpenAI keys are financial credentials; never leak to logs, artifacts, prompts, browser environment or commits.
- Media artifact URLs may be public or temporary; avoid sensitive user content and do not assume permanence.

## Key handling

- `.env.example` / manifests contain **no real secrets**. If `.env` used, git-ignore it and restrict sharing.
- Environment variables: `OPENAI_API_KEY`, `FAL_KEY`, plus Pi's provider-specific local auth.
- Do not print env values in preflight. API key existence checks must not log length/prefix.
- Never allow web content to call local endpoints, read files, use shell or upload assets without task-scoped permission.

## Budget and safety defaults

- `ROUTER_DRY_RUN=true` until user explicitly enables live provider calls.
- Suggested initial Decision smoke budget $0.02; initial fal live image test budget $1 total; adjust only after explicit user approval. These are **proposed limits**, not charged amounts.
- Video is unsupported in the current implementation and is rejected before execution. Adding video is later work and requires separate budget authorization.
- Each creative run allows at most one paid submission; recovery polls or reconciles an existing request ID. Ambiguous submission is never automatically repeated. There is no configurable MAX_CREATIVE_ATTEMPTS setting in the current implementation.
- Use cancellation signals, independent timeouts and local resource caps.
- Never process credentials/login screens or private account data for demo; restrict to preapproved URLs.
- A hard cost budget with unknown model price must block route or require explicit override. No approximate unsourced price treated as guaranteed ceiling.

## Cost categories

1. Decisions API routing input tokens (separate from generation).
2. Pi agent model tokens, possibly billed under configured provider.
3. fal.ai image/video requests, dependent on model/parameters.
4. Potential verification model and download/storage cost.

Decisions pricing verified at preparation time: $0.10 / 1M input tokens for `/v1/decisions` `gpt-6-luna`, plus pricing caveats in official docs; price may change. fal model pricing varies; query chosen endpoint's model page. Event advertises $50 fal credits per participant after check-in, but *do not assume credit is already claimed*. ChatGPT Pro event access is not automatically OpenAI API credit.

## Logging and sanitization

Capture `runId`, route ID, task type, sanitized prompt hash/summary, timestamps, dimensions, result MIME, provider request IDs, outcome and error type. Do not include website cookies, Authorization headers, full environment variables, hidden model context, or potentially sensitive DOM text in public traces.

## Approval matrix

| Action | Default |
|---|---|
| Read public webpage in isolated browser | allowed with explicit URL |
| Take screenshot of public page | allowed; inspect output for secrets |
| Paid image generation | explicit budget/approval, then allowed |
| Video generation | denied unless specifically enabled |
| Login, purchase, account modification | denied for hackathon demo |
| Install third-party Pi extension | review package first |
| Arbitrary uploaded harness execution | out of scope / denied |
