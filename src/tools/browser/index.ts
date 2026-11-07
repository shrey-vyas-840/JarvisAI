import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
  BrowserManager,
  discoverChromeProfiles,
  launchChromeProfile,
} from '../../browser/index.js';
import {
  extractPageSnapshot,
  extractPageText,
  findTextOnPage,
} from '../../browser/dom-extractor.js';
import { validateBrowserUrl } from '../../browser/url-guard.js';
import type { AppConfig } from '../../config.js';
import type { ToolDefinition } from '../../core/tool-registry.js';
import type { ApprovalRequest } from '../../security/approval-types.js';

export interface BrowserToolsOptions {
  readonly browserManager?: BrowserManager;
  readonly config: AppConfig;
}

export function createBrowserTools(options: BrowserToolsOptions): ToolDefinition[] {
  const browser = options.browserManager ?? new BrowserManager();
  const config = options.config;

  const tools: ToolDefinition[] = [];

  // 1. browser_list_profiles
  tools.push({
    name: 'browser_list_profiles',
    description:
      'List available Chrome profiles on this PC, including their display names, directory identifiers, email accounts, and whether the Playwriter extension is installed.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    argumentsSchema: z.object({}),
    execute: () => {
      const result = discoverChromeProfiles();
      return {
        executablePath: result.executablePath,
        userDataDir: result.userDataDir,
        isChromeRunning: result.isChromeRunning,
        profiles: result.profiles.map((p) => ({
          directory: p.directory,
          name: p.name,
          email: p.email ?? null,
          hasPlaywriterExtension: p.hasPlaywriterExtension,
          isChromeRunning: p.isChromeRunning,
        })),
      };
    },
  });

  // 2. browser_open_profile
  const openProfileSchema = z.object({
    profileDirectory: z
      .string()
      .min(1)
      .describe('The profile directory identifier, e.g. "Default", "Profile 1", "Profile 4"'),
  });
  tools.push({
    name: 'browser_open_profile',
    description:
      'Launch Chrome with a specific user profile directory. Use this when Chrome is not yet running with the desired profile.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        profileDirectory: {
          type: 'string',
          description: 'The profile directory identifier, e.g. "Profile 4" or "Default"',
        },
      },
      required: ['profileDirectory'],
    },
    argumentsSchema: openProfileSchema,
    execute: (rawArgs: unknown) => {
      const args = openProfileSchema.parse(rawArgs);
      const launchResult = launchChromeProfile(args.profileDirectory);
      if (!launchResult.success) {
        throw new Error(
          `Failed to launch Chrome profile "${args.profileDirectory}": ${launchResult.error ?? 'unknown error'}`,
        );
      }
      return {
        launched: true,
        profileDirectory: launchResult.profileDirectory,
        executablePath: launchResult.executablePath,
        pid: launchResult.pid,
        instructions:
          'Chrome launched. If the Playwriter extension is not yet active on the target tab, please ensure it is clicked/enabled in Chrome.',
      };
    },
  });

  // 3. browser_list_connected_profiles
  tools.push({
    name: 'browser_list_connected_profiles',
    description:
      'Check which Chrome profiles currently have an active Playwriter extension connection to the local relay at 127.0.0.1:19988.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    argumentsSchema: z.object({}),
    execute: async () => {
      const connected = await browser.listConnectedProfiles();
      return {
        connectedProfiles: connected.map((c) => ({
          id: c.id,
          browser: c.browser,
          email: c.email,
          activeTabs: c.activeTabs,
          playwriterVersion: c.playwriterVersion,
        })),
      };
    },
  });

  // 4. browser_connect_profile
  const connectProfileSchema = z.object({
    profileIdOrEmail: z
      .string()
      .optional()
      .describe(
        'Optional profile ID or email to connect to. If omitted, connects to the first available connected browser.',
      ),
  });
  tools.push({
    name: 'browser_connect_profile',
    description:
      'Connect JARVIS to the selected Chrome profile via the Playwriter extension. If multiple profiles are connected, you may specify profileIdOrEmail.',
    permission: 'read-only',
    timeoutMs: 20000,
    parameters: {
      type: 'object',
      properties: {
        profileIdOrEmail: {
          type: 'string',
          description: 'Optional profile ID or email address to connect to.',
        },
      },
      required: [],
    },
    argumentsSchema: connectProfileSchema,
    execute: async (rawArgs: unknown) => {
      const args = connectProfileSchema.parse(rawArgs);
      const profile = await browser.connect(args.profileIdOrEmail);
      return {
        connected: true,
        profile,
      };
    },
  });

  // 5. browser_list_tabs
  tools.push({
    name: 'browser_list_tabs',
    description:
      'List all open tabs in the connected Chrome profile, showing their tab index, title, URL, whether they are active, and whether they are owned by JARVIS.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    argumentsSchema: z.object({}),
    execute: async () => {
      const tabs = await browser.listTabs();
      return { tabs };
    },
  });

  // 6. browser_new_tab
  const newTabSchema = z.object({
    url: z
      .string()
      .optional()
      .describe('Initial URL to navigate to in the new tab. Defaults to "about:blank".'),
  });
  tools.push({
    name: 'browser_new_tab',
    description:
      'Create a new tab in the connected Chrome profile under the "jarvis" tab group. JARVIS can safely operate and close this tab.',
    permission: 'read-only',
    timeoutMs: 30000,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Initial URL to navigate to (optional).',
        },
      },
      required: [],
    },
    argumentsSchema: newTabSchema,
    execute: async (rawArgs: unknown) => {
      const args = newTabSchema.parse(rawArgs);
      let targetUrl = 'about:blank';
      if (args.url && args.url !== 'about:blank') {
        const validation = validateBrowserUrl(args.url);
        if (!validation.valid || !validation.sanitizedUrl) {
          throw new Error(validation.error ?? 'Invalid URL');
        }
        targetUrl = validation.sanitizedUrl;
      }

      const tab = await browser.newTab(targetUrl);
      return {
        created: true,
        tab,
      };
    },
  });

  // 7. browser_switch_tab
  const switchTabSchema = z.object({
    tabIndex: z
      .number()
      .int()
      .min(0)
      .describe('Zero-based index of the tab to bring to front and activate.'),
  });
  tools.push({
    name: 'browser_switch_tab',
    description: 'Switch the active tab in the browser context by its index.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        tabIndex: {
          type: 'integer',
          description: 'Zero-based tab index to switch to.',
        },
      },
      required: ['tabIndex'],
    },
    argumentsSchema: switchTabSchema,
    execute: async (rawArgs: unknown) => {
      const args = switchTabSchema.parse(rawArgs);
      const tab = await browser.switchTab(args.tabIndex);
      return { switched: true, activeTab: tab };
    },
  });

  // 8. browser_close_jarvis_tab
  const closeTabSchema = z.object({
    tabIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Optional tab index to close. If omitted, closes current JARVIS active tab.'),
  });
  tools.push({
    name: 'browser_close_jarvis_tab',
    description:
      'Close a tab created and owned by JARVIS. Security restriction: will reject any attempt to close existing user tabs.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        tabIndex: {
          type: 'integer',
          description: 'Tab index to close (must be a JARVIS-created tab).',
        },
      },
      required: [],
    },
    argumentsSchema: closeTabSchema,
    execute: async (rawArgs: unknown) => {
      const args = closeTabSchema.parse(rawArgs);
      return browser.closeJarvisTab(args.tabIndex);
    },
  });

  // 9. browser_navigate
  const navigateSchema = z.object({
    url: z.string().min(1).describe('The HTTP or HTTPS URL to navigate to.'),
  });
  tools.push({
    name: 'browser_navigate',
    description:
      'Navigate the active tab to an HTTP or HTTPS URL. Rejects dangerous URL schemes (javascript:, file:, data:, vbscript:) and unauthorized private/local network access.',
    permission: 'read-only',
    timeoutMs: 35000,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Target HTTP or HTTPS URL.',
        },
      },
      required: ['url'],
    },
    argumentsSchema: navigateSchema,
    execute: async (rawArgs: unknown) => {
      const args = navigateSchema.parse(rawArgs);
      const validation = validateBrowserUrl(args.url);
      if (!validation.valid || !validation.sanitizedUrl) {
        throw new Error(validation.error ?? 'Invalid URL');
      }

      return browser.navigate(validation.sanitizedUrl);
    },
  });

  // 10. browser_go_back
  tools.push({
    name: 'browser_go_back',
    description: 'Navigate back in the active tab history.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: async () => {
      const page = browser.getActivePage();
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return { url: page.url(), title: await page.title() };
    },
  });

  // 11. browser_go_forward
  tools.push({
    name: 'browser_go_forward',
    description: 'Navigate forward in the active tab history.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: async () => {
      const page = browser.getActivePage();
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return { url: page.url(), title: await page.title() };
    },
  });

  // 12. browser_reload
  tools.push({
    name: 'browser_reload',
    description: 'Reload the current page in the active tab.',
    permission: 'read-only',
    timeoutMs: 20000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: async () => {
      const page = browser.getActivePage();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
      return { url: page.url(), title: await page.title() };
    },
  });

  // 13. browser_get_page_snapshot
  tools.push({
    name: 'browser_get_page_snapshot',
    description:
      'Retrieve the accessibility tree / ARIA snapshot of the current page. This gives the semantic structure, roles, names, and interactive elements of the webpage.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: async () => {
      const page = browser.getActivePage();
      return extractPageSnapshot(page);
    },
  });

  // 14. browser_get_page_text
  const pageTextSchema = z.object({
    maxLength: z
      .number()
      .int()
      .min(100)
      .max(100000)
      .optional()
      .describe('Maximum number of characters to return (default: 30000).'),
  });
  tools.push({
    name: 'browser_get_page_text',
    description:
      'Extract readable text content from the current webpage body. Output is bounded and reports truncation honestly.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        maxLength: {
          type: 'integer',
          description: 'Maximum characters to return (default 30000).',
        },
      },
      required: [],
    },
    argumentsSchema: pageTextSchema,
    execute: async (rawArgs: unknown) => {
      const args = pageTextSchema.parse(rawArgs);
      const page = browser.getActivePage();
      return extractPageText(page, args.maxLength);
    },
  });

  // 15. browser_get_page_title
  tools.push({
    name: 'browser_get_page_title',
    description: 'Get the title of the current webpage.',
    permission: 'read-only',
    timeoutMs: 5000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: async () => {
      const page = browser.getActivePage();
      return { title: await page.title() };
    },
  });

  // 16. browser_get_page_url
  tools.push({
    name: 'browser_get_page_url',
    description: 'Get the URL of the current webpage.',
    permission: 'read-only',
    timeoutMs: 5000,
    parameters: { type: 'object', properties: {}, required: [] },
    argumentsSchema: z.object({}),
    execute: () => {
      const page = browser.getActivePage();
      return { url: page.url() };
    },
  });

  // 17. browser_find_text
  const findTextSchema = z.object({
    query: z.string().min(1).describe('The text substring to search for on the page.'),
  });
  tools.push({
    name: 'browser_find_text',
    description: 'Search for text occurrences and matching snippets on the current webpage.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text string to find.',
        },
      },
      required: ['query'],
    },
    argumentsSchema: findTextSchema,
    execute: async (rawArgs: unknown) => {
      const args = findTextSchema.parse(rawArgs);
      const page = browser.getActivePage();
      return findTextOnPage(page, args.query);
    },
  });

  // 18. browser_click
  const clickSchema = z.object({
    selector: z
      .string()
      .min(1)
      .describe(
        'Playwright selector, text, or accessibility locator to click (e.g. "button:has-text(\'Search\')", "a[href*=\'about\']", "text=Submit").',
      ),
  });
  tools.push({
    name: 'browser_click',
    description:
      'Click an element on the current webpage identified by selector, text, or role locator. Verifies the page state after clicking.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Locator or CSS selector for the element to click.',
        },
      },
      required: ['selector'],
    },
    argumentsSchema: clickSchema,
    execute: async (rawArgs: unknown) => {
      const args = clickSchema.parse(rawArgs);
      const page = browser.getActivePage();
      const locator = page.locator(args.selector).first();
      await locator.click({ timeout: 10000 });
      // Brief pause to allow DOM updates
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      return {
        clicked: true,
        selector: args.selector,
        currentUrl: page.url(),
        currentTitle: await page.title(),
      };
    },
  });

  // 19. browser_hover
  const hoverSchema = z.object({
    selector: z.string().min(1).describe('Locator or selector of the element to hover over.'),
  });
  tools.push({
    name: 'browser_hover',
    description: 'Hover mouse over an element on the current webpage.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Locator or selector to hover over.',
        },
      },
      required: ['selector'],
    },
    argumentsSchema: hoverSchema,
    execute: async (rawArgs: unknown) => {
      const args = hoverSchema.parse(rawArgs);
      const page = browser.getActivePage();
      await page.locator(args.selector).first().hover({ timeout: 8000 });
      return { hovered: true, selector: args.selector };
    },
  });

  // 20. browser_fill_field
  const fillFieldSchema = z.object({
    selector: z.string().min(1).describe('Locator or selector of the input field or textarea.'),
    value: z.string().describe('Value to fill into the field.'),
  });
  tools.push({
    name: 'browser_fill_field',
    description:
      'Type or fill text into an input or textarea field. Security rule: will reject filling password fields; password fields must be filled manually by the user.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Locator or selector of the input field.',
        },
        value: {
          type: 'string',
          description: 'Text value to fill.',
        },
      },
      required: ['selector', 'value'],
    },
    argumentsSchema: fillFieldSchema,
    execute: async (rawArgs: unknown) => {
      const args = fillFieldSchema.parse(rawArgs);
      const page = browser.getActivePage();
      const locator = page.locator(args.selector).first();

      const type = await locator.getAttribute('type').catch(() => null);
      if (type?.toLowerCase() === 'password') {
        throw new Error(
          'Security restriction: JARVIS is forbidden from filling password fields. Please complete password entry manually.',
        );
      }

      await locator.fill(args.value, { timeout: 10000 });
      const enteredValue = await locator.inputValue().catch(() => args.value);
      return {
        filled: true,
        selector: args.selector,
        valueLength: enteredValue.length,
      };
    },
  });

  // 21. browser_select_option
  const selectOptionSchema = z.object({
    selector: z.string().min(1).describe('Selector of the <select> element.'),
    value: z.string().min(1).describe('Option value or label to select.'),
  });
  tools.push({
    name: 'browser_select_option',
    description: 'Select an option in a dropdown or <select> control.',
    permission: 'read-only',
    timeoutMs: 10000,
    parameters: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'Selector of the select dropdown.',
        },
        value: {
          type: 'string',
          description: 'Option value or label.',
        },
      },
      required: ['selector', 'value'],
    },
    argumentsSchema: selectOptionSchema,
    execute: async (rawArgs: unknown) => {
      const args = selectOptionSchema.parse(rawArgs);
      const page = browser.getActivePage();
      const selected = await page
        .locator(args.selector)
        .first()
        .selectOption(args.value, { timeout: 8000 });
      return { selectedOptions: selected };
    },
  });

  // 22. browser_press_key
  const pressKeySchema = z.object({
    key: z
      .string()
      .min(1)
      .describe('Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown", "PageDown").'),
  });
  tools.push({
    name: 'browser_press_key',
    description: 'Send a keyboard keypress event to the active webpage.',
    permission: 'read-only',
    timeoutMs: 8000,
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Key name (e.g. "Enter", "Tab", "Escape").',
        },
      },
      required: ['key'],
    },
    argumentsSchema: pressKeySchema,
    execute: async (rawArgs: unknown) => {
      const args = pressKeySchema.parse(rawArgs);
      const page = browser.getActivePage();
      await page.keyboard.press(args.key);
      return { pressedKey: args.key };
    },
  });

  // 23. browser_scroll
  const scrollSchema = z.object({
    direction: z.enum(['down', 'up']).describe('Scroll direction.'),
    pixels: z
      .number()
      .int()
      .min(50)
      .max(5000)
      .optional()
      .describe('Number of pixels to scroll (default: 500).'),
  });
  tools.push({
    name: 'browser_scroll',
    description: 'Scroll the active webpage up or down.',
    permission: 'read-only',
    timeoutMs: 8000,
    parameters: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['down', 'up'],
          description: 'Direction to scroll.',
        },
        pixels: {
          type: 'integer',
          description: 'Pixels to scroll (default 500).',
        },
      },
      required: ['direction'],
    },
    argumentsSchema: scrollSchema,
    execute: async (rawArgs: unknown) => {
      const args = scrollSchema.parse(rawArgs);
      const page = browser.getActivePage();
      const deltaY = (args.direction === 'down' ? 1 : -1) * (args.pixels ?? 500);
      await page.mouse.wheel(0, deltaY);
      return { scrolled: true, direction: args.direction, pixels: Math.abs(deltaY) };
    },
  });

  // 24. browser_screenshot
  const screenshotSchema = z.object({
    filename: z
      .string()
      .optional()
      .describe('Optional filename for saving screenshot in D:\\AI\\Temp (e.g. "page.png").'),
  });
  tools.push({
    name: 'browser_screenshot',
    description: 'Capture a screenshot of the active browser page and save it into D:\\AI\\Temp.',
    permission: 'read-only',
    timeoutMs: 15000,
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Optional screenshot filename.',
        },
      },
      required: [],
    },
    argumentsSchema: screenshotSchema,
    execute: async (rawArgs: unknown) => {
      const args = screenshotSchema.parse(rawArgs);
      const page = browser.getActivePage();
      const tempDir = config.paths.temp;
      if (!existsSync(tempDir)) {
        mkdirSync(tempDir, { recursive: true });
      }

      const safeBaseName = (args.filename ?? `screenshot-${String(Date.now())}.png`).replace(
        /[^a-zA-Z0-9_.-]/g,
        '_',
      );
      const targetPath = path.join(
        tempDir,
        safeBaseName.endsWith('.png') ? safeBaseName : `${safeBaseName}.png`,
      );

      await page.screenshot({ path: targetPath, fullPage: false });
      return {
        captured: true,
        path: targetPath,
        url: page.url(),
      };
    },
  });

  // 25. browser_fill_form
  const fillFormSchema = z.object({
    formSelector: z.string().optional().describe('Optional CSS selector for the form.'),
    fieldValues: z
      .record(z.string(), z.string())
      .describe('Key-value pairs of field names/selectors and values to enter.'),
  });
  tools.push({
    name: 'browser_fill_form',
    description:
      'Fill ordinary form fields without submitting the form. Displays entered fields for review.',
    permission: 'read-only',
    timeoutMs: 25000,
    parameters: {
      type: 'object',
      properties: {
        formSelector: {
          type: 'string',
          description: 'Optional form selector.',
        },
        fieldValues: {
          type: 'object',
          description: 'Map of field names/selectors to values.',
        },
      },
      required: ['fieldValues'],
    },
    argumentsSchema: fillFormSchema,
    execute: async (rawArgs: unknown) => {
      const args = fillFormSchema.parse(rawArgs);
      const page = browser.getActivePage();
      const filled: Record<string, string> = {};

      for (const [fieldRef, val] of Object.entries(args.fieldValues)) {
        const locator = args.formSelector
          ? page
              .locator(args.formSelector)
              .locator(`[name="${fieldRef}"], #${fieldRef}, [aria-label="${fieldRef}"]`)
              .first()
          : page.locator(`[name="${fieldRef}"], #${fieldRef}, [aria-label="${fieldRef}"]`).first();

        const type = await locator.getAttribute('type').catch(() => null);
        if (type?.toLowerCase() === 'password') {
          throw new Error(
            `Security restriction: Field "${fieldRef}" is a password field. Password entry must be done manually.`,
          );
        }

        await locator.fill(val, { timeout: 5000 });
        filled[fieldRef] = val;
      }

      return {
        completed: true,
        filledFields: filled,
        reviewNotice:
          'Form fields have been filled. Form submission requires explicit user approval.',
      };
    },
  });

  // 26. browser_submit_form (Consequential -> Requires Approval)
  const submitFormSchema = z.object({
    formSelector: z.string().min(1).describe('CSS selector of the form to submit.'),
    submitButtonSelector: z
      .string()
      .optional()
      .describe('Optional selector of the submit button to click.'),
    intendedActionSummary: z
      .string()
      .min(5)
      .describe('Summary of the action and intended submission consequences.'),
  });
  tools.push({
    name: 'browser_submit_form',
    description:
      'Submit a web form. Consequential operation: requires explicit user approval describing the destination website, form action, and submission consequences.',
    permission: 'requires-approval',
    timeoutMs: 30000,
    parameters: {
      type: 'object',
      properties: {
        formSelector: {
          type: 'string',
          description: 'CSS selector of the form to submit.',
        },
        submitButtonSelector: {
          type: 'string',
          description: 'Optional submit button selector.',
        },
        intendedActionSummary: {
          type: 'string',
          description: 'Summary of the submission purpose and consequences.',
        },
      },
      required: ['formSelector', 'intendedActionSummary'],
    },
    argumentsSchema: submitFormSchema,
    approvalRequest: (rawArgs: unknown): ApprovalRequest => {
      const args = submitFormSchema.parse(rawArgs);
      const page = browser.getActivePage();
      const currentUrl = page.url();
      return {
        toolName: 'browser_submit_form',
        operation: 'Submit Web Form',
        action: `Submit form "${args.formSelector}" on "${currentUrl}"`,
        warning: `This action will submit external data to "${currentUrl}". Intended action: ${args.intendedActionSummary}`,
      };
    },
    execute: async (rawArgs: unknown) => {
      const args = submitFormSchema.parse(rawArgs);
      const page = browser.getActivePage();
      if (args.submitButtonSelector) {
        await page.locator(args.submitButtonSelector).first().click({ timeout: 10000 });
      } else {
        const form = page.locator(args.formSelector).first();
        const submitBtn = form
          .locator(
            'input[type="submit"], button[type="submit"], button:has-text("Submit"), button:has-text("Send")',
          )
          .first();
        const btnCount = await submitBtn.count().catch(() => 0);
        if (btnCount > 0) {
          await submitBtn.click({ timeout: 10000 });
        } else {
          await form.press('Enter');
        }
      }

      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
      return {
        submitted: true,
        resultingUrl: page.url(),
        resultingTitle: await page.title(),
      };
    },
  });

  // 27. browser_download_file (Consequential -> Requires Approval)
  const downloadFileSchema = z.object({
    downloadTriggerSelector: z
      .string()
      .min(1)
      .describe('Selector of the link or button that initiates the download.'),
    targetFilename: z
      .string()
      .min(1)
      .describe(
        'Safe destination filename inside D:\\AI\\Exports (no paths or directory traversal).',
      ),
  });
  tools.push({
    name: 'browser_download_file',
    description:
      'Download a file from the active webpage strictly into D:\\AI\\Exports. Consequential operation: requires explicit user approval before saving the file.',
    permission: 'requires-approval',
    timeoutMs: 60000,
    parameters: {
      type: 'object',
      properties: {
        downloadTriggerSelector: {
          type: 'string',
          description: 'Selector of the element that triggers the download.',
        },
        targetFilename: {
          type: 'string',
          description: 'Safe target filename inside D:\\AI\\Exports.',
        },
      },
      required: ['downloadTriggerSelector', 'targetFilename'],
    },
    argumentsSchema: downloadFileSchema,
    approvalRequest: (rawArgs: unknown): ApprovalRequest => {
      const args = downloadFileSchema.parse(rawArgs);
      const sanitized = path.basename(args.targetFilename.trim());
      const destPath = path.join(config.paths.exports, sanitized);
      return {
        toolName: 'browser_download_file',
        operation: 'Download File from Browser',
        root: 'exports',
        relativePath: sanitized,
        absolutePath: destPath,
        action: `Download and save file to "${destPath}"`,
        warning: 'This will download content from the active webpage and create a file in Exports.',
      };
    },
    execute: async (rawArgs: unknown) => {
      const args = downloadFileSchema.parse(rawArgs);
      const page = browser.getActivePage();
      const sanitized = path.basename(args.targetFilename.trim());
      if (sanitized !== args.targetFilename.trim() || sanitized.includes('..')) {
        throw new Error(
          'Security restriction: Filename cannot contain directory paths or traversal.',
        );
      }

      const exportsDir = config.paths.exports;
      if (!existsSync(exportsDir)) {
        mkdirSync(exportsDir, { recursive: true });
      }

      const destPath = path.join(exportsDir, sanitized);
      if (existsSync(destPath)) {
        throw new Error(
          `File "${sanitized}" already exists in Exports. Overwriting is prohibited.`,
        );
      }

      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.locator(args.downloadTriggerSelector).first().click({ timeout: 10000 }),
      ]);

      await download.saveAs(destPath);
      return {
        downloaded: true,
        sourceUrl: download.url(),
        savedPath: destPath,
        suggestedFilename: download.suggestedFilename(),
      };
    },
  });

  return tools;
}
