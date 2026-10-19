# Open-source release implementation

Release candidate implemented on 2026-10-17 and hardened in the 2026-10-18 final review. The current review adds canonical usage accounting, scoped probes, cancellation fixes, read-only performance reports, and the [selectable decision provider layer](DECISION_PROVIDERS.md). See [PERFORMANCE.md](PERFORMANCE.md) and the [final review](FINAL_REVIEW.md). Production sign-off and public npm publication remain pending.

| Stage | State | Evidence |
| --- | --- | --- |
| Shared contracts and keyless local routing | passed offline | Task v1.1/result v1.3; legacy readers; explicit selection, priority ties, policy/unknown-cost checks |
| OpenAI/Jev/Ollaya decision provider layer | implemented; fixtures verified; one OpenAI live decision-only check and local Ollaya smoke passed | Init writes local priority; omitted selector stays OpenAI; explicit provider choice; separate credentials; typed System One protocol; deterministic admission; no silent fallback |
| Snapshot/patch boundary | passed locally | Dirty content preservation, explicit untracked capture, protected paths, limits, Git tamper checks, independent patch applicability |
| Codex/Claude Code/OpenCode/Pi workers | implemented; offline verified | Structured protocol fixtures, real subprocess doubles, native controls; Pi genuine RPC lifecycle |
| Process cancellation and recovery | passed locally | Output bounds, malformed events, timeout/abort, SIGTERM-ignoring descendants, exclusive/stale leases, trace-failure release |
| CLI, packaging, onboarding and CI | implemented | init/doctor/serve/mcp-config; four host formats; MIT; optional specialists; package allowlist |
| macOS Node 22.19.0 | passed locally | Actual version checked; typecheck, 236 passing tests, 6 explicitly skipped live tests, build and package inspection |
| macOS Node 24.19.0 | passed locally | Typecheck, 236 passing tests, 6 explicitly skipped live tests, build and package inspection |
| Clean tarball install | passed locally | Optional dependencies omitted, CLI errors/version, real stdio handshake, four tools, registry and keyless host defer |
| Linux arm64 Node 22.19.0 / 24.22.0 | passed in local containers | Fresh npm install, 236 passing tests and 6 explicit live skips on each; typecheck/build/package checks; clean consumer smoke |
| GitHub Actions on merged source commit | passed | macOS and Linux runners, Node 22.19 and Node 24; all four jobs passed |
| Native four-host/four-worker matrix | not run | Requires compatible native runtimes/accounts and authorized usage |
| Live coding patches and specialist composition | not run for this release | New worker tests are opt-in; historical specialist runs are separate evidence |
| Public npm publication | prepared, not performed | Unscoped name `harnessrouter` was free on 2026-10-19; tag workflow and changelog are in place; no tag or publish has been run |

One decision-only OpenAI request selected an eligible route without executing a worker. This is API and response evidence, not a verified execution or outcome claim. No live Jev request, native worker task, or fal generation was run. A local Ollaya inference separately checked the local decision protocol. A live test skip is not interoperability proof. Applicable patches and parseable completion events do not establish semantic task success.

## Reproduce the offline checks

Use Node 22.19+ in the Node 22 line or Node 24:

```bash
npm ci
npm run check
npm run package:smoke
```

`package:smoke` installs a freshly packed tarball into a temporary consumer without optional dependencies. A fresh runner may fetch dependency metadata or tarballs from npm; it never makes model/provider calls. `npm ci` alone does not guarantee cached npm metadata. Use `npm run package:smoke -- --offline` only with a fully populated dependency and metadata cache. No provider keys are needed.

## Trust and execution defaults

`harnessrouter init` writes `selector: "local"`. That first-run path uses configured priority and does not need a decision API key. OpenAI Decisions, Jev, and local Ollaya are explicit opt-ins (`--selector decisions` or `--decision-provider`). A config file or process that omits `selector` still resolves to OpenAI Decisions, so older files stay fail-closed instead of silently ranking workers. Missing hosted credentials and authorization never cause an automatic provider switch. Project JSON/dotenv settings require `HARNESSROUTER_TRUST_PROJECT_CONFIG=true`; an explicitly selected config file is a trusted choice. Init generates disabled profiles and no workspace grants. Dry run, execution, and paid calls stay off. Global/profile execution permission and per-task unknown-cost consent are separate from priced provider authorization.

Claude uses router-owned workspace MCP tools. Pi uses the pinned SDK's genuine RPC server, with explicit provider/model, controlled resources and bounded file tools. OpenCode supports the audited 1.18.15 ordinary native API/OAuth subset using isolated configuration/database; unsupported remote/managed configuration fails closed. Codex uses explicit model and native sandbox settings. These runtime controls are not a universal security sandbox.

## Remaining release gates

1. GitHub Actions passed on the merged source commit. Local checks cover macOS and Linux arm64 containers; remote GitHub runners cover macOS and Linux x64 on Node 22 and 24.
2. Supply compatible native runtime versions and choose models/accounts. The previously installed Claude Code 1.0.35 failed startup under the original Node 26 environment; newer runtime compatibility is not established by fixtures.
3. Supply a Jev credential if live Jev verification is required. The OpenAI check was one bounded request; reported-token cost estimates are not invoices.
4. Configure compatible native runtimes, choose worker models, and approve any unknown native-account usage before running host-to-worker tests, real patch tests, and specialist composition. Retain sanitized traces, model provenance and verification outcomes; repair failures before signing off.
5. Publish with the steps below. Recheck the npm name first. No tag or npm publication is created by opening a pull request.

The opt-in worker commands and evidence boundaries are documented in [COMPATIBILITY.md](COMPATIBILITY.md).

## Publish the first npm release

Checked on 2026-10-19 with `npm view harnessrouter`: the registry returned 404, so the unscoped name is available. `@ozgureyilmaz/harnessrouter` was unused as well. Names can be claimed later. Recheck immediately before publishing. If `harnessrouter` has been taken, change `package.json` `name` to `@ozgureyilmaz/harnessrouter`, keep `publishConfig.access` set to `public`, and change the install command to `npm install -g @ozgureyilmaz/harnessrouter`. Do not publish under a different name without that edit.

`package.json` is version `1.0.0`. [CHANGELOG.md](../CHANGELOG.md) describes that version and still says Unreleased. `publishConfig` requests public access and provenance. `files` is an allowlist. `docs/.npmignore` keeps PDF files out of the tarball. `npm run package:check` rejects anything outside the allowlist, including a PDF that slips through, and requires the CLI shebang, `dist/api.js`, and `CHANGELOG.md`. `npm run package:smoke` installs the packed tarball and exercises the CLI and MCP handshake without optional dependencies or provider calls.

The workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml) is the only publisher. It runs on a pushed tag matching `v*.*.*`. It does not create the tag and it does not open a GitHub Release.

1. On the commit you intend to publish, confirm `version` is `1.0.0` and the changelog describes it. Set the changelog date when you tag.
2. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run package:check`, and `npm run package:smoke` on Node 22.19+ and Node 24. The publish job itself repeats those checks on Node 24 before it uploads.
3. Add a repository Actions secret named `NPM_TOKEN`. Use an npm granular access token that can publish `harnessrouter`, or a classic automation token. The workflow maps it to `NODE_AUTH_TOKEN` for the publish step and stops if the secret is empty. Do not commit the token or print it.
4. Keep the repository public. Provenance needs `id-token: write`, which the workflow requests, and `npm publish --provenance --access public`. `publishConfig.provenance` is true, so a publish that cannot produce a provenance statement fails instead of uploading a package without one.
5. Tag the exact version and push only that tag: `git tag v1.0.0 && git push origin v1.0.0`. The tag must be `v` plus the `package.json` version, with no prerelease suffix. `v1.0.0-rc.1` matches the workflow glob and is then rejected by the version check.
6. Watch the Publish to npm workflow. A green run means the registry accepted `1.0.0`. Confirm with `npm view harnessrouter version`. After that, `npm install -g harnessrouter` is the install path in the README.

These steps are the owner's action. This change set does not push a tag, create a release, or call `npm publish`.
