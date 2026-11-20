use serde_json::{json, Value};
pub fn view(s: &Value) -> Value {
    let bound = s["bound"] == true;
    let paused = s["paused"] == true;
    let count = s["active_operations"].as_u64().unwrap_or(0);
    let now = super::storage::now();
    let fresh = s["updated_at"]
        .as_f64()
        .is_some_and(|v| now - v < 10. && v <= now + 5.);
    let online = s["connection"] == "online" && fresh;
    let (kind, label, title, detail) = if s["connection"] == "online" && !fresh {
        (
            "unknown",
            "状态待确认",
            "正在确认设备状态",
            "暂时无法读取最新状态，请刷新或检查连接。".into(),
        )
    } else if s["busy"] == true && !bound {
        (
            "authorizing",
            "等待授权",
            "在浏览器中完成连接",
            "确认服务器上的授权页面，完成后会自动连接。".into(),
        )
    } else if !bound {
        (
            "unbound",
            "尚未连接",
            "让智能体连接这台电脑",
            "添加服务器并确认授权，即可使用你开放的本机能力。".into(),
        )
    } else if !online {
        (
            "offline",
            if paused {
                "离线 · 已暂停"
            } else {
                "连接中断"
            },
            "正在等待服务器连接",
            if paused {
                "暂停状态已保留；连接恢复后仍需手动恢复操作。"
            } else {
                "设备绑定已保留，请检查服务器或本机连接后重连。"
            }
            .into(),
        )
    } else if paused {
        (
            "paused",
            "已暂停",
            "控制权在你手中",
            if s["pause_reason"] == "desktop_input" {
                "检测到本机操作，已暂停自动控制。准备好后可手动恢复。"
            } else {
                "新的远程操作已暂停。准备好后，可随时恢复。"
            }
            .into(),
        )
    } else if count > 0 {
        (
            "active",
            "正在执行",
            "智能体正在使用这台电脑",
            format!("{count} 项操作进行中。你可以随时暂停或停止当前任务。"),
        )
    } else {
        (
            "ready",
            "在线待命",
            "已连接，等待任务",
            "已准备好接收授权智能体的任务，当前没有正在执行的操作。".into(),
        )
    };
    json!({"kind":kind,"label":label,"title":title,"detail":detail,"bound":bound,"paused":paused,"online":online,"operations":if online{count}else{0}})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn states() {
        assert_eq!(view(&json!({"bound":false}))["kind"], "unbound");
        assert_eq!(
            view(&json!({"bound":false,"busy":true}))["kind"],
            "authorizing"
        );
        let mut s = json!({"bound":true,"paused":false,"connection":"online","updated_at":super::super::storage::now()});
        assert_eq!(view(&s)["kind"], "ready");
        s["paused"] = json!(true);
        assert_eq!(view(&s)["kind"], "paused");
        s["paused"] = json!(false);
        s["active_operations"] = json!(2);
        assert_eq!(view(&s)["kind"], "active");
        s["updated_at"] = json!(0);
        assert_eq!(view(&s)["kind"], "unknown");
        s["connection"] = json!("offline");
        assert_eq!(view(&s)["operations"], 0);
    }
}
