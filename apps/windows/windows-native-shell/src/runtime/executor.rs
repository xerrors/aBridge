use super::computer::Computer;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::Read,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle, process::CommandExt},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
pub type Cancel = Arc<AtomicBool>;
pub type Output = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;
pub type Result<T> = std::result::Result<T, ExecError>;
#[derive(Debug, Clone)]
pub struct ExecError {
    pub code: String,
    pub message: String,
    pub status: String,
}
impl ExecError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: "refused".into(),
        }
    }
    pub fn unknown() -> Self {
        Self {
            code: "outcome_unknown".into(),
            message: "Windows helper reply was lost; observe again".into(),
            status: "outcome_unknown".into(),
        }
    }
}
impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ExecError {}
impl From<std::io::Error> for ExecError {
    fn from(e: std::io::Error) -> Self {
        Self {
            code: "execution_failed".into(),
            message: format!("Local access failed ({:?})", e.kind()),
            status: "failed".into(),
        }
    }
}
pub fn check(c: &Cancel) -> Result<()> {
    if c.load(Ordering::SeqCst) {
        Err(ExecError {
            code: "cancelled".into(),
            message: "Operation cancelled".into(),
            status: "cancelled".into(),
        })
    } else {
        Ok(())
    }
}
pub fn powershell() -> PathBuf {
    PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe")
}
fn regular_file(file: &File) -> Result<()> {
    // Metadata alone can describe DOS devices as files; reject pipes/devices before any I/O.
    let disk =
        unsafe { windows_sys::Win32::Storage::FileSystem::GetFileType(file.as_raw_handle()) }
            == windows_sys::Win32::Storage::FileSystem::FILE_TYPE_DISK;
    if !disk || !file.metadata()?.is_file() {
        return Err(ExecError::new(
            "unsupported_file_type",
            "File access requires a regular file",
        ));
    }
    Ok(())
}
pub fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .ok_or_else(|| ExecError::new("invalid_arguments", &format!("{key} must be a string")))
}
pub fn number(v: &Value, key: &str, default: u64, min: u64, max: u64) -> Result<u64> {
    let n = if v.get(key).is_some() {
        v[key].as_u64()
    } else {
        Some(default)
    };
    n.filter(|n| *n >= min && *n <= max)
        .ok_or_else(|| ExecError::new("invalid_arguments", &format!("Invalid {key}")))
}
fn expand(s: &str) -> Result<PathBuf> {
    if s.contains('\0') || s.starts_with("\\\\.\\") || s.starts_with("\\\\?\\GLOBALROOT") {
        return Err(ExecError::new(
            "unsupported_file_type",
            "File access requires an ordinary path",
        ));
    }
    let home = std::env::var_os("USERPROFILE")
        .ok_or_else(|| ExecError::new("invalid_cwd", "Home unavailable"))?;
    let p = if s == "~" {
        PathBuf::from(home)
    } else if s.starts_with("~/") || s.starts_with("~\\") {
        PathBuf::from(home).join(&s[2..])
    } else {
        PathBuf::from(s)
    };
    Ok(std::path::absolute(p)?)
}
pub struct Executor {
    computer: Mutex<Computer>,
    running: Mutex<HashMap<String, (Cancel, String, String)>>,
    cached_diagnostics: Mutex<Value>,
    output: Output,
}
impl Executor {
    pub fn new(_state_dir: PathBuf, output: Output) -> Self {
        Self {
            computer: Mutex::new(Computer::default()),
            running: Mutex::new(HashMap::new()),
            cached_diagnostics: Mutex::new(
                json!({"driver":{"ready":false},"permissions":{"checked":false,"screen":false,"input":false}}),
            ),
            output,
        }
    }
    pub fn execute(
        &self,
        id: &str,
        tool: &str,
        args: &Value,
        session: &str,
        cancel: Cancel,
    ) -> Result<Value> {
        check(&cancel)?;
        self.running
            .lock()
            .unwrap()
            .insert(id.into(), (cancel.clone(), tool.into(), session.into()));
        let result = self.run(id, tool, args, session, &cancel);
        self.running.lock().unwrap().remove(id);
        result
    }
    fn run(
        &self,
        id: &str,
        tool: &str,
        args: &Value,
        session: &str,
        cancel: &Cancel,
    ) -> Result<Value> {
        if tool.starts_with("computer_") {
            return self
                .computer
                .lock()
                .unwrap()
                .execute(tool, args, session, cancel);
        }
        if tool == "command_execute" {
            return self.command(id, args, cancel);
        }
        let path = expand(string(args, "path")?)?;
        match tool {
            "files_list" => {
                let limit = number(args, "limit", 200, 1, 500)? as usize;
                let mut entries = Vec::new();
                let mut truncated = false;
                for entry in std::fs::read_dir(&path)? {
                    check(cancel)?;
                    if entries.len() == limit {
                        truncated = true;
                        break;
                    }
                    let entry = entry?;
                    let m = std::fs::symlink_metadata(entry.path())?;
                    entries.push(json!({"name":entry.file_name().to_string_lossy(),"is_directory":m.is_dir(),"is_symlink":m.is_symlink(),"size":m.len(),"modified_at":m.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs_f64()}));
                }
                entries.sort_by_key(|v| v["name"].as_str().unwrap_or("").to_lowercase());
                Ok(json!({"path":path,"entries":entries,"truncated":truncated}))
            }
            "file_read" => {
                let max = number(args, "max_bytes", 1048576, 1, 1048576)?;
                let file = File::open(&path)?;
                regular_file(&file)?;
                let mut bytes = Vec::new();
                file.take(max + 1).read_to_end(&mut bytes)?;
                check(cancel)?;
                if bytes.len() as u64 > max {
                    return Err(ExecError::new(
                        "file_too_large",
                        "File exceeds the requested size limit",
                    ));
                }
                let size = bytes.len();
                let content = String::from_utf8(bytes).map_err(|_| {
                    ExecError::new("unsupported_encoding", "File must contain UTF-8 text")
                })?;
                Ok(
                    json!({"path":path,"size":size,"content":content.strip_prefix('\u{feff}').unwrap_or(&content)}),
                )
            }
            "file_write" => {
                let content = string(args, "content")?;
                if content.len() > 1048576 {
                    return Err(ExecError::new(
                        "file_too_large",
                        "Content exceeds the 1048576 byte limit",
                    ));
                }
                let overwrite = args
                    .get("overwrite")
                    .map(|v| {
                        v.as_bool().ok_or_else(|| {
                            ExecError::new("invalid_arguments", "overwrite must be boolean")
                        })
                    })
                    .transpose()?
                    .unwrap_or(false);
                let mut opts = OpenOptions::new();
                opts.write(true)
                    .create(true)
                    .create_new(!overwrite)
                    .custom_flags(0);
                let mut file = opts.open(&path)?;
                regular_file(&file)?;
                check(cancel)?;
                if overwrite {
                    file.set_len(0)?;
                }
                std::io::Write::write_all(&mut file, content.as_bytes())?;
                Ok(json!({"path":path,"size":content.len(),"overwritten":overwrite}))
            }
            _ => Err(ExecError::new(
                "unknown_tool",
                "This desktop device does not provide that tool",
            )),
        }
    }
    fn command(&self, id: &str, args: &Value, cancel: &Cancel) -> Result<Value> {
        let command = string(args, "command")?;
        let timeout = args["timeout"].as_f64().unwrap_or(30.);
        if !(1. ..=120.).contains(&timeout) {
            return Err(ExecError::new(
                "invalid_arguments",
                "timeout must be between 1 and 120 seconds",
            ));
        }
        let cwd = expand(args["cwd"].as_str().unwrap_or("~"))?;
        if !cwd.is_dir() {
            return Err(ExecError::new(
                "invalid_cwd",
                "Working directory does not exist or is inaccessible",
            ));
        }
        let mut cmd = Command::new(powershell());
        cmd.env_clear();
        for key in [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "LANG",
            "TMPDIR",
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
            "PATHEXT",
            "COMSPEC",
        ] {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        if let Some(env) = args.get("env") {
            let map = env.as_object().ok_or_else(|| {
                ExecError::new(
                    "invalid_arguments",
                    "env must contain string names and values",
                )
            })?;
            for (k, v) in map {
                let value = v.as_str().ok_or_else(|| {
                    ExecError::new("invalid_arguments", "Invalid environment value")
                })?;
                if k.is_empty() || k.contains(['=', '\0']) || value.contains('\0') {
                    return Err(ExecError::new(
                        "invalid_arguments",
                        "Invalid environment value",
                    ));
                }
                cmd.env(k, value);
            }
        }
        let script = include_str!("command-host.ps1").replace(
            &STANDARD.encode("ABRIDGE_COMMAND_PLACEHOLDER"),
            &STANDARD.encode(command),
        );
        let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        check(cancel)?;
        let mut child = cmd
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &STANDARD.encode(bytes),
            ])
            .current_dir(cwd)
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        drop(child.stdin.take());
        let capture = |mut stream: Box<dyn Read + Send>, name: &'static str| {
            let output = self.output.clone();
            let id = id.to_owned();
            let cancel = cancel.clone();
            std::thread::spawn(move || {
                let mut kept = Vec::new();
                let mut buf = [0u8; 8192];
                let mut truncated = false;
                let mut pending = Vec::new();
                loop {
                    let n = match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let take = n.min(131072 - kept.len());
                    kept.extend_from_slice(&buf[..take]);
                    truncated |= take < n;
                    pending.extend_from_slice(&buf[..take]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid > 0 {
                        if !cancel.load(Ordering::SeqCst) {
                            output(&id, name, &String::from_utf8_lossy(&pending[..valid]));
                        }
                        pending.drain(..valid);
                    }
                    if pending.len() > 4 {
                        if !cancel.load(Ordering::SeqCst) {
                            output(&id, name, &String::from_utf8_lossy(&pending));
                        }
                        pending.clear();
                    }
                }
                if !pending.is_empty() && !cancel.load(Ordering::SeqCst) {
                    output(&id, name, &String::from_utf8_lossy(&pending));
                }
                let text = String::from_utf8_lossy(&kept).into_owned();
                (text, truncated)
            })
        };
        let out = capture(Box::new(child.stdout.take().unwrap()), "stdout");
        let err = capture(Box::new(child.stderr.take().unwrap()), "stderr");
        let started = Instant::now();
        let mut timed_out = false;
        let code = loop {
            if let Some(status) = child.try_wait()? {
                break status.code().unwrap_or(-1);
            }
            if cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs_f64(timeout)
            {
                timed_out = started.elapsed() > Duration::from_secs_f64(timeout);
                let taskkill = PathBuf::from(
                    std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
                )
                .join("System32/taskkill.exe");
                let _ = Command::new(taskkill)
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                let _ = child.kill();
                let _ = child.wait();
                break -1;
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let (out, tr1) = out.join().unwrap_or_default();
        let (err, tr2) = err.join().unwrap_or_default();
        check(cancel)?;
        Ok(
            json!({"exit_code":code,"stdout":out,"stderr":err,"truncated":tr1||tr2,"timed_out":timed_out}),
        )
    }
    pub fn close_session(&self, id: &str) {
        for (c, _, session) in self.running.lock().unwrap().values() {
            if session == id {
                c.store(true, Ordering::SeqCst);
            }
        }
        self.computer.lock().unwrap().close_session(id);
    }
    pub fn invalidate(&self, id: &str) {
        self.computer.lock().unwrap().invalidate(id);
    }
    pub fn stop_computer(&self) {
        for (c, tool, _) in self.running.lock().unwrap().values() {
            if tool.starts_with("computer_") {
                c.store(true, Ordering::SeqCst);
            }
        }
        self.computer.lock().unwrap().stop();
    }
    pub fn stop(&self) {
        for (c, _, _) in self.running.lock().unwrap().values() {
            c.store(true, Ordering::SeqCst);
        }
        self.computer.lock().unwrap().stop();
    }
    pub fn shutdown(&self) {
        self.stop();
        self.computer.lock().unwrap().driver.shutdown();
    }
    pub fn diagnostics(&self, initialize: bool) -> Value {
        if !initialize {
            return self.cached_diagnostics.lock().unwrap().clone();
        }
        let mut c = self.computer.lock().unwrap();
        if initialize {
            c.driver.diagnostics=c.driver.call("diagnostics",json!({}),&Arc::new(AtomicBool::new(false))).unwrap_or_else(|e|json!({"driver":{"ready":false,"error":e.code},"permissions":{"checked":true,"input":false,"screen":false}}));
        }
        let value = c.driver.diagnostics.clone();
        *self.cached_diagnostics.lock().unwrap() = value.clone();
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf8_create_only_and_cancellation() {
        let root = tempfile::tempdir().unwrap();
        let executor = Executor::new(root.path().into(), Arc::new(|_, _, _| {}));
        let file = root.path().join("中文.txt");
        let cancel = Arc::new(AtomicBool::new(false));
        executor
            .execute(
                "write",
                "file_write",
                &json!({"path":file,"content":"中文 😀"}),
                "s",
                cancel.clone(),
            )
            .unwrap();
        assert!(executor
            .execute(
                "duplicate",
                "file_write",
                &json!({"path":file,"content":"wrong"}),
                "s",
                cancel.clone()
            )
            .is_err());
        assert_eq!(
            executor
                .execute(
                    "read",
                    "file_read",
                    &json!({"path":file}),
                    "s",
                    cancel.clone()
                )
                .unwrap()["content"],
            "中文 😀"
        );
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            executor
                .execute(
                    "cancelled",
                    "file_write",
                    &json!({"path":file,"content":"wrong","overwrite":true}),
                    "s",
                    cancel
                )
                .unwrap_err()
                .status,
            "cancelled"
        );
        assert_eq!(std::fs::read_to_string(file).unwrap(), "中文 😀");
    }
    #[test]
    fn invalid_encoding_and_bounded_reads() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("bytes");
        std::fs::write(&file, [255]).unwrap();
        let e = Executor::new(root.path().into(), Arc::new(|_, _, _| {}));
        let cancel = Arc::new(AtomicBool::new(false));
        assert_eq!(
            e.execute(
                "bad",
                "file_read",
                &json!({"path":file}),
                "s",
                cancel.clone()
            )
            .unwrap_err()
            .code,
            "unsupported_encoding"
        );
        std::fs::write(&file, b"123").unwrap();
        assert_eq!(
            e.execute(
                "large",
                "file_read",
                &json!({"path":file,"max_bytes":2}),
                "s",
                cancel
            )
            .unwrap_err()
            .code,
            "file_too_large"
        );
    }
}
