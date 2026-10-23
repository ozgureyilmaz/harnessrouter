# Changelog

All notable changes to this package are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - Unreleased

First npm release of the local MCP router. `package.json` is already at `1.0.0`. Nothing has been tagged or published. The date is filled in when the `v1.0.0` tag is pushed and the publish workflow succeeds. See [open-source release](docs/OPEN_SOURCE_RELEASE.md).

### Added

- Local MCP server that accepts one bounded task and hands it to an enabled Codex, Claude Code, OpenCode, or Pi worker. The result is text or a patch from an isolated Git snapshot.
- `harnessrouter init` writes `selector: "local"`. A new configuration routes by configured priority and does not need a decision API key. Dry run stays on, execution stays off, paid calls stay off, worker profiles stay disabled, and no workspace root is granted.
- Opt-in decision providers via `--selector decisions` or `--decision-provider openai|jev|ollaya`: OpenAI Decisions (`gpt-6-luna`), TypeSafe Jev, and loopback Ollaya. A config file or process that omits `selector` still resolves to OpenAI Decisions.
- `doctor`, `stats`, and `mcp-config` snippets for Codex, Claude Code, OpenCode, and Pi.
- Library entry at `dist/api.js`, CLI bin `harnessrouter`, and an offline `package:check` / `package:smoke` pair.
- Tag-triggered GitHub Actions publish workflow. It publishes to npm with provenance when `NPM_TOKEN` is set. It does not create the tag.

### Security

- Missing hosted credentials never switch providers. Paid selection and worker execution each require their own explicit grant.
- JSON configuration rejects credential fields. Unknown routes and provider errors fail closed.
- Starter configuration is fail-closed: workers disabled, no workspace grants, dry run on.
- Development dependency overrides move DeepEval's OpenTelemetry trace exporters to 0.223.0 and `uuid` to 11.1.1. Production dependencies are unchanged.

### Changed

- The README describes harnessrouter as a router above harnesses. The keyless selector ranks by configured priority. A hosted decision model is the opt-in that chooses among eligible routes. The terminology follows Theo Browne's [What is a harness?](https://x.com/theo/status/2113424203345265053).
- Contributor docs drop the event notes, local checkpoint reviews, and the delivery manifest.

### Existing checkout

If saved runs or budget reservations live under an older checkout's `artifacts/` directory, keep using that directory with `ARTIFACTS_DIR` or trusted `artifactsDir`. The default state directory does not import those runs. Reconcile old reservations before authorizing new priced work.
