use super::*;

#[test]
fn canonical_matches_javascript_and_hashes_received_arguments() {
    let frame = json!({"tool":"command_execute","arguments":{"command":"echo x"},"session_id":"s"});
    assert_eq!(
        request_hash(&frame),
        "0044ad6ed0685055fa06d3a2c41978ff12114fc20203034b9b97783133a6ddca"
    );
    assert_ne!(
        request_hash(&frame),
        request_hash(
            &json!({"tool":"command_execute","arguments":{"command":"echo x","timeout":30},"session_id":"s"})
        )
    );
    let value: Value =
        serde_json::from_str(r#"{"":1.0,"😀":-0.0,"a":[0.000001,0.0000001,1e21]}"#).unwrap();
    assert_eq!(
        canonical(&value),
        "{\"a\":[0.000001,1e-7,1e+21],\"😀\":0,\"\":1}"
    );
}

#[test]
fn input_requires_screen_only_for_the_shared_contract_cases() {
    assert!(required_capabilities("computer_open", &json!({})).contains(&"screen".into()));
    assert!(required_capabilities("computer_act", &json!({})).contains(&"screen".into()));
    assert!(
        !required_capabilities("computer_act", &json!({"observe_after":false}))
            .contains(&"screen".into())
    );
    assert!(required_capabilities(
        "computer_act",
        &json!({"observe_after":false,"screenshot":true})
    )
    .contains(&"screen".into()));
}

#[test]
fn receipts_preserve_known_results_and_never_replay_unknown_effects() {
    let receipt =
        json!({"input_dispatched":true,"observation_error":{"code":"observation_timeout"}});
    let (status, value, error) = outcome(Ok(receipt.clone()), false);
    assert_eq!(status, "executed");
    assert_eq!(value, receipt);
    assert!(error.is_null());
    let (status, value, error) = outcome(Ok(receipt), true);
    assert_eq!(status, "outcome_unknown");
    assert_eq!(value, json!({}));
    assert_eq!(error["code"], "operation_cancelled");
    assert_eq!(
        outcome(
            Err(ExecError::new("focus_changed", "target focus changed")),
            false
        )
        .0,
        "refused"
    );
    assert_eq!(
        outcome(Err(ExecError::unknown()), false).0,
        "outcome_unknown"
    );
}

fn fixture(url: String) -> (tempfile::TempDir, Value) {
    let directory = tempfile::tempdir().unwrap();
    storage::directory(directory.path()).unwrap();
    let config = json!({"url":url,"paused":false,"capabilities":{"screen":false,"input":false,"shell":true,"files":true}});
    storage::write(&directory.path().join("config.json"), &config).unwrap();
    (directory, config)
}
async fn bounded(tx: &Sender, name: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(2), command(tx, name, json!({})))
        .await
        .expect("local control must not wait for a network timeout")
        .unwrap()
}

#[tokio::test]
async fn stalled_websocket_upgrade_does_not_block_pause_or_shutdown() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (directory, config) = fixture(format!("http://{}", listener.local_addr().unwrap()));
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        directory.path().into(),
        config,
        "abr_device_fixture".into(),
        rx,
    ));
    let (_socket, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(bounded(&tx, "status").await["connection"], "connecting");
    assert_eq!(bounded(&tx, "pause").await["paused"], true);
    assert_eq!(bounded(&tx, "shutdown").await["shutdown_requested"], true);
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn missing_welcome_does_not_block_local_control() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (directory, config) = fixture(format!("http://{}", listener.local_addr().unwrap()));
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        directory.path().into(),
        config,
        "abr_device_fixture".into(),
        rx,
    ));
    let (socket, _) = listener.accept().await.unwrap();
    let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
    assert!(matches!(ws.next().await, Some(Ok(Message::Text(_)))));
    assert_eq!(bounded(&tx, "status").await["connection"], "connecting");
    assert_eq!(bounded(&tx, "pause").await["paused"], true);
    assert_eq!(bounded(&tx, "shutdown").await["shutdown_requested"], true);
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn local_control_preserves_error_codes_and_validation_order() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (directory, config) = fixture(format!("http://{}", listener.local_addr().unwrap()));
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        directory.path().into(),
        config,
        "abr_device_fixture".into(),
        rx,
    ));
    for (name, args, code, message) in [
        (
            "rename",
            json!({"name":""}),
            "invalid_name",
            "设备名称需为 1–120 个字符",
        ),
        (
            "rename",
            json!({"name":"Fixture"}),
            "device_offline",
            "请连接 Server 后再修改设备名称",
        ),
        (
            "capability",
            json!({"capability":"browser"}),
            "invalid_arguments",
            "Unknown desktop capability",
        ),
        (
            "not-a-command",
            json!({}),
            "invalid_arguments",
            "Unknown local command",
        ),
    ] {
        let error = tokio::time::timeout(Duration::from_secs(2), command(&tx, name, args))
            .await
            .unwrap()
            .unwrap_err();
        let typed = error
            .downcast_ref::<ControlError>()
            .expect("control errors retain their protocol code");
        assert_eq!(typed.code, code);
        assert_eq!(typed.message, message);
    }
    bounded(&tx, "shutdown").await;
    task.await.unwrap().unwrap();
}

#[test]
fn durable_status_ignores_clocks_but_preserves_diagnostics_and_activity_changes() {
    let (directory, _) = fixture("http://127.0.0.1:1".into());
    let mut previous = None;
    let mut status = json!({"updated_at":1,"desktop_active_until":31,"active_operations":1,"driver":{"ready":false},"capabilities":["shell"]});
    assert!(persist_status(directory.path(), &status, false, &mut previous).unwrap());
    let path = directory.path().join("status.json");
    let initial = std::fs::read(&path).unwrap();
    status["updated_at"] = json!(2);
    status["desktop_active_until"] = json!(32);
    assert!(!persist_status(directory.path(), &status, false, &mut previous).unwrap());
    assert_eq!(std::fs::read(&path).unwrap(), initial);
    status["driver"]["ready"] = json!(true);
    status["capabilities"] = json!(["shell", "screen"]);
    assert!(persist_status(directory.path(), &status, false, &mut previous).unwrap());
    status["desktop_active_until"] = json!(0);
    assert!(persist_status(directory.path(), &status, false, &mut previous).unwrap());
    assert!(persist_status(directory.path(), &status, true, &mut previous).unwrap());
}

#[tokio::test]
async fn idle_status_refresh_does_not_rewrite_the_durable_snapshot() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (directory, config) = fixture(format!("http://{}", listener.local_addr().unwrap()));
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        directory.path().into(),
        config,
        "abr_device_fixture".into(),
        rx,
    ));
    let (_socket, _) = listener.accept().await.unwrap();
    let path = directory.path().join("status.json");
    tokio::time::timeout(Duration::from_secs(2), async {
        while !path.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let initial = std::fs::read(&path).unwrap();
    let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
    tokio::time::sleep(Duration::from_millis(2200)).await;
    let live = bounded(&tx, "status").await;
    assert!(
        live["updated_at"].as_f64().unwrap()
            > serde_json::from_slice::<Value>(&initial).unwrap()["updated_at"]
                .as_f64()
                .unwrap()
    );
    assert_eq!(std::fs::read(&path).unwrap(), initial);
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        modified
    );
    bounded(&tx, "pause").await;
    // The next status command runs after the preceding event's durable write.
    bounded(&tx, "status").await;
    let paused: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(paused["paused"], true);
    bounded(&tx, "shutdown").await;
    task.await.unwrap().unwrap();
}

fn actor(dir: PathBuf, config: Value) -> (Client, mpsc::Receiver<Value>) {
    let (outgoing, received) = mpsc::channel(64);
    let (_, incoming) = mpsc::channel(64);
    let journal = storage::Journal::open(&dir).unwrap();
    let exec = Arc::new(Executor::new(dir.clone(), Arc::new(|_, _, _| {})));
    (
        Client {
            dir,
            config,
            key: "abr_device_fixture".into(),
            exec,
            journal,
            network: Some(Network {
                outgoing,
                incoming,
                task: tokio::spawn(std::future::pending()),
                alive: Arc::new(AtomicBool::new(true)),
            }),
            epoch: 7,
            sequence: 0,
            device: json!({"device_id":"fixture"}),
            server_caps: vec!["files".into(), "shell".into()],
            lease: Duration::from_secs(30),
            ack: Instant::now(),
            reconnect: Instant::now(),
            backoff: 1,
            heartbeat: Instant::now(),
            connection: "online",
            error: "",
            running: HashMap::new(),
            closed: HashSet::new(),
            pending: vec![],
            unbind: None,
            quitting: false,
            dirty: false,
        },
        received,
    )
}
fn dispatch(id: &str, sequence: u64, path: &std::path::Path) -> Value {
    json!({"type":"dispatch","protocol":"abridge/1","device_id":"fixture","connection_epoch":7,"device_credential_version":1,"sequence":sequence,"session_capabilities":["files"],"operation_id":id,"session_id":"session","tool":"file_write","arguments":{"path":path,"content":"once","overwrite":false},"expires_at":storage::now()+20.})
}

#[tokio::test]
async fn journal_prevents_write_replay_including_after_restart_and_unknown_result() {
    let (dir, config) = fixture("http://127.0.0.1:1".into());
    let path = dir.path().join("effect.txt");
    let (mut c, mut received) = actor(dir.path().into(), config.clone());
    let (done, mut completion) = mpsc::unbounded_channel();
    let first = dispatch("write-once", 1, &path);
    c.dispatch(first.clone(), &done).unwrap();
    complete(
        &mut c,
        tokio::time::timeout(Duration::from_secs(2), completion.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(received.recv().await.unwrap()["status"], "executed");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "once");
    c.dispatch(first.clone(), &done).unwrap();
    let duplicate = received.recv().await.unwrap();
    assert_eq!(duplicate["result"]["deduplicated"], true);
    assert_eq!(duplicate["status"], "executed");
    let mut conflict = first.clone();
    conflict["arguments"]["content"] = json!("different");
    c.dispatch(conflict, &done).unwrap();
    assert_eq!(
        received.recv().await.unwrap()["error"]["code"],
        "idempotency_conflict"
    );
    let uncertain = dispatch("in-flight", 2, &path);
    c.journal
        .start("in-flight", &request_hash(&uncertain))
        .unwrap();
    drop(c);
    let (mut restarted, mut received) = actor(dir.path().into(), config);
    restarted.dispatch(first, &done).unwrap();
    assert_eq!(received.recv().await.unwrap()["status"], "executed");
    restarted.dispatch(uncertain, &done).unwrap();
    assert_eq!(received.recv().await.unwrap()["status"], "outcome_unknown");
    assert!(restarted.running.is_empty());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "once");
}

#[tokio::test]
async fn admission_prioritizes_pause_revocation_closed_session_and_capability() {
    let (dir, config) = fixture("http://127.0.0.1:1".into());
    let path = dir.path().join("must-not-exist");
    let (mut c, mut received) = actor(dir.path().into(), config);
    let (done, _) = mpsc::unbounded_channel();
    c.config["paused"] = json!(true);
    c.dispatch(dispatch("paused", 1, &path), &done).unwrap();
    assert_eq!(
        received.recv().await.unwrap()["error"]["code"],
        "device_paused"
    );
    c.config["paused"] = json!(false);
    c.config["revoked"] = json!(true);
    c.dispatch(dispatch("revoked", 2, &path), &done).unwrap();
    assert_eq!(
        received.recv().await.unwrap()["error"]["code"],
        "device_paused"
    );
    c.config["revoked"] = json!(false);
    c.closed.insert("session".into());
    c.dispatch(dispatch("closed", 3, &path), &done).unwrap();
    assert_eq!(
        received.recv().await.unwrap()["error"]["code"],
        "session_closed"
    );
    c.closed.clear();
    c.config["capabilities"]["files"] = json!(false);
    c.dispatch(dispatch("disabled", 4, &path), &done).unwrap();
    assert_eq!(
        received.recv().await.unwrap()["error"]["code"],
        "capability_unavailable"
    );
    c.config["capabilities"]["files"] = json!(true);
    c.dispatch(dispatch("stale", 4, &path), &done).unwrap();
    assert_eq!(
        received.recv().await.unwrap()["error"]["code"],
        "stale_sequence"
    );
    let mut expired = dispatch("expired", 5, &path);
    expired["expires_at"] = json!(storage::now() - 1.);
    c.dispatch(expired, &done).unwrap();
    assert_eq!(
        received.recv().await.unwrap()["error"]["code"],
        "dispatch_expired"
    );
    assert!(c.running.is_empty());
    assert!(!path.exists());
    c.network
        .as_ref()
        .unwrap()
        .alive
        .store(false, Ordering::SeqCst);
    c.dispatch(dispatch("closed-socket", 6, &path), &done)
        .unwrap();
    assert!(received.try_recv().is_err());
    assert!(c.running.is_empty());
    assert!(!path.exists());
}

#[tokio::test]
async fn unbind_waits_for_revoke_and_removes_the_credential() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (directory, config) = fixture(format!("http://{}", listener.local_addr().unwrap()));
    storage::directory(&directory.path().join("credentials")).unwrap();
    storage::write(
        &directory.path().join("credentials/device.json"),
        &json!({"device_key":"abr_device_fixture"}),
    )
    .unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
        assert!(matches!(ws.next().await, Some(Ok(Message::Text(_)))));
        ws.send(Message::Text(json!({"type":"welcome","protocol":"abridge/1","device_id":"fixture","connection_epoch":1,"capabilities":["shell","files"],"owner_name":"Fixture","lease_seconds":30,"heartbeat_interval":10}).to_string().into())).await.unwrap();
        while let Some(Ok(Message::Text(text))) = ws.next().await {
            let frame: Value = serde_json::from_str(&text).unwrap();
            if frame["type"] == "unbind" {
                ws.send(Message::Text(
                    json!({"type":"revoke","connection_epoch":1})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
                return;
            }
        }
        panic!("unbind was not sent to the Server");
    });
    let (tx, rx) = mpsc::unbounded_channel();
    let task = tokio::spawn(run(
        directory.path().into(),
        config,
        "abr_device_fixture".into(),
        rx,
    ));
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if bounded(&tx, "status").await["connection"] == "online" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        bounded(&tx, "unbind").await,
        json!({"unbound":true,"cloud_revoked":true})
    );
    task.await.unwrap().unwrap();
    server.await.unwrap();
    assert!(!directory.path().join("credentials/device.json").exists());
    assert_eq!(storage::config(directory.path()).unwrap()["revoked"], true);
}
