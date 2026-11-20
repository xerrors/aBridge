//! The original, trusted Windows UIA/Win32 driver, hosted by system PowerShell.
use super::executor::{check, powershell, Cancel, ExecError, Result};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc::{self, Receiver},
    time::{Duration, Instant},
};

pub struct Driver {
    child: Option<Child>,
    input: Option<ChildStdin>,
    replies: Option<Receiver<Value>>,
    directory: Option<tempfile::TempDir>,
    sequence: u64,
    pub deadline: Option<Instant>,
    pub diagnostics: Value,
}
impl Default for Driver {
    fn default() -> Self {
        Self {
            child: None,
            input: None,
            replies: None,
            directory: None,
            sequence: 0,
            deadline: None,
            diagnostics: json!({"driver":{"ready":false},"permissions":{"checked":false,"screen":false,"input":false}}),
        }
    }
}
impl Driver {
    pub fn is_started(&self) -> bool {
        self.child.is_some()
    }
    fn start(&mut self) -> Result<()> {
        if self.child.is_some() {
            return Ok(());
        }
        let dir = tempfile::Builder::new()
            .prefix("abridge-native-")
            .tempdir()?;
        // Protect the directory before placing executable code or cancellation state in it.
        let protect="$p=$env:ABRIDGE_PRIVATE_DIR;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetAccessRuleProtection($true,$false);$a.SetOwner($sid);$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','ContainerInherit,ObjectInherit','None','Allow')));[System.IO.DirectoryInfo]::new($p).SetAccessControl($a)";
        let mut guard = Command::new(powershell())
            .args(["-NoProfile", "-NonInteractive", "-Command", protect])
            .env("ABRIDGE_PRIVATE_DIR", dir.path())
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        drop(guard.stdin.take());
        let protected = guard.wait_with_output()?;
        let status = protected.status;
        if !status.success() {
            return Err(ExecError::new(
                "driver_unavailable",
                "Cannot protect Windows driver directory",
            ));
        }
        let script = dir.path().join("host.ps1");
        std::fs::write(&script, include_bytes!("driver-host.ps1"))?;
        let mut child = Command::new(powershell())
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-MTA",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .env("ABRIDGE_CANCEL_FILE", dir.path().join("cancel"))
            .env(
                "ABRIDGE_OCCLUSION_DIAGNOSTIC",
                dir.path().join("last-occlusion.json"),
            )
            .env(
                "ABRIDGE_PROTECTED_PIDS",
                format!(
                    "{},{}",
                    std::process::id(),
                    std::env::var("ABRIDGE_PROTECTED_PIDS").unwrap_or_default()
                ),
            )
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match reader
                    .by_ref()
                    .take(40 * 1024 * 1024)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) | Err(_) => break,
                    _ => {}
                }
                if line.len() >= 40 * 1024 * 1024 {
                    break;
                }
                match serde_json::from_slice(&line) {
                    Ok(v) => {
                        if tx.send(v).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
        self.input = child.stdin.take();
        self.child = Some(child);
        self.replies = Some(rx);
        self.directory = Some(dir);
        Ok(())
    }
    pub fn call(&mut self, op: &str, args: Value, cancel: &Cancel) -> Result<Value> {
        check(cancel)?;
        if self.deadline.is_some_and(|t| Instant::now() >= t) {
            return Err(ExecError::new(
                "observation_timeout",
                "Observation deadline elapsed",
            ));
        }
        self.start()?;
        check(cancel)?;
        self.sequence += 1;
        let id = self.sequence;
        if writeln!(
            self.input.as_mut().unwrap(),
            "{}",
            json!({"id":id,"op":op,"args":args})
        )
        .and_then(|_| self.input.as_mut().unwrap().flush())
        .is_err()
        {
            self.shutdown();
            return Err(ExecError::unknown());
        }
        let start = Instant::now();
        let mut cancellation = None;
        loop {
            if (cancel.load(std::sync::atomic::Ordering::SeqCst)
                || self.deadline.is_some_and(|t| Instant::now() >= t)
                || start.elapsed() > Duration::from_secs(30))
                && cancellation.is_none()
            {
                let _ = std::fs::write(
                    self.directory.as_ref().unwrap().path().join("cancel"),
                    id.to_string(),
                );
                cancellation = Some(Instant::now());
            }
            if cancellation.is_some_and(|t: Instant| t.elapsed() > Duration::from_secs(5)) {
                self.shutdown();
                return Err(ExecError::unknown());
            }
            match self
                .replies
                .as_ref()
                .unwrap()
                .recv_timeout(Duration::from_millis(30))
            {
                Ok(v) => {
                    if v["id"].as_u64() != Some(id) {
                        continue;
                    }
                    if v["ok"] == true {
                        return Ok(v["data"].clone());
                    }
                    return Err(ExecError {
                        code: v["error"].as_str().unwrap_or("native_error").into(),
                        message: if v["error"] == "focus_changed" {
                            "Target window is not in the foreground or focus changed. Activate the intended existing application, then observe its window again.".into()
                        } else {
                            v["error"]
                                .as_str()
                                .unwrap_or("Windows driver failed")
                                .into()
                        },
                        status: v["outcome"].as_str().unwrap_or("outcome_unknown").into(),
                    });
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => {
                    self.shutdown();
                    return Err(ExecError::unknown());
                }
            }
        }
    }
    pub fn shutdown(&mut self) {
        self.input.take();
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.replies.take();
        self.directory.take();
    }
}
impl Drop for Driver {
    fn drop(&mut self) {
        self.shutdown();
    }
}
