//! Same authenticated named pipe as the Node client, including cross-version exclusion.
use super::{
    client::{self, Sender},
    storage,
};
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, ServerOptions},
    task::{JoinHandle, JoinSet},
};

fn pipe_path(dir: &Path) -> Result<String> {
    let absolute = std::path::absolute(dir)?;
    Ok(format!(
        r"\\.\pipe\abridge-{:x}",
        Sha256::digest(absolute.to_string_lossy().to_lowercase().as_bytes())
    ))
}
async fn line(stream: &mut (impl AsyncRead + Unpin), limit: usize) -> Result<Value> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let count = stream.read(&mut chunk).await?;
        ensure!(count > 0, "Incomplete local response");
        ensure!(bytes.len() + count <= limit, "Local message too large");
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(end) = bytes.iter().position(|&b| b == b'\n') {
            let value: Value = serde_json::from_slice(&bytes[..end])?;
            ensure!(value.is_object(), "Invalid local request");
            return Ok(value);
        }
    }
}
fn token_matches(value: &Value, token: &str) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == token.len()
            && s.bytes()
                .zip(token.bytes())
                .fold(0, |v, (a, b)| v | (a ^ b))
                == 0
    })
}
struct CredentialGuard {
    path: PathBuf,
    token: String,
}
impl Drop for CredentialGuard {
    fn drop(&mut self) {
        if storage::read(&self.path).is_ok_and(|value| token_matches(&value["token"], &self.token))
        {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
pub async fn serve(dir: PathBuf, tx: Sender) -> Result<JoinHandle<()>> {
    storage::directory(&dir)?;
    let name = pipe_path(&dir)?;
    // First-instance ownership must precede replacing the credential of a running old client.
    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&name)?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| anyhow::anyhow!("Random unavailable"))?;
    let token: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let path = dir.join("control-auth.json");
    storage::write(&path, &json!({"token":token}))?;
    let credential = CredentialGuard {
        path,
        token: token.clone(),
    };
    Ok(tokio::spawn(async move {
        let _credential = credential;
        let mut server = server;
        let mut connections = JoinSet::new();
        loop {
            tokio::select! {
                result=server.connect()=>if result.is_err(){break},
                _=tx.closed()=>break,
                Some(_)=connections.join_next()=>continue,
            }
            let next = match ServerOptions::new()
                .reject_remote_clients(true)
                .create(&name)
            {
                Ok(next) => next,
                Err(_) => break,
            };
            let mut connected = std::mem::replace(&mut server, next);
            let token = token.clone();
            let tx = tx.clone();
            connections.spawn(async move {
                let handle=async {
                    let mut request=tokio::time::timeout(Duration::from_secs(3),line(&mut connected,8192)).await??;
                    if !token_matches(&request["_token"],&token) {
                        return Ok::<_,anyhow::Error>(json!({"ok":false,"error":{"code":"control_unauthorized","message":"Local control authentication failed"}}));
                    }
                    request.as_object_mut().unwrap().remove("_token");
                    let name=request["command"].as_str().context("Missing command")?.to_owned();
                    let mut response=tokio::time::timeout(Duration::from_secs(15),client::command(&tx,&name,request)).await??;
                    response["ok"]=json!(true);
                    Ok(response)
                }.await;
                let response=handle.unwrap_or_else(|error| {
                    if let Some(error) = error.downcast_ref::<client::ControlError>() {
                        json!({"ok":false,"error":{"code":error.code,"message":error.message}})
                    } else {
                        json!({"ok":false,"error":{"code":"control_failed","message":"Local control failed"}})
                    }
                });
                let encoded=response.to_string()+"\n";
                if encoded.len()<=131072 {
                    let _=tokio::time::timeout(Duration::from_secs(3),connected.write_all(encoded.as_bytes())).await;
                }
            });
        }
    }))
}
pub async fn request(dir: &Path, request: &Value) -> Result<Value> {
    let credential = storage::read(&dir.join("control-auth.json"))?;
    let token = credential["token"]
        .as_str()
        .context("Invalid local control credential")?;
    let mut request = request.clone();
    ensure!(request.is_object(), "Invalid local request");
    request["_token"] = json!(token);
    let encoded = request.to_string() + "\n";
    ensure!(encoded.len() <= 8192, "Local request too large");
    let mut pipe = ClientOptions::new().open(pipe_path(dir)?)?;
    tokio::time::timeout(Duration::from_secs(15), async {
        pipe.write_all(encoded.as_bytes()).await?;
        let value = line(&mut pipe, 131072).await?;
        if value["ok"] == false {
            bail!(
                "{}",
                value["error"]["message"]
                    .as_str()
                    .unwrap_or("Local control failed")
            );
        }
        Ok(value)
    })
    .await?
}
