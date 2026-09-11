import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, FetchRequest } from 'ethers';
import { localRpcUrl } from './guards.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
const configuredRuntime = process.env.DEMO_RUNTIME_DIR;
if (configuredRuntime !== undefined && !configuredRuntime.trim()) {
  throw new Error('DEMO_RUNTIME_DIR must not be empty when set.');
}
export const RUNTIME = configuredRuntime === undefined
  ? fileURLToPath(new URL('.runtime/', import.meta.url))
  : `${resolve(configuredRuntime)}${sep}`;
export const FORK_BLOCK = 25913344;
export const ADDRESSES = {
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  provider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
};
export const TOKEN_ABI = [
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
  'function transfer(address,uint256) returns(bool)',
  'function deposit() payable',
];
export const POOL_ABI = [
  'function supply(address,uint256,address,uint16)',
  'function borrow(address,uint256,uint256,uint16,address)',
  'function setUserUseReserveAsCollateral(address,bool)',
  'function getUserAccountData(address) view returns(uint256,uint256,uint256,uint256,uint256,uint256)',
];
export async function artifact(name) {
  return JSON.parse(await readFile(`${ROOT}out/${name}.sol/${name}.json`, 'utf8'));
}
export function provider() {
  const request = new FetchRequest(localRpcUrl(process.env.DEMO_RPC_URL ?? 'http://127.0.0.1:8545'));
  // Fork reads may miss the local cache and reach the upstream RPC once.
  request.timeout = 60_000;
  const rpc = new JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  rpc.pollingInterval = 100;
  return rpc;
}
export async function assertFork(rpc, expectedInstance) {
  const [chain, client, meta] = await Promise.all([
    rpc.send('eth_chainId', []), rpc.send('web3_clientVersion', []), rpc.send('anvil_metadata', []),
  ]);
  if (BigInt(chain) !== 31337n || !/^anvil\//i.test(client)
    || BigInt(meta.chainId) !== 31337n || BigInt(meta.forkedNetwork?.chainId ?? 0) !== 1n
    || BigInt(meta.forkedNetwork?.forkBlockNumber ?? 0) !== BigInt(FORK_BLOCK)
    || !meta.instanceId || (expectedInstance && meta.instanceId !== expectedInstance)) {
    throw new Error('Expected the original local Anvil mainnet fork at block 25913344, chain 31337.');
  }
  return meta;
}
export async function receipt(txPromise) {
  const tx = await txPromise;
  const mined = await tx.wait(1, 120_000);
  if (!mined || mined.status !== 1) throw new Error('Local transaction did not succeed.');
  return mined;
}
export async function contracts(rpc, config) {
  const accounts = await rpc.send('eth_accounts', []);
  if (![config.maker, config.taker, config.scenarioReceiver].every(address =>
    accounts.some(account => account.toLowerCase() === address.toLowerCase()))) {
    throw new Error('Only unlocked local Anvil accounts are supported.');
  }
  const taker = await rpc.getSigner(config.taker);
  const [aquaArtifact, routerArtifact, engineArtifact, policyArtifact] = await Promise.all([
    artifact('Aqua'), artifact('MarginMMSwapVMRouter'), artifact('MarginMMScenarioEngine'), artifact('MarginMMPolicy'),
  ]);
  return {
    taker,
    aqua: new Contract(config.aqua, aquaArtifact.abi, rpc),
    router: new Contract(config.router, routerArtifact.abi, taker),
    engine: new Contract(config.engine, engineArtifact.abi, rpc),
    policy: new Contract(config.policy, policyArtifact.abi, rpc),
    aWETH: new Contract(config.aWETH, TOKEN_ABI, rpc),
    aUSDC: new Contract(config.aUSDC, TOKEN_ABI, rpc),
  };
}
