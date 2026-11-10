import { z } from 'zod';

export const visionElementSchema = z
  .object({
    x: z.number().int().min(0).max(1000),
    y: z.number().int().min(0).max(1000),
    width: z.number().int().positive().max(1000),
    height: z.number().int().positive().max(1000),
    label: z.string().trim().min(1).max(200),
    role: z.string().trim().max(80).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const visionResponseSchema = z
  .object({
    summary: z.string().trim().max(500).optional(),
    elements: z.array(visionElementSchema).max(50),
  })
  .strict();

export type VisionElement = z.infer<typeof visionElementSchema>;
export type VisionResponse = z.infer<typeof visionResponseSchema>;

export const VISION_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    elements: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          x: { type: 'integer', minimum: 0, maximum: 1000 },
          y: { type: 'integer', minimum: 0, maximum: 1000 },
          width: { type: 'integer', minimum: 1, maximum: 1000 },
          height: { type: 'integer', minimum: 1, maximum: 1000 },
          label: { type: 'string', minLength: 1, maxLength: 200 },
          role: { type: 'string', maxLength: 80 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['x', 'y', 'width', 'height', 'label', 'confidence'],
      },
    },
  },
  required: ['elements'],
} as const;

export type VisionErrorKind =
  'http' | 'network' | 'timeout' | 'aborted' | 'invalid_response' | 'unsupported_model';

export class VisionError extends Error {
  public readonly kind: VisionErrorKind;
  public readonly status: number | null;

  public constructor(
    kind: VisionErrorKind,
    message: string,
    status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'VisionError';
    this.kind = kind;
    this.status = status;
  }
}
