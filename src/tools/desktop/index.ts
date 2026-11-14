import path from 'node:path';
import { z } from 'zod';

import type { AppConfig } from '../../config.js';
import type { ToolDefinition } from '../../core/tool-registry.js';
import { DesktopManager } from '../../desktop/desktop-manager.js';
import type { ApprovalRequest } from '../../security/approval-types.js';
import { mapImageRectToScreen, toScreenElement, VisionAnalyzer } from '../../vision/index.js';

export interface DesktopToolsOptions {
  readonly desktopManager?: DesktopManager;
  readonly visionAnalyzer?: VisionAnalyzer;
  readonly config: AppConfig;
}

export function createDesktopTools(options: DesktopToolsOptions): ToolDefinition[] {
  const desktop = options.desktopManager ?? new DesktopManager();
  const vision =
    options.visionAnalyzer ??
    new VisionAnalyzer({
      baseUrl: options.config.ollama.baseUrl,
      model: options.config.ollama.visionModel,
    });
  const config = options.config;

  const tools: ToolDefinition[] = [];

  // 1. desktop_get_screen_info
  tools.push({
    name: 'desktop_get_screen_info',
    description:
      'Return primary and virtual desktop dimensions, screen origin, DPI, and display scaling. Use this before mapping vision coordinates to screen pixels.',
    permission: 'read-only',
    timeoutMs: 5000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: () => desktop.getScreenInfo(),
  });

  // 2. desktop_wait_for_window
  const waitForWindowSchema = z.object({
    title: z.string().optional().describe('Case-insensitive window title substring.'),
    class_name: z.string().optional().describe('Case-insensitive window class name substring.'),
    timeout_ms: z
      .number()
      .int()
      .min(250)
      .max(30000)
      .optional()
      .describe('Maximum wait time in milliseconds (default: 10000).'),
  });
  tools.push({
    name: 'desktop_wait_for_window',
    description:
      'Wait for a top-level Windows window (for example a Chrome extension popup) to appear, matching a title or class-name substring.',
    permission: 'read-only',
    timeoutMs: 35000,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Window title substring.' },
        class_name: { type: 'string', description: 'Window class name substring.' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds.' },
      },
      required: [],
    },
    argumentsSchema: waitForWindowSchema,
    execute: async (rawArgs: unknown) => {
      const args = waitForWindowSchema.parse(rawArgs);
      if ((args.title ?? '').trim().length === 0 && (args.class_name ?? '').trim().length === 0) {
        throw new Error('Provide a title or class_name filter.');
      }
      return desktop.waitForWindow(args);
    },
  });

  // 1. desktop_list_windows
  tools.push({
    name: 'desktop_list_windows',
    description:
      'List visible top-level application windows on the Windows desktop, showing titles, process IDs, handles, and dimensions.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: async () => {
      const windows = await desktop.listWindows();
      return { windows };
    },
  });

  // 2. desktop_inspect_window
  const inspectSchema = z.object({
    handle: z.number().int().optional().describe('Window handle.'),
    title: z.string().optional().describe('Substring of the window title.'),
  });
  tools.push({
    name: 'desktop_inspect_window',
    description:
      'Inspect details of a specific application window by its handle or title substring.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'integer', description: 'Window handle.' },
        title: { type: 'string', description: 'Window title substring.' },
      },
      required: [],
    },
    argumentsSchema: inspectSchema,
    execute: async (rawArgs: unknown) => {
      const args = inspectSchema.parse(rawArgs);
      return desktop.inspectWindow(args);
    },
  });

  // 3. desktop_focus_window
  const focusSchema = z.object({
    handle: z.number().int().optional().describe('Window handle.'),
    title: z.string().optional().describe('Substring of the window title to bring to front.'),
  });
  tools.push({
    name: 'desktop_focus_window',
    description: 'Bring a specific desktop window into the foreground and give it keyboard focus.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'integer', description: 'Window handle.' },
        title: { type: 'string', description: 'Window title substring.' },
      },
      required: [],
    },
    argumentsSchema: focusSchema,
    execute: async (rawArgs: unknown) => {
      const args = focusSchema.parse(rawArgs);
      return desktop.focusWindow(args);
    },
  });

  // 4. desktop_get_controls
  const getControlsSchema = z.object({
    handle: z.number().int().optional().describe('Window handle.'),
    title: z.string().optional().describe('Window title substring.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of controls to return (default: 50).'),
  });
  tools.push({
    name: 'desktop_get_controls',
    description:
      'Enumerate accessible UI Automation controls (buttons, tabs, inputs, documents) inside a target window.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'integer', description: 'Window handle.' },
        title: { type: 'string', description: 'Window title substring.' },
        limit: { type: 'integer', description: 'Max controls to return.' },
      },
      required: [],
    },
    argumentsSchema: getControlsSchema,
    execute: async (rawArgs: unknown) => {
      const args = getControlsSchema.parse(rawArgs);
      const controls = await desktop.getControls(args);
      return { controls };
    },
  });

  // 5. desktop_click_control
  const clickControlSchema = z.object({
    handle: z.number().int().optional().describe('Window handle.'),
    title: z.string().optional().describe('Window title.'),
    control_title: z.string().optional().describe('Text/label of the control to click.'),
    automation_id: z.string().optional().describe('Automation ID of the control to click.'),
    control_type: z.string().optional().describe('Control type (e.g. "Button", "TabItem").'),
  });
  tools.push({
    name: 'desktop_click_control',
    description:
      'Click a native Windows UI Automation control identified by label, automation ID, or control type.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'integer' },
        title: { type: 'string' },
        control_title: { type: 'string' },
        automation_id: { type: 'string' },
        control_type: { type: 'string' },
      },
      required: [],
    },
    argumentsSchema: clickControlSchema,
    execute: async (rawArgs: unknown) => {
      const args = clickControlSchema.parse(rawArgs);
      return desktop.clickControl(args);
    },
  });

  // 6. desktop_type_text
  const typeTextSchema = z
    .object({
      text: z.string().describe('Text to type.'),
      handle: z.number().int().positive().describe('Exact top-level window handle.'),
      expected_window_title: z.string().min(1).describe('Exact current window title.'),
      tab_title: z.string().min(1).describe('Exact UI Automation TabItem title to select.'),
      control_type: z.enum(['Document', 'Edit']).describe('Exact editor control type.'),
      expected_text: z.string().describe('Exact text that must already be in the editor.'),
    })
    .strict();
  tools.push({
    name: 'desktop_type_text',
    description:
      'Replace text only in one uniquely identified UI Automation document tab and editor control. Requires an exact window title, exact TabItem title, exact editor control type, and exact expected current text. Selects and verifies the tab, verifies editor focus, writes through a supported UIA control pattern or the focused control, then independently reads back exact text. Never falls back to window-level or foreground typing. Delivery without exact read-back is not success.',
    permission: 'requires-approval',
    timeoutMs: 30000,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        handle: { type: 'integer', minimum: 1, description: 'Exact top-level window handle.' },
        expected_window_title: { type: 'string', description: 'Exact current window title.' },
        tab_title: { type: 'string', description: 'Exact UI Automation TabItem title.' },
        control_type: { type: 'string', enum: ['Document', 'Edit'] },
        expected_text: { type: 'string', description: 'Exact expected editor contents.' },
      },
      required: [
        'text',
        'handle',
        'expected_window_title',
        'tab_title',
        'control_type',
        'expected_text',
      ],
    },
    argumentsSchema: typeTextSchema,
    approvalRequest: (rawArgs: unknown): ApprovalRequest => {
      const args = typeTextSchema.parse(rawArgs);
      return {
        toolName: 'desktop_type_text',
        operation: 'Write verified text to one desktop document',
        action: `Write ${String(args.text.length)} characters to the exact UIA tab "${args.tab_title}" in "${args.expected_window_title}".`,
        warning:
          'The action is limited to the uniquely identified document tab and will proceed only if the editor currently contains the exact expected text. JARVIS reads the editor back before reporting success.',
      };
    },
    execute: async (rawArgs: unknown) => {
      const args = typeTextSchema.parse(rawArgs);
      return desktop.typeText(args);
    },
    verify: (rawArgs: unknown, output) => {
      const args = typeTextSchema.safeParse(rawArgs);
      return (
        args.success &&
        typeof output === 'object' &&
        output !== null &&
        'outcome' in output &&
        output.outcome === 'verified' &&
        'readback_matches' in output &&
        output.readback_matches === true &&
        'readback' in output &&
        output.readback === args.data.text
      );
    },
  });

  const setControlValueSchema = z
    .object({
      handle: z.number().int().positive(),
      expected_window_title: z.string().min(1),
      control_type: z.string().min(1),
      expected_value: z.string(),
      value: z.string(),
      control_title: z.string().min(1).optional(),
      automation_id: z.string().min(1).optional(),
    })
    .strict()
    .refine((args) => args.control_title !== undefined || args.automation_id !== undefined, {
      message: 'Provide control_title or automation_id to identify one exact control.',
    });
  tools.push({
    name: 'desktop_set_control_value',
    description:
      'Set a value only on one uniquely identified native UI Automation control. Requires an exact target window identity, control type, stable title or automation ID, and exact expected pre-action value. Uses UIA ValuePattern and independently reads the value back; it never falls back to foreground keyboard typing.',
    permission: 'requires-approval',
    timeoutMs: 30000,
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'integer', minimum: 1 },
        expected_window_title: { type: 'string' },
        control_type: { type: 'string' },
        expected_value: { type: 'string' },
        value: { type: 'string' },
        control_title: { type: 'string' },
        automation_id: { type: 'string' },
      },
      required: ['handle', 'expected_window_title', 'control_type', 'expected_value', 'value'],
    },
    argumentsSchema: setControlValueSchema,
    approvalRequest: (rawArgs: unknown): ApprovalRequest => {
      const args = setControlValueSchema.parse(rawArgs);
      return {
        toolName: 'desktop_set_control_value',
        operation: 'Set one verified desktop control value',
        action: `Set one ${args.control_type} control in "${args.expected_window_title}" after its current value matches the supplied precondition.`,
        warning:
          'JARVIS will refuse ambiguous, stale, password, or changed targets and will read the target value back after delivery.',
      };
    },
    execute: (rawArgs: unknown) => desktop.setControlValue(setControlValueSchema.parse(rawArgs)),
    verify: (_args, output) =>
      typeof output === 'object' &&
      output !== null &&
      'outcome' in output &&
      output.outcome === 'verified' &&
      'readback_matches' in output &&
      output.readback_matches === true,
  });

  const documentReadSchema = z
    .object({
      handle: z.number().int().positive(),
      expected_window_title: z.string().min(1),
      tab_title: z.string().min(1),
      control_type: z.enum(['Document', 'Edit']),
      max_chars: z.number().int().min(1).max(16384).optional(),
    })
    .strict();
  tools.push({
    name: 'desktop_read_document_text',
    description:
      'Read text from exactly one UI Automation document tab/editor. Requires the exact window handle and title, TabItem title, and editor control type; fails if any target is ambiguous or changed.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'integer', minimum: 1 },
        expected_window_title: { type: 'string' },
        tab_title: { type: 'string' },
        control_type: { type: 'string', enum: ['Document', 'Edit'] },
        max_chars: { type: 'integer', minimum: 1, maximum: 16384 },
      },
      required: ['handle', 'expected_window_title', 'tab_title', 'control_type'],
    },
    argumentsSchema: documentReadSchema,
    execute: (rawArgs: unknown) => {
      const args = documentReadSchema.parse(rawArgs);
      return desktop.readDocumentText(args);
    },
    verify: (_args, output) =>
      typeof output === 'object' &&
      output !== null &&
      'outcome' in output &&
      output.outcome === 'verified' &&
      'text' in output &&
      typeof output.text === 'string',
  });

  const closeDocumentSchema = z
    .object({
      handle: z.number().int().positive(),
      expected_window_title: z.string().min(1),
      tab_title: z.string().min(1),
      control_type: z.enum(['Document', 'Edit']),
      expected_text: z.string(),
    })
    .strict();
  tools.push({
    name: 'desktop_close_verified_document',
    description:
      'Close only the exact selected UI Automation document tab after confirming its contents match the expected text. Fails closed if the target changed or is ambiguous.',
    permission: 'requires-approval',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        handle: { type: 'integer', minimum: 1 },
        expected_window_title: { type: 'string' },
        tab_title: { type: 'string' },
        control_type: { type: 'string', enum: ['Document', 'Edit'] },
        expected_text: { type: 'string' },
      },
      required: ['handle', 'expected_window_title', 'tab_title', 'control_type', 'expected_text'],
    },
    argumentsSchema: closeDocumentSchema,
    approvalRequest: (rawArgs: unknown): ApprovalRequest => {
      const args = closeDocumentSchema.parse(rawArgs);
      return {
        toolName: 'desktop_close_verified_document',
        operation: 'Close one verified desktop document tab',
        action: `Close the exact tab "${args.tab_title}" after its content matches the expected test text.`,
        warning: 'Only the exact identified test tab may be closed; other tabs remain untouched.',
      };
    },
    execute: (rawArgs: unknown) => {
      const args = closeDocumentSchema.parse(rawArgs);
      return desktop.closeVerifiedDocument(args);
    },
    verify: (_args, output) =>
      typeof output === 'object' &&
      output !== null &&
      'outcome' in output &&
      output.outcome === 'verified' &&
      'closed' in output &&
      output.closed === true,
  });

  // 7. desktop_press_key
  const pressKeySchema = z.object({
    key: z
      .string()
      .min(1)
      .describe('Key or shortcut to send (e.g. "{ENTER}", "{TAB}", "^s" for Ctrl+S).'),
  });
  tools.push({
    name: 'desktop_press_key',
    description: 'Send a keyboard key or hotkey combination to the active Windows desktop window.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key or shortcut string.' },
      },
      required: ['key'],
    },
    argumentsSchema: pressKeySchema,
    execute: async (rawArgs: unknown) => {
      const args = pressKeySchema.parse(rawArgs);
      return desktop.pressKey(args);
    },
  });

  // 8. desktop_scroll
  const scrollSchema = z.object({
    direction: z.enum(['down', 'up']).describe('Scroll direction.'),
    amount: z.number().int().min(1).max(20).optional().describe('Scroll ticks (default: 3).'),
    x: z.number().int().optional().describe('Optional screen X coordinate for wheel scrolling.'),
    y: z.number().int().optional().describe('Optional screen Y coordinate for wheel scrolling.'),
    handle: z.number().int().optional().describe('Optional target window handle.'),
    title: z.string().optional().describe('Optional target window title substring.'),
  });
  tools.push({
    name: 'desktop_scroll',
    description:
      'Scroll the active or target window up or down, optionally using a specific screen coordinate for the mouse wheel.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up'] },
        amount: { type: 'integer' },
        x: { type: 'integer' },
        y: { type: 'integer' },
        handle: { type: 'integer' },
        title: { type: 'string' },
      },
      required: ['direction'],
    },
    argumentsSchema: scrollSchema,
    execute: async (rawArgs: unknown) => {
      const args = scrollSchema.parse(rawArgs);
      return desktop.scroll(args);
    },
  });

  // 9. desktop_mouse_click
  const mouseClickSchema = z.object({
    x: z.number().int().describe('Horizontal screen coordinate in pixels.'),
    y: z.number().int().describe('Vertical screen coordinate in pixels.'),
    button: z.enum(['left', 'right']).optional().describe('Mouse button (default: left).'),
    double: z.boolean().optional().describe('Whether to double click.'),
    handle: z.number().int().optional().describe('Optional target window handle.'),
    title: z.string().optional().describe('Optional target window title substring.'),
  });
  tools.push({
    name: 'desktop_mouse_click',
    description:
      'Click mouse at physical screen coordinates (x, y). Coordinates are validated against the virtual screen and, when possible, the target/active window bounds.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'X coordinate.' },
        y: { type: 'integer', description: 'Y coordinate.' },
        button: { type: 'string', enum: ['left', 'right'] },
        double: { type: 'boolean' },
        handle: { type: 'integer' },
        title: { type: 'string' },
      },
      required: ['x', 'y'],
    },
    argumentsSchema: mouseClickSchema,
    execute: async (rawArgs: unknown) => {
      const args = mouseClickSchema.parse(rawArgs);
      return desktop.mouseClick(args);
    },
  });

  // 10. desktop_mouse_move
  const mouseMoveSchema = z.object({
    x: z.number().int().describe('X coordinate.'),
    y: z.number().int().describe('Y coordinate.'),
  });
  tools.push({
    name: 'desktop_mouse_move',
    description: 'Move mouse cursor to coordinates (x, y).',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
      },
      required: ['x', 'y'],
    },
    argumentsSchema: mouseMoveSchema,
    execute: async (rawArgs: unknown) => {
      const args = mouseMoveSchema.parse(rawArgs);
      return desktop.mouseMove(args);
    },
  });

  // 11. desktop_mouse_drag
  const mouseDragSchema = z.object({
    x1: z.number().int().describe('Start X coordinate.'),
    y1: z.number().int().describe('Start Y coordinate.'),
    x2: z.number().int().describe('End X coordinate.'),
    y2: z.number().int().describe('End Y coordinate.'),
    handle: z.number().int().optional().describe('Optional target window handle.'),
    title: z.string().optional().describe('Optional target window title substring.'),
  });
  tools.push({
    name: 'desktop_mouse_drag',
    description:
      'Perform a mouse drag and drop operation from (x1, y1) to (x2, y2), with screen and target-window coordinate validation.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        x1: { type: 'integer' },
        y1: { type: 'integer' },
        x2: { type: 'integer' },
        y2: { type: 'integer' },
        handle: { type: 'integer' },
        title: { type: 'string' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    argumentsSchema: mouseDragSchema,
    execute: async (rawArgs: unknown) => {
      const args = mouseDragSchema.parse(rawArgs);
      return desktop.mouseDrag(args);
    },
  });

  // 12. desktop_capture_screenshot
  const captureScreenshotSchema = z.object({
    filename: z
      .string()
      .optional()
      .describe('Filename to save inside D:\\AI\\Temp (e.g. "desktop.png").'),
    handle: z
      .number()
      .int()
      .optional()
      .describe('Optional window handle to capture only that window.'),
    title: z.string().optional().describe('Optional window title substring to capture.'),
  });
  tools.push({
    name: 'desktop_capture_screenshot',
    description:
      'Capture a screenshot of the Windows desktop or a specific window and save it into D:\\AI\\Temp. Returns image dimensions and screen origin for coordinate mapping.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Output screenshot filename.' },
        handle: { type: 'integer', description: 'Optional window handle.' },
        title: { type: 'string', description: 'Optional window title substring.' },
      },
      required: [],
    },
    argumentsSchema: captureScreenshotSchema,
    execute: async (rawArgs: unknown) => {
      const args = captureScreenshotSchema.parse(rawArgs);
      const safeName = (args.filename ?? `desktop-${String(Date.now())}.png`).replace(
        /[^a-zA-Z0-9_.-]/g,
        '_',
      );
      const targetPath = path.join(
        config.paths.temp,
        safeName.endsWith('.png') ? safeName : `${safeName}.png`,
      );

      return desktop.captureScreenshot({
        path: targetPath,
        handle: args.handle,
        title: args.title,
      });
    },
  });

  // 13. desktop_launch_application
  const launchAppSchema = z.object({
    name: z
      .enum(['notepad', 'calc', 'calculator', 'explorer', 'excel'])
      .describe(
        'Application to launch from the approved allowlist (notepad, calculator, explorer, excel).',
      ),
  });
  tools.push({
    name: 'desktop_launch_application',
    description:
      'Launch an approved Windows application from the security allowlist (notepad, calculator, explorer). Other arbitrary binaries are disallowed.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: ['notepad', 'calc', 'calculator', 'explorer', 'excel'],
          description: 'Approved application name.',
        },
      },
      required: ['name'],
    },
    argumentsSchema: launchAppSchema,
    execute: async (rawArgs: unknown) => {
      const args = launchAppSchema.parse(rawArgs);
      return desktop.launchApplication(args);
    },
  });

  const locateElements = async (
    args: {
      readonly target: string;
      readonly handle?: number | undefined;
      readonly title?: string | undefined;
      readonly max_elements?: number | undefined;
      readonly min_confidence?: number | undefined;
      readonly max_dimension?: number | undefined;
    },
    signal: AbortSignal,
  ): Promise<{
    capture: Awaited<ReturnType<DesktopManager['captureScreenshot']>>;
    analysis: Awaited<ReturnType<VisionAnalyzer['analyze']>>;
    elements: {
      label: string;
      role: string | null;
      confidence: number | null;
      rect: { x: number; y: number; width: number; height: number };
      center: { x: number; y: number };
      imageRect: { x: number; y: number; width: number; height: number };
    }[];
  }> => {
    const capture = await desktop.captureScreenshot({
      handle: args.handle,
      title: args.title,
      includeImage: true,
      maxDimension: args.max_dimension,
    });

    if (capture.image_base64 === undefined) {
      throw new Error('Desktop capture did not return image data for local vision analysis.');
    }

    const analysis = await vision.analyze(
      {
        imageBase64: capture.image_base64,
        imageWidth: capture.image_width,
        imageHeight: capture.image_height,
        target: args.target,
        contextLabel:
          args.title !== undefined ? `window titled "${args.title}"` : 'Windows desktop',
      },
      { signal },
    );

    const elements = analysis.elements
      .filter(
        (element) =>
          args.min_confidence === undefined || (element.confidence ?? 0) >= args.min_confidence,
      )
      .slice(0, args.max_elements ?? 8)
      .map((element) => {
        const screenRect = mapImageRectToScreen(
          {
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          },
          {
            imageWidth: capture.image_width,
            imageHeight: capture.image_height,
            originalWidth: capture.original_width,
            originalHeight: capture.original_height,
            screenOriginX: capture.screen_origin_x,
            screenOriginY: capture.screen_origin_y,
          },
        );

        return {
          ...toScreenElement(element, screenRect),
          imageRect: {
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          },
        };
      });

    return { capture, analysis, elements };
  };

  // 16. desktop_vision_locate
  const visionLocateSchema = z.object({
    target: z
      .string()
      .min(1)
      .max(500)
      .describe('Plain-language description of the visible element to locate.'),
    handle: z.number().int().optional().describe('Optional target window handle.'),
    title: z.string().optional().describe('Optional target window title substring.'),
    max_elements: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Maximum matching elements to return (default: 8).'),
    min_confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Optional minimum model confidence filter (0 to 1).'),
    max_dimension: z
      .number()
      .int()
      .min(640)
      .max(2048)
      .optional()
      .describe('Maximum screenshot dimension sent to the local vision model (default: 1600).'),
  });
  tools.push({
    name: 'desktop_vision_locate',
    description:
      'Observe a window or the desktop with a local-only Ollama vision model and locate visible UI elements. Returns physical screen coordinates and click centers. No screenshot is saved or sent to the cloud.',
    permission: 'read-only',
    timeoutMs: 120000,
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Element description to locate.' },
        handle: { type: 'integer', description: 'Optional window handle.' },
        title: { type: 'string', description: 'Optional window title substring.' },
        max_elements: { type: 'integer', description: 'Maximum elements to return.' },
        min_confidence: { type: 'number', description: 'Minimum confidence from 0 to 1.' },
        max_dimension: { type: 'integer', description: 'Maximum image dimension sent to Ollama.' },
      },
      required: ['target'],
    },
    argumentsSchema: visionLocateSchema,
    execute: async (rawArgs: unknown, context) => {
      const args = visionLocateSchema.parse(rawArgs);
      const { capture, analysis, elements } = await locateElements(args, context.signal);

      return {
        observed: true,
        model: analysis.model,
        summary: analysis.summary,
        elapsedMs: analysis.elapsedMs,
        invalidElementCount: analysis.invalidElementCount,
        capture: {
          imageWidth: capture.image_width,
          imageHeight: capture.image_height,
          originalWidth: capture.original_width,
          originalHeight: capture.original_height,
          screenOriginX: capture.screen_origin_x,
          screenOriginY: capture.screen_origin_y,
          scaleX: capture.scale_x,
          scaleY: capture.scale_y,
        },
        elements,
      };
    },
  });

  // 17. desktop_vision_click
  const visionClickSchema = z.object({
    target: z
      .string()
      .min(1)
      .max(500)
      .describe('Plain-language description of the visible element to click.'),
    handle: z.number().int().optional().describe('Optional target window handle.'),
    title: z.string().optional().describe('Optional target window title substring.'),
    candidate_index: z
      .number()
      .int()
      .min(0)
      .max(19)
      .optional()
      .describe('Which returned candidate to click, ordered by model output (default: 0).'),
    min_confidence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Minimum confidence required before clicking (default: 0.5).'),
    button: z.enum(['left', 'right']).optional().describe('Mouse button (default: left).'),
    double: z.boolean().optional().describe('Whether to double-click.'),
    expect_after: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Optional visible state expected after the click, verified by a second local vision pass.',
      ),
    max_dimension: z
      .number()
      .int()
      .min(640)
      .max(2048)
      .optional()
      .describe('Maximum screenshot dimension sent to the local vision model (default: 1600).'),
  });
  tools.push({
    name: 'desktop_vision_click',
    description:
      'Last-resort visual desktop click: capture a fresh screenshot, locate one target with the local Ollama vision model, click its physical screen center, then re-capture and (optionally) verify the expected visible state. Never reuses stale coordinates.',
    permission: 'read-only',
    timeoutMs: 240000,
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Element description to click.' },
        handle: { type: 'integer', description: 'Optional target window handle.' },
        title: { type: 'string', description: 'Optional target window title substring.' },
        candidate_index: { type: 'integer', description: 'Candidate index to click.' },
        min_confidence: { type: 'number', description: 'Minimum confidence from 0 to 1.' },
        button: { type: 'string', enum: ['left', 'right'] },
        double: { type: 'boolean' },
        expect_after: { type: 'string', description: 'Expected visible state after clicking.' },
        max_dimension: { type: 'integer', description: 'Maximum image dimension sent to Ollama.' },
      },
      required: ['target'],
    },
    argumentsSchema: visionClickSchema,
    execute: async (rawArgs: unknown, context) => {
      const args = visionClickSchema.parse(rawArgs);
      const minConfidence = args.min_confidence ?? 0.5;
      const { capture, analysis, elements } = await locateElements(
        {
          target: args.target,
          handle: args.handle,
          title: args.title,
          max_elements: 20,
          min_confidence: minConfidence,
          max_dimension: args.max_dimension,
        },
        context.signal,
      );
      const candidate = elements[args.candidate_index ?? 0];

      if (candidate === undefined) {
        throw new Error(
          `No visual element matched "${args.target}" with confidence >= ${String(minConfidence)}. No click was performed.`,
        );
      }

      const clickResult = await desktop.mouseClick({
        x: candidate.center.x,
        y: candidate.center.y,
        button: args.button,
        double: args.double,
        handle: args.handle,
        title: args.title,
      });

      const postCapture = await desktop.captureScreenshot({
        handle: args.handle,
        title: args.title,
        includeImage: args.expect_after !== undefined,
        maxDimension: args.max_dimension,
      });

      let verification: 'verified' | 'not_observed' | 'not_applicable' = 'not_applicable';
      let verificationDetails: unknown = null;

      if (args.expect_after !== undefined && postCapture.image_base64 !== undefined) {
        const expected = await vision.analyze(
          {
            imageBase64: postCapture.image_base64,
            imageWidth: postCapture.image_width,
            imageHeight: postCapture.image_height,
            target: args.expect_after,
            contextLabel:
              args.title !== undefined ? `window titled "${args.title}"` : 'Windows desktop',
          },
          { signal: context.signal },
        );
        const matching = expected.elements.filter(
          (element) => (element.confidence ?? 0) >= minConfidence,
        );
        verification = matching.length > 0 ? 'verified' : 'not_observed';
        verificationDetails = {
          summary: expected.summary,
          matchingElementCount: matching.length,
          elapsedMs: expected.elapsedMs,
          invalidElementCount: expected.invalidElementCount,
        };
      }

      return {
        clicked: clickResult.clicked,
        target: args.target,
        candidateIndex: args.candidate_index ?? 0,
        candidateCount: elements.length,
        confidence: candidate.confidence,
        label: candidate.label,
        screenCoordinates: candidate.center,
        targetWindow: clickResult.target_window ?? null,
        observation: {
          model: analysis.model,
          summary: analysis.summary,
          elapsedMs: analysis.elapsedMs,
          invalidElementCount: analysis.invalidElementCount,
          imageWidth: capture.image_width,
          imageHeight: capture.image_height,
        },
        reobserved: true,
        postAction: {
          imageWidth: postCapture.image_width,
          imageHeight: postCapture.image_height,
          screenOriginX: postCapture.screen_origin_x,
          screenOriginY: postCapture.screen_origin_y,
        },
        verification,
        verificationDetails,
      };
    },
  });

  return tools;
}
