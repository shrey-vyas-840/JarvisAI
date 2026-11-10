export interface PngDimensions {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPngDimensions(buffer: Buffer): PngDimensions {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Screenshot was not a valid PNG image.');
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  if (width < 1 || height < 1) {
    throw new Error('Screenshot PNG has invalid dimensions.');
  }

  return { width, height };
}
