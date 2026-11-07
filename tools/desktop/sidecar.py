#!/usr/bin/env python3
"""
JARVIS Windows Desktop Automation Sidecar
Communicates with JARVIS agent core via JSON-lines over standard input/output.
Uses pywinauto with Windows UI Automation backend and Win32 fallback.
"""

import sys
import json
import os
import subprocess
import traceback
from typing import Dict, Any, List

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

try:
    from pywinauto import Desktop, Application
    from pywinauto.keyboard import send_keys
    from pywinauto.mouse import click, move, press, release
    from PIL import ImageGrab
except ImportError as e:
    sys.stderr.write(f"CRITICAL: Failed to import required desktop automation libraries: {e}\n")
    sys.exit(1)

ALLOWED_APPLICATIONS = {
    "notepad": "notepad.exe",
    "calc": "calc.exe",
    "calculator": "calc.exe",
    "explorer": "explorer.exe",
}

def get_desktop():
    return Desktop(backend="uia")

def list_windows(params: Dict[str, Any]) -> List[Dict[str, Any]]:
    windows = []
    seen_handles = set()

    # Try UIA first
    try:
        uia_desktop = Desktop(backend="uia")
        for win in uia_desktop.windows():
            try:
                text = win.window_text().strip()
                if not text:
                    continue
                h = win.handle
                if h in seen_handles:
                    continue
                seen_handles.add(h)
                rect = win.rectangle()
                windows.append({
                    "handle": h,
                    "title": text,
                    "process_id": win.process_id(),
                    "class_name": win.class_name(),
                    "backend": "uia",
                    "rect": {
                        "left": rect.left,
                        "top": rect.top,
                        "right": rect.right,
                        "bottom": rect.bottom,
                        "width": rect.width(),
                        "height": rect.height()
                    }
                })
            except Exception:
                continue
    except Exception:
        pass

    # Augment or fallback with Win32
    try:
        win32_desktop = Desktop(backend="win32")
        for win in win32_desktop.windows():
            try:
                if not win.is_visible():
                    continue
                text = win.window_text().strip()
                if not text:
                    continue
                h = win.handle
                if h in seen_handles:
                    continue
                seen_handles.add(h)
                rect = win.rectangle()
                windows.append({
                    "handle": h,
                    "title": text,
                    "process_id": win.process_id(),
                    "class_name": win.class_name(),
                    "backend": "win32",
                    "rect": {
                        "left": rect.left,
                        "top": rect.top,
                        "right": rect.right,
                        "bottom": rect.bottom,
                        "width": rect.width(),
                        "height": rect.height()
                    }
                })
            except Exception:
                continue
    except Exception:
        pass

    return windows

def inspect_window(params: Dict[str, Any]) -> Dict[str, Any]:
    handle = params.get("handle")
    title = params.get("title")

    target = None
    desktop = get_desktop()
    if handle:
        try:
            target = desktop.window(handle=handle)
            if not target.exists(timeout=2):
                target = None
        except Exception:
            target = None
    elif title:
        try:
            target = desktop.window(title_re=f".*{title}.*")
            if not target.exists(timeout=2):
                target = None
        except Exception:
            target = None

    if not target:
        # Fallback to win32
        w32 = Desktop(backend="win32")
        if handle:
            target = w32.window(handle=handle)
        elif title:
            target = w32.window(title_re=f".*{title}.*")

    if not target or not target.exists(timeout=2):
        raise ValueError(f"Target window with handle={handle} or title='{title}' not found.")

    rect = target.rectangle()
    return {
        "handle": target.handle,
        "title": target.window_text(),
        "process_id": target.process_id(),
        "class_name": target.class_name(),
        "rect": {
            "left": rect.left,
            "top": rect.top,
            "right": rect.right,
            "bottom": rect.bottom,
            "width": rect.width(),
            "height": rect.height()
        }
    }

def focus_window(params: Dict[str, Any]) -> Dict[str, Any]:
    info = inspect_window(params)
    desktop = get_desktop()
    target = desktop.window(handle=info["handle"])
    if not target.exists(timeout=2):
        target = Desktop(backend="win32").window(handle=info["handle"])
    target.set_focus()
    return {
        "focused": True,
        "handle": info["handle"],
        "title": info["title"]
    }

def get_controls(params: Dict[str, Any]) -> List[Dict[str, Any]]:
    info = inspect_window(params)
    desktop = get_desktop()
    target = desktop.window(handle=info["handle"])
    if not target.exists(timeout=2):
        target = Desktop(backend="win32").window(handle=info["handle"])

    controls = []
    max_count = params.get("limit", 50)
    for ctrl in target.descendants():
        try:
            ctrl_text = ctrl.window_text().strip()
            ctrl_type = ctrl.friendly_class_name()
            auto_id = getattr(ctrl, 'automation_id', lambda: '')() or ''
            rect = ctrl.rectangle()

            is_password = False
            try:
                is_password = bool(ctrl.element_info.element.CurrentIsPassword)
            except Exception:
                is_password = "password" in ctrl_text.lower() or "password" in auto_id.lower()

            controls.append({
                "control_type": ctrl_type,
                "title": "[REDACTED_PASSWORD]" if is_password else ctrl_text,
                "automation_id": auto_id,
                "is_enabled": ctrl.is_enabled(),
                "is_visible": ctrl.is_visible(),
                "is_password": is_password,
                "rect": {
                    "left": rect.left,
                    "top": rect.top,
                    "width": rect.width(),
                    "height": rect.height()
                }
            })
            if len(controls) >= max_count:
                break
        except Exception:
            continue
    return controls

def click_control(params: Dict[str, Any]) -> Dict[str, Any]:
    info = inspect_window(params)
    desktop = get_desktop()
    target = desktop.window(handle=info["handle"])
    if not target.exists(timeout=2):
        target = Desktop(backend="win32").window(handle=info["handle"])

    ctrl_title = params.get("control_title")
    auto_id = params.get("automation_id")
    ctrl_type = params.get("control_type")

    ctrl = None
    if auto_id:
        ctrl = target.child_window(auto_id=auto_id)
    elif ctrl_title:
        ctrl = target.child_window(title=ctrl_title)
    elif ctrl_type:
        ctrl = target.child_window(control_type=ctrl_type)

    if not ctrl or not ctrl.exists(timeout=3):
        raise ValueError("Target control not found in window.")

    ctrl.click_input()
    return {"clicked": True, "control": ctrl.window_text()}

def type_text(params: Dict[str, Any]) -> Dict[str, Any]:
    text = params.get("text", "")
    if not text:
        return {"typed": True, "length": 0}

    # Bring target window to focus if specified
    if params.get("handle") or params.get("title"):
        focus_window(params)

    # Safe typing with spaces
    send_keys(text, with_spaces=True)
    return {"typed": True, "length": len(text)}

def press_key(params: Dict[str, Any]) -> Dict[str, Any]:
    key = params.get("key", "")
    if not key:
        raise ValueError("Key must not be empty.")
    send_keys(key)
    return {"pressed": True, "key": key}

def scroll(params: Dict[str, Any]) -> Dict[str, Any]:
    direction = params.get("direction", "down")
    amount = params.get("amount", 3)
    coords = params.get("coords")
    wheel_dist = -amount if direction == "down" else amount

    if coords:
        from pywinauto.mouse import scroll as mouse_scroll
        mouse_scroll(coords=(coords.get("x", 0), coords.get("y", 0)), wheel_dist=wheel_dist)
    else:
        key = "{PGDN}" if direction == "down" else "{PGUP}"
        for _ in range(max(1, amount // 3)):
            send_keys(key)
    return {"scrolled": True, "direction": direction, "amount": amount}

def mouse_click(params: Dict[str, Any]) -> Dict[str, Any]:
    x = params.get("x")
    y = params.get("y")
    button = params.get("button", "left")
    double = params.get("double", False)

    if x is None or y is None:
        raise ValueError("Must provide coordinates x and y.")

    # Find the top/active window
    desktop = get_desktop()
    active_win = None
    try:
        active_win = desktop.top_window()
    except Exception:
        try:
            active_win = Desktop(backend="win32").top_window()
        except Exception:
            pass

    if active_win and active_win.exists(timeout=2):
        rect = active_win.rectangle()
        if not (rect.left <= x <= rect.right and rect.top <= y <= rect.bottom):
            raise ValueError(
                f"Target coordinates ({x}, {y}) are outside the verified bounds "
                f"[{rect.left}, {rect.top}, {rect.right}, {rect.bottom}] for active window '{active_win.window_text()}'."
            )

    click(button=button, coords=(x, y), double=double)
    return {
        "clicked": True,
        "x": x,
        "y": y,
        "target_window": active_win.window_text() if active_win else "unknown"
    }

def mouse_move(params: Dict[str, Any]) -> Dict[str, Any]:
    x = params.get("x")
    y = params.get("y")
    if x is None or y is None:
        raise ValueError("Must provide coordinates x and y.")
    move(coords=(x, y))
    return {"moved": True, "x": x, "y": y}

def mouse_drag(params: Dict[str, Any]) -> Dict[str, Any]:
    x1, y1 = params.get("x1"), params.get("y1")
    x2, y2 = params.get("x2"), params.get("y2")
    if None in (x1, y1, x2, y2):
        raise ValueError("Must provide (x1, y1) and (x2, y2).")
    move(coords=(x1, y1))
    press(button="left", coords=(x1, y1))
    move(coords=(x2, y2))
    release(button="left", coords=(x2, y2))
    return {"dragged": True, "from": [x1, y1], "to": [x2, y2]}

def capture_screenshot(params: Dict[str, Any]) -> Dict[str, Any]:
    dest_path = params.get("path")
    handle = params.get("handle")

    bbox = None
    if handle:
        desktop = get_desktop()
        try:
            win = desktop.window(handle=handle)
            if win.exists(timeout=2):
                rect = win.rectangle()
                bbox = (rect.left, rect.top, rect.right, rect.bottom)
        except Exception:
            pass

    im = ImageGrab.grab(bbox=bbox, all_screens=True)
    if dest_path:
        os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
        im.save(dest_path)
    return {
        "captured": True,
        "width": im.width,
        "height": im.height,
        "saved_path": dest_path
    }

def launch_application(params: Dict[str, Any]) -> Dict[str, Any]:
    app_key = params.get("name", "").strip().lower()
    if app_key not in ALLOWED_APPLICATIONS:
        raise ValueError(
            f"Application '{app_key}' is not in the approved desktop allowlist. "
            f"Allowed applications: {', '.join(ALLOWED_APPLICATIONS.keys())}"
        )
    binary = ALLOWED_APPLICATIONS[app_key]
    proc = subprocess.Popen([binary])
    return {
        "launched": True,
        "application": app_key,
        "executable": binary,
        "pid": proc.pid
    }

DISPATCH = {
    "list_windows": list_windows,
    "inspect_window": inspect_window,
    "focus_window": focus_window,
    "get_controls": get_controls,
    "click_control": click_control,
    "type_text": type_text,
    "press_key": press_key,
    "scroll": scroll,
    "mouse_click": mouse_click,
    "mouse_move": mouse_move,
    "mouse_drag": mouse_drag,
    "capture_screenshot": capture_screenshot,
    "launch_application": launch_application,
}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            req_id = req.get("id")
            action = req.get("action")
            params = req.get("params", {})

            if action not in DISPATCH:
                res = {"id": req_id, "success": False, "error": f"Unknown action '{action}'"}
            else:
                data = DISPATCH[action](params)
                res = {"id": req_id, "success": True, "data": data}
            sys.stdout.write(json.dumps(res) + "\n")
        except Exception as e:
            res = {
                "id": req.get("id") if 'req' in locals() else None,
                "success": False,
                "error": str(e),
                "trace": traceback.format_exc()
            }
            sys.stdout.write(json.dumps(res) + "\n")

if __name__ == "__main__":
    main()
