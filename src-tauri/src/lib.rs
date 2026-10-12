// Marcio App — lib.rs
//
// Tauri 2 backend. Faz:
//   1. Single instance — não deixa abrir 2 apps
//   2. Em DEV: o bot é iniciado pelo beforeDevCommand (npm run dev)
//   3. Em PRODUÇÃO: copia resources (dist/) pra AppData,
//      roda npm install --production, e spawna `node dist/bot.js`
//   4. Abre janela nativa apontando pro painel web (http://localhost:3001)
//   5. Cria tray icon: Mostrar / Reiniciar bot / Sair
//   6. Notificações nativas do Windows
//
// AppData dir (cross-platform):
//   - Windows: %APPDATA%\com.marcio.app
//   - macOS: ~/Library/Application Support/com.marcio.app
//   - Linux: ~/.config/com.marcio.app
// (Tauri resolve automaticamente via app_handle.path().app_data_dir())

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

/// Cria arquivos default de configuração se não existirem.
/// Esses arquivos permitem que o usuário edite configs pelo painel ou
/// manualmente. O bot funciona sem eles (usa defaults hardcoded), mas
/// ter os arquivos facilita edição + persistência.
fn ensure_default_data_files(app_data_dir: &PathBuf) {
    let data_dir = app_data_dir.join("data");
    let _ = std::fs::create_dir_all(&data_dir);
    let stickers_dir = data_dir.join("stickers-vault");
    let _ = std::fs::create_dir_all(&stickers_dir);

    // ai-config.json vazio (IA desativada até o usuário configurar API key)
    let ai_config = data_dir.join("ai-config.json");
    if !ai_config.exists() {
        let default_ai_config = r#"{
  "model": "gemini-3.5-flash-lite",
  "fallbackModels": ["gemini-3.1-flash-lite"],
  "apiUrl": "https://generativelanguage.googleapis.com/v1beta/models",
  "apiKey": "",
  "maxTokens": 400,
  "temperature": 0.75,
  "audioTranscription": {
    "enabled": true,
    "primaryModel": "gemini-3.5-flash-lite",
    "fallbackModel": "gemini-3.1-flash-lite"
  }
}
"#;
        let _ = std::fs::write(&ai_config, default_ai_config);
        println!("[TAURI] ✅ criado data/ai-config.json (default — configure API key no painel)");
    }

    // system-prompt.txt vazio (bot usa DEFAULT_SYSTEM_PROMPT hardcoded se vazio)
    let system_prompt = data_dir.join("system-prompt.txt");
    if !system_prompt.exists() {
        let _ = std::fs::write(&system_prompt, "");
        println!("[TAURI] ✅ criado data/system-prompt.txt (vazio — bot usa default)");
    }

    // banned.json vazio
    let banned = data_dir.join("banned.json");
    if !banned.exists() {
        let _ = std::fs::write(&banned, "[]");
    }

    // ops.json vazio
    let ops = data_dir.join("ops.json");
    if !ops.exists() {
        let _ = std::fs::write(&ops, "[]");
    }

    // directives.json vazio
    let directives = data_dir.join("directives.json");
    if !directives.exists() {
        let _ = std::fs::write(&directives, "[]");
    }

    // memories.json vazio
    let memories = data_dir.join("memories.json");
    if !memories.exists() {
        let _ = std::fs::write(&memories, "{}");
    }

    // chat-settings.json vazio
    let chat_settings = data_dir.join("chat-settings.json");
    if !chat_settings.exists() {
        let _ = std::fs::write(&chat_settings, "{}");
    }

    // decision-log.json vazio
    let decision_log = data_dir.join("decision-log.json");
    if !decision_log.exists() {
        let _ = std::fs::write(&decision_log, "{}");
    }

    // stickers-meta.json vazio
    let stickers_meta = data_dir.join("stickers-meta.json");
    if !stickers_meta.exists() {
        let _ = std::fs::write(&stickers_meta, "{}");
    }
}

/// Configura o ambiente de produção em AppData:
/// 1. Copia dist/ (código compilado) — sempre sobrescreve (código novo a cada versão)
/// 2. Copia package.json + patch-whatsapp-web.js (sempre sobrescreve)
/// 3. Cria arquivos default de config (ai-config.json, etc.) se não existirem
/// 4. Roda `npm install --production` se node_modules/ não existe
/// 5. Roda `node patch-whatsapp-web.js` depois do npm install
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
    } else {
        eprintln!("[TAURI] ⚠️ dist/ não encontrado nos resources — build pode estar quebrado");
    }

    // 2. Copia package.json + patch-whatsapp-web.js (sempre sobrescreve)
    let src_pkg = resource_dir.join("package.json");
    if src_pkg.exists() {
        let _ = std::fs::copy(&src_pkg, app_data_dir.join("package.json"));
        println!("[TAURI] ✅ package.json copiado");
    }
    let src_patch = resource_dir.join("patch-whatsapp-web.js");
    if src_patch.exists() {
        let _ = std::fs::copy(&src_patch, app_data_dir.join("patch-whatsapp-web.js"));
        println!("[TAURI] ✅ patch-whatsapp-web.js copiado");
    }

    // 3. Cria arquivos default de config se não existirem (NÃO sobrescreve existentes)
    ensure_default_data_files(app_data_dir);

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
        // Mesmo com node_modules existente, roda o patch se ainda não foi aplicado
        // (idempotente — se já tá patcheado, não faz nada)
        let patch_marker = app_data_dir.join(".patch-applied");
        if !patch_marker.exists() {
            println!("[TAURI] Aplicando patch do whatsapp-web.js (primeira vez)...");
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
            let _ = std::fs::write(&patch_marker, "applied");
        }
    }
}

/// Lê setup-state.json do AppData — flag que indica se o wizard já foi completado.
/// Retorna true se setup completo (deve abrir main window) ou false se precisa abrir setup.
fn is_setup_completed(app_data_dir: &PathBuf) -> bool {
    let setup_state_path = app_data_dir.join("data").join("setup-state.json");
    if !setup_state_path.exists() {
        return false;
    }
    match std::fs::read_to_string(&setup_state_path) {
        Ok(content) => {
            // Parse simples do JSON (evita dep de serde no lib.rs)
            content.contains("\"completed\":true")
        }
        Err(_) => false,
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
    // Usa a API cross-platform do Tauri pra resolver o AppData dir:
    //   - Windows: %APPDATA%\com.marcio.app
    //   - macOS: ~/Library/Application Support/com.marcio.app
    //   - Linux: ~/.config/com.marcio.app
    let app_data_dir = app_handle.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&app_data_dir);
    println!("[TAURI] AppData dir: {}", app_data_dir.display());

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

/// Chamado pelo setup-wizard quando o setup é completado.
/// Abre a janela main e fecha a janela de setup.
#[tauri::command]
fn open_main_window(app: tauri::AppHandle) {
    println!("[TAURI] Setup completo — abrindo janela main");
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.show();
        let _ = main_window.set_focus();
    }
    if let Some(setup_window) = app.get_webview_window("setup") {
        let _ = setup_window.close();
    }
}

/// Força reabrir o setup wizard (pra testar em dev).
/// Marca setup-state.json como não completado.
#[tauri::command]
fn reopen_setup(app: tauri::AppHandle) {
    println!("[TAURI] Reabrindo setup wizard (forçado)");
    // Em dev, não precisa marcar setup-state (não afeta dados).
    // Só abre a janela de setup se existir.
    if let Some(setup_window) = app.get_webview_window("setup") {
        let _ = setup_window.show();
        let _ = setup_window.set_focus();
    } else {
        // Se a janela foi fechada, cria uma nova
        let _ = tauri::WebviewWindowBuilder::new(
            &app,
            "setup",
            tauri::WebviewUrl::App("setup-wizard.html".into())
        )
        .title("Márcio App — Setup")
        .inner_size(560.0, 720.0)
        .min_inner_size(480.0, 600.0)
        .resizable(false)
        .decorations(false)
        .center()
        .build();
    }
}

/// Reinicia o app (usado pelo updater depois de instalar nova versão).
/// Em Tauri 2, usa `app.restart()` que fecha todos os processos e reabre.
#[tauri::command]
fn relaunch_app(app: tauri::AppHandle) {
    println!("[TAURI] Reiniciando app…");
    // Mata o bot Node.js antes de reiniciar (senão fica órfão)
    let state: tauri::State<BotProcess> = app.state();
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut child) = *guard {
        let _ = child.kill();
        let _ = child.wait();
    }
    *guard = None;
    // Reinicia o app Tauri
    app.restart();
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

            // === Decide qual janela mostrar (setup ou main) ===
            // Em produção: checa setup-state.json no AppData.
            // Em dev: sempre abre main (setup é testado via URL /setup-wizard.html).
            let is_dev = is_port_open("127.0.0.1", 3001);
            let should_show_setup = if is_dev {
                // Dev: sempre abre main. Setup é acessível via http://localhost:3001/setup-wizard.html
                false
            } else {
                // Produção: checa se setup foi completado
                let app_data_dir = app.path().app_data_dir().ok();
                match app_data_dir {
                    Some(d) => !is_setup_completed(&d),
                    None => true,  // não conseguiu resolver AppData — mostra setup (primeira vez provável)
                }
            };

            if should_show_setup {
                println!("[TAURI] Setup não completado — abrindo janela de setup");
                if let Some(setup_window) = app.get_webview_window("setup") {
                    let _ = setup_window.show();
                    let _ = setup_window.set_focus();
                }
                // Esconde a janela main (já tá invisível por config, mas por garantia)
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.hide();
                }
            } else {
                println!("[TAURI] Setup já completado (ou dev mode) — abrindo janela main");
                if let Some(main_window) = app.get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                }
                // Fecha a janela de setup se estiver aberta (não deveria, mas por garantia)
                if let Some(setup_window) = app.get_webview_window("setup") {
                    let _ = setup_window.hide();
                }
            }

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
            toggle_autostart,
            open_main_window,
            reopen_setup,
            relaunch_app
        ])
        .run(tauri::generate_context!())
        .expect("erro ao rodar Márcio App");
}
