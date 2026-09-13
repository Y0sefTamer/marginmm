# MarginMM

**Collateral-aware market making for Aave V3 positions, executed through 1inch Aqua and SwapVM.**

MarginMM lets a maker quote two-way liquidity in `aWETH` / `aUSDC` without ever quoting past the safety of the Aave account behind those aTokens. Every quote is derived live from the maker's actual Aave balances, debt, liquidation thresholds, index values, and oracle prices. Every fill re-checks that math at settlement time and reverts the entire trade if the resulting position would violate Aave's own Health Factor (HF) or the maker's own, stricter **StressHF** policy.



## The problem

Makers who want to provide liquidity backed by their Aave collateral are stuck choosing between two bad options: quote conservatively and leave capital idle, or quote against static balances and risk a fill that pushes their own Aave position toward liquidation. Aave's HF tells you if you're already in trouble, not how large a fill you can safely absorb before you sign a quote, or how that capacity holds up if the market moves against you.

## What MarginMM does

MarginMM sits between a maker's Aave V3 position and the 1inch Aqua / SwapVM execution layer:

- **Live capacity, not static balances.** Before every quote, MarginMM snapshots the maker's current Aave collateral, debt, liquidation thresholds and normalized-income indices, and pulls price from the same oracle Aave uses.
- **`qMax` derivation.** From that snapshot it computes the maximum size the maker can safely fill in either direction, conservatively rounded.
- **Stress testing, not just current health.** Beyond today's HF, the maker sets a minimum **StressHF**: the health factor their position must still clear under a defined shock set (e.g. WETH -20%, WETH -30%, a USDC oracle move). A quote that only survives today's prices but fails under stress is rejected.
- **Settlement-time re-verification.** SwapVM enforces the risk check as a mandatory instruction on the fill path itself. The trade is clamped to live `qMax` and the *actual* post-transfer HF and StressHF are checked after the transfer, not just estimated before it. If either check fails, the whole settlement reverts.
- **Maker policy, not protocol policy.** The minimum StressHF is a per-maker, per-strategy setting stored outside the immutable Aqua strategy, so a maker can tighten their own risk tolerance without redeploying or resubmitting liquidity.

## Demo flow

1. A maker supplies WETH and USDC to Aave V3 and borrows variable-rate USDC against it.
2. The resulting aTokens are shipped into an immutable Aqua strategy.
3. A taker requests a fill larger than the position can safely absorb.
4. MarginMM clamps the fill to the live `qMax`, settles through SwapVM, and proves the post-settlement HF and StressHF both hold.
5. Withdrawing USDC collateral shrinks (or zeros) available capacity; restoring the position restores it.
6. Raising the maker's StressHF floor reduces quoted capacity immediately, with no change to the immutable Aqua strategy itself.

## Architecture

**Core contracts**

| Contract | Role |
|---|---|
| `MarginMMScenarioEngine.sol` | Canonical Aave snapshot, stress-scenario modeling, conservative aToken preview |
| `MarginMMPolicy.sol` | Mutable maker policy (minimum StressHF per maker/strategy), kept outside the immutable Aqua strategy data |
| `MarginMMTradeMath.sol` | Integer-only pricing and conservative `qMax` computation |
| `MarginMMSwapVMRouter.sol` | Wires the risk check into SwapVM as a mandatory opcode; handles partial-fill clamping and post-settlement verification |

**AI & Calibration Layer**

| Service | Role |
|---|---|
| `Risk Agent` | AI agent (powered by Groq) that evaluates market conditions and proposes policy refreshes. |
| `Calibration Service` | Node.js backend gating deterministic market-risk calibration behind an x402 Hedera testnet paywall. |
| `Hedera Blocky402` | Enforces exact HBAR micro-payments to authorize calibration evidence before updating the policy. |

**Execution layer:** trades route through [SwapVM](https://github.com/1inch) instructions on top of 1inch Aqua, with the risk check enforced as one of those instructions rather than as an external, bypassable guard.

## Frontend

A maker-facing dashboard (TypeScript/React), a tool for the liquidity provider, not the taker. Four sections:

- **Overview**: current HF, current StressHF, overall Aave account health, and the maker's active risk policy at a glance.
- **Position Balances**: WETH collateral, USDC collateral, and outstanding USDC debt.
- **Risk Policy**: an execution bench to preview a fill or pull an executable quote; maker controls to set the minimum StressHF a quote must preserve; and a demo lab to stress-test capacity against the shock scenarios interactively.
- **Execution Activity**: a log of fills and the risk checks each one passed.

## Scope (current MVP)

- Ethereum Mainnet Aave V3 semantics, developed and tested against a pinned mainnet fork.
- Collateral: WETH + USDC. Debt: variable-rate USDC. No eMode or other active reserve category.
- `aWETH ↔ aUSDC` exact-output fills.
- Pricing: Aave's own oracle reference price plus a maker spread (demo default 10 bps, hard-capped at 100 bps).
- Stress set: baseline, WETH -20%, WETH -30%, USDC oracle price -5% (the USDC shock moves both aUSDC collateral value and USDC debt value).
- Demo policy floor of StressHF `1.10` is a demo default, not a recommended universal safe threshold.
- Hedera: [PLACEHOLDER]
- Not deployed to a public network; this is a tested local/fork build, not an audited or production-ready system.

## Tech stack

- **Contracts:** Solidity (Foundry, forge/cast/anvil)
- **Execution:** SwapVM instructions on 1inch Aqua
- **Lending backend:** Aave V3 (mainnet fork)
- **Frontend:** TypeScript, React, Vite
- **AI & Payments:** Groq OpenAI-compatible endpoints, Hedera Testnet, x402 Protocol
- **Local orchestration:** Anvil mainnet fork + local demo backend

## Running it locally

Requirements: Ubuntu/WSL2, Foundry, Git, Node.js 22, npm, curl, and a Mainnet archive RPC.

```bash
export ETH_RPC_URL='https://your-private-mainnet-rpc'
./scripts/test-ubuntu.sh
```

Interactive local demo:

```bash
export ETH_RPC_URL='https://your-private-mainnet-rpc'
./scripts/start-local-demo.sh
```

Then open `http://127.0.0.1:3001`. The local RPC/backend are loopback-only and use randomly unlocked Anvil accounts, no real keys or funds involved.

## Execution commands

Commands needed to build and run the app after cloning the repo.

**Contracts (Foundry)**

```bash
forge install
forge build
forge test
```

**Backend / local demo**

```bash
source ~/.nvm/nvm.shsh
nvm use 22
export ETH_RPC_URL='https://your-private-mainnet-rpc'
./scripts/start-local-demo.sh
```

## Testing

Tested on Ubuntu/WSL2, Foundry with Solidity 0.8.30 (Cancun), Node.js 22, against a pinned Ethereum mainnet fork.

- Contract build succeeds, with both the scenario engine and router well under the EIP-170 contract-size limit.
- Scenario engine, router/Aqua/Aave integration, trade math, and policy each have dedicated unit and fork test suites, including fuzz testing on the core capacity-safety property across both trade directions.
- Frontend: full test suite and production build pass.
- Backend guard tests pass.
- End-to-end smoke tests cover both fill directions, partial `qMax` clamping, replay/staleness guards, policy tightening, and a full collateral-withdrawal-then-restore scenario.

Some deeper invariant tests on the underlying SwapVM instruction set (e.g. additivity/symmetry under progressive fees, decay, TWAP, Dutch auctions, and gas-based fee adjustment stacked together) are currently skipped or flagged for further research. These are properties of the shared SwapVM primitives rather than MarginMM-specific logic, and don't affect the risk-check path described above.

This is a tested hackathon build, not an independent audit. Don't use it with real funds without further review.

## Team

- **Mohamed Tamer**: Web3 smart contract auditor
- **Yosef Tamer**: Smart contract developer
- **Ziad Kotry**: Fullstack web developer

## License

This project is licensed under the MIT License.
