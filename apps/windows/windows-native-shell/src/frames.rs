use crate::wide;
use std::ptr::{null, null_mut};
use windows_sys::core::BOOL;
use windows_sys::Win32::{
    Foundation::*, Graphics::Gdi::*, System::LibraryLoader::*, UI::WindowsAndMessaging::*,
};
#[derive(Default)]
pub struct Frames {
    windows: Vec<HWND>,
    layout: Vec<(i32, i32, i32, i32)>,
}
unsafe extern "system" fn monitor(_: HMONITOR, _: HDC, rect: *mut RECT, data: LPARAM) -> BOOL {
    let r = *rect;
    (*(data as *mut Vec<(i32, i32, i32, i32)>)).push((r.left, r.top, r.right, r.bottom));
    1
}
unsafe extern "system" fn proc(hwnd: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    match msg {
        WM_NCHITTEST => return HTTRANSPARENT as isize,
        WM_MOUSEACTIVATE => return MA_NOACTIVATE as isize,
        WM_TIMER => {
            let offset = (GetWindowLongPtrW(hwnd, GWLP_USERDATA) + 2) % 135;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, offset);
            InvalidateRect(hwnd, null(), 0);
            return 0;
        }
        WM_PAINT => {
            let mut ps = std::mem::zeroed();
            let dc = BeginPaint(hwnd, &mut ps);
            let mut r = std::mem::zeroed();
            GetClientRect(hwnd, &mut r);
            let base = CreateSolidBrush(0x00dd6600);
            FillRect(dc, &r, base);
            DeleteObject(base);
            let mut animate = 0i32;
            SystemParametersInfoW(
                SPI_GETCLIENTAREAANIMATION,
                0,
                (&mut animate as *mut i32).cast(),
                0,
            );
            if animate != 0 {
                let brush = CreateSolidBrush(0x00ffe0b8);
                let horizontal = r.right > r.bottom;
                let extent = if horizontal { r.right } else { r.bottom };
                let mut p = -(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as i32);
                while p < extent {
                    let dash = if horizontal {
                        RECT {
                            left: p,
                            top: 0,
                            right: p + 90,
                            bottom: r.bottom,
                        }
                    } else {
                        RECT {
                            left: 0,
                            top: p,
                            right: r.right,
                            bottom: p + 90,
                        }
                    };
                    FillRect(dc, &dash, brush);
                    p += 135;
                }
                DeleteObject(brush);
            } else {
                KillTimer(hwnd, 1);
            }
            EndPaint(hwnd, &ps);
            return 0;
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, w, l)
}
impl Frames {
    pub unsafe fn show(&mut self, active: bool) {
        let mut layout = Vec::<(i32, i32, i32, i32)>::new();
        if active {
            EnumDisplayMonitors(
                null_mut(),
                null(),
                Some(monitor),
                &mut layout as *mut _ as isize,
            );
        }
        if layout == self.layout {
            return;
        }
        for hwnd in self.windows.drain(..) {
            DestroyWindow(hwnd);
        }
        self.layout = layout;
        let instance = GetModuleHandleW(null());
        let class = wide("aBridge.ActivityFrame");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&wc);
        for &(left, top, right, bottom) in &self.layout {
            for (x, y, w, h) in [
                (left, top, right - left, 3),
                (left, bottom - 3, right - left, 3),
                (left, top + 3, 3, (bottom - top - 6).max(1)),
                (right - 3, top + 3, 3, (bottom - top - 6).max(1)),
            ] {
                let hwnd = CreateWindowExW(
                    WS_EX_LAYERED
                        | WS_EX_TRANSPARENT
                        | WS_EX_TOOLWINDOW
                        | WS_EX_NOACTIVATE
                        | WS_EX_TOPMOST,
                    class.as_ptr(),
                    wide("aBridge · 正在操作桌面").as_ptr(),
                    WS_POPUP,
                    x,
                    y,
                    w,
                    h,
                    null_mut(),
                    null_mut(),
                    instance,
                    null(),
                );
                if !hwnd.is_null() {
                    SetLayeredWindowAttributes(hwnd, 0, 180, LWA_ALPHA);
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        x,
                        y,
                        w,
                        h,
                        SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                    SetTimer(hwnd, 1, 66, None);
                    self.windows.push(hwnd);
                }
            }
        }
    }
}
impl Drop for Frames {
    fn drop(&mut self) {
        unsafe {
            self.show(false);
        }
    }
}
