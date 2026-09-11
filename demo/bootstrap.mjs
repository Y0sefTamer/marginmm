import { mkdir, readFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AbiCoder, Contract, ContractFactory, MaxUint256, getAddress, keccak256, toBeHex } from 'ethers';
import { ADDRESSES, TOKEN_ABI, POOL_ABI, RUNTIME, provider, assertFork, artifact, receipt } from './chain.mjs';
import { saveConfig } from './service.mjs';

// Only a fresh verified Anvil fork may receive this synthetic USDC balance.
// Discover the slot by observing balanceOf, restore every probe, then verify the final write.
async function fundUSDC(rpc, token, account, amount) {
  const coder = AbiCoder.defaultAbiCoder();
  const before = await token.balanceOf(account);
  if (before !== 0n) throw new Error('Fixture account is not fresh.');
  const marker = 1234567890123n;
  for (let slot = 0; slot < 100; slot++) {
    const key = keccak256(coder.encode(['address', 'uint256'], [account, slot]));
    const previous = await rpc.send('eth_getStorageAt', [ADDRESSES.usdc, key, 'latest']);
    let matched = false;
    try {
      await rpc.send('anvil_setStorageAt', [ADDRESSES.usdc, key, toBeHex(marker, 32)]);
      matched = await token.balanceOf(account) === marker;
    } finally { await rpc.send('anvil_setStorageAt', [ADDRESSES.usdc, key, previous]); }
    if (matched) {
      await rpc.send('anvil_setStorageAt', [ADDRESSES.usdc, key, toBeHex(amount, 32)]);
      if (await token.balanceOf(account) !== amount) throw new Error('USDC fixture funding failed.');
      return;
    }
  }
  throw new Error('USDC balance slot could not be verified.');
}
export async function bootstrap(rpc) {
  const meta = await assertFork(rpc);
  const calibrationSigner = getAddress(process.env.CALIBRATION_SIGNER_ADDRESS ?? '');
  await mkdir(RUNTIME, { recursive: true, mode: 0o700 });
  const existing = await readFile(`${RUNTIME}deployment.json`, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && JSON.parse(existing).instanceId === meta.instanceId) {
    throw new Error('This Anvil instance already has a fixture. Use restore or restart Anvil.');
  }
  // Load all final compiled artifacts before changing any chain state.
  const names = ['Aqua', 'MarginMMScenarioEngine', 'MarginMMPolicy', 'MarginMMSwapVMRouter'];
  const compiled = await Promise.all(names.map(artifact));
  const accounts = await rpc.send('eth_accounts', []);
  if (accounts.length < 3) throw new Error('Three unlocked Anvil accounts required.');
  const [makerAddress, takerAddress, scenarioReceiver] = accounts;
  const maker = await rpc.getSigner(makerAddress), taker = await rpc.getSigner(takerAddress);
  const addressesProvider = new Contract(ADDRESSES.provider, [
    'function getPool() view returns(address)', 'function getPoolDataProvider() view returns(address)',
    'function getPriceOracle() view returns(address)',
  ], rpc);
  const [poolAddress, dataProvider, oracle] = await Promise.all([
    addressesProvider.getPool(), addressesProvider.getPoolDataProvider(), addressesProvider.getPriceOracle(),
  ]);
  if (poolAddress.toLowerCase() !== ADDRESSES.pool.toLowerCase()) throw new Error('Unexpected Aave pool.');
  const pool = new Contract(poolAddress, POOL_ABI, maker);
  async function deploy(index, args) {
    const value = await new ContractFactory(compiled[index].abi, compiled[index].bytecode.object, maker).deploy(...args);
    await value.waitForDeployment();
    return value;
  }
  console.log('Deploying Aqua, scenario engine, maker policy and router on local chain 31337.');
  const aqua = await deploy(0, []);
  const engine = await deploy(1, [poolAddress, dataProvider, oracle]);
  const policy = await deploy(2, [makerAddress, calibrationSigner]);
  const router = await deploy(3, [aqua.target, ADDRESSES.weth, engine.target, policy.target, makerAddress, 'MarginMM Demo', '1']);
  const aWETHAddress = await engine.aWETH(), aUSDCAddress = await engine.aUSDC();
  const aWETH = new Contract(aWETHAddress, TOKEN_ABI, maker), aUSDC = new Contract(aUSDCAddress, TOKEN_ABI, maker);
  const weth = new Contract(ADDRESSES.weth, TOKEN_ABI, maker), usdc = new Contract(ADDRESSES.usdc, TOKEN_ABI, maker);
  console.log('Seeding maker/taker collateral through actual Aave supplies on the fork.');
  for (const [signer, wethAmount, usdcAmount] of [[maker, 10n * 10n ** 18n, 50000n * 10n ** 6n], [taker, 100n * 10n ** 18n, 200000n * 10n ** 6n]]) {
    const account = await signer.getAddress();
    await fundUSDC(rpc, usdc, account, usdcAmount);
    await receipt(weth.connect(signer).deposit({ value: wethAmount }));
    await receipt(weth.connect(signer).approve(poolAddress, wethAmount));
    await receipt(usdc.connect(signer).approve(poolAddress, usdcAmount));
    await receipt(pool.connect(signer).supply(ADDRESSES.weth, wethAmount, account, 0));
    await receipt(pool.connect(signer).supply(ADDRESSES.usdc, usdcAmount, account, 0));
    await receipt(pool.connect(signer).setUserUseReserveAsCollateral(ADDRESSES.weth, true));
    await receipt(pool.connect(signer).setUserUseReserveAsCollateral(ADDRESSES.usdc, true));
  }
  const accountBeforeBorrow = await pool.getUserAccountData(makerAddress);
  console.log(`Maker available borrow (Aave base units): ${accountBeforeBorrow[2]}`);
  try {
    await pool.borrow.staticCall(ADDRESSES.usdc, 46000n * 10n ** 6n, 2, 0, makerAddress);
  } catch (error) {
    throw new Error(`Aave borrow fixture rejected: ${error.shortMessage ?? error.message}`);
  }
  await receipt(pool.borrow(ADDRESSES.usdc, 46000n * 10n ** 6n, 2, 0, makerAddress));
  const [actualWeth, actualUsdc] = await Promise.all([aWETH.balanceOf(makerAddress), aUSDC.balanceOf(makerAddress)]);
  await receipt(aWETH.connect(taker).approve(router.target, MaxUint256));
  await receipt(aUSDC.connect(taker).approve(router.target, MaxUint256));
  const snapshot = await engine.snapshot(makerAddress);
  if (snapshot.usdcDebt < 46000n * 10n ** 6n || snapshot.aaveHF <= 10n ** 18n) {
    throw new Error('Bootstrap position is not a valid Aave fixture.');
  }
  const config = {
    instanceId: meta.instanceId, chainId: 31337, forkBlock: 25913344,
    maker: makerAddress, taker: takerAddress, scenarioReceiver,
    aqua: aqua.target, engine: engine.target, policy: policy.target, router: router.target,
    aWETH: aWETHAddress, aUSDC: aUSDCAddress, pool: poolAddress, dataProvider, oracle,
    pairId: await router.PAIR_ID(), calibrationSigner,
    order: null, strategyHash: null, xycPriceBounds: null,
    suppliedBalances: { weth: actualWeth.toString(), usdc: actualUsdc.toString() },
    receiverBaseline: (await aUSDC.balanceOf(scenarioReceiver)).toString(),
    snapshotId: await rpc.send('evm_snapshot', []),
  };
  await saveConfig(config);
  await unlink(`${RUNTIME}pending.json`).catch(error => { if (error.code !== 'ENOENT') throw error; });
  console.log(`Local fixture ready for Maker wallet ${makerAddress}.`);
  console.log('Deploy/seed completed. Aqua shipping and MarketPolicy approval remain browser-wallet actions.');
  return config;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rpc = provider();
  bootstrap(rpc).catch(error => {
    console.error(`Bootstrap failed: ${error.shortMessage ?? error.message ?? 'unknown error'}`);
    process.exitCode = 1;
  })
    .finally(() => rpc.destroy());
}
