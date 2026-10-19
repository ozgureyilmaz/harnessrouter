# Review delivery allowlist

This is the intended source-review boundary. It does not stage or commit files.

## Include

- `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.check.json`, and `.gitignore`
- `src/**`, `tests/**`, `contracts/**`, `fixtures/**`, and `scripts/**` (required by the documented npm commands)
- `config/harness-registry.yaml`, `config/harness-registry.example.yaml`, and `config/.env.example`
- `docs/ARCHITECTURE.md`, `docs/CURRENT_STATUS_REVIEW.md`, `docs/DELIVERY_ALLOWLIST.md`, `docs/EXPERIMENTS_AND_METRICS.md`, `docs/FAL_PROFILES.md`, `docs/PRODUCT_SPEC.md`, `docs/RUNBOOK.md`, `docs/SECURITY_AND_COST.md`, `docs/SOURCES_AND_ASSUMPTIONS.md`, and `docs/VALIDATION_GATES.md`
- `docs/LIVE_EVALUATION.md` and `docs/LIVE_EVALUATION_RESULTS.md` — evaluation commands and portable aggregate results; raw run files remain local.
- `docs/LOCAL_METERING.md` — local measurement commands and report fields.
- `docs/DELIVERY_REVIEW.json` — historical candidate file manifest and scan results; review only, never automatic staging

## Exclude

- Secrets and local state: `.env*` except `config/.env.example`, `artifacts/**`, `node_modules/**`, and `dist/**`
- Local agent/build-session instructions: `AGENTS.md`, `CODEX_BUILD_PROMPT.md`, `START_HERE.md`, `.codex/**`, `.claude/**`, `docs/BUILD_LOG.md`, `docs/IMPLEMENTATION_PLAN.md`, and `docs/PI_AUDIT.md`
- Presentation work: `.presentation-build/**` and `presentation-output/**`

The excluded presentation directories are existing user files. Leave them intact; exclusion means only that they are outside this source delivery.

## Completed P0 delivery review

The candidate manifest contains 96 files plus the self-described review JSON. No configured provider credential literal or private-key marker was found among those candidates. The current working tree also contains later edits from another chat; the manifest records their current hashes but does not claim they passed the P0 checks. Use the separate live and final-local fingerprints in the native evidence for the verified revision. No files were staged, committed, pushed, or removed.

That JSON manifest is a historical P0 snapshot. Later edits change hashes; do not interpret the old manifest as validation of the current checkout.
