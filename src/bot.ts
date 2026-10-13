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
const MARCIO_DATA_DIR = process.env.MARCIO_DATA_DIR;
const rootDir = process.cwd();

if (MARCIO_DATA_DIR) {
  console.log(`[BOOT] Usando data dir: ${MARCIO_DATA_DIR}`);
} else {
  console.log(`[BOOT] MARCIO_DATA_DIR não setado — usando cwd (${rootDir})`);
}

// Diretório base pra todos os dados
const baseDir = MARCIO_DATA_DIR || rootDir;

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
  shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  app.log('FATAL', `unhandledRejection: ${String(reason)}`);
});

// Inicia
app.start().catch((err) => {
  console.error('Erro fatal ao iniciar:', err);
  process.exit(1);
});
