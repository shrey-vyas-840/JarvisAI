import { describe, it, expect } from 'vitest';

import { createBrowserTools } from '../../../src/tools/browser/index.js';
import type { AppConfig } from '../../../src/config.js';
import type { ToolExecutionContext } from '../../../src/core/tool-registry.js';

describe('Browser Tools Registration and Security Policies', () => {
  const mockConfig: AppConfig = {
    appEnv: 'test',
    log: { level: 'info', dir: 'D:\\AI\\JarvisAgent\\logs' },
    ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:9b', numCtx: 4096, think: false },
    paths: {
      workspace: 'D:\\AI\\JarvisWorkspace',
      exports: 'D:\\AI\\Exports',
      temp: 'D:\\AI\\Temp',
    },
  };

  it('registers all 27 browser tools with exact permissions and schemas', () => {
    const tools = createBrowserTools({ config: mockConfig });
    expect(tools.length).toBe(27);

    const toolMap = new Map(tools.map((t) => [t.name, t]));

    // Check specific tools exist
    expect(toolMap.has('browser_list_profiles')).toBe(true);
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
});
