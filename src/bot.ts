/**
 * bot.ts — entrypoint do Márcio App.
 *
 * Uso:  npm run dev   (tsx watch — hot reload ao salvar)
 *       npm start     (tsx — sem watch)
 *       npm run build && node dist/bot.js  (compilado)
 *
 * O que faz:
 *  1. Constrói o AppConfig apontando pra data/ e logs/ relativos ao cwd.
 *  2. Define legacyAuthPath pra reaproveitar a sessão do bot velho
 *     (NÃO precisa re-escanear QR).
 *  3. Instancia MarcioApp e chama start().
 *  4. Captura SIGINT/SIGTERM pra desligar graciosamente.
 */

import path from 'node:path';
import { MarcioApp, type AppConfig } from './MarcioApp';

// Diretório raiz do projeto (onde tá package.json)
const rootDir = process.cwd();

// Configuração
const config: AppConfig = {
  rootDir,
  dataDir: path.join(rootDir, 'data'),
  logDir: path.join(rootDir, 'logs'),
  botName: 'Robô do PT 🤖',

  // REAPROVEITA a sessão do bot velho.
  // O bot velho (index.js) usava LocalAuth() sem dataPath, que cria
  // .wwebjs_auth/ no cwd dele. Se você rodar o marcio-app DE DENTRO da
  // pasta do bot velho (ou copiar .wwebjs_auth/ pra marcio-app/), a
  // sessão é reaproveitada — sem re-escanear QR.
  //
  // OPÇÃO A (recomendada): apontar pro .wwebjs_auth do bot velho.
  //   Descomente a linha abaixo e troque o caminho pro do seu PC:
  // legacyAuthPath: path.resolve('../marcio-bot-old/.wwebjs_auth'),
  //
  // OPÇÃO B: copiar .wwebjs_auth/ pra dentro do marcio-app/ e deixar
  //   o LocalAuth() usar o default. Não precisa setar legacyAuthPath.
  //
  // OPÇÃO C: primeira vez (sessão nova) — deixe undefined e escaneie o QR.
  // legacyAuthPath: undefined,
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
