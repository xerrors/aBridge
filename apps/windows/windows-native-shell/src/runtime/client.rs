use super::{
    executor::{ExecError, Executor},
    protocol, storage,
};
use anyhow::{ensure, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};
pub struct Command {
    pub name: String,
    pub args: Value,
    pub reply: oneshot::Sender<Result<Value>>,
}
#[derive(Debug)]
pub struct ControlError {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for ControlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ControlError {}
fn control_error(code: &'static str, message: &str) -> anyhow::Error {
    ControlError {
        code,
        message: message.into(),
    }
    .into()
}
pub type Sender = mpsc::UnboundedSender<Command>;
pub async fn command(tx: &Sender, name: &str, args: Value) -> Result<Value> {
    let (reply, rx) = oneshot::channel();
    tx.send(Command {
        name: name.into(),
        args,
        reply,
    })
    .map_err(|_| anyhow::anyhow!("设备进程已退出"))?;
    rx.await?
}
struct Running {
    cancel: Arc<AtomicBool>,
    session: String,
    caps: Vec<String>,
    client: String,
    epoch: u64,
}
struct Complete {
    id: String,
    epoch: u64,
    result: Result<Value, ExecError>,
}
enum NetworkEvent {
    Welcome(Value),
    Frame(Value),
    Closed(bool),
}
struct Network {
    outgoing: mpsc::Sender<Value>,
    incoming: mpsc::Receiver<NetworkEvent>,
    task: JoinHandle<()>,
    alive: Arc<AtomicBool>,
}
impl Drop for Network {
    fn drop(&mut self) {
        self.task.abort();
    }
}
type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
async fn wire_send(s: &mut Socket, value: Value) -> Result<()> {
    tokio::time::timeout(
        Duration::from_secs(5),
        s.send(Message::Text(value.to_string().into())),
    )
    .await??;
    Ok(())
}
fn network(config: Value, key: String, executor: Arc<Executor>) -> Network {
    // Accommodate both bounded output streams for every admitted operation.
    let (outgoing, mut output) =
        mpsc::channel::<Value>(protocol::contract().limits.operations * 34 + 64);
    let (events, incoming) = mpsc::channel(64);
    let alive = Arc::new(AtomicBool::new(true));
    let network_alive = alive.clone();
    let task = tokio::spawn(async move {
        let run=async {
   let mut url=url::Url::parse(config["url"].as_str().context("Server URL")?)?;
   url.set_scheme(if url.scheme()=="https"{"wss"}else{"ws"}).map_err(|_|anyhow::anyhow!("Invalid Server URL"))?;
   url.set_path(&format!("{}/ws/device",url.path().trim_end_matches('/')));
   let mut request=url.as_str().into_client_request()?;request.headers_mut().insert("Authorization",format!("Bearer {key}").parse()?);
   let options=tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default().max_message_size(Some(protocol::contract().limits.message_bytes));
   let(mut socket,_)=tokio::time::timeout(Duration::from_secs(10),tokio_tungstenite::connect_async_with_config(request,Some(options),false)).await??;
   if config["capabilities"]["screen"]==true||config["capabilities"]["input"]==true {let exec=executor.clone();tokio::task::spawn_blocking(move||exec.diagnostics(true)).await?;}
   wire_send(&mut socket,json!({"type":"hello","protocol":protocol::contract().protocol,"platform":"win32","version":env!("ABRIDGE_VERSION"),"capabilities":capabilities(&config,&executor),"paused":config["paused"]})).await?;
   let welcome=tokio::time::timeout(Duration::from_secs(10),async {loop {match socket.next().await {Some(Ok(Message::Text(text)))=>break Ok::<Value,anyhow::Error>(protocol::parse("welcome",serde_json::from_str(&text)?)?),Some(Ok(Message::Ping(_)|Message::Pong(_)))=>{},_=>anyhow::bail!("Invalid device welcome")}}}).await??;
   events.try_send(NetworkEvent::Welcome(welcome))?;
   loop {tokio::select! {
    frame=socket.next()=>{
    match frame {
        Some(Ok(Message::Text(text))) => {
            events.try_send(NetworkEvent::Frame(serde_json::from_str(&text)?))?
        }
        Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
        _ => anyhow::bail!("Device connection closed"),
    }
},
    value=output.recv()=>{
    let Some(value) = value else {
        return Ok::<(), anyhow::Error>(());
    };
    wire_send(&mut socket, value).await?;
}
   }}
  }.await;
        let revoked=run.as_ref().err().and_then(|e|e.downcast_ref::<tokio_tungstenite::tungstenite::Error>()).is_some_and(|e|matches!(e,tokio_tungstenite::tungstenite::Error::Http(r) if r.status()==401||r.status()==403));
        network_alive.store(false, Ordering::SeqCst);
        let _ = events.send(NetworkEvent::Closed(revoked)).await;
    });
    Network {
        outgoing,
        incoming,
        task,
        alive,
    }
}
#[derive(Clone)]
enum Cleanup {
    All,
    Desktop,
    Initialize,
    Session(String),
    Invalidate(Vec<String>),
}
struct Pending {
    ids: HashSet<String>,
    cleanup: Option<Cleanup>,
    task: Option<JoinHandle<()>>,
    reply: Option<oneshot::Sender<Result<Value>>>,
    value: Option<Value>,
}
struct Unbind {
    reply: oneshot::Sender<Result<Value>>,
    deadline: Instant,
    acknowledged: bool,
    started: bool,
}
struct Renamed {
    reply: oneshot::Sender<Result<Value>>,
    result: Result<Value>,
}
struct Client {
    dir: PathBuf,
    config: Value,
    key: String,
    exec: Arc<Executor>,
    journal: storage::Journal,
    network: Option<Network>,
    epoch: u64,
    sequence: u64,
    device: Value,
    server_caps: Vec<String>,
    lease: Duration,
    ack: Instant,
    reconnect: Instant,
    backoff: u64,
    heartbeat: Instant,
    connection: &'static str,
    error: &'static str,
    running: HashMap<String, Running>,
    closed: HashSet<String>,
    pending: Vec<Pending>,
    unbind: Option<Unbind>,
    quitting: bool,
    dirty: bool,
}
impl Client {
    fn snapshot(&self) -> Value {
        let mut v = self.exec.diagnostics(false);
        if !v.is_object() {
            v = json!({});
        }
        let mut controllers: Vec<_> = self.running.values().map(|o| o.client.clone()).collect();
        controllers.sort();
        controllers.dedup();
        v.as_object_mut().unwrap().extend(json!({"connection":self.connection,"paused":self.config["paused"],"pause_reason":self.config["pause_reason"].as_str().unwrap_or(""),"capabilities":capabilities(&self.config,&self.exec),"requested_capabilities":self.config["capabilities"],"active_operations":self.running.len(),"active_controllers":controllers,"desktop_active_until":if self.running.values().any(|o|o.caps.iter().any(|c|c=="input")){storage::now()+30.}else{0.},"url":self.config["url"],"error":self.error,"device_id":self.device["device_id"].as_str().unwrap_or(""),"device_name":self.device["device_name"].as_str().unwrap_or(""),"owner_name":self.device["owner_name"].as_str().unwrap_or(""),"updated_at":storage::now()}).as_object().unwrap().clone());
        v
    }
    fn save(&self) -> Result<()> {
        storage::write(&self.dir.join("config.json"), &self.config)
    }
    fn send(&mut self, value: Value) {
        if let Some(net) = &self.network {
            if net.outgoing.try_send(value).is_err() {
                self.disconnect(false);
            }
        }
    }
    fn heartbeat(&mut self) {
        if self.connection == "online" {
            self.send(json!({"type":"heartbeat","connection_epoch":self.epoch,"capabilities":capabilities(&self.config,&self.exec),"paused":self.config["paused"]}));
        }
        self.heartbeat = Instant::now();
    }
    fn cancel(
        &mut self,
        ids: HashSet<String>,
        cleanup: Cleanup,
        reply: Option<oneshot::Sender<Result<Value>>>,
        value: Option<Value>,
    ) {
        for id in &ids {
            if let Some(op) = self.running.get(id) {
                op.cancel.store(true, Ordering::SeqCst);
            }
        }
        self.pending.push(Pending {
            ids,
            cleanup: Some(cleanup),
            task: None,
            reply,
            value,
        });
    }
    fn all_ids(&self) -> HashSet<String> {
        self.running.keys().cloned().collect()
    }
    fn disconnect(&mut self, revoked: bool) {
        self.network = None;
        self.connection = if revoked { "revoked" } else { "offline" };
        self.error = if revoked {
            "Device credential revoked; bind this device again"
        } else {
            "Server connection unavailable"
        };
        self.reconnect = Instant::now() + Duration::from_secs(self.backoff);
        self.backoff = (self.backoff * 2).min(15);
        self.cancel(self.all_ids(), Cleanup::All, None, None);
        self.dirty = true;
    }
    fn refuse(&mut self, id: &str, code: &str, message: &str) {
        self.send(json!({"type":"result","operation_id":id,"connection_epoch":self.epoch,"status":"refused","result":{},"error":{"code":code,"message":message}}));
    }
    fn dispatch(&mut self, value: Value, done: &mpsc::UnboundedSender<Complete>) -> Result<()> {
        let frame = match protocol::parse("operation", value.clone()) {
            Ok(v) => v,
            Err(_) => {
                if let Some(id) = value["operation_id"].as_str() {
                    self.refuse(id,"invalid_dispatch","Invalid operation frame; check server/client protocol alignment before retrying");
                }
                return Ok(());
            }
        };
        let id = frame["operation_id"]
            .as_str()
            .context("Operation identity")?;
        let session = frame["session_id"].as_str().context("Session identity")?;
        if !identity(id) || !identity(session) {
            self.refuse(id, "invalid_dispatch", "Invalid operation identity");
            return Ok(());
        }
        if frame["device_id"] != self.device["device_id"]
            || frame["connection_epoch"].as_u64() != Some(self.epoch)
        {
            return Ok(());
        }
        if self
            .network
            .as_ref()
            .is_none_or(|net| !net.alive.load(Ordering::SeqCst))
        {
            for operation in self.running.values() {
                operation.cancel.store(true, Ordering::SeqCst);
            }
            return Ok(());
        }
        if self.ack.elapsed() >= self.lease || self.connection != "online" {
            self.disconnect(false);
            return Ok(());
        }
        let now = storage::now();
        let expiry = frame["expires_at"].as_f64().unwrap_or(0.);
        let limits = &protocol::contract().limits;
        if expiry < now
            || expiry > now + limits.operation_start_seconds + limits.operation_grace_seconds
        {
            self.refuse(id, "dispatch_expired", "Operation start deadline expired");
            return Ok(());
        }
        let tool = frame["tool"].as_str().context("Tool")?;
        if protocol::contract()
            .tool_capabilities
            .get(tool)
            .is_none_or(|c| c == "browser")
        {
            self.refuse(
                id,
                "capability_unavailable",
                "Use an independent browser device",
            );
            return Ok(());
        }
        let hash = request_hash(&frame);
        if let Some((prior, status)) = self.journal.get(id)? {
            let conflict = prior != hash;
            self.send(json!({"type":"result","operation_id":id,"connection_epoch":self.epoch,"status":if conflict{"refused"}else if status=="executing"{"outcome_unknown"}else{&status},"result":{"deduplicated":true,"prior_status":status},"error":{"code":if conflict{"idempotency_conflict"}else{"duplicate_operation"},"message":if conflict{"Operation identity reused with different arguments"}else{"Operation was already accepted; its effect will not be replayed"}}}));
            return Ok(());
        }
        let seq = frame["sequence"].as_u64().unwrap_or(0);
        if seq <= self.sequence {
            self.refuse(id, "stale_sequence", "Operation sequence is stale");
            return Ok(());
        }
        self.sequence = seq;
        if self.quitting || self.config["paused"] == true || self.config["revoked"] == true {
            self.refuse(id, "device_paused", "Local access is paused");
            return Ok(());
        }
        if self.closed.contains(session) {
            self.refuse(id, "session_closed", "This session is closed");
            return Ok(());
        }
        if self.running.len() >= limits.operations {
            self.refuse(id, "device_busy", "Device operation limit reached");
            return Ok(());
        }
        let caps = required_capabilities(tool, &frame["arguments"]);
        let available = capabilities(&self.config, &self.exec);
        if caps.iter().any(|c| {
            available[c] != true
                || !self.server_caps.contains(c)
                || !frame["session_capabilities"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!(c)))
        }) {
            self.refuse(
                id,
                "capability_unavailable",
                "Required capability is unavailable",
            );
            return Ok(());
        }
        if expiry <= storage::now() {
            self.refuse(
                id,
                "dispatch_expired",
                "Operation start deadline expired during admission",
            );
            return Ok(());
        }
        // No await between admission checks and durable identity reservation.
        self.journal.start(id, &hash)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let id = id.to_owned();
        let session = session.to_owned();
        let epoch = self.epoch;
        self.running.insert(
            id.clone(),
            Running {
                cancel: cancel.clone(),
                session: session.clone(),
                caps,
                client: frame["client_name"].as_str().unwrap_or("MCP Agent").into(),
                epoch,
            },
        );
        self.dirty = true;
        let exec = self.exec.clone();
        let done = done.clone();
        tokio::task::spawn_blocking(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let tool = frame["tool"].as_str().unwrap();
                let args = protocol::parse(tool, frame["arguments"].clone()).map_err(|_| {
                    ExecError::new("invalid_arguments", "Invalid operation arguments")
                })?;
                exec.execute(&id, tool, &args, &session, cancel)
            }))
            .unwrap_or_else(|_| Err(ExecError::unknown()));
            let _ = done.send(Complete { id, epoch, result });
        });
        Ok(())
    }
    async fn progress(&mut self) -> Result<()> {
        let mut index = 0;
        while index < self.pending.len() {
            let p = &mut self.pending[index];
            if p.ids.iter().any(|id| self.running.contains_key(id)) {
                index += 1;
                continue;
            }
            if let Some(cleanup) = p.cleanup.take() {
                let exec = self.exec.clone();
                p.task = Some(tokio::task::spawn_blocking(move || match cleanup {
                    Cleanup::All => exec.stop(),
                    Cleanup::Desktop => exec.stop_computer(),
                    Cleanup::Initialize => {
                        exec.diagnostics(true);
                    }
                    Cleanup::Session(id) => exec.close_session(&id),
                    Cleanup::Invalidate(ids) => {
                        for id in ids {
                            exec.invalidate(&id);
                        }
                    }
                }));
            }
            if !p.task.as_ref().is_some_and(|t| t.is_finished()) {
                index += 1;
                continue;
            }
            let mut p = self.pending.remove(index);
            let result = p.task.take().unwrap().await.map_err(anyhow::Error::from);
            self.dirty = true;
            self.heartbeat();
            if let Some(reply) = p.reply {
                let _ = reply.send(result.map(|()| p.value.unwrap_or_else(|| self.snapshot())));
            } else {
                result?;
            }
        }
        if self.running.is_empty()
            && self.pending.is_empty()
            && self.unbind.as_ref().is_some_and(|u| !u.started)
        {
            let online = self.connection == "online";
            let u = self.unbind.as_mut().unwrap();
            u.started = true;
            u.deadline = Instant::now()
                + if online {
                    Duration::from_secs(5)
                } else {
                    Duration::ZERO
                };
            if online {
                self.send(json!({"type":"unbind","connection_epoch":self.epoch}));
            }
        }
        if self.unbind.as_ref().is_some_and(|u| {
            u.started
                && (u.acknowledged || Instant::now() >= u.deadline)
                && self.running.is_empty()
                && self.pending.is_empty()
        }) {
            let u = self.unbind.take().unwrap();
            self.key.clear();
            self.network = None;
            self.quitting = true;
            let _ = u
                .reply
                .send(Ok(json!({"unbound":true,"cloud_revoked":u.acknowledged})));
        }
        Ok(())
    }
}
pub async fn run(
    dir: PathBuf,
    config: Value,
    key: String,
    mut commands: mpsc::UnboundedReceiver<Command>,
) -> Result<()> {
    let (output_tx, mut output) = mpsc::channel(256);
    let exec = Arc::new(Executor::new(
        dir.clone(),
        Arc::new(move |id, stream, data| {
            let _ = output_tx.blocking_send(
                json!({"type":"output","operation_id":id,"stream":stream,"data":data}),
            );
        }),
    ));
    let journal = storage::Journal::open(&dir)?;
    let mut c = Client {
        dir,
        config,
        key,
        exec,
        journal,
        network: None,
        epoch: 0,
        sequence: 0,
        device: json!({}),
        server_caps: vec![],
        lease: Duration::from_secs_f64(protocol::contract().limits.lease_seconds),
        ack: Instant::now(),
        reconnect: Instant::now(),
        backoff: 1,
        heartbeat: Instant::now(),
        connection: "offline",
        error: "",
        running: HashMap::new(),
        closed: HashSet::new(),
        pending: vec![],
        unbind: None,
        quitting: false,
        dirty: true,
    };
    let (done_tx, mut done) = mpsc::unbounded_channel::<Complete>();
    let (rename_tx, mut renamed) = mpsc::unbounded_channel::<Renamed>();
    let mut tick = tokio::time::interval(Duration::from_millis(100));
    let mut status_at = Instant::now();
    let mut persisted_status = None;
    let mut commands_open = true;
    let result=async {loop {
  if c.network.is_none()&&!c.quitting&&c.config["revoked"]!=true&&c.running.is_empty()&&c.pending.is_empty()&&Instant::now()>=c.reconnect {c.connection="connecting";c.dirty=true;c.network=Some(network(c.config.clone(),c.key.clone(),c.exec.clone()));}
  tokio::select! {
   cmd=commands.recv(),if commands_open=>{
    match cmd {
        Some(cmd) => control(&mut c, cmd, &rename_tx)?,
        None => {
            commands_open = false;
            c.quitting = true;
            c.network = None;
            c.cancel(c.all_ids(), Cleanup::All, None, None);
        }
    }
},
   event=async{if !c.pending.is_empty(){return std::future::pending().await;}match c.network.as_mut(){Some(net)=>net.incoming.recv().await,None=>std::future::pending().await}}=>{
    match event {
        Some(NetworkEvent::Welcome(v)) => {
            c.epoch = v["connection_epoch"].as_u64().unwrap();
            c.lease = Duration::from_secs_f64(
                v["lease_seconds"]
                    .as_f64()
                    .unwrap()
                    .clamp(1., protocol::contract().limits.lease_seconds),
            );
            c.server_caps = v["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect();
            c.device = v;
            c.sequence = 0;
            c.closed.clear();
            c.ack = Instant::now();
            c.connection = "online";
            c.error = "";
            c.backoff = 1;
            c.dirty = true;
            c.heartbeat();
        }
        Some(NetworkEvent::Closed(revoked)) => {
            if revoked {
                c.config["revoked"] = json!(true);
                c.save()?;
            }
            c.disconnect(revoked);
        }
        None => c.disconnect(false),
        Some(NetworkEvent::Frame(v)) => {
            if v["connection_epoch"].as_u64() == Some(c.epoch) {
                match v["type"].as_str() {
                    Some("heartbeat_ack") => {
                        c.ack = Instant::now();
                        if let Ok(name) =
                            protocol::parse("deviceRename", json!({"name":v["device_name"]}))
                        {
                            if c.device["device_name"] != name["name"] {
                                c.device["device_name"] = name["name"].clone();
                                c.dirty = true;
                            }
                        }
                    }
                    Some("dispatch") => c.dispatch(v, &done_tx)?,
                    Some("cancel") => {
                        if let Some(ids) = v["operation_ids"].as_array() {
                            let ids: HashSet<_> = ids
                                .iter()
                                .filter_map(|v| v.as_str().map(str::to_owned))
                                .collect();
                            let sessions = c
                                .running
                                .iter()
                                .filter(|(id, o)| {
                                    ids.contains(*id)
                                        && o.caps.iter().any(|x| x == "input" || x == "screen")
                                })
                                .map(|(_, o)| o.session.clone())
                                .collect();
                            c.cancel(ids, Cleanup::Invalidate(sessions), None, None);
                        }
                    }
                    Some("session_close") => {
                        if let Some(session) = v["session_id"].as_str() {
                            c.closed.insert(session.into());
                            let ids = c
                                .running
                                .iter()
                                .filter(|(_, o)| o.session == session)
                                .map(|(id, _)| id.clone())
                                .collect();
                            c.cancel(ids, Cleanup::Session(session.into()), None, None);
                        }
                    }
                    Some("stop") => c.cancel(c.all_ids(), Cleanup::All, None, None),
                    Some("revoke") => {
                        c.config["revoked"] = json!(true);
                        c.save()?;
                        if let Some(u) = c.unbind.as_mut() {
                            u.acknowledged = true;
                        }
                        c.disconnect(true);
                    }
                    _ => {}
                }
            }
        }
    }
},
   Some(out)=output.recv(), if c.network.as_ref().is_none_or(|net| net.outgoing.capacity() > 4)=>output_frame(&mut c,out),
   Some(result)=done.recv(), if output.is_empty()=>{
    complete(&mut c, result)?;
},
   Some(rename)=renamed.recv()=>{
    let result = rename.result.and_then(|v| {
        if v["id"] != c.device["device_id"] || c.quitting || c.config["revoked"] == true {
            return Err(control_error("invalid_response", "Server 返回了不匹配的设备名称"));
        }
        c.device["device_name"] = v["name"].clone();
        c.dirty = true;
        Ok(c.snapshot())
    });
    let _ = rename.reply.send(result);
},
   _=tick.tick()=>{
    if c.network.as_ref().is_some_and(|net| !net.alive.load(Ordering::SeqCst)) {
        for operation in c.running.values() { operation.cancel.store(true, Ordering::SeqCst); }
    }
    if c.connection == "online" && c.ack.elapsed() >= c.lease {
        c.disconnect(false);
    }
    if c.heartbeat.elapsed()
        >= Duration::from_secs_f64(protocol::contract().limits.heartbeat_seconds)
    {
        c.heartbeat();
    }
}
  }
  c.progress().await?;
  if c.dirty || status_at.elapsed() >= Duration::from_secs(1) {
      persist_status(&c.dir, &c.snapshot(), c.dirty, &mut persisted_status)?;
      c.dirty = false;
      status_at = Instant::now();
  }
  if c.quitting&&c.running.is_empty()&&c.pending.is_empty()&&c.unbind.is_none(){break;}
 }Ok::<(),anyhow::Error>(())}.await;
    // Any protocol/storage failure also cancels accepted work before dropping the journal.
    c.network = None;
    for op in c.running.values() {
        op.cancel.store(true, Ordering::SeqCst);
    }
    let exec = c.exec.clone();
    let cleanup = tokio::task::spawn_blocking(move || exec.shutdown());
    while !c.running.is_empty() {
        tokio::select! {Some(result)=done.recv()=>{
            c.journal.finish(&result.id, "outcome_unknown")?;
            c.running.remove(&result.id);
        },Some(_)=output.recv()=>{}}
    }
    cleanup.await?;
    c.connection = "offline";
    storage::write(&c.dir.join("status.json"), &c.snapshot())?;
    result
}
fn persist_status(
    dir: &std::path::Path,
    snapshot: &Value,
    force: bool,
    previous: &mut Option<Value>,
) -> Result<bool> {
    // Live status requests still get fresh timestamps and activity deadlines.
    // The durable snapshot only needs changes to state, including async driver diagnostics.
    let mut semantic = snapshot.clone();
    if let Some(object) = semantic.as_object_mut() {
        object.remove("updated_at");
        if let Some(deadline) = object.get_mut("desktop_active_until") {
            *deadline = json!(deadline.as_f64().is_some_and(|v| v > 0.));
        }
    }
    if !force && previous.as_ref() == Some(&semantic) {
        return Ok(false);
    }
    storage::write(&dir.join("status.json"), snapshot)?;
    *previous = Some(semantic);
    Ok(true)
}
fn output_frame(c: &mut Client, mut out: Value) {
    if let Some(op) = out["operation_id"]
        .as_str()
        .and_then(|id| c.running.get(id))
    {
        if op.epoch == c.epoch && !op.cancel.load(Ordering::SeqCst) {
            out["connection_epoch"] = json!(op.epoch);
            c.send(out);
        }
    }
}
fn complete(c: &mut Client, done: Complete) -> Result<()> {
    let op = c.running.remove(&done.id);
    let cancelled = op.as_ref().is_some_and(|o| o.cancel.load(Ordering::SeqCst))
        || c.quitting
        || c.config["paused"] == true
        || c.config["revoked"] == true;
    let (status, value, error) = outcome(done.result, cancelled);
    if error["code"] == "user_takeover" {
        c.config["paused"] = json!(true);
        c.config["pause_reason"] = json!("desktop_input");
        for op in c.running.values() {
            op.cancel.store(true, Ordering::SeqCst);
        }
        c.save()?;
        c.cancel(c.all_ids(), Cleanup::Desktop, None, None);
    }
    c.journal.finish(&done.id, &status)?;
    c.dirty = true;
    if done.epoch == c.epoch && c.connection == "online" {
        let mut frame = json!({"type":"result","operation_id":done.id,"connection_epoch":done.epoch,"status":status,"result":value});
        if !error.is_null() {
            frame["error"] = error;
        }
        c.send(frame);
    }
    Ok(())
}
fn outcome(result: Result<Value, ExecError>, cancelled: bool) -> (String, Value, Value) {
    if cancelled {
        return (
            "outcome_unknown".into(),
            json!({}),
            json!({"code":"operation_cancelled","message":"Execution result is unknown; the operation will not be replayed"}),
        );
    }
    match result {
        Ok(value) => ("executed".into(), value, Value::Null),
        Err(e)
            if matches!(
                e.code.as_str(),
                "outcome_unknown" | "operation_cancelled" | "cancelled"
            ) =>
        {
            (
                "outcome_unknown".into(),
                json!({}),
                json!({"code":"outcome_unknown","message":"Execution result is unknown; the operation will not be replayed"}),
            )
        }
        Err(e) => (
            e.status,
            json!({}),
            json!({"code":e.code,"message":e.message}),
        ),
    }
}
fn control(c: &mut Client, cmd: Command, renames: &mpsc::UnboundedSender<Renamed>) -> Result<()> {
    let Command { name, args, reply } = cmd;
    if name == "status" {
        let _ = reply.send(Ok(c.snapshot()));
        return Ok(());
    }
    if name == "rename" {
        let checked = (|| -> Result<Value> {
            let body = protocol::parse("deviceRename", json!({"name":args["name"]}))
                .map_err(|_| control_error("invalid_name", "设备名称需为 1–120 个字符"))?;
            if c.connection != "online" || c.key.is_empty() || c.config["revoked"] == true {
                return Err(control_error(
                    "device_offline",
                    "请连接 Server 后再修改设备名称",
                ));
            }
            Ok(body)
        })();
        match checked {
            Err(e) => {
                let _ = reply.send(Err(e));
            }
            Ok(body) => {
                let tx = renames.clone();
                let url = format!(
                    "{}/api/device",
                    c.config["url"].as_str().unwrap().trim_end_matches('/')
                );
                let key = c.key.clone();
                tokio::spawn(async move {
                    let result = async {
                        let client = reqwest::Client::builder()
                            .redirect(reqwest::redirect::Policy::none())
                            .timeout(Duration::from_secs(10))
                            .build()?;
                        let response = client
                            .patch(url)
                            .bearer_auth(key)
                            .json(&body)
                            .send()
                            .await
                            .map_err(|_| {
                                control_error("rename_failed", "无法保存设备名称，请检查连接后重试")
                            })?;
                        if !response.status().is_success() {
                            return Err(control_error(
                                "rename_failed",
                                "设备名称保存失败，请重新连接后重试",
                            ));
                        }
                        let body = response.json().await.map_err(|_| {
                            control_error("invalid_response", "Server 返回了不匹配的设备名称")
                        })?;
                        protocol::parse("deviceRenameResult", body).map_err(|_| {
                            control_error("invalid_response", "Server 返回了不匹配的设备名称")
                        })
                    }
                    .await;
                    let _ = tx.send(Renamed { reply, result });
                });
            }
        }
        return Ok(());
    }
    let mut cleanup = None;
    let mut selected = c.all_ids();
    let mut explicit = None;
    let result = (|| -> Result<()> {
        match name.as_str() {
            "status" => {}
            "pause" => {
                if args["if_desktop_active"] == true
                    && !c
                        .running
                        .values()
                        .any(|o| o.caps.iter().any(|cap| cap == "input"))
                {
                    explicit = Some(json!({"ignored":true}));
                    return Ok(());
                }
                c.config["paused"] = json!(true);
                c.config["pause_reason"] = json!(if args["reason"] == "desktop_input"
                    || args["if_desktop_active"] == true
                {
                    "desktop_input"
                } else {
                    "manual"
                });
                c.save()?;
                cleanup = Some(Cleanup::All);
            }
            "resume" => {
                c.config["paused"] = json!(false);
                c.config.as_object_mut().unwrap().remove("pause_reason");
                c.save()?;
            }
            "shutdown" => {
                c.quitting = true;
                cleanup = Some(Cleanup::All);
                explicit = Some(json!({"shutdown_requested":true}));
            }
            "stop" => {
                cleanup = Some(Cleanup::All);
                c.send(json!({"type":"local_stop","connection_epoch":c.epoch}));
            }
            "capability" => {
                let cap = args["capability"].as_str().ok_or_else(|| {
                    control_error("invalid_arguments", "Unknown desktop capability")
                })?;
                if !["screen", "input", "shell", "files"].contains(&cap)
                    || !args["enabled"].is_boolean()
                {
                    return Err(control_error(
                        "invalid_arguments",
                        "Unknown desktop capability",
                    ));
                }
                c.config["capabilities"][cap] = args["enabled"].clone();
                c.save()?;
                if args["enabled"] == false {
                    selected = c
                        .running
                        .iter()
                        .filter(|(_, o)| o.caps.iter().any(|x| x == cap))
                        .map(|(id, _)| id.clone())
                        .collect();
                    cleanup = Some(if cap == "screen" || cap == "input" {
                        Cleanup::Desktop
                    } else {
                        Cleanup::Invalidate(vec![])
                    });
                } else if cap == "screen" || cap == "input" {
                    selected.clear();
                    cleanup = Some(Cleanup::Initialize);
                }
            }
            "unbind" => {
                ensure!(c.unbind.is_none(), "设备正在解除绑定");
                c.config["paused"] = json!(true);
                c.config["revoked"] = json!(true);
                c.save()?;
                match std::fs::remove_file(c.dir.join("credentials/device.json")) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.into()),
                };
                cleanup = Some(Cleanup::All);
            }
            _ => return Err(control_error("invalid_arguments", "Unknown local command")),
        };
        Ok(())
    })();
    if let Err(e) = result {
        if c.config["paused"] == true || c.config["revoked"] == true {
            c.cancel(c.all_ids(), Cleanup::All, None, None);
        }
        let _ = reply.send(Err(e));
        return Ok(());
    }
    c.dirty = true;
    if name == "unbind" {
        c.unbind = Some(Unbind {
            reply,
            deadline: Instant::now(),
            acknowledged: false,
            started: false,
        });
        c.cancel(selected, cleanup.unwrap(), None, None);
        return Ok(());
    }
    if let Some(cleanup) = cleanup {
        c.cancel(selected, cleanup, Some(reply), explicit);
    } else {
        let _ = reply.send(Ok(explicit.unwrap_or_else(|| c.snapshot())));
    }
    c.heartbeat();
    Ok(())
}
fn capabilities(config: &Value, exec: &Executor) -> Value {
    let mut caps = Value::Object(
        protocol::contract()
            .capabilities
            .iter()
            .map(|cap| (cap.clone(), json!(false)))
            .collect(),
    );
    let d = exec.diagnostics(false);
    for c in ["screen", "input", "shell", "files"] {
        caps[c] = json!(
            config["capabilities"][c] == true
                && (!["screen", "input"].contains(&c)
                    || (d["driver"]["ready"] == true && d["permissions"][c] == true))
        );
    }
    caps
}
fn identity(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}
fn required_capabilities(tool: &str, args: &Value) -> Vec<String> {
    let mut result = vec![protocol::contract().tool_capabilities[tool].clone()];
    if (tool == "computer_open"
        || (tool == "computer_act"
            && (args["observe_after"] != false || args["screenshot"] == true)))
        && !result.iter().any(|c| c == "screen")
    {
        result.push("screen".into());
    }
    result
}
fn canonical(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical(&object[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Number(n) => ryu_js::Buffer::new()
            .format(n.as_f64().unwrap())
            .to_string(),
        _ => value.to_string(),
    }
}
fn request_hash(frame: &Value) -> String {
    format!("{:x}",Sha256::digest(canonical(&json!({"tool":frame["tool"],"arguments":frame["arguments"],"session_id":frame["session_id"]})).as_bytes()))
}
#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
