import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import {
  AGENT_DESKTOP_REF_PATTERN,
  AgentDesktopClient,
  type AgentDesktopReadProperty,
  type AgentDesktopStateProperty,
} from '../../desktop/agent-desktop-client.js';
import { DesktopBackendSelector } from '../../desktop/backend-selector.js';
import { DesktopManager } from '../../desktop/desktop-manager.js';

const REF_PATTERN = AGENT_DESKTOP_REF_PATTERN;

const refSchema = z
  .string()
  .regex(REF_PATTERN, 'Must be a qualified ref from a fresh agent-desktop snapshot.');

const surfaceValues = [
  'window',
  'focused',
  'menu',
  'menubar',
  'sheet',
  'popover',
  'alert',
  'desktop',
  'taskbar',
  'system-tray',
  'quick-settings',
  'notification-center',
  'toolbar',
  'dock',
  'spotlight',
  'menu-bar-extras',
  'system-tray-overflow',
  'start-menu',
  'action-center',
] as const;

const refActions = [
  'click',
  'toggle',
  'check',
  'uncheck',
  'expand',
  'collapse',
  'set_value',
  'type',
  'clear',
  'press',
] as const;

const readProperties = [
  'text',
  'value',
  'title',
  'bounds',
  'role',
  'states',
  'visible',
  'enabled',
  'checked',
  'focused',
  'expanded',
  'selected',
] as const;

export interface AgentDesktopToolsOptions {
  readonly client?: AgentDesktopClient | undefined;
  readonly selector?: DesktopBackendSelector | undefined;
  readonly desktopManager?: DesktopManager | undefined;
}

export function createAgentDesktopTools(options: AgentDesktopToolsOptions = {}): ToolDefinition[] {
  const client = options.client ?? new AgentDesktopClient();
  const desktopManager = options.desktopManager ?? new DesktopManager();
  const selector =
    options.selector ??
    new DesktopBackendSelector({
      agentDesktop: client,
      pywinauto: desktopManager,
    });
  const tools: ToolDefinition[] = [];

  tools.push({
    name: 'desktop_ax_status',
    description:
      'Select the fastest currently reliable Windows desktop automation backend by probing agent-desktop UI Automation and the pywinauto fallback. Returns list and accessibility-tree latency, health, selected backend, permissions, and errors. Call once per run and re-check after switching to a materially different app.',
    permission: 'read-only',
    timeoutMs: 45000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: async () => selector.select({ force: true }),
  });

  const listWindowsSchema = z.object({
    app: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Optional exact case-insensitive application name such as notepad.exe.'),
  });
  tools.push({
    name: 'desktop_ax_list_windows',
    description:
      'List visible Windows application windows through the agent-desktop accessibility backend. Returns window ids, app names, titles, process ids, focus state, and bounds.',
    permission: 'read-only',
    timeoutMs: 20000,
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Optional exact application name filter.' },
      },
      required: [],
    },
    argumentsSchema: listWindowsSchema,
    execute: async (rawArgs: unknown, context) => {
      const args = listWindowsSchema.parse(rawArgs);
      const windows = await client.listWindows(args.app, { signal: context.signal });

      return { backend: 'agent-desktop', windows };
    },
  });

  const snapshotSchema = z
    .object({
      app: z.string().trim().min(1).max(200).optional().describe('Application name.'),
      window_id: z
        .string()
        .regex(/^w-\d+$/)
        .optional()
        .describe('Specific window id from desktop_ax_list_windows.'),
      surface: z
        .enum(surfaceValues)
        .optional()
        .describe('Accessibility surface such as window, menu, sheet, or start-menu.'),
      root: refSchema.optional().describe('Drill into one region of an existing snapshot.'),
      interactive_only: z.boolean().optional().describe('Keep interactive elements only.'),
      compact: z.boolean().optional().describe('Collapse empty single-child wrappers.'),
      skeleton: z.boolean().optional().describe('Return a shallow overview with child counts.'),
      include_bounds: z.boolean().optional().describe('Include element screen bounds.'),
      max_depth: z.number().int().min(1).max(20).optional().describe('Maximum tree depth.'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .max(30000)
        .optional()
        .describe('Observation deadline in milliseconds.'),
    })
    .superRefine((value, context) => {
      if (value.app === undefined && value.window_id === undefined && value.root === undefined) {
        context.addIssue({
          code: 'custom',
          message: 'Provide app, window_id, or root.',
        });
      }

      if (value.root !== undefined && value.surface !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'root cannot be combined with surface.',
        });
      }
    });
  tools.push({
    name: 'desktop_ax_snapshot',
    description:
      'Read an application accessibility tree through agent-desktop and return structured JSON with scoped @ref IDs. Use interactive_only and compact for normal use; use skeleton then root drilling for large apps. Snapshots may contain private UI text and must not be placed in public logs. Re-snapshot after any UI change.',
    permission: 'read-only',
    timeoutMs: 45000,
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Application name.' },
        window_id: { type: 'string', description: 'Specific window id.' },
        surface: { type: 'string', enum: surfaceValues },
        root: { type: 'string', description: 'Qualified ref to drill into.' },
        interactive_only: { type: 'boolean' },
        compact: { type: 'boolean' },
        skeleton: { type: 'boolean' },
        include_bounds: { type: 'boolean' },
        max_depth: { type: 'integer' },
        timeout_ms: { type: 'integer' },
      },
      required: [],
    },
    argumentsSchema: snapshotSchema,
    execute: async (rawArgs: unknown, context) => {
      const args = snapshotSchema.parse(rawArgs);
      const snapshot = await client.snapshot(
        {
          app: args.app,
          windowId: args.window_id,
          surface: args.surface,
          root: args.root,
          interactiveOnly: args.interactive_only ?? true,
          compact: args.compact ?? true,
          skeleton: args.skeleton,
          includeBounds: args.include_bounds,
          maxDepth: args.max_depth,
          timeoutMs: args.timeout_ms,
        },
        { signal: context.signal },
      );

      return {
        backend: 'agent-desktop',
        snapshot,
        refs: `Refs belong to snapshot ${snapshot.snapshot_id}. Re-snapshot after any UI change.`,
      };
    },
  });

  const findSchema = z
    .object({
      app: z.string().trim().min(1).max(200).optional().describe('Application name.'),
      window_id: z
        .string()
        .regex(/^w-\d+$/)
        .optional()
        .describe('Specific window id from desktop_ax_list_windows.'),
      surface: z.enum(surfaceValues).optional().describe('Surface to search.'),
      root: refSchema.optional().describe('Search inside this subtree only.'),
      role: z.string().trim().min(1).max(100).optional().describe('Accessibility role.'),
      name: z.string().trim().min(1).max(500).optional().describe('Accessible name.'),
      text: z.string().trim().min(1).max(500).optional().describe('Visible text.'),
      value: z.string().trim().min(1).max(500).optional().describe('Current value.'),
      description: z.string().trim().min(1).max(500).optional().describe('Accessible description.'),
      native_id: z.string().trim().min(1).max(500).optional().describe('Native automation id.'),
      exact: z.boolean().optional().describe('Require exact case-insensitive matches.'),
      first: z.boolean().optional().describe('Return only the first match.'),
      limit: z.number().int().min(1).max(100).optional().describe('Maximum matches (default 20).'),
      timeout_ms: z.number().int().min(1000).max(30000).optional().describe('Search deadline.'),
    })
    .superRefine((value, context) => {
      if (
        value.role === undefined &&
        value.name === undefined &&
        value.text === undefined &&
        value.value === undefined &&
        value.description === undefined &&
        value.native_id === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Provide at least one of role, name, text, value, description, or native_id.',
        });
      }

      if (value.root !== undefined && value.surface !== undefined) {
        context.addIssue({
          code: 'custom',
          message: 'root cannot be combined with surface.',
        });
      }
    });
  tools.push({
    name: 'desktop_ax_find',
    description:
      'Find accessibility elements by role, name, text, value, description, or native automation id. Returns qualified refs for actionable matches. Use this before a full snapshot when the target is known, and check that the match is unique before acting.',
    permission: 'read-only',
    timeoutMs: 45000,
    parameters: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        window_id: { type: 'string' },
        surface: { type: 'string', enum: surfaceValues },
        root: { type: 'string' },
        role: { type: 'string' },
        name: { type: 'string' },
        text: { type: 'string' },
        value: { type: 'string' },
        description: { type: 'string' },
        native_id: { type: 'string' },
        exact: { type: 'boolean' },
        first: { type: 'boolean' },
        limit: { type: 'integer' },
        timeout_ms: { type: 'integer' },
      },
      required: [],
    },
    argumentsSchema: findSchema,
    execute: async (rawArgs: unknown, context) => {
      const args = findSchema.parse(rawArgs);
      const result = await client.find(
        {
          app: args.app,
          windowId: args.window_id,
          surface: args.surface,
          root: args.root,
          role: args.role,
          name: args.name,
          text: args.text,
          value: args.value,
          description: args.description,
          nativeId: args.native_id,
          exact: args.exact,
          first: args.first,
          limit: args.limit ?? 20,
          timeoutMs: args.timeout_ms,
        },
        { signal: context.signal },
      );

      return { backend: 'agent-desktop', result };
    },
  });

  const readSchema = z.object({
    ref: refSchema.describe('Qualified ref from a fresh snapshot.'),
    property: z.enum(readProperties).describe('Property or state to read.'),
  });
  tools.push({
    name: 'desktop_ax_read',
    description:
      'Read one live property or state from an accessibility ref: text, value, title, bounds, role, states, visible, enabled, checked, focused, expanded, or selected. Use a fresh read to verify an action; a stale ref must be re-snapshotted.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Qualified ref.' },
        property: { type: 'string', enum: readProperties },
      },
      required: ['ref', 'property'],
    },
    argumentsSchema: readSchema,
    execute: async (rawArgs: unknown, context) => {
      const args = readSchema.parse(rawArgs);
      const isState = isStateProperty(args.property);
      const result = isState
        ? await client.is(args.ref, args.property as AgentDesktopStateProperty, {
            signal: context.signal,
          })
        : await client.get(args.ref, args.property as AgentDesktopReadProperty, {
            signal: context.signal,
          });

      return {
        backend: 'agent-desktop',
        ref: args.ref,
        property: args.property,
        kind: isState ? 'state' : 'property',
        result,
      };
    },
  });

  const actionSchema = z
    .object({
      action: z.enum(refActions).describe('Accessibility action to perform.'),
      ref: refSchema.optional().describe('Qualified ref for ref-based actions.'),
      text: z
        .string()
        .max(131072)
        .optional()
        .describe('Text for set_value or type. Prefer set_value when supported.'),
      key: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe('Key combo for press, such as return, escape, tab, or ctrl+c.'),
      app: z.string().trim().min(1).max(200).optional().describe('Target app for press.'),
      window_id: z
        .string()
        .regex(/^w-\d+$/)
        .optional()
        .describe('Target window id for press.'),
      timeout_ms: z
        .number()
        .int()
        .min(500)
        .max(30000)
        .optional()
        .describe('Action timeout in milliseconds.'),
    })
    .superRefine((value, context) => {
      if (value.action === 'set_value' || value.action === 'type') {
        if (value.ref === undefined) {
          context.addIssue({ code: 'custom', message: 'ref is required for text actions.' });
        }

        if (value.text === undefined) {
          context.addIssue({ code: 'custom', message: 'text is required for text actions.' });
        }
      } else if (value.action === 'press') {
        if (value.key === undefined) {
          context.addIssue({ code: 'custom', message: 'key is required for press.' });
        }

        if (value.app === undefined && value.window_id === undefined) {
          context.addIssue({
            code: 'custom',
            message: 'app or window_id is required for press.',
          });
        }
      } else if (value.ref === undefined) {
        context.addIssue({ code: 'custom', message: 'ref is required for this action.' });
      }
    });
  tools.push({
    name: 'desktop_ax_action',
    description:
      'Perform one accessibility action: click, toggle, check, uncheck, expand, collapse, set_value, type, clear, or press a key. Ref actions are semantic and headless; type uses physical headed input on Windows, so prefer set_value when available. Never retry an action unless its error says retry=safe; re-observe after every action.',
    permission: 'read-only',
    timeoutMs: 60000,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: refActions },
        ref: { type: 'string' },
        text: { type: 'string' },
        key: { type: 'string' },
        app: { type: 'string' },
        window_id: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['action'],
    },
    argumentsSchema: actionSchema,
    execute: async (rawArgs: unknown, context) => {
      const args = actionSchema.parse(rawArgs);

      if (args.action === 'press') {
        if (args.key === undefined) {
          throw new Error('key is required for press.');
        }

        const result = await client.press({
          combo: args.key,
          app: args.app,
          windowId: args.window_id,
          signal: context.signal,
        });

        return {
          backend: 'agent-desktop',
          action: args.action,
          key: args.key,
          result,
        };
      }

      const result = await client.act({
        action: args.action === 'set_value' ? 'set-value' : args.action,
        ref: args.ref ?? '',
        text: args.text,
        timeoutMs: args.timeout_ms,
        signal: context.signal,
      });

      return {
        backend: 'agent-desktop',
        action: args.action,
        ref: args.ref ?? null,
        result,
      };
    },
  });

  const waitSchema = z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('delay'),
      ms: z.number().int().min(0).max(5000).describe('Milliseconds to wait.'),
    }),
    z.object({
      mode: z.literal('element'),
      ref: refSchema.describe('Element ref to wait for.'),
      predicate: z
        .enum(['exists', 'enabled', 'visible', 'actionable', 'value'])
        .optional()
        .describe('Condition to satisfy (default exists).'),
      value: z.string().max(1000).optional().describe('Expected value for predicate=value.'),
      app: z.string().trim().min(1).max(200).optional().describe('Optional app scope.'),
      timeout_ms: z.number().int().min(250).max(60000).optional().describe('Wait budget.'),
    }),
    z.object({
      mode: z.literal('window'),
      window_title: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe('Window title substring to wait for.'),
      timeout_ms: z.number().int().min(250).max(60000).optional().describe('Wait budget.'),
    }),
    z.object({
      mode: z.literal('text'),
      text: z.string().trim().min(1).max(500).describe('Text to wait for.'),
      app: z.string().trim().min(1).max(200).optional().describe('Optional app scope.'),
      count: z.number().int().min(1).max(100).optional().describe('Expected match count.'),
      timeout_ms: z.number().int().min(250).max(60000).optional().describe('Wait budget.'),
    }),
    z.object({
      mode: z.literal('menu'),
      state: z.enum(['open', 'closed']).describe('Wait for a menu to open or close.'),
      app: z.string().trim().min(1).max(200).optional().describe('Optional app scope.'),
      timeout_ms: z.number().int().min(250).max(60000).optional().describe('Wait budget.'),
    }),
    z.object({
      mode: z.literal('event'),
      event: z.enum([
        'window-opened',
        'window-closed',
        'app-launched',
        'app-terminated',
        'focus-changed',
        'surface-appeared',
        'surface-dismissed',
      ]),
      window_id: z
        .string()
        .regex(/^w-\d+$/)
        .optional()
        .describe('Optional window id filter.'),
      timeout_ms: z.number().int().min(250).max(60000).optional().describe('Wait budget.'),
    }),
  ]);
  tools.push({
    name: 'desktop_ax_wait',
    description:
      'Wait for an element, window, text, menu state, desktop event, or a short delay using agent-desktop rather than a fixed sleep. Use this to verify that an expected UI state actually appeared.',
    permission: 'read-only',
    timeoutMs: 70000,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['delay', 'element', 'window', 'text', 'menu', 'event'] },
        ms: { type: 'integer' },
        ref: { type: 'string' },
        predicate: {
          type: 'string',
          enum: ['exists', 'enabled', 'visible', 'actionable', 'value'],
        },
        value: { type: 'string' },
        window_title: { type: 'string' },
        text: { type: 'string' },
        app: { type: 'string' },
        count: { type: 'integer' },
        state: { type: 'string', enum: ['open', 'closed'] },
        event: {
          type: 'string',
          enum: [
            'window-opened',
            'window-closed',
            'app-launched',
            'app-terminated',
            'focus-changed',
            'surface-appeared',
            'surface-dismissed',
          ],
        },
        window_id: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['mode'],
    },
    argumentsSchema: waitSchema,
    execute: async (rawArgs: unknown, context) => {
      const args = waitSchema.parse(rawArgs);

      if (args.mode === 'delay') {
        return {
          backend: 'agent-desktop',
          mode: args.mode,
          result: await client.wait({ mode: 'delay', ms: args.ms, signal: context.signal }),
        };
      }

      if (args.mode === 'element') {
        if (args.predicate === 'value' && args.value === undefined) {
          throw new Error('value is required when predicate is value.');
        }

        return {
          backend: 'agent-desktop',
          mode: args.mode,
          result: await client.wait({
            mode: 'element',
            ref: args.ref,
            predicate: args.predicate,
            value: args.value,
            app: args.app,
            timeoutMs: args.timeout_ms,
            signal: context.signal,
          }),
        };
      }

      if (args.mode === 'window') {
        return {
          backend: 'agent-desktop',
          mode: args.mode,
          result: await client.wait({
            mode: 'window',
            title: args.window_title,
            timeoutMs: args.timeout_ms,
            signal: context.signal,
          }),
        };
      }

      if (args.mode === 'text') {
        return {
          backend: 'agent-desktop',
          mode: args.mode,
          result: await client.wait({
            mode: 'text',
            text: args.text,
            app: args.app,
            count: args.count,
            timeoutMs: args.timeout_ms,
            signal: context.signal,
          }),
        };
      }

      if (args.mode === 'menu') {
        return {
          backend: 'agent-desktop',
          mode: args.mode,
          result: await client.wait({
            mode: 'menu',
            state: args.state,
            app: args.app,
            timeoutMs: args.timeout_ms,
            signal: context.signal,
          }),
        };
      }

      return {
        backend: 'agent-desktop',
        mode: args.mode,
        result: await client.wait({
          mode: 'event',
          event: args.event,
          windowId: args.window_id,
          timeoutMs: args.timeout_ms,
          signal: context.signal,
        }),
      };
    },
  });

  return tools;
}

function isStateProperty(
  property: (typeof readProperties)[number],
): property is AgentDesktopStateProperty {
  return (
    property === 'visible' ||
    property === 'enabled' ||
    property === 'checked' ||
    property === 'focused' ||
    property === 'expanded' ||
    property === 'selected'
  );
}
