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

for command_name in git forge node npm npx; do
  command -v "$command_name" >/dev/null || { echo "Missing required command: $command_name" >&2; exit 1; }
done

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" != "22" ]]; then
  echo "Node.js 22.x is required; found $(node --version)." >&2
  exit 1
fi

ensure_dependency() {
  local path="$1" url="$2" revision="$3"
  if ! git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [[ -d "$path" && -n "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      echo "$path exists but is not the expected Git dependency." >&2
      exit 1
    fi
    rm -rf -- "$path"
    git clone --filter=blob:none --no-checkout "$url" "$path"
    git -C "$path" fetch --depth 1 origin "$revision"
    git -C "$path" checkout --detach "$revision"
  fi
  local actual
  actual="$(git -C "$path" rev-parse HEAD)"
  if [[ "$actual" != "$revision" ]]; then
    echo "$path is at $actual, expected $revision. Refusing to rewrite an existing checkout." >&2
    exit 1
  fi
}

ensure_dependency lib/forge-std https://github.com/foundry-rs/forge-std bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
ensure_dependency lib/openzeppelin-contracts https://github.com/OpenZeppelin/openzeppelin-contracts cab19933c33c2ad1d4c7a84864a3601dddfd16f3
ensure_dependency lib/aave-v3-origin https://github.com/aave/aave-v3-origin 5c2eb37f39959dd491ba97fdc2af94bb4ee88f41
ensure_dependency lib/swap-vm https://github.com/1inch/swap-vm 32c687c2b73101fc26549e48fa1ff8a4d73afbac

if grep -q ') external returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)' lib/swap-vm/src/SwapVM.sol; then
  git -C lib/swap-vm apply ../../patches/swap-vm-overridable.patch
fi
PUBLIC_COUNT="$(grep -c ') public virtual returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)' lib/swap-vm/src/SwapVM.sol || true)"
if [[ "$PUBLIC_COUNT" != "2" ]]; then
  echo "The audited two-line SwapVM compatibility patch is not applied exactly." >&2
  exit 1
fi

if [[ ! -f lib/swap-vm/src/libs/XYCSwapMath.sol ]]; then
  git -C lib/swap-vm apply ../../patches/swap-vm-xyc-math.patch
fi
if ! grep -q 'XYCSwapMath.exactIn' lib/swap-vm/src/instructions/XYCSwap.sol \
  || ! grep -q 'XYCSwapMath.exactOut' lib/swap-vm/src/instructions/XYCSwap.sol \
  || ! grep -q 'XYCConcentrateArgsBuilder.virtualBalances' lib/swap-vm/src/instructions/XYCConcentrate.sol; then
  echo "The audited shared XYC math patch is not applied exactly." >&2
  exit 1
fi

if ! grep -q 'function _validateTakerTraits(' lib/swap-vm/src/SwapVM.sol; then
  git -C lib/swap-vm apply ../../patches/swap-vm-taker-validation-hook.patch
fi
VALIDATION_HOOK_CALLS="$(grep -c '_validateTakerTraits(takerTraits' lib/swap-vm/src/SwapVM.sol || true)"
if [[ "$VALIDATION_HOOK_CALLS" != "2" ]]; then
  echo "The audited SwapVM taker-validation hook patch is not applied exactly." >&2
  exit 1
fi

npx --yes yarn@1.22.22 --cwd lib/swap-vm install --frozen-lockfile --ignore-scripts --non-interactive
npm ci --prefix demo --ignore-scripts
npm ci --prefix frontend --ignore-scripts
npm ci --prefix services --ignore-scripts

echo "Pinned dependencies and Node workspaces are ready."
