use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::Path,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::Threading::*,
};
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const ACCESS_DENIED_ACE_TYPE: u8 = 1;
pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
fn wide(p: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(Some(0)).collect()
}
pub fn normalize_url(s: &str, confirmed: Option<&str>) -> Result<String> {
    let u = url::Url::parse(s.trim()).map_err(|_| anyhow::anyhow!("请填写完整的 Server 地址"))?;
    ensure!(
        matches!(u.scheme(), "http" | "https")
            && u.username().is_empty()
            && u.password().is_none()
            && u.query().is_none()
            && u.fragment().is_none(),
        "Server 地址仅支持 HTTP 或 HTTPS，不能包含凭据、查询或片段"
    );
    ensure!(u.host_str().is_some(), "请填写完整的 Server 地址");
    if u.scheme() == "http" {
        let h = u.host_str().unwrap();
        ensure!(
            h == "localhost"
                || h == "127.0.0.1"
                || h == "[::1]"
                || confirmed == Some(u.origin().ascii_serialization().as_str()),
            "请先确认此 Server 使用未加密的 HTTP 连接"
        );
    }
    let text = u.to_string();
    Ok(text.strip_suffix('/').unwrap_or(&text).to_owned())
}
/// Reject reparse points and foreign owners; only owner and SYSTEM may have allow ACEs.
pub fn private_path(path: &Path, create_acl: bool) -> Result<()> {
    unsafe {
        let meta = fs::symlink_metadata(path)?;
        use std::os::windows::fs::MetadataExt;
        ensure!(
            meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0,
            "Reparse point refused"
        );
        let mut token = std::ptr::null_mut();
        ensure!(
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0,
            "Token unavailable"
        );
        let mut size = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut bytes = vec![0u8; size as usize];
        let ok = GetTokenInformation(token, TokenUser, bytes.as_mut_ptr().cast(), size, &mut size);
        CloseHandle(token);
        ensure!(ok != 0, "Token unavailable");
        let sid = (*(bytes.as_ptr() as *const TOKEN_USER)).User.Sid;
        let mut owner = std::ptr::null_mut();
        let mut acl = std::ptr::null_mut();
        let mut descriptor = std::ptr::null_mut();
        ensure!(
            GetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut acl,
                std::ptr::null_mut(),
                &mut descriptor
            ) == 0,
            "ACL unavailable"
        );
        let owned = EqualSid(owner, sid) != 0;
        LocalFree(descriptor);
        ensure!(owned, "Wrong owner");
        if create_acl {
            let mut text = std::ptr::null_mut();
            ensure!(
                ConvertSidToStringSidW(sid, &mut text) != 0,
                "SID unavailable"
            );
            let mut n = 0;
            while *text.add(n) != 0 {
                n += 1;
            }
            let who = String::from_utf16_lossy(std::slice::from_raw_parts(text, n));
            LocalFree(text.cast());
            let flags = if meta.is_dir() { "OICI" } else { "" };
            let sddl = format!("D:P(A;{flags};FA;;;{who})(A;{flags};FA;;;SY)");
            let w: Vec<u16> = sddl.encode_utf16().chain(Some(0)).collect();
            let mut sd = std::ptr::null_mut();
            ensure!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    w.as_ptr(),
                    1,
                    &mut sd,
                    std::ptr::null_mut()
                ) != 0,
                "ACL invalid"
            );
            let mut present = 0;
            let mut defaulted = 0;
            GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted);
            let result = SetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                acl,
                std::ptr::null_mut(),
            );
            LocalFree(sd);
            ensure!(result == 0, "ACL protection failed");
        }
        ensure!(
            GetNamedSecurityInfoW(
                wide(path).as_ptr(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                std::ptr::null_mut(),
                &mut acl,
                std::ptr::null_mut(),
                &mut descriptor
            ) == 0,
            "ACL unavailable"
        );
        let checked = (|| -> Result<()> {
            ensure!(
                !acl.is_null() && EqualSid(owner, sid) != 0,
                "Private ACL required"
            );
            let mut system = [0u8; 68];
            let mut length = 68;
            ensure!(
                CreateWellKnownSid(
                    WinLocalSystemSid,
                    std::ptr::null_mut(),
                    system.as_mut_ptr().cast(),
                    &mut length
                ) != 0,
                "System SID unavailable"
            );
            let mut has = false;
            for i in 0..(*acl).AceCount {
                let mut ace = std::ptr::null_mut();
                ensure!(GetAce(acl, i as u32, &mut ace) != 0, "ACL invalid");
                let header = &*(ace as *const ACE_HEADER);
                if header.AceType == ACCESS_ALLOWED_ACE_TYPE {
                    let a = &*(ace as *const ACCESS_ALLOWED_ACE);
                    let p = std::ptr::addr_of!(a.SidStart) as *mut _;
                    let own = EqualSid(p, sid) != 0;
                    ensure!(
                        own || EqualSid(p, system.as_mut_ptr().cast()) != 0,
                        "Shared access refused"
                    );
                    has |= own;
                } else {
                    ensure!(header.AceType == ACCESS_DENIED_ACE_TYPE, "Unsupported ACL");
                }
            }
            ensure!(has, "Owner access missing");
            Ok(())
        })();
        LocalFree(descriptor);
        checked
    }
}
pub fn directory(p: &Path) -> Result<()> {
    fs::create_dir_all(p)?;
    private_path(p, true)
}
pub fn read(p: &Path) -> Result<Value> {
    private_path(p, false)?;
    ensure!(fs::metadata(p)?.is_file(), "Regular file required");
    let mut b = Vec::new();
    std::fs::File::open(p)?.take(131073).read_to_end(&mut b)?;
    ensure!(b.len() <= 131072, "State too large");
    Ok(serde_json::from_slice(&b)?)
}
pub fn write(p: &Path, v: &Value) -> Result<()> {
    private_path(p.parent().context("State parent")?, false)?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| anyhow::anyhow!("Random unavailable"))?;
    let temp = p.with_extension(format!("{:x}.tmp", u128::from_le_bytes(nonce)));
    let result = (|| -> Result<()> {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        private_path(&temp, true)?;
        f.write_all(&serde_json::to_vec(v)?)?;
        f.sync_all()?;
        drop(f);
        replace_private(&temp, p)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}
fn replace_private(temp: &Path, target: &Path) -> Result<()> {
    use std::time::{Duration, Instant};
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut delay = Duration::from_millis(10);
    let source = wide(temp);
    let destination = wide(target);
    loop {
        // A retry never relaxes ownership or follows a newly introduced junction.
        private_path(target.parent().context("State parent")?, false)?;
        match fs::symlink_metadata(target) {
            Ok(info) => {
                ensure!(
                    info.is_file(),
                    "State destination must be a regular private file"
                );
                private_path(target, false)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        let code = unsafe {
            if MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            ) != 0
            {
                return Ok(());
            }
            GetLastError()
        };
        if !matches!(
            code,
            ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION
        ) || Instant::now() >= deadline
        {
            anyhow::bail!(
                "Atomic state replacement failed ({}, Win32 error {code})",
                target.file_name().unwrap_or_default().to_string_lossy()
            );
        }
        // Windows can temporarily deny replacement while a reader/scanner holds
        // a handle without FILE_SHARE_DELETE. Keep the fully synced temporary
        // file and retry the same atomic operation; never remove the old target.
        std::thread::sleep(delay.min(deadline.saturating_duration_since(Instant::now())));
        delay = (delay * 2).min(Duration::from_millis(80));
    }
}
pub fn config(dir: &Path) -> Result<Value> {
    private_path(dir, false)?;
    let v = read(&dir.join("config.json"))?;
    normalize_url(
        v["url"]
            .as_str()
            .context("Bind this device in aBridge settings")?,
        v["http_confirmed_origin"].as_str(),
    )?;
    ensure!(
        v["paused"].is_boolean() && v["capabilities"].is_object(),
        "Invalid configuration"
    );
    Ok(v)
}
pub fn credential(dir: &Path, url: &str) -> Result<String> {
    private_path(dir, false)?;
    private_path(&dir.join("credentials"), false)?;
    let v = read(&dir.join("credentials/device.json"))?;
    ensure!(
        v["server_url"] == url,
        "Credential belongs to another server"
    );
    let key = v["device_key"].as_str().context("Rebind this device")?;
    ensure!(
        key.starts_with("abr_device_") && key.len() <= 4096,
        "Invalid Device Key"
    );
    Ok(key.into())
}
pub fn bind(
    dir: &Path,
    url: &str,
    key: &str,
    caps: Value,
    confirmed: Option<&str>,
) -> Result<Value> {
    ensure!(
        key.starts_with("abr_device_") && key.len() <= 4096,
        "Invalid Device Key"
    );
    directory(dir)?;
    directory(&dir.join("credentials"))?;
    let old = if dir.join("config.json").exists() {
        Some(config(dir)?)
    } else {
        None
    };
    let mut cfg = json!({"url":url,"capabilities":caps,"paused":old.as_ref().and_then(|v|v["paused"].as_bool()).unwrap_or(false)});
    if let Some(v) = old.and_then(|v| v.get("pause_reason").cloned()) {
        cfg["pause_reason"] = v;
    }
    if let Some(c) = confirmed
        .filter(|c| url::Url::parse(url).is_ok_and(|u| u.origin().ascii_serialization() == *c))
    {
        cfg["http_confirmed_origin"] = json!(c);
    }
    write(
        &dir.join("credentials/device.json"),
        &json!({"server_url":url,"device_key":key}),
    )?;
    write(&dir.join("config.json"), &cfg)?;
    Ok(cfg)
}
pub struct Journal(rusqlite::Connection);
impl Journal {
    pub fn open(dir: &Path) -> Result<Self> {
        private_path(dir, false)?;
        if dir.join("operations.sqlite3").exists() {
            private_path(&dir.join("operations.sqlite3"), false)?;
        }
        let c = rusqlite::Connection::open(dir.join("operations.sqlite3"))?;
        c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,status TEXT NOT NULL,updated_at REAL NOT NULL); UPDATE operations SET status='outcome_unknown' WHERE status='executing'")?;
        private_path(&dir.join("operations.sqlite3"), true)?;
        Ok(Self(c))
    }
    pub fn get(&self, id: &str) -> Result<Option<(String, String)>> {
        use rusqlite::OptionalExtension;
        Ok(self
            .0
            .query_row(
                "SELECT request_hash,status FROM operations WHERE id=?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?)
    }
    pub fn start(&self, id: &str, hash: &str) -> Result<()> {
        self.0.execute(
            "INSERT INTO operations VALUES(?,?,?,?)",
            rusqlite::params![id, hash, "executing", now()],
        )?;
        Ok(())
    }
    pub fn finish(&self, id: &str, status: &str) -> Result<()> {
        self.0.execute(
            "UPDATE operations SET status=?,updated_at=? WHERE id=?",
            rusqlite::params![status, now(), id],
        )?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_state_and_existing_sqlite_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        directory(dir.path()).unwrap();
        let cfg = bind(
            dir.path(),
            "https://example.test",
            "abr_device_fixture",
            json!({"screen":false,"input":false,"shell":true,"files":true}),
            None,
        )
        .unwrap();
        assert_eq!(config(dir.path()).unwrap(), cfg);
        assert_eq!(
            credential(dir.path(), "https://example.test").unwrap(),
            "abr_device_fixture"
        );
        assert!(credential(dir.path(), "https://other.test").is_err());
        let path = dir.path().join("operations.sqlite3");
        {
            let old = rusqlite::Connection::open(&path).unwrap();
            old.execute_batch("CREATE TABLE operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,status TEXT NOT NULL,updated_at REAL NOT NULL); INSERT INTO operations VALUES('old','digest','executing',1)").unwrap();
        }
        let journal = Journal::open(dir.path()).unwrap();
        assert_eq!(
            journal.get("old").unwrap(),
            Some(("digest".into(), "outcome_unknown".into()))
        );
        assert!(journal.start("old", "digest").is_err());
        journal.start("new", "hash").unwrap();
        journal.finish("new", "executed").unwrap();
        assert_eq!(
            journal.get("new").unwrap(),
            Some(("hash".into(), "executed".into()))
        );
    }
    #[test]
    fn insecure_origin_requires_exact_confirmation() {
        assert!(normalize_url("http://example.test", None).is_err());
        assert!(normalize_url("http://example.test", Some("http://other.test")).is_err());
        assert_eq!(
            normalize_url("http://example.test/", Some("http://example.test")).unwrap(),
            "http://example.test"
        );
        assert!(normalize_url("https://user:pass@example.test", None).is_err());
    }
    #[test]
    fn shared_acl_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        directory(dir.path()).unwrap();
        let file = dir.path().join("value.json");
        write(&file, &json!({"secret":"fixture"})).unwrap();
        private_path(&file, false).unwrap();
        unsafe {
            let sddl: Vec<u16> = "D:P(A;;FA;;;WD)".encode_utf16().chain(Some(0)).collect();
            let mut sd = std::ptr::null_mut();
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut sd,
                    std::ptr::null_mut()
                ),
                0
            );
            let mut present = 0;
            let mut acl = std::ptr::null_mut();
            let mut defaulted = 0;
            GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted);
            assert_eq!(
                SetNamedSecurityInfoW(
                    wide(&file).as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    acl,
                    std::ptr::null_mut()
                ),
                0
            );
            LocalFree(sd);
        }
        assert!(read(&file).is_err());
        private_path(&file, true).unwrap();
    }
}
#[cfg(test)]
mod replacement_tests {
    use super::*;
    use std::{
        os::windows::fs::OpenOptionsExt,
        time::{Duration, Instant},
    };
    fn locked_target(dir: &Path) -> (std::path::PathBuf, std::fs::File) {
        directory(dir).unwrap();
        let target = dir.join("config.json");
        write(&target, &json!({"value":"old"})).unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&target)
            .unwrap();
        (target, held)
    }
    #[test]
    fn shared_delete_lock_exhaustion_preserves_old_file_then_unlock_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let (target, held) = locked_target(dir.path());
        let start = Instant::now();
        let error = write(&target, &json!({"value":"new"}))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("config.json")
                && (error.contains("Win32 error 5")
                    || error.contains("Win32 error 32")
                    || error.contains("Win32 error 33")),
            "{error}"
        );
        assert!(start.elapsed() >= Duration::from_millis(450));
        assert!(start.elapsed() < Duration::from_secs(3));
        assert_eq!(read(&target).unwrap(), json!({"value":"old"}));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        drop(held);
        write(&target, &json!({"value":"new"})).unwrap();
        assert_eq!(read(&target).unwrap(), json!({"value":"new"}));
    }
    #[test]
    fn transient_shared_delete_lock_retries_same_atomic_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let (target, held) = locked_target(dir.path());
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            drop(held);
        });
        write(&target, &json!({"value":"new"})).unwrap();
        release.join().unwrap();
        assert_eq!(read(&target).unwrap(), json!({"value":"new"}));
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        private_path(&target, false).unwrap();
    }
    #[test]
    fn destination_directory_is_not_removed_or_replaced() {
        let dir = tempfile::tempdir().unwrap();
        directory(dir.path()).unwrap();
        let target = dir.path().join("config.json");
        directory(&target).unwrap();
        assert!(write(&target, &json!({"value":"new"})).is_err());
        assert!(target.is_dir());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
