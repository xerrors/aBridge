use super::{
    driver::Driver,
    executor::{check, string, Cancel, ExecError, Result},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant},
};
struct Observation {
    id: String,
    created: Instant,
    target: Value,
    refs: HashMap<String, Value>,
    width: f64,
    height: f64,
    capture: Value,
    focus: Option<String>,
}
#[derive(Default)]
pub struct Computer {
    pub driver: Driver,
    observations: HashMap<String, Observation>,
    targets: HashMap<String, Value>,
    closed: HashSet<String>,
    sequence: Option<u64>,
}
impl Computer {
    fn next_observation_id(&mut self) -> Result<String> {
        // Match the shared reference generator: an OS-random 48-bit starting point,
        // monotonic across sessions, with no wrapping into previously issued references.
        let next = if let Some(next) = self.sequence {
            next
        } else {
            let mut bytes = [0u8; 8];
            getrandom::fill(&mut bytes[2..]).map_err(|_| {
                ExecError::new("random_unavailable", "System random source unavailable")
            })?;
            u64::from_be_bytes(bytes)
        };
        if next >= 1 << 48 {
            return Err(ExecError::new(
                "references_exhausted",
                "Observation references exhausted; restart the client",
            ));
        }
        self.sequence = Some(next + 1);
        Ok(format!(
            "obs_{}",
            URL_SAFE_NO_PAD.encode(&next.to_be_bytes()[2..])
        ))
    }
    fn focus(&mut self, cancel: &Cancel) -> Result<String> {
        let apps = self.driver.call("apps", json!({}), cancel)?;
        let active: Vec<_> = apps
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["active"] == true && a["running"] == true)
            .collect();
        if active.len() != 1 {
            return Err(ExecError::new(
                "focus_unavailable",
                "Cannot verify active application",
            ));
        }
        let windows = self
            .driver
            .call("windows", json!({"pid":active[0]["pid"]}), cancel)?;
        let mut rows: Vec<_> = windows
            .as_array()
            .into_iter()
            .flatten()
            .filter(|w| w["is_on_screen"] == true && w["layer"] == 0)
            .collect();
        rows.sort_by_key(|w| std::cmp::Reverse(w["z_index"].as_i64().unwrap_or(0)));
        let first = rows
            .first()
            .ok_or_else(|| ExecError::new("focus_unavailable", "Cannot verify front window"))?;
        if rows
            .get(1)
            .is_some_and(|second| second["z_index"] == first["z_index"])
        {
            return Err(ExecError::new(
                "focus_unavailable",
                "Cannot verify the front window",
            ));
        }
        Ok(format!("{}:{}", active[0]["pid"], first["window_id"]))
    }
    pub fn execute(
        &mut self,
        tool: &str,
        args: &Value,
        session: &str,
        cancel: &Cancel,
    ) -> Result<Value> {
        check(cancel)?;
        if self.closed.contains(session) {
            return Err(ExecError::new(
                "session_closed",
                "Desktop session has closed",
            ));
        }
        match tool {
            "computer_apps" => {
                let raw = self.driver.call("apps", json!({}), cancel)?;
                let query = args["query"].as_str().map(str::to_lowercase);
                let mut rows: Vec<Value> = raw
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|a| {
                        query
                            .as_ref()
                            .map(|q| {
                                format!(
                                    "{} {} {}",
                                    a["name"].as_str().unwrap_or(""),
                                    a["window_title"].as_str().unwrap_or(""),
                                    a["bundle_id"].as_str().unwrap_or("")
                                )
                                .to_lowercase()
                                .contains(q)
                            })
                            .unwrap_or(a["running"] == true)
                    })
                    .cloned()
                    .collect();
                rows.sort_by_key(|v| v["running"] != true);
                let total = rows.len();
                rows.truncate(200);
                while serde_json::to_vec(&rows).unwrap().len() > 6000 {
                    rows.pop();
                }
                let mut result =
                    json!({"apps":rows,"matches_total":total,"truncated":rows.len()<total});
                if query.is_some() && !rows.iter().any(|a| a["running"] == true) {
                    let mut alternatives: Vec<_> = raw
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|a| a["running"] == true && a["pid"].as_u64().unwrap_or(0) > 0)
                        .cloned()
                        .collect();
                    alternatives.sort_by_key(|a| a["active"] != true);
                    alternatives.truncate(20);
                    while serde_json::to_vec(&alternatives).unwrap().len() > 4000 {
                        alternatives.pop();
                    }
                    if !alternatives.is_empty() {
                        result["running_alternatives"] = json!(alternatives);
                        result["guidance"]=json!("No running app matched this text. Localized launcher names can differ from process names. Inspect these running alternatives and their window titles before launching an installed entry; each bundle_id identifies its own process.");
                    }
                }
                Ok(result)
            }
            "computer_windows" => {
                let raw = self
                    .driver
                    .call("windows", json!({"pid":args["pid"]}), cancel)?;
                let rows: Vec<_> = raw
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(200)
                    .cloned()
                    .collect();
                let running = args["pid"].as_u64().map(|pid| unsafe {
                    use windows_sys::Win32::{
                        Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED},
                        System::Threading::{
                            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
                        },
                    };
                    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
                    if handle.is_null() {
                        return GetLastError() == ERROR_ACCESS_DENIED;
                    }
                    let mut exit = 0;
                    let alive = GetExitCodeProcess(handle, &mut exit) != 0 && exit == 259;
                    CloseHandle(handle);
                    alive
                });
                let mut result = json!({"windows":rows,"requested_pid":args["pid"],"process_running":running,"on_screen_only":false,"truncated":raw.as_array().is_some_and(|r|r.len()>200),"empty_reason":if rows.is_empty(){if running==Some(false){json!("process_not_running")}else{json!("no_windows_reported")}}else{Value::Null}});
                if rows.is_empty() {
                    result["guidance"]=json!("Refresh computer_apps/windows and observe a returned pid/window_id; off-screen windows are included");
                }
                Ok(result)
            }
            "computer_observe" => self.observe(args, session, cancel),
            "computer_act" => self.act(args, session, cancel),
            "computer_open" => {
                let started = Instant::now();
                let bundle = string(args, "bundle_id")?;
                let apps = self.driver.call("apps", json!({}), cancel)?;
                if !apps
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|a| a["bundle_id"] == bundle)
                {
                    return Err(ExecError::new(
                        "app_not_found",
                        "Application is not installed",
                    ));
                }
                self.driver
                    .call("open", json!({"bundle_id":bundle}), cancel)?;
                let deadline = started + Duration::from_secs(25);
                self.driver.deadline = Some(deadline);
                let follow_up = (|| -> Result<Value> {
                    let mut result = json!({"launch_requested":true,"bundle_id":bundle});
                    for _ in 0..16 {
                        check(cancel)?;
                        let apps = self.driver.call("apps", json!({}), cancel)?;
                        if let Some(app) = apps
                            .as_array()
                            .into_iter()
                            .flatten()
                            .find(|a| a["bundle_id"] == bundle && a["running"] == true)
                        {
                            let windows =
                                self.driver
                                    .call("windows", json!({"pid":app["pid"]}), cancel)?;
                            let mut rows: Vec<_> = windows
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|w| {
                                    w["layer"] == 0
                                        && w["bounds"]["width"].as_f64().unwrap_or(0.) > 0.
                                        && w["bounds"]["height"].as_f64().unwrap_or(0.) > 0.
                                })
                                .collect();
                            rows.sort_by_key(|w| {
                                (
                                    w["is_focused"] != true,
                                    w["is_on_screen"] != true,
                                    std::cmp::Reverse(
                                        w["bounds"]["width"].as_i64().unwrap_or(0)
                                            * w["bounds"]["height"].as_i64().unwrap_or(0),
                                    ),
                                )
                            });
                            if let Some(w) = rows.first() {
                                let target = json!({"pid":app["pid"],"window_id":w["window_id"]});
                                self.targets.insert(session.into(), target.clone());
                                self.observations.remove(session);
                                match self.observe(
                                    &json!({
                                        "pid":app["pid"], "window_id":w["window_id"],
                                        "screenshot":args["screenshot"].as_bool().unwrap_or(false)
                                    }),
                                    session,
                                    cancel,
                                ) {
                                    Ok(value) => result["observation"] = value,
                                    Err(error) => {
                                        check(cancel)?;
                                        result["window"] = target;
                                        result["observation_error"] = json!({
                                            "code":if Instant::now() >= deadline { "observation_timeout" } else { &error.code },
                                            "message":"Application launched; observe selected window again without reopening it"
                                        });
                                    }
                                }
                                return Ok(result);
                            }
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                    result["observation_error"] = json!({"code":"window_unavailable","message":"Application launched but no ordinary window appeared"});
                    Ok(result)
                })();
                self.driver.deadline = None;
                check(cancel)?;
                match follow_up {
                    Ok(value) => Ok(value),
                    Err(error) => Ok(json!({
                        "launch_requested":true,"bundle_id":bundle,
                        "observation_error":{
                            "code":if Instant::now() >= deadline { "window_discovery_timeout" } else { &error.code },
                            "message":"Application launch requested; follow-up window observation unavailable"
                        }
                    })),
                }
            }
            _ => Err(ExecError::new("unknown_tool", "Unsupported desktop tool")),
        }
    }
    fn observe(&mut self, args: &Value, session: &str, cancel: &Cancel) -> Result<Value> {
        let target = if args.get("pid").is_some() || args.get("window_id").is_some() {
            if args["desktop"] == true {
                return Err(ExecError::new(
                    "invalid_arguments",
                    "Select a window or desktop",
                ));
            }
            if args["pid"].as_u64().unwrap_or(0) == 0
                || args["window_id"].as_u64().unwrap_or(0) == 0
            {
                return Err(ExecError::new(
                    "invalid_arguments",
                    "Select a returned pid and window_id",
                ));
            }
            json!({"pid":args["pid"],"window_id":args["window_id"]})
        } else if args["desktop"] == true {
            json!({"desktop":true})
        } else {
            self.targets.get(session).cloned().ok_or_else(|| {
                ExecError::new(
                    "target_required",
                    "Select a window, or explicitly request desktop",
                )
            })?
        };
        let focus = if target["desktop"] == true {
            Some(self.focus(cancel)?)
        } else {
            None
        };
        let raw=self.driver.call("observe",json!({"session":session,"target":target,"screenshot":args["screenshot"].as_bool().unwrap_or(true)}),cancel)?;
        check(cancel)?;
        if let Some(ref prior) = focus {
            if *prior != self.focus(cancel)? {
                return Err(ExecError::new(
                    "focus_changed",
                    "Front window changed during observation",
                ));
            }
        }
        let id = self.next_observation_id()?;
        let mut observation = Observation {
            id: id.clone(),
            created: Instant::now(),
            target: target.clone(),
            refs: HashMap::new(),
            width: raw["width"].as_f64().unwrap_or(0.),
            height: raw["height"].as_f64().unwrap_or(0.),
            capture: raw["capture_id"].clone(),
            focus,
        };
        let mut result = json!({"observation_id":id,"app_name":raw["app_name"],"window_title":raw["window_title"]});
        if target["desktop"] == true {
            result["desktop"] = json!(true);
        } else {
            result["window"] = target.clone();
        }
        for k in ["is_focused", "accessibility_status", "accessibility_limit"] {
            if let Some(v) = raw.get(k) {
                result[k] = v.clone();
            }
        }
        let valid_image = raw["image_base64"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= super::protocol::contract().limits.image_bytes.div_ceil(3) * 4
        }) && matches!(
            raw["mime_type"].as_str(),
            Some("image/png" | "image/jpeg" | "image/webp")
        );
        let pixel = valid_image
            && observation.width > 0.
            && observation.height > 0.
            && raw["frame_valid"] != false;
        let query = args["query"].as_str().map(str::to_lowercase);
        let mut rows = Vec::new();
        let mut total = 0;
        let mut truncated = raw["truncated"] == true;
        for e in raw["elements"].as_array().into_iter().flatten() {
            let role = e["role"].as_str().unwrap_or("").to_lowercase();
            let protected = ["secure", "password", "protected"]
                .iter()
                .any(|kind| role.contains(kind));
            let label = e["label"].as_str().unwrap_or("");
            let value = if protected { None } else { e["value"].as_str() };
            if query.as_ref().is_some_and(|q| {
                !format!("{label} {}", value.unwrap_or(""))
                    .to_lowercase()
                    .contains(q)
            }) {
                continue;
            }
            let actionable =
                e["token"].is_string() && e["actions"].as_array().is_some_and(|a| !a.is_empty());
            if label.is_empty() && value.is_none() && !actionable {
                continue;
            }
            total += 1;
            let mut row = json!({"role":e["role"],"label":label.chars().take(if query.is_some(){2000}else{240}).collect::<String>(),"depth":e["depth"]});
            if let Some(v) = value {
                row["value"] = json!(v
                    .chars()
                    .take(if query.is_some() { 4500 } else { 384 })
                    .collect::<String>());
            }
            let reference = format!("e{}", rows.len() + 1);
            if actionable {
                row["element_ref"] = json!(reference);
                row["actions"] = e["actions"].clone();
                if pixel {
                    if let Some(b) = e.get("bounds") {
                        row["bounds"] = b.clone();
                    }
                }
            }
            for k in ["enabled", "selected"] {
                if let Some(v) = e.get(k) {
                    row[k] = v.clone();
                }
            }
            rows.push(row);
            if serde_json::to_vec(&rows).unwrap().len() > 7000 {
                rows.pop();
                truncated = true;
                break;
            }
            if actionable {
                observation.refs.insert(reference, e["token"].clone());
            }
        }
        result["elements"] = json!(rows);
        result["elements_total"] = json!(total);
        result["truncated"] = json!(truncated);
        if truncated {
            result["next_step"]=json!("UIA results are partial. query only filters this bounded snapshot and does not extend traversal. Use a suitable action already present, or locate the target in a fresh window screenshot.");
        }
        if query.is_some() && total == 0 {
            result["next_step"] = json!(if raw["accessibility_limit"] == "time_budget" {
                "No match in the time-limited UIA snapshot. This does not prove the control is absent. Use the current window screenshot, or request one if missing; another query does not extend traversal."
            } else {
                "No literal substring matched. query takes one text substring, not a JSON list or regular expression. For unlabeled controls, omit query, request a screenshot, and identify element_ref using its bounds and the image."
            });
        }
        if target.get("pid").is_some() {
            result["interaction_guidance"] = json!(if pixel {
                "Prefer an element_ref whose actions include the requested semantic operation. Double/right/middle/modifier clicks require explicit screenshot coordinates. If UIA is unavailable, incomplete, or has no suitable control, use this window screenshot to locate the target and use coordinates with this observation_id. query only filters the current UIA snapshot; repeated queries do not make non-interactive text actionable. After an ineffective or uncertain action, observe and verify the actual result before switching methods; never blindly repeat a send or submission."
            } else {
                "Prefer an element_ref whose actions include the requested semantic operation. Double/right/middle/modifier clicks require explicit screenshot coordinates. If UIA has no suitable control, request a fresh window screenshot before using coordinates. query only filters the current UIA snapshot; repeated queries do not make non-interactive text actionable. Verify uncertain or ineffective actions before switching methods; never blindly repeat a send or submission."
            });
        }
        result["pixel_actions"] = json!(pixel);
        if let Some(image) = raw["image_base64"].as_str().filter(|_| valid_image) {
            result["image_base64"] = json!(image);
            result["mime_type"] = raw["mime_type"].clone();
        }
        if pixel {
            result["geometry"] = json!({"width":observation.width,"height":observation.height});
            result["coordinate_space"] = json!("screenshot_pixels");
            result["element_bounds_space"] = json!("screenshot_pixels");
            result["supported_coordinate_spaces"] = json!(["screenshot_pixels", "normalized_1000"]);
        } else {
            observation.width = 0.;
            observation.height = 0.;
        }
        self.targets.insert(session.into(), target);
        self.observations.insert(session.into(), observation);
        Ok(result)
    }
    fn act(&mut self, args: &Value, session: &str, cancel: &Cancel) -> Result<Value> {
        let o = self.observations.get(session).ok_or_else(|| {
            ExecError::new("stale_observation", "Observe target again before acting")
        })?;
        if args["observation_id"] != o.id
            || o.created.elapsed()
                > Duration::from_secs_f64(
                    super::protocol::contract()
                        .limits
                        .desktop_observation_seconds,
                )
        {
            return Err(ExecError::new(
                "stale_observation",
                "Observe target again before acting",
            ));
        }
        let action = &args["action"];
        let kind = string(action, "type")?;
        if ![
            "click",
            "double_click",
            "type",
            "key",
            "move",
            "drag",
            "scroll",
        ]
        .contains(&kind)
        {
            return Err(ExecError::new(
                "invalid_arguments",
                "Unsupported desktop action",
            ));
        }
        if action["delivery_mode"] == "background"
            || action.get("mode").is_some_and(|v| v != "foreground")
        {
            return Err(ExecError::new(
                "invalid_arguments",
                "Windows requires foreground input",
            ));
        }
        let mut native = action.clone();
        native
            .as_object_mut()
            .ok_or_else(|| ExecError::new("invalid_arguments", "action must be object"))?
            .remove("type");
        native["action"] = json!(kind);
        native["target"] = o.target.clone();
        native["capture_id"] = o.capture.clone();
        native["session"] = json!(session);
        if let Some(reference) = action["element_ref"].as_str() {
            native["native_ref"] = o.refs.get(reference).cloned().ok_or_else(|| {
                ExecError::new(
                    "invalid_reference",
                    "Element reference is not in this observation",
                )
            })?;
            if action.get("x").is_some() || action.get("y").is_some() {
                return Err(ExecError::new(
                    "invalid_arguments",
                    "Use element reference or coordinates",
                ));
            }
        }
        let point = |x: &Value, y: &Value| -> Result<(f64, f64)> {
            if o.width <= 0. || o.height <= 0. {
                return Err(ExecError::new(
                    "screenshot_required",
                    "Observe with screenshot before pixel actions",
                ));
            }
            let (mut x, mut y) = (x.as_f64().unwrap_or(-1.), y.as_f64().unwrap_or(-1.));
            if action["coordinate_space"] == "normalized_1000" {
                if !(0. ..=1000.).contains(&x) || !(0. ..=1000.).contains(&y) {
                    return Err(ExecError::new(
                        "invalid_arguments",
                        "Normalized coordinates outside 0–1000",
                    ));
                }
                x = (x * o.width / 1000.).floor().min(o.width - 1.);
                y = (y * o.height / 1000.).floor().min(o.height - 1.);
            }
            if x < 0. || y < 0. || x >= o.width || y >= o.height {
                return Err(ExecError::new(
                    "invalid_arguments",
                    "Coordinates outside observed screenshot",
                ));
            }
            Ok((x, y))
        };
        if (["click", "double_click"].contains(&kind) && action.get("element_ref").is_none())
            || ["move", "drag"].contains(&kind)
        {
            let (x, y) = point(&action["x"], &action["y"])?;
            native["x"] = json!(x);
            native["y"] = json!(y);
        }
        if kind == "drag" {
            let (x, y) = point(&action["to_x"], &action["to_y"])?;
            native["to_x"] = json!(x);
            native["to_y"] = json!(y);
        }
        if kind == "scroll" {
            let (dx, dy) = (
                action["delta_x"].as_f64().unwrap_or(0.),
                action["delta_y"].as_f64().unwrap_or(0.),
            );
            if dx.abs() > 10000. || dy.abs() > 10000. || (dx == 0.) == (dy == 0.) {
                return Err(ExecError::new(
                    "invalid_arguments",
                    "Scroll requires one nonzero axis",
                ));
            }
            let (x, y) = if action.get("x").is_some() {
                point(&action["x"], &action["y"])?
            } else {
                point(
                    &json!((o.width / 2.).floor()),
                    &json!((o.height / 2.).floor()),
                )?
            };
            native["x"] = json!(x);
            native["y"] = json!(y);
            native["delta_x"] = json!(dx);
            native["delta_y"] = json!(dy);
        }
        if kind == "type" {
            let s = string(action, "text")?;
            if s.encode_utf16().count() > 10000 || s.contains('\0') {
                return Err(ExecError::new("invalid_arguments", "Invalid text"));
            }
        }
        if kind == "key" {
            let s = string(action, "key")?;
            if s.is_empty() || s.len() > 100 {
                return Err(ExecError::new("invalid_arguments", "Invalid key"));
            }
        }
        if let Some(mods) = action["modifiers"].as_array() {
            let mut mapped = Vec::new();
            for m in mods {
                let m = m.as_str().unwrap_or("");
                if ![
                    "cmd", "command", "meta", "win", "ctrl", "control", "alt", "option", "shift",
                    "fn",
                ]
                .contains(&m)
                {
                    return Err(ExecError::new("invalid_arguments", "Invalid modifier"));
                }
                mapped.push(match m {
                    "command" => "cmd",
                    "control" => "ctrl",
                    "alt" => "option",
                    _ => m,
                });
            }
            native["modifiers"] = json!(mapped);
        }
        let focus = o.focus.clone();
        let target = o.target.clone();
        let wait = super::executor::number(args, "wait_after_ms", 2000, 0, 10000)?;
        if args["screenshot"] == true && args["observe_after"] == false {
            return Err(ExecError::new(
                "invalid_arguments",
                "screenshot requires observe_after",
            ));
        }
        check(cancel)?;
        if let Some(f) = focus {
            if f != self.focus(cancel)? {
                return Err(ExecError::new(
                    "focus_changed",
                    "Front window changed; observe again",
                ));
            }
        }
        self.observations.remove(session);
        let mut result = self.driver.call("act", native, cancel)?;
        if args["observe_after"] == false {
            return Ok(result);
        }
        let followup = (|| {
            let start = Instant::now();
            while start.elapsed() < Duration::from_millis(wait) {
                check(cancel)?;
                std::thread::sleep(Duration::from_millis(20));
            }
            let mut request = target;
            request["screenshot"] = json!(args["screenshot"] == true);
            self.observe(&request, session, cancel)
        })();
        match followup {
            Ok(v) => result["observation"] = v,
            Err(e) => {
                result["observation_error"] = json!({"code":e.code,"message":"Action delivered; follow-up observation unavailable. Verify the actual result; do not repeat the delivered action."})
            }
        }
        Ok(result)
    }
    pub fn invalidate(&mut self, id: &str) {
        self.observations.remove(id);
    }
    pub fn close_session(&mut self, id: &str) {
        self.closed.insert(id.into());
        self.observations.remove(id);
        self.targets.remove(id);
        if self.driver.is_started() {
            let _ = self.driver.call(
                "release",
                json!({"session":id}),
                &Arc::new(AtomicBool::new(false)),
            );
        }
    }
    pub fn stop(&mut self) {
        for id in self.targets.keys().cloned().collect::<Vec<_>>() {
            self.close_session(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generated_observations_are_accepted_by_shared_action_contract() {
        let mut computer = Computer::default();
        let first = computer.next_observation_id().unwrap();
        computer.invalidate("session-one");
        let second = computer.next_observation_id().unwrap();
        assert_ne!(first, second);
        for id in [first, second] {
            super::super::protocol::parse(
                "computer_act",
                json!({
                    "observation_id": id,
                    "action": {"type":"click", "element_ref":"e1"}
                }),
            )
            .unwrap();
        }
        assert!(super::super::protocol::parse(
            "computer_act",
            json!({
                "observation_id":"obs_33064_1",
                "action":{"type":"click","element_ref":"e1"}
            })
        )
        .is_err());
    }
    #[test]
    fn observation_reference_exhaustion_never_wraps() {
        let mut computer = Computer {
            sequence: Some((1u64 << 48) - 1),
            ..Default::default()
        };
        let last = computer.next_observation_id().unwrap();
        super::super::protocol::parse(
            "computer_act",
            json!({
                "observation_id":last,
                "action":{"type":"click","element_ref":"e1"}
            }),
        )
        .unwrap();
        assert_eq!(
            computer.next_observation_id().unwrap_err().code,
            "references_exhausted"
        );
    }
}
