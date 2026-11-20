use crate::{
    flag,
    frames::Frames,
    host::{Host, Message, Pending},
    text, wide,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::{Dwm::*, Gdi::*},
    System::{LibraryLoader::*, Registry::*, Threading::*},
    UI::{Controls::*, HiDpi::*, Input::KeyboardAndMouse::*, Shell::*, WindowsAndMessaging::*},
};
const HOST_TIMER: usize = 0xAB42;
type LayoutState = ([i32; 4], [bool; 5], bool);
const CAPS: [&str; 4] = ["screen", "input", "shell", "files"];
struct App {
    hwnd: HWND,
    destroyed: bool,
    controls: HashMap<u16, HWND>,
    host: Host,
    frames: Frames,
    activation: HANDLE,
    preferences: PathBuf,
    status: Value,
    healthy: bool,
    active: bool,
    bound: bool,
    paused: bool,
    binding: bool,
    quitting: bool,
    has_status: bool,
    heartbeat: Instant,
    sections: [bool; 5],
    theme: i32,
    dark: bool,
    background: HBRUSH,
    input: HBRUSH,
    font: HFONT,
    title_font: HFONT,
    status_font: HFONT,
    scroll: i32,
    content_height: i32,
    status_error: String,
    transport_error: String,
    tray: NOTIFYICONDATAW,
    taskbar_created: u32,
    tray_callback: u32,
    layout_state: Option<LayoutState>,
    online_color: bool,
}
unsafe fn label(hwnd: HWND, s: &str) {
    if read(hwnd) != s {
        SetWindowTextW(hwnd, wide(s).as_ptr());
    }
}
unsafe fn read(hwnd: HWND) -> String {
    let mut b = vec![0; GetWindowTextLengthW(hwnd) as usize + 1];
    let n = GetWindowTextW(hwnd, b.as_mut_ptr(), b.len() as i32);
    String::from_utf16_lossy(&b[..n as usize])
}
unsafe fn enabled(hwnd: HWND, value: i32) {
    if (IsWindowEnabled(hwnd) != 0) != (value != 0) {
        EnableWindow(hwnd, value);
    }
}
unsafe fn checked(hwnd: HWND, value: usize) {
    if SendMessageW(hwnd, BM_GETCHECK, 0, 0) as usize != value {
        SendMessageW(hwnd, BM_SETCHECK, value, 0);
    }
}
impl App {
    unsafe fn control(&mut self, id: u16, class: &str, title: &str, style: u32) {
        let h = CreateWindowExW(
            if class == "EDIT" { WS_EX_CLIENTEDGE } else { 0 },
            wide(class).as_ptr(),
            wide(title).as_ptr(),
            WS_CHILD | WS_VISIBLE | style,
            0,
            0,
            1,
            1,
            self.hwnd,
            id as usize as HMENU,
            GetModuleHandleW(null()),
            null(),
        );
        SendMessageW(h, WM_SETFONT, self.font as usize, 1);
        self.controls.insert(id, h);
    }
    fn h(&self, id: u16) -> HWND {
        self.controls[&id]
    }
    unsafe fn error(&mut self, s: &str) {
        if self.destroyed {
            return;
        }
        let changed = read(self.h(9)) != s;
        label(self.h(9), s);
        if changed && !s.is_empty() {
            self.layout();
            let mut bounds = RECT::default();
            let mut client = RECT::default();
            GetWindowRect(self.h(9), &mut bounds);
            GetClientRect(self.hwnd, &mut client);
            let mut origin = POINT { x: 0, y: 0 };
            ClientToScreen(self.hwnd, &mut origin);
            let bottom = bounds.bottom - origin.y;
            let dpi = GetDpiForWindow(self.hwnd);
            if dpi != 0 && bottom > client.bottom - 12 {
                self.scroll += (bottom - client.bottom + 12) * 96 / dpi as i32;
                self.layout();
            }
        }
    }
    unsafe fn reveal(&self) {
        ShowWindow(self.hwnd, SW_RESTORE);
        SetForegroundWindow(self.hwnd);
    }
    unsafe fn create(&mut self) {
        self.control(1, "STATIC", "aBridge", 0);
        SendMessageW(self.h(1), WM_SETFONT, self.title_font as usize, 1);
        self.control(2, "STATIC", "正在启动…", 0);
        SendMessageW(self.h(2), WM_SETFONT, self.status_font as usize, 1);
        self.control(3, "STATIC", "", 0);
        self.control(15, "STATIC", "设备名称", 0);
        self.control(10, "EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL as u32);
        SendMessageW(self.h(10), EM_SETLIMITTEXT, 120, 0);
        for (id, s) in [
            (11, "保存名称"),
            (12, "暂停"),
            (13, "停止当前任务"),
            (14, "重新连接"),
            (20, "连接"),
            (22, "使用 Device Token"),
            (24, "连接并授权"),
            (25, "取消授权"),
            (26, "解绑设备"),
            (30, "本机能力"),
            (40, "偏好设置"),
            (50, "运行诊断"),
        ] {
            self.control(id, "BUTTON", s, WS_TABSTOP | BS_OWNERDRAW as u32);
        }
        self.control(27, "STATIC", "服务端网址", 0);
        self.control(21, "EDIT", "", WS_TABSTOP | ES_AUTOHSCROLL as u32);
        SendMessageW(self.h(21), EM_SETLIMITTEXT, 8192, 0);
        self.control(28, "STATIC", "Device Token", 0);
        self.control(
            23,
            "EDIT",
            "",
            WS_TABSTOP | ES_PASSWORD as u32 | ES_AUTOHSCROLL as u32,
        );
        SendMessageW(self.h(23), EM_SETLIMITTEXT, 4096, 0);

        for (i, s) in ["屏幕观察", "键鼠控制", "终端", "文件"].iter().enumerate() {
            self.control(
                31 + i as u16,
                "BUTTON",
                s,
                WS_TABSTOP | BS_AUTOCHECKBOX as u32,
            );
            SendMessageW(self.h(31 + i as u16), BM_SETCHECK, BST_CHECKED as usize, 0);
        }
        self.control(
            41,
            "COMBOBOX",
            "",
            WS_TABSTOP | CBS_DROPDOWNLIST as u32 | WS_VSCROLL,
        );
        for s in ["跟随系统", "浅色", "深色"] {
            SendMessageW(self.h(41), CB_ADDSTRING, 0, wide(s).as_ptr() as isize);
        }
        SendMessageW(self.h(41), CB_SETCURSEL, self.theme as usize, 0);
        self.control(42, "STATIC", "外观", 0);
        self.control(43, "STATIC", "暂停快捷键  Ctrl + Alt + Shift + P", 0);
        self.control(51, "STATIC", "", 0);
        self.control(9, "STATIC", "", 0);
        self.apply_theme();
        self.refresh();
        self.layout();
        if RegisterHotKey(
            self.hwnd,
            1,
            MOD_CONTROL | MOD_ALT | MOD_SHIFT | MOD_NOREPEAT,
            0x50,
        ) == 0
        {
            self.error("暂停快捷键已被其他程序占用。");
        }
        self.tray = std::mem::zeroed();
        self.tray.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        self.tray.hWnd = self.hwnd;
        self.tray.uID = 1;
        self.tray.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
        self.tray.uCallbackMessage = self.tray_callback;
        self.tray.hIcon = LoadIconW(GetModuleHandleW(null()), std::ptr::without_provenance(1));
        if self.tray.hIcon.is_null() {
            self.tray.hIcon = LoadIconW(null_mut(), IDI_APPLICATION);
        }
        let tip = wide("aBridge · 正在启动");
        self.tray.szTip[..tip.len()].copy_from_slice(&tip);
        Shell_NotifyIconW(NIM_ADD, &self.tray);
        SetTimer(self.hwnd, HOST_TIMER, 100, None);
        self.send("status", json!({}), 0);
    }
    unsafe fn place(&self, id: u16, x: i32, y: i32, w: i32, h: i32, visible: bool) {
        let scale = GetDpiForWindow(self.hwnd) as f64 / 96.;
        let p = |n: i32| (n as f64 * scale).round() as i32;
        ShowWindow(self.h(id), if visible { SW_SHOWNA } else { SW_HIDE });
        MoveWindow(self.h(id), p(x), p(y - self.scroll), p(w), p(h), 1);
    }
    unsafe fn layout(&mut self) {
        if self.destroyed {
            return;
        }
        let mut r = std::mem::zeroed();
        GetClientRect(self.hwnd, &mut r);
        let key = (
            [
                r.right,
                r.bottom,
                GetDpiForWindow(self.hwnd) as i32,
                self.scroll,
            ],
            self.sections,
            self.binding,
        );
        if self.layout_state == Some(key) {
            return;
        }
        self.layout_state = Some(key);
        let scale = GetDpiForWindow(self.hwnd) as f64 / 96.;
        let width = (r.right as f64 / scale) as i32;
        let w = (width - 52).max(300);
        self.place(1, 26, 20, w, 42, true);
        self.place(2, 26, 78, w, 30, true);
        self.place(3, 26, 112, w, 24, true);
        self.place(15, 26, 140, w, 20, true);
        self.place(10, 26, 162, w - 106, 32, true);
        self.place(11, 26 + w - 98, 162, 98, 32, true);
        self.place(12, 26, 206, 72, 34, true);
        self.place(13, 106, 206, 140, 34, true);
        self.place(14, 254, 206, 108, 34, true);
        for (i, id) in [20, 22, 30, 40, 50].iter().enumerate() {
            let title = match id {
                20 => "连接",
                22 => "使用 Device Token",
                30 => "本机能力",
                40 => "偏好设置",
                _ => "运行诊断",
            };
            label(
                self.h(*id),
                &format!("{}  {}", if self.sections[i] { "▾" } else { "▸" }, title),
            );
        }
        let mut y = 262;
        self.place(20, 26, y, w, 30, true);
        y += 38;
        self.place(27, 26, y, w, 22, self.sections[0]);
        self.place(21, 26, y + 25, w, 32, self.sections[0]);
        self.place(22, 26, y + 67, w, 28, self.sections[0]);
        let token = self.sections[0] && self.sections[1];
        self.place(28, 26, y + 102, w, 22, token);
        self.place(23, 26, y + 128, w, 32, token);
        let actions = y + if self.sections[1] { 170 } else { 105 };
        self.place(24, 26, actions, 122, 34, self.sections[0]);
        self.place(25, 156, actions, 108, 34, self.sections[0] && self.binding);
        self.place(
            26,
            if self.binding { 272 } else { 156 },
            actions,
            108,
            34,
            self.sections[0],
        );
        if self.sections[0] {
            y = actions + 50;
        }
        self.place(30, 26, y, w, 30, true);
        y += 38;
        for i in 0..4 {
            self.place(
                31 + i,
                26 + i as i32 * (w / 4),
                y,
                w / 4,
                30,
                self.sections[2],
            );
        }
        if self.sections[2] {
            y += 46;
        }
        self.place(40, 26, y, w, 30, true);
        y += 38;
        self.place(42, 26, y, w, 22, self.sections[3]);
        self.place(41, 26, y + 28, 160, 180, self.sections[3]);
        self.place(43, 26, y + 70, w, 24, self.sections[3]);
        if self.sections[3] {
            y += 110;
        }
        self.place(50, 26, y, w, 30, true);
        y += 38;
        self.place(51, 26, y, w, 140, self.sections[4]);
        if self.sections[4] {
            y += 154;
        }
        self.place(9, 26, y, w, 100, true);
        self.content_height = y + 126;
        let page = (r.bottom as f64 / scale) as u32;
        let clamped = self
            .scroll
            .clamp(0, (self.content_height - page as i32 + 1).max(0));
        if self.scroll != clamped {
            self.scroll = clamped;
            self.layout();
            return;
        }
        let info = SCROLLINFO {
            cbSize: std::mem::size_of::<SCROLLINFO>() as u32,
            fMask: SIF_RANGE | SIF_PAGE | SIF_POS,
            nMin: 0,
            nMax: self.content_height,
            nPage: page,
            nPos: self.scroll,
            nTrackPos: 0,
        };
        SetScrollInfo(self.hwnd, SB_VERT, &info, 1);
        InvalidateRect(self.hwnd, null(), 1);
    }
    unsafe fn fonts(&mut self) {
        let dpi = GetDpiForWindow(self.hwnd) as i32;
        let make = |size: i32, weight: i32| {
            CreateFontW(
                -size * dpi / 96,
                0,
                0,
                0,
                weight,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                0,
                0,
                CLEARTYPE_QUALITY as u32,
                0,
                wide("Microsoft YaHei UI").as_ptr(),
            )
        };
        let old = [self.font, self.title_font, self.status_font];
        self.font = make(14, 400);
        self.title_font = make(30, 700);
        self.status_font = make(22, 600);
        for (&id, &h) in &self.controls {
            SendMessageW(
                h,
                WM_SETFONT,
                match id {
                    1 => self.title_font,
                    2 => self.status_font,
                    _ => self.font,
                } as usize,
                1,
            );
        }
        for font in old {
            DeleteObject(font);
        }
    }
    unsafe fn apply_theme(&mut self) {
        let mut light = 1u32;
        let mut size = 4;
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize").as_ptr(),
            wide("AppsUseLightTheme").as_ptr(),
            RRF_RT_REG_DWORD,
            null_mut(),
            (&mut light as *mut u32).cast(),
            &mut size,
        );
        self.dark = self.theme == 2 || (self.theme == 0 && light == 0);
        let dark = self.dark as i32;
        let _ = DwmSetWindowAttribute(
            self.hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            (&dark as *const i32).cast(),
            4,
        );
        if !self.background.is_null() {
            DeleteObject(self.background);
        }
        if !self.input.is_null() {
            DeleteObject(self.input);
        }
        self.background = CreateSolidBrush(if self.dark { 0x00202020 } else { 0x00fafafa });
        self.input = CreateSolidBrush(if self.dark { 0x002d2d2d } else { 0x00ffffff });
        // The light visual-style checkbox ignores WM_CTLCOLOR text colors. Keep
        // the native checkbox semantics, but use its classic painter in dark mode.
        let empty = wide("");
        let theme = if self.dark { empty.as_ptr() } else { null() };
        for id in 31..=34 {
            SetWindowTheme(self.h(id), theme, theme);
        }
        RedrawWindow(
            self.hwnd,
            null(),
            null_mut(),
            RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_ERASE,
        );
    }
    unsafe fn refresh(&self) {
        for id in [21, 23, 24] {
            enabled(self.h(id), (!self.bound && !self.binding) as i32);
        }
        enabled(self.h(26), (self.bound && !self.binding) as i32);
        for i in 0..4 {
            enabled(
                self.h(31 + i),
                (!self.binding && !self.host.pending.values().any(|p| p.control == 31 + i)) as i32,
            );
        }
    }
    unsafe fn send(&mut self, action: &str, args: Value, control: u16) {
        self.error("");
        match self.host.send(action, args, control) {
            Ok(()) => {
                if control != 0 {
                    enabled(self.h(control), 0);
                }
            }
            Err(_) => {
                self.error("本机连接已关闭。");
                if action == "bind" {
                    self.binding = false;
                    self.refresh();
                }
                if action == "quit" {
                    if !self.host.running() {
                        DestroyWindow(self.hwnd);
                    } else {
                        self.quitting = false;
                        self.error("退出尚未完成，客户端仍在运行。请等待当前操作清理后重试。");
                        self.reveal();
                    }
                }
            }
        }
    }
    unsafe fn render(&mut self) {
        let s: String = if !self.healthy {
            "状态暂不可用".into()
        } else if self.status["view"].is_object() {
            self.status["view"]["label"]
                .as_str()
                .unwrap_or("未连接")
                .into()
        } else {
            "正在启动…".into()
        };
        label(self.h(2), &s);
        let mut tooltip = [0; 128];
        let tip = wide(&format!("aBridge · {s}"));
        let n = tip.len().min(127);
        tooltip[..n].copy_from_slice(&tip[..n]);
        if self.tray.szTip != tooltip {
            self.tray.szTip = tooltip;
            Shell_NotifyIconW(NIM_MODIFY, &self.tray);
        }
        let online = self.healthy && !self.paused && text(&self.status, "connection") == "online";
        if online != self.online_color {
            self.online_color = online;
            InvalidateRect(self.h(2), null(), 1);
        }
    }
    unsafe fn apply_status(&mut self, v: Value) {
        self.status = v;
        let bound = flag(&self.status, "bound");
        if !self.has_status || bound != self.bound {
            self.sections[0] = !bound;
        }
        self.has_status = true;
        self.bound = bound;
        self.paused = flag(&self.status, "paused");
        if GetFocus() != self.h(10) {
            label(self.h(10), &text(&self.status, "device_name"));
        }
        if self.bound && GetFocus() != self.h(21) {
            label(self.h(21), &text(&self.status, "url"));
        }
        label(
            self.h(3),
            &if self.bound {
                [
                    text(&self.status, "owner_name"),
                    text(&self.status, "device_id"),
                ]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" · ")
            } else {
                "连接服务端，授权此电脑".into()
            },
        );
        label(self.h(12), if self.paused { "恢复" } else { "暂停" });
        if self.bound {
            let caps = if self.status["requested_capabilities"].is_object() {
                &self.status["requested_capabilities"]
            } else {
                &self.status["capabilities"]
            };
            for (i, key) in CAPS.iter().enumerate() {
                checked(
                    self.h(31 + i as u16),
                    if flag(caps, key) {
                        BST_CHECKED as usize
                    } else {
                        0
                    },
                );
            }
        }
        let error = self.status["local_error"]
            .as_str()
            .or(self.status["error"].as_str())
            .unwrap_or("")
            .to_string();
        label(
            self.h(51),
            &format!(
                "版本  {}\r\n内核  {}\r\n桌面驱动  {}\r\n连接  {}\r\n设备  {}\r\n{}",
                text(&self.status, "version"),
                "Rust 原生",
                if flag(&self.status["driver"], "ready") {
                    "已就绪"
                } else {
                    "按需启动"
                },
                text(&self.status, "connection"),
                text(&self.status, "device_id"),
                error
            ),
        );
        if !error.is_empty() || read(self.h(9)) == self.status_error {
            self.error(&error);
        }
        self.status_error = error;
        if self.paused || text(&self.status, "connection") != "online" {
            self.active = false;
            self.frames.show(false);
        }
        self.refresh();
        self.render();
        self.layout();
    }
    unsafe fn lose(&mut self, s: &str) {
        self.healthy = false;
        self.active = false;
        self.frames.show(false);
        self.render();
        self.transport_error = s.into();
        self.error(s);
    }
    unsafe fn finish(&mut self, p: Pending, v: Option<Value>) {
        if p.control != 0 {
            enabled(self.h(p.control), 1);
        }
        let ok = v.as_ref().is_some_and(|v| flag(v, "ok"));
        if p.action == "quit" {
            if ok || !self.host.running() {
                if ok {
                    self.host.graceful();
                }
                DestroyWindow(self.hwnd);
            } else {
                self.quitting = false;
                self.error("退出尚未完成，客户端仍在运行。请等待当前操作清理后重试。");
                self.reveal();
            }
            return;
        }
        if p.action == "bind" {
            label(self.h(23), "");
            self.binding = false;
            self.refresh();
            self.layout();
        }
        if !ok {
            self.error(
                &v.as_ref()
                    .map(|v| v["error"].as_str().unwrap_or("本机操作失败。").to_string())
                    .unwrap_or("操作确认超时，请检查当前状态后再试。".into()),
            );
            if p.action == "capability" {
                let _ = self.host.send("status", json!({}), 0);
            }
            return;
        }
        let v = v.unwrap();
        if v["status"].is_object() {
            self.apply_status(v["status"].clone());
        } else if v["view"].is_object() {
            self.apply_status(v);
        } else if p.action != "status" {
            self.send("status", json!({}), 0);
        }
    }
    unsafe fn tick(&mut self) {
        if self.destroyed {
            return;
        }
        if WaitForSingleObject(self.activation, 0) == WAIT_OBJECT_0 {
            self.reveal();
        }
        while let Ok(msg) = self.host.messages.try_recv() {
            match msg {
                Message::Closed => {
                    let pending = std::mem::take(&mut self.host.pending);
                    for (_, p) in pending {
                        self.finish(p, Some(json!({"ok":false,"error":"本机连接已关闭。"})));
                        if self.destroyed {
                            return;
                        }
                    }
                    self.lose("本机内核已退出，请退出后重新打开 aBridge。");
                }
                Message::Data(v) => {
                    if let Some(id) = v["id"].as_u64() {
                        if let Some(p) = self.host.pending.remove(&id) {
                            self.finish(p, Some(v));
                        }
                    } else {
                        match v["event"].as_str().unwrap_or("") {
                            "status" => self.apply_status(v["status"].clone()),
                            "activity" => {
                                let recovered = !self.healthy;
                                self.heartbeat = Instant::now();
                                self.healthy = true;
                                if recovered && read(self.h(9)) == self.transport_error {
                                    self.error("");
                                }
                                self.transport_error.clear();
                                let active = flag(&v, "active")
                                    && !self.paused
                                    && text(&self.status, "connection") == "online";
                                if active != self.active {
                                    self.active = active;
                                    self.frames.show(active);
                                }
                                if recovered {
                                    self.render();
                                }
                            }
                            "authorization" => {
                                if let Ok(url) = url::Url::parse(&text(&v, "url")) {
                                    if matches!(url.scheme(), "http" | "https") {
                                        let result = ShellExecuteW(
                                            self.hwnd,
                                            wide("open").as_ptr(),
                                            wide(url.as_str()).as_ptr(),
                                            null(),
                                            null(),
                                            SW_SHOWNORMAL,
                                        );
                                        if result as isize <= 32 {
                                            self.error(
                                                "无法打开默认浏览器，请检查系统浏览器设置。",
                                            );
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            // A quit response synchronously destroys the window. Do not process
            // the queued pipe closure or any later status using its dead HWND.
            if self.destroyed {
                return;
            }
        }
        for p in self.host.expired() {
            self.finish(p, None);
            if self.destroyed {
                return;
            }
        }
        if self.healthy && self.heartbeat.elapsed() > Duration::from_secs(2) {
            self.lose("本机状态暂时不可用。");
        }
    }
    unsafe fn command(&mut self, id: u16, notification: u16) {
        match id {
            11 => self.send("rename", json!({"name":read(self.h(10)).trim()}), 11),
            12 => {
                if !self.paused {
                    self.frames.show(false);
                }
                self.send(if self.paused { "resume" } else { "pause" }, json!({}), 12);
            }
            13 => {
                self.frames.show(false);
                self.send("stop", json!({}), 13);
            }
            14 => self.send("connect", json!({}), 14),
            20 | 22 | 30 | 40 | 50 => {
                let index = match id {
                    20 => 0,
                    22 => 1,
                    30 => 2,
                    40 => 3,
                    _ => 4,
                };
                self.sections[index] = !self.sections[index];
                self.layout();
            }
            24 => {
                if self.binding || self.bound {
                    return;
                }
                let parsed = url::Url::parse(read(self.h(21)).trim());
                let Ok(url) = parsed else {
                    self.error("请输入有效的 http 或 https 服务端网址。");
                    return;
                };
                if !matches!(url.scheme(), "http" | "https")
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    self.error("请输入有效的 http 或 https 服务端网址。");
                    return;
                }
                let mut args = json!({"url":url.as_str(),"capabilities":{}});
                for (i, key) in CAPS.iter().enumerate() {
                    args["capabilities"][key] = json!(
                        SendMessageW(self.h(31 + i as u16), BM_GETCHECK, 0, 0)
                            == BST_CHECKED as isize
                    );
                }
                if url.scheme() == "http" {
                    let origin = url.origin().ascii_serialization();
                    if MessageBoxW(self.hwnd,wide(&format!("此连接未使用 HTTPS 加密：\n{origin}\n\n仅在你信任的网络中继续。是否允许连接？")).as_ptr(),wide("确认 HTTP 连接").as_ptr(),MB_YESNO|MB_ICONWARNING)!=IDYES{return;}
                    args["http_confirmed_origin"] = json!(origin);
                }
                let token = read(self.h(23));
                if !token.trim().is_empty() {
                    args["device_key"] = json!(token.trim());
                }
                self.binding = true;
                self.refresh();
                self.layout();
                self.send("bind", args, 24);
            }
            25 => self.send("cancel", json!({}), 25),
            26 => {
                if MessageBoxW(
                    self.hwnd,
                    wide("解绑将停止本机任务，并清除本机设备凭据。是否继续？").as_ptr(),
                    wide("解绑设备").as_ptr(),
                    MB_YESNO | MB_ICONQUESTION,
                ) == IDYES
                {
                    self.frames.show(false);
                    self.send("unbind", json!({}), 26);
                }
            }
            31..=34 => {
                if self.bound && !self.binding {
                    let enabled =
                        SendMessageW(self.h(id), BM_GETCHECK, 0, 0) == BST_CHECKED as isize;
                    if id == 32 && !enabled {
                        self.frames.show(false);
                    }
                    self.send(
                        "capability",
                        json!({"capability":CAPS[(id-31) as usize],"enabled":enabled}),
                        id,
                    );
                }
            }
            41 if notification == CBN_SELCHANGE as u16 => {
                self.theme = SendMessageW(self.h(41), CB_GETCURSEL, 0, 0) as i32;
                self.apply_theme();
                let result = (|| -> std::io::Result<()> {
                    std::fs::create_dir_all(self.preferences.parent().unwrap())?;
                    let tmp = self.preferences.with_extension("json.tmp");
                    std::fs::write(&tmp, json!({"theme":self.theme}).to_string())?;
                    if windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                        wide(&tmp.to_string_lossy()).as_ptr(),
                        wide(&self.preferences.to_string_lossy()).as_ptr(),
                        windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING,
                    ) == 0
                    {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                })();
                if result.is_err() {
                    self.error("外观设置未能保存。");
                }
            }
            60 => self.reveal(),
            61 if !self.quitting => {
                self.quitting = true;
                self.frames.show(false);
                if self.host.running() {
                    self.send("quit", json!({}), 0);
                } else {
                    DestroyWindow(self.hwnd);
                }
            }
            _ => {}
        }
    }
    unsafe fn menu(&mut self) {
        let menu = CreatePopupMenu();
        for (id, s) in [
            (60, "打开 aBridge"),
            (12, if self.paused { "恢复" } else { "暂停" }),
            (13, "停止当前任务"),
        ] {
            AppendMenuW(menu, MF_STRING, id, wide(s).as_ptr());
        }
        AppendMenuW(menu, MF_SEPARATOR, 0, null());
        AppendMenuW(menu, MF_STRING, 61, wide("退出").as_ptr());
        let mut p = std::mem::zeroed();
        GetCursorPos(&mut p);
        SetForegroundWindow(self.hwnd);
        let id = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_RIGHTBUTTON,
            p.x,
            p.y,
            0,
            self.hwnd,
            null(),
        );
        DestroyMenu(menu);
        if id != 0 {
            self.command(id as u16, 0);
        }
        PostMessageW(self.hwnd, WM_NULL, 0, 0);
    }
}
unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut App;
    if ptr.is_null() {
        return DefWindowProcW(hwnd, msg, w, l);
    }
    let app = &mut *ptr;
    if msg == app.taskbar_created {
        Shell_NotifyIconW(NIM_ADD, &app.tray);
        return 0;
    }
    match msg {
        WM_CLOSE => {
            ShowWindow(hwnd, SW_HIDE);
            return 0;
        }
        WM_DESTROY => {
            app.destroyed = true;
            KillTimer(hwnd, HOST_TIMER);
            UnregisterHotKey(hwnd, 1);
            app.frames.show(false);
            Shell_NotifyIconW(NIM_DELETE, &app.tray);
            PostQuitMessage(0);
            return 0;
        }
        WM_TIMER if w == HOST_TIMER => {
            app.tick();
            return 0;
        }
        WM_COMMAND => {
            app.command((w & 65535) as u16, (w >> 16) as u16);
            return 0;
        }
        WM_HOTKEY if w == 1 => {
            app.frames.show(false);
            app.send("pause", json!({}), 0);
            return 0;
        }
        message if message == app.tray_callback => {
            match l as u32 {
                WM_LBUTTONDBLCLK => app.reveal(),
                WM_RBUTTONUP | WM_CONTEXTMENU => app.menu(),
                _ => {}
            }
            return 0;
        }
        WM_SIZE => {
            app.layout();
            return 0;
        }
        WM_DISPLAYCHANGE => {
            if app.active && app.healthy {
                app.frames.show(true);
            }
        }
        WM_SETTINGCHANGE => app.apply_theme(),
        WM_DPICHANGED => {
            let r = *(l as *const RECT);
            SetWindowPos(
                hwnd,
                null_mut(),
                r.left,
                r.top,
                r.right - r.left,
                r.bottom - r.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            app.fonts();
            app.layout();
        }
        WM_GETMINMAXINFO => {
            let info = &mut *(l as *mut MINMAXINFO);
            let dpi = GetDpiForWindow(hwnd) as i32;
            info.ptMinTrackSize = POINT {
                x: 440 * dpi / 96,
                y: 440 * dpi / 96,
            };
            return 0;
        }
        WM_VSCROLL | WM_MOUSEWHEEL => {
            let mut info: SCROLLINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<SCROLLINFO>() as u32;
            info.fMask = SIF_ALL;
            GetScrollInfo(hwnd, SB_VERT, &mut info);
            let next = if msg == WM_MOUSEWHEEL {
                app.scroll - ((w >> 16) as i16 as i32) / 120 * 45
            } else {
                match (w & 65535) as i32 {
                    SB_LINEUP => app.scroll - 24,
                    SB_LINEDOWN => app.scroll + 24,
                    SB_PAGEUP => app.scroll - info.nPage as i32,
                    SB_PAGEDOWN => app.scroll + info.nPage as i32,
                    SB_THUMBTRACK => info.nTrackPos,
                    _ => app.scroll,
                }
            };
            app.scroll = next.clamp(0, (info.nMax - info.nPage as i32 + 1).max(0));
            app.layout();
            return 0;
        }
        WM_DRAWITEM => {
            let item = &*(l as *const DRAWITEMSTRUCT);
            let dc = item.hDC;
            let mut r = item.rcItem;
            let section = matches!(item.CtlID, 20 | 22 | 30 | 40 | 50);
            let disabled = item.itemState & ODS_DISABLED != 0;
            let primary = item.CtlID == 24 && !disabled;
            let pressed = item.itemState & ODS_SELECTED != 0;
            FillRect(dc, &r, app.background);
            let fill = if primary {
                if pressed {
                    0x00c25800
                } else {
                    0x00dd6600
                }
            } else if app.dark {
                if pressed {
                    0x003b3b3b
                } else {
                    0x002d2d2d
                }
            } else if pressed {
                0x00ededed
            } else {
                0x00ffffff
            };
            let brush = CreateSolidBrush(fill);
            let pen = CreatePen(
                PS_SOLID,
                1,
                if primary {
                    fill
                } else if app.dark {
                    0x00454545
                } else {
                    0x00e5e5e5
                },
            );
            let previous_brush = SelectObject(dc, brush);
            let previous_pen = SelectObject(dc, pen);
            let radius = (6 * GetDpiForWindow(hwnd) / 96) as i32;
            RoundRect(dc, r.left, r.top, r.right, r.bottom, radius * 2, radius * 2);
            SelectObject(dc, previous_brush);
            SelectObject(dc, previous_pen);
            DeleteObject(brush);
            DeleteObject(pen);
            SetBkMode(dc, TRANSPARENT as i32);
            SetTextColor(
                dc,
                if disabled {
                    0x00888888
                } else if primary {
                    0x00ffffff
                } else if app.dark {
                    0x00f3f3f3
                } else {
                    0x00171717
                },
            );
            let previous_font = SelectObject(dc, app.font);
            let s = wide(&read(item.hwndItem));
            if section {
                r.left += radius * 2;
            }
            DrawTextW(
                dc,
                s.as_ptr(),
                -1,
                &mut r,
                (if section { DT_LEFT } else { DT_CENTER }) | DT_VCENTER | DT_SINGLELINE,
            );
            SelectObject(dc, previous_font);
            if item.itemState & ODS_FOCUS != 0 {
                InflateRect(&mut r, -3, -3);
                DrawFocusRect(dc, &r);
            }
            return 1;
        }
        WM_ERASEBKGND => {
            let mut r = std::mem::zeroed();
            GetClientRect(hwnd, &mut r);
            FillRect(w as HDC, &r, app.background);
            return 1;
        }
        WM_CTLCOLORSTATIC | WM_CTLCOLOREDIT | WM_CTLCOLORLISTBOX | WM_CTLCOLORBTN => {
            let dc = w as HDC;
            let input = msg == WM_CTLCOLOREDIT || msg == WM_CTLCOLORLISTBOX;
            let color = if l as HWND == app.h(9) {
                0x005c5ccd
            } else if l as HWND == app.h(1)
                || (l as HWND == app.h(2)
                    && app.healthy
                    && !app.paused
                    && text(&app.status, "connection") == "online")
            {
                0x00dd6600
            } else if app.dark {
                0x00f3f3f3
            } else {
                0x00171717
            };
            SetTextColor(dc, color);
            SetBkColor(
                dc,
                if input {
                    if app.dark {
                        0x002d2d2d
                    } else {
                        0xffffff
                    }
                } else if app.dark {
                    0x00202020
                } else {
                    0x00fafafa
                },
            );
            return if input { app.input } else { app.background } as isize;
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, w, l)
}
pub unsafe fn run(
    base: PathBuf,
    state: PathBuf,
    activation: HANDLE,
) -> Result<(), Box<dyn std::error::Error>> {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    let instance = GetModuleHandleW(null());
    let class = wide("aBridge.Native.Win32");
    let icon = LoadIconW(instance, std::ptr::without_provenance(1));
    let wc = WNDCLASSW {
        lpfnWndProc: Some(proc),
        hInstance: instance,
        lpszClassName: class.as_ptr(),
        hCursor: LoadCursorW(null_mut(), IDC_ARROW),
        hIcon: icon,
        ..std::mem::zeroed()
    };
    RegisterClassW(&wc);
    let dpi = GetDpiForSystem() as i32;
    let font = CreateFontW(
        -14 * dpi / 96,
        0,
        0,
        0,
        400,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        0,
        0,
        CLEARTYPE_QUALITY as u32,
        0,
        wide("Microsoft YaHei UI").as_ptr(),
    );
    let title_font = CreateFontW(
        -30 * dpi / 96,
        0,
        0,
        0,
        700,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        0,
        0,
        CLEARTYPE_QUALITY as u32,
        0,
        wide("Microsoft YaHei UI").as_ptr(),
    );
    let status_font = CreateFontW(
        -22 * dpi / 96,
        0,
        0,
        0,
        600,
        0,
        0,
        0,
        DEFAULT_CHARSET as u32,
        0,
        0,
        CLEARTYPE_QUALITY as u32,
        0,
        wide("Microsoft YaHei UI").as_ptr(),
    );
    let preferences = state.join("windows-ui/native-preferences.json");
    let theme = std::fs::read(&preferences)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["theme"].as_i64())
        .unwrap_or(0)
        .clamp(0, 2) as i32;
    let mut app = Box::new(App {
        hwnd: null_mut(),
        destroyed: false,
        controls: HashMap::new(),
        host: Host::start(&base, &state)?,
        frames: Frames::default(),
        activation,
        preferences,
        status: Value::Null,
        healthy: false,
        active: false,
        bound: false,
        paused: false,
        binding: false,
        quitting: false,
        has_status: false,
        heartbeat: Instant::now(),
        sections: [true, false, true, false, false],
        theme,
        dark: false,
        background: null_mut(),
        input: null_mut(),
        font,
        title_font,
        status_font,
        scroll: 0,
        content_height: 0,
        status_error: String::new(),
        transport_error: String::new(),
        tray: std::mem::zeroed(),
        taskbar_created: RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
        tray_callback: RegisterWindowMessageW(wide("aBridge.Native.Tray.Callback").as_ptr()),
        layout_state: None,
        online_color: false,
    });
    let width = 540 * dpi / 96;
    let height = 640 * dpi / 96;
    let hwnd = CreateWindowExW(
        WS_EX_CONTROLPARENT,
        class.as_ptr(),
        wide("aBridge").as_ptr(),
        WS_OVERLAPPEDWINDOW | WS_VSCROLL | WS_CLIPCHILDREN,
        (GetSystemMetrics(SM_CXSCREEN) - width) / 2,
        (GetSystemMetrics(SM_CYSCREEN) - height) / 2,
        width,
        height,
        null_mut(),
        null_mut(),
        instance,
        null(),
    );
    if hwnd.is_null() {
        return Err("window creation".into());
    }
    app.hwnd = hwnd;
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut *app as *mut App as isize);
    app.create();
    ShowWindow(hwnd, SW_SHOW);
    let mut msg = std::mem::zeroed();
    while GetMessageW(&mut msg, null_mut(), 0, 0) > 0 {
        if IsDialogMessageW(hwnd, &msg) == 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        } else if msg.message == WM_KEYDOWN && msg.wParam == VK_TAB as usize {
            let focus = GetFocus();
            if IsChild(hwnd, focus) != 0 {
                let mut bounds = RECT::default();
                let mut client = RECT::default();
                GetWindowRect(focus, &mut bounds);
                GetClientRect(hwnd, &mut client);
                let mut origin = POINT { x: 0, y: 0 };
                ClientToScreen(hwnd, &mut origin);
                let top = bounds.top - origin.y;
                let bottom = bounds.bottom - origin.y;
                let delta = if top < 12 {
                    top - 12
                } else if bottom > client.bottom - 12 {
                    bottom - client.bottom + 12
                } else {
                    0
                };
                if delta != 0 {
                    app.scroll += delta * 96 / GetDpiForWindow(hwnd) as i32;
                    app.layout();
                }
            }
        }
    }
    SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
    DeleteObject(app.font);
    DeleteObject(app.title_font);
    DeleteObject(app.status_font);
    DeleteObject(app.background);
    DeleteObject(app.input);
    Ok(())
}
