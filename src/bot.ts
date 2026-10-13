/**
 * bot.ts — entrypoint do Márcio App.
 *
 * Uso:  npm run dev   (tsx watch — hot reload ao salvar)
 *       npm start     (tsx — sem watch)
 *       npm run build && node dist/bot.js  (compilado)
 *
 * O que faz:
 *  1. Determina o diretório base de dados (MARCIO_DATA_DIR ou cwd).
 *     - Em produção (Tauri .exe), MARCIO_DATA_DIR = %APPDATA%\MarcioApp
 *     - Em dev, usa o cwd do projeto (backward compat)
 *  2. Migra dados antigos (data/, .wwebjs_auth/) pro novo local se preciso.
 *  3. Instancia MarcioApp e chama start().
 *  4. Captura SIGINT/SIGTERM pra desligar graciosamente.
 */

import path from 'node:path';
import fs from 'node:fs';
import { MarcioApp, type AppConfig } from './MarcioApp';

// === Determina o diretório base de dados ===
// Em produção (Tauri), o Rust passa MARCIO_DATA_DIR = %APPDATA%\MarcioApp
// Em dev (sem a env var), usa o cwd do projeto
//
// ⚠️ OPÇÃO: MARCIO_USE_PROD_DATA=1
// Se setado em dev, usa os dados de produção (AppData) em vez da pasta local.
// Isso permite testar com dados reais sem precisar fazer backup/restore.
// Ex: $env:MARCIO_USE_PROD_DATA=1; npm run dev
const MARCIO_DATA_DIR = process.env.MARCIO_DATA_DIR;
const rootDir = process.cwd();

// Detecta o AppData dir do Tauri (mesma lógica do Rust)
function detectAppDataDir(): string | null {
  const home = process.env.USERPROFILE || process.env.HOME || process.env.APPDATA;
  if (!home) return null;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || home, 'com.marcio.app');
  } else if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'com.marcio.app');
  } else {
    return path.join(home, '.config', 'com.marcio.app');
  }
}

let baseDir: string;

if (MARCIO_DATA_DIR) {
  // Produção: Rust passou o caminho
  baseDir = MARCIO_DATA_DIR;
  console.log(`[BOOT] Usando data dir (produção): ${baseDir}`);
} else if (process.env.MARCIO_USE_PROD_DATA === '1') {
  // Dev com dados de produção
  const appData = detectAppDataDir();
  if (appData && fs.existsSync(appData)) {
    baseDir = appData;
    console.log(`[BOOT] Usando data dir de PRODUÇÃO em dev: ${baseDir}`);
    console.log(`[BOOT] ⚠️ Cuidado: mudanças em dev afetam os dados de produção!`);
  } else {
    baseDir = rootDir;
    console.log(`[BOOT] MARCIO_USE_PROD_DATA=1 mas AppData não encontrado (${appData}) — usando cwd`);
  }
} else {
  // Dev normal (dados locais)
  baseDir = rootDir;
  console.log(`[BOOT] Dev mode — usando cwd (${baseDir})`);
  console.log(`[BOOT] 💡 Pra usar dados de produção: $env:MARCIO_USE_PROD_DATA=1; npm run dev`);
}

// === Migração: se tem data/ ou .wwebjs_auth/ no cwd mas não no baseDir, copia ===
function migrateIfNeeded() {
  if (!MARCIO_DATA_DIR) return; // só migra em produção (quando baseDir != cwd)

  const oldDataDir = path.join(rootDir, 'data');
  const newDataDir = path.join(baseDir, 'data');
  const oldAuth = path.join(rootDir, '.wwebjs_auth');
  const newAuth = path.join(baseDir, '.wwebjs_auth');

  // Migra data/ se existe no cwd mas não no baseDir
  if (fs.existsSync(oldDataDir) && !fs.existsSync(newDataDir)) {
    console.log('[BOOT] Migrando data/ pra o novo local...');
    try {
      fs.cpSync(oldDataDir, newDataDir, { recursive: true });
      console.log('[BOOT] ✅ data/ migrado');
    } catch (e) {
      console.error('[BOOT] ❌ erro ao migrar data/:', (e as Error).message);
    }
  }

  // Migra .wwebjs_auth/ se existe no cwd mas não no baseDir
  if (fs.existsSync(oldAuth) && !fs.existsSync(newAuth)) {
    console.log('[BOOT] Migrando .wwebjs_auth/ pra o novo local...');
    try {
      fs.cpSync(oldAuth, newAuth, { recursive: true });
      console.log('[BOOT] ✅ .wwebjs_auth/ migrado');
    } catch (e) {
      console.error('[BOOT] ❌ erro ao migrar .wwebjs_auth/:', (e as Error).message);
    }
  }
}

migrateIfNeeded();

// === Configuração ===
const config: AppConfig = {
  rootDir,
  dataDir: path.join(baseDir, 'data'),
  logDir: path.join(baseDir, 'logs'),
  botName: 'Bot 🤖',

  // Auth do WhatsApp: usa .wwebjs_auth/ dentro do baseDir
  // (em produção: %APPDATA%\MarcioApp\.wwebjs_auth)
  // (em dev: cwd\.wwebjs_auth — backward compat)
  legacyAuthPath: MARCIO_DATA_DIR ? path.join(baseDir, '.wwebjs_auth') : undefined,
};

// Boot
const app = new MarcioApp(config);

// Shutdown gracioso
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] desligando...`);
  await app.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  app.log('FATAL', `uncaughtException: ${err.stack ?? err.message}`);
  // ErrorTracker já vai capturar via seu próprio handler, mas garantimos
  // que o erro seja reportado aqui também antes do shutdown.
  try {
    app.errors.report('UNCAUGHT', `Exceção não capturada: ${err.message}`, err, {
      userMessage: 'Erro crítico interno. O app vai reiniciar.',
      severity: 'critical',
    });
  } catch { /* evita recursão */ }
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  app.log('FATAL', `unhandledRejection: ${String(reason)}`);
  // ErrorTracker já captura isso via handler próprio.
});

// Inicia
app.start().catch((err) => {
  console.error('Erro fatal ao iniciar:', err);
  try {
    app.errors.report('BOOT', `Erro fatal ao iniciar app: ${err.message}`, err, {
      userMessage: 'O app não conseguiu iniciar. Verifique os logs em /diagnostic.',
      severity: 'critical',
    });
  } catch { /* evita erro duplo */ }
  process.exit(1);
});
