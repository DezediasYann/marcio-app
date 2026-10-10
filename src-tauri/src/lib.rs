// Marcio App — lib.rs
//
// Tauri 2 backend. Faz 3 coisas:
//   1. Spawna o processo Node.js do bot (`node bot.ts` via tsx) em background
//   2. Abre uma janela nativa apontando pro painel web (http://localhost:3001)
//   3. Cria um ícone de bandeja (tray) com menu: Mostrar / Reiniciar bot / Sair
//
// IMPORTANTE: o bot (Node.js) é quem faz tudo — IA, WhatsApp, comandos, painel.
// O Rust só embrulha: abre janela + gerencia o processo filho.

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

// Guarda o PID do processo Node pra podermos matar quando o app fechar.
struct BotProcess(Mutex<Option<Child>>);

/// Inicia o bot Node.js como processo filho.
/// Usa `npx tsx src/bot.ts` (mesmo que `npm run dev` mas sem watch).
/// O cwd é o diretório do projeto (onde tá package.json).
fn spawn_bot(app: &tauri::AppHandle) -> Option<Child> {
    let resource_dir = app.path().resource_dir().ok()?;
    // Em dev, o cwd é o diretório do projeto (src-tauri/..).
    // Em produção (bundled), o bot vai junto como resource.
    // Por enquanto, assume que tá rodando do diretório do projeto.
    let project_dir = std::env::current_dir().unwrap_or_else(|_| resource_dir.clone());

    println!("[TAURI] Iniciando bot Node.js em: {}", project_dir.display());

    // Tenta: npx tsx src/bot.ts
    // Se npx falhar (tsconfig issues), cai pra: node dist/bot.js
    let child = Command::new("npx")
        .arg("tsx")
        .arg("src/bot.ts")
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

#[tauri::command]
fn restart_bot(state: tauri::State<BotProcess>) -> String {
    let mut guard = state.0.lock().unwrap();
    // Mata o processo antigo se existir
    if let Some(ref mut child) = *guard {
        let _ = child.kill();
        let _ = child.wait();
    }
    *guard = None;
    // TODO: re-spawn — precisaria do app handle aqui.
    // Por enquanto, só mata. O usuário reabre o app.
    "Bot reiniciado (feche e reabra o app pra reiniciar completamente)".to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BotProcess(Mutex::new(None)))
        .setup(|app| {
            // Spawna o bot
            if let Some(child) = spawn_bot(&app.handle()) {
                let state: tauri::State<BotProcess> = app.state();
                *state.0.lock().unwrap() = Some(child);
            }

            // Cria o tray icon com menu
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
                        if let Some(child) = spawn_bot(app) {
                            *guard = Some(child);
                        }
                    }
                    "quit" => {
                        // Mata o bot antes de sair
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
            // Quando o usuário fecha a janela (X), minimiza pra tray em vez de sair.
            if let WindowEvent::CloseRequested { api, .. } = event {
                window.hide().unwrap_or_default();
                api.prevent_close();
            }
        })
        .invoke_handler(tauri::generate_handler![restart_bot])
        .run(tauri::generate_context!())
        .expect("erro ao rodar Márcio App");
}
