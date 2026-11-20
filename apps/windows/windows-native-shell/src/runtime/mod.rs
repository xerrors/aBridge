mod authorization;
mod client;
mod computer;
mod driver;
mod executor;
mod local_control;
mod protocol;
pub mod storage;
mod view;
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::{mpsc, Mutex};
static OUTPUT_CLOSED: AtomicBool = AtomicBool::new(false);
struct Host {
    dir: PathBuf,
    client: Option<client::Sender>,
    task: Option<tokio::task::JoinHandle<Result<()>>>,
    control: Option<tokio::task::JoinHandle<()>>,
    busy: bool,
    quitting: bool,
    cancel: Arc<AtomicBool>,
    last_error: String,
}
impl Host {
    async fn start(&mut self) -> Result<()> {
        if self.task.as_ref().is_some_and(|t| !t.is_finished()) {
            return Ok(());
        }
        if let Some(t) = self.control.take() {
            t.abort();
            let _ = t.await;
        }
        let cfg = storage::config(&self.dir)?;
        let key = storage::credential(&self.dir, cfg["url"].as_str().unwrap())?;
        let (tx, rx) = mpsc::unbounded_channel();
        self.control = Some(local_control::serve(self.dir.clone(), tx.clone()).await?);
        self.client = Some(tx);
        let dir = self.dir.clone();
        self.task = Some(tokio::spawn(
            async move { client::run(dir, cfg, key, rx).await },
        ));
        Ok(())
    }
    async fn stop(&mut self) -> Result<()> {
        if self.task.as_ref().is_some_and(|t| !t.is_finished()) {
            if let Some(tx) = &self.client {
                // Unbind can acknowledge before its final cleanup finishes. In that
                // interval the task may exit without receiving another shutdown;
                // its completion below is the authoritative stop confirmation.
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    client::command(tx, "shutdown", json!({})),
                )
                .await;
            }
            if let Some(t) = self.task.as_mut() {
                tokio::time::timeout(std::time::Duration::from_secs(15), t).await???;
            }
        }
        self.task = None;
        self.client = None;
        if let Some(t) = self.control.take() {
            t.abort();
            let _ = t.await;
        }
        Ok(())
    }
    // Fast activity polling must only consult the actor's current in-memory state.
    async fn snapshot(&self) -> Value {
        if let Some(tx) = &self.client {
            tokio::time::timeout(
                std::time::Duration::from_millis(750),
                client::command(tx, "status", json!({})),
            )
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(json!({"connection":"offline"}))
        } else {
            json!({"connection":"offline"})
        }
    }
    fn present(&self, mut s: Value) -> Value {
        // The old shell reads persisted revocation for `bound`, including while
        // an unbind is still waiting for its server acknowledgement. Keep that
        // check at the full-status cadence, not the 200 ms activity cadence.
        let cfg = storage::config(&self.dir).unwrap_or(json!({}));
        let o = s.as_object_mut().unwrap();
        o.insert(
            "bound".into(),
            json!(cfg["url"].is_string() && cfg["revoked"] != true),
        );
        o.entry("url").or_insert_with(|| cfg["url"].clone());
        o.entry("requested_capabilities")
            .or_insert_with(|| cfg["capabilities"].clone());
        o.entry("paused").or_insert_with(|| cfg["paused"].clone());
        o.insert("version".into(), json!(env!("ABRIDGE_VERSION")));
        o.insert("busy".into(), json!(self.busy));
        o.insert("local_error".into(), json!(self.last_error));
        s["view"] = view::view(&s);
        s
    }
    async fn status(&self) -> Value {
        self.present(self.snapshot().await)
    }
}
fn emit(v: Value) {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if writeln!(out, "{v}").and_then(|_| out.flush()).is_err() {
        OUTPUT_CLOSED.store(true, Ordering::SeqCst);
    }
}
pub fn run_host(state: PathBuf, parent_pid: u32) -> Result<()> {
    let own = std::process::id();
    std::env::set_var(
        "ABRIDGE_INDICATOR_PID",
        if parent_pid > 0 { parent_pid } else { own }.to_string(),
    );
    std::env::set_var("ABRIDGE_PROTECTED_PIDS", format!("{own},{parent_pid}"));
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(host(state, parent_pid))
}
async fn host(dir: PathBuf, parent_pid: u32) -> Result<()> {
    storage::directory(&dir)?;
    let shared = Arc::new(Mutex::new(Host {
        dir,
        client: None,
        task: None,
        control: None,
        busy: false,
        quitting: false,
        cancel: Arc::new(AtomicBool::new(false)),
        last_error: String::new(),
    }));
    let _ = shared.lock().await.start().await;
    let (tx, mut rx) = mpsc::channel(32);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        loop {
            let mut line = Vec::new();
            use std::io::Read;
            match reader.by_ref().take(65537).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 65536 => break,
                Ok(_) => {
                    if tx.blocking_send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let mut last = 0u64;
    let mut refresh = tokio::time::interval(std::time::Duration::from_millis(200));
    let mut last_status = std::time::Instant::now() - std::time::Duration::from_secs(2);
    let (completed_tx, mut completed) = mpsc::unbounded_channel::<(u64, String, Result<Value>)>();
    let mut outstanding = 0;
    loop {
        tokio::select! {
                line=rx.recv()=>{let Some(line)=line else{break;};let candidate=serde_json::from_slice::<Value>(&line).unwrap_or(Value::Null);let id=candidate["id"].as_u64().filter(|i|*i>0&&*i<=9007199254740991).unwrap_or(0);let valid=validate_request(&candidate);if valid.is_err(){emit(json!({"id":id,"ok":false,"error":"请求无效。"}));continue;}
        if id<=last||outstanding>=32{emit(json!({"id":id,"ok":false,"error":"请求重复或客户端正忙。"}));continue;}last=id;outstanding+=1;let host=shared.clone();let tx=completed_tx.clone();tokio::spawn(async move{let name=candidate["action"].as_str().unwrap().to_owned();let result=action(host,&name,candidate["args"].clone()).await;let _=tx.send((id,name,result));});},
                Some((id,name,result))=completed.recv()=>{outstanding-=1;let quitting=name=="quit"&&result.is_ok();match result{Ok(v)=>{let mut reply=json!({"id":id,"ok":true});if let Some(o)=v.as_object(){reply.as_object_mut().unwrap().extend(o.clone());}emit(reply);},Err(e)=>emit(json!({"id":id,"ok":false,"error":e.to_string()}))};if quitting{break;}last_status=std::time::Instant::now()-std::time::Duration::from_secs(2);},
                _=refresh.tick()=>{if OUTPUT_CLOSED.load(Ordering::SeqCst)||(parent_pid>0&&!parent_alive(parent_pid)){break;}
        if let Ok(h)=shared.try_lock(){let s=h.snapshot().await;emit(json!({"event":"activity","active":s["connection"]=="online"&&s["paused"]!=true&&s["desktop_active_until"].as_f64().unwrap_or(0.)>storage::now()}));if last_status.elapsed().as_secs()>=2{emit(json!({"event":"status","status":h.present(s)}));last_status=std::time::Instant::now();}}}
                }
    }
    let mut h = shared.lock().await;
    h.cancel.store(true, Ordering::SeqCst);
    h.stop().await?;
    Ok(())
}
async fn action(shared: Arc<Mutex<Host>>, name: &str, args: Value) -> Result<Value> {
    if name == "bind" {
        let (url, cancel, dir) = {
            let mut h = shared.lock().await;
            ensure!(!h.quitting, "客户端正在退出。");
            ensure!(!h.busy, "正在连接，请先完成或取消当前授权。");
            if let Ok(c) = storage::config(&h.dir) {
                ensure!(
                    c["revoked"] == true,
                    "此电脑已绑定。请先解除绑定再更换服务器。"
                );
            }
            let url = storage::normalize_url(
                args["url"].as_str().context("服务地址无效")?,
                args["http_confirmed_origin"].as_str(),
            )?;
            h.busy = true;
            h.cancel = Arc::new(AtomicBool::new(false));
            (url, h.cancel.clone(), h.dir.clone())
        };
        let result = async {
            let key = if let Some(key) = args["device_key"].as_str() {
                verify_token_cancellable(&url, key, &cancel).await?;
                key.to_owned()
            } else {
                authorization::authorize(
                    &url,
                    args["http_confirmed_origin"].as_str(),
                    cancel.clone(),
                    Arc::new(emit),
                )
                .await?
            };
            ensure!(!cancel.load(Ordering::SeqCst), "授权已取消。");
            let mut h = shared.lock().await;
            h.stop().await?;
            ensure!(!cancel.load(Ordering::SeqCst), "授权已取消。");
            let mut caps = json!({"screen":false,"input":false,"shell":false,"files":false});
            for c in ["screen", "input", "shell", "files"] {
                caps[c] = json!(args["capabilities"][c] == true);
            }
            storage::bind(
                &dir,
                &url,
                &key,
                caps,
                args["http_confirmed_origin"].as_str(),
            )?;
            h.start().await?;
            Ok(json!({"bound":true}))
        }
        .await;
        shared.lock().await.busy = false;
        return result;
    }
    let mut h = shared.lock().await;
    ensure!(!h.quitting, "客户端正在退出。");
    match name {
        "status" => Ok(h.status().await),
        "connect" => {
            h.start().await?;
            Ok(json!({}))
        }
        "cancel" => {
            h.cancel.store(true, Ordering::SeqCst);
            Ok(json!({}))
        }
        "quit" => {
            h.quitting = true;
            h.cancel.store(true, Ordering::SeqCst);
            if let Err(error) = h.stop().await {
                h.quitting = false;
                return Err(error);
            }
            Ok(json!({}))
        }
        _ => {
            let tx = h
                .client
                .as_ref()
                .context("设备进程未运行，请重连。")?
                .clone();
            drop(h);
            client::command(&tx, name, args).await
        }
    }
}
fn validate_request(v: &Value) -> Result<()> {
    protocol::parse("windowsShellRequest", v.clone())?;
    Ok(())
}
async fn verify_token_cancellable(url: &str, key: &str, cancel: &AtomicBool) -> Result<()> {
    tokio::select! {
        biased;
        _ = async {while !cancel.load(Ordering::SeqCst) {tokio::time::sleep(std::time::Duration::from_millis(50)).await;}} => anyhow::bail!("授权已取消。"),
        result=authorization::verify_token(url,key)=>result,
    }
}
fn parent_alive(pid: u32) -> bool {
    unsafe {
        use windows_sys::Win32::{Foundation::*, System::Threading::*};
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0;
        let alive = GetExitCodeProcess(h, &mut code) != 0 && code == 259;
        CloseHandle(h);
        alive
    }
}
pub fn run_cli(args: &[String]) -> Result<()> {
    cli::run(args)
}
mod cli;
#[cfg(test)]
mod host_tests {
    use super::*;
    #[tokio::test]
    async fn stop_accepts_completed_cleanup_when_shutdown_reply_closes() {
        let (tx, mut rx) = mpsc::unbounded_channel::<client::Command>();
        let task = tokio::spawn(async move {
            // Final unbind cleanup can finish before another shutdown is handled.
            let command = rx.recv().await.unwrap();
            assert_eq!(command.name, "shutdown");
            drop(command);
            Ok(())
        });
        let mut host = Host {
            dir: PathBuf::new(),
            client: Some(tx),
            task: Some(task),
            control: None,
            busy: false,
            quitting: false,
            cancel: Arc::new(AtomicBool::new(false)),
            last_error: String::new(),
        };
        host.stop().await.unwrap();
        assert!(host.task.is_none());
        assert!(host.client.is_none());
    }
    #[tokio::test]
    async fn live_snapshot_preserves_actor_state_and_persisted_revocation() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = storage::bind(
            dir.path(),
            "https://example.test",
            "abr_device_fixture",
            json!({"screen":false,"input":false,"shell":true,"files":false}),
            None,
        )
        .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel::<client::Command>();
        let actor = tokio::spawn(async move {
            while let Some(cmd) = rx.recv().await {
                let _=cmd.reply.send(Ok(json!({"connection":"online","url":"https://example.test","requested_capabilities":{"shell":true},"paused":true,"updated_at":storage::now(),"desktop_active_until":storage::now()+30.})));
            }
        });
        let h = Host {
            dir: dir.path().into(),
            client: Some(tx),
            task: None,
            control: None,
            busy: false,
            quitting: false,
            cancel: Arc::new(AtomicBool::new(false)),
            last_error: String::new(),
        };
        let status = h.status().await;
        assert_eq!(status["bound"], true);
        assert_eq!(status["paused"], true);
        cfg["revoked"] = json!(true);
        storage::write(&dir.path().join("config.json"), &cfg).unwrap();
        let snapshot = h.snapshot().await;
        assert_eq!(snapshot["connection"], "online");
        assert!(snapshot["desktop_active_until"].as_f64().unwrap() > storage::now());
        let revoked = h.present(snapshot);
        assert_eq!(revoked["bound"], false);
        assert_eq!(revoked["paused"], true);
        actor.abort();
    }
}
