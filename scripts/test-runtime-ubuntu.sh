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

: "${ETH_RPC_URL:?Set ETH_RPC_URL to an Ethereum Mainnet archive RPC URL.}"
RUNTIME_RPC_PORT="${RUNTIME_RPC_PORT:-18545}"
RUNTIME_DEMO_PORT="${RUNTIME_DEMO_PORT:-13001}"
RUNTIME_RPC_URL="http://127.0.0.1:$RUNTIME_RPC_PORT"
RUNTIME_DEMO_URL="http://127.0.0.1:$RUNTIME_DEMO_PORT"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "22" ]] || {
  echo "Node.js 22.x is required." >&2
  exit 1
}
for port in "$RUNTIME_RPC_PORT" "$RUNTIME_DEMO_PORT"; do
  if timeout 1 bash -c "</dev/tcp/127.0.0.1/$port" >/dev/null 2>&1; then
    echo "Port $port is already in use. Stop it before the isolated runtime test." >&2
    exit 1
  fi
done

TEST_MNEMONIC="$(cd demo && node --input-type=module -e "import { Mnemonic, randomBytes } from 'ethers'; process.stdout.write(Mnemonic.fromEntropy(randomBytes(32)).phrase)")"
TEST_CALIBRATION_SIGNER_PRIVATE_KEY="$(cd demo && node --input-type=module -e "import { Wallet } from 'ethers'; process.stdout.write(Wallet.createRandom().privateKey)")"
TEST_CALIBRATION_SIGNER_ADDRESS="$(
  cd demo
  TEST_KEY="$TEST_CALIBRATION_SIGNER_PRIVATE_KEY" node --input-type=module -e \
    "import { Wallet } from 'ethers'; process.stdout.write(new Wallet(process.env.TEST_KEY).address)"
)"

TEST_RUNTIME_DIR="$(mktemp -d)"
TEST_SUCCEEDED=0
ANVIL_PID=""
SERVER_PID=""
cleanup() {
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
  [[ -z "$ANVIL_PID" ]] || kill "$ANVIL_PID" 2>/dev/null || true
  [[ -z "$SERVER_PID" ]] || wait "$SERVER_PID" 2>/dev/null || true
  [[ -z "$ANVIL_PID" ]] || wait "$ANVIL_PID" 2>/dev/null || true
  if [[ "$TEST_SUCCEEDED" == "1" ]]; then
    rm -rf -- "$TEST_RUNTIME_DIR"
  else
    echo "Isolated runtime logs retained at $TEST_RUNTIME_DIR" >&2
  fi
}
trap cleanup EXIT INT TERM

anvil --fork-url "$ETH_RPC_URL" --fork-block-number 25913344 --chain-id 31337 \
  --port "$RUNTIME_RPC_PORT" --mnemonic "$TEST_MNEMONIC" --accounts 10 --silent >"$TEST_RUNTIME_DIR/anvil.log" 2>&1 &
ANVIL_PID="$!"
unset TEST_MNEMONIC
for _ in {1..120}; do
  cast chain-id --rpc-url "$RUNTIME_RPC_URL" >/dev/null 2>&1 && break
  kill -0 "$ANVIL_PID" 2>/dev/null || { echo "Anvil exited during runtime setup; inspect $TEST_RUNTIME_DIR/anvil.log." >&2; exit 1; }
  sleep 0.5
done
cast chain-id --rpc-url "$RUNTIME_RPC_URL" >/dev/null

forge build --quiet
npm --prefix services run build
DEMO_RUNTIME_DIR="$TEST_RUNTIME_DIR" DEMO_RPC_URL="$RUNTIME_RPC_URL" CALIBRATION_SIGNER_ADDRESS="$TEST_CALIBRATION_SIGNER_ADDRESS" npm --prefix demo run bootstrap
DEMO_RUNTIME_DIR="$TEST_RUNTIME_DIR" DEMO_RPC_URL="$RUNTIME_RPC_URL" DEMO_PORT="$RUNTIME_DEMO_PORT" npm --prefix demo start >"$TEST_RUNTIME_DIR/server.log" 2>&1 &
SERVER_PID="$!"
for _ in {1..60}; do
  curl --fail --silent "$RUNTIME_DEMO_URL/api/state" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "Demo server exited during runtime setup; inspect $TEST_RUNTIME_DIR/server.log." >&2; exit 1; }
  sleep 0.5
done
curl --fail --silent "$RUNTIME_DEMO_URL/api/state" >/dev/null
DEMO_RUNTIME_DIR="$TEST_RUNTIME_DIR" DEMO_RPC_URL="$RUNTIME_RPC_URL" DEMO_BASE_URL="$RUNTIME_DEMO_URL" \
  TEST_CALIBRATION_SIGNER_PRIVATE_KEY="$TEST_CALIBRATION_SIGNER_PRIVATE_KEY" npm --prefix demo run test:runtime
TEST_SUCCEEDED=1
