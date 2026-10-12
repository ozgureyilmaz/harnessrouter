#!/usr/bin/env bash
set -u
# Non-billable, non-mutating machine readiness report. No secret values printed.
cd "$(dirname "$0")/.." || exit 1
printf '\n== harnessrouter pre-build preflight (NO API CALLS) ==\n'
printf 'working directory: '; pwd
for c in node npm pi codex git curl; do
  if command -v "$c" >/dev/null 2>&1; then
    printf '[found] %-7s %s\n' "$c" "$(command -v "$c")"
  else
    printf '[missing] %s\n' "$c"
  fi
done
if command -v node >/dev/null 2>&1; then node --version; fi
if command -v npm >/dev/null 2>&1; then npm --version; fi
if command -v pi >/dev/null 2>&1; then pi --version 2>/dev/null || true; fi
if command -v codex >/dev/null 2>&1; then codex --version 2>/dev/null || true; fi
for v in OPENAI_API_KEY FAL_KEY; do
  if [[ -n "${!v:-}" ]]; then printf '[set] %s\n' "$v"; else printf '[unset] %s\n' "$v"; fi
done
if [[ -d .git ]]; then
  printf 'git status (short):\n'; git status --short
else
  printf 'git repository: not initialized here\n'
fi
if [[ -d /Applications/"Google Chrome.app" ]] || command -v google-chrome >/dev/null 2>&1; then
  echo '[found] Google Chrome candidate'
else
  echo '[unknown] Chrome executable not found in common locations'
fi
printf 'This only checks local readiness. No extension, provider or API was tested.\n'
