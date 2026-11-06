import { describe, expect, it } from 'vitest';

import { getVersionLabel, PRODUCT_NAME, VERSION } from '../src/version.js';

describe('version metadata', () => {
  it('exposes the product name', () => {
    expect(PRODUCT_NAME).toBe('JARVIS');
  });

  it('uses a valid semantic version', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it('formats a human-readable label', () => {
    expect(getVersionLabel()).toBe(`${PRODUCT_NAME} ${VERSION}`);
  });
});
