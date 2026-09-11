import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, keccak256, maxUint256, parseAbi, parseUnits } from 'viem';
import type { Address, Hex } from 'viem';
import type { AgentProposal, MakerAction, MakerState } from './api';
import { validateMakerAction } from './wallet';
import { proposalFixture, stateFixture } from './test/fixtures';

const tokenAbi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function transfer(address to,uint256 amount) returns (bool)',
]);
const aquaAbi = parseAbi([
  'function ship(address app,bytes strategy,address[] tokens,uint256[] amounts) returns (bytes32 strategyHash)',
]);
const policyAbi = parseAbi([
  'function approveMarketPolicy(bytes32 strategy,uint256 hardFloorStressHF,(uint256 chainId,address policyRegistry,bytes32 pairId,uint32 shockBps,uint8 marketRegime,uint32 policyVersion,uint32 modelVersion,uint64 issuedAt,uint64 validUntil,uint64 evidenceBlockFrom,uint64 evidenceBlockTo,bytes32 evidenceHash) artifact,bytes signature)',
]);
const addr = (value: string) => value as Address;
const hex = (value: string) => value as Hex;

function action(id: string, to: string, data: `0x${string}`): MakerAction {
  return {
    id, chainId: '31337', from: stateFixture.makerAddress,
    to, data, value: '0', label: 'Reviewed local action',
  };
}

describe('Maker transaction firewall', () => {
  it('accepts only an unlimited approval from the configured aToken to configured Aqua', () => {
    const canonical = action('approve-aweth', stateFixture.contracts.aWETH, encodeFunctionData({
      abi: tokenAbi, functionName: 'approve', args: [addr(stateFixture.contracts.aqua), maxUint256],
    }));
    expect(() => validateMakerAction(stateFixture, canonical)).not.toThrow();
    const wrongSpender = { ...canonical, data: encodeFunctionData({
      abi: tokenAbi, functionName: 'approve', args: [addr(stateFixture.contracts.router), maxUint256],
    }) };
    expect(() => validateMakerAction(stateFixture, wrongSpender)).toThrow('not canonical');
    expect(() => validateMakerAction(stateFixture, { ...canonical, chainId: '1' as '31337' })).toThrow();
  });

  it('binds Aqua ship calldata to the reviewed immutable strategy hash and token pair', () => {
    const strategyBytes = encodeAbiParameters(
      [{ type: 'tuple', components: [
        { name: 'maker', type: 'address' }, { name: 'traits', type: 'uint256' }, { name: 'data', type: 'bytes' },
      ] }],
      [{ maker: addr(stateFixture.makerAddress), traits: 1n, data: '0x1234' }],
    );
    const state: MakerState = {
      ...stateFixture,
      strategy: { ...stateFixture.strategy, state: 'unshipped', hash: keccak256(strategyBytes) },
    };
    const canonical = action('ship-strategy', state.contracts.aqua, encodeFunctionData({
      abi: aquaAbi, functionName: 'ship',
      args: [
        addr(state.contracts.router), strategyBytes, [addr(state.contracts.aWETH), addr(state.contracts.aUSDC)],
        [parseUnits(state.collateral.weth, 18), parseUnits(state.collateral.usdc, 6)],
      ],
    }));
    expect(() => validateMakerAction(state, canonical)).not.toThrow();
    const wrongPair = { ...canonical, data: encodeFunctionData({
      abi: aquaAbi, functionName: 'ship',
      args: [
        addr(state.contracts.router), strategyBytes, [addr(state.contracts.aUSDC), addr(state.contracts.aWETH)],
        [parseUnits(state.collateral.usdc, 6), parseUnits(state.collateral.weth, 18)],
      ],
    }) };
    expect(() => validateMakerAction(state, wrongPair)).toThrow('not canonical');
    const wrongAmount = { ...canonical, data: encodeFunctionData({
      abi: aquaAbi, functionName: 'ship',
      args: [
        addr(state.contracts.router), strategyBytes, [addr(state.contracts.aWETH), addr(state.contracts.aUSDC)],
        [parseUnits(state.collateral.weth, 18) - 1n, parseUnits(state.collateral.usdc, 6)],
      ],
    }) };
    expect(() => validateMakerAction(state, wrongAmount)).toThrow('not canonical');
    const emptyState: MakerState = { ...state, collateral: { weth: '0', usdc: '0' } };
    const emptyShip = action('ship-strategy', emptyState.contracts.aqua, encodeFunctionData({
      abi: aquaAbi, functionName: 'ship',
      args: [
        addr(emptyState.contracts.router), strategyBytes,
        [addr(emptyState.contracts.aWETH), addr(emptyState.contracts.aUSDC)], [0n, 0n],
      ],
    }));
    expect(() => validateMakerAction(emptyState, emptyShip)).toThrow('not canonical');
  });

  it('binds MarketPolicy approval to chain, registry, pair, floor, TTL and reviewed evidence', () => {
    const calibration = proposalFixture.calibration!;
    const artifact = {
      chainId: 31337n,
      policyRegistry: addr(stateFixture.contracts.policy),
      pairId: stateFixture.pairId as `0x${string}`,
      shockBps: calibration.shockBps,
      marketRegime: calibration.marketRegime,
      policyVersion: calibration.policyVersion,
      modelVersion: calibration.modelVersion,
      issuedAt: BigInt(calibration.issuedAt),
      validUntil: BigInt(calibration.validUntil),
      evidenceBlockFrom: 25_913_300n,
      evidenceBlockTo: 25_913_340n,
      evidenceHash: calibration.evidenceHash as `0x${string}`,
    };
    const canonical = action('approve-market-policy', stateFixture.contracts.policy, encodeFunctionData({
      abi: policyAbi, functionName: 'approveMarketPolicy',
      args: [hex(stateFixture.strategy.hash!), 1_100_000_000_000_000_000n, artifact, '0x1234'],
    }));
    const proposal: AgentProposal = { ...proposalFixture, approval: canonical };
    expect(() => validateMakerAction(stateFixture, canonical, { hardFloor: '1.10', proposal })).not.toThrow();
    expect(() => validateMakerAction(stateFixture, canonical, { hardFloor: '1.20', proposal })).toThrow();
    expect(() => validateMakerAction(stateFixture, canonical, {
      hardFloor: '1.10',
      proposal: { ...proposal, calibration: { ...calibration, marketRegime: 3 } },
    })).toThrow();

    const extended = { ...artifact, validUntil: artifact.issuedAt + 21_601n };
    const unsafeTtl = { ...canonical, data: encodeFunctionData({
      abi: policyAbi, functionName: 'approveMarketPolicy',
      args: [hex(stateFixture.strategy.hash!), 1_100_000_000_000_000_000n, extended, '0x1234'],
    }) };
    const alteredProposal: AgentProposal = {
      ...proposal,
      calibration: { ...calibration, validUntil: Number(extended.validUntil) },
    };
    expect(() => validateMakerAction(stateFixture, unsafeTtl, { hardFloor: '1.10', proposal: alteredProposal })).toThrow();
  });

  it('allows only the fixed local collateral-drift transfer', () => {
    const canonical = action('withdraw-usdc-scenario', stateFixture.contracts.aUSDC, encodeFunctionData({
      abi: tokenAbi, functionName: 'transfer', args: [addr(stateFixture.demoScenarioReceiver), 5_000_000_000n],
    }));
    expect(() => validateMakerAction(stateFixture, canonical)).not.toThrow();
    const oversized = { ...canonical, data: encodeFunctionData({
      abi: tokenAbi, functionName: 'transfer', args: [addr(stateFixture.demoScenarioReceiver), 5_000_000_001n],
    }) };
    expect(() => validateMakerAction(stateFixture, oversized)).toThrow('not canonical');
  });
});
