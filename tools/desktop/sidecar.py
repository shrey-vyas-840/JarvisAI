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
import time
import base64
import io
import traceback
from typing import Dict, Any, List, Optional, Tuple

sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

if sys.platform == "win32":
    try:
        import ctypes
        # Match UI Automation rectangles and screenshot pixels under Windows DPI scaling.
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(2)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass
        hdesk = ctypes.windll.user32.OpenDesktopW("default", 0, False, 0x10000000)
        if hdesk:
            ctypes.windll.user32.SetThreadDesktop(hdesk)
    except Exception:
        pass

try:
    from pywinauto import Desktop, Application
    from pywinauto.keyboard import send_keys
    from pywinauto.mouse import click, double_click, move, press, release, right_click
    from PIL import Image, ImageGrab
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


def get_screen_info(params: Dict[str, Any]) -> Dict[str, Any]:
    user32 = ctypes.windll.user32
    virtual = {
        "left": user32.GetSystemMetrics(76),
        "top": user32.GetSystemMetrics(77),
        "width": user32.GetSystemMetrics(78),
        "height": user32.GetSystemMetrics(79),
    }
    primary = {
        "width": user32.GetSystemMetrics(0),
        "height": user32.GetSystemMetrics(1),
    }
    dpi = 96
    try:
        dpi = ctypes.windll.user32.GetDpiForSystem()
    except Exception:
        try:
            hdc = user32.GetDC(0)
            dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)
            user32.ReleaseDC(0, hdc)
        except Exception:
            pass
    return {
        "primary": primary,
        "virtual": virtual,
        "dpi": dpi,
        "dpi_scale": round(dpi / 96.0, 4),
    }


def get_virtual_screen_rect() -> Dict[str, int]:
    info = get_screen_info({})
    return info["virtual"]


def ensure_point_on_screen(x: int, y: int) -> None:
    virtual = get_virtual_screen_rect()
    left = virtual["left"]
    top = virtual["top"]
    right = left + virtual["width"]
    bottom = top + virtual["height"]
    if not (left <= x < right and top <= y < bottom):
        raise ValueError(
            f"Target coordinates ({x}, {y}) are outside the virtual screen bounds "
            f"[{left}, {top}, {right}, {bottom}]."
        )


def resolve_target_window(params: Dict[str, Any]):
    handle = params.get("handle")
    title = params.get("title")
    if not handle and not title:
        return None
    info = inspect_window(params)
    desktop = get_desktop()
    target = desktop.window(handle=info["handle"])
    if not target.exists(timeout=2):
        target = Desktop(backend="win32").window(handle=info["handle"])
    return target


def ensure_point_in_window(win, x: int, y: int) -> None:
    rect = win.rectangle()
    if not (rect.left <= x <= rect.right and rect.top <= y <= rect.bottom):
        raise ValueError(
            f"Target coordinates ({x}, {y}) are outside the verified bounds "
            f"[{rect.left}, {rect.top}, {rect.right}, {rect.bottom}] for window "
            f"'{win.window_text()}'."
        )


def is_password_control(ctrl) -> bool:
    try:
        return bool(ctrl.element_info.element.CurrentIsPassword)
    except Exception:
        text = ""
        auto_id = ""
        try:
            text = ctrl.window_text().lower()
        except Exception:
            pass
        try:
            auto_id = (getattr(ctrl, "automation_id", lambda: "")() or "").lower()
        except Exception:
            pass
        return "password" in text or "password" in auto_id


def capture_bbox(params: Dict[str, Any]) -> Tuple[Optional[Tuple[int, int, int, int]], Dict[str, int]]:
    handle = params.get("handle")
    title = params.get("title")
    if handle or title:
        info = inspect_window(params)
        rect = info["rect"]
        bbox = (rect["left"], rect["top"], rect["right"], rect["bottom"])
        meta = {
            "screen_origin_x": rect["left"],
            "screen_origin_y": rect["top"],
            "original_width": rect["width"],
            "original_height": rect["height"],
        }
        return bbox, meta

    virtual = get_virtual_screen_rect()
    bbox = (virtual["left"], virtual["top"], virtual["left"] + virtual["width"], virtual["top"] + virtual["height"])
    meta = {
        "screen_origin_x": virtual["left"],
        "screen_origin_y": virtual["top"],
        "original_width": virtual["width"],
        "original_height": virtual["height"],
    }
    return bbox, meta

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


def wait_for_window(params: Dict[str, Any]) -> Dict[str, Any]:
    title = (params.get("title") or "").strip().lower()
    class_name = (params.get("class_name") or "").strip().lower()
    timeout_ms = min(int(params.get("timeout_ms", 10000)), 30000)
    poll_ms = max(100, int(params.get("poll_ms", 250)))

    if not title and not class_name:
        raise ValueError("wait_for_window requires a title or class_name filter.")

    deadline = time.monotonic() + (timeout_ms / 1000.0)
    while time.monotonic() < deadline:
        for win in list_windows({}):
            if title and title not in win["title"].lower():
                continue
            if class_name and class_name not in win["class_name"].lower():
                continue
            return {"found": True, "window": win}
        time.sleep(poll_ms / 1000.0)

    raise TimeoutError(
        f"Window matching title='{title}' class_name='{class_name}' was not found "
        f"within {timeout_ms}ms."
    )


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

    target = resolve_target_window(params)
    if target is not None:
        target.set_focus()

    automation_id = params.get("automation_id")
    control_title = params.get("control_title")
    if automation_id or control_title:
        if target is None:
            raise ValueError("A target window handle or title is required to type into a control.")
        if automation_id:
            ctrl = target.child_window(auto_id=automation_id)
        else:
            ctrl = target.child_window(title=control_title)
        if not ctrl.exists(timeout=3):
            raise ValueError("Target control not found in window.")
        if is_password_control(ctrl):
            raise ValueError(
                "Security restriction: JARVIS is forbidden from typing into password controls."
            )
        ctrl.set_focus()

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
    amount = max(1, int(params.get("amount", 3)))
    coords = params.get("coords")
    x = params.get("x")
    y = params.get("y")
    wheel_dist = -amount if direction == "down" else amount

    if x is not None and y is not None:
        ensure_point_on_screen(int(x), int(y))
        from pywinauto.mouse import scroll as mouse_scroll
        mouse_scroll(coords=(int(x), int(y)), wheel_dist=wheel_dist)
    elif coords:
        cx, cy = int(coords.get("x", 0)), int(coords.get("y", 0))
        ensure_point_on_screen(cx, cy)
        from pywinauto.mouse import scroll as mouse_scroll
        mouse_scroll(coords=(cx, cy), wheel_dist=wheel_dist)
    else:
        target = resolve_target_window(params)
        if target is not None:
            target.set_focus()
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

    x = int(x)
    y = int(y)
    ensure_point_on_screen(x, y)

    target_win = resolve_target_window(params)
    if target_win is None:
        desktop = get_desktop()
        try:
            target_win = desktop.top_window()
        except Exception:
            try:
                target_win = Desktop(backend="win32").top_window()
            except Exception:
                target_win = None

    if target_win is not None and target_win.exists(timeout=2):
        ensure_point_in_window(target_win, x, y)
        try:
            target_win.set_focus()
        except Exception:
            pass

    if double:
        double_click(coords=(x, y))
    elif button == "right":
        right_click(coords=(x, y))
    else:
        click(button=button, coords=(x, y))
    return {
        "clicked": True,
        "x": x,
        "y": y,
        "target_window": target_win.window_text() if target_win else "unknown"
    }

def mouse_move(params: Dict[str, Any]) -> Dict[str, Any]:
    x = params.get("x")
    y = params.get("y")
    if x is None or y is None:
        raise ValueError("Must provide coordinates x and y.")
    x = int(x)
    y = int(y)
    ensure_point_on_screen(x, y)
    move(coords=(x, y))
    return {"moved": True, "x": x, "y": y}

def mouse_drag(params: Dict[str, Any]) -> Dict[str, Any]:
    x1, y1 = params.get("x1"), params.get("y1")
    x2, y2 = params.get("x2"), params.get("y2")
    if None in (x1, y1, x2, y2):
        raise ValueError("Must provide (x1, y1) and (x2, y2).")
    x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
    ensure_point_on_screen(x1, y1)
    ensure_point_on_screen(x2, y2)

    target_win = resolve_target_window(params)
    if target_win is not None and target_win.exists(timeout=2):
        ensure_point_in_window(target_win, x1, y1)
        ensure_point_in_window(target_win, x2, y2)
        try:
            target_win.set_focus()
        except Exception:
            pass

    move(coords=(x1, y1))
    press(button="left", coords=(x1, y1))
    move(coords=(x2, y2))
    release(button="left", coords=(x2, y2))
    return {"dragged": True, "from": [x1, y1], "to": [x2, y2]}

def capture_screenshot(params: Dict[str, Any]) -> Dict[str, Any]:
    dest_path = params.get("path")
    include_image = bool(params.get("include_image", False))
    max_dimension = max(320, min(int(params.get("max_dimension", 1600)), 4096))
    bbox, meta = capture_bbox(params)

    im = ImageGrab.grab(bbox=bbox, all_screens=True)
    original_width, original_height = im.width, im.height
    image = im

    if include_image and max(im.width, im.height) > max_dimension:
        scale = max_dimension / float(max(im.width, im.height))
        image = im.resize(
            (max(1, int(im.width * scale)), max(1, int(im.height * scale))),
            Image.Resampling.LANCZOS,
        )

    result: Dict[str, Any] = {
        "captured": True,
        "width": image.width,
        "height": image.height,
        "image_width": image.width,
        "image_height": image.height,
        "original_width": original_width,
        "original_height": original_height,
        "screen_origin_x": meta["screen_origin_x"],
        "screen_origin_y": meta["screen_origin_y"],
        "scale_x": original_width / float(image.width),
        "scale_y": original_height / float(image.height),
        "saved_path": None,
    }

    if dest_path:
        os.makedirs(os.path.dirname(os.path.abspath(dest_path)), exist_ok=True)
        im.save(dest_path)
        result["saved_path"] = dest_path

    if include_image:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        result["image_base64"] = base64.b64encode(buffer.getvalue()).decode("ascii")

    return result

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
    "get_screen_info": get_screen_info,
    "list_windows": list_windows,
    "wait_for_window": wait_for_window,
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
