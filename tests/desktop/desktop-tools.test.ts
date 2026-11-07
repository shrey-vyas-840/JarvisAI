import { describe, it, expect, vi } from 'vitest';

import { createDesktopTools } from '../../src/tools/desktop/index.js';
import type { DesktopManager } from '../../src/desktop/desktop-manager.js';
import type { AppConfig } from '../../src/config.js';
import type { ToolExecutionContext } from '../../src/core/tool-registry.js';

describe('Windows Desktop Automation Tools', () => {
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

  const mockDesktopManager: Partial<DesktopManager> = {
    listWindows: vi.fn().mockResolvedValue([
      {
        handle: 12345,
        title: 'Untitled - Notepad',
        process_id: 9999,
        class_name: 'Notepad',
        backend: 'uia',
        rect: { left: 100, top: 100, right: 600, bottom: 500, width: 500, height: 400 },
      },
    ]),
    inspectWindow: vi.fn().mockResolvedValue({
      handle: 12345,
      title: 'Untitled - Notepad',
      process_id: 9999,
      class_name: 'Notepad',
      backend: 'uia',
      rect: { left: 100, top: 100, right: 600, bottom: 500, width: 500, height: 400 },
    }),
    typeText: vi.fn().mockResolvedValue({ typed: true, length: 11 }),
    launchApplication: vi
      .fn()
      .mockResolvedValue({ launched: true, application: 'notepad', pid: 1234 }),
  };

  it('registers all 13 desktop automation tools', () => {
    const tools = createDesktopTools({
      desktopManager: mockDesktopManager as DesktopManager,
      config: mockConfig,
    });

    expect(tools.length).toBe(13);
    const names = new Set(tools.map((t) => t.name));

    expect(names.has('desktop_list_windows')).toBe(true);
    expect(names.has('desktop_inspect_window')).toBe(true);
    expect(names.has('desktop_focus_window')).toBe(true);
    expect(names.has('desktop_get_controls')).toBe(true);
    expect(names.has('desktop_click_control')).toBe(true);
    expect(names.has('desktop_type_text')).toBe(true);
    expect(names.has('desktop_press_key')).toBe(true);
    expect(names.has('desktop_scroll')).toBe(true);
    expect(names.has('desktop_mouse_click')).toBe(true);
    expect(names.has('desktop_mouse_move')).toBe(true);
    expect(names.has('desktop_mouse_drag')).toBe(true);
    expect(names.has('desktop_capture_screenshot')).toBe(true);
    expect(names.has('desktop_launch_application')).toBe(true);
  });

  it('enforces strict application allowlist in desktop_launch_application', async () => {
    const tools = createDesktopTools({
      desktopManager: mockDesktopManager as DesktopManager,
      config: mockConfig,
    });
    const launchTool = tools.find((t) => t.name === 'desktop_launch_application');
    expect(launchTool).toBeDefined();
    if (!launchTool) return;

    const fakeContext = {} as ToolExecutionContext;
    const res = (await launchTool.execute({ name: 'notepad' }, fakeContext)) as {
      launched: boolean;
    };
    expect(res.launched).toBe(true);

    // Disallowed application throws schema validation error
    await expect(launchTool.execute({ name: 'cmd.exe' }, fakeContext)).rejects.toThrow();
    await expect(launchTool.execute({ name: 'powershell' }, fakeContext)).rejects.toThrow();
  });
});
