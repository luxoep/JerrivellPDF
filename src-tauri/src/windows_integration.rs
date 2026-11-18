// SPDX-License-Identifier: MIT OR Apache-2.0
//! Per-user PDF candidates and a user-controlled Windows default-apps handoff.
//!
//! Never write UserChoice, its hash, or the default value of the .pdf key.
//! https://learn.microsoft.com/windows/win32/shell/how-to-include-an-application-on-the-open-with-dialog-box
//! https://learn.microsoft.com/windows/apps/develop/launch/launch-default-apps-settings

use serde::Serialize;
use std::ffi::c_void;
use std::path::Path;
use std::ptr::{null, null_mut};

const APP_NAME: &str = "Jerrivell PDF";
const PROG_ID: &str = "JerrivellPDF.Document";
const CAPABILITIES: &str = "Software\\JerrivellPDF\\Capabilities";
const DEFAULT_SETTINGS: &str = "ms-settings:defaultapps";
const APP_SETTINGS: &str = "ms-settings:defaultapps?registeredAppUser=Jerrivell%20PDF";
type Hkey = *mut c_void;
const HKCU: Hkey = 0x8000_0001_u32 as i32 as isize as Hkey;
const HKLM: Hkey = 0x8000_0002_u32 as i32 as isize as Hkey;

#[link(name = "advapi32")]
unsafe extern "system" {
    fn RegCreateKeyExW(
        key: Hkey,
        subkey: *const u16,
        reserved: u32,
        class: *mut u16,
        options: u32,
        access: u32,
        security: *const c_void,
        result: *mut Hkey,
        disposition: *mut u32,
    ) -> i32;
    fn RegSetValueExW(
        key: Hkey,
        name: *const u16,
        reserved: u32,
        kind: u32,
        data: *const u8,
        bytes: u32,
    ) -> i32;
    fn RegCloseKey(key: Hkey) -> i32;
    fn RegGetValueW(
        key: Hkey,
        subkey: *const u16,
        name: *const u16,
        flags: u32,
        kind: *mut u32,
        data: *mut c_void,
        bytes: *mut u32,
    ) -> i32;
}

#[link(name = "shell32")]
unsafe extern "system" {
    fn ShellExecuteW(
        owner: *mut c_void,
        operation: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
    ) -> *mut c_void;
    fn SHChangeNotify(event: i32, flags: u32, item1: *const c_void, item2: *const c_void);
}

#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: *mut c_void, mode: u32) -> i32;
    fn CoUninitialize();
}

#[repr(C)]
struct OsVersionInfo {
    size: u32,
    major: u32,
    minor: u32,
    build: u32,
    platform: u32,
    service_pack: [u16; 128],
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn RtlGetVersion(version: *mut OsVersionInfo) -> i32;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    application_name: &'static str,
    prog_id: &'static str,
    registered: bool,
    settings_uri: &'static str,
    settings_opened: bool,
    selection_required: bool,
}

fn wide(value: &str) -> Result<Vec<u16>, String> {
    if value.contains('\0') {
        return Err("WINDOWS_INTEGRATION_ERROR: 无效的注册值。".into());
    }
    Ok(value.encode_utf16().chain(Some(0)).collect())
}

fn entries(executable: &Path) -> Result<Vec<(String, String, String)>, String> {
    let executable = executable
        .to_str()
        .ok_or("WINDOWS_INTEGRATION_ERROR: 无法读取程序路径。")?;
    if executable.contains('\0') || executable.contains('"') {
        return Err("WINDOWS_INTEGRATION_ERROR: 无效的程序路径。".into());
    }
    let command = format!("\"{executable}\" --open \"%1\"");
    let icon = format!("\"{executable}\",0");
    let app = "Software\\Classes\\Applications\\jerrivell-pdf.exe";
    let prog = format!("Software\\Classes\\{PROG_ID}");
    let verb = "Software\\Classes\\SystemFileAssociations\\.pdf\\shell\\JerrivellPDF";
    let mut values: Vec<(String, String, String)> = vec![
        (prog.clone(), "".into(), "Jerrivell PDF document".into()),
        (format!("{prog}\\DefaultIcon"), "".into(), icon.clone()),
        (
            format!("{prog}\\shell\\open\\command"),
            "".into(),
            command.clone(),
        ),
        (
            format!("{prog}\\Application"),
            "ApplicationName".into(),
            APP_NAME.into(),
        ),
        (
            format!("{prog}\\Application"),
            "ApplicationIcon".into(),
            icon.clone(),
        ),
        (
            "Software\\Classes\\.pdf\\OpenWithProgids".into(),
            PROG_ID.into(),
            "".into(),
        ),
        (app.into(), "FriendlyAppName".into(), APP_NAME.into()),
        (format!("{app}\\DefaultIcon"), "".into(), icon.clone()),
        (format!("{app}\\SupportedTypes"), ".pdf".into(), "".into()),
        (
            format!("{app}\\shell\\open\\command"),
            "".into(),
            command.clone(),
        ),
        (
            CAPABILITIES.into(),
            "ApplicationName".into(),
            APP_NAME.into(),
        ),
        (
            CAPABILITIES.into(),
            "ApplicationDescription".into(),
            "Local open-source PDF workspace".into(),
        ),
        (CAPABILITIES.into(), "ApplicationIcon".into(), icon.clone()),
        (
            CAPABILITIES.into(),
            "JerrivellOwnerPath".into(),
            executable.into(),
        ),
        (
            format!("{CAPABILITIES}\\FileAssociations"),
            ".pdf".into(),
            PROG_ID.into(),
        ),
        (
            "Software\\RegisteredApplications".into(),
            APP_NAME.into(),
            CAPABILITIES.into(),
        ),
        (verb.into(), "".into(), "使用 Jerrivell PDF 打开".into()),
        (verb.into(), "Icon".into(), icon),
        (verb.into(), "MultiSelectModel".into(), "Single".into()),
        (format!("{verb}\\command"), "".into(), command),
    ];
    // Validate every value before the first registry write.
    for (path, name, data) in &values {
        wide(path)?;
        wide(name)?;
        wide(data)?;
    }
    values.shrink_to_fit();
    Ok(values)
}

fn write_value(path: &str, name: &str, data: &str) -> Result<(), String> {
    let path_wide = wide(path)?;
    let name_wide = wide(name)?;
    let data_wide = wide(data)?;
    let mut key = null_mut();
    // SAFETY: all UTF-16 buffers are terminated and live through synchronous API
    // calls. HKCU is a predefined handle; the newly opened key is always closed.
    let created = unsafe {
        RegCreateKeyExW(
            HKCU,
            path_wide.as_ptr(),
            0,
            null_mut(),
            0,
            0x0002,
            null(),
            &mut key,
            null_mut(),
        )
    };
    if created != 0 {
        return Err(format!(
            "WINDOWS_INTEGRATION_ERROR: 注册打开方式失败（{created}）：{path}"
        ));
    }
    let written = unsafe {
        RegSetValueExW(
            key,
            name_wide.as_ptr(),
            0,
            1,
            data_wide.as_ptr().cast(),
            (data_wide.len() * 2) as u32,
        )
    };
    unsafe {
        RegCloseKey(key);
    }
    if written != 0 {
        return Err(format!(
            "WINDOWS_INTEGRATION_ERROR: 注册打开方式失败（{written}）：{path}"
        ));
    }
    Ok(())
}

fn supports_app_settings(build: u32, revision: Option<u32>) -> bool {
    build >= 22631
        || (build == 22621 && revision.is_some_and(|v| v >= 1555))
        || (build == 22000 && revision.is_some_and(|v| v >= 1817))
}

fn preferred_settings_uri() -> &'static str {
    let mut version = OsVersionInfo {
        size: std::mem::size_of::<OsVersionInfo>() as u32,
        major: 0,
        minor: 0,
        build: 0,
        platform: 0,
        service_pack: [0; 128],
    };
    // SAFETY: RtlGetVersion writes exactly the OSVERSIONINFOW-sized structure.
    if unsafe { RtlGetVersion(&mut version) } != 0 {
        return DEFAULT_SETTINGS;
    }
    let path = wide("Software\\Microsoft\\Windows NT\\CurrentVersion").unwrap();
    let name = wide("UBR").unwrap();
    let mut revision = 0_u32;
    let mut bytes = 4_u32;
    // RRF_RT_REG_DWORD requests only a DWORD and bytes bounds the output buffer.
    let result = unsafe {
        RegGetValueW(
            HKLM,
            path.as_ptr(),
            name.as_ptr(),
            0x10,
            null_mut(),
            (&mut revision as *mut u32).cast(),
            &mut bytes,
        )
    };
    if supports_app_settings(version.build, (result == 0).then_some(revision)) {
        APP_SETTINGS
    } else {
        DEFAULT_SETTINGS
    }
}

pub fn register_pdf_integration() -> Result<IntegrationStatus, String> {
    let executable =
        std::env::current_exe().map_err(|e| format!("WINDOWS_INTEGRATION_ERROR: {e}"))?;
    // Debug and installed builds deliberately register the exact running EXE;
    // no caller-provided executable, registry path, command, or URI is accepted.
    for (path, name, value) in entries(&executable)? {
        write_value(&path, &name, &value)?;
    }
    unsafe {
        SHChangeNotify(0x0800_0000, 0, null(), null());
    }
    Ok(IntegrationStatus {
        application_name: APP_NAME,
        prog_id: PROG_ID,
        registered: true,
        settings_uri: preferred_settings_uri(),
        settings_opened: false,
        selection_required: true,
    })
}

fn launch(uri: &'static str) -> bool {
    let operation = wide("open").unwrap();
    let uri = wide(uri).unwrap();
    // The command runs on a blocking pool thread. Some Shell URI handlers use
    // COM; balance only our own successful initialization (including S_FALSE).
    let initialized = unsafe { CoInitializeEx(null_mut(), 0x2 | 0x4) } >= 0;
    // SAFETY: launch only one of two fixed documented Settings URIs; no shell
    // command or user input. ShellExecuteW does not retain these string buffers.
    let launched = unsafe {
        ShellExecuteW(
            null_mut(),
            operation.as_ptr(),
            uri.as_ptr(),
            null(),
            null(),
            1,
        ) as isize
            > 32
    };
    if initialized {
        unsafe {
            CoUninitialize();
        }
    }
    launched
}

pub fn open_default_pdf_settings() -> Result<IntegrationStatus, String> {
    let mut status = register_pdf_integration()?;
    if !launch(status.settings_uri) {
        if status.settings_uri == DEFAULT_SETTINGS || !launch(DEFAULT_SETTINGS) {
            return Err("WINDOWS_INTEGRATION_ERROR: 无法打开默认应用设置。请在 Windows 设置 → 应用 → 默认应用中搜索 Jerrivell PDF 或 .pdf。".into());
        }
        status.settings_uri = DEFAULT_SETTINGS;
    }
    status.settings_opened = true;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_do_not_replace_user_default_and_quote_paths() {
        let values = entries(Path::new("C:\\测试 文件 & Jerry\\jerrivell-pdf.exe")).unwrap();
        assert_eq!(
            values
                .iter()
                .filter(|(path, _, _)| path.ends_with("\\command"))
                .count(),
            3
        );
        for (path, name, data) in &values {
            assert!(!path.to_lowercase().contains("userchoice"));
            assert!(!(path == "Software\\Classes\\.pdf" && name.is_empty()));
            if path.ends_with("\\command") {
                assert_eq!(
                    data,
                    "\"C:\\测试 文件 & Jerry\\jerrivell-pdf.exe\" --open \"%1\""
                );
            }
        }
        assert!(values
            .iter()
            .any(|(path, name, value)| path.ends_with("\\OpenWithProgids")
                && name == PROG_ID
                && value.is_empty()));
        assert!(values.iter().any(|(path, name, value)| path
            == "Software\\RegisteredApplications"
            && name == APP_NAME
            && value == CAPABILITIES));
        assert!(entries(Path::new("C:\\bad\"path\\app.exe")).is_err());
    }

    #[test]
    fn settings_route_only_uses_documented_supported_builds() {
        for build in [19045, 22000, 22621, 22622] {
            assert!(!supports_app_settings(build, None));
        }
        assert!(!supports_app_settings(22000, Some(1816)));
        assert!(supports_app_settings(22000, Some(1817)));
        assert!(!supports_app_settings(22621, Some(1554)));
        assert!(supports_app_settings(22621, Some(1555)));
        assert!(supports_app_settings(22631, None));
        assert!(supports_app_settings(26100, None));
        assert_eq!(
            wide("Jerry\0other").unwrap_err(),
            "WINDOWS_INTEGRATION_ERROR: 无效的注册值。"
        );
    }
}
