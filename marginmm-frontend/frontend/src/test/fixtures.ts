import type { Fill, MakerState, Quote } from '../api';

// Test fixtures only. The application never imports or renders these values.
export const stateFixture: MakerState = {
  makerAddress: '0x0000000000000000000000000000000000000002',
  chain: { id: '31337', name: 'Anvil', fork: true },
  blockNumber: '23000000',
  collateral: { weth: '10.123456789123456789', usdc: '20000.000001' },
  debt: { usdc: '12000' },
  currentHF: '1.75',
  stressHF: '1.40',
  riskFloor: '1.10',
  qMax: { weth: '0.123456789123456789', usdc: '750.123456' },
};

export const quoteFixture: Quote = {
  quoteId: 'quote-1', status: 'ready', direction: 'weth-in',
  requestedOut: '1000', executableOut: '750.123456', qMax: '750.123456', partialFill: true,
  stressHF: '1.20', riskFloor: '1.10', expiresAt: '2099-01-01T00:00:00.000Z',
};

export const fillFixture: Fill = {
  quoteId: 'quote-1', status: 'filled', direction: 'weth-in',
  requestedOut: '1000', executedOut: '750.123456',
  transactionHash: `0x${'a'.repeat(64)}`, chainId: '31337',
};
