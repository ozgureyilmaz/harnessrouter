# Decisions API smoke test (optional, paid)

Use `scripts/decisions-smoke.sh` only when a valid `OPENAI_API_KEY` has been supplied in the current shell and small actual API spend is approved. It exercises a **minimal decision**, not routing or execution. In the build, adapt this into a proper response validator using SDK types.

**Expected result**: successful HTTP and `answers[0].type == "choice"`, returned `choice` equals one of supplied allowed values. `confidence` is not calibrated task success.

Do not print API secrets. `curl` errors, auth errors or other responses must be handled transparently. A simulated JSON fixture is **not** a live API result.

Example URL and guide: https://developers.openai.com/api/docs/guides/decisions
