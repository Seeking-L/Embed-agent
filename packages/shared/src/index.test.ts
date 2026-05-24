import { describe, it, expect } from 'vitest';
import { formatTokenUsage } from './index';

describe('formatTokenUsage', () => {
  it('把输入输出 token 拼成一行', () => {
    expect(formatTokenUsage(10, 20)).toBe('10 in / 20 out');
  });
});
