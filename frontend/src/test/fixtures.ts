import type { AgentProposal, Fill, MakerState, Quote } from '../api';

const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (digit: string) => `0x${digit.repeat(64)}`;

export const stateFixture: MakerState = {
  makerAddress: address('1'),
  demoScenarioReceiver: address('2'),
  chain: {
    id: '31337', name: 'Anvil mainnet fork', fork: true,
    forkBlock: '25913344', timestamp: 4_000_000_000,
  },
  blockNumber: '25913350',
  contracts: {
    aqua: address('3'), router: address('4'), policy: address('5'),
    aWETH: address('6'), aUSDC: address('7'),
  },
  pairId: hash('8'),
  strategy: {
    state: 'active', hash: hash('9'),
    priceBounds: { minUsdcPerWeth: '1500', maxUsdcPerWeth: '6000' },
    aquaBalances: { weth: '10.123456789123456789', usdc: '50000.000001' },
    nextAction: null,
  },
  collateral: { weth: '10.123456789123456789', usdc: '50000.000001' },
  debt: { usdc: '46000' },
  currentHF: '1.35', stressHF: '1.20',
  policy: {
    state: 'valid', enabled: true, hardFloorStressHF: '1.10', policyVersion: 1,
    revision: '1', shockBps: 1240, marketRegime: 2, modelVersion: 1,
    issuedAt: 4_000_000_000,
    validUntil: 4_000_021_600, secondsRemaining: 21_600, evidenceHash: hash('a'),
    evidenceBlockFrom: 25_913_300, evidenceBlockTo: 25_913_340,
  },
  ready: true,
};

export const quoteFixture: Quote = {
  quoteId: '11111111-1111-4111-8111-111111111111', status: 'ready', direction: 'weth-in',
  requestedAmountIn: '5', actualAmountIn: '3.123456789123456789',
  baseAmountOut: '10000', finalAmountOut: '7500.123456', qMax: '7500.123456',
  partialFill: true, riskClass: 1,
  stressHFBefore: '1.20', stressHFAfter: '1.10', hardFloorStressHF: '1.10',
  shockBps: 1240, policyVersion: 1, policyRevision: '1', policyValidUntil: 4_000_021_600,
  expiresAt: '2099-01-01T00:00:00.000Z', reason: null,
};

export const fillFixture: Fill = {
  quoteId: quoteFixture.quoteId, status: 'filled', direction: 'weth-in',
  requestedAmountIn: quoteFixture.requestedAmountIn,
  actualAmountIn: quoteFixture.actualAmountIn,
  baseAmountOut: quoteFixture.baseAmountOut,
  finalAmountOut: quoteFixture.finalAmountOut,
  qMax: quoteFixture.qMax,
  stressHFBefore: quoteFixture.stressHFBefore,
  stressHFAfter: quoteFixture.stressHFAfter,
  shockBps: 1240, policyVersion: 1, riskClass: 1,
  transactionHash: hash('b'), chainId: '31337',
};

export const proposalFixture: AgentProposal = {
  decision: 'proposal_ready', headline: 'A fresh policy is ready for Maker review.',
  rationale: ['Current policy requires refresh.', 'Calibration passed deterministic validation.'],
  policyStatus: { state: 'missing' },
  graphEvidence: {
    queriedAt: 4_000_000_000, observationCount: 24,
    marketDeployment: 'QmMarket', marketIndexedBlock: 25913340,
    aaveDeployment: 'QmAave', aaveIndexedBlock: 25913341,
  },
  paymentReceipt: {
    transaction: '0.0.100@4000000000.000000000', network: 'hedera:testnet',
    amount: '100000', idempotentReplay: false,
  },
  calibration: {
    shockBps: 1240, marketRegime: 2, policyVersion: 2, modelVersion: 1,
    issuedAt: 4_000_000_000,
    validUntil: 4_000_021_600, evidenceHash: hash('c'), signer: address('d'),
    evidenceBlockFrom: 25_913_300, evidenceBlockTo: 25_913_340,
  },
  approval: {
    id: 'approve-market-policy', chainId: '31337', from: stateFixture.makerAddress,
    to: stateFixture.contracts.policy, data: '0x12345678', value: '0',
    label: 'Approve signed policy',
  },
};
