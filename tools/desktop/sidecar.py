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
        import ctypes.wintypes
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
    from PIL import Image, ImageGrab
except ImportError as e:
    sys.stderr.write(f"CRITICAL: Failed to import required desktop automation libraries: {e}\n")
    sys.exit(1)

ALLOWED_APPLICATIONS = {
    "notepad": "notepad.exe",
    "calc": "calc.exe",
    "calculator": "calc.exe",
    "explorer": "explorer.exe",
    "excel": "excel.exe",
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
    return {
        "focused": bring_to_foreground(target),
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

def _exact_document_target(params: Dict[str, Any]):
    handle = int(params["handle"])
    expected_window_title = params["expected_window_title"]
    expected_tab_title = params["tab_title"]
    control_type = params["control_type"]
    desktop = get_desktop()
    window = desktop.window(handle=handle)
    if not window.exists(timeout=2):
        raise ValueError(f"Target window handle={handle} no longer exists.")
    if not params.get("allow_title_change", False) and window.window_text() != expected_window_title:
        raise ValueError(
            "Target window title changed before interaction; refusing to use a stale window identity."
        )

    expected_runtime_id = params.get("tab_runtime_id")
    matching_tabs = []
    for control in window.descendants():
        if control.friendly_class_name() != "TabItem":
            continue
        if expected_runtime_id is None:
            if control.window_text().strip() == expected_tab_title:
                matching_tabs.append(control)
            continue
        try:
            runtime_id = [int(value) for value in control.element_info.element.GetRuntimeId()]
            if runtime_id == expected_runtime_id:
                matching_tabs.append(control)
        except Exception:
            continue
    if len(matching_tabs) != 1:
        raise ValueError(
            f"Expected one exact document tab, found {len(matching_tabs)}; no input was sent."
        )
    tab = matching_tabs[0]
    if not tab.is_selected():
        tab.select()
    if not tab.is_selected() or (
        not params.get("allow_title_change", False)
        and window.window_text() != expected_window_title
    ):
        raise ValueError("The requested document tab could not be selected and confirmed.")

    matching_controls = [
        control
        for control in window.descendants()
        if control.friendly_class_name() == control_type
        and control.is_visible()
        and control.is_enabled()
    ]
    if len(matching_controls) != 1:
        raise ValueError(
            f"Expected one enabled visible {control_type} control in the selected tab, "
            f"found {len(matching_controls)}; no input was sent."
        )
    control = matching_controls[0]
    runtime_id = None
    try:
        runtime_id = [int(value) for value in control.element_info.element.GetRuntimeId()]
    except Exception:
        pass
    identity = {
        "window_handle": handle,
        "window_title": window.window_text(),
        "tab_title": tab.window_text(),
        "tab_runtime_id": [int(value) for value in tab.element_info.element.GetRuntimeId()],
        "control_type": control.friendly_class_name(),
        "automation_id": getattr(control, "automation_id", lambda: "")() or "",
        "runtime_id": runtime_id,
    }
    return window, tab, control, identity

def _read_uia_text(control, max_chars: int = 16384) -> Tuple[str, str]:
    try:
        value = control.iface_value.CurrentValue
        if isinstance(value, str):
            return value, "ValuePattern"
    except Exception:
        pass
    try:
        text_range = control.iface_text.DocumentRange
        value = text_range.GetText(max_chars)
        if isinstance(value, str):
            return value, "TextPattern"
    except Exception as error:
        raise RuntimeError(
            "Target editor exposes neither a readable ValuePattern nor TextPattern."
        ) from error
    raise RuntimeError("Target editor returned no readable UI Automation text value.")

def _exact_value_control_target(params: Dict[str, Any]):
    handle = int(params["handle"])
    expected_window_title = params["expected_window_title"]
    control_type = params["control_type"]
    control_title = params.get("control_title")
    automation_id = params.get("automation_id")
    window = get_desktop().window(handle=handle)
    if not window.exists(timeout=2):
        raise ValueError("Target window handle no longer exists; delivery=not_delivered retry=safe.")
    if window.window_text() != expected_window_title:
        raise ValueError("Target window title changed before interaction; delivery=not_delivered retry=safe.")

    matches = []
    for control in window.descendants():
        try:
            if control.friendly_class_name() != control_type:
                continue
            if not control.is_visible() or not control.is_enabled() or is_password_control(control):
                continue
            actual_title = control.window_text().strip()
            actual_automation_id = getattr(control, 'automation_id', lambda: '')() or ''
            if control_title is not None and actual_title != control_title:
                continue
            if automation_id is not None and actual_automation_id != automation_id:
                continue
            matches.append(control)
        except Exception:
            continue
    if len(matches) != 1:
        raise ValueError(
            f"Expected one exact enabled visible {control_type} control, found {len(matches)}; no input was sent."
        )
    control = matches[0]
    return window, control, {
        "window_handle": handle,
        "window_title": window.window_text(),
        "control_type": control.friendly_class_name(),
        "title": control.window_text().strip(),
        "automation_id": getattr(control, 'automation_id', lambda: '')() or '',
    }

def set_control_value(params: Dict[str, Any]) -> Dict[str, Any]:
    window, control, identity = _exact_value_control_target(params)
    try:
        value_pattern = control.iface_value
        if bool(value_pattern.CurrentIsReadOnly):
            raise ValueError("Target control is read-only; delivery=not_delivered retry=safe.")
        current_value = value_pattern.CurrentValue
    except ValueError:
        raise
    except Exception as error:
        raise RuntimeError(
            "Target control does not expose a writable UI Automation ValuePattern; no keyboard fallback is permitted."
        ) from error
    if current_value != params["expected_value"]:
        raise ValueError(
            "Target control value does not match the exact precondition; delivery=not_delivered retry=safe."
        )

    delivery = "not_dispatched"
    dispatch_error = None
    try:
        delivery = "dispatched"
        value_pattern.SetValue(params["value"])
    except Exception as error:
        dispatch_error = str(error)

    try:
        _, verified_control, verified_identity = _exact_value_control_target(params)
        readback = verified_control.iface_value.CurrentValue
        matches = readback == params["value"]
    except Exception as error:
        verified_identity = identity
        readback = None
        matches = False
        if dispatch_error is None:
            dispatch_error = str(error)
    return {
        "outcome": "verified" if matches else "uncertain",
        "backend": "pywinauto",
        "target": verified_identity,
        "delivery": delivery,
        "readback": readback,
        "readback_matches": matches,
        "error": None if matches else (dispatch_error or "UI Automation read-back differed."),
    }

def read_document_text(params: Dict[str, Any]) -> Dict[str, Any]:
    window, tab, control, identity = _exact_document_target(params)
    text, pattern = _read_uia_text(control, int(params.get("max_chars", 16384)))
    return {
        "outcome": "verified",
        "backend": "pywinauto",
        "target": identity,
        "read_pattern": pattern,
        "text": text,
        "character_count": len(text),
    }

def write_document_text_verified(params: Dict[str, Any]) -> Dict[str, Any]:
    window, tab, control, identity = _exact_document_target(params)
    current_text, read_pattern = _read_uia_text(control)
    expected_before = params["expected_text"]
    if current_text != expected_before:
        raise ValueError(
            "Target document contents do not match the expected precondition; "
            "delivery=not_delivered retry=safe."
        )

    replacement_text = params["text"]
    delivery = "not_dispatched"
    method = ""
    dispatch_error = None
    try:
        value_pattern = control.iface_value
        is_read_only = bool(value_pattern.CurrentIsReadOnly)
        if not is_read_only:
            method = "ValuePattern.SetValue"
            delivery = "dispatched"
            try:
                value_pattern.SetValue(replacement_text)
            except Exception as error:
                # Once the provider call has started, delivery is uncertain. Never retry
                # through keyboard input after a potentially partial provider operation.
                dispatch_error = str(error)
        else:
            raise RuntimeError("ValuePattern is read-only.")
    except Exception:
        if delivery == "dispatched":
            raise
        if any(char in replacement_text for char in "{}^%~+()\t\r\n"):
            raise ValueError(
                "Target requires keyboard input and the text contains unsupported key syntax; "
                "delivery=not_delivered retry=safe."
            )
        method = "focused-control type_keys"
        control.set_focus()
        if not control.has_keyboard_focus():
            raise RuntimeError(
                "The exact editor control did not acquire keyboard focus; "
                "delivery=not_delivered retry=safe."
            )
        if ctypes.windll.user32.GetForegroundWindow() != window.handle:
            raise RuntimeError(
                "The target application is not the foreground window; "
                "delivery=not_delivered retry=safe."
            )
        delivery = "dispatched"
        try:
            control.type_keys(
                replacement_text,
                with_spaces=True,
                set_foreground=False,
            )
        except Exception as error:
            # A keyboard API exception does not prove that no characters arrived.
            dispatch_error = str(error)

    # Reacquire the tab and editor after dispatch; never trust the dispatch return value.
    try:
        verify_params = dict(params)
        verify_params["allow_title_change"] = True
        verify_params["tab_runtime_id"] = identity["tab_runtime_id"]
        _, _, verified_control, verified_identity = _exact_document_target(verify_params)
        readback, verified_pattern = _read_uia_text(verified_control)
        readback_matches = readback == replacement_text
    except Exception as error:
        verified_identity = identity
        readback = None
        verified_pattern = read_pattern
        readback_matches = False
        if dispatch_error is None:
            dispatch_error = str(error)
    outcome = "verified" if readback_matches else "uncertain"
    return {
        "outcome": outcome,
        "backend": "pywinauto",
        "target": verified_identity,
        "delivery": delivery,
        "method": method,
        "read_pattern": verified_pattern or read_pattern,
        "expected_character_count": len(replacement_text),
        "actual_character_count": len(readback) if readback is not None else None,
        "readback_matches": readback_matches,
        "readback": readback,
        "error": None if readback_matches else (dispatch_error or "UI Automation read-back differed."),
    }


def close_verified_document(params: Dict[str, Any]) -> Dict[str, Any]:
    window, tab, control, identity = _exact_document_target(params)
    text, _ = _read_uia_text(control)
    if text != params["expected_text"]:
        raise ValueError("Document content changed; refusing to close or delete it.")
    close_buttons = [
        candidate
        for candidate in window.descendants()
        if candidate.friendly_class_name() == "Button"
        and candidate.window_text().strip() == "Close Tab"
        and candidate.is_visible()
        and candidate.is_enabled()
    ]
    if len(close_buttons) != 1:
        raise ValueError(
            f"Expected one active-tab close button, found {len(close_buttons)}; "
            "leaving the verified document open."
        )
    close_buttons[0].invoke()
    time.sleep(0.1)
    remaining = [
        candidate
        for candidate in get_desktop().windows()
        if candidate.handle == int(params["handle"])
        and any(
            child.friendly_class_name() == "TabItem"
            and child.window_text().strip() == params["tab_title"]
            for child in candidate.descendants()
        )
    ]
    if remaining:
        raise RuntimeError("The verified document tab remained open after close request.")
    return {"outcome": "verified", "target": identity, "closed": True}

def save_verified_document(params: Dict[str, Any]) -> Dict[str, Any]:
    window, tab, control, identity = _exact_document_target(params)
    text, _ = _read_uia_text(control)
    if text != params["expected_text"]:
        raise ValueError("Document contents changed; refusing to save an unexpected value.")
    control.set_focus()
    if not control.has_keyboard_focus():
        raise RuntimeError("Exact document editor did not acquire focus; delivery=not_dispatched.")
    if ctypes.windll.user32.GetForegroundWindow() != window.handle:
        raise RuntimeError("Target application is not foreground; delivery=not_dispatched.")
    try:
        control.type_keys("^s", set_foreground=False)
    except Exception as error:
        raise RuntimeError(f"Save shortcut may have been dispatched; outcome=uncertain: {error}") from error
    return {"outcome": "dispatched", "target": identity, "delivery": "dispatched"}

def open_acceptance_document(params: Dict[str, Any]) -> Dict[str, Any]:
    file_path = os.path.abspath(params["path"])
    allowed_root = os.path.realpath(params["allowed_root"])
    resolved_path = os.path.realpath(file_path)
    if os.path.commonpath([allowed_root, resolved_path]) != allowed_root:
        raise ValueError("Acceptance document must be inside the configured temporary directory.")
    if not os.path.basename(file_path).startswith("jarvis-desktop-acceptance-") or not file_path.lower().endswith(".txt"):
        raise ValueError("Acceptance document name is outside the dedicated test-file pattern.")
    if not os.path.isfile(file_path) or os.path.getsize(file_path) != 0:
        raise ValueError("Acceptance document must already exist and be empty.")
    process = subprocess.Popen([ALLOWED_APPLICATIONS["notepad"], file_path])
    return {"opened": True, "pid": process.pid, "path": file_path}

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
    required = (
        "handle",
        "expected_window_title",
        "tab_title",
        "control_type",
        "expected_text",
        "text",
    )
    missing = [name for name in required if name not in params]
    if missing:
        raise ValueError(
            "Window-only or unverified typing is disabled. Required target and verification "
            f"fields are missing: {', '.join(missing)}. delivery=not_delivered retry=safe."
        )
    return write_document_text_verified(params)

def press_key(params: Dict[str, Any]) -> Dict[str, Any]:
    key = params.get("key", "")
    if not key:
        raise ValueError("Key must not be empty.")
    send_keys(key)
    return {"pressed": True, "key": key}

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800

MOUSE_BUTTON_FLAGS = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}

def get_cursor_position() -> Tuple[int, int]:
    point = ctypes.wintypes.POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
    return int(point.x), int(point.y)

def set_cursor_position(x: int, y: int) -> None:
    if not ctypes.windll.user32.SetCursorPos(int(x), int(y)):
        raise RuntimeError(f"Failed to move cursor to ({x}, {y}).")

def send_mouse_event(flag: int, data: int = 0) -> None:
    ctypes.windll.user32.mouse_event(flag, 0, 0, data, 0)

def bring_to_foreground(target) -> bool:
    if target is None:
        return False
    try:
        target.set_focus()
    except Exception:
        pass
    handle = getattr(target, "handle", None)
    if not handle:
        return False
    user32 = ctypes.windll.user32
    deadline = time.time() + 1.0
    while user32.GetForegroundWindow() != handle and time.time() < deadline:
        try:
            user32.SetForegroundWindow(handle)
        except Exception:
            pass
        time.sleep(0.05)
    return user32.GetForegroundWindow() == handle

def click_at(x: int, y: int, button: str = "left", double: bool = False) -> None:
    down, up = MOUSE_BUTTON_FLAGS.get(button, MOUSE_BUTTON_FLAGS["left"])
    set_cursor_position(x, y)
    time.sleep(0.05)
    presses = 2 if double else 1
    for index in range(presses):
        send_mouse_event(down)
        time.sleep(0.02)
        send_mouse_event(up)
        if index + 1 < presses:
            time.sleep(0.08)

def scroll(params: Dict[str, Any]) -> Dict[str, Any]:
    direction = params.get("direction", "down")
    amount = max(1, int(params.get("amount", 3)))
    coords = params.get("coords")
    x = params.get("x")
    y = params.get("y")
    wheel_dist = -amount if direction == "down" else amount

    if x is not None and y is not None:
        target_x, target_y = int(x), int(y)
        ensure_point_on_screen(target_x, target_y)
        set_cursor_position(target_x, target_y)
        time.sleep(0.05)
        send_mouse_event(MOUSEEVENTF_WHEEL, wheel_dist * 120)
    elif coords:
        cx, cy = int(coords.get("x", 0)), int(coords.get("y", 0))
        ensure_point_on_screen(cx, cy)
        set_cursor_position(cx, cy)
        time.sleep(0.05)
        send_mouse_event(MOUSEEVENTF_WHEEL, wheel_dist * 120)
    else:
        bring_to_foreground(resolve_target_window(params))
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
        if not bring_to_foreground(target_win):
            raise RuntimeError(
                f"Could not bring target window handle={target_win.handle} to the foreground; click cancelled."
            )

    click_at(x, y, button=button, double=double)
    return {
        "clicked": True,
        "x": x,
        "y": y,
        "cursor": list(get_cursor_position()),
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
    set_cursor_position(x, y)
    return {"moved": True, "x": x, "y": y, "cursor": list(get_cursor_position())}

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
        if not bring_to_foreground(target_win):
            raise RuntimeError(
                f"Could not bring target window handle={target_win.handle} to the foreground; drag cancelled."
            )

    set_cursor_position(x1, y1)
    time.sleep(0.05)
    send_mouse_event(MOUSEEVENTF_LEFTDOWN)
    time.sleep(0.05)
    set_cursor_position(x2, y2)
    time.sleep(0.05)
    send_mouse_event(MOUSEEVENTF_LEFTUP)
    return {
        "dragged": True,
        "from": [x1, y1],
        "to": [x2, y2],
        "cursor": list(get_cursor_position()),
    }

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
    "set_control_value": set_control_value,
    "read_document_text": read_document_text,
    "write_document_text_verified": write_document_text_verified,
    "close_verified_document": close_verified_document,
    "save_verified_document": save_verified_document,
    "open_acceptance_document": open_acceptance_document,
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
