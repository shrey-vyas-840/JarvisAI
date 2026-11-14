import { describe, it, expect, vi } from 'vitest';

import { createDesktopTools } from '../../src/tools/desktop/index.js';
import type { DesktopManager } from '../../src/desktop/desktop-manager.js';
import type { AppConfig } from '../../src/config.js';
import type { ToolExecutionContext } from '../../src/core/tool-registry.js';

describe('Windows Desktop Automation Tools', () => {
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

  it('registers desktop tools including verified document targeting and read-back', () => {
    const tools = createDesktopTools({
      desktopManager: mockDesktopManager as DesktopManager,
      config: mockConfig,
    });

    expect(tools.length).toBe(20);
    const names = new Set(tools.map((t) => t.name));

    expect(names.has('desktop_get_screen_info')).toBe(true);
    expect(names.has('desktop_wait_for_window')).toBe(true);
    expect(names.has('desktop_vision_locate')).toBe(true);
    expect(names.has('desktop_vision_click')).toBe(true);
    expect(names.has('desktop_list_windows')).toBe(true);
    expect(names.has('desktop_inspect_window')).toBe(true);
    expect(names.has('desktop_focus_window')).toBe(true);
    expect(names.has('desktop_get_controls')).toBe(true);
    expect(names.has('desktop_click_control')).toBe(true);
    expect(names.has('desktop_type_text')).toBe(true);
    expect(names.has('desktop_set_control_value')).toBe(true);
    expect(names.has('desktop_read_document_text')).toBe(true);
    expect(names.has('desktop_close_verified_document')).toBe(true);
    expect(names.has('desktop_press_key')).toBe(true);
    expect(names.has('desktop_scroll')).toBe(true);
    expect(names.has('desktop_mouse_click')).toBe(true);
    expect(names.has('desktop_mouse_move')).toBe(true);
    expect(names.has('desktop_mouse_drag')).toBe(true);
    expect(names.has('desktop_capture_screenshot')).toBe(true);
    expect(names.has('desktop_launch_application')).toBe(true);
  });

  it('requires tab and editor identity plus exact preconditions for desktop text input', async () => {
    const typeText = vi.fn().mockResolvedValue({
      outcome: 'verified',
      backend: 'pywinauto',
      target: {
        window_handle: 12345,
        window_title: 'jarvis-test.txt - Notepad',
        tab_title: 'jarvis-test.txt. Unmodified.',
        control_type: 'Document',
        automation_id: '',
        runtime_id: [1, 2, 3],
      },
      delivery: 'dispatched',
      method: 'ValuePattern.SetValue',
      read_pattern: 'TextPattern',
      expected_character_count: 5,
      actual_character_count: 5,
      readback_matches: true,
      readback: 'hello',
      error: null,
    });
    const tool = createDesktopTools({
      desktopManager: { typeText } as unknown as DesktopManager,
      config: mockConfig,
    }).find((candidate) => candidate.name === 'desktop_type_text');
    expect(tool).toBeDefined();
    if (!tool) return;

    const args = {
      text: 'hello',
      handle: 12345,
      expected_window_title: 'jarvis-test.txt - Notepad',
      tab_title: 'jarvis-test.txt. Unmodified.',
      control_type: 'Document',
      expected_text: '',
    };
    const context = {} as ToolExecutionContext;
    const output = await tool.execute(args, context);

    expect(tool.permission).toBe('requires-approval');
    expect(typeText).toHaveBeenCalledWith(args);
    expect(tool.verify?.(args, output, context)).toBe(true);
    expect(tool.verify?.(args, { outcome: 'uncertain' }, context)).toBe(false);

    await expect(tool.execute({ text: 'unsafe window-only text' }, context)).rejects.toThrow();
  });

  it('maps vision candidates to physical screen coordinates before clicking', async () => {
    const capture = vi.fn().mockResolvedValue({
      captured: true,
      width: 1000,
      height: 1000,
      image_width: 1000,
      image_height: 1000,
      original_width: 2000,
      original_height: 2000,
      screen_origin_x: 100,
      screen_origin_y: 200,
      scale_x: 2,
      scale_y: 2,
      saved_path: null,
      image_base64: 'iVBORw0KGgo=',
    });
    const mouseClick = vi
      .fn()
      .mockResolvedValue({ clicked: true, x: 340, y: 320, target_window: 'Notepad' });
    const analyze = vi.fn().mockResolvedValue({
      model: 'qwen3.5:9b',
      summary: null,
      elapsedMs: 5,
      invalidElementCount: 0,
      elements: [
        {
          x: 100,
          y: 50,
          width: 40,
          height: 20,
          label: 'Save button',
          role: 'button',
          confidence: 0.9,
        },
      ],
    });

    const tools = createDesktopTools({
      desktopManager: { captureScreenshot: capture, mouseClick } as unknown as DesktopManager,
      visionAnalyzer: { analyze } as unknown as import('../../src/vision/index.js').VisionAnalyzer,
      config: mockConfig,
    });
    const tool = tools.find((t) => t.name === 'desktop_vision_click');
    expect(tool).toBeDefined();
    if (!tool) return;

    const result = (await tool.execute(
      { target: 'the save button', min_confidence: 0.5 },
      {} as ToolExecutionContext,
    )) as { clicked: boolean; screenCoordinates: { x: number; y: number }; verification: string };

    expect(capture).toHaveBeenCalledTimes(2);
    expect(mouseClick).toHaveBeenCalledWith(
      expect.objectContaining({ x: 340, y: 320, button: undefined, double: undefined }),
    );
    expect(result.clicked).toBe(true);
    expect(result.screenCoordinates).toEqual({ x: 340, y: 320 });
    expect(result.verification).toBe('not_applicable');
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

  it('sets one identified UI Automation value only after an exact precondition and read-back', async () => {
    const setControlValue = vi.fn().mockResolvedValue({
      outcome: 'verified',
      delivery: 'dispatched',
      readback: 'verified value',
      readback_matches: true,
      error: null,
    });
    const tool = createDesktopTools({
      desktopManager: { setControlValue } as unknown as DesktopManager,
      config: mockConfig,
    }).find((candidate) => candidate.name === 'desktop_set_control_value');
    expect(tool).toBeDefined();
    if (!tool) return;

    const args = {
      handle: 12345,
      expected_window_title: 'A verified application',
      control_type: 'Edit',
      control_title: 'Name',
      expected_value: '',
      value: 'verified value',
    };
    const context = {} as ToolExecutionContext;
    const output = await tool.execute(args, context);

    expect(setControlValue).toHaveBeenCalledWith(args);
    expect(tool.verify?.(args, output, context)).toBe(true);
    expect(() =>
      tool.execute({ ...args, control_title: undefined, automation_id: undefined }, context),
    ).toThrow('control_title or automation_id');
  });
});
