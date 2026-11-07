import path from 'node:path';
import { z } from 'zod';

import type { AppConfig } from '../../config.js';
import type { ToolDefinition } from '../../core/tool-registry.js';
import { DesktopManager } from '../../desktop/desktop-manager.js';

export interface DesktopToolsOptions {
  readonly desktopManager?: DesktopManager;
  readonly config: AppConfig;
}

export function createDesktopTools(options: DesktopToolsOptions): ToolDefinition[] {
  const desktop = options.desktopManager ?? new DesktopManager();
  const config = options.config;

  const tools: ToolDefinition[] = [];

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
  const typeTextSchema = z.object({
    text: z.string().describe('Text to type.'),
    handle: z.number().int().optional().describe('Window handle to focus before typing.'),
    title: z.string().optional().describe('Window title to focus before typing.'),
    automation_id: z.string().optional().describe('Specific control automation ID to target.'),
  });
  tools.push({
    name: 'desktop_type_text',
    description:
      'Type text into the focused window or control. Password controls are strictly blocked.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        handle: { type: 'integer', description: 'Window handle.' },
        title: { type: 'string', description: 'Window title.' },
        automation_id: { type: 'string', description: 'Automation ID.' },
      },
      required: ['text'],
    },
    argumentsSchema: typeTextSchema,
    execute: async (rawArgs: unknown) => {
      const args = typeTextSchema.parse(rawArgs);
      return desktop.typeText(args);
    },
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
  });
  tools.push({
    name: 'desktop_scroll',
    description: 'Scroll the active window up or down.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['down', 'up'] },
        amount: { type: 'integer' },
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
  });
  tools.push({
    name: 'desktop_mouse_click',
    description:
      'Click mouse at screen coordinates (x, y). Safety check: verified that coordinates lie within the active foreground window.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer', description: 'X coordinate.' },
        y: { type: 'integer', description: 'Y coordinate.' },
        button: { type: 'string', enum: ['left', 'right'] },
        double: { type: 'boolean' },
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
  });
  tools.push({
    name: 'desktop_mouse_drag',
    description: 'Perform a mouse drag and drop operation from (x1, y1) to (x2, y2).',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        x1: { type: 'integer' },
        y1: { type: 'integer' },
        x2: { type: 'integer' },
        y2: { type: 'integer' },
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
  });
  tools.push({
    name: 'desktop_capture_screenshot',
    description:
      'Capture screenshot of the Windows desktop or a specific window and save it into D:\\AI\\Temp.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Output screenshot filename.' },
        handle: { type: 'integer', description: 'Optional window handle.' },
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
      });
    },
  });

  // 13. desktop_launch_application
  const launchAppSchema = z.object({
    name: z
      .enum(['notepad', 'calc', 'calculator', 'explorer'])
      .describe(
        'Application to launch from the approved allowlist (notepad, calculator, explorer).',
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
          enum: ['notepad', 'calc', 'calculator', 'explorer'],
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

  return tools;
}
