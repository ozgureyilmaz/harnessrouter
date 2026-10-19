# Security policy

harnessrouter starts independent local agent runtimes. Only enable a profile after trusting the executable, provider/account, model configuration, and workspace scope. Runtime capability checks fail closed when required isolation controls are absent.

## Report a vulnerability

Use GitHub private vulnerability reporting if it is available on this repository. Otherwise open a minimal issue asking for a private reporting channel, without credentials, exploit details, private paths, or personal data. Do not attach native authentication files or unsanitized traces to a public issue.

## Execution boundary

Worker profiles and workspace roots come from trusted user-level or explicitly selected configuration. Project JSON and dotenv files are ignored unless `HARNESSROUTER_TRUST_PROJECT_CONFIG=true`; reviewing the project before enabling that flag is required. Tasks cannot register executables, adapters, plugins, or workspace roots. Execution requires explicit local permission, an enabled profile, a compatible runtime, and per-task authorization for unknown-cost usage. The host remains responsible for reviewing and applying returned patches.

Snapshots copy current tracked file contents, including dirty edits and deletions; untracked files require explicit inclusion. Known secret filenames and inherited agent/control configuration are excluded. Absolute/traversing include paths, symlinks, hardlinks, and nonregular files are rejected. Snapshot size/file limits apply before execution and during result collection. Baseline metadata is held outside the worker-accessible filesystem; worker changes to snapshot Git metadata fail verification.

These controls are not a universal OS sandbox. Native runtimes have different isolation capabilities. Post-run checks cannot reliably detect all writes outside the snapshot; filename exclusions cannot recognize secrets stored under arbitrary names. Review eligible source content before authorizing a worker. Do not assume native provider authentication is inaccessible merely because it is absent from the snapshot.

Patches are checked for applicability against captured content, with a baseline fingerprint, changed-file manifest, and SHA256 digest. This verifies an artifact boundary, not semantic correctness. Source changes after capture require a fresh review. Read-only violations, protected writes, and Git metadata tampering are explicit failures.

## Credentials, configuration and cost

Authenticate each worker through its native runtime. Router configuration does not need copied OAuth tokens or native credentials. Environment inheritance is bounded; documented native/provider variables may still reach an authorized worker. Keep `.env` ignored and private. `OPENAI_API_KEY` is for optional OpenAI routing; `FAL_KEY` is for optional image execution. Pi credentials follow its configured provider.

Do not load task-supplied MCP servers, hooks, extensions, or packages. Worker recursion is blocked. OpenCode remote/well-known and organization metadata profiles remain unavailable when inherited configuration cannot be safely excluded. See [compatibility](docs/COMPATIBILITY.md).

Explicit `allowUnknownCost` means a per-run USD charge cannot be verified or fully capped by router price reservations. Native subscription usage may be billable. `allowPaid: false` does not guarantee native worker execution is free. Provider timeouts/cancellation do not guarantee zero billing, and ambiguous paid submissions must be reconciled before retrying.

Optional Pi browser execution uses isolated public sessions and disallows account login, payments, forms, downloads, and private profiles. Optional fal execution is image-only with approved finite budgets and durable submission state; video is disabled.

## Local artifacts

Runs persist results, provenance, sanitized traces, and artifacts outside the installed package. Local prompts and source-derived outputs can still be sensitive after redaction. Review artifacts before sharing. Keep private workspaces and runtime state out of published tarballs. The package check and static-demo validation verify their specific allowlists; they do not audit arbitrary files on your machine.
