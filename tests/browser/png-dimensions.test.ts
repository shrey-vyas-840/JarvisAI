import { describe, expect, it } from 'vitest';

import { readPngDimensions } from '../../src/browser/png-dimensions.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function createPngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(24);
  PNG_SIGNATURE.copy(buffer, 0);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

describe('readPngDimensions', () => {
  it('reads width and height from a PNG IHDR header', () => {
    expect(readPngDimensions(createPngHeader(1920, 1080))).toEqual({
      width: 1920,
      height: 1080,
    });
  });

  it('rejects non-PNG data', () => {
    expect(() => readPngDimensions(Buffer.from('not a png'))).toThrow(/valid PNG/);
  });

  it('rejects a PNG signature with zero dimensions', () => {
    expect(() => readPngDimensions(createPngHeader(0, 100))).toThrow(/invalid dimensions/);
  });
});
