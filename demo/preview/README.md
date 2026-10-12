# harnessrouter recorded demo

Static playback of actual local runs captured on 12 October 2026. This page does not execute an agent, call a provider, or accept credentials. Animation timings are illustrative; measured durations appear separately.

The featured schema 1.2 workflow uses browser run `c32e2814-8908-4760-8b42-8bb477fad560` and creative run `a99494de-75e5-49c3-9e64-6a191728cc14`. The two original PNGs were copied without modification and checked against their recorded SHA-256 hashes. The browser had one eligible route and made no Decisions request; the image route was selected through Decisions. Source context and the parent run were verified. Visual similarity remains unverified.

The evidence page reads sanitized snapshots from `data/`. All 24 records in the captured metrics snapshot are retained, including cancellation and host defer. The counts describe development runs, not a reliability benchmark. The native Codex-only workflow is partial: it produced a real draft, but fresh-browser inspection and rendered style measurement were unavailable in that run, and exact 16:9 failed. The direct fal baseline is a separate historical image-only comparison with its actual reference run. Host/Pi USD is unknown; published-rate estimates are not invoices.

## local preview

From the repository root:

```bash
npm run demo:check
python3 -m http.server 4173 --bind 127.0.0.1 --directory demo/preview
```

Open <http://127.0.0.1:4173/>. The server exposes only this demo directory. “Play comparison” replays the recorded flow. “GIF preview mode” isolates its 16:9 frame; Escape exits that mode.

## update the public snapshot

On the original machine with the captured local evidence:

```bash
npm run demo:export
npm run demo:check
```

The exporter reads the private metrics file and explicitly selected local evidence. It copies two reviewed PNGs and exports only allowed result fields. It validates the composition, native results, asset hashes, and baseline reference. Raw prompts, DOM, traces, provider URLs, local paths, and the budget ledger are excluded from the exported run records. The reviewed native Codex-only record exports only its result summary and original draft PNG; raw execution events remain private. A future native record requires review before export. A public clone already contains the snapshot and needs no local evidence or provider keys to display it.

The separately captured browser-only pilot has its own portable dataset and original screenshots. It preserves the shared public task and observed page data; the run-record exporter does not overwrite it.

## GitHub Pages

The `pages.yml` workflow validates and uploads only `demo/preview/` on a push to `master`, or on manual dispatch. It installs no project dependencies and makes no paid provider calls. In repository **Settings → Pages**, select **GitHub Actions** as the source before the first deployment.

Expected URL after a successful deployment: <https://ozgureyilmaz.github.io/harnessrouter/>.

Visual reference: [Agentation](https://www.agentation.com). No brand assets or page copy are reused.

## Captured browser-only comparison

The new browser section reads the portable `data/browser-comparison.json`: native current-session Codex CUA versus native MCP → Pi on the identical browser-only task. Both real screenshots are portable files in `assets/browser-pilot/`. Native task checks pass 4/4; Pi passes 3/4 because the exact link target was not returned. Token counters are shown only where reported; native model/token and both USD costs remain unavailable. Browser GIF view plays recorded steps; it is not a timing race. Existing composite and creative-only evidence remain separate. See `../browser-comparison.md` for measurement limits.
