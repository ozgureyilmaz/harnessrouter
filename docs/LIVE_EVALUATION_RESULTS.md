# live evaluation results

Pilot captured on 13 October 2026: 42 trials across two independent harnesses and two composed workflows. Semantic grading used GPT-6 Luna with high reasoning and a fixed 0–4 rubric, requiring at least 3 in every dimension. Image human review is pending.

| Evaluation | Trials | Technical pass | Combined technical and semantic pass |
|---|---:|---:|---:|
| Pi direct | 18 | 18 | 14 |
| fal direct | 18 | 18 | 15 |
| Browser to image | 6 | 5 | 1 |

Of 48 planned harness steps, 47 were attempted and 46 passed technical checks. One dependent generation was skipped after an upstream Pi failure. The 46 completed outputs were graded: 34 passed every semantic dimension. Both judge control examples behaved as expected.

## observed gaps

- Pi misreported card colors in all three direct layout trials. Screenshot capture returns a file notification to the agent, while text extraction exposes overall page styles; neither supplies the per-card visual evidence needed for those claims.
- A composed Pi trial repeated `browser_extract` and hit the one-read limit. The first extraction and screenshot had succeeded, but the extra tool error caused the run to fail. Tool limits need clearer instructions and defined repeat behavior.
- Three of 18 direct image generations missed or obscured the exact-three-object requirement. The fast profile passed 8/9 semantic evaluations, and the quality profile passed 7/9. These samples do not establish general superiority of either profile.
- All three public-source composed images were nearly blank or too faint to deliver the requested focal illustration. Technical image validity and source-context provenance did not ensure a useful output.
- URL masking in a public-page summary affected one judge verdict even though the structured result contained the source URL. The rubric needs a clearer distinction between structured API output and narrative presentation.

## timings and costs

| Group | Sample count | Median harness duration | p95 harness duration |
|---|---:|---:|---:|
| Pi controlled, including composition | 15 | 11.32 s | 21.25 s |
| Pi public, including composition | 9 | 19.97 s | 34.17 s |
| fal fast, direct | 9 | 6.46 s | 7.75 s |
| fal quality, direct | 9 | 9.99 s | 13.75 s |

Judge latency is excluded from harness duration. Pi groups include the failed attempt; other groups contain completed attempts.

The API rate-estimate subtotal was **$0.1753**. Held upper-bound commitments were **$2.55** under the authorized **$4** evaluation cap. Pi subscription usage has no per-request USD amount in this integration, so total cost remains partial. Rate estimates are not invoices. No paid request was automatically retried, and no unresolved paid reservation remained.

## evidence and limits

The captured run contains 47 unique harness run IDs, 46 unique semantic judge response IDs and two additional judge controls. A separate provider-free audit re-decoded all 46 saved screenshots/images and reconstructed the source observation fingerprints for all five generated composition outputs.

Four browser cases used controlled static pages; two used public pages. Those environments are reported separately. Original artifacts, references, traces, raw results and audit records remain in private local storage. This portable summary includes aggregate observations only.

The scores describe a small synthetic pilot and have not been calibrated against human ratings. They identify concrete gaps rather than establishing a general reliability rate, speed advantage or quality advantage.

See [evaluation commands](LIVE_EVALUATION.md) for offline checks, budgeted live execution and saved-output regrading.
