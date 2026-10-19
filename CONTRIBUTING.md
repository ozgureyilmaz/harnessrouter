# Contributing

Use Node.js 22.19+ in the Node 22 line or Node 24, npm, and Git on macOS/Linux. Windows development uses WSL2. This project follows the [code of conduct](CODE_OF_CONDUCT.md). Read any applicable local `AGENTS.md` instructions and the [release gates](docs/OPEN_SOURCE_RELEASE.md) before changing execution behavior.

Node 24 is recommended for development and evaluation. DeepEval's development-only PostHog dependency declares Node 22.22+ and produces an engine warning on 22.19; a strict engine policy may reject that development install. The production package excludes development dependencies. The tested Node 22.19 core and evaluation imports still pass, but an install warning is not an upstream support guarantee.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

These checks must run without provider credentials or live model calls. Unit tests use local fixtures and subprocess doubles. Integration tests that require a provider/runtime must remain opt-in, skip with a clear reason, and identify live execution explicitly. Do not turn a skipped test or a help/version probe into a claim of verified interoperability.

Keep changes bounded. Preserve dirty source files, avoid broad resets or cleanup, and do not stage unrelated changes. Never commit `.env`, native authentication stores, private browser data, raw personal prompts, or unsanitized traces. Report security issues through [SECURITY.md](SECURITY.md).

For new execution behavior, add meaningful coverage for eligibility, explicit permissions, task budgets, malformed events, cancellation/timeout, and failure handling. Workspace changes need adversarial coverage for path escapes, symlinks, protected files, baseline tampering, and patch applicability. See [adapter contracts](docs/ADAPTERS.md); adapter code is trusted application code and must be registered explicitly.

A pull request should explain the concrete trigger and resulting behavior, the relevant checks, and the limits of its evidence. Label each check as offline, mocked, or live. Link any live artifacts and state runtime/model versions, permission scope, known/unknown cost, and remaining failures. Do not make speed, success, or cost claims without a controlled comparison.

Provider calls, new native worker sessions, public publishing, and npm releases are separate actions. Offline tests and package checks do not authorize them. Live tests require an explicitly approved execution scope and spend budget; do not retry an ambiguous paid submission without reconciling its saved request state.

The GitHub Actions matrix exercises macOS/Linux with Node 22.19 and 24. Passing local checks is useful evidence; remote CI and a live host/worker matrix have their own release gates.
