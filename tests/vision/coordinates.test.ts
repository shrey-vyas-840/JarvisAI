import { describe, expect, it } from 'vitest';

import {
  isRectWithinImage,
  mapImageRectToScreen,
  mapImageRectToViewport,
  normalizedRectToImageRect,
  toScreenElement,
} from '../../src/vision/coordinates.js';

describe('vision coordinate mapping', () => {
  it('detects bounds that overflow the captured image', () => {
    expect(isRectWithinImage({ x: 0, y: 0, width: 100, height: 50 }, 100, 50)).toBe(true);
    expect(isRectWithinImage({ x: 1, y: 0, width: 100, height: 50 }, 100, 50)).toBe(false);
    expect(isRectWithinImage({ x: 0, y: 0, width: 0, height: 50 }, 100, 50)).toBe(false);
  });

  it('converts normalized 0-1000 model coordinates into image pixels', () => {
    expect(
      normalizedRectToImageRect({ x: 100, y: 200, width: 300, height: 100 }, 1000, 500),
    ).toEqual({ x: 100, y: 100, width: 300, height: 50 });
    expect(
      normalizedRectToImageRect({ x: 500, y: 500, width: 100, height: 100 }, 773, 758),
    ).toEqual({ x: 387, y: 379, width: 77, height: 76 });
  });

  it('rejects normalized rectangles outside the 0-1000 grid', () => {
    expect(() =>
      normalizedRectToImageRect({ x: 900, y: 0, width: 200, height: 100 }, 1000, 500),
    ).toThrow(/0-1000 grid/);
  });

  it('maps resized image coordinates back to physical screen coordinates', () => {
    const mapped = mapImageRectToScreen(
      { x: 100, y: 50, width: 40, height: 20 },
      {
        imageWidth: 1280,
        imageHeight: 720,
        originalWidth: 1920,
        originalHeight: 1080,
        screenOriginX: 100,
        screenOriginY: 200,
      },
    );

    expect(mapped).toEqual({ x: 250, y: 275, width: 60, height: 30 });
  });

  it('maps screenshot coordinates to browser viewport CSS pixels', () => {
    const mapped = mapImageRectToViewport(
      { x: 200, y: 100, width: 100, height: 50 },
      {
        imageWidth: 2000,
        imageHeight: 1000,
        viewportWidth: 1000,
        viewportHeight: 500,
      },
    );

    expect(mapped).toEqual({ x: 100, y: 50, width: 50, height: 25 });
  });

  it('returns a clickable center for the mapped element', () => {
    const element = toScreenElement(
      {
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        label: 'Search',
        role: 'button',
      },
      { x: 110, y: 220, width: 30, height: 40 },
    );

    expect(element.center).toEqual({ x: 125, y: 240 });
    expect(element.role).toBe('button');
    expect(element.confidence).toBeNull();
  });

  it('rejects out-of-bounds mapping instead of clamping silently', () => {
    expect(() =>
      mapImageRectToScreen(
        { x: 1270, y: 0, width: 20, height: 20 },
        {
          imageWidth: 1280,
          imageHeight: 720,
          originalWidth: 1920,
          originalHeight: 1080,
          screenOriginX: 0,
          screenOriginY: 0,
        },
      ),
    ).toThrow(/outside the captured image/);
  });
});
