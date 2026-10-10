// Marcio App — lib.rs
//
// Tauri 2 backend. Faz:
//   1. Single instance — não deixa abrir 2 apps
//   2. Em DEV: o bot é iniciado pelo beforeDevCommand (npm run dev)
//   3. Em PRODUÇÃO: copia resources (dist/ + data/) pra AppData,
//      roda npm install --production, e spawna `node dist/bot.js`
//   4. Abre janela nativa apontando pro painel web (http://localhost:3001)
//   5. Cria tray icon: Mostrar / Reiniciar bot / Sair
//   6. Notificações nativas do Windows

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::path::PathBuf;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

struct BotProcess(Mutex<Option<Child>>);

fn is_port_open(host: &str, port: u16) -> bool {
    std::net::TcpStream::connect((host, port)).is_ok()
}

/// Resolve o AppData dir: %APPDATA%\MarcioApp no Windows.
fn get_app_data_dir() -> Option<PathBuf> {
    std::env::var("APPDATA")
        .ok()
        .map(|appdata| {
            let mut p = PathBuf::from(appdata);
            p.push("MarcioApp");
            p
        })
}

/// Copia um diretório recursivamente, mas SÓ arquivos que não existem no destino.
/// Não sobrescreve dados do usuário (memories.json, etc.).
fn copy_dir_if_not_exists(src: &std::path::Path, dst: &std::path::Path) {
    if !src.exists() { return; }
    let _ = std::fs::create_dir_all(dst);
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.flatten() {
            let path = entry.path();
            let dst_path = dst.join(entry.file_name());
            if path.is_dir() {
                copy_dir_if_not_exists(&path, &dst_path);
            } else {
                if !dst_path.exists() {
                    let _ = std::fs::copy(&path, &dst_path);
                }
            }
        }
    }
}

/// Copia um arquivo se não existe no destino.
fn copy_file_if_not_exists(src: &str, dst: &std::path::Path) {
    let src_path = std::path::Path::new(src);
    if src_path.exists() {
        let dst_path = dst.join(src_path.file_name().unwrap_or_default());
        if !dst_path.exists() {
            let _ = std::fs::copy(src_path, &dst_path);
        }
    }
}

/// Configura o ambiente de produção em AppData:
/// 1. Copia dist/ + data/ + package.json + patch-whatsapp-web.js dos resources
/// 2. Roda `npm install --production` se node_modules/ não existe
/// 3. Roda `node patch-whatsapp-web.js`
/// Retorna o PathBuf do AppData dir (onde o bot deve rodar).
fn setup_production_env(resource_dir: &PathBuf, app_data_dir: &PathBuf) {
    println!("[TAURI] Configurando ambiente de produção em: {}", app_data_dir.display());
    let _ = std::fs::create_dir_all(app_data_dir);

    // 1. Copia dist/ (código compilado) — sempre sobrescreve (código novo a cada versão)
    let src_dist = resource_dir.join("dist");
    let dst_dist = app_data_dir.join("dist");
    if src_dist.exists() {
        let _ = std::fs::remove_dir_all(&dst_dist);
        let _ = std::fs::create_dir_all(&dst_dist);
        copy_dir_recursive(&src_dist, &dst_dist);
        println!("[TAURI] ✅ dist/ copiado");
    }

    // 2. Copia data/ (configs padrão) — SÓ se não existe (não sobrescreve dados do usuário)
    let src_data = resource_dir.join("data");
    let dst_data = app_data_dir.join("data");
    if src_data.exists() {
        copy_dir_if_not_exists(&src_data, &dst_data);
        println!("[TAURI] ✅ data/ verificado/copiado");
    }

    // 3. Copia package.json + patch-whatsapp-web.js (sempre sobrescreve)
    copy_file_if_not_exists("package.json", app_data_dir);
    let src_pkg = resource_dir.join("package.json");
    if src_pkg.exists() {
        let _ = std::fs::copy(&src_pkg, app_data_dir.join("package.json"));
    }
    let src_patch = resource_dir.join("patch-whatsapp-web.js");
    if src_patch.exists() {
        let _ = std::fs::copy(&src_patch, app_data_dir.join("patch-whatsapp-web.js"));
    }

    // 4. Se node_modules/ não existe, roda npm install --production
    let node_modules = app_data_dir.join("node_modules");
    if !node_modules.exists() {
        println!("[TAURI] node_modules/ não existe — rodando npm install --production...");
        println!("[TAURI] Isso pode demorar vários minutos na primeira vez (baixa Puppeteer + Chromium)...");

        #[cfg(windows)]
        let output = Command::new("cmd")
            .arg("/c").arg("npm").arg("install").arg("--production").arg("--no-audit").arg("--no-fund")
            .current_dir(app_data_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .output();

        #[cfg(not(windows))]
        let output = Command::new("npm")
            .arg("install").arg("--production").arg("--no-audit").arg("--no-fund")
            .current_dir(app_data_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .output();

        match output {
            Ok(o) => {
                if o.status.success() {
                    println!("[TAURI] ✅ npm install concluído");
                } else {
                    eprintln!("[TAURI] ⚠️ npm install pode ter falhado — verificando...");
                }
            }
            Err(e) => {
                eprintln!("[TAURI] ❌ erro ao rodar npm install: {}", e);
            }
        }

        // Roda o patch do whatsapp-web.js (vsync → fps_mode)
        println!("[TAURI] Aplicando patch do whatsapp-web.js...");
        #[cfg(windows)]
        let _ = Command::new("cmd")
            .arg("/c").arg("node").arg("patch-whatsapp-web.js")
            .current_dir(app_data_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .output();

        #[cfg(not(windows))]
        let _ = Command::new("node")
            .arg("patch-whatsapp-web.js")
            .current_dir(app_data_dir)
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .output();
    } else {
        println!("[TAURI] node_modules/ já existe — pulando npm install");
    }
}

/// Cópia recursiva que SEMPRE sobrescreve (usado pra dist/).
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) {
    if !src.exists() { return; }
    let _ = std::fs::create_dir_all(dst);
    if let Ok(entries) = std::fs::read_dir(src) {
        for entry in entries.flatten() {
            let path = entry.path();
            let dst_path = dst.join(entry.file_name());
            if path.is_dir() {
                copy_dir_recursive(&path, &dst_path);
            } else {
                let _ = std::fs::copy(&path, &dst_path);
            }
        }
    }
}

/// Spawna o bot Node.js.
/// Em DEV: `npx tsx src/bot.ts` no diretório do projeto
/// Em PRODUÇÃO: `node dist/bot.js` no AppData
fn spawn_bot_process(app_handle: &tauri::AppHandle) -> Option<Child> {
    let is_dev = is_port_open("127.0.0.1", 3001);

    if is_dev {
        // === MODO DEV ===
        // O bot já tá rodando via beforeDevCommand (npm run dev).
        // Não precisamos spawnar nada.
        println!("[TAURI] localhost:3001 já responde — modo dev (bot já rodando)");
        return None;
    }

    // === MODO PRODUÇÃO ===
    let app_data_dir = get_app_data_dir()?;
    let _ = std::fs::create_dir_all(&app_data_dir);

    // Configura o ambiente (copia resources, npm install se preciso)
    let resource_dir = app_handle.path().resource_dir().ok()?;
    setup_production_env(&resource_dir, &app_data_dir);

    // Spawna `node dist/bot.js` no AppData
    println!("[TAURI] Iniciando bot: node dist/bot.js em {}", app_data_dir.display());

    #[cfg(windows)]
    let child = Command::new("cmd")
        .arg("/c").arg("node").arg("dist/bot.js")
        .current_dir(&app_data_dir)
        .env("MARCIO_DATA_DIR", &app_data_dir)
        .env("NODE_ENV", "production")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();

    #[cfg(not(windows))]
    let child = Command::new("node")
        .arg("dist/bot.js")
        .current_dir(&app_data_dir)
        .env("MARCIO_DATA_DIR", &app_data_dir)
        .env("NODE_ENV", "production")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();

    match child {
        Ok(c) => {
            println!("[TAURI] ✅ Bot Node.js iniciado (PID: {})", c.id());
            Some(c)
        }
        Err(e) => {
            eprintln!("[TAURI] ❌ Erro ao iniciar bot: {}", e);
            eprintln!("[TAURI]    Certifique-se de que Node.js está instalado no PATH.");
            None
        }
    }
}

fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder()
        .title(title)
        .body(body)
        .show()
    {
        eprintln!("[TAURI] erro ao enviar notificação: {}", e);
    }
}

#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    send_notification(&app, &title, &body);
}

#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> bool {
    if let Some(autostart) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() {
        autostart.is_enabled().unwrap_or(false)
    } else {
        false
    }
}

#[tauri::command]
fn toggle_autostart(app: tauri::AppHandle, enabled: bool) -> bool {
    if let Some(autostart) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() {
        if enabled {
            autostart.enable().is_ok()
        } else {
            autostart.disable().is_ok()
        }
    } else {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["com.marcio.app"]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(BotProcess(Mutex::new(None)))
        .setup(|app| {
            // Spawna o bot (dev: detecta; produção: copia resources + npm install + spawn)
            let bot_child = spawn_bot_process(app.handle());
            let state: tauri::State<BotProcess> = app.state();
            *state.0.lock().unwrap() = bot_child;

            // Tray icon
            let show = MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Reiniciar bot", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &restart, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Márcio App")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "restart" => {
                        let state: tauri::State<BotProcess> = app.state();
                        let mut guard = state.0.lock().unwrap();
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        *guard = None;
                        if let Some(c) = spawn_bot_process(app) {
                            *guard = Some(c);
                        }
                    }
                    "quit" => {
                        let state: tauri::State<BotProcess> = app.state();
                        let mut guard = state.0.lock().unwrap();
                        if let Some(ref mut child) = *guard {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap_or_default();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![
            notify,
            is_autostart_enabled,
            toggle_autostart
        ])
        .run(tauri::generate_context!())
        .expect("erro ao rodar Márcio App");
}
