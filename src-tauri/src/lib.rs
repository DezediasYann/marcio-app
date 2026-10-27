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
    Manager, WindowEvent, Emitter, Listener,
};
use tauri_plugin_notification::NotificationExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct BotProcess(Mutex<Option<Child>>);

fn is_port_open(host: &str, port: u16) -> bool {
    std::net::TcpStream::connect((host, port)).is_ok()
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
/// 1. Extrai dist-bundle.zip (código compilado) — sempre sobrescreve
/// 2. Extrai node_modules.zip (dependências) — só se não existe (pula se já tem)
/// 3. Copia package.json + patch-whatsapp-web.js + changelog.json
/// 4. Cria arquivos default de config se não existirem
/// 5. Aplica patch do whatsapp-web.js (idempotente)
/// NÃO faz npm install — node_modules já vem no zip (funciona sem Node.js no PC).
fn setup_production_env(resource_dir: &PathBuf, app_data_dir: &PathBuf) {
    println!("[TAURI] Configurando ambiente de produção em: {}", app_data_dir.display());
    let _ = std::fs::create_dir_all(app_data_dir);

    // 1. Extrai dist-bundle.zip (código compilado) — sempre sobrescreve
    let dist_zip = resource_dir.join("dist-bundle.zip");
    let dst_dist = app_data_dir.join("dist");
    if dist_zip.exists() {
        let _ = std::fs::remove_dir_all(&dst_dist);
        let _ = std::fs::create_dir_all(&dst_dist);
        println!("[TAURI] Extraindo dist-bundle.zip...");
        extract_zip(&dist_zip, &dst_dist);
        println!("[TAURI] ✅ dist/ extraído");
    } else if resource_dir.join("dist").exists() {
        // Fallback: copia dist/ direto (se não tem zip)
        let src_dist = resource_dir.join("dist");
        let _ = std::fs::remove_dir_all(&dst_dist);
        let _ = std::fs::create_dir_all(&dst_dist);
        copy_dir_recursive(&src_dist, &dst_dist);
        println!("[TAURI] ✅ dist/ copiado (fallback)");
    }

    // 2. Extrai node_modules.zip — SÓ se não existe (não sobrescreve pra não quebrar patches)
    let nm_zip = resource_dir.join("node_modules.zip");
    let dst_nm = app_data_dir.join("node_modules");
    if !dst_nm.exists() {
        if nm_zip.exists() {
            let _ = std::fs::create_dir_all(&dst_nm);
            println!("[TAURI] Extraindo node_modules.zip (pode demorar)...");
            extract_zip(&nm_zip, &dst_nm);
            println!("[TAURI] ✅ node_modules/ extraído");
        } else {
            eprintln!("[TAURI] ⚠️ node_modules.zip não encontrado — bot pode não funcionar");
        }
    } else {
        println!("[TAURI] node_modules/ já existe — pulando extração");
    }

    // 3. Copia node-portable (Node.js embutido) — sempre sobrescreve
    #[cfg(windows)]
    {
        let src_node = resource_dir.join("node-portable.exe");
        if src_node.exists() {
            let _ = std::fs::copy(&src_node, app_data_dir.join("node-portable.exe"));
            println!("[TAURI] ✅ node-portable.exe copiado");
        }
    }
    #[cfg(not(windows))]
    {
        let src_node = resource_dir.join("node-portable");
        if src_node.exists() {
            let _ = std::fs::copy(&src_node, app_data_dir.join("node-portable"));
            // No Linux/macOS, precisa dar permissão de execução no binário.
            // std::fs::set_permissions é o método correto (não std::fs::permissions).
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                app_data_dir.join("node-portable"),
                std::fs::Permissions::from_mode(0o755),
            );
            println!("[TAURI] ✅ node-portable copiado");
        }
    }

    // 4. Copia package.json + patch-whatsapp-web.js + changelog.json
    for file in &["package.json", "patch-whatsapp-web.js", "changelog.json"] {
        let src = resource_dir.join(file);
        if src.exists() {
            let _ = std::fs::copy(&src, app_data_dir.join(file));
        }
    }

    // 5. Cria arquivos default de config
    ensure_default_data_files(app_data_dir);

    // 6. Aplica patch do whatsapp-web.js (idempotente, sem janela visível)
    let patch_marker = app_data_dir.join(".patch-applied");
    if !patch_marker.exists() {
        println!("[TAURI] Aplicando patch do whatsapp-web.js...");
        let node_exe = get_node_executable(app_data_dir);
        #[cfg(windows)]
        {
            let mut cmd = Command::new(&node_exe);
            cmd.arg("patch-whatsapp-web.js")
                .current_dir(app_data_dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output();
        }
        #[cfg(not(windows))]
        {
            let _ = Command::new(&node_exe)
                .arg("patch-whatsapp-web.js")
                .current_dir(app_data_dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output();
        }
        let _ = std::fs::write(&patch_marker, "applied");
    }
}

/// Resolve o caminho do executável do Node.js.
/// Em produção: usa node-portable (embutido no app) no AppData.
/// Em dev: usa "node" do PATH (fallback).
fn get_node_executable(app_data_dir: &PathBuf) -> String {
    #[cfg(windows)]
    {
        let portable = app_data_dir.join("node-portable.exe");
        if portable.exists() {
            return portable.to_string_lossy().to_string();
        }
    }
    #[cfg(not(windows))]
    {
        let portable = app_data_dir.join("node-portable");
        if portable.exists() {
            return portable.to_string_lossy().to_string();
        }
    }
    // Fallback: "node" do PATH (se node-portable não existe)
    "node".to_string()
}

/// Extrai um arquivo .zip num diretório destino.
/// Usa crate `zip` nativo (cross-platform, sem dependências do sistema).
/// Fallback: tenta PowerShell (Windows) ou unzip (Linux/macOS) se nativo falhar.
fn extract_zip(zip_path: &PathBuf, dest: &PathBuf) {
    let _ = std::fs::create_dir_all(dest);

    // 1. Tenta extração nativa primeiro (cross-platform, sem deps externas)
    if extract_zip_native(zip_path, dest) {
        println!("[TAURI] ✅ extração nativa concluída: {}", zip_path.display());
        return;
    }
    eprintln!("[TAURI] ⚠️ extração nativa falhou — tentando fallback externo");

    // 2. Fallback: PowerShell (Windows) ou unzip (Linux/macOS)
    #[cfg(windows)]
    {
        let mut cmd = Command::new("powershell");
        cmd.arg("-WindowStyle").arg("Hidden")
            .arg("-Command")
            .arg(format!(
                "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                zip_path.display(),
                dest.display()
            ))
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("unzip")
            .arg("-o")
            .arg("-q")
            .arg(zip_path)
            .arg("-d")
            .arg(dest)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .output();
    }
}

/// Extração nativa de ZIP usando crate `zip` (sem depender de comando externo).
/// Funciona em Windows, macOS e Linux. Retorna true se sucesso.
fn extract_zip_native(zip_path: &PathBuf, dest: &PathBuf) -> bool {
    let file = match std::fs::File::open(zip_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[TAURI] não conseguiu abrir zip: {}", e);
            return false;
        }
    };
    let mut archive = match zip::ZipArchive::new(file) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("[TAURI] não conseguiu ler zip: {}", e);
            return false;
        }
    };
    for i in 0..archive.len() {
        let mut entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let outpath = match entry.enclosed_name() {
            Some(p) => dest.join(p),
            None => continue,
        };
        // Cria diretório pai se não existe
        if let Some(parent) = outpath.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&outpath);
        } else {
            let mut outfile = match std::fs::File::create(&outpath) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let _ = std::io::copy(&mut entry, &mut outfile);
            // Em Unix, aplica permissões do arquivo do zip
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = entry.unix_mode() {
                    let _ = std::fs::set_permissions(
                        &outpath,
                        std::fs::Permissions::from_mode(mode),
                    );
                }
            }
        }
    }
    true
}

/// Lê setup-state.json do AppData — flag que indica se o wizard já foi completado.
/// Retorna true se setup completo (deve abrir main window) ou false se precisa abrir setup.
fn is_setup_completed(app_data_dir: &PathBuf) -> bool {
    let setup_state_path = app_data_dir.join("data").join("setup-state.json");
    if !setup_state_path.exists() {
        println!("[TAURI] setup-state.json não existe em: {}", setup_state_path.display());
        return false;
    }
    match std::fs::read_to_string(&setup_state_path) {
        Ok(content) => {
            println!("[TAURI] setup-state.json encontrado — conteúdo: {}", content);
            // Parse simples do JSON (evita dep de serde no lib.rs)
            // Aceita com ou sem espaço depois do ":" (JSON.stringify com indent=2 gera ": true")
            let cleaned = content.replace(" ", "").replace("\n", "").replace("\t", "");
            let found = cleaned.contains("\"completed\":true");
            println!("[TAURI] is_setup_completed = {} (procurou \"completed\":true)", found);
            found
        }
        Err(e) => {
            println!("[TAURI] erro ao ler setup-state.json: {}", e);
            false
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
    // Usa a API cross-platform do Tauri pra resolver o AppData dir:
    //   - Windows: %APPDATA%\com.marcio.app
    //   - macOS: ~/Library/Application Support/com.marcio.app
    //   - Linux: ~/.config/com.marcio.app
    let app_data_dir = app_handle.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&app_data_dir);
    println!("[TAURI] AppData dir: {}", app_data_dir.display());

    // Configura o ambiente (extrai resources, NÃO faz npm install)
    let resource_dir = app_handle.path().resource_dir().ok()?;
    setup_production_env(&resource_dir, &app_data_dir);

    // Resolve o executável do Node.js (node-portable embutido ou "node" do PATH)
    let node_exe = get_node_executable(&app_data_dir);
    println!("[TAURI] Node.js: {}", node_exe);
    println!("[TAURI] Iniciando bot: {} dist/bot.js em {}", node_exe, app_data_dir.display());

    // Redireciona stdout/stderr pra arquivo de log (esconde console do Windows).
    let log_path = app_data_dir.join("logs");
    let _ = std::fs::create_dir_all(&log_path);
    let log_file = std::fs::File::create(log_path.join("bot-stdout.log")).ok();
    let log_file_err = std::fs::File::create(log_path.join("bot-stderr.log")).ok();
    let stdout = log_file.map(|f| Stdio::from(f)).unwrap_or(Stdio::null());
    let stderr = log_file_err.map(|f| Stdio::from(f)).unwrap_or(Stdio::null());

    #[cfg(windows)]
    {
        let mut cmd = Command::new(&node_exe);
        cmd.arg("dist/bot.js")
            .current_dir(&app_data_dir)
            .env("MARCIO_DATA_DIR", &app_data_dir)
            .env("NODE_ENV", "production")
            .stdout(stdout)
            .stderr(stderr);
        cmd.creation_flags(CREATE_NO_WINDOW); // esconde janela de console
        let child = cmd.spawn();
        match child {
            Ok(c) => {
                println!("[TAURI] ✅ Bot Node.js iniciado (PID: {}, sem janela de console)", c.id());
                Some(c)
            }
            Err(e) => {
                eprintln!("[TAURI] ❌ Erro ao iniciar bot: {}", e);
                None
            }
        }
    }

    #[cfg(not(windows))]
    {
        let child = Command::new(&node_exe)
            .arg("dist/bot.js")
            .current_dir(&app_data_dir)
            .env("MARCIO_DATA_DIR", &app_data_dir)
            .env("NODE_ENV", "production")
            .stdout(stdout)
            .stderr(stderr)
            .spawn();
        match child {
            Ok(c) => {
                println!("[TAURI] ✅ Bot Node.js iniciado (PID: {})", c.id());
                Some(c)
            }
            Err(e) => {
                eprintln!("[TAURI] ❌ Erro ao iniciar bot: {}", e);
                None
            }
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

/// Sair completamente do app (mata bot + fecha Tauri).
/// Diferente de fechar a janela (que só esconde pro tray), este comando
/// mata o processo do bot Node.js E fecha o app Tauri de verdade.
/// Usado pelo botão "Sair completamente" no painel.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    println!("[TAURI] Quit app solicitado — matando bot e saindo…");
    let state: tauri::State<BotProcess> = app.state();
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut child) = *guard {
        let _ = child.kill();
        let _ = child.wait();
        println!("[TAURI] ✅ Bot Node.js morto");
    }
    *guard = None;
    // Fecha todas as janelas e sai do processo Tauri
    app.exit(0);
}

/// Minimiza a janela main pro tray (esconde sem fechar).
/// Usado pelo botão "Minimizar pro tray" no modal de fechar.
#[tauri::command]
fn minimize_to_tray(app: tauri::AppHandle) {
    println!("[TAURI] Minimizando pro tray…");
    if let Some(main_window) = app.get_webview_window("main") {
        let _ = main_window.hide();
        println!("[TAURI] ✅ Janela main escondida (minimizada pro tray)");
    } else {
        println!("[TAURI] ⚠️ Janela main não encontrada");
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
            // Tray icon (cria imediatamente — não precisa esperar setup)
            let show = MenuItem::with_id(app, "show", "Mostrar", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "Reiniciar bot", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &restart, &quit])?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Márcio App")
                .icon({
                    // Usa o ícone default do app (definido em tauri.conf.json).
                    // Fallback: imagem 1x1 transparente (RGBA) se não tiver ícone.
                    // Evita panic em plataformas onde default_window_icon() pode retornar None.
                    const FALLBACK_RGBA: [u8; 4] = [0, 0, 0, 0];
                    app.default_window_icon()
                        .cloned()
                        .unwrap_or_else(|| {
                            eprintln!("[TAURI] ⚠️ default_window_icon() retornou None — usando fallback");
                            tauri::image::Image::new(&FALLBACK_RGBA, 1, 1)
                        })
                })
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
                        println!("[TAURI] Tray menu: Sair — matando bot e saindo...");
                        let state: tauri::State<BotProcess> = app.state();
                        let mut guard = state.0.lock().unwrap();
                        if let Some(ref mut child) = *guard {
                            println!("[TAURI] Matando processo do bot (PID: {})", child.id());
                            let _ = child.kill();
                            let _ = child.wait();
                            println!("[TAURI] ✅ Bot morto");
                        } else {
                            println!("[TAURI] ⚠️ Nenhum bot em execução para matar");
                        }
                        *guard = None;
                        // Em Windows, garante que o processo sai mesmo se tiver threads presas
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // === Tela de preparação ===
            // A janela "preparing" já tá visível (visible: true no config).
            // Em dev: pula direto pra main (porta 3001 já aberta).
            // Em produção: roda setup_production_env em background, depois troca pra setup/main.

            let app_handle = app.handle().clone();

            // Listener: quando setup_production_env termina, troca de janela
            app.handle().listen("env-ready", move |_event| {
                println!("[TAURI] Ambiente pronto — trocando janela");

                // Decide qual janela mostrar (setup ou main)
                let is_dev = is_port_open("127.0.0.1", 3001);
                println!("[TAURI] is_dev (porta 3001) = {}", is_dev);
                let should_show_setup = if is_dev {
                    println!("[TAURI] Modo dev — não mostra setup wizard (bot já rodando via npm run dev)");
                    false
                } else {
                    let app_data_dir = app_handle.path().app_data_dir().ok();
                    match app_data_dir {
                        Some(d) => {
                            println!("[TAURI] AppData dir: {}", d.display());
                            let setup_done = is_setup_completed(&d);
                            println!("[TAURI] is_setup_completed = {}", setup_done);
                            !setup_done
                        },
                        None => {
                            println!("[TAURI] ⚠️ AppData dir não encontrado — mostrando setup");
                            true
                        }
                    }
                };

                // Fecha janela preparing
                if let Some(prep) = app_handle.get_webview_window("preparing") {
                    let _ = prep.close();
                }

                if should_show_setup {
                    println!("[TAURI] Abrindo setup wizard");
                    if let Some(setup_window) = app_handle.get_webview_window("setup") {
                        let _ = setup_window.show();
                        let _ = setup_window.set_focus();
                    }
                } else {
                    println!("[TAURI] Abrindo painel principal");
                    if let Some(main_window) = app_handle.get_webview_window("main") {
                        let _ = main_window.show();
                        let _ = main_window.set_focus();
                    }
                }
            });

            // Background thread: roda setup_production_env + spawn bot
            let app_handle_bg = app.handle().clone();
            std::thread::spawn(move || {
                let is_dev = is_port_open("127.0.0.1", 3001);

                if is_dev {
                    println!("[TAURI] Dev mode — pulando setup_production_env");
                } else {
                    // Produção: extrai zips, copia node-portable, aplica patch
                    let resource_dir = app_handle_bg.path().resource_dir().ok();
                    let app_data_dir = app_handle_bg.path().app_data_dir().ok();
                    if let (Some(rd), Some(ad)) = (resource_dir, app_data_dir) {
                        setup_production_env(&rd, &ad);
                    }
                }

                // Spawn bot (em dev, bot já tá rodando; em produção, spawn agora)
                let bot_child = spawn_bot_process(&app_handle_bg);
                let state: tauri::State<BotProcess> = app_handle_bg.state();
                *state.0.lock().unwrap() = bot_child;

                // Notifica main thread que o ambiente tá pronto
                let _ = app_handle_bg.emit("env-ready", ());
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Só pergunta pra janela main (a principal do app).
                // Setup wizard e preparing não perguntam — apenas escondem.
                if window.label() == "main" {
                    // Emite evento pro frontend abrir modal "Desligar bot ou minimizar?"
                    // O frontend decide: se "minimizar" → window.hide()
                    //                  se "sair" → invoke('quit_app')
                    let _ = window.app_handle().emit("close-requested", ());
                    api.prevent_close();
                } else {
                    window.hide().unwrap_or_default();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            notify,
            is_autostart_enabled,
            toggle_autostart,
            open_main_window,
            reopen_setup,
            relaunch_app,
            quit_app,
            minimize_to_tray
        ])
        .run(tauri::generate_context!())
        .expect("erro ao rodar Márcio App");
}
