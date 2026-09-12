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

for command_name in forge anvil cast node npm curl timeout; do
  command -v "$command_name" >/dev/null || { echo "Missing required command: $command_name" >&2; exit 1; }
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "22" ]]; then
  echo "Node.js 22.x is required; found $(node --version)." >&2
  exit 1
fi
: "${ETH_RPC_URL:?Set ETH_RPC_URL to a plain Ethereum Mainnet archive RPC URL.}"
if ! ETH_RPC_URL="$ETH_RPC_URL" node --input-type=module -e '
  const raw = process.env.ETH_RPC_URL ?? "";
  try {
    const url = new URL(raw);
    if (raw.trim() !== raw || /[\[\]()\s]/.test(raw)
      || !["http:", "https:"].includes(url.protocol) || url.username || url.password) process.exit(1);
  } catch { process.exit(1); }
'; then
  echo "ETH_RPC_URL must be a plain HTTP(S) URL, not a Markdown link or quoted label." >&2
  exit 1
fi

for path in demo/.env.local services/.env.calibrator.local services/.env.agent.local; do
  [[ -f "$path" ]] || { echo "Missing $path; copy and fill its committed .example file." >&2; exit 1; }
done
for path in demo/node_modules frontend/node_modules services/node_modules; do
  [[ -d "$path" ]] || { echo "Dependencies are missing. Run ./scripts/setup-ubuntu.sh once." >&2; exit 1; }
done

# shellcheck source=/dev/null
source demo/.env.local
: "${ANVIL_DEMO_MNEMONIC:?ANVIL_DEMO_MNEMONIC is required in demo/.env.local}"
: "${CALIBRATION_SIGNER_ADDRESS:?CALIBRATION_SIGNER_ADDRESS is required in demo/.env.local}"
read -r -a DEMO_WORDS <<<"$ANVIL_DEMO_MNEMONIC"
if [[ "${#DEMO_WORDS[@]}" != "24" ]]; then
  echo "ANVIL_DEMO_MNEMONIC must contain exactly 24 words." >&2
  exit 1
fi
if [[ ! "$CALIBRATION_SIGNER_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]] \
  || [[ "$CALIBRATION_SIGNER_ADDRESS" =~ ^0x0{40}$ ]]; then
  echo "CALIBRATION_SIGNER_ADDRESS must be a non-zero Ethereum address." >&2
  exit 1
fi
DEMO_CALIBRATION_SIGNER="$CALIBRATION_SIGNER_ADDRESS"

CALIBRATOR_PUBLIC="$(
  set -a
  # shellcheck source=/dev/null
  source services/.env.calibrator.local
  set +a
  printf '%s|%s|%s' "${CALIBRATION_SIGNER_ADDRESS:-}" "${HEDERA_PAYTO_ACCOUNT_ID:-}" "${X402_PRICE_TINYBAR:-}"
)"
AGENT_PUBLIC="$(
  set -a
  # shellcheck source=/dev/null
  source services/.env.agent.local
  set +a
  printf '%s|%s' "${HEDERA_PAYTO_ACCOUNT_ID:-}" "${X402_PRICE_TINYBAR:-}"
)"
CALIBRATOR_SIGNER_PUBLIC="${CALIBRATOR_PUBLIC%%|*}"
if [[ "${CALIBRATOR_SIGNER_PUBLIC,,}" != "${DEMO_CALIBRATION_SIGNER,,}" ]]; then
  echo "The public calibration signer differs between demo and calibrator env files." >&2
  exit 1
fi
if [[ "${CALIBRATOR_PUBLIC#*|}" != "$AGENT_PUBLIC" ]]; then
  echo "The Agent and calibrator must pin the same Hedera pay-to account and tinybar price." >&2
  exit 1
fi

for port in 8545 3001 4021; do
  if timeout 1 bash -c "</dev/tcp/127.0.0.1/$port" >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop the existing local demo first." >&2
    exit 1
  fi
done

# Startup deliberately does not run npm/yarn installs. That slow, one-time work belongs to setup-ubuntu.sh.
if [[ "${MARGINMM_SKIP_BUILD:-0}" == "1" ]]; then
  echo "Fast restart: reusing previously built contract, service and frontend artifacts."
else
  forge build
  npm --prefix services run build
  npm --prefix frontend run build
fi
mkdir -p demo/.runtime
rm -f -- demo/.runtime/deployment.json demo/.runtime/deployment.tmp demo/.runtime/pending.json \
  demo/.runtime/agent-requests.json demo/.runtime/agent-requests.json.tmp \
  demo/.runtime/calibration-requests.json demo/.runtime/calibration-requests.json.tmp

ANVIL_PID=""
CALIBRATOR_PID=""
SERVER_PID=""
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  [[ -z "$CALIBRATOR_PID" ]] || kill "$CALIBRATOR_PID" 2>/dev/null || true
  [[ -z "$ANVIL_PID" ]] || kill "$ANVIL_PID" 2>/dev/null || true
  [[ -z "$SERVER_PID" ]] || wait "$SERVER_PID" 2>/dev/null || true
  [[ -z "$CALIBRATOR_PID" ]] || wait "$CALIBRATOR_PID" 2>/dev/null || true
  [[ -z "$ANVIL_PID" ]] || wait "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

anvil --fork-url "$ETH_RPC_URL" --fork-block-number 25913344 --chain-id 31337 \
  --mnemonic "$ANVIL_DEMO_MNEMONIC" --accounts 10 --silent >demo/.runtime/anvil.log 2>&1 &
ANVIL_PID="$!"
unset ANVIL_DEMO_MNEMONIC DEMO_WORDS
for _ in {1..120}; do
  cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null 2>&1 && break
  kill -0 "$ANVIL_PID" 2>/dev/null || { echo "Anvil exited; inspect demo/.runtime/anvil.log." >&2; exit 1; }
  sleep 0.5
done
cast chain-id --rpc-url http://127.0.0.1:8545 >/dev/null

CALIBRATION_SIGNER_ADDRESS="$DEMO_CALIBRATION_SIGNER" npm --prefix demo run bootstrap
POLICY_REGISTRY="$(node -e 'const c=require("./demo/.runtime/deployment.json"); process.stdout.write(c.policy)')"
PAIR_ID="$(node -e 'const c=require("./demo/.runtime/deployment.json"); process.stdout.write(c.pairId)')"

(
  set -a
  # shellcheck source=/dev/null
  source services/.env.calibrator.local
  set +a
  unset ANVIL_DEMO_MNEMONIC HEDERA_AGENT_PRIVATE_KEY GROQ_API_KEY
  export MARGINMM_CHAIN_ID=31337 MARGINMM_ETHEREUM_RPC_URL=http://127.0.0.1:8545 \
    MARGINMM_POLICY_REGISTRY="$POLICY_REGISTRY" MARGINMM_PAIR_ID="$PAIR_ID" \
    CALIBRATION_IDEMPOTENCY_PATH="$PROJECT_ROOT/demo/.runtime/calibration-requests.json"
  exec node services/dist/src/calibration-service.js
) >demo/.runtime/calibrator.log 2>&1 &
CALIBRATOR_PID="$!"
for _ in {1..120}; do
  curl --fail --silent http://127.0.0.1:4021/health >/dev/null 2>&1 && break
  kill -0 "$CALIBRATOR_PID" 2>/dev/null || {
    echo "Calibration service exited; inspect demo/.runtime/calibrator.log." >&2
    exit 1
  }
  sleep 1
done
curl --fail --silent http://127.0.0.1:4021/health >/dev/null || {
  echo "Calibration service did not become healthy within 120 seconds; inspect demo/.runtime/calibrator.log." >&2
  exit 1
}

(
  set -a
  # shellcheck source=/dev/null
  source services/.env.agent.local
  set +a
  unset ANVIL_DEMO_MNEMONIC CALIBRATION_SIGNER_PRIVATE_KEY
  exec node demo/server.mjs
) >demo/.runtime/server.log 2>&1 &
SERVER_PID="$!"
for _ in {1..60}; do
  curl --fail --silent http://127.0.0.1:3001/api/state >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "Demo server exited; inspect demo/.runtime/server.log." >&2; exit 1; }
  sleep 0.5
done
curl --fail --silent http://127.0.0.1:3001/api/state >/dev/null

MAKER_ADDRESS="$(node -e 'const c=require("./demo/.runtime/deployment.json"); process.stdout.write(c.maker)')"
echo "MarginMM local MVP is ready at http://127.0.0.1:3001"
echo "Import the demo-only mnemonic from demo/.env.local and connect Maker account: $MAKER_ADDRESS"
echo "Secrets were not sent to the frontend. Press Ctrl+C to stop all three local processes."
wait "$SERVER_PID"
