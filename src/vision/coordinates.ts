import type { VisionElement } from './types.js';

export interface ImageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export const VISION_COORDINATE_GRID = 1000;

export interface ScreenCaptureMetadata {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly screenOriginX: number;
  readonly screenOriginY: number;
}

export interface ViewportMapping {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface ScreenElement {
  readonly label: string;
  readonly role: string | null;
  readonly confidence: number | null;
  readonly rect: ImageRect;
  readonly center: { readonly x: number; readonly y: number };
}

export function isRectWithinImage(
  rect: ImageRect,
  imageWidth: number,
  imageHeight: number,
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= imageWidth &&
    rect.y + rect.height <= imageHeight
  );
}

export function normalizedRectToImageRect(
  rect: ImageRect,
  imageWidth: number,
  imageHeight: number,
): ImageRect {
  assertPositive(imageWidth, 'imageWidth');
  assertPositive(imageHeight, 'imageHeight');

  if (!isRectWithinImage(rect, VISION_COORDINATE_GRID, VISION_COORDINATE_GRID)) {
    throw new Error('Normalized vision element bounds are outside the 0-1000 grid.');
  }

  const x = Math.round((rect.x * imageWidth) / VISION_COORDINATE_GRID);
  const y = Math.round((rect.y * imageHeight) / VISION_COORDINATE_GRID);
  const right = Math.round(((rect.x + rect.width) * imageWidth) / VISION_COORDINATE_GRID);
  const bottom = Math.round(((rect.y + rect.height) * imageHeight) / VISION_COORDINATE_GRID);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

export function mapImageRectToScreen(rect: ImageRect, capture: ScreenCaptureMetadata): ImageRect {
  assertPositive(capture.imageWidth, 'imageWidth');
  assertPositive(capture.imageHeight, 'imageHeight');
  assertPositive(capture.originalWidth, 'originalWidth');
  assertPositive(capture.originalHeight, 'originalHeight');

  if (!isRectWithinImage(rect, capture.imageWidth, capture.imageHeight)) {
    throw new Error('Vision element bounds are outside the captured image.');
  }

  const scaleX = capture.originalWidth / capture.imageWidth;
  const scaleY = capture.originalHeight / capture.imageHeight;
  const x = Math.round(capture.screenOriginX + rect.x * scaleX);
  const y = Math.round(capture.screenOriginY + rect.y * scaleY);
  const right = Math.round(capture.screenOriginX + (rect.x + rect.width) * scaleX);
  const bottom = Math.round(capture.screenOriginY + (rect.y + rect.height) * scaleY);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

export function mapImageRectToViewport(rect: ImageRect, mapping: ViewportMapping): ImageRect {
  assertPositive(mapping.imageWidth, 'imageWidth');
  assertPositive(mapping.imageHeight, 'imageHeight');
  assertPositive(mapping.viewportWidth, 'viewportWidth');
  assertPositive(mapping.viewportHeight, 'viewportHeight');

  if (!isRectWithinImage(rect, mapping.imageWidth, mapping.imageHeight)) {
    throw new Error('Vision element bounds are outside the captured browser screenshot.');
  }

  const scaleX = mapping.viewportWidth / mapping.imageWidth;
  const scaleY = mapping.viewportHeight / mapping.imageHeight;
  const x = Math.round(rect.x * scaleX);
  const y = Math.round(rect.y * scaleY);
  const right = Math.round((rect.x + rect.width) * scaleX);
  const bottom = Math.round((rect.y + rect.height) * scaleY);

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}

export function toScreenElement(element: VisionElement, rect: ImageRect): ScreenElement {
  return {
    label: element.label,
    role: element.role ?? null,
    confidence: element.confidence ?? null,
    rect,
    center: {
      x: rect.x + Math.floor(rect.width / 2),
      y: rect.y + Math.floor(rect.height / 2),
    },
  };
}

function assertPositive(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}
