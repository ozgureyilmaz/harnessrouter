# Adapter contracts

harnessrouter keeps the host, router, independent runtime, and result verification separate. A worker profile binds one native runtime adapter to one explicit model. Eligibility and permissions are deterministic; selection receives only eligible route IDs. An execution completion event is not proof that the resulting artifact is correct.

## Process workers

`src/workers/types.ts` defines `WorkerProfile` and `WorkerProtocol`. Local profiles specify `id`, `adapter`, `model`, `enabled`, and `allowExecution`; optional fields include `provider`, `executable`, `allowUnknownCost`, `priority`, `timeoutMs`, and `allowedModels` (explicit physical identifiers allowed for a configured alias). `executable` is a path or executable name, never a shell command. Pi uses the pinned SDK RPC bootstrap and rejects executable overrides.

`WorkerProtocol` supplies:

- `kind`: `codex`, `claude-code`, `opencode`, or `pi`.
- `helpArgs` and `requiredHelpFlags`: local CLI capability checks, or an optional `probe(profile)` for a more specific health decision.
- `invocation(profile, {cwd, prompt, mode, runDirectory})`: an explicit command/argument vector, bounded environment overrides, and optional stdin.
- `closeStdinOnEvent`: optional RPC terminal event that closes input only after completion.
- `parse(records, profile)`: validated terminal completion, answer, session/model provenance, usage counters, and cost status.

`ProcessWorkerAdapter` in `src/workers/adapter.ts` implements the shared `HarnessAdapter` interface. It verifies execution and unknown-cost permissions, acquires a per-profile lease, captures the workspace, invokes the native runtime through the process supervisor, records events, parses completion, and verifies workspace results. The process group is killed before output collection settles, then the lease is released and the snapshot is deleted unless `keepSnapshots` is set. A lease whose owner process has exited is reclaimed by reconcile and the run is marked `interrupted`. Workers receive a recursion marker and are instructed not to stage/commit or modify `.git`.

The supervisor uses argument vectors without a shell, strict output/time bounds, cancellation, and process cleanup. NDJSON events remain untrusted input. Incomplete streams, explicit runtime errors, absent final messages, and invalid terminal states fail. A runtime's reported model is retained only when the protocol actually supplies it; the configured model is not presented as an independently measured physical-model identity.

The worker environment passes a bounded set of runtime paths and native/provider credentials. Supported provider variables are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, and `OPENROUTER_API_KEY`; use only those required by your chosen provider. Native stores remain controlled by the runtime through `HOME`, `CODEX_HOME`, or `PI_CODING_AGENT_DIR` as applicable. harnessrouter does not read or copy their contents. `FAL_KEY` belongs to the image specialist and is not inherited by general workers.

Native account charges may remain unknown. Usage counters are provider-reported measurements; catalog rates and CLI cost fields do not establish an invoice. Local/profile and task authorization for unknown cost are both required.

## Workspace results

`prepareWorkspace(request, runDirectory, policy)` and `collectPatch(snapshot, runDirectory)` in `src/workspace/snapshot.ts` implement the snapshot boundary. Only trusted policy roots grant access. Workspace roots must resolve to repository roots without symlink components; run storage must be outside the source repository. The run-directory parent must already exist.

The baseline contains current tracked regular files plus explicitly included untracked files, excluding protected control/secret paths. Dirty edits are part of the baseline; pre-capture deletions remain absent. Limits default to 5,000 files and 32 MiB. Known secret names, inherited harness configuration, `.git`, hooks, and dependency directories are excluded. Unsafe relative paths, symlinks, and hardlinks fail closed.

The isolated snapshot receives a Git baseline with controlled identity, environment, and disabled hooks. Baseline content and Git metadata fingerprints are held in module-private memory. Collection must receive the original snapshot object in the same process. Any worker `.git` change, including staging, is rejected. Source repositories are never automatically changed.

Collection validates file types, protected paths, and limits; detects read-only modifications; writes `workspace.patch` and `workspace-changes.json`; and checks binary patch applicability in a separate checkout of captured content. The manifest includes changed paths, baseline fingerprint, and SHA256. A requested patch with no changes returns `patch_empty`; read-only modifications return `workspace_read_only_violation`. Read-only tasks with no changes can return text through the process adapter.

Applicability is technical verification, not semantic acceptance. Native tools have differing restrictions and this boundary does not guarantee OS-level containment. See [SECURITY.md](../SECURITY.md).

## Programmatic extensions

`HarnessAdapter` in `src/domain/types.ts` is the broader adapter contract: `id`, `health()`, and `execute(task, context)` returning an `AdapterResult`, with optional `preflight`, `verify`, `cancel`, and `close` lifecycle hooks. A new specialist adapter implements that interface and must be registered explicitly in trusted application code, with a matching validator in the registry loader and supported capability/permission declarations.

A new process protocol implements `WorkerProtocol` and is explicitly connected to `ProcessWorkerAdapter` by trusted registration code. Extend the profile schema/adapter union and tests deliberately when introducing a new runtime. Task input and registry descriptions never supply executable adapter code. Arbitrary task-loaded plugins are not supported.

## Existing specialists

Pi browser remains a real RPC-controlled agent runtime with restricted isolated public-browser tools. Its public inspection/screenshot permissions differ from the general Pi workspace worker. fal-creative owns model-specific planning, validated generation parameters, admission and durable submission state, bounded recovery, and image verification; it is more than a prompt passthrough. Host defer returns control without silently running unsupported work.

Host-managed composition uses a completed run's observations as input to a separate task and records `parentRunId` plus context fingerprint. It does not grant additional capabilities or spending authority. Historical specialist evidence is linked from the [README](../README.md); it does not establish live general-worker interoperability.

## Verification before adding a route

Add offline tests for profile/manifest mismatch, unavailable runtime flags, malformed streams, terminal failures, explicit model identity, unknown-cost policy, cancellation, timeout, and output bounds. Exercise the full process adapter against a local subprocess double and real temporary Git repositories. New live evidence requires a separately authorized native run, a verified result/artifact, and an honest compatibility entry. Help/version output or fixture success alone is insufficient.
