use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    os::windows::process::CommandExt,
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, SyncSender},
    thread,
    time::{Duration, Instant},
};

pub enum Message {
    Data(Value),
    Closed,
}
pub struct Pending {
    pub action: String,
    pub started: Instant,
    pub control: u16,
}
pub struct Host {
    child: Child,
    input: Option<SyncSender<(String, Instant)>>,
    pub messages: Receiver<Message>,
    pub pending: HashMap<u64, Pending>,
    sequence: u64,
    graceful: bool,
}
impl Host {
    pub fn start(base: &Path, state: &Path) -> std::io::Result<Self> {
        let mut child = Command::new(base.join("aBridge.exe"))
            .arg("--native-host")
            .arg("--state-dir")
            .arg(state)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .current_dir(base)
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let (tx, messages) = mpsc::channel();
        let (writer, writes) = mpsc::sync_channel::<(String, Instant)>(32);
        let failures = tx.clone();
        thread::spawn(move || {
            while let Ok((line, deadline)) = writes.recv() {
                if Instant::now() >= deadline {
                    continue;
                }
                if writeln!(stdin, "{line}")
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    let _ = failures.send(Message::Closed);
                    break;
                }
            }
        });
        let input = Some(writer);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = Vec::new();
                match Read::by_ref(&mut reader)
                    .take(131074)
                    .read_until(b'\n', &mut line)
                {
                    Ok(0) | Err(_) => break,
                    _ => {}
                }
                if line.len() > 131073 {
                    break;
                }
                match serde_json::from_slice(&line) {
                    Ok(v) => {
                        if tx.send(Message::Data(v)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send(Message::Closed);
        });
        thread::spawn(move || {
            let mut buf = [0; 4096];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input,
            messages,
            pending: HashMap::new(),
            sequence: 0,
            graceful: false,
        })
    }
    pub fn send(&mut self, action: &str, args: Value, control: u16) -> std::io::Result<()> {
        self.sequence += 1;
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| std::io::Error::other("设备内核已退出。"))?;
        let deadline = Instant::now() + Duration::from_secs(timeout(action));
        input
            .try_send((
                json!({"id": self.sequence, "action":action, "args":args}).to_string(),
                deadline,
            ))
            .map_err(|_| std::io::Error::other("本机连接不可用，请检查当前状态后再试。"))?;
        self.pending.insert(
            self.sequence,
            Pending {
                action: action.into(),
                started: Instant::now(),
                control,
            },
        );
        Ok(())
    }
    pub fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
    pub fn graceful(&mut self) {
        self.graceful = true;
    }
    pub fn expired(&mut self) -> Vec<Pending> {
        let ids: Vec<_> = self
            .pending
            .iter()
            .filter(|(_, p)| p.started.elapsed() > Duration::from_secs(timeout(&p.action)))
            .map(|(id, _)| *id)
            .collect();
        ids.into_iter()
            .filter_map(|id| self.pending.remove(&id))
            .collect()
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        self.input.take();
        let end = Instant::now() + Duration::from_millis(1500);
        while self.running() && Instant::now() < end {
            thread::sleep(Duration::from_millis(20));
        }
        if !self.graceful && self.running() {
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .status();
        }
    }
}

fn timeout(action: &str) -> u64 {
    match action {
        "bind" => 310,
        "quit" => 45,
        _ => 25,
    }
}
