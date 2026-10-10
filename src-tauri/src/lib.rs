// Marcio App — lib.rs
//
// Tauri 2 backend. Faz:
//   1. Single instance — não deixa abrir 2 apps
//   2. Spawna o bot Node.js (em produção) ou detecta (em dev)
//   3. Abre janela nativa apontando pro painel web (http://localhost:3001)
//   4. Cria tray icon: Mostrar / Reiniciar bot / Sair
//   5. Notificações nativas do Windows (quando o bot reporta alertas via WS)
//   6. Auto-start no boot (opcional, via plugin)
//
// IMPORTANTE: o bot (Node.js) é quem faz tudo — IA, WhatsApp, comandos, painel.
// O Rust só embrulha: abre janela + gerencia o processo filho + notificações.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

// Guarda o processo Node pra podermos matar quando o app fechar.
struct BotProcess(Mutex<Option<Child>>);

/// Verifica se uma porta TCP tá aberta (tentando conectar).
fn is_port_open(host: &str, port: u16) -> bool {
    std::net::TcpStream::connect((host, port)).is_ok()
}

/// Spawna o bot Node.js no diretório do projeto.
/// No Windows usa `cmd /c npx` porque `npx` é um .cmd file.
fn spawn_bot_process() -> Option<Child> {
    let cwd = std::env::current_dir().ok()?;
    let project_dir = cwd.parent().unwrap_or(&cwd).to_path_buf();

    println!("[TAURI] Iniciando bot Node.js em: {}", project_dir.display());

    #[cfg(windows)]
    let child = Command::new("cmd")
        .arg("/c").arg("npx").arg("tsx").arg("src/bot.ts")
        .current_dir(&project_dir)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn();

    #[cfg(not(windows))]
    let child = Command::new("npx")
        .arg("tsx").arg("src/bot.ts")
        .current_dir(&project_dir)
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
            eprintln!("[TAURI]    Certifique-se de que Node.js e npm estão no PATH.");
            None
        }
    }
}

/// Envia uma notificação nativa do sistema (Windows toast / macOS notification).
fn send_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder()
        .title(title)
        .body(body)
        .show()
    {
        eprintln!("[TAURI] erro ao enviar notificação: {}", e);
    }
}

// === Comandos Tauri (chamados pelo frontend via invoke) ===

/// Envia uma notificação nativa (chamado pelo painel via JS).
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) {
    send_notification(&app, &title, &body);
}

/// Verifica se o auto-start tá ativado.
#[tauri::command]
fn is_autostart_enabled(app: tauri::AppHandle) -> bool {
    if let Some(autostart) = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>() {
        autostart.is_enabled().unwrap_or(false)
    } else {
        false
    }
}

/// Ativa/desativa o auto-start.
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
    // Single instance — se já tem outra instância rodando, foca nela e sai.
    // Pra funcionar, precisa do plugin tauri-plugin-single-instance.
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Segunda instância: foca a janela existente
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
            Some(vec!["com.marcio.app"]), // app id pra auto-start
        ))
        .manage(BotProcess(Mutex::new(None)))
        .setup(|app| {
            // === Spawna o bot (ou detecta em dev) ===
            let bot_child = if is_port_open("127.0.0.1", 3001) {
                println!("[TAURI] localhost:3001 já responde — modo dev (bot já rodando)");
                None
            } else {
                println!("[TAURI] localhost:3001 não responde — modo produção (spawna bot)");
                spawn_bot_process()
            };
            let state: tauri::State<BotProcess> = app.state();
            *state.0.lock().unwrap() = bot_child;

            // === Tray icon ===
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
                        if let Some(c) = spawn_bot_process() {
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

            // === Notificação de boas-vindas (só em produção, pra não encher em dev) ===
            if !is_port_open("127.0.0.1", 3001) {
                // Se spawnamos o bot (produção), notifica
                send_notification(app.handle(), "🤖 Márcio App", "Bot iniciado e rodando em background.");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Fecha a janela (X) → minimiza pra tray
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
