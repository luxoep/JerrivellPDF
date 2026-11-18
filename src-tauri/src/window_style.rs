// SPDX-License-Identifier: GPL-3.0-or-later
//! Keep the native Windows caption aligned with the application's light header.

use std::ffi::c_void;
use std::mem::size_of;

const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
const DWMWA_BORDER_COLOR: u32 = 34;
const DWMWA_CAPTION_COLOR: u32 = 35;
const DWMWA_TEXT_COLOR: u32 = 36;

#[link(name = "dwmapi")]
unsafe extern "system" {
    fn DwmSetWindowAttribute(
        hwnd: *mut c_void,
        attribute: u32,
        value: *const c_void,
        value_size: u32,
    ) -> i32;
}

const fn color_ref(red: u8, green: u8, blue: u8) -> u32 {
    red as u32 | ((green as u32) << 8) | ((blue as u32) << 16)
}

/// Apply only this window's frame colors; native caption controls stay intact.
///
/// Caption/text/border colors require Windows 11 build 22000 or newer. DWM
/// rejects unsupported attributes on older systems, so styling is best effort
/// and must never prevent the PDF application from starting.
/// https://learn.microsoft.com/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute
pub fn match_app_titlebar<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    // The application currently has a fixed light palette. Keep caption button
    // glyphs light-theme compatible even when Windows itself uses dark mode.
    let _ = window.set_theme(Some(tauri::Theme::Light));
    let Ok(hwnd) = window.hwnd() else {
        return;
    };

    for (attribute, value) in [
        (DWMWA_USE_IMMERSIVE_DARK_MODE, 0_u32),
        (DWMWA_CAPTION_COLOR, color_ref(255, 255, 255)), // .app-header #ffffff
        (DWMWA_TEXT_COLOR, color_ref(36, 43, 62)),       // app text #242b3e
        (DWMWA_BORDER_COLOR, color_ref(232, 234, 240)),  // --border #e8eaf0
    ] {
        // SAFETY: hwnd comes from this live Tauri window. DWM synchronously
        // reads a correctly sized 32-bit BOOL/COLORREF from value; it retains
        // no pointer. All four attributes use four-byte values on Windows.
        let _ = unsafe {
            DwmSetWindowAttribute(
                hwnd.0 as *mut c_void,
                attribute,
                (&value as *const u32).cast(),
                size_of::<u32>() as u32,
            )
        };
    }
}
