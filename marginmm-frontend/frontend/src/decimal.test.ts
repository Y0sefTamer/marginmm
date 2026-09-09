import { describe, expect, it } from 'vitest';
import { amountError, compare, displayDecimal, floorError, headroom, isDecimal, meterPercent } from './decimal';

describe('decimal amounts', () => {
  it('preserves wei precision beyond IEEE-754', () => {
    expect(amountError('0.000000000000000001', 'usdc-in')).toBeNull();
    expect(compare('1.000000000000000001', '1')).toBe(1);
    expect(displayDecimal('123456789123456789.123456789123456789')).toBe('123,456,789,123,456,789.123456789123456789');
    expect(headroom('1.100000000000000001', '1.1')).toBe('0.000000000000000001');
  });
  it.each(['-1', '+1', '1e3', 'NaN', 'Infinity', '.1', '01', ' 1', '1.', '1,000', '0x1', '1.0000001'])('rejects invalid USDC amount %s', value => {
    expect(amountError(value, 'weth-in')).not.toBeNull();
  });
  it('does not round over-precision or overflow', () => {
    expect(amountError('1.0000000000000000001', 'usdc-in')).not.toBeNull();
    expect(amountError('0', 'weth-in')).not.toBeNull();
    expect(isDecimal('9'.repeat(78), 18)).toBe(false);
    expect(amountError('0.000001', 'weth-in')).toBeNull();
  });
  it('enforces the demo policy minimum without floating-point comparison', () => {
    expect(floorError('1.099999999999999999')).not.toBeNull();
    expect(floorError('1.10')).toBeNull();
    expect(floorError('1e0')).not.toBeNull();
  });
  it('bounds display meters while preserving the original amount', () => {
    expect(meterPercent('1.10')).toBe(55);
    expect(meterPercent('1000')).toBe(100);
    expect(meterPercent(null)).toBe(0);
    expect(displayDecimal('1.29523999', 2, 4)).toBe('1.2952');
    expect(displayDecimal('1.2', 2, 4)).toBe('1.20');
  });
});
