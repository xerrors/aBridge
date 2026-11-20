use super::*;
use std::{collections::HashMap, path::Path};
pub fn run(args: &[String]) -> Result<()> {
    let mut options = HashMap::<String, String>::new();
    let mut pos = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if ["--state-dir", "--capability", "--enabled", "--name"].contains(&a.as_str()) {
            i += 1;
            options.insert(
                a.clone(),
                args.get(i).context("Missing option value")?.clone(),
            );
        } else if [
            "--help",
            "-h",
            "--version",
            "--stdin",
            "--json",
            "--if-desktop-active",
        ]
        .contains(&a.as_str())
        {
            options.insert(a.clone(), String::new());
        } else {
            ensure!(!a.starts_with('-'), "Unknown option");
            pos.push(a.clone());
        }
        i += 1;
    }
    if options.contains_key("--version") {
        println!("{}", env!("ABRIDGE_VERSION"));
        return Ok(());
    }
    if options.contains_key("--help") || options.contains_key("-h") {
        println!("Usage: aBridge <run|authorize --stdin|configure --stdin|startup-check|status|control <command>|diagnose> [--state-dir <dir>]");
        return Ok(());
    }
    let dir = std::path::absolute(
        options
            .get("--state-dir")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_else(|_| {
                    format!(
                        "{}\\AppData\\Local",
                        std::env::var("USERPROFILE").unwrap_or_default()
                    )
                }))
                .join("aBridge")
            }),
    )?;
    let name = pos.first().map(String::as_str).unwrap_or("status");
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(async {
            match name {
                "startup-check" => emit(json!({"ready":true})),
                "run" => {
                    let cfg = storage::config(&dir)?;
                    let key = storage::credential(&dir, cfg["url"].as_str().unwrap())?;
                    let (tx, rx) = mpsc::unbounded_channel();
                    let control = local_control::serve(dir.clone(), tx.clone()).await?;
                    let parent = std::env::var("ABRIDGE_PARENT_PID")
                        .ok()
                        .and_then(|s| s.parse::<u32>().ok());
                    let monitor = tokio::spawn(async move {
                        if let Some(pid) = parent {
                            while parent_alive(pid) {
                                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            }
                            let _ = client::command(&tx, "shutdown", json!({})).await;
                        }
                    });
                    let r = client::run(dir, cfg, key, rx).await;
                    monitor.abort();
                    control.abort();
                    r?;
                }
                "configure" => {
                    ensure!(
                        options.contains_key("--stdin"),
                        "Use configure --stdin; credentials must not be command-line arguments"
                    );
                    let data = tokio::task::spawn_blocking(|| -> Result<Value> {
                        use std::io::Read;
                        let mut b = Vec::new();
                        std::io::stdin().take(65537).read_to_end(&mut b)?;
                        ensure!(b.len() <= 65536, "Input exceeds 64 KiB");
                        Ok(serde_json::from_slice(&b)?)
                    })
                    .await??;
                    let url = storage::normalize_url(
                        data["url"]
                            .as_str()
                            .context("url and device_key are required")?,
                        data["http_confirmed_origin"].as_str(),
                    )?;
                    let key = data["device_key"]
                        .as_str()
                        .context("url and device_key are required")?;
                    authorization::verify_token(&url, key).await?;
                    let caps = capabilities(data.get("capabilities"))?;
                    let mut cfg = storage::bind(
                        &dir,
                        &url,
                        key,
                        caps,
                        data["http_confirmed_origin"].as_str(),
                    )?;
                    cfg["ok"] = json!(true);
                    emit(cfg);
                }
                "authorize" => {
                    ensure!(options.contains_key("--stdin"), "Use authorize --stdin");
                    authorize(&dir).await?;
                }
                "status" => {
                    let v = match local_control::request(&dir, &json!({"command":"status"})).await {
                        Ok(v) => v,
                        Err(_) => {
                            let mut s =
                                storage::read(&dir.join("status.json")).unwrap_or(json!({}));
                            if !s.is_object() {
                                s = json!({});
                            }
                            s["connection"] = json!("offline");
                            s["active_operations"] = json!(0);
                            s
                        }
                    };
                    emit(v);
                }
                "diagnose" => {
                    let e = executor::Executor::new(dir, Arc::new(|_, _, _| {}));
                    emit(e.diagnostics(true));
                    e.shutdown();
                }
                "control" | "pause" | "resume" | "stop" | "unbind" => {
                    let operation = if name == "control" {
                        pos.get(1)
                            .context("A local control command is required")?
                            .as_str()
                    } else {
                        name
                    };
                    let mut request = json!({"command":operation});
                    if options.contains_key("--if-desktop-active") {
                        request["if_desktop_active"] = json!(true);
                    }
                    for option in ["capability", "name"] {
                        if let Some(s) = options.get(&format!("--{option}")) {
                            request[option] = json!(s);
                        }
                    }
                    if let Some(e) = options.get("--enabled") {
                        ensure!(
                            e == "true" || e == "false",
                            "--enabled must be true or false"
                        );
                        request["enabled"] = json!(e == "true");
                    }
                    let mut v = local_control::request(&dir, &request).await?;
                    v["ok"] = json!(true);
                    emit(v);
                }
                _ => anyhow::bail!("Unknown client command: {name}"),
            };
            Ok(())
        })
}
fn capabilities(v: Option<&Value>) -> Result<Value> {
    let mut caps = json!({"screen":false,"input":false,"shell":false,"files":false});
    if let Some(v) = v {
        let o = v.as_object().context("Invalid desktop binding")?;
        for (k, v) in o {
            ensure!(
                ["screen", "input", "shell", "files"].contains(&k.as_str()) && v.is_boolean(),
                "Invalid desktop binding"
            );
            caps[k] = v.clone();
        }
    }
    Ok(caps)
}
async fn authorize(dir: &Path) -> Result<()> {
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let (tx, mut rx) = mpsc::channel(2);
    std::thread::spawn(move || {
        use std::io::Read;
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        loop {
            let mut line = Vec::new();
            match reader.by_ref().take(65537).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 65536 => break,
                _ => {
                    if tx.blocking_send(line).is_err() {
                        break;
                    }
                }
            }
        }
        signal.store(true, Ordering::SeqCst);
    });
    let parent = std::env::var("ABRIDGE_PARENT_PID")
        .ok()
        .and_then(|s| s.parse::<u32>().ok());
    let monitor_cancel = cancel.clone();
    let monitor = tokio::spawn(async move {
        let start = std::time::Instant::now();
        while !monitor_cancel.load(Ordering::SeqCst) {
            if start.elapsed().as_secs() >= 300 || parent.is_some_and(|p| !parent_alive(p)) {
                monitor_cancel.store(true, Ordering::SeqCst);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    });
    let result = async {
        let start = protocol::parse("deviceBindingInput", next(&mut rx, &cancel).await?)?;
        let url = storage::normalize_url(
            start["url"].as_str().context("Invalid server")?,
            start["http_confirmed_origin"].as_str(),
        )?;
        let key = if let Some(k) = start["device_key"].as_str() {
            verify_token_cancellable(&url, k, &cancel).await?;
            k.to_owned()
        } else {
            authorization::authorize(
                &url,
                start["http_confirmed_origin"].as_str(),
                cancel.clone(),
                Arc::new(|mut v| {
                    v["authorization_url"] = v["url"].take();
                    v.as_object_mut().unwrap().remove("url");
                    emit(v);
                }),
            )
            .await?
        };
        emit(json!({"event":"ready"}));
        let commit = next(&mut rx, &cancel).await?;
        ensure!(
            commit["command"] == "commit" && commit.as_object().is_some_and(|o| o.len() == 2),
            "Invalid commit"
        );
        let caps = capabilities(Some(&commit["capabilities"]))?;
        ensure!(
            !cancel.load(Ordering::SeqCst),
            "授权已取消或过期，请重新发起"
        );
        storage::bind(
            dir,
            &url,
            &key,
            caps,
            start["http_confirmed_origin"].as_str(),
        )?;
        emit(json!({"event":"complete","ok":true,"url":url}));
        Ok(())
    }
    .await;
    monitor.abort();
    if let Err(ref e) = result {
        emit(json!({"event":"error","error":format!("{e}")}));
    }
    result
}
async fn next(rx: &mut mpsc::Receiver<Vec<u8>>, cancel: &AtomicBool) -> Result<Value> {
    loop {
        ensure!(
            !cancel.load(Ordering::SeqCst),
            "授权已取消或过期，请重新发起"
        );
        tokio::select! {v=rx.recv()=>return Ok(serde_json::from_slice(&v.context("授权已取消")?)?),_=tokio::time::sleep(std::time::Duration::from_millis(100))=>{}}
    }
}
