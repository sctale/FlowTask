// FlowTask 桌面版壳（Tauri v2）
// -----------------------------------------------------------------------------
// 职责刻意做小：不重写任何业务——服务端就是仓库里那份 flowtask_server.js，
// 由构建脚本打成 Node SEA sidecar（binaries/flowtask-server-<triple>.exe）。
// 本壳只做四件事：
//   1) 端口 5178 上若已有 FlowTask 服务（比如 vbs 启动的），直接复用、不重复起；
//   2) 否则拉起 sidecar（数据目录=主 exe 所在目录，保持「拷走文件夹即搬家」）；
//   3) WebView 窗口指向 http://127.0.0.1:5178；
//   4) 托盘常驻：关窗=隐藏（服务继续跑，同事还能访问），退出=顺手收掉自己起的 sidecar。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

const APP_URL: &str = "http://127.0.0.1:5178";

/// 探一下 5178 是不是已经在跑 FlowTask（与 vbs 启动器同一判据：/api/ping 里认 "app":"FlowTask"）
fn flowtask_up() -> bool {
    let mut s = match TcpStream::connect_timeout(
        &"127.0.0.1:5178".parse().unwrap(),
        Duration::from_millis(400),
    ) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = s.set_read_timeout(Some(Duration::from_millis(800)));
    if s.write_all(b"GET /api/ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_err() {
        return false;
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        match s.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if buf.len() > 4096 {
            break;
        }
    }
    String::from_utf8_lossy(&buf).contains("\"app\":\"FlowTask\"")
}

struct ServerState {
    child: Mutex<Option<CommandChild>>, // 只有本壳亲手起的才有值
    owned: bool,                        // 复用外部服务时=false，退出不杀
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn kill_sidecar(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerState>() {
        if let Some(child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .setup(|app| {
            let handle = app.handle().clone();

            // 便携哲学延续：数据就放主 exe 同目录（安装模式下即 $INSTDIR，用户级可写）
            let exe_dir: PathBuf = std::env::current_exe()?
                .parent()
                .ok_or_else(|| std::io::Error::other("no exe dir"))?
                .to_path_buf();
            let html = app
                .path()
                .resolve("app.html", tauri::path::BaseDirectory::Resource)
                .map_err(|e| format!("解析 app.html 资源失败: {e}"))?;

            let owned = !flowtask_up();
            let mut child_opt: Option<CommandChild> = None;
            if owned {
                let sidecar = handle
                    .shell()
                    .sidecar("flowtask-server")
                    .map_err(|e| format!("定位 sidecar 失败: {e}"))?;
                let (_rx, child) = sidecar
                    .envs(vec![
                        ("FLOWTASK_DATA_DIR", exe_dir.to_string_lossy().to_string()),
                        ("FLOWTASK_HTML", html.to_string_lossy().to_string()),
                    ])
                    .spawn()
                    .map_err(|e| format!("启动 sidecar 失败: {e}"))?;
                child_opt = Some(child);
                // 等就绪（最长 10s）：SEA 冷启动比 node 略快，留足磁盘慢的余量
                for _ in 0..50 {
                    if flowtask_up() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            } else {
                // 复用外部服务：不打日志（GUI 子系统没有控制台），行为本身已说明一切
            }

            app.manage(ServerState {
                child: Mutex::new(child_opt),
                owned,
            });

            WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(APP_URL.parse()?))
                .title("FlowTask")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 560.0)
                .center()
                .build()?;

            let show = MenuItem::with_id(&handle, "show", "显示主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(&handle, "quit", "退出 FlowTask", true, None::<&str>)?;
            let menu = Menu::with_items(&handle, &[&show, &quit])?;
            TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("FlowTask · 本地项目管理")
                .icon(handle.default_window_icon().unwrap().clone())
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => {
                        kill_sidecar(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(&handle)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关窗=隐藏到托盘：服务继续跑，局域网同事不受影响
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("FlowTask 桌面版启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                kill_sidecar(app);
            }
        });
}
