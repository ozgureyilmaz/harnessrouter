# Review delivery allowlist

This is the intended source-review boundary. It does not stage or commit files.

## Include

- `README.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.check.json`, and `.gitignore`
- `src/**`, `tests/**`, `contracts/**`, `fixtures/**`, and `scripts/**` (required by the documented npm commands)
- `config/harness-registry.yaml`, `config/harness-registry.example.yaml`, and `config/.env.example`
- `docs/ARCHITECTURE.md`, `docs/CURRENT_STATUS_REVIEW.md`, `docs/DELIVERY_ALLOWLIST.md`, `docs/DEMO_AND_PITCH.md`, `docs/EXPERIMENTS_AND_METRICS.md`, `docs/FAL_PROFILES.md`, `docs/PRODUCT_SPEC.md`, `docs/RUNBOOK.md`, `docs/SECURITY_AND_COST.md`, `docs/SOURCES_AND_ASSUMPTIONS.md`, and `docs/VALIDATION_GATES.md`
- `demo/README.md`, `demo/run-log.md`, `demo/browser-task.json`, `demo/image-task.json`, `demo/offline-evaluation.json`, `demo/live-routing-evaluation.json`, `demo/native-mcp-verification.json`, and `demo/provenance-audit.json`
- `docs/DELIVERY_REVIEW.json` — exact candidate file manifest and scan results; review only, never automatic staging
- `.github/workflows/pages.yml`, `docs/LOCAL_METERING.md`, and `demo/preview/**` — portable Pages source, sanitized snapshots, and explicitly reviewed original demo images
- `demo/creative-pilot-20261012.md`, `demo/paired-comparison-plan.md`, `demo/codex-only-run.json`, `demo/browser-comparison.md`, and `demo/browser-comparison.json` — bounded experiment summaries and portable task/evidence records

## Exclude

- Secrets and local state: `.env*` except `config/.env.example`, `artifacts/**`, `node_modules/**`, and `dist/**`
- Local agent/build-session instructions: `AGENTS.md`, `CODEX_BUILD_PROMPT.md`, `START_HERE.md`, `.codex/**`, `.claude/**`, `docs/BUILD_LOG.md`, `docs/IMPLEMENTATION_PLAN.md`, and `docs/PI_AUDIT.md`
- Presentation work: `.presentation-build/**` and `presentation-output/**`
- `demo/metrics.json` until its run-specific absolute paths and assumptions are made portable; use the concise run-log summary for source delivery.
- `demo/paired-agentation-comparison.json` and `.md` — local records contain machine paths; the public browser-only pilot and creative-pilot summary remain separate.
- `_site/**` — local deployment build output, if generated.

The excluded presentation directories are existing user files. Leave them intact; exclusion means only that they are outside this source delivery.

## Completed P0 delivery review

The candidate manifest contains 96 files plus the self-described review JSON. No configured provider credential literal or private-key marker was found among those candidates. The current working tree also contains later edits from another chat; the manifest records their current hashes but does not claim they passed the P0 checks. Use the separate live and final-local fingerprints in the native evidence for the verified revision. No files were staged, committed, pushed, or removed.

That JSON manifest is a historical P0 snapshot. The README/Pages preparation adds files and changes hashes; do not interpret the old manifest as validation of the current checkout.

## Pages publication boundary

Only `demo/preview/` is uploaded by the Pages workflow. The exporter reads local evidence offline, validates the featured native results and asset hashes, and emits a field-allowlisted snapshot. Raw provider results, traces, URLs, absolute paths, credentials, and the session ledger are not copied into its run records. The separately captured browser-only public-page dataset retains its shared prompt and measured observations. All public images are original reviewed artifacts, copied without modification.

`npm run demo:check` validates the public file allowlist, original image hashes, snapshot consistency, portable links, script syntax, and common credential/local-path markers. Deployment needs no OpenAI/fal keys or project dependency installation. The git commands for source delivery should use the explicit project paths; ignore rules exclude existing local presentation work and private runtime state.
