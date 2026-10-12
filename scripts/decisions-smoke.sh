#!/usr/bin/env bash
set -euo pipefail
# ONE PAID OpenAI Decisions API request. Run only with explicit approval.
if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo 'OPENAI_API_KEY is unset. No request sent.' >&2
  exit 2
fi
if [[ "${APPROVE_PAID_DECISION_SMOKE:-}" != 'yes' ]]; then
  echo 'Set APPROVE_PAID_DECISION_SMOKE=yes to explicitly permit one paid API request.' >&2
  exit 3
fi
payload='{"model":"gpt-6-luna","input":"Open a public webpage and capture a screenshot.","questions":[{"type":"choice","name":"execution_route","instructions":"Choose the appropriate execution route for the task.","choices":[{"value":"pi-browser:configured","description":"Browser interactions, extraction and screenshots."},{"value":"fal-creative:image-fast","description":"Generate illustrations and other images."}]}]}'
curl --fail-with-body --show-error --silent --max-time 25 https://api.openai.com/v1/decisions \
  -H "Authorization: Bearer ${OPENAI_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data "$payload"
echo
