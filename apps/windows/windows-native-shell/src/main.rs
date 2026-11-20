#![windows_subsystem = "windows"]
mod frames;
mod host;
mod runtime;
mod ui;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, ptr::null_mut};
use windows_sys::Win32::{Foundation::*, System::Threading::*, UI::WindowsAndMessaging::*};
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub fn text(v: &serde_json::Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").into()
}
pub fn flag(v: &serde_json::Value, key: &str) -> bool {
    v[key].as_bool().unwrap_or(false)
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    unsafe {
        let base = std::env::current_exe()?.parent().unwrap().to_path_buf();
        let mut local = [0u16; 260];
        if windows_sys::Win32::UI::Shell::SHGetFolderPathW(
            null_mut(),
            windows_sys::Win32::UI::Shell::CSIDL_LOCAL_APPDATA as i32,
            null_mut(),
            0,
            local.as_mut_ptr(),
        ) < 0
        {
            return Err("LocalApplicationData unavailable".into());
        }
        let mut state = PathBuf::from(String::from_utf16(
            &local[..local.iter().position(|&c| c == 0).unwrap_or(local.len())],
        )?)
        .join("aBridge");
        let deployment = base.join("deployment.json");
        if deployment.exists() {
            let v: serde_json::Value = serde_json::from_slice(&std::fs::read(deployment)?)?;
            if let Some(s) = v["state_dir"].as_str() {
                state = PathBuf::from(s);
            }
        }
        let mut args = std::env::args_os().skip(1);
        while let Some(a) = args.next() {
            if a == "--state-dir" {
                if let Some(s) = args.next() {
                    state = s.into();
                }
            }
        }
        // GetFullPathName matches Path.GetFullPath without requiring the directory to exist.
        if state.as_os_str().is_empty() {
            return Err("empty state path".into());
        }
        let path = wide(&state.to_string_lossy());
        let mut buffer = vec![0u16; 32768];
        let n = windows_sys::Win32::Storage::FileSystem::GetFullPathNameW(
            path.as_ptr(),
            buffer.len() as u32,
            buffer.as_mut_ptr(),
            null_mut(),
        );
        if n == 0 || n as usize >= buffer.len() {
            return Err("invalid state path".into());
        }
        let mut path = String::from_utf16(&buffer[..n as usize])?;
        if windows_sys::Win32::UI::Shell::PathIsRootW(wide(&path).as_ptr()) == 0
            && (path.ends_with('\\') || path.ends_with('/'))
        {
            path.pop();
        }
        state = PathBuf::from(&path);
        let arguments: Vec<String> = std::env::args().skip(1).collect();
        if arguments.iter().any(|arg| arg == "--native-host") {
            let parent = arguments
                .iter()
                .position(|arg| arg == "--parent-pid")
                .and_then(|index| arguments.get(index + 1))
                .ok_or("Missing native host parent PID")?
                .parse::<u32>()?;
            if parent == 0 {
                return Err("Invalid native host parent PID".into());
            }
            return runtime::run_host(state, parent).map_err(Into::into);
        }
        let identity = format!(
            "{:X}",
            Sha256::digest(invariant_lowercase(&path)?.as_bytes())
        );
        let mutex = CreateMutexW(
            null_mut(),
            1,
            wide(&format!("Local\\aBridge.Native.{identity}")).as_ptr(),
        );
        if mutex.is_null() {
            return Err("mutex".into());
        }
        let first = GetLastError() != ERROR_ALREADY_EXISTS;
        let activation = CreateEventW(
            null_mut(),
            0,
            0,
            wide(&format!("Local\\aBridge.Show.{identity}")).as_ptr(),
        );
        if activation.is_null() {
            CloseHandle(mutex);
            return Err("activation event".into());
        }
        if !first {
            SetEvent(activation);
            CloseHandle(activation);
            CloseHandle(mutex);
            return Ok(());
        }
        let result = ui::run(base, state, activation);
        CloseHandle(activation);
        CloseHandle(mutex);
        result
    }
}
fn cli_mode(arguments: &[String]) -> bool {
    if arguments.iter().any(|arg| arg == "--native-host") {
        return false;
    }
    let mut arguments = arguments.iter();
    while let Some(arg) = arguments.next() {
        match arg.as_str() {
            "--state-dir" | "--capability" | "--enabled" | "--name" => {
                arguments.next();
            }
            "--help" | "-h" | "--version" => return true,
            other if !other.starts_with('-') => return true,
            _ => {}
        }
    }
    false
}
fn main() {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if cli_mode(&arguments) {
        if let Err(error) = runtime::run_cli(&arguments) {
            println!("{}", serde_json::json!({"error":error.to_string()}));
            std::process::exit(1);
        }
        return;
    }
    if run().is_err() {
        if arguments.iter().any(|arg| arg == "--native-host") {
            eprintln!("Native host failed to start");
            std::process::exit(1);
        }
        unsafe {
            MessageBoxW(
                null_mut(),
                wide("aBridge 无法启动，请检查安装是否完整以及本机状态目录权限。").as_ptr(),
                wide("aBridge").as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

// Match .NET's Windows ICU simple casing, with NLS fallback on older Windows.
fn invariant_lowercase(value: &str) -> Result<String, Box<dyn std::error::Error>> {
    use windows_sys::Win32::System::LibraryLoader::*;
    unsafe {
        let library = LoadLibraryExW(
            wide("icu.dll").as_ptr(),
            std::ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        );
        if !library.is_null() {
            let symbol = GetProcAddress(library, c"u_tolower".as_ptr().cast());
            if let Some(symbol) = symbol {
                let lower: unsafe extern "C" fn(i32) -> i32 = std::mem::transmute(symbol);
                let result = value
                    .chars()
                    .map(|c| {
                        if c == '\u{0130}' {
                            c
                        } else {
                            char::from_u32(lower(c as i32) as u32).unwrap_or(c)
                        }
                    })
                    .collect();
                FreeLibrary(library);
                return Ok(result);
            }
            FreeLibrary(library);
        }
        use windows_sys::Win32::Globalization::*;
        let input: Vec<u16> = value.encode_utf16().collect();
        let mut output = vec![0u16; input.len()];
        let count = LCMapStringEx(
            wide("").as_ptr(),
            LCMAP_LOWERCASE,
            input.as_ptr(),
            input.len() as i32,
            output.as_mut_ptr(),
            output.len() as i32,
            std::ptr::null(),
            std::ptr::null(),
            0,
        );
        if count == 0 {
            return Err("path casing failed".into());
        }
        Ok(String::from_utf16(&output[..count as usize])?)
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn cli_options_may_precede_commands_without_opening_gui() {
        let args = |values: &[&str]| values.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(super::cli_mode(&args(&["--state-dir", "state", "status"])));
        assert!(!super::cli_mode(&args(&["--state-dir", "state"])));
        assert!(!super::cli_mode(&args(&[
            "--native-host",
            "--state-dir",
            "state"
        ])));
    }
    #[test]
    fn legacy_invariant_casing_is_not_contextual_or_expanding() {
        assert_eq!(super::invariant_lowercase("D:İΟΣ").unwrap(), "d:İοσ");
    }
}
