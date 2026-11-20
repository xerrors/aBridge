//! Browser PKCE and manual binding; credentials never enter a callback URL.
use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use url::Url;

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()?)
}
pub async fn response_json(mut response: reqwest::Response, schema: &str) -> Result<Value> {
    ensure!(
        response.status().is_success(),
        "授权服务请求失败 ({})",
        response.status().as_u16()
    );
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        ensure!(body.len() + chunk.len() <= 65536, "授权服务返回结果过大");
        body.extend_from_slice(&chunk);
    }
    super::protocol::parse(
        schema,
        serde_json::from_slice(&body).context("授权服务返回无效结果")?,
    )
    .context("授权服务返回无效结果")
}
pub async fn verify_token(url: &str, key: &str) -> Result<()> {
    ensure!(
        key.starts_with("abr_device_") && key.len() <= 4096,
        "请使用电脑设备的 Device Token，不能使用 Agent Key 或管理员 Token"
    );
    let response = client()?
        .get(format!("{url}/api/device"))
        .bearer_auth(key)
        .send()
        .await?;
    if response.status().as_u16() == 401 {
        bail!("设备 Token 无效或已撤销");
    }
    ensure!(
        response.status().is_success(),
        "设备验证失败 ({})",
        response.status().as_u16()
    );
    let device = response_json(response, "deviceIdentity").await?;
    ensure!(
        device["kind"] == "computer",
        "请使用电脑设备的 Token，不能使用浏览器、Agent 或管理员 Token"
    );
    Ok(())
}
fn nonce() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("系统安全随机数不可用"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
async fn cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
// Validate the entire callback before accepting either its code or cancellation.
fn callback(header: &str, redirect: &Url, state: &str) -> Result<Option<String>> {
    let mut lines = header.split("\r\n");
    let request: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    ensure!(
        request.len() == 3 && request[0] == "GET" && request[2].starts_with("HTTP/1."),
        "无效授权回调"
    );
    let target = redirect.join(request[1])?;
    let hosts: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, value)| value.trim())
        .collect();
    let expected = format!("127.0.0.1:{}", redirect.port().context("Callback port")?);
    ensure!(
        hosts == [expected.as_str()]
            && target.origin() == redirect.origin()
            && target.path() == "/abridge/callback",
        "无效授权回调"
    );
    let query: Vec<_> = target.query_pairs().collect();
    let values = |key: &str| {
        query
            .iter()
            .filter(|(name, _)| name == key)
            .map(|(_, value)| value.as_ref())
            .collect::<Vec<_>>()
    };
    let states = values("state");
    ensure!(
        states.len() == 1 && constant_eq(states[0].as_bytes(), state.as_bytes()),
        "无效授权回调"
    );
    let codes = values("code");
    let errors = values("error");
    ensure!(
        (codes.len() == 1 && errors.is_empty()) || (errors.len() == 1 && codes.is_empty()),
        "无效授权回调"
    );
    if !errors.is_empty() {
        return Ok(None);
    }
    let code = codes[0];
    ensure!(
        (16..=256).contains(&code.len())
            && code
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "无效授权回调"
    );
    Ok(Some(code.into()))
}
fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |v, (a, b)| v | (a ^ b)) == 0
}
async fn receive_code(listener: &TcpListener, redirect: &Url, state: &str) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await?;
        let read = async {
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let n = stream.read(&mut chunk).await?;
                ensure!(n != 0 && bytes.len() + n <= 8192, "无效授权回调");
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            callback(std::str::from_utf8(&bytes)?, redirect, state)
        };
        let result = tokio::time::timeout(Duration::from_secs(5), read).await;
        let valid = matches!(&result, Ok(Ok(_)));
        let body = match &result {
            Ok(Ok(Some(_))) => "授权已确认，可以返回 aBridge。",
            Ok(Ok(None)) => "已取消授权，可以返回 aBridge。",
            _ => "无效授权回调。请返回 aBridge 重试。",
        };
        let status = if valid { "200 OK" } else { "400 Bad Request" };
        let reply = format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ =
            tokio::time::timeout(Duration::from_secs(1), stream.write_all(reply.as_bytes())).await;
        if let Ok(Ok(code)) = result {
            return code.context("浏览器授权已取消");
        }
    }
}
pub async fn authorize(
    url: &str,
    confirmed: Option<&str>,
    cancel: Arc<AtomicBool>,
    notice: Arc<dyn Fn(Value) + Send + Sync>,
) -> Result<String> {
    ensure!(
        !cancel.load(Ordering::Acquire),
        "授权已取消或过期，请重新发起"
    );
    let server = super::storage::normalize_url(url, confirmed)?;
    let base = Url::parse(&server)?;
    let verifier = nonce()?;
    let state = nonce()?;
    let http = client()?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let redirect = Url::parse(&format!(
        "http://127.0.0.1:{}/abridge/callback",
        listener.local_addr()?.port()
    ))?;
    let name: String = std::env::var("COMPUTERNAME")
        .unwrap_or_else(|_| "Computer".into())
        .trim()
        .chars()
        .take(80)
        .collect();
    let request = super::protocol::parse(
        "deviceAuthorizationRequest",
        json!({
            "kind":"computer", "name":if name.is_empty(){"Computer"}else{&name},
            "capabilities":["screen","input","shell","files"], "redirect_uri":redirect.as_str(),
            "code_challenge":URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
            "code_challenge_method":"S256", "state":state
        }),
    )?;
    let mut authorization_id = None;
    let flow = async {
        let started = response_json(
            http.post(format!("{server}/api/device-authorizations"))
                .json(&request)
                .send()
                .await?,
            "deviceAuthorizationStart",
        )
        .await?;
        authorization_id = started["id"].as_str().map(str::to_owned);
        let consent = Url::parse(
            started["authorization_url"]
                .as_str()
                .context("授权页面无效")?,
        )?;
        let expires = started["expires_at"].as_f64().context("授权时间无效")?;
        ensure!(
            consent.origin() == base.origin()
                && consent.username().is_empty()
                && consent.password().is_none()
                && consent.fragment().is_none()
                && expires > now(),
            "授权页面与服务地址不匹配或已过期"
        );
        notice(json!({"event":"authorization","url":consent.as_str(),"expires_at":expires}));
        let code = tokio::time::timeout(
            Duration::from_secs_f64((expires - now()).clamp(0.0, 300.0)),
            receive_code(&listener, &redirect, &state),
        )
        .await
        .context("授权已取消或过期，请重新发起")??;
        ensure!(
            !cancel.load(Ordering::Acquire),
            "授权已取消或过期，请重新发起"
        );
        let token_request = super::protocol::parse(
            "deviceAuthorizationTokenRequest",
            json!({"code":code,"code_verifier":verifier,"redirect_uri":redirect.as_str()}),
        )?;
        let device = response_json(
            http.post(format!("{server}/api/device-authorizations/token"))
                .json(&token_request)
                .send()
                .await?,
            "deviceAuthorizationToken",
        )
        .await?;
        ensure!(
            device["kind"] == "computer"
                && device["capabilities"]
                    .as_array()
                    .context("设备能力无效")?
                    .iter()
                    .all(|v| matches!(v.as_str(), Some("screen" | "input" | "shell" | "files"))),
            "授权服务返回了不匹配的设备类型"
        );
        Ok::<_, anyhow::Error>(device["key"].as_str().context("设备凭据无效")?.to_owned())
    };
    let result = tokio::select! {
        biased;
        _ = cancelled(&cancel) => Err(anyhow::anyhow!("授权已取消或过期，请重新发起")),
        result = tokio::time::timeout(Duration::from_secs(300),flow) => result.context("授权已取消或过期，请重新发起").and_then(|r|r),
    };
    drop(listener);
    if result.is_err() {
        if let Some(id) = authorization_id {
            let _ = http
                .delete(format!("{server}/api/device-authorizations/{id}"))
                .timeout(Duration::from_secs(1))
                .json(&json!({"code_verifier":verifier}))
                .send()
                .await;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_rejects_wrong_host_duplicate_state_and_ambiguous_result() {
        let redirect = Url::parse("http://127.0.0.1:1234/abridge/callback").unwrap();
        let code = "abcdefghijklmnopqrstuvwxyz123456";
        let request = |query: &str, host: &str| {
            format!("GET /abridge/callback?{query} HTTP/1.1\r\nHost: {host}\r\n\r\n")
        };
        assert_eq!(
            callback(
                &request(&format!("state=secret&code={code}"), "127.0.0.1:1234"),
                &redirect,
                "secret"
            )
            .unwrap(),
            Some(code.into())
        );
        for query in [
            format!("state=wrong&code={code}"),
            format!("state=secret&state=secret&code={code}"),
            format!("state=secret&code={code}&error=denied"),
        ] {
            assert!(callback(&request(&query, "127.0.0.1:1234"), &redirect, "secret").is_err());
        }
        assert!(callback(
            &request(&format!("state=secret&code={code}"), "evil.example"),
            &redirect,
            "secret"
        )
        .is_err());
    }
}
