# fal image profiles

This document records the endpoint contracts used by `fal-creative`. The model pages and API schemas were checked on **2026-10-12**. fal can change endpoint schemas and pricing, so treat the listed rates as a checked catalog snapshot and the per-run amount as an estimate until billing data is available.

## Current profiles

| Route | fal endpoint | Profile role | Catalog rate checked 2026-10-12 |
|---|---|---|---:|
| `fal-creative:image-fast` | `fal-ai/flux/schnell` | Low-cost, four-step image generation | `$0.003 / megapixel` |
| `fal-creative:image-quality` | `fal-ai/flux-2` | FLUX.2 [dev], vendor-described enhanced realism and crisper text | `$0.012 / megapixel` |

Sources: [FLUX.1 schnell model and price](https://fal.ai/models/fal-ai/flux/schnell), [FLUX.1 schnell API schema](https://fal.ai/models/fal-ai/flux/schnell/api), [FLUX.2 [dev] model and price](https://fal.ai/models/fal-ai/flux-2), [FLUX.2 API schema](https://fal.ai/models/fal-ai/flux-2/api).

The profile name describes the intended policy. It does not assert a measured quality or latency comparison. The FLUX.2 wording above is fal’s product description, not a HarnessRouter evaluation.

## Endpoint parameters

Both profiles submit one image with an explicit custom `image_size`, PNG output, and the safety checker enabled. The implementation derives a prompt from the task and bounded visual context, and reserves budget before it submits to fal.

| Parameter | `fal-ai/flux/schnell` | `fal-ai/flux-2` |
|---|---|---|
| Required | `prompt` | `prompt` |
| Steps | `num_inference_steps: 4` | `num_inference_steps: 28` |
| Guidance | `guidance_scale: 3.5` | `guidance_scale: 2.5` |
| Dimensions | custom width/height | custom width/height, each 512–2048 px |
| Image count | `num_images: 1` | `num_images: 1` |
| Safety | `enable_safety_checker: true` | `enable_safety_checker: true` |
| Output | `output_format: "png"` | `output_format: "png"` |
| Acceleration | `acceleration: "none"` | `acceleration: "regular"` |
| Prompt expansion | not in this endpoint schema | enabled only for `quality: "high"` |
| Optional seed | unsigned 32-bit integer | unsigned 32-bit integer |

fal documents the schnell schema as accepting steps, preset or custom dimensions, seed, guidance, output format, acceleration, safety-checker, `sync_mode`, and image count. FLUX.2 adds prompt expansion and WebP output; it documents the same core controls with a 512–2048 px limit. `fal-creative` uses only the listed fields needed for the current bounded image task.

The supported aspect ratios are `1:1`, `4:3`, `3:4`, `16:9`, and `9:16`. They map to `992×992`, `1024×768`, `768×1024`, `1024×576`, and `576×1024` respectively. These model-aligned request sizes each stay within one decimal megapixel, so the current catalog estimate is `$0.003` for schnell and `$0.012` for FLUX.2 for one output. The code rounds up by decimal megapixel for a conservative budget check. fal’s final invoice amount is not exposed by the queue result, so returned `cost.status` is `estimated`.

Requested dimensions and artifact dimensions are separate values. `expectedWidth` and `expectedHeight` describe the submitted parameters; `width` and `height` in the result come from decoding the downloaded image. fal may align or resize the output, so the verifier checks the requested aspect ratio within 2.5% and records the actual dimensions rather than assuming they match the request.

The current hard limit is `$0.25` for an image task, with the selected task and session budgets enforced by the shared budget ledger. `num_images` is fixed to one; retries that could create another paid image are not enabled.

## Strict task options

The optional `task.context.creativeOptions` object accepts exactly these fields:

```json
{
  "aspectRatio": "16:9",
  "style": "soft editorial illustration",
  "quality": "balanced",
  "negativePrompt": "watermarks, lettering",
  "seed": 42
}
```

`aspectRatio` is one of the five supported ratios above. `style` is a user-supplied string up to 240 characters. `quality` is `fast`, `balanced`, or `high`; `high` requires the quality route and `fast` requires the fast route. `negativePrompt` is limited to 600 characters. Neither endpoint schema has a separate negative-prompt parameter, so that text is rendered in the positive prompt as an explicit avoidance instruction. `seed` must be an integer from 0 through 4,294,967,295. Unknown keys and invalid values are rejected before a provider call. `desiredOutput` must explicitly be `image`; video and mixed output are unsupported.

## Browser observation handoff

For a composed browser-to-image task, the optional `task.context.websiteObservations` follows the Pi browser output shape:

```json
{
  "sourceUrl": "https://example.com/",
  "pageTitle": "Example",
  "agentSummary": "A dark editorial layout with generous spacing.",
  "screenshotPath": "/path/to/verified-screenshot.png",
  "visualStyle": {
    "viewport": {"width": 1440, "height": 900},
    "palette": {
      "pageBackground": "rgb(18, 32, 52)",
      "bodyText": "#F1F5F9",
      "heading": null,
      "link": "#6AA9FF"
    },
    "typography": {
      "bodyFontFamily": "Inter, sans-serif",
      "bodyFontSize": "16px",
      "bodyLineHeight": "1.8",
      "headingFontFamily": "Georgia, serif",
      "headingFontSize": "32px",
      "headingFontWeight": "700"
    },
    "layout": {"mainContentBox": {"x": 240, "y": 100, "width": 960, "height": 700}}
  }
}
```

The object is strict and bounded. The prompt uses only normalized CSS colors, generic font-family/size/weight/line-height categories, layout inferred from viewport geometry, and a small allowlist of visual descriptors extracted from `agentSummary`. It does not pass the raw page title, summary, screenshot path, source URL, CSS font family, or arbitrary observation text to the image model. This limits prompt-injection propagation from the visited page.

The plan and journal record `parentRunId`, a SHA-256 fingerprint of the observation object, and the sanitized public origin as provenance. The raw object is not copied into traces or the fal prompt. Unknown keys, non-public source URLs, and malformed measurements cause a pre-provider rejection.

## Queue lifecycle, cancellation, and ambiguity

The implementation uses the pinned `@fal-ai/client` queue methods: `fal.queue.submit`, `fal.queue.status`, `fal.queue.result`, and `fal.queue.cancel`. It saves a run-scoped submission journal before the POST and persists `request_id` before polling. Status and result reads can resume with that same ID after interruption. A cached completed result is locally re-verified before it is returned.

fal’s [queue documentation](https://fal.ai/docs/documentation/model-apis/inference/queue) states that cancel removes a request still in `IN_QUEUE`, while cancellation of `IN_PROGRESS` only signals the runner and may not stop generation. fal also documents `X-Fal-No-Retry: 1` to disable server-side retries. The SDK may retry the submission HTTP call on transport failures; the adapter’s fetch guard permits at most one outbound queue-submit POST per run. If no `request_id` arrives after a possible submission, the journal records an ambiguous state, the full budget reservation remains held, and the harness returns `reconciliation_required` without another submit. A known request ID can be polled or cancelled; cancellation does not prove the provider stopped or avoid a charge.

The result image is downloaded only from public HTTPS locations through the shared URL-checking helper. Redirects are revalidated, files over 20 MiB are refused, the decoded file signature determines MIME type, and actual dimensions must match the requested aspect ratio within 2.5%. An image is returned as verified only after the local file passes that check.

## Live integration test

The default integration suite skips provider work with a reason. A single paid schnell image test runs only when all four values are explicitly set: `FAL_LIVE_TESTS=true`, `FAL_KEY`, `ROUTER_ALLOW_PAID_RUNS=true`, and `ROUTER_DRY_RUN=false`. It reserves at most `$0.01` in its local test budget, and the image task itself is capped at `$0.01`. No live fal call was made while implementing these profiles.
