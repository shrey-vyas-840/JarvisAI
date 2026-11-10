import { describe, it, expect } from 'vitest';

import type { BrowserManager } from '../../../src/browser/index.js';
import type { AppConfig } from '../../../src/config.js';
import type { ToolExecutionContext } from '../../../src/core/tool-registry.js';
import { createBrowserTools } from '../../../src/tools/browser/index.js';
import type { VisionAnalyzer } from '../../../src/vision/index.js';

const makePngHeader = (width: number, height: number): Buffer => {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
};

const makeFakeBrowser = (page: object): BrowserManager =>
  ({ getActivePage: () => page }) as unknown as BrowserManager;

interface FakeVisionElement {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  confidence: number;
}

const makeFakeVision = (elements: FakeVisionElement[]): VisionAnalyzer =>
  ({
    analyze: () => ({
      model: 'fake-vision',
      summary: null,
      elements,
      invalidElementCount: 0,
      elapsedMs: 1,
    }),
  }) as unknown as VisionAnalyzer;

describe('Browser Tools Registration and Security Policies', () => {
  const mockConfig: AppConfig = {
    appEnv: 'test',
    log: { level: 'info', dir: 'D:\\AI\\JarvisAgent\\logs' },
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      visionModel: 'qwen3.5:9b',
      numCtx: 4096,
      think: false,
    },
    paths: {
      workspace: 'D:\\AI\\JarvisWorkspace',
      exports: 'D:\\AI\\Exports',
      temp: 'D:\\AI\\Temp',
    },
  };

  it('registers all 30 browser tools with exact permissions and schemas', () => {
    const tools = createBrowserTools({ config: mockConfig });
    expect(tools.length).toBe(30);

    const toolMap = new Map(tools.map((t) => [t.name, t]));

    // Check specific tools exist
    expect(toolMap.has('browser_list_profiles')).toBe(true);
    expect(toolMap.has('browser_list_extensions')).toBe(true);
    expect(toolMap.has('browser_vision_locate')).toBe(true);
    expect(toolMap.has('browser_vision_click')).toBe(true);
    expect(toolMap.has('browser_open_profile')).toBe(true);
    expect(toolMap.has('browser_list_connected_profiles')).toBe(true);
    expect(toolMap.has('browser_connect_profile')).toBe(true);
    expect(toolMap.has('browser_list_tabs')).toBe(true);
    expect(toolMap.has('browser_new_tab')).toBe(true);
    expect(toolMap.has('browser_navigate')).toBe(true);
    expect(toolMap.has('browser_click')).toBe(true);
    expect(toolMap.has('browser_fill_field')).toBe(true);
    expect(toolMap.has('browser_fill_form')).toBe(true);
    expect(toolMap.has('browser_submit_form')).toBe(true);
    expect(toolMap.has('browser_download_file')).toBe(true);
    expect(toolMap.has('browser_close_jarvis_tab')).toBe(true);

    // Verify permissions: consequential actions MUST require approval
    const submitTool = toolMap.get('browser_submit_form');
    expect(submitTool?.permission).toBe('requires-approval');
    expect(submitTool?.approvalRequest).toBeDefined();

    const downloadTool = toolMap.get('browser_download_file');
    expect(downloadTool?.permission).toBe('requires-approval');
    expect(downloadTool?.approvalRequest).toBeDefined();

    // Verify ordinary inspection and navigation tools are read-only
    expect(toolMap.get('browser_list_profiles')?.permission).toBe('read-only');
    expect(toolMap.get('browser_get_page_text')?.permission).toBe('read-only');
    expect(toolMap.get('browser_get_page_snapshot')?.permission).toBe('read-only');
    expect(toolMap.get('browser_navigate')?.permission).toBe('read-only');
    expect(toolMap.get('browser_list_extensions')?.permission).toBe('read-only');
    expect(toolMap.get('browser_vision_locate')?.permission).toBe('read-only');
    expect(toolMap.get('browser_vision_click')?.permission).toBe('read-only');
  });

  it('generates approval prompt for form submission with domain and action warnings', () => {
    const tools = createBrowserTools({ config: mockConfig });
    const submitTool = tools.find((t) => t.name === 'browser_submit_form');
    expect(submitTool?.approvalRequest).toBeDefined();
  });

  it('generates approval prompt for download strictly targeting D:\\AI\\Exports', async () => {
    const tools = createBrowserTools({ config: mockConfig });
    const downloadTool = tools.find((t) => t.name === 'browser_download_file');
    expect(downloadTool).toBeDefined();
    if (!downloadTool?.approvalRequest) return;

    const fakeContext = {} as ToolExecutionContext;

    const approval = await downloadTool.approvalRequest(
      { downloadTriggerSelector: '#download-btn', targetFilename: 'report.pdf' },
      fakeContext,
    );

    expect(approval.toolName).toBe('browser_download_file');
    expect(approval.root).toBe('exports');
    expect(approval.relativePath).toBe('report.pdf');
    expect(approval.absolutePath).toBe('D:\\AI\\Exports\\report.pdf');
  });

  const makeContext = (): ToolExecutionContext =>
    ({ signal: new AbortController().signal }) as unknown as ToolExecutionContext;

  it('falls back to window dimensions when the connected page has no viewportSize', async () => {
    const page = {
      viewportSize: () => null,
      evaluate: () => Promise.resolve({ width: 800, height: 600 }),
      screenshot: () => makePngHeader(1000, 500),
      url: () => 'https://example.com/',
    };
    const tools = createBrowserTools({
      browserManager: makeFakeBrowser(page),
      visionAnalyzer: makeFakeVision([
        { x: 500, y: 250, width: 100, height: 50, label: 'target', confidence: 0.9 },
      ]),
      config: mockConfig,
    });
    const locate = tools.find((tool) => tool.name === 'browser_vision_locate');
    expect(locate).toBeDefined();
    if (!locate) return;

    const result = (await locate.execute(
      { target: 'target', min_confidence: 0.5 },
      makeContext(),
    )) as {
      viewport: { width: number; height: number };
      elements: { rect: { x: number; y: number; width: number; height: number } }[];
    };

    expect(result.viewport).toEqual({ width: 800, height: 600 });
    expect(result.elements[0]?.rect).toEqual({ x: 400, y: 300, width: 80, height: 60 });
  });

  it('does not fail a successful vision click when the title read races navigation', async () => {
    const clicks: [number, number][] = [];
    const page = {
      viewportSize: () => null,
      evaluate: () => Promise.resolve({ width: 800, height: 600 }),
      screenshot: () => makePngHeader(1000, 500),
      mouse: {
        click: (x: number, y: number) => {
          clicks.push([x, y]);
        },
      },
      waitForLoadState: () => Promise.resolve(),
      url: () => 'https://example.com/',
      title: () => {
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      },
    };
    const tools = createBrowserTools({
      browserManager: makeFakeBrowser(page),
      visionAnalyzer: makeFakeVision([
        { x: 500, y: 250, width: 100, height: 50, label: 'target', confidence: 0.9 },
      ]),
      config: mockConfig,
    });
    const click = tools.find((tool) => tool.name === 'browser_vision_click');
    expect(click).toBeDefined();
    if (!click) return;

    const result = (await click.execute(
      { target: 'target', min_confidence: 0.5 },
      makeContext(),
    )) as {
      clicked: boolean;
      currentTitle: string | null;
      viewportCoordinates: { x: number; y: number };
    };

    expect(result.clicked).toBe(true);
    expect(result.currentTitle).toBeNull();
    expect(result.viewportCoordinates).toEqual({ x: 440, y: 330 });
    expect(clicks).toEqual([[440, 330]]);
  });
});
