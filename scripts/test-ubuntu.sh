#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

FOUNDRY_BIN="${FOUNDRY_BIN:-$HOME/.foundry/bin}"
[[ -d "$FOUNDRY_BIN" ]] && export PATH="$FOUNDRY_BIN:$PATH"
NVM_ROOT="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_ROOT/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "$NVM_ROOT/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi
for command_name in forge node npm; do
  command -v "$command_name" >/dev/null || { echo "Missing required command: $command_name" >&2; exit 1; }
done
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "22" ]] || {
  echo "Node.js 22.x is required; found $(node --version)." >&2
  exit 1
}

if [[ "${MARGINMM_SKIP_SETUP:-0}" != "1" ]]; then
  ./scripts/setup-ubuntu.sh
fi
forge fmt --check
forge build --sizes
forge test -vv
npm --prefix demo test
npm --prefix services run build
npm --prefix services test
npm --prefix frontend test
npm --prefix frontend run build
./scripts/test-runtime-ubuntu.sh
