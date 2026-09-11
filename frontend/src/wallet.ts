import {
  createPublicClient, createWalletClient, custom, decodeFunctionData, defineChain, getAddress,
  http, keccak256, maxUint256, parseAbi, parseUnits,
} from 'viem';
import type { Address, EIP1193Provider, Hex } from 'viem';
import type { AgentProposal, MakerAction, MakerState } from './api';

const localChain = defineChain({
  id: 31337,
  name: 'MarginMM local mainnet fork',
  nativeCurrency: { name: 'Local Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

const tokenAbi = parseAbi([
  'function approve(address spender,uint256 amount) returns (bool)',
  'function transfer(address to,uint256 amount) returns (bool)',
]);
const aquaAbi = parseAbi([
  'function ship(address app,bytes strategy,address[] tokens,uint256[] amounts) returns (bytes32 strategyHash)',
]);
const policyAbi = parseAbi([
  'function approveMarketPolicy(bytes32 strategy,uint256 hardFloorStressHF,(uint256 chainId,address policyRegistry,bytes32 pairId,uint32 shockBps,uint8 marketRegime,uint32 policyVersion,uint32 modelVersion,uint64 issuedAt,uint64 validUntil,uint64 evidenceBlockFrom,uint64 evidenceBlockTo,bytes32 evidenceHash) artifact,bytes signature)',
  'function setMakerSettings(bytes32 strategy,bytes32 pairId,uint256 hardFloorStressHF,uint32 policyVersion)',
]);

declare global {
  interface Window { ethereum?: EIP1193Provider }
}

export interface ExpectedMakerAction {
  hardFloor?: string;
  proposal?: AgentProposal;
}

export async function connectMaker(expectedMaker: string): Promise<Address> {
  const injected = window.ethereum;
  if (!injected) throw new Error('Install or enable MetaMask/Rabby, then import the local demo-only Maker account.');
  await injected.request({ method: 'eth_requestAccounts' });
  await ensureLocalChain(injected);
  const accounts = await injected.request({ method: 'eth_accounts' }) as string[];
  if (!Array.isArray(accounts) || !accounts[0]) throw new Error('The injected wallet returned no selected account.');
  const selected = getAddress(accounts[0]);
  if (selected.toLowerCase() !== expectedMaker.toLowerCase()) {
    throw new Error(`Select the seeded Maker account ${expectedMaker} in your wallet.`);
  }
  return selected;
}

export async function sendMakerAction(
  state: MakerState,
  action: MakerAction,
  expected: ExpectedMakerAction = {},
): Promise<Hex> {
  const account = await connectMaker(state.makerAddress);
  validateMakerAction(state, action, expected);
  const injected = window.ethereum as EIP1193Provider;
  const wallet = createWalletClient({ account, chain: localChain, transport: custom(injected) });
  const client = createPublicClient({ chain: localChain, transport: http('http://127.0.0.1:8545') });
  const hash = await wallet.sendTransaction({
    account, chain: localChain, to: getAddress(action.to), data: action.data, value: 0n,
  });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error('The Maker transaction reverted on local chain 31337.');
  return hash;
}

export function validateMakerAction(
  state: MakerState,
  action: MakerAction,
  expected: ExpectedMakerAction = {},
): void {
  if (action.chainId !== '31337' || action.value !== '0'
    || action.from.toLowerCase() !== state.makerAddress.toLowerCase()) {
    throw new Error('The proposed transaction is not a zero-value Maker action on chain 31337.');
  }
  const target = action.to.toLowerCase();
  if (action.id === 'approve-aweth' || action.id === 'approve-ausdc') {
    const expectedToken = action.id === 'approve-aweth' ? state.contracts.aWETH : state.contracts.aUSDC;
    if (target !== expectedToken.toLowerCase()) throw new Error('Approval target is not the configured aToken.');
    const decoded = decodeFunctionData({ abi: tokenAbi, data: action.data });
    if (decoded.functionName !== 'approve'
      || String(decoded.args[0]).toLowerCase() !== state.contracts.aqua.toLowerCase()
      || decoded.args[1] !== maxUint256) throw new Error('Aqua approval calldata is not canonical.');
    return;
  }
  if (action.id === 'ship-strategy') {
    if (target !== state.contracts.aqua.toLowerCase() || state.strategy.state !== 'unshipped' || !state.strategy.hash) {
      throw new Error('Aqua ship target or strategy is invalid.');
    }
    const decoded = decodeFunctionData({ abi: aquaAbi, data: action.data });
    const [app, strategyBytes, tokens, amounts] = decoded.args;
    if (decoded.functionName !== 'ship'
      || String(app).toLowerCase() !== state.contracts.router.toLowerCase()
      || keccak256(strategyBytes) !== state.strategy.hash
      || tokens.length !== 2 || amounts.length !== 2
      || String(tokens[0]).toLowerCase() !== state.contracts.aWETH.toLowerCase()
      || String(tokens[1]).toLowerCase() !== state.contracts.aUSDC.toLowerCase()
      || amounts[0] === 0n || amounts[1] === 0n
      || amounts[0] !== parseUnits(state.collateral.weth, 18)
      || amounts[1] !== parseUnits(state.collateral.usdc, 6)) throw new Error('Aqua ship calldata is not canonical.');
    return;
  }
  if (action.id === 'approve-market-policy') {
    if (target !== state.contracts.policy.toLowerCase() || !state.strategy.hash
      || !expected.hardFloor || !expected.proposal?.calibration) {
      throw new Error('Signed policy approval context is incomplete.');
    }
    const decoded = decodeFunctionData({ abi: policyAbi, data: action.data });
    if (decoded.functionName !== 'approveMarketPolicy') throw new Error('Unexpected policy approval method.');
    const [strategy, floor, artifact, signature] = decoded.args;
    const calibration = expected.proposal.calibration;
    if (strategy !== state.strategy.hash || floor !== parseUnits(expected.hardFloor, 18)
      || artifact.chainId !== 31337n
      || artifact.policyRegistry.toLowerCase() !== state.contracts.policy.toLowerCase()
      || artifact.pairId !== state.pairId
      || artifact.shockBps !== calibration.shockBps
      || artifact.marketRegime !== calibration.marketRegime
      || artifact.policyVersion !== calibration.policyVersion
      || artifact.modelVersion !== calibration.modelVersion
      || Number(artifact.issuedAt) !== calibration.issuedAt
      || Number(artifact.validUntil) !== calibration.validUntil
      || artifact.issuedAt > BigInt(state.chain.timestamp)
      || artifact.validUntil < BigInt(state.chain.timestamp)
      || artifact.validUntil - artifact.issuedAt > 21_600n
      || Number(artifact.evidenceBlockFrom) !== calibration.evidenceBlockFrom
      || Number(artifact.evidenceBlockTo) !== calibration.evidenceBlockTo
      || artifact.evidenceBlockFrom > artifact.evidenceBlockTo
      || artifact.evidenceHash !== calibration.evidenceHash
      || signature === '0x') throw new Error('Signed policy approval calldata does not match the reviewed proposal.');
    return;
  }
  if (action.id === 'update-maker-floor') {
    if (target !== state.contracts.policy.toLowerCase() || !state.strategy.hash || !expected.hardFloor) {
      throw new Error('Maker floor update context is incomplete.');
    }
    const decoded = decodeFunctionData({ abi: policyAbi, data: action.data });
    if (decoded.functionName !== 'setMakerSettings'
      || decoded.args[0] !== state.strategy.hash || decoded.args[1] !== state.pairId
      || decoded.args[2] !== parseUnits(expected.hardFloor, 18)
      || decoded.args[3] !== state.policy.policyVersion) throw new Error('Maker floor calldata is not canonical.');
    return;
  }
  if (action.id === 'withdraw-usdc-scenario') {
    if (target !== state.contracts.aUSDC.toLowerCase()) throw new Error('Scenario target is not aUSDC.');
    const decoded = decodeFunctionData({ abi: tokenAbi, data: action.data });
    if (decoded.functionName !== 'transfer'
      || String(decoded.args[0]).toLowerCase() !== state.demoScenarioReceiver.toLowerCase()
      || decoded.args[1] !== parseUnits('5000', 6)) throw new Error('Scenario calldata is not canonical.');
    return;
  }
  throw new Error('The local API proposed an unknown Maker action.');
}

async function ensureLocalChain(provider: EIP1193Provider): Promise<void> {
  const chainId = await provider.request({ method: 'eth_chainId' });
  if (chainId === '0x7a69') return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a69' }] });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== 4902 && code !== -32603) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: '0x7a69', chainName: localChain.name,
        nativeCurrency: localChain.nativeCurrency,
        rpcUrls: ['http://127.0.0.1:8545'],
      }],
    });
  }
  const updated = await provider.request({ method: 'eth_chainId' });
  if (updated !== '0x7a69') throw new Error('Switch the injected wallet to MarginMM local chain 31337.');
}
