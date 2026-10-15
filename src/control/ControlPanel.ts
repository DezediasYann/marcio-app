/**
 * ControlPanel — painel de controle web do Márcio (a "janela do servidor Minecraft").
 *
 * Subir um servidor HTTP + WebSocket na porta 3001 que:
 *  - Serve um dashboard HTML único (public/index.html) — sem build, vanilla JS.
 *  - Expõe uma REST API de leitura (stats, memórias, contexto, chats, profile,
 *    diretivas, system-prompt, logs) e escrita (system-prompt, debug, ia per-chat,
 *    injeção de comandos).
 *  - Mantém um WebSocket aberto pro dashboard: broadcast de logs em tempo real
 *    + snapshot inicial + execução de comandos vindos do console do dashboard.
 *
 * === ARQUITETURA ===
 *  - HTTP server nativo do Node (node:http) — sem Express.
 *  - WebSocket via `ws` (anexado ao mesmo server).
 *  - Injeção de comandos: monta uma "mensagem virtual" que parece um Message
 *    do whatsapp-web.js e chama direto o handler do CommandRegistry. O
 *    MessageRouter é DELIBERADAMENTE pulado — ele ignora msgs `fromMe`, e
 *    precisamos que o handler seja chamado com fromMe=true (pra ser tratado
 *    como OP pelo PermissionSystem.isOp).
 *
 * === DEPENDÊNCIAS (service locator) ===
 *  - this.app.startTime
 *  - this.app.brain            — aiRequestCount, lastUsedModel, aiDisabledChats,
 *                                chatEntrosaoLevel, getSystemPrompt, getAIConfig,
 *                                getAllFallbackModels
 *  - this.app.context          — activeChatIds, getRecent, count, historyLoadedCount
 *  - this.app.memory           — allUsers, forUser, load
 *  - this.app.profile          — get
 *  - this.app.directives       — all
 *  - this.app.stickers         — listNamed
 *  - this.app.debugEnabled / .debugFullEnabled
 *  - this.app.aiConfig         — { enabled, ... }
 *  - this.app.dataPath         — caminho pra data files
 *  - this.app.config.logDir    — diretório de logs (logs/bot.log)
 *  - this.app.whatsapp.client  — info.wid._serialized (PV do bot), getChatById, getContact
 *  - this.app.commands         — lookup, all
 *  - this.app.log / .debug     — logging
 *
 * === WIRING (a ser feito pelo agente principal) ===
 *  - Em MarcioApp.start(), depois do `await this.whatsapp.initialize()`:
 *      this.control = new ControlPanel(this);
 *      this.control.listen(3001);
 *  - Em shutdown():
 *      if (this.control) this.control.destroy();
 *  - Hook de log: o agente principal pode interceptar app.log() pra chamar
 *    this.control.broadcast('log', { tag, message, time }). Ou o dashboard
 *    faz polling de /api/logs — suporte a ambos.
 */

import type { MarcioApp } from '../MarcioApp';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { createZip, readZip } from './ZipBundle';

// ============================================================================
// TIPOS
// ============================================================================

interface StatsPayload {
  uptime: number;              // ms desde boot
  aiRequestCount: number;
  lastUsedModel: string | null;
  chatsWithContext: number;
  historyLoaded: number;
  memories: number;            // total de fatos em todos os usuários
  stickers: number;            // figurinhas nomeadas/favoritas
  directives: number;
  debug: 'on' | 'off' | 'full';
  debugFull: boolean;
  iaEnabled: boolean;          // app.aiConfig?.enabled
  aiConfig: {
    model: string;
    fallbackModels: string[];
  };
}

interface CommandResult {
  ok: boolean;
  result?: string;
  error?: string;
}

// ============================================================================
// HELPERS — funções puras (fora da classe)
// ============================================================================

/**
 * Extrai o conteúdo do primeiro campo de arquivo (filename=...) de um body
 * multipart/form-data. Implementação mínima — não usa lib externa.
 *
 * @param body Buffer completo do body da requisição.
 * @param contentType Header Content-Type (com boundary).
 * @returns Buffer com o conteúdo do arquivo, ou null se não encontrou.
 */
function extractMultipartFile(body: Buffer, contentType: string): Buffer | null {
  // Pega o boundary do header: multipart/form-data; boundary=----WebKitFormBoundaryXXX
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return null;
  const boundary = (m[1] || m[2] || '').trim();
  if (!boundary) return null;

  // O delimiter real é --<boundary>
  const delim = Buffer.from(`--${boundary}`);
  // Acha a primeira ocorrência do delim.
  const firstDelim = body.indexOf(delim);
  if (firstDelim === -1) return null;

  // Procura por \r\n\r\n (fim dos headers da parte) a partir do primeiro delim.
  // O conteúdo começa depois do \r\n\r\n.
  const headersEnd = body.indexOf('\r\n\r\n', firstDelim);
  if (headersEnd === -1) return null;
  const contentStart = headersEnd + 4;

  // O conteúdo termina no próximo \r\n--<boundary>.
  const endDelim = Buffer.from(`\r\n--${boundary}`);
  const contentEnd = body.indexOf(endDelim, contentStart);
  if (contentEnd === -1) {
    // Tenta sem o \r\n (última parte pode não ter)
    const altEnd = body.indexOf(delim, contentStart);
    if (altEnd === -1) return null;
    return body.subarray(contentStart, altEnd);
  }

  return body.subarray(contentStart, contentEnd);
}

// ============================================================================
// CONTROL PANEL
// ============================================================================

export class ControlPanel {
  private app: MarcioApp;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private publicDir: string;
  private logFilePath: string;
  private listenPort: number = 3001;

  /**
   * Flags de captura — quando um comando é injetado pelo painel, setamos
   * capturing=true e capturingChatId=PV do bot. Assim, MarcioApp.notify()
   * e WhatsAppClient.sendMessage() podem interceptar as respostas e
   * mandá-las pro painel (em vez de só pro WhatsApp).
   */
  capturing = false;
  capturingChatId: string | null = null;

  constructor(app: MarcioApp) {
    this.app = app;
    // Resolve o diretório public/ relativo a este arquivo (funciona tanto em
    // tsx quanto após tsc, porque rootDir="./src" mantém a estrutura).
    // O projeto é CommonJS (ver tsconfig), então __dirname está disponível.
    this.publicDir = path.join(__dirname, 'public');
    this.logFilePath = path.join(this.app.config.logDir, 'bot.log');
  }

  // ===========================================================================
  // LISTEN — sobe HTTP + WS na mesma porta
  // ===========================================================================

  /**
   * Inicia o servidor HTTP + WebSocket na porta informada.
   */
  listen(port: number): void {
    this.listenPort = port;
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));

    // WebSocket Server anexado ao mesmo HTTP server (upgrade automático).
    this.wss = new WebSocketServer({ server: this.httpServer });

    // Configura handlers do WS (extraído pra poder re-criar em caso de EADDRINUSE)
    this.setupWsHandlers();

    // ⚠️ CRÍTICO: registra o error handler ANTES de chamar listen().
    // Se registrar DEPOIS (como era antes), o erro EADDRINUSE dispara no próximo
    // tick ANTES do handler ser registrado, vira uncaughtException, e o bot crasha.
    this.httpServer.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        // Porta já em uso — provavelmente outra instância do bot ficou rodando.
        // Em vez de crashar o app (uncaughtException), tenta matar o processo
        // órfão e retentar uma vez.
        this.app.log('PANEL', `porta ${port} em uso — tentando matar processo órfão...`);
        this.killProcessOnPort(port).then((killed) => {
          if (killed) {
            this.app.log('PANEL', `processo órfão morto — tentando ouvir porta ${port} de novo...`);
            // Tenta de novo depois de 2s (dá tempo pro SO liberar a porta)
            setTimeout(() => {
              try {
                // Cria NOVO server (não reusa o que já falhou — ele fica marcado)
                this.httpServer = createServer((req, res) => this.handleHttp(req, res));
                this.wss = new WebSocketServer({ server: this.httpServer });
                this.setupWsHandlers();
                this.httpServer.on('error', (e2) => {
                  this.app.log('PANEL', `erro no servidor HTTP (retry): ${e2.message}`);
                });
                this.httpServer.listen(port, () => {
                  this.app.log('PANEL', `✅ Painel de controle ouvindo em http://localhost:${port} (após matar órfão)`);
                });
              } catch (e2) {
                this.app.errors.report('PANEL', `EADDRINUSE persistente em porta ${port}`, e2 as Error, {
                  userMessage: 'Já existe outro bot rodando. Feche todas as instâncias e tente de novo.',
                  severity: 'critical',
                });
                this.app.log('PANEL', `❌ Não conseguiu ouvir porta ${port} nem após matar órfão: ${(e2 as Error).message}`);
              }
            }, 2000);
          } else {
            this.app.errors.report('PANEL', `Porta ${port} em uso por outro processo que não foi possível matar`, e, {
              userMessage: 'Já existe outro bot rodando em http://localhost:3001. Feche ele e tente de novo.',
              severity: 'critical',
            });
            this.app.log('PANEL', `❌ Não conseguiu matar processo na porta ${port}. Outra instância do bot está rodando?`);
          }
        });
      } else {
        this.app.log('PANEL', `erro no servidor HTTP: ${e.message}`);
      }
    });

    this.httpServer.listen(port, () => {
      this.app.log('PANEL', `Painel de controle ouvindo em http://localhost:${port}`);
    });
  }

  /**
   * Configura os handlers do WebSocket server (extraído pra poder re-criar depois).
   */
  private setupWsHandlers(): void {
    if (!this.wss) return;
    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);
      this.app.debug('PANEL', `cliente WS conectado — total=${this.clients.size}`);

      // Envia snapshot imediato
      try {
        this.send(ws, 'snapshot', this.buildStats());
      } catch (e) {
        this.app.debug('PANEL', `erro ao enviar snapshot: ${(e as Error).message}`);
      }

      ws.on('message', (raw: Buffer) => {
        this.handleWsMessage(ws, raw).catch((e) => {
          this.app.debug('PANEL', `erro em WS message: ${(e as Error).message}`);
        });
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.app.debug('PANEL', `cliente WS desconectado — total=${this.clients.size}`);
      });

      ws.on('error', () => {
        // ignora — já tratado no close
      });
    });
  }

  /**
   * Mata o processo que tá ouvindo numa porta específica.
   * Em Windows: usa netstat + taskkill.
   * Em Linux/Mac: usa lsof + kill.
   * Retorna true se matou, false se não achou ou falhou.
   */
  private async killProcessOnPort(port: number): Promise<boolean> {
    const { execSync } = require('node:child_process');
    try {
      if (process.platform === 'win32') {
        // netstat -ano | findstr :3001
        // Linha: TCP    127.0.0.1:3001    0.0.0.0:0    LISTENING    12345
        const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', timeout: 5000 });
        const lines = out.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const pids = new Set<number>();
        for (const line of lines) {
          if (line.includes('LISTENING')) {
            const parts = line.split(/\s+/);
            const pid = parseInt(parts[parts.length - 1]);
            if (pid > 0 && pid !== process.pid) pids.add(pid);
          }
        }
        if (pids.size === 0) return false;
        this.app.debug('PANEL', `matando ${pids.size} processo(s) na porta ${port}: ${[...pids].join(', ')}`);
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 });
            this.app.debug('PANEL', `processo ${pid} morto`);
          } catch (e) {
            this.app.debug('PANEL', `falha ao matar PID ${pid}: ${(e as Error).message}`);
          }
        }
        return true;
      } else {
        // Linux/Mac: lsof -ti:3001
        try {
          const out = execSync(`lsof -ti:${port}`, { encoding: 'utf8', timeout: 5000 });
          const pids = out.split('\n').map(s => parseInt(s.trim())).filter(p => p > 0 && p !== process.pid);
          if (pids.length === 0) return false;
          for (const pid of pids) {
            try { execSync(`kill -9 ${pid}`, { timeout: 3000 }); } catch { /* ignora */ }
          }
          return true;
        } catch {
          return false; // lsof não achou
        }
      }
    } catch (e) {
      this.app.debug('PANEL', `killProcessOnPort erro: ${(e as Error).message}`);
      return false;
    }
  }

  // ===========================================================================
  // BROADCAST — envia pra todos os WS clients
  // ===========================================================================

  /**
   * Envia `{ type, data }` pra todos os clientes WebSocket conectados.
   * Usado pelo MarcioApp pra fazer push de logs em tempo real.
   */
  broadcast(type: string, data: any): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({ type, data });
    for (const ws of this.clients) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      } catch {
        // ignora — cliente morto será limpo no close
      }
    }
  }

  /**
   * Envia pra um cliente específico.
   */
  private send(ws: WebSocket, type: string, data: any): void {
    ws.send(JSON.stringify({ type, data }));
  }

  // ===========================================================================
  // DESTROY
  // ===========================================================================

  destroy(): void {
    try {
      // Fecha todos os WS clients
      for (const ws of this.clients) {
        try { ws.close(); } catch { /* ignora */ }
      }
      this.clients.clear();

      if (this.wss) {
        this.wss.close();
        this.wss = null;
      }
      if (this.httpServer) {
        this.httpServer.close();
        this.httpServer = null;
      }
      this.app.log('PANEL', 'Painel de controle fechado.');
    } catch (e) {
      this.app.log('PANEL', `erro ao fechar painel: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // HTTP DISPATCH
  // ===========================================================================

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || '/', `http://localhost`);
      const pathname = url.pathname;
      const method = (req.method || 'GET').toUpperCase();

      // CORS liberal — painel roda local, mas deixa aberto pra dev tools
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // --- Roteamento ---
      // GET /
      if (method === 'GET' && pathname === '/') {
        return this.serveIndex(res);
      }

      // GET /favicon.ico — favicon inline (data URI) pra evitar 404
      if (method === 'GET' && (pathname === '/favicon.ico' || pathname === '/favicon.png')) {
        const ico = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAhGVYSWZNTQAqAAAACAAFARIAAwAAAAEAAQAAARoABQAAAAEAAABKARsABQAAAAEAAABSASgAAwAAAAEAAgAAh2kABAAAAAEAAABaAAAAAAAAAEgAAAABAAAASAAAAAEAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAEKADAAQAAAABAAAAEAAAAAAoD2dXAAAACXBIWXMAABYlAAAWJQFJUiTwAAABWWlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOkRFQjUxMzIyMEM5RTlEMTFCRUZBOTlDQ0I1QzY4MzQwIiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOkRFQjUxMzIzMEM5RTlEMTFCRUZBOTlDQ0I1QzY4MzQwIj4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6REVCNTEzMjAwQzlFOUQxMUJFRkE5OUNDQjVDNjgzNDAiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6REVCNTEzMjEwQzlFOUQxMUJFRkE5OUNDQjVDNjgzNDAiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InciPz4dIrJsAAAAFklEQVQ4y2Nk+M9gZmBgYGD4zwB5TwCX8wIAE8MC1s3wfWgAAAAASUVORK5CYII=', 'base64');
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=86400',
          'Content-Length': ico.length,
        });
        res.end(ico);
        return;
      }

      // GET /setup-wizard.html — wizard de primeira execução (janela sem barra)
      // Em produção, o lib.rs abre essa página em vez do index.html na primeira vez.
      // Em dev, o usuário acessa http://localhost:3001/setup-wizard.html pra testar.
      if (method === 'GET' && pathname === '/setup-wizard.html') {
        return this.serveSetupWizard(res);
      }

      // ======================================================================
      // SETUP WIZARD — estado do primeiro boot (data/setup-state.json)
      // ======================================================================

      // POST /api/setup/complete — marca setup como completo
      // Body: { botName?: string, systemPrompt?: string, aiConfig?: {...} }
      // Salva tudo (delega pros sistemas correspondentes) e marca setup-state.json.
      //
      // ⚠️ MODO DEV (porta 3001 aberta = beforeDevCommand rodando):
      // NÃO SALVA NADA. Retorna erro 403 explicando. Isso evita que o usuário
      // testando o wizard em dev sobrescreva dados reais (api-config.json,
      // system-prompt.txt, etc.).
      if (method === 'POST' && pathname === '/api/setup/complete') {
        // Detecta dev: se a porta 3001 já estava aberta antes do Tauri iniciar,
        // é porque o `npm run dev` (beforeDevCommand) está rodando o bot.
        // Em produção, o Tauri spawna o bot depois — porta 3001 só abre depois.
        const isDevMode = process.env.NODE_ENV !== 'production';
        if (isDevMode) {
          return this.json(res, {
            ok: false,
            error: 'modo dev detectado — setup/complete bloqueado pra não sobrescrever seus dados. Use o wizard em produção (após compilar com npm run tauri:build). Em dev, o wizard é só preview visual.',
            devMode: true,
          }, 403);
        }

        const body = await this.readJsonBody(req);
        try {
          // 1. Salva botName (se veio) — atualiza config do bot em runtime
          if (typeof body?.botName === 'string' && body.botName.trim()) {
            const newBotName = body.botName.trim();
            (this.app.config as any).botName = newBotName;
            this.app.log('SETUP', `botName configurado: ${newBotName}`);
          }

          // 2. Salva system-prompt.txt (se veio)
          if (typeof body?.systemPrompt === 'string') {
            try {
              fs.writeFileSync(this.app.dataPath('system-prompt.txt'), body.systemPrompt, 'utf8');
              this.app.log('SETUP', 'system-prompt.txt salvo');
              this.app.brain.aiConfigCacheTime = 0;
            } catch (e) {
              this.app.debug('SETUP', `erro ao salvar system-prompt: ${(e as Error).message}`);
            }
          }

          // 3. Salva ai-config.json (se veio) — merge com existente
          if (body?.aiConfig && typeof body.aiConfig === 'object') {
            try {
              const filePath = this.app.dataPath('ai-config.json');
              let existing: any = {};
              try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
              const next = { ...existing, ...body.aiConfig };
              fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
              this.app.brain.aiConfigCacheTime = 0;
              if (this.app.audioTranscriber) this.app.audioTranscriber.invalidateConfigCache();
              this.app.log('SETUP', `ai-config.json salvo — model=${next.model} apiKey=${next.apiKey ? '(set)' : '(vazio)'}`);
            } catch (e) {
              this.app.debug('SETUP', `erro ao salvar ai-config: ${(e as Error).message}`);
            }
          }

          // 4. Marca setup como completo
          this.writeSetupState({ completed: true, completedAt: new Date().toISOString() });

          // 5. Notifica o Tauri (se estiver rodando) pra fechar a janela de setup
          // e abrir a janela principal.
          this.app.control?.broadcast('setup-complete', { completed: true });

          return this.json(res, { ok: true, message: 'setup completo' });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/setup/reset — marca setup como NÃO completo (pra testar wizard de novo).
      // ⚠️ SÓ FUNCIONA EM PRODUÇÃO com body.force === true.
      // Em dev, retorna 403 (setup-state não deve ser mexido em dev — wizard é só preview).
      if (method === 'POST' && pathname === '/api/setup/reset') {
        const body = await this.readJsonBody(req).catch(() => ({}));
        const isProd = process.env.NODE_ENV === 'production';
        const force = body?.force === true;
        if (!isProd) {
          return this.json(res, {
            ok: false,
            error: 'modo dev — setup/reset bloqueado. Em dev, o wizard é só preview (não cria setup-state.json). Pra resetar em produção, envie { force: true }.',
            devMode: true,
          }, 403);
        }
        if (!force) {
          return this.json(res, { ok: false, error: 'em produção, envie { force: true } pra resetar setup' }, 403);
        }
        try {
          this.writeSetupState({ completed: false });
          this.app.log('SETUP', 'setup resetado — wizard vai abrir na próxima vez');
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // GET /chart.min.js, /js/*, /css/* — static files do publicDir
      // (Chart.js local, evita CDN bloqueado por Tracking Prevention do Edge)
      if (method === 'GET' && (pathname === '/chart.min.js' || pathname.startsWith('/js/') || pathname.startsWith('/css/'))) {
        return this.serveStaticFile(pathname, res);
      }

      // ======================================================================
      // CHANGELOG — "O que há de novo?"
      // ======================================================================

      // GET /api/changelog — retorna o changelog completo (de data/changelog.json)
      // + info de qual versão o usuário já viu (de changelog-state.json)
      if (method === 'GET' && pathname === '/api/changelog') {
        try {
          const changelog = this.readChangelog();
          const seenVersion = this.readChangelogState().lastSeenVersion;
          // Versão atual do app (do package.json lido uma vez)
          const currentVersion = this.getCurrentVersion();
          // hasNew = a versão ATUAL do app é mais nova que a última vista.
          // Isso garante que ao ATUALIZAR o app (versão muda), o changelog aparece
          // mesmo que o usuário tenha dismissado uma versão anterior.
          // Ex: usuário na v1.0.1 viu e dismissou (lastSeen=1.0.1).
          //     Atualiza pra v1.0.2 → currentVersion(1.0.2) > seenVersion(1.0.1) → hasNew=true ✅
          const hasNew = this.compareVersions(currentVersion, seenVersion) > 0;
          return this.json(res, {
            currentVersion,
            lastSeenVersion: seenVersion,
            hasNew,
            releases: changelog.releases,
          });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/changelog/dismiss — marca versão como vista (não mostra de novo)
      // Body: { version?: string } — se não vier, usa a versão atual do app
      if (method === 'POST' && pathname === '/api/changelog/dismiss') {
        const body = await this.readJsonBody(req).catch(() => ({}));
        try {
          const version = (body?.version as string) || this.getCurrentVersion();
          this.writeChangelogState({ lastSeenVersion: version, dismissedAt: new Date().toISOString() });
          this.app.log('CHANGELOG', `versão ${version} marcada como vista`);
          return this.json(res, { ok: true, lastSeenVersion: version });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // GET /api/stats
      if (method === 'GET' && pathname === '/api/stats') {
        return this.json(res, this.buildStats());
      }

      // GET /api/stats/history — dados pra gráficos (últimas 24h, 1 ponto/min)
      if (method === 'GET' && pathname === '/api/stats/history') {
        return this.json(res, { history: this.app.statsHistory });
      }

      // GET /api/memories
      if (method === 'GET' && pathname === '/api/memories') {
        return this.json(res, this.buildMemories());
      }

      // GET /api/chats
      if (method === 'GET' && pathname === '/api/chats') {
        const chats = await this.buildChatsList();
        return this.json(res, { chats });
      }

      // GET /api/directives
      if (method === 'GET' && pathname === '/api/directives') {
        return this.json(res, this.app.directives.all());
      }

      // GET /api/system-prompt
      if (method === 'GET' && pathname === '/api/system-prompt') {
        return this.json(res, { content: this.app.brain.getSystemPrompt() });
      }

      // GET /api/logs
      if (method === 'GET' && pathname === '/api/logs') {
        return this.json(res, { lines: this.readLastLogLines(100) });
      }

      // GET /api/errors — lista erros capturados pelo ErrorTracker
      // Retorna: { errors: TrackedError[], summary: HealthSummary }
      if (method === 'GET' && pathname === '/api/errors') {
        return this.json(res, {
          errors: this.app.errors.list(),
          summary: this.app.errors.healthSummary(),
        });
      }

      // DELETE /api/errors — limpa todos os erros
      if (method === 'DELETE' && pathname === '/api/errors') {
        this.app.errors.clear();
        return this.json(res, { ok: true });
      }

      // GET /api/errors/export — retorna erros em texto formatado (pra copiar)
      if (method === 'GET' && pathname === '/api/errors/export') {
        const text = this.app.errors.toText();
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="marcio-errors-${new Date().toISOString().slice(0, 19)}.txt"`,
          'Cache-Control': 'no-store',
        });
        res.end(text);
        return;
      }

      // GET /api/health — status de saúde do app (WA conectado, IA online, etc.)
      if (method === 'GET' && pathname === '/api/health') {
        return this.json(res, this.getHealthStatus());
      }

      // GET /api/feature-flags — retorna canal atual + features habilitadas
      // O painel usa pra mascarar botões que não devem aparecer em release estável.
      if (method === 'GET' && pathname === '/api/feature-flags') {
        return this.json(res, this.app.features.getConfig());
      }

      // GET /api/update-settings — retorna config de update (aceitar beta, etc.)
      if (method === 'GET' && pathname === '/api/update-settings') {
        return this.json(res, this.readUpdateSettings());
      }

      // POST /api/update-settings — salva config de update
      // Body: { acceptBeta?: boolean }
      if (method === 'POST' && pathname === '/api/update-settings') {
        const body = await this.readJsonBody(req).catch(() => ({}));
        try {
          const current = this.readUpdateSettings();
          if (typeof body?.acceptBeta === 'boolean') {
            current.acceptBeta = body.acceptBeta;
          }
          this.writeUpdateSettings(current);
          this.app.log('UPDATE', `update-settings salvo — acceptBeta=${current.acceptBeta}`);
          return this.json(res, { ok: true, ...current });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // GET /api/bot-profile — retorna perfil do bot (identidade evolutiva)
      if (method === 'GET' && pathname === '/api/bot-profile') {
        try {
          const profile = this.app.botProfile?.get();
          if (!profile) return this.json(res, { error: 'BotProfile não inicializado' }, 500);
          return this.json(res, profile);
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/bot-profile — atualiza perfil do bot (editável pelo painel)
      // Body: { aiSummary?, aiShortView?, convictions?, traits?, likes?, dislikes?, rawNotes? }
      if (method === 'POST' && pathname === '/api/bot-profile') {
        const body = await this.readJsonBody(req).catch(() => ({}));
        try {
          const current = this.app.botProfile.get();
          // Merge campos (não substitui tudo — só o que veio)
          if (typeof body?.aiSummary === 'string') current.aiSummary = body.aiSummary;
          if (typeof body?.aiShortView === 'string') current.aiShortView = body.aiShortView;
          if (body?.convictions && typeof body.convictions === 'object') {
            // Se é um objeto vazio, limpa tudo. Senão, merge.
            if (Object.keys(body.convictions).length === 0) {
              current.convictions = {};
            } else {
              current.convictions = { ...current.convictions, ...body.convictions };
            }
          }
          if (body?.traits && typeof body.traits === 'object') {
            if (Object.keys(body.traits).length === 0) {
              current.traits = {};
            } else {
              current.traits = { ...current.traits, ...body.traits };
            }
          }
          if (Array.isArray(body?.likes)) current.likes = body.likes;
          if (Array.isArray(body?.dislikes)) current.dislikes = body.dislikes;
          if (typeof body?.rawNotes === 'string') current.rawNotes = body.rawNotes;
          this.app.botProfile.update(current);
          this.app.log('PANEL', 'BotProfile atualizado via painel');
          return this.json(res, { ok: true, profile: current });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/bot-profile/:field/:key — remove um item específico
      // Ex: DELETE /api/bot-profile/convictions/politica
      if (method === 'DELETE' && pathname.startsWith('/api/bot-profile/')) {
        try {
          const parts = pathname.slice('/api/bot-profile/'.length).split('/');
          const field = parts[0]; // convictions, traits, likes, dislikes
          const key = parts[1] ? decodeURIComponent(parts[1]) : '';
          const profile = this.app.botProfile.get();
          if (field === 'convictions' && key) {
            delete profile.convictions[key];
          } else if (field === 'traits' && key) {
            delete profile.traits[key];
          } else if (field === 'likes' && key) {
            profile.likes = profile.likes.filter(l => l !== key);
          } else if (field === 'dislikes' && key) {
            profile.dislikes = profile.dislikes.filter(d => d !== key);
          }
          this.app.botProfile.update(profile);
          this.app.log('PANEL', `BotProfile: removido ${field}/${key}`);
          return this.json(res, { ok: true, profile });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/bot-profile/reflect — força auto-reflexão imediata
      if (method === 'POST' && pathname === '/api/bot-profile/reflect') {
        try {
          const body = await this.readJsonBody(req).catch(() => ({}));
          const chatId = body?.chatId || '';
          this.app.log('PANEL', 'Forçando auto-reflexão do BotProfile...');
          // registerInteraction com threshold 1 pra forçar
          const profile = this.app.botProfile.get();
          profile.interactionCountSinceUpdate = 29; // próximo do threshold
          this.app.botProfile.update(profile);
          await this.app.botProfile.registerInteraction(chatId);
          return this.json(res, { ok: true, profile: this.app.botProfile.get() });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/bot-profile/converse — "Converse com o Pensamento"
      // Body: { message: string }
      // Retorna: { ok, response, profile }
      if (method === 'POST' && pathname === '/api/bot-profile/converse') {
        try {
          const body = await this.readJsonBody(req).catch(() => ({}));
          const message = String(body?.message || '').trim();
          if (!message) {
            return this.json(res, { ok: false, error: 'mensagem vazia' }, 400);
          }
          this.app.log('PANEL', `💬 converse: ${message.slice(0, 60)}${message.length > 60 ? '…' : ''}`);
          const result = await this.app.botProfile.converse(message);
          if (result.error) {
            return this.json(res, { ok: false, error: result.error, response: result.response });
          }
          return this.json(res, { ok: true, response: result.response, profile: this.app.botProfile.get() });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/bot-profile/injections — limpa TODAS as injeções
      if (method === 'DELETE' && pathname === '/api/bot-profile/injections') {
        try {
          this.app.botProfile.clearInjections();
          return this.json(res, { ok: true, profile: this.app.botProfile.get() });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/bot-profile/injections/:index — remove uma injeção específica
      if (method === 'DELETE' && pathname.startsWith('/api/bot-profile/injections/')) {
        try {
          const idxStr = pathname.slice('/api/bot-profile/injections/'.length).split('/')[0];
          const index = parseInt(idxStr, 10);
          if (isNaN(index)) {
            return this.json(res, { ok: false, error: 'índice inválido' }, 400);
          }
          const removed = this.app.botProfile.removeInjection(index);
          if (!removed) {
            return this.json(res, { ok: false, error: 'injeção não encontrada' }, 404);
          }
          return this.json(res, { ok: true, profile: this.app.botProfile.get() });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // GET /api/lastfm-config — retorna config do Last.fm
      if (method === 'GET' && pathname === '/api/lastfm-config') {
        try {
          const filePath = this.app.dataPath('lastfm-config.json');
          const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{}';
          const parsed = JSON.parse(content);
          return this.json(res, { apiKey: parsed.apiKey || '' });
        } catch {
          return this.json(res, { apiKey: '' });
        }
      }

      // POST /api/lastfm-config — salva config do Last.fm
      if (method === 'POST' && pathname === '/api/lastfm-config') {
        const body = await this.readJsonBody(req).catch(() => ({}));
        try {
          const config = { apiKey: String(body?.apiKey || '') };
          fs.writeFileSync(this.app.dataPath('lastfm-config.json'), JSON.stringify(config, null, 2), 'utf8');
          this.app.log('LASTFM', `API key salva (${config.apiKey ? 'configurada' : 'vazia'})`);
          if (this.app.lastCollage) this.app.lastCollage.invalidateConfigCache();
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/dev/secret-action — executa ação secreta (só em dev/beta)
      // Body: { action: 'force-error' | 'force-ia-offline' | 'clear-memories' | ... }
      // Em stable: retorna 403 (menu secreto não existe).
      if (method === 'POST' && pathname === '/api/dev/secret-action') {
        if (this.app.features.getChannel() === 'stable') {
          return this.json(res, { ok: false, error: 'Menu secreto desativado em stable' }, 403);
        }
        const body = await this.readJsonBody(req);
        const action = String(body?.action || '');
        return this.json(res, await this.executeSecretAction(action, body));
      }

      // GET /api/context/:chatId  (chatId é URL-encoded)
      if (method === 'GET' && pathname.startsWith('/api/context/')) {
        const chatId = decodeURIComponent(pathname.slice('/api/context/'.length));
        return this.json(res, this.app.context.getRecent(chatId));
      }

      // GET /api/profile/:chatId
      if (method === 'GET' && pathname.startsWith('/api/profile/')) {
        const chatId = decodeURIComponent(pathname.slice('/api/profile/'.length));
        return this.json(res, this.app.profile.get(chatId));
      }

      // POST /api/system-prompt
      if (method === 'POST' && pathname === '/api/system-prompt') {
        const body = await this.readJsonBody(req);
        if (typeof body?.content !== 'string') {
          return this.json(res, { ok: false, error: 'content ausente' }, 400);
        }
        try {
          fs.writeFileSync(this.app.dataPath('system-prompt.txt'), body.content, 'utf8');
          // Hot-reload no Brain tem TTL 5s — Painel só escreve; Brain re-lê sozinho.
          this.app.log('PANEL', 'system-prompt.txt atualizado via painel — hot-reload em até 5s.');
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/debug  { mode: 'on' | 'off' | 'full' }
      if (method === 'POST' && pathname === '/api/debug') {
        const body = await this.readJsonBody(req);
        const mode = String(body?.mode || '').toLowerCase();
        if (mode === 'on') {
          this.app.debugEnabled = true;
          this.app.debugFullEnabled = false;
        } else if (mode === 'off') {
          this.app.debugEnabled = false;
          this.app.debugFullEnabled = false;
        } else if (mode === 'full') {
          this.app.debugEnabled = true;
          this.app.debugFullEnabled = true;
        } else {
          return this.json(res, { ok: false, error: 'mode deve ser on|off|full' }, 400);
        }
        this.app.log('PANEL', `debug alterado via painel — enabled=${this.app.debugEnabled} full=${this.app.debugFullEnabled}`);
        return this.json(res, { ok: true });
      }

      // POST /api/ia/:chatId  { enabled: boolean }
      if (method === 'POST' && pathname.startsWith('/api/ia/')) {
        const chatId = decodeURIComponent(pathname.slice('/api/ia/'.length));
        const body = await this.readJsonBody(req);
        const enabled = !!body?.enabled;
        this.app.chatSettings.setAiEnabled(chatId, enabled);  // persiste + sync brain
        this.app.log('PANEL', `IA ${enabled ? 'reativada' : 'desativada'} via painel — chat=${chatId}`);
        return this.json(res, { ok: true });
      }

      // POST /api/chat-settings/:chatId  { entrosao?: number, muted?: boolean, aiEnabled?: boolean }
      if (method === 'POST' && pathname.startsWith('/api/chat-settings/')) {
        const chatId = decodeURIComponent(pathname.slice('/api/chat-settings/'.length));
        const body = await this.readJsonBody(req);
        if (typeof body.entrosao === 'number') {
          this.app.chatSettings.setEntrosao(chatId, body.entrosao);
        }
        if (typeof body.muted === 'boolean') {
          this.app.chatSettings.setMuted(chatId, body.muted);
        }
        if (typeof body.aiEnabled === 'boolean') {
          this.app.chatSettings.setAiEnabled(chatId, body.aiEnabled);
        }
        return this.json(res, { ok: true, settings: this.app.chatSettings.get(chatId) });
      }

      // GET /api/maintenance — status do modo manutenção
      if (method === 'GET' && pathname === '/api/maintenance') {
        return this.json(res, { enabled: this.app.maintenanceMode });
      }

      // POST /api/maintenance { enabled }
      if (method === 'POST' && pathname === '/api/maintenance') {
        const body = await this.readJsonBody(req);
        this.app.maintenanceMode = !!body?.enabled;
        this.app.log('PANEL', `modo manutenção ${this.app.maintenanceMode ? 'ativado' : 'desativado'} via painel`);
        return this.json(res, { ok: true, enabled: this.app.maintenanceMode });
      }

      // POST /api/command  { text: string }
      if (method === 'POST' && pathname === '/api/command') {
        const body = await this.readJsonBody(req);
        if (typeof body?.text !== 'string') {
          return this.json(res, { ok: false, error: 'text ausente' }, 400);
        }
        const result = await this.injectCommand(body.text);
        return this.json(res, result);
      }

      // ======================================================================
      // BOT LIFECYCLE  (POST /api/bot/...)
      // ======================================================================

      // GET /api/bot/status
      if (method === 'GET' && pathname === '/api/bot/status') {
        return this.json(res, this.buildBotStatus());
      }

      // GET /api/qr
      if (method === 'GET' && pathname === '/api/qr') {
        const qr = this.app.whatsapp?.lastQr ?? null;
        return this.json(res, { qr });
      }

      // GET /api/bot-config — retorna nome do bot + aliases
      if (method === 'GET' && pathname === '/api/bot-config') {
        try {
          const cfg = this.app.brain.getBotConfig();
          return this.json(res, cfg);
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/bot-config — salva nome do bot + aliases
      // Body: { botName: string, aliases: string[] }
      if (method === 'POST' && pathname === '/api/bot-config') {
        const body = await this.readJsonBody(req);
        try {
          const botName = typeof body?.botName === 'string' ? body.botName.trim() : '';
          const aliases = Array.isArray(body?.aliases) ? body.aliases : [];
          this.app.brain.saveBotConfig(botName, aliases);
          return this.json(res, { ok: true, botName: this.app.config.botName, aliases: Array.from(this.app.brain.botAliases) });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // GET /api/bot/avatar — retorna URL da foto de perfil do bot no WhatsApp
      if (method === 'GET' && pathname === '/api/bot/avatar') {
        try {
          const client = this.app.whatsapp?.client;
          if (!client || !client.info?.wid?._serialized) {
            return this.json(res, { url: null, error: 'WhatsApp não conectado' });
          }
          const myId = client.info.wid._serialized;
          const contact = await client.getContactById(myId);
          const url = await contact.getProfilePicUrl();
          return this.json(res, { url, id: myId });
        } catch (e) {
          return this.json(res, { url: null, error: (e as Error).message });
        }
      }

      // POST /api/bot/stop
      if (method === 'POST' && pathname === '/api/bot/stop') {
        try {
          await this.app.stopBot();
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/bot/start
      if (method === 'POST' && pathname === '/api/bot/start') {
        try {
          await this.app.startBot();
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/bot/restart
      if (method === 'POST' && pathname === '/api/bot/restart') {
        try {
          // Não await — restart demora (stop+2s+start). Responde ok e roda em background.
          this.app.restartBot().catch(e => {
            this.app.log('PANEL', `erro em restartBot: ${(e as Error).message}`);
          });
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/bot/reconnect  (destroy + kill + recreate client + initialize)
      if (method === 'POST' && pathname === '/api/bot/reconnect') {
        try {
          const wa = this.app.whatsapp;
          if (!wa) return this.json(res, { ok: false, error: 'WhatsApp client indisponível' }, 500);
          (async () => {
            try {
              this.app.log('PANEL', 'reconnect: destruindo client...');
              await wa.client.destroy();
            } catch (e) {
              this.app.debug('PANEL', `reconnect: destroy falhou: ${(e as Error).message}`);
            }
            await killLeftoverChromium(this.app);
            // Cria um Client NOVO (não dá pra reusar o mesmo após destroy)
            this.app.log('PANEL', 'reconnect: recriando client...');
            wa.createClient();
            try {
              this.app.log('PANEL', 'reconnect: inicializando...');
              await wa.initialize();
              this.app.log('PANEL', 'reconnect: client re-inicializado');
            } catch (e) {
              this.app.log('PANEL', `erro em reconnect: ${(e as Error).message}`);
            }
          })();
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/bot/logout  (kill + deleta auth + recreate + initialize)
      if (method === 'POST' && pathname === '/api/bot/logout') {
        try {
          const wa = this.app.whatsapp;
          const authPath = this.app.config.legacyAuthPath
            || path.join(this.app.config.rootDir, '.wwebjs_auth');
          this.app.log('PANEL', `logout: iniciando...`);

          // 1. Destroy o client
          if (wa) {
            try {
              this.app.log('PANEL', 'logout: destruindo client...');
              await wa.client.destroy();
            } catch (e) {
              this.app.debug('PANEL', `logout: destroy falhou: ${(e as Error).message}`);
            }
          }

          // 1.5. Espera 3s pra Chromium liberar os arquivos (.db, .db-journal)
          // O EBUSY acontece porque o Chromium mantém arquivos SQLite abertos
          // mesmo depois de destroy(). Damos tempo pra ele fechar tudo.
          this.app.log('PANEL', 'logout: esperando 3s pro Chromium liberar arquivos...');
          await new Promise(r => setTimeout(r, 3000));

          // 2. Mata processos órfãos + remove locks
          await killLeftoverChromium(this.app);

          // Espera mais 2s depois de matar (pra SO liberar handles)
          await new Promise(r => setTimeout(r, 2000));

          // 3. Remove o diretório de auth
          this.app.log('PANEL', `logout: removendo auth em ${authPath}`);
          let removed = false;
          for (let i = 0; i < 5; i++) {
            try {
              fs.rmSync(authPath, { recursive: true, force: true });
              this.app.log('PANEL', 'logout: auth removido ✓');
              removed = true;
              break;
            } catch (e) {
              const msg = (e as Error).message;
              this.app.debug('PANEL', `logout: tentativa ${i+1} falhou: ${msg}`);
              // Se for EBUSY, tenta matar de novo os processos que tão segurando
              if (msg.includes('EBUSY') || msg.includes('resource busy')) {
                this.app.debug('PANEL', `logout: EBUSY — matando processos Chromium de novo...`);
                await killLeftoverChromium(this.app);
              }
              await new Promise(r => setTimeout(r, 2000));
            }
          }
          if (!removed) {
            this.app.log('PANEL', `logout: ⚠️ não conseguiu remover auth dir depois de 5 tentativas — pode ter arquivo travado`);
          }

          // 4. Cria Client NOVO e inicializa
          if (wa) {
            (async () => {
              try {
                this.app.log('PANEL', 'logout: recriando client...');
                wa.createClient();
                this.app.log('PANEL', 'logout: inicializando...');
                await wa.initialize();
                this.app.log('PANEL', 'logout: client re-inicializado — novo QR deve aparecer');
              } catch (e) {
                this.app.log('PANEL', `logout: erro ao re-inicializar: ${(e as Error).message}`);
              }
            })();
          }
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // MEMORIES CRUD  (POST /api/memories/:user, DELETE .../:user/:index,
      //                 GET /api/memories/export)
      // ======================================================================

      // GET /api/memories/export  (download JSON)
      // Importante: checar ANTES de /api/memories/:user (não conflita em METHOD,
      // mas mantém ordem clara).
      if (method === 'GET' && pathname === '/api/memories/export') {
        const data = this.app.memory.load();
        const body = JSON.stringify(data, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="memories.json"',
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }

      // POST /api/memories/import  (upload JSON — substitui todas as memórias)
      // Aceita:
      //  - application/json direto: body = { "userName": [ {fact, sourceChat, timestamp}, ... ] }
      //  - multipart/form-data com campo "file" contendo o JSON acima
      //  - JSON com envelope { files: { "memories.json": base64 } } (vindo do /api/backup)
      // Em todos os casos, extrai o objeto de memórias e chama memory.replace().
      if (method === 'POST' && pathname === '/api/memories/import') {
        try {
          const parsed = await this.readRestoreBody(req);
          if (!parsed || typeof parsed !== 'object') {
            return this.json(res, { ok: false, error: 'JSON inválido' }, 400);
          }
          // Caso 1: envelope de backup { files: { "memories.json": base64, ... } }
          let memData: unknown = parsed;
          if (parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
            const files = parsed.files as Record<string, string>;
            // Procura memories.json (case-insensitive) no envelope
            const memKey = Object.keys(files).find(k => k.toLowerCase() === 'memories.json');
            if (!memKey) {
              return this.json(res, { ok: false, error: 'backup não contém memories.json' }, 400);
            }
            try {
              const b64 = files[memKey];
              memData = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
            } catch (e) {
              return this.json(res, { ok: false, error: `memories.json corrompido no backup: ${(e as Error).message}` }, 400);
            }
          }
          // Chama memory.replace() com validação rigorosa
          let stats: { users: number; facts: number };
          try {
            stats = this.app.memory.replace(memData);
          } catch (e) {
            return this.json(res, { ok: false, error: (e as Error).message }, 400);
          }
          this.app.log('PANEL', `memórias importadas via painel — ${stats.users} usuário(s), ${stats.facts} fato(s)`);
          return this.json(res, { ok: true, ...stats });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/memories/:user  { fact: string } (UI legada envia { text })
      if (method === 'POST' && pathname.startsWith('/api/memories/')) {
        const user = decodeURIComponent(pathname.slice('/api/memories/'.length));
        if (!user) return this.json(res, { ok: false, error: 'user ausente' }, 400);
        const body = await this.readJsonBody(req);
        // Aceita fact ou text (UI do F6a-1 envia text).
        const fact = String(body?.fact ?? body?.text ?? '').trim();
        if (!fact) return this.json(res, { ok: false, error: 'fact ausente' }, 400);
        try {
          this.app.memory.add('panel', user, fact);
          this.app.memory.save();  // salva síncrono
          this.app.log('PANEL', `memória adicionada via painel — user=${user} fact="${fact.slice(0, 60)}"`);
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/memories/:user/:index
      if (method === 'DELETE' && pathname.startsWith('/api/memories/')) {
        const rest = pathname.slice('/api/memories/'.length);
        const slashIdx = rest.lastIndexOf('/');
        if (slashIdx === -1) {
          return this.json(res, { ok: false, error: 'formato esperado: /api/memories/:user/:index' }, 400);
        }
        const user = decodeURIComponent(rest.slice(0, slashIdx));
        const indexStr = rest.slice(slashIdx + 1);
        const index = parseInt(indexStr, 10);
        if (isNaN(index)) {
          return this.json(res, { ok: false, error: 'index inválido' }, 400);
        }
        try {
          const memories = this.app.memory.load();
          const facts = memories[user] || [];
          if (index < 0 || index >= facts.length) {
            return this.json(res, { ok: false, error: 'index fora do intervalo' }, 400);
          }
          facts.splice(index, 1);
          if (facts.length === 0) {
            delete memories[user];
          }
          this.app.memory.save();
          this.app.log('PANEL', `memória removida via painel — user=${user} index=${index}`);
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // PROFILEBOOK (perfis IA — pessoas + grupos)
      // ======================================================================

      // GET /api/profiles — lista todos os perfis
      if (method === 'GET' && pathname === '/api/profiles') {
        const profiles = this.app.profileBook.all();
        return this.json(res, { profiles });
      }

      // GET /api/profiles/:id — um perfil
      if (method === 'GET' && pathname.startsWith('/api/profiles/') && !pathname.includes('/refresh')) {
        const id = decodeURIComponent(pathname.slice('/api/profiles/'.length));
        const profile = this.app.profileBook.get(id);
        if (!profile) return this.json(res, { error: 'perfil não encontrado' }, 404);
        return this.json(res, { profile });
      }

      // POST /api/profiles — cria novo perfil manualmente
      if (method === 'POST' && pathname === '/api/profiles') {
        try {
          const body = await this.readJsonBody(req);
          const { id, type, name, traits, aiSummary, rawNotes } = body || {};
          if (!id || !name) return this.json(res, { ok: false, error: 'id e name obrigatórios' }, 400);
          const profile = this.app.profileBook.create(
            String(id),
            (type === 'group' ? 'group' : 'person'),
            String(name),
            traits,
            aiSummary,
            rawNotes,
          );
          return this.json(res, { ok: true, profile });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/profiles/migrate — migra memories.json antigo
      if (method === 'POST' && pathname === '/api/profiles/migrate') {
        try {
          const result = await this.app.profileBook.migrateFromOldMemories();
          return this.json(res, { ok: true, ...result });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/profiles/mine — minera decision-log + history-log pra criar perfis
      if (method === 'POST' && pathname === '/api/profiles/mine') {
        try {
          this.app.log('PANEL', 'mineração de perfis disparada via painel');
          // Roda em background — responde imediatamente
          this.app.profileBook.mineFromDecisionLog().catch(e => {
            this.app.debug('PANEL', `mineração falhou: ${(e as Error).message}`);
          });
          return this.json(res, { ok: true, message: 'mineração iniciada em background — aguarde ~30s e recarregue' });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/profiles/link — linka dois IDs manualmente (alias)
      // Body: { canonicalId, aliasId, reason? }
      if (method === 'POST' && pathname === '/api/profiles/link') {
        try {
          const body = await this.readJsonBody(req);
          const { canonicalId, aliasId, reason } = body || {};
          if (!canonicalId || !aliasId) {
            return this.json(res, { ok: false, error: 'canonicalId e aliasId obrigatórios' }, 400);
          }
          const ok = this.app.profileBook.linkIds(
            String(canonicalId),
            String(aliasId),
            reason ? String(reason) : 'manual link via painel',
          );
          return this.json(res, { ok, profile: this.app.profileBook.get(String(canonicalId)) });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/profiles/resolve — resolve nome → perfis (pra debug/testar)
      // Body: { name }
      if (method === 'POST' && pathname === '/api/profiles/resolve') {
        try {
          const body = await this.readJsonBody(req);
          const name = String(body?.name || '').trim();
          if (!name) return this.json(res, { ok: false, error: 'name obrigatório' }, 400);
          const matches = this.app.profileBook.resolveByName(name);
          return this.json(res, { ok: true, matches: matches.map(m => ({ profile: m.profile, confidence: m.confidence })) });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/profiles/:id/refresh — força atualização IA
      if (method === 'POST' && pathname.endsWith('/refresh') && pathname.startsWith('/api/profiles/')) {
        const id = decodeURIComponent(pathname.slice('/api/profiles/'.length, -'/refresh'.length));
        try {
          const ok = await this.app.profileBook.updateProfileWithAI(id);
          return this.json(res, { ok, profile: this.app.profileBook.get(id) });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // PUT /api/profiles/:id — update manual (full replace dos campos)
      if (method === 'PUT' && pathname.startsWith('/api/profiles/')) {
        const id = decodeURIComponent(pathname.slice('/api/profiles/'.length));
        try {
          const body = await this.readJsonBody(req);
          const profile = this.app.profileBook.updateManually(id, body || {});
          if (!profile) return this.json(res, { ok: false, error: 'perfil não encontrado' }, 404);
          return this.json(res, { ok: true, profile });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/profiles/:id
      if (method === 'DELETE' && pathname.startsWith('/api/profiles/')) {
        const id = decodeURIComponent(pathname.slice('/api/profiles/'.length));
        const removed = this.app.profileBook.remove(id);
        return this.json(res, { ok: removed });
      }

      // ======================================================================
      // STICKERS  (GET /api/stickers, POST /:filename/name|favorite,
      //            DELETE /:filename)
      // ======================================================================

      // GET /api/stickers
      if (method === 'GET' && pathname === '/api/stickers') {
        return this.json(res, { stickers: this.buildStickerList() });
      }

      // POST /api/stickers/merge-duplicates — encontra figurinhas com mesmo conteúdo (hash) e une
      if (method === 'POST' && pathname === '/api/stickers/merge-duplicates') {
        try {
          const vaultDir = this.app.dataPath('stickers-vault');
          const meta = this.app.stickers.loadMeta();
          let files: string[] = [];
          try {
            files = fs.readdirSync(vaultDir).filter(f => /\.(webp|png|jpg|jpeg)$/.test(f));
          } catch {
            return this.json(res, { ok: false, error: 'vault não encontrado' });
          }

          // Agrupa por hash
          const hashMap = new Map<string, string[]>(); // hash → [filename, ...]
          for (const filename of files) {
            try {
              const buf = fs.readFileSync(path.join(vaultDir, filename));
              const crypto = require('node:crypto');
              const hash = crypto.createHash('sha256').update(buf).digest('hex');
              if (!hashMap.has(hash)) hashMap.set(hash, []);
              hashMap.get(hash)!.push(filename);
            } catch { /* ignora */ }
          }

          // Pra cada grupo com 2+ arquivos, mantém o primeiro e deleta os outros
          // (transfere metadados: nome + favorita pro que fica)
          let merged = 0;
          let deleted = 0;
          for (const [hash, filenames] of hashMap) {
            if (filenames.length < 2) continue;

            // Escolhe o "sobrevivente": prefere o que tem nome ou favorita
            let survivor = filenames[0];
            for (const f of filenames) {
              const m = meta[f];
              if (m && (m.name || m.favorite)) {
                survivor = f;
                break;
              }
            }

            // Transfere metadados dos outros pro sobrevivente
            for (const f of filenames) {
              if (f === survivor) continue;
              const m = meta[f];
              if (m) {
                if (m.name && !meta[survivor]?.name) {
                  this.app.stickers.setMeta(survivor, { name: m.name });
                }
                if (m.favorite && !meta[survivor]?.favorite) {
                  this.app.stickers.setMeta(survivor, { favorite: true });
                }
                // Remove meta do arquivo que vai ser deletado
                this.app.stickers.removeMeta(f);
              }
              // Deleta o arquivo duplicado
              try {
                fs.unlinkSync(path.join(vaultDir, f));
                deleted++;
              } catch { /* ignora */ }
            }
            merged++;
          }

          this.app.log('PANEL', `merge-duplicates: ${merged} grupo(s) processado(s), ${deleted} arquivo(s) deletado(s)`);
          return this.json(res, { ok: true, groups: merged, deleted });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/stickers/:filename/name  { name: string }
      if (method === 'POST' && pathname.startsWith('/api/stickers/') && pathname.endsWith('/name')) {
        const inner = pathname.slice('/api/stickers/'.length, pathname.length - '/name'.length);
        const filename = decodeURIComponent(inner);
        const body = await this.readJsonBody(req);
        const name = String(body?.name ?? '').trim();
        if (!filename) return this.json(res, { ok: false, error: 'filename ausente' }, 400);
        try {
          this.app.stickers.setMeta(filename, { name: name || undefined });
          this.app.log('PANEL', `figurinha renomeada via painel — ${filename} → "${name}"`);
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/stickers/:filename/favorite  { favorite: boolean }
      if (method === 'POST' && pathname.startsWith('/api/stickers/') && pathname.endsWith('/favorite')) {
        const inner = pathname.slice('/api/stickers/'.length, pathname.length - '/favorite'.length);
        const filename = decodeURIComponent(inner);
        const body = await this.readJsonBody(req);
        const favorite = !!body?.favorite;
        if (!filename) return this.json(res, { ok: false, error: 'filename ausente' }, 400);
        try {
          this.app.stickers.setMeta(filename, { favorite });
          this.app.log('PANEL', `figurinha ${favorite ? 'favoritada' : 'desfavoritada'} via painel — ${filename}`);
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/stickers/:filename
      if (method === 'DELETE' && pathname.startsWith('/api/stickers/')) {
        const filename = decodeURIComponent(pathname.slice('/api/stickers/'.length));
        if (!filename) return this.json(res, { ok: false, error: 'filename ausente' }, 400);
        try {
          const vaultDir = this.app.dataPath('stickers-vault');
          const filepath = path.join(vaultDir, filename);
          if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
          }
          this.app.stickers.removeMeta(filename);
          this.app.log('PANEL', `figurinha deletada via painel — ${filename}`);
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // CONVERSATIONS (GET /api/conversations) — clone do WhatsApp com decision-log
      // ======================================================================

      // GET /api/conversations — retorna msgs agrupadas por chat (decision-log + history backfill)
      if (method === 'GET' && pathname === '/api/conversations') {
        try {
          // Usa getConversations(100) que mescla decision-log (tempo real)
          // + historyLog (backfill de msgs antigas do WhatsApp).
          const convs = this.app.retroactive.getConversations(100);

          // Busca nomes dos chats via WhatsApp (pode falhar se WA desconectado)
          let chatNameMap = new Map<string, string>();
          let chatPhotoMap = new Map<string, string>();
          try {
            const chats = await this.app.whatsapp.client.getChats();
            for (const c of chats as any[]) {
              const cid = c.id?._serialized || '';
              if (cid) chatNameMap.set(cid, c.name || c.formattedTitle || cid);
              // Tenta pegar foto do chat
              try {
                const picUrl = await c.getProfilePicUrl();
                if (picUrl) chatPhotoMap.set(cid, picUrl);
              } catch { /* ignora */ }
            }
          } catch (e) {
            this.app.debug('PANEL', `conversations: getChats falhou (${(e as Error).message}) — usando chatId como nome`);
          }

          // Também busca fotos/nomes do ProfileBook (pode ter dados melhores)
          const profileBookData = this.app.profileBook.load();

          const result = convs.map(conv => {
            const profile = profileBookData[conv.chatId];
            const chatName = profile?.name || chatNameMap.get(conv.chatId) || conv.chatId;
            const photoUrl = profile?.photoUrl || chatPhotoMap.get(conv.chatId);
            return {
              chatId: conv.chatId,
              chatName,
              isGroup: conv.chatId.endsWith('@g.us'),
              photoUrl,
              messages: conv.messages,
            };
          });

          this.app.debug('PANEL', `conversations: ${result.length} chat(s), ${result.reduce((s, c) => s + c.messages.length, 0)} msg(s) total`);

          return this.json(res, { conversations: result });
        } catch (e) {
          this.app.debug('PANEL', `conversations erro: ${(e as Error).message}`);
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/conversations/backfill — re-dispara o backfill de histórico manualmente
      // Query/body param `force=true` pula a guarda de idempotência e re-busca tudo.
      if (method === 'POST' && pathname === '/api/conversations/backfill') {
        try {
          // Lê "force" de query string (?force=true) ou body JSON ({ force: true })
          const query = url.searchParams;
          let force = query.get('force') === 'true' || query.get('force') === '1';
          if (!force) {
            // Tenta ler do body (POST pode enviar JSON)
            const body = await this.readJsonBody(req);
            if (body && typeof body.force === 'boolean') {
              force = body.force === true;
            } else if (body && typeof body.force === 'string') {
              force = body.force === 'true' || body.force === '1';
            }
          }

          this.app.log('PANEL', `backfill manualmente disparado via painel${force ? ' (force=true)' : ''}`);
          // Roda em background — responde imediatamente com "iniciado"
          this.app.retroactive.backfillHistory(30, 100, force).catch(e => {
            this.app.debug('PANEL', `backfill manual falhou: ${(e as Error).message}`);
          });
          const msg = force
            ? 'backfill FORÇADO iniciado — aguarde ~30s e recarregue (historyLog foi limpo e re-buscado)'
            : 'backfill iniciado em background — aguarde ~30s e recarregue';
          return this.json(res, { ok: true, message: msg, force });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // COMMANDS  (GET /api/commands, POST /api/commands/:token, DELETE /api/commands/:token)
      // Permite ao painel ativar/desativar comandos e mudar opOnly↔public.
      // Comandos "locked" (admin: /admin, /op, /deop, /ops, /ban, /unban, /banidos)
      // não podem ser mexidos — setOverride/clearOverride retornam false.
      // ======================================================================

      // GET /api/commands  — lista todos os comandos com status de override + locked
      if (method === 'GET' && pathname === '/api/commands') {
        try {
          const list = this.app.commands.allWithStatus().map(c => ({
            name: c.name,
            aliases: c.aliases,
            help: c.help || '',
            opOnly: !!c.opOnly,  // original do código
            pvOnly: !!c.pvOnly,  // original do código
            locked: c.locked,  // admin commands — não dá pra mexer
            disabled: c.isDisabled,  // desativado via override?
            effectiveOpOnly: c.effectiveOpOnly,  // opOnly efetivo (com override)
            override: c.override,  // override aplicado (se houver)
          }));
          return this.json(res, { commands: list });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/commands/:token  { disabled?: boolean, opOnly?: boolean }
      // Seta override. Se comando é locked, retorna 403.
      if (method === 'POST' && pathname.startsWith('/api/commands/')) {
        const token = decodeURIComponent(pathname.slice('/api/commands/'.length));
        if (!token) return this.json(res, { ok: false, error: 'token ausente' }, 400);
        const body = await this.readJsonBody(req);
        try {
          const override: any = {};
          if (typeof body?.disabled === 'boolean') override.disabled = body.disabled;
          if (typeof body?.opOnly === 'boolean') override.opOnly = body.opOnly;

          if (Object.keys(override).length === 0) {
            return this.json(res, { ok: false, error: 'nenhum campo pra setar (disabled ou opOnly)' }, 400);
          }

          const ok = this.app.commands.setOverride(token, override);
          if (!ok) {
            // Comando não existe OU é locked (admin)
            const def = this.app.commands.lookup(token);
            if (!def) {
              return this.json(res, { ok: false, error: 'comando não existe' }, 404);
            }
            return this.json(res, { ok: false, error: 'comando travado (admin) — não pode ser mexido' }, 403);
          }
          this.app.log('PANEL', `override de comando ${token} setado: ${JSON.stringify(override)}`);
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/commands/:token  — remove override, volta pro default do código
      if (method === 'DELETE' && pathname.startsWith('/api/commands/')) {
        const token = decodeURIComponent(pathname.slice('/api/commands/'.length));
        if (!token) return this.json(res, { ok: false, error: 'token ausente' }, 400);
        try {
          const ok = this.app.commands.clearOverride(token);
          if (!ok) {
            const def = this.app.commands.lookup(token);
            if (!def) {
              return this.json(res, { ok: false, error: 'comando não existe' }, 404);
            }
            return this.json(res, { ok: false, error: 'comando travado (admin) — não pode ser mexido' }, 403);
          }
          this.app.log('PANEL', `override de comando ${token} removido — volta pro default`);
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // EVENTS  (GET /api/events)
      // ======================================================================

      // GET /api/events  — upcoming only, sorted by fireAt
      if (method === 'GET' && pathname === '/api/events') {
        try {
          const all = this.app.scheduler.list();
          const now = Date.now();
          const upcoming = all
            .filter(e => !e.fired && e.fireAt > now)
            .sort((a, b) => a.fireAt - b.fireAt);
          return this.json(res, { events: upcoming });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/events/:id  — cancela um evento
      if (method === 'DELETE' && pathname.startsWith('/api/events/')) {
        try {
          const id = decodeURIComponent(pathname.slice('/api/events/'.length));
          const ok = this.app.scheduler.cancel(id);
          return this.json(res, { ok });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // ======================================================================
      // OPS & BANNED
      // ======================================================================

      // GET /api/ops  → { ops: [...], items: [...] }  (items alias pra UI legada)
      if (method === 'GET' && pathname === '/api/ops') {
        const ops = this.app.permissions.loadOps();
        return this.json(res, { ops });
      }
      // POST /api/ops  { phone, lid?, id? }  (id = alias pra phone/lid)
      if (method === 'POST' && pathname === '/api/ops') {
        const body = await this.readJsonBody(req);
        // Aceita phone|lid explícitos, ou id genérico (UI envia { id }).
        // id com @lid vira lid; senão vira phone.
        let phone = body?.phone ? String(body.phone) : null;
        let lid = body?.lid ? String(body.lid) : null;
        if ((!phone && !lid) && body?.id != null) {
          const id = String(body.id);
          if (id.includes('@lid')) lid = id;
          else phone = id;
        }
        if (!phone && !lid) {
          return this.json(res, { ok: false, error: 'phone ou lid ausente' }, 400);
        }
        try {
          const added = this.app.permissions.addOp(lid, phone);
          this.app.log('PANEL', `op ${added ? 'adicionado' : 'já existia'} via painel — lid=${lid} phone=${phone}`);
          return this.json(res, { ok: true, added });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }
      // DELETE /api/ops/:phone  (UI envia id no path — interpretado igual)
      if (method === 'DELETE' && pathname.startsWith('/api/ops/')) {
        const raw = decodeURIComponent(pathname.slice('/api/ops/'.length));
        if (!raw) return this.json(res, { ok: false, error: 'phone/id ausente' }, 400);
        // Se tem @lid, trata como lid; senão como phone.
        const lid = raw.includes('@lid') ? raw : null;
        const phone = raw.includes('@lid') ? null : raw;
        try {
          const removed = this.app.permissions.removeOp(lid, phone);
          this.app.log('PANEL', `op ${removed ? 'removido' : 'não existia'} via painel — raw=${raw}`);
          return this.json(res, { ok: true, removed });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // GET /api/banned  → { banned: [...], items: [...] }
      if (method === 'GET' && pathname === '/api/banned') {
        const banned = this.app.permissions.loadBanned();
        return this.json(res, { banned });
      }
      // POST /api/banned  { phone, lid?, id? }
      if (method === 'POST' && pathname === '/api/banned') {
        const body = await this.readJsonBody(req);
        let phone = body?.phone ? String(body.phone) : null;
        let lid = body?.lid ? String(body.lid) : null;
        if ((!phone && !lid) && body?.id != null) {
          const id = String(body.id);
          if (id.includes('@lid')) lid = id;
          else phone = id;
        }
        if (!phone && !lid) {
          return this.json(res, { ok: false, error: 'phone ou lid ausente' }, 400);
        }
        try {
          const added = this.app.permissions.addBanned(lid, phone);
          this.app.log('PANEL', `banido ${added ? 'adicionado' : 'já existia'} via painel — lid=${lid} phone=${phone}`);
          return this.json(res, { ok: true, added });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }
      // DELETE /api/banned/:phone
      if (method === 'DELETE' && pathname.startsWith('/api/banned/')) {
        const raw = decodeURIComponent(pathname.slice('/api/banned/'.length));
        if (!raw) return this.json(res, { ok: false, error: 'phone/id ausente' }, 400);
        const lid = raw.includes('@lid') ? raw : null;
        const phone = raw.includes('@lid') ? null : raw;
        try {
          const removed = this.app.permissions.removeBanned(lid, phone);
          this.app.log('PANEL', `banido ${removed ? 'removido' : 'não existia'} via painel — raw=${raw}`);
          return this.json(res, { ok: true, removed });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // AI CONFIG  (GET / POST /api/ai-config, POST /api/ia/test)
      // ======================================================================

      // GET /api/ai-config  — runtime config (não o estático)
      if (method === 'GET' && pathname === '/api/ai-config') {
        return this.json(res, this.app.brain.getAIConfig());
      }

      // POST /api/ai-config  { model, fallbackModels, apiUrl, apiKey, maxTokens, temperature, audioTranscription }
      // audioTranscription: { enabled, primaryModel, fallbackModel } — opcional
      if (method === 'POST' && pathname === '/api/ai-config') {
        const body = await this.readJsonBody(req);
        try {
          // Lê config atual (preserva campos não enviados)
          const filePath = this.app.dataPath('ai-config.json');
          let existing: any = {};
          try {
            existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          } catch { /* ok — primeira vez */ }
          const next: any = { ...existing };
          if (typeof body?.model === 'string') next.model = body.model;
          if (Array.isArray(body?.fallbackModels)) next.fallbackModels = body.fallbackModels;
          if (typeof body?.apiUrl === 'string') next.apiUrl = body.apiUrl;
          if (typeof body?.apiKey === 'string') next.apiKey = body.apiKey;
          if (body?.maxTokens != null && !isNaN(Number(body.maxTokens))) {
            next.maxTokens = Number(body.maxTokens);
          }
          if (body?.temperature != null && !isNaN(Number(body.temperature))) {
            next.temperature = Number(body.temperature);
          }
          // === Seção audioTranscription (transcrição de áudios do WhatsApp) ===
          if (body?.audioTranscription && typeof body.audioTranscription === 'object') {
            const at = body.audioTranscription;
            const current = existing.audioTranscription || {};
            next.audioTranscription = {
              enabled: typeof at.enabled === 'boolean' ? at.enabled : (current.enabled ?? true),
              primaryModel: typeof at.primaryModel === 'string' && at.primaryModel.trim()
                ? at.primaryModel.trim()
                : (current.primaryModel || 'gemini-3.5-flash-lite'),
              fallbackModel: typeof at.fallbackModel === 'string' && at.fallbackModel.trim()
                ? at.fallbackModel.trim()
                : (current.fallbackModel || 'gemini-3.1-flash-lite'),
            };
          }
          // === Cooldown de figurinha (ajustável via painel) ===
          if (body?.stickerCooldownSec != null && !isNaN(Number(body.stickerCooldownSec))) {
            next.stickerCooldownSec = Number(body.stickerCooldownSec);
          }
          // === Modelo de self-awareness (IA dedicada pra auto-reflexao) ===
          if (body?.selfAwarenessModel !== undefined) {
            next.selfAwarenessModel = body.selfAwarenessModel || null;
          }
          fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
          // Invalida cache do Brain — próxima chamada de getAIConfig() re-lê.
          this.app.brain.aiConfigCacheTime = 0;
          // Invalida também o cache do AudioTranscriber (se instanciado)
          if (this.app.audioTranscriber) {
            this.app.audioTranscriber.invalidateConfigCache();
          }
          const audioLog = next.audioTranscription ? ` audio=${next.audioTranscription.enabled ? 'on' : 'off'}(${next.audioTranscription.primaryModel})` : '';
          this.app.log('PANEL', `AI config atualizada via painel — model=${next.model} fallbacks=${(next.fallbackModels || []).length}${audioLog}`);
          return this.json(res, { ok: true });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/ia/test  — envia "ping" pra API atual, retorna resposta/erro
      if (method === 'POST' && pathname === '/api/ia/test') {
        try {
          const result = await this.testAIConnection();
          return this.json(res, result);
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // DIRECTIVES  (POST /api/directives, DELETE /api/directives/:id)
      // ======================================================================

      // POST /api/directives  { text: string }
      if (method === 'POST' && pathname === '/api/directives') {
        const body = await this.readJsonBody(req);
        const text = String(body?.text || '').trim();
        if (!text) return this.json(res, { ok: false, error: 'text ausente' }, 400);
        try {
          const result = this.app.directives.add(text, 'panel');
          if (!result.ok) {
            return this.json(res, { ok: false, error: result.error || 'erro ao adicionar diretiva' }, 400);
          }
          this.app.log('PANEL', `diretiva adicionada via painel — "${text.slice(0, 60)}"`);
          return this.json(res, { ok: true, directive: result.directive });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // DELETE /api/directives/:id
      if (method === 'DELETE' && pathname.startsWith('/api/directives/')) {
        const idStr = decodeURIComponent(pathname.slice('/api/directives/'.length));
        const id = parseInt(idStr, 10);
        if (isNaN(id)) return this.json(res, { ok: false, error: 'id inválido' }, 400);
        try {
          const removed = this.app.directives.remove(id);
          this.app.log('PANEL', `diretiva ${removed ? 'removida' : 'não existia'} via painel — id=${id}`);
          return this.json(res, { ok: true, removed });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // EXPORT / IMPORT (sistema unificado — escolhe o que exportar/importar)
      // ======================================================================

      // GET /api/export/components — lista componentes disponíveis com info
      if (method === 'GET' && pathname === '/api/export/components') {
        try {
          const components = this.buildExportComponentsList();
          return this.json(res, { components });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/export — gera backup como .zip (bundle)
      // Body: { components: ['memories', 'directives', ...] }
      // Retorna .zip com os arquivos reais dentro (comprime com deflate).
      if (method === 'POST' && pathname === '/api/export') {
        try {
          const body = await this.readJsonBody(req);
          const requested: string[] = Array.isArray(body?.components) ? body.components : [];
          if (requested.length === 0) {
            return this.json(res, { ok: false, error: 'nenhum componente selecionado' }, 400);
          }
          const pkg = this.buildExportPackage(requested);
          if (pkg.errors.length > 0 && pkg.data === null) {
            return this.json(res, { ok: false, error: 'todos os componentes falharam', details: pkg.errors }, 500);
          }

          // Gera ZIP
          const files: Record<string, Buffer> = {};
          const meta = {
            format: 'marcio-zip-bundle',
            version: 1,
            createdAt: new Date().toISOString(),
            appVersion: this.getCurrentVersion(),
            components: pkg.exported,
          };
          files['metadata.json'] = Buffer.from(JSON.stringify(meta, null, 2), 'utf8');
          if (pkg.data) {
            for (const [comp, content] of Object.entries(pkg.data)) {
              if (comp === 'system-prompt') {
                files['system-prompt.txt'] = Buffer.from(String(content), 'utf8');
              } else if (comp === 'stickers-vault') {
                if (typeof content === 'object' && content) {
                  for (const [fname, b64] of Object.entries(content)) {
                    files[`stickers-vault/${fname}`] = Buffer.from(b64 as string, 'base64');
                  }
                }
              } else {
                files[`${comp}.json`] = Buffer.from(JSON.stringify(content, null, 2), 'utf8');
              }
            }
          }
          const zipBuf = createZip(files);
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="marcio-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip"`,
            'Cache-Control': 'no-store',
            'Content-Length': zipBuf.length,
          });
          res.end(zipBuf);
          this.app.log('PANEL', `export ZIP: ${pkg.exported.length} componente(s), ${(zipBuf.length / 1024).toFixed(0)}KB — ${pkg.exported.join(', ')}`);
          return;
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/import — restaura backup de arquivo .zip (bundle)
      // Body: arquivo .zip cru (Content-Type: application/zip)
      // Query: ?components=memories,directives (opcional — filtra o que restaurar)
      if (method === 'POST' && pathname === '/api/import') {
        try {
          // Lê body como Buffer
          const buf = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = [];
            let total = 0;
            const MAX = 100 * 1024 * 1024;
            req.on('data', (chunk: Buffer) => {
              total += chunk.length;
              if (total > MAX) { reject(new Error('body too large')); req.destroy(); return; }
              chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks)));
            req.on('error', reject);
          });

          // Detecta ZIP pelos magic bytes (PK\x03\x04)
          const isZip = buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50;
          if (!isZip) {
            return this.json(res, { ok: false, error: 'Formato inválido. Use um arquivo .zip exportado pelo app.' }, 400);
          }

          this.app.debug('PANEL', `import: ZIP detectado, ${buf.length} bytes`);
          const files = readZip(buf);
          this.app.debug('PANEL', `import: ZIP extraído — ${Object.keys(files).length} arquivos`);

          // Lê metadata.json
          const meta = files['metadata.json'] ? JSON.parse(files['metadata.json'].toString('utf8')) : {};
          this.app.debug('PANEL', `import: metadata:`, meta);

          // Converte arquivos pra formato interno
          const data: Record<string, any> = {};
          for (const [fname, fbuf] of Object.entries(files)) {
            if (fname === 'metadata.json') continue;
            if (fname === 'system-prompt.txt') {
              data['system-prompt'] = fbuf.toString('utf8');
            } else if (fname.startsWith('stickers-vault/')) {
              if (!data['stickers-vault']) data['stickers-vault'] = {};
              const sname = fname.replace('stickers-vault/', '');
              // Mantém como Buffer — applyImportPackage detecta Buffer e escreve direto
              data['stickers-vault'][sname] = fbuf;
            } else if (fname.endsWith('.json')) {
              const comp = fname.replace('.json', '');
              try { data[comp] = JSON.parse(fbuf.toString('utf8')); }
              catch { this.app.debug('PANEL', `import: skip ${fname} (JSON inválido)`); }
            }
          }

          const parsed = {
            format: 'marcio-backup',
            version: 2,
            createdAt: meta.createdAt || new Date().toISOString(),
            components: meta.components || Object.keys(data),
            data,
            errors: [],
          };

          if (!parsed.data || Object.keys(parsed.data).length === 0) {
            return this.json(res, { ok: false, error: 'ZIP não contém componentes reconhecidos' }, 400);
          }

          // Determina quais componentes restaurar
          const url2 = new URL(req.url || '/', 'http://localhost');
          const filterParam = url2.searchParams.get('components');
          const filter: string[] | null = filterParam
            ? filterParam.split(',').map(s => s.trim()).filter(Boolean)
            : null;
          const result = this.applyImportPackage(parsed, filter);
          this.app.log('PANEL', `import ZIP: ${result.applied.length} componente(s) restaurado(s) — ${result.applied.join(', ') || 'nenhum'}`);
          return this.json(res, { ok: true, format: 'zip', ...result });
        } catch (e) {
          this.app.debug('PANEL', `import erro: ${(e as Error).message}`);
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // LEGACY ENDPOINTS (compatibilidade — redirecionam pros novos)
      // ======================================================================

      // GET /api/backup — legacy: exporta tudo (formato antigo {files})
      if (method === 'GET' && pathname === '/api/backup') {
        try {
          const files = this.collectBackupFiles();
          const body = JSON.stringify({
            version: 1,
            createdAt: new Date().toISOString(),
            files,
          }, null, 2);
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="marcio-backup.json"',
            'Cache-Control': 'no-store',
          });
          res.end(body);
          return;
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // POST /api/restore — legacy: restaura tudo do envelope {files}
      if (method === 'POST' && pathname === '/api/restore') {
        try {
          const parsed = await this.readRestoreBody(req);
          if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
            return this.json(res, { ok: false, error: 'formato inválido — esperado { files: { name: base64 } }' }, 400);
          }
          const files: Record<string, string> = parsed.files;
          let count = 0;
          for (const [name, b64] of Object.entries(files)) {
            if (!name || /[\\/]|\.\./.test(name)) continue;
            const target = this.app.dataPath(name);
            try {
              fs.mkdirSync(path.dirname(target), { recursive: true });
              fs.writeFileSync(target, Buffer.from(b64 as string, 'base64'));
              count++;
            } catch (e) {
              this.app.debug('PANEL', `restore: falha ao escrever ${name}: ${(e as Error).message}`);
            }
          }
          this.app.brain.aiConfigCacheTime = 0;
          this.app.log('PANEL', `restore (legacy): ${count} arquivo(s) restaurado(s)`);
          return this.json(res, { ok: true, count });
        } catch (e) {
          return this.json(res, { ok: false, error: (e as Error).message }, 500);
        }
      }

      // 404
      return this.json(res, { error: 'not found', path: pathname }, 404);
    } catch (e) {
      this.app.debug('PANEL', `erro HTTP em ${req.method} ${req.url}: ${(e as Error).message}`);
      try {
        this.json(res, { error: (e as Error).message }, 500);
      } catch { /* ignora */ }
    }
  }

  // ===========================================================================
  // STATIC FILE
  // ===========================================================================

  private serveIndex(res: ServerResponse): void {
    const filePath = path.join(this.publicDir, 'index.html');
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      // Cache-Control agressivo: no-store + no-cache + must-revalidate.
      // Sem isso, o Edge/Tauri WebView2 cacheia o HTML e o usuário roda
      // versão velha mesmo depois de atualizar o arquivo no disco.
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`index.html não encontrado em ${filePath}: ${(e as Error).message}`);
    }
  }

  /**
   * Serve o setup-wizard.html (janela de primeira execução).
   * Mesmo Cache-Control agressivo do serveIndex — wizard pode mudar entre versões.
   */
  private serveSetupWizard(res: ServerResponse): void {
    const filePath = path.join(this.publicDir, 'setup-wizard.html');
    try {
      const html = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`setup-wizard.html não encontrado em ${filePath}: ${(e as Error).message}`);
    }
  }

  /**
   * Lê data/setup-state.json — flag que indica se o wizard já foi completado.
   * Retorna { completed: false } se arquivo não existe (primeira execução).
   */
  private readSetupState(): { completed: boolean; completedAt?: string } {
    try {
      const filePath = this.app.dataPath('setup-state.json');
      if (!fs.existsSync(filePath)) {
        return { completed: false };
      }
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) return { completed: false };
      const parsed = JSON.parse(content);
      return {
        completed: !!parsed.completed,
        completedAt: parsed.completedAt || undefined,
      };
    } catch {
      return { completed: false };
    }
  }

  /**
   * Salva data/setup-state.json.
   */
  private writeSetupState(state: { completed: boolean; completedAt?: string }): void {
    try {
      const filePath = this.app.dataPath('setup-state.json');
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      this.app.debug('SETUP', `erro ao salvar setup-state: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // CHANGELOG — "O que há de novo?"
  // ===========================================================================

  /**
   * Versão atual do app (cacheada do package.json). Lida 1x no boot.
   */
  private _cachedVersion: string | null = null;
  private getCurrentVersion(): string {
    if (this._cachedVersion) return this._cachedVersion;
    try {
      // Em produção, package.json tá no cwd do bot (AppData).
      // Em dev, tá no rootDir.
      const rootDir = this.app.config.rootDir;
      const pkgPath = path.join(rootDir, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      this._cachedVersion = pkg.version || '1.0.0';
    } catch {
      this._cachedVersion = '1.0.0';
    }
    return this._cachedVersion;
  }

  /**
   * Lê data/changelog.json — arquivo com as novidades por versão.
   * Procura em 3 locais (em ordem):
   *  1. data/changelog.json (user-editável — se o usuário customizou)
   *  2. rootDir/data/changelog.json (bundled com o app — em produção: AppData)
   *  3. rootDir/changelog.json (fallback — em dev: raiz do projeto)
   * Se não existe em nenhum, retorna objeto vazio.
   */
  private readChangelog(): { releases: Array<any> } {
    const candidates = [
      this.app.dataPath('changelog.json'),
      path.join(this.app.config.rootDir, 'data', 'changelog.json'),
      path.join(this.app.config.rootDir, 'changelog.json'),
    ];
    for (const filePath of candidates) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) continue;
        return JSON.parse(content);
      } catch (e) {
        this.app.debug('CHANGELOG', `erro ao ler ${filePath}: ${(e as Error).message}`);
      }
    }
    this.app.debug('CHANGELOG', 'nenhum changelog.json encontrado — retornando vazio');
    return { releases: [] };
  }

  /**
   * Lê data/changelog-state.json — qual versão o usuário já viu.
   * Retorna { lastSeenVersion: '0.0.0' } se não existe (primeira vez = mostra tudo).
   */
  private readChangelogState(): { lastSeenVersion: string; dismissedAt?: string } {
    try {
      const filePath = this.app.dataPath('changelog-state.json');
      if (!fs.existsSync(filePath)) {
        return { lastSeenVersion: '0.0.0' };  // nunca viu — mostra tudo
      }
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) return { lastSeenVersion: '0.0.0' };
      const parsed = JSON.parse(content);
      return {
        lastSeenVersion: parsed.lastSeenVersion || '0.0.0',
        dismissedAt: parsed.dismissedAt || undefined,
      };
    } catch {
      return { lastSeenVersion: '0.0.0' };
    }
  }

  /**
   * Salva data/changelog-state.json.
   */
  private writeChangelogState(state: { lastSeenVersion: string; dismissedAt?: string }): void {
    try {
      const filePath = this.app.dataPath('changelog-state.json');
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (e) {
      this.app.debug('CHANGELOG', `erro ao salvar changelog-state: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // UPDATE SETTINGS (acceptBeta)
  // ===========================================================================

  private readUpdateSettings(): { acceptBeta: boolean } {
    try {
      const filePath = this.app.dataPath('update-settings.json');
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      return { acceptBeta: !!parsed.acceptBeta };
    } catch {
      return { acceptBeta: false };
    }
  }

  private writeUpdateSettings(settings: { acceptBeta: boolean }): void {
    const filePath = this.app.dataPath('update-settings.json');
    // Garante que o diretório data/ existe
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(settings, null, 2), 'utf8');
    this.app.debug('UPDATE', `update-settings.json salvo em: ${filePath} — acceptBeta=${settings.acceptBeta}`);
  }

  /**
   * Compara duas versões semver (com suporte a pre-release tags e 4-part beta).
   * Retorna: 1 se a > b, -1 se a < b, 0 se igual.
   *
   * Regras semver:
   *  - 1.0.3 > 1.0.2 (normal)
   *  - 1.0.3 > 1.0.3-beta-1 (release > pre-release)
   *  - 1.0.3 > 1.0.3.1 (release > 4-part beta — 4º número = contador de beta)
   *  - 1.0.3.2 > 1.0.3.1 (beta maior)
   */
  private compareVersions(a: string, b: string): number {
    const parseSemver = (v: string): { major: number[]; pre: string[]; betaNum: number } => {
      const clean = (v || '0.0.0').replace(/^v/, '');
      // Split version e pre-release (ex: 1.0.3-beta-1 → version=1.0.3, pre=beta-1)
      const [versionPart, ...preParts] = clean.split('-');
      const parts = versionPart.split('.').map(n => parseInt(n.replace(/\D/g, '')) || 0);
      // Se tem 4 partes (ex: 1.0.3.1), a 4ª é o contador de beta
      let betaNum = 0;
      let major = parts;
      if (parts.length >= 4) {
        betaNum = parts[3];
        major = parts.slice(0, 3); // só usa as 3 primeiras como major
      }
      const pre = preParts.length > 0 ? preParts.join('-').split('.') : [];
      return { major, pre, betaNum };
    };
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    // Compara major.minor.patch primeiro
    const maxLen = Math.max(pa.major.length, pb.major.length);
    for (let i = 0; i < maxLen; i++) {
      const na = pa.major[i] || 0;
      const nb = pb.major[i] || 0;
      if (na > nb) return 1;
      if (na < nb) return -1;
    }
    // major.minor.patch é igual — agora verifica se é beta (4-part ou pre-release)
    // - Sem beta (betaNum=0 e sem pre) > com beta (betaNum>0 ou tem pre)
    // - 1.0.3 > 1.0.3.1 (betaNum=1)
    // - 1.0.3 > 1.0.3-beta-1 (pre=["beta","1"])
    const aIsBeta = pa.betaNum > 0 || pa.pre.length > 0;
    const bIsBeta = pb.betaNum > 0 || pb.pre.length > 0;
    if (!aIsBeta && !bIsBeta) return 0;  // ambos são release
    if (!aIsBeta) return 1;  // a é release, b é beta → a > b
    if (!bIsBeta) return -1; // b é release, a é beta → a < b
    // Ambos são beta — compara qual é maior
    // Pra 4-part: 1.0.3.2 > 1.0.3.1
    // Pra pre-release: beta-2 > beta-1 (alfabético)
    // Mistura: 4-part (betaNum=2) > pre-release (beta-1)? Trata como numérico.
    if (pa.betaNum !== pb.betaNum) {
      return pa.betaNum > pb.betaNum ? 1 : -1;
    }
    // Se betaNum é igual (ambos 0 ou ambos mesmo), compara pre-release alfabético
    const aPre = pa.pre.join('.');
    const bPre = pb.pre.join('.');
    if (aPre > bPre) return 1;
    if (aPre < bPre) return -1;
    return 0;
  }

  /**
   * Serve um arquivo estático do publicDir (chart.min.js, /js/*, /css/*).
   * Path traversal protegido — normaliza e checa que está dentro do publicDir.
   */
  private serveStaticFile(pathname: string, res: ServerResponse): void {
    // Sanitiza pathname — remove leading slash, previne path traversal
    const clean = pathname.replace(/^\/+/, '').replace(/\.\./g, '').replace(/\\/g, '');
    if (!clean) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('invalid path');
      return;
    }
    const filePath = path.join(this.publicDir, clean);
    // Verifica que está dentro do publicDir (path traversal guard)
    if (!filePath.startsWith(this.publicDir)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    try {
      const buf = fs.readFileSync(filePath);
      // Determina Content-Type pela extensão
      const ext = path.extname(filePath).toLowerCase();
      const ct = ext === '.js' ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.json' ? 'application/json; charset=utf-8'
        : ext === '.png' ? 'image/png'
        : ext === '.svg' ? 'image/svg+xml'
        : 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': buf.length,
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`arquivo não encontrado: ${clean}: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // HTTP HELPERS
  // ===========================================================================

  private json(res: ServerResponse, data: any, status = 200): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  private readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const MAX = 5 * 1024 * 1024; // 5MB — chega pra system-prompt grande
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * Lê o body do POST /api/restore. Aceita dois formatos:
   *  1. application/json — body é o JSON do backup direto.
   *  2. multipart/form-data — UI envia FormData com campo `file` contendo
   *     o JSON do backup (baixado anteriormente via /api/backup).
   *
   * Em ambos os casos, retorna o objeto parsed (com campo `files`).
   */
  private readRestoreBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      const MAX = 50 * 1024 * 1024;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const ct = String(req.headers['content-type'] || '').toLowerCase();
          // Tenta JSON direto primeiro (mais comum e confiável)
          const raw = buf.toString('utf8').trim();
          if (raw.startsWith('{') || raw.startsWith('[')) {
            try {
              return resolve(JSON.parse(raw));
            } catch { /* não é JSON válido, continua */ }
          }
          // Se é multipart, tenta extrair
          if (ct.includes('multipart/form-data')) {
            const fileContent = extractMultipartFile(buf, ct);
            if (fileContent != null) {
              try {
                const json = JSON.parse(fileContent.toString('utf8'));
                return resolve(json);
              } catch { /* arquivo não é JSON */ }
            }
            // Fallback: tenta parsear o body inteiro como JSON (ignorando multipart headers)
            try {
              return resolve(JSON.parse(raw));
            } catch {
              return reject(new Error('multipart sem arquivo válido'));
            }
          }
          // Qualquer outro caso: tenta JSON
          if (!raw) return resolve({});
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('body não é JSON válido'));
          }
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  // ===========================================================================
  // PAYLOAD BUILDERS
  // ===========================================================================

  private buildStats(): StatsPayload {
    // Conta memórias (total de fatos)
    let memoriesCount = 0;
    try {
      const all = this.app.memory.load();
      for (const user of Object.keys(all)) {
        memoriesCount += (all[user] || []).length;
      }
    } catch {
      // ignora
    }

    const debug: 'on' | 'off' | 'full' = this.app.debugFullEnabled
      ? 'full'
      : (this.app.debugEnabled ? 'on' : 'off');

    const aiConfig = this.app.brain.getAIConfig();
    const fallbacks = this.app.brain.getAllFallbackModels().filter((m, i, arr) => arr.indexOf(m) === i && m !== aiConfig.model);

    return {
      uptime: Date.now() - this.app.startTime,
      aiRequestCount: this.app.brain.aiRequestCount,
      lastUsedModel: this.app.brain.lastUsedModel,
      chatsWithContext: this.app.context.activeChatIds().length,
      historyLoaded: this.app.context.historyLoadedCount(),
      memories: memoriesCount,
      stickers: this.app.stickers.listNamed().length,
      directives: this.app.directives.all().length,
      debug,
      debugFull: this.app.debugFullEnabled,
      iaEnabled: !!this.app.aiConfig?.enabled,
      aiConfig: {
        model: aiConfig.model,
        fallbackModels: fallbacks,
      },
    };
  }

  private buildMemories(): Record<string, Array<{ fact: string; sourceChat: string; timestamp: string }>> {
    try {
      const all = this.app.memory.load();
      // Sanitiza pra serialização segura
      const out: Record<string, any> = {};
      for (const [user, facts] of Object.entries(all)) {
        out[user] = (facts as any[]).map((f) => ({
          fact: String(f?.fact ?? ''),
          sourceChat: String(f?.sourceChat ?? ''),
          timestamp: String(f?.timestamp ?? ''),
        }));
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Busca TODOS os chats do WhatsApp (client.getChats) + mescla com settings.
   * É async porque getChats() é async.
   */
  private async buildChatsList(): Promise<Array<{ chatId: string; name: string; isGroup: boolean; contextCount: number; iaEnabled: boolean; entrosao: number; muted: boolean; lastActivity: number }>> {
    let allChats: any[] = [];

    // 1. Tenta buscar TODOS os chats do WhatsApp (tem nome, isGroup, timestamp)
    try {
      allChats = await this.app.whatsapp.client.getChats();
    } catch (e) {
      this.app.debug('PANEL', `getChats falhou: ${(e as Error).message}`);
    }

    // 2. Se getChats falhou ou retornou vazio, fallback: contexto ativo + settings
    if (!allChats || allChats.length === 0) {
      const activeIds = this.app.context.activeChatIds();
      const settingsIds = this.app.chatSettings.allChatIds();
      const allIds = [...new Set([...activeIds, ...settingsIds])];
      allChats = allIds.map(id => ({ id: { _serialized: id }, name: id, isGroup: id.endsWith('@g.us'), timestamp: 0 }));
    }

    // 3. Filtra só chats que têm nome ou que o bot já interagiu (evita listar 500 strangers)
    // Pra PVs: só mostra se tem contexto OU tem settings customizadas
    // Pra grupos: mostra todos (o bot tá nele)
    const activeIds = new Set(this.app.context.activeChatIds());
    const settingsIds = new Set(this.app.chatSettings.allChatIds());

    return allChats
      .filter((chat: any) => {
        const chatId = chat.id?._serialized || '';
        if (!chatId) return false;
        // Grupos: sempre mostra (bot tá nele)
        if (chat.isGroup) return true;
        // PVs: só mostra se tem nome real (não só número) OU já interagiu
        const hasName = chat.name && chat.name !== chatId && !/^\d+@c\.us$/.test(chat.name);
        return hasName || activeIds.has(chatId) || settingsIds.has(chatId);
      })
      .map((chat: any) => {
        const chatId = chat.id?._serialized || '';
        const settings = this.app.chatSettings.get(chatId);
        // Nome: prefere name, senão formattedTitle, senão o ID
        let name = chat.name || chat.formattedTitle || chatId;
        // Se o nome é só o número (sem @), formata melhor
        if (/^\d+$/.test(name)) {
          name = `+${name}`;
        }
        return {
          chatId,
          name,
          isGroup: !!chat.isGroup,
          contextCount: this.app.context.count(chatId),
          iaEnabled: settings.aiEnabled,
          entrosao: settings.entrosao,
          muted: settings.muted,
          lastActivity: chat.timestamp ? chat.timestamp * 1000 : (chat.lastMessage?.timestamp ? chat.lastMessage.timestamp * 1000 : 0),
        };
      })
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  private readLastLogLines(n: number): string[] {
    try {
      if (!fs.existsSync(this.logFilePath)) return [];
      const raw = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = raw.split('\n');
      // Remove última linha vazia
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      return lines.slice(-n);
    } catch {
      return [];
    }
  }

  // ===========================================================================
  // HEALTH STATUS  (GET /api/health)
  // ===========================================================================

  /**
   * Retorna o status de saúde do app — usado pela seção "Diagnóstico" do painel.
   * Verifica: WhatsApp conectado, IA online, porta livre, uptime, etc.
   */
  private getHealthStatus(): {
    whatsapp: { connected: boolean; info?: string };
    ai: { enabled: boolean; hasApiKey: boolean; model: string | null; info?: string };
    port: { listening: boolean; port: number };
    uptime: number;
    errorSummary: any;
    maintenanceMode: boolean;
    debugEnabled: boolean;
    version: string;
    dataDir: string;
  } {
    // Status do WhatsApp
    let waConnected = false;
    let waInfo: string | undefined;
    try {
      waConnected = !!(this.app.whatsapp?.client?.info);
      if (this.app.whatsapp?.client?.info) {
        const info = this.app.whatsapp.client.info;
        waInfo = `${info.pushname || 'Bot'} (${info.wid?.user || '?'})`;
      }
    } catch (e) {
      waInfo = `erro ao verificar: ${(e as Error).message}`;
    }

    // Status da IA
    const cfg = this.app.brain?.getAIConfig();
    const aiEnabled = !!(cfg && cfg.apiKey);
    const aiModel = cfg?.model || null;

    // Status do ErrorTracker
    const errorSummary = this.app.errors ? this.app.errors.healthSummary() : null;

    return {
      whatsapp: { connected: waConnected, info: waInfo },
      ai: {
        enabled: aiEnabled,
        hasApiKey: !!(cfg && cfg.apiKey),
        model: aiModel,
        info: !aiEnabled ? 'Configure a API key em Configurações → IA' : undefined,
      },
      port: { listening: true, port: this.listenPort },
      uptime: Math.floor((Date.now() - this.app.startTime) / 1000),
      errorSummary,
      maintenanceMode: this.app.maintenanceMode,
      debugEnabled: this.app.debugEnabled,
      version: this.getCurrentVersion(),
      dataDir: this.app.config.dataDir,
    };
  }

  // ===========================================================================
  // SECRET ACTIONS  (POST /api/dev/secret-action)
  // ===========================================================================

  /**
   * Executa uma ação secreta do menu de testes.
   * SÓ funciona em dev/beta — em stable retorna erro 403 (checagem no endpoint).
   * Usado pra testar o funcionamento do app sem precisar rodar cenários reais.
   */
  private async executeSecretAction(action: string, body: any): Promise<{ ok: boolean; result?: string; error?: string }> {
    const channel = this.app.features.getChannel();
    if (channel === 'stable') {
      return { ok: false, error: 'Menu secreto desativado em stable' };
    }

    try {
      switch (action) {
        case 'open-setup-wizard':
          // Em Tauri: emite evento pra abrir a janela setup
          // Em browser: o frontend abre setup-wizard.html em nova aba
          if (this.app.control) {
            this.app.control.broadcast('open-setup-wizard', {});
          }
          return { ok: true, result: 'Comando pra abrir Setup Wizard enviado' };

        case 'reset-setup-state':
          // Marca setup-state como não-completado
          try {
            const setupStatePath = this.app.dataPath('setup-state.json');
            this.app.debug('PANEL', `reset-setup-state: escrevendo em ${setupStatePath}`);
            fs.writeFileSync(setupStatePath, JSON.stringify({ completed: false, resetAt: new Date().toISOString() }), 'utf8');
            return { ok: true, result: 'setup-state resetado — wizard vai abrir na próxima vez' };
          } catch (e) {
            return { ok: false, error: `Erro ao resetar setup-state: ${(e as Error).message}` };
          }

        case 'inject-test-error':
          this.app.errors.report('TEST', 'Erro de teste injetado pelo menu secreto', new Error('Stack de teste'), {
            userMessage: 'Este é um erro de teste — pode ignororar.',
            severity: 'warn',
            context: { source: 'secret-menu' },
          });
          return { ok: true, result: 'Erro de teste injetado no ErrorTracker' };

        case 'inject-critical-error':
          this.app.errors.report('TEST', 'ERRO CRÍTICO de teste', new Error('Stack de teste crítico'), {
            userMessage: 'Erro crítico de teste — em produção, isso dispararia notificação nativa.',
            severity: 'critical',
            context: { source: 'secret-menu' },
          });
          return { ok: true, result: 'Erro crítico de teste injetado' };

        case 'test-notification':
          if (this.app.control) {
            this.app.control.broadcast('notification', {
              title: '🔔 Teste de notificação',
              body: `Notificação gerada pelo menu secreto (${channel}).`,
            });
          }
          return { ok: true, result: 'Notificação enviada' };

        case 'force-wa-disconnect':
          // Simula desconexão do WhatsApp (dispara o evento sem desconectar de verdade)
          this.app.log('TEST', 'Simulando desconexão do WhatsApp (menu secreto)');
          this.app.errors.report('WA', 'Teste: simulação de desconexão', undefined, {
            userMessage: 'Teste: simulação de desconexão do WhatsApp.',
            severity: 'warn',
            context: { source: 'secret-menu' },
          });
          return { ok: true, result: 'Simulação de desconexão registrada' };

        case 'clear-errors':
          this.app.errors.clear();
          return { ok: true, result: 'Lista de erros limpa' };

        case 'clear-memories':
          this.app.log('TEST', 'Limpando TODAS as memórias (menu secreto)');
          try {
            const memPath = this.app.dataPath('memories.json');
            fs.writeFileSync(memPath, '{}', 'utf8');
            if (this.app.memory) {
              // Recarrega memórias em runtime
              this.app.memory['load']?.();
            }
            return { ok: true, result: 'Todas as memórias foram limpas' };
          } catch (e) {
            return { ok: false, error: `Erro ao limpar memórias: ${(e as Error).message}` };
          }

        case 'clear-stickers':
          this.app.log('TEST', 'Limpando TODAS as figurinhas (menu secreto)');
          try {
            const vaultDir = this.app.dataPath('stickers-vault');
            let deletedCount = 0;
            if (fs.existsSync(vaultDir)) {
              const files = fs.readdirSync(vaultDir).filter(f => /\.(webp|png|jpg|jpeg)$/.test(f));
              for (const f of files) {
                try { fs.unlinkSync(path.join(vaultDir, f)); deletedCount++; } catch { /* ignora */ }
              }
            }
            const metaPath = this.app.dataPath('stickers-meta.json');
            if (fs.existsSync(metaPath)) {
              fs.writeFileSync(metaPath, '{}', 'utf8');
            }
            return { ok: true, result: `${deletedCount} figurinhas limpas (vault resetado)` };
          } catch (e) {
            return { ok: false, error: `Erro ao limpar figurinhas: ${(e as Error).message}` };
          }

        case 'refresh-feature-flags':
          this.app.features.refresh();
          return { ok: true, result: `FeatureFlags re-detectado — canal=${this.app.features.getChannel()}` };

        default:
          return { ok: false, error: `Ação desconhecida: "${action}"` };
      }
    } catch (e) {
      return { ok: false, error: `Erro ao executar ação: ${(e as Error).message}` };
    }
  }

  // ===========================================================================
  // BOT STATUS  (GET /api/bot/status)
  // ===========================================================================

  /**
   * Monta o snapshot de status do bot/WhatsApp.
   * - running: true se o client existe (mesmo que não conectado ainda).
   * - whatsappConnected: true se client.info tá disponível (só vira após 'ready').
   * - uptime: ms desde boot.
   * - number: wid._serialized do bot ou null.
   */
  private buildBotStatus(): { running: boolean; whatsappConnected: boolean; uptime: number; number: string | null; lastReconnect: number } {
    const running = !!this.app.whatsapp?.client;
    let whatsappConnected = false;
    let number: string | null = null;
    if (running) {
      try {
        const info = (this.app.whatsapp as any)?.client?.info;
        if (info) {
          whatsappConnected = true;
          number = info.wid?._serialized ?? null;
        }
      } catch {
        // client.info pode lançar se o client foi destruído ou não tá pronto.
        whatsappConnected = false;
      }
    }
    return {
      running,
      whatsappConnected,
      uptime: Date.now() - this.app.startTime,
      number,
      lastReconnect: this.app.whatsapp?.lastReconnect || 0,
    };
  }

  // ===========================================================================
  // STICKER LIST  (GET /api/stickers)
  // ===========================================================================

  /**
   * Lista todas as figurinhas do vault com thumbnail base64.
   * - Lista TODOS os arquivos no vault dir (não só os nomeados).
   * - Cada item: { filename, name, favorite, thumbnail }.
   * - thumbnail é data URL (`data:image/webp;base64,...`).
   * - Cap em 50 itens (evita resposta gigante — vault pode ter 200+).
   *
   * Nota: não redimensiona (sem dep de image processing). Stickers webp
   * são tipicamente pequenos (10-50KB), então 50 thumbs ~ 1-2MB total.
   */
  private buildStickerList(): Array<{ filename: string; name: string | null; favorite: boolean; thumbnail: string | null }> {
    try {
      const vaultDir = this.app.dataPath('stickers-vault');
      const meta = this.app.stickers.loadMeta();
      let files: string[] = [];
      try {
        files = fs.readdirSync(vaultDir).filter(f => /\.(webp|png|jpg|jpeg)$/.test(f));
      } catch {
        // vault dir não existe → sem figurinhas
        return [];
      }
      // Ordena: figurinhas nomeadas/favoritas PRIMEIRO, depois por timestamp decrescente.
      // Isso garante que figurinhas marcadas pelo usuário sempre apareçam no painel,
      // mesmo que o vault esteja cheio (limite 200) e elas sejam antigas.
      // Antes, o cap de 100 + ordenação por timestamp cortava figurinhas nomeadas antigas.
      const stickerMeta = (filename: string) => meta[filename] || {};
      files.sort((a, b) => {
        const ma = stickerMeta(a);
        const mb = stickerMeta(b);
        // 1. Favoritas primeiro
        const favA = mb.favorite ? 1 : 0;
        const favB = ma.favorite ? 1 : 0;
        if (favA !== favB) return favA - favB;
        // 2. Nomeadas antes de sem-nome
        const nameA = mb.name ? 1 : 0;
        const nameB = ma.name ? 1 : 0;
        if (nameA !== nameB) return nameA - nameB;
        // 3. Por timestamp decrescente (mais recente primeiro)
        return b.localeCompare(a);
      });
      // Sem cap — o vault já é limitado a 200 figurinhas (VAULT_MAX_SIZE no StickerVault).
      // 200 thumbnails webp ~ 4-10MB, aceitável pra uma chamada local.
      // Se um dia precisar paginar, fazer via query param ?offset=0&limit=200.
      return files.map(filename => {
        let thumbnail: string | null = null;
        try {
          const buf = fs.readFileSync(path.join(vaultDir, filename));
          const ext = path.extname(filename).toLowerCase();
          const mime = ext === '.png' ? 'image/png'
                     : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
                     : 'image/webp';
          thumbnail = `data:${mime};base64,${buf.toString('base64')}`;
        } catch {
          thumbnail = null;
        }
        const m = meta[filename] || {};
        return {
          filename,
          name: m.name || null,
          favorite: !!m.favorite,
          thumbnail,
        };
      });
    } catch (e) {
      this.app.debug('PANEL', `erro ao listar figurinhas: ${(e as Error).message}`);
      return [];
    }
  }

  // ===========================================================================
  // AI CONNECTION TEST  (POST /api/ia/test)
  // ===========================================================================

  /**
   * Envia um "ping" (mensagem mínima) pra API de IA atual, retorna a resposta
   * ou erro. Usa a config runtime do Brain (getAIConfig) — respeita provider,
   * fallback, etc.
   *
   * @returns { ok, response?, error? }
   */
  private async testAIConnection(): Promise<{ ok: boolean; response?: string; error?: string }> {
    const cfg = this.app.brain.getAIConfig();
    if (!cfg?.apiKey && cfg?.provider !== null) {
      // Pode funcionar sem key pra alguns providers locais (Ollama), mas
      // pra Gemini/OpenAI é obrigatória. Não bloqueamos — só avisamos no log.
      this.app.debug('PANEL', 'ia/test: apiKey vazia — tentando mesmo assim');
    }
    const provider = cfg.provider || (cfg.apiUrl.includes('googleapis') ? 'gemini' : 'openai');
    const testPrompt = 'Responda apenas com: PONG';

    try {
      if (provider === 'gemini') {
        const geminiUrl = `${cfg.apiUrl.replace(/\/+$/, '')}/${cfg.model}:generateContent?key=${cfg.apiKey}`;
        const r = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: testPrompt }] }],
            generationConfig: { maxOutputTokens: 50, temperature: 0 },
          }),
        });
        if (!r.ok) {
          const errText = await r.text();
          return { ok: false, error: `Gemini API ${r.status}: ${errText.slice(0, 300)}` };
        }
        const data = await r.json() as any;
        const response = data.candidates?.[0]?.content?.parts?.[0]?.text || '(resposta vazia)';
        return { ok: true, response: String(response).trim() };
      } else {
        // OpenAI-compatible
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        const r = await fetch(cfg.apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: 'Responda apenas com: PONG' },
              { role: 'user', content: 'ping' },
            ],
            max_tokens: 50,
            temperature: 0,
          }),
        });
        if (!r.ok) {
          const errText = await r.text();
          return { ok: false, error: `API ${r.status}: ${errText.slice(0, 300)}` };
        }
        const data = await r.json() as any;
        const response = data.choices?.[0]?.message?.content || '(resposta vazia)';
        return { ok: true, response: String(response).trim() };
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ===========================================================================
  // BACKUP FILES  (GET /api/backup)
  // ===========================================================================

  /**
   * Lê todos os arquivos soltos em data/ (exceto subdirs grandes tipo
   * stickers-vault) e retorna como { name: base64 }.
   *
   * Inclui TODOS os .json e .txt soltos em data/:
   *  - memories.json, directives.json, ai-config.json, system-prompt.txt
   *  - ops.json, banned.json, chat-profiles.json, stickers-meta.json
   *  - decision-log.json, chat-settings.json, events.json
   *  - profile-book.json (sistema novo de perfis)
   *  - command-overrides.json (overrides de comandos)
   *  - setup-state.json (estado do wizard — opcional, não crítico)
   *
   * Subdirs incluídos: NENHUM (stickers-vault é huge; os outros não existem
   * por default). Se quiser adicionar um subdir no futuro, dá pra estender.
   */
  private collectBackupFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    const dataDir = this.app.config.dataDir;
    try {
      const entries = fs.readdirSync(dataDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) continue;
        if (!entry.isFile()) continue;
        const full = path.join(dataDir, entry.name);
        try {
          const buf = fs.readFileSync(full);
          out[entry.name] = buf.toString('base64');
        } catch (e) {
          this.app.debug('PANEL', `backup: skip ${entry.name}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      this.app.debug('PANEL', `backup: erro ao ler dataDir: ${(e as Error).message}`);
    }
    return out;
  }

  // ===========================================================================
  // EXPORT / IMPORT — componentes granulares
  // ===========================================================================

  /**
   * Lista os componentes disponíveis para export/import, com info útil
   * (nome, descrição, contagem/tamanho, se existe).
   * Cada componente sabe ler seu próprio data file e retornar um resumo.
   */
  private buildExportComponentsList(): Array<{
    id: string;
    label: string;
    description: string;
    icon: string;
    count: number;
    sizeBytes: number;
    available: boolean;
  }> {
    const comps: Array<{ id: string; label: string; description: string; icon: string; count: number; sizeBytes: number; available: boolean }> = [];

    // Helper: lê um JSON de data/ e retorna {count, sizeBytes, available}
    const info = (filename: string, countFn: (data: any) => number): { count: number; sizeBytes: number; available: boolean } => {
      try {
        const full = this.app.dataPath(filename);
        if (!fs.existsSync(full)) return { count: 0, sizeBytes: 0, available: false };
        const buf = fs.readFileSync(full);
        let parsed: any;
        try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = null; }
        const count = parsed ? countFn(parsed) : 0;
        return { count, sizeBytes: buf.length, available: true };
      } catch {
        return { count: 0, sizeBytes: 0, available: false };
      }
    };

    // memories
    {
      const i = info('memories.json', d => {
        let n = 0;
        for (const k of Object.keys(d)) if (Array.isArray(d[k])) n += d[k].length;
        return n;
      });
      comps.push({ id: 'memories', label: 'Memórias', description: 'Fatos permanentes sobre pessoas', icon: '🧠', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // directives
    {
      const i = info('directives.json', d => Array.isArray(d) ? d.length : 0);
      comps.push({ id: 'directives', label: 'Diretivas', description: 'Regras de comportamento da IA', icon: '📜', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // system-prompt
    {
      let size = 0, available = false;
      try {
        const full = this.app.dataPath('system-prompt.txt');
        if (fs.existsSync(full)) { size = fs.statSync(full).size; available = true; }
      } catch { /* ignora */ }
      comps.push({ id: 'system-prompt', label: 'System Prompt', description: 'Personalidade base do Márcio', icon: '📝', count: 1, sizeBytes: size, available });
    }
    // ai-config
    {
      const i = info('ai-config.json', () => 1);
      comps.push({ id: 'ai-config', label: 'Config IA', description: 'Modelo, API key, fallbacks', icon: '🤖', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // ops
    {
      const i = info('ops.json', d => Array.isArray(d) ? d.length : 0);
      comps.push({ id: 'ops', label: 'Operadores', description: 'Lista de ops (permissões)', icon: '👑', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // banned
    {
      const i = info('banned.json', d => Array.isArray(d) ? d.length : 0);
      comps.push({ id: 'banned', label: 'Banidos', description: 'Lista de usuários banidos', icon: '🚫', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // chat-profiles
    {
      const i = info('chat-profiles.json', d => Object.keys(d || {}).length);
      comps.push({ id: 'chat-profiles', label: 'Perfis de chat', description: 'Estilo aprendido por chat', icon: '👥', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // stickers-meta
    {
      const i = info('stickers-meta.json', d => Object.keys(d || {}).length);
      comps.push({ id: 'stickers-meta', label: 'Metadados de figurinhas', description: 'Nomes e favoritas (sem as imagens)', icon: '🎭', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // stickers-vault (imagens — opcional, pesado)
    {
      let count = 0, size = 0, available = false;
      try {
        const vaultDir = this.app.dataPath('stickers-vault');
        if (fs.existsSync(vaultDir)) {
          available = true;
          const files = fs.readdirSync(vaultDir).filter(f => /\.(webp|png|jpg|jpeg)$/i.test(f));
          count = files.length;
          for (const f of files) {
            try { size += fs.statSync(path.join(vaultDir, f)).size; } catch { /* ignora */ }
          }
        }
      } catch { /* ignora */ }
      comps.push({ id: 'stickers-vault', label: 'Figurinhas (imagens)', description: 'Arquivos de imagem do vault — pesado', icon: '🖼️', count, sizeBytes: size, available });
    }
    // decision-log
    {
      const i = info('decision-log.json', d => {
        let n = 0;
        for (const k of Object.keys(d)) if (Array.isArray(d[k])) n += d[k].length;
        return n;
      });
      comps.push({ id: 'decision-log', label: 'Log de decisões', description: 'Mensagens processadas (retroativo)', icon: '♻️', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // chat-settings
    {
      const i = info('chat-settings.json', d => Object.keys(d || {}).length);
      comps.push({ id: 'chat-settings', label: 'Settings de chat', description: 'IA on/off e entrosão por chat', icon: '⚙️', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // profile-book (sistema novo de perfis — separado do chat-profiles)
    {
      const i = info('profile-book.json', d => Object.keys(d?.profiles || d || {}).length);
      comps.push({ id: 'profile-book', label: 'ProfileBook', description: 'Perfis de pessoas/grupos (sistema novo)', icon: '👤', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // command-overrides (overrides de comandos — ativar/desativar, op↔public)
    {
      const i = info('command-overrides.json', d => Object.keys(d || {}).length);
      comps.push({ id: 'command-overrides', label: 'Overrides de comandos', description: 'Configs de ativar/desativar e permissão', icon: '🔧', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // bot-config (nome do bot + aliases customizados)
    {
      const i = info('bot-config.json', d => Array.isArray(d?.aliases) ? d.aliases.length : 0);
      comps.push({ id: 'bot-config', label: 'Config do Bot', description: 'Nome do bot e aliases de resposta', icon: '🤖', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }
    // events
    {
      const i = info('events.json', d => Array.isArray(d) ? d.length : 0);
      comps.push({ id: 'events', label: 'Eventos agendados', description: 'Lembretes e eventos futuros', icon: '📅', count: i.count, sizeBytes: i.sizeBytes, available: i.available });
    }

    return comps;
  }

  /**
   * Monta o pacote de exportação com os componentes solicitados.
   * Cada componente vira uma key em `data` com seu conteúdo (JSON parseado
   * ou string, dependendo do tipo).
   */
  private buildExportPackage(requested: string[]): { exported: string[]; data: Record<string, any> | null; errors: string[] } {
    const data: Record<string, any> = {};
    const exported: string[] = [];
    const errors: string[] = [];

    const readJson = (filename: string): any | null => {
      try {
        const full = this.app.dataPath(filename);
        if (!fs.existsSync(full)) return null;
        return JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch (e) {
        errors.push(`${filename}: ${(e as Error).message}`);
        return null;
      }
    };
    const readText = (filename: string): string | null => {
      try {
        const full = this.app.dataPath(filename);
        if (!fs.existsSync(full)) return null;
        return fs.readFileSync(full, 'utf8');
      } catch (e) {
        errors.push(`${filename}: ${(e as Error).message}`);
        return null;
      }
    };

    for (const comp of requested) {
      try {
        switch (comp) {
          case 'memories': {
            const d = readJson('memories.json');
            if (d !== null) { data.memories = d; exported.push(comp); }
            else errors.push('memories: arquivo não encontrado');
            break;
          }
          case 'directives': {
            const d = readJson('directives.json');
            if (d !== null) { data.directives = d; exported.push(comp); }
            else errors.push('directives: arquivo não encontrado');
            break;
          }
          case 'system-prompt': {
            const d = readText('system-prompt.txt');
            if (d !== null) { data['system-prompt'] = d; exported.push(comp); }
            else errors.push('system-prompt: arquivo não encontrado');
            break;
          }
          case 'ai-config': {
            const d = readJson('ai-config.json');
            if (d !== null) { data['ai-config'] = d; exported.push(comp); }
            else errors.push('ai-config: arquivo não encontrado');
            break;
          }
          case 'ops': {
            const d = readJson('ops.json');
            if (d !== null) { data.ops = d; exported.push(comp); }
            else errors.push('ops: arquivo não encontrado');
            break;
          }
          case 'banned': {
            const d = readJson('banned.json');
            if (d !== null) { data.banned = d; exported.push(comp); }
            else errors.push('banned: arquivo não encontrado');
            break;
          }
          case 'chat-profiles': {
            const d = readJson('chat-profiles.json');
            if (d !== null) { data['chat-profiles'] = d; exported.push(comp); }
            else errors.push('chat-profiles: arquivo não encontrado');
            break;
          }
          case 'stickers-meta': {
            const d = readJson('stickers-meta.json');
            if (d !== null) { data['stickers-meta'] = d; exported.push(comp); }
            else errors.push('stickers-meta: arquivo não encontrado');
            break;
          }
          case 'stickers-vault': {
            // Lê todas as imagens do vault como { filename: base64 }
            const vaultDir = this.app.dataPath('stickers-vault');
            const imgs: Record<string, string> = {};
            try {
              const files = fs.readdirSync(vaultDir).filter(f => /\.(webp|png|jpg|jpeg)$/i.test(f));
              for (const f of files) {
                try {
                  const buf = fs.readFileSync(path.join(vaultDir, f));
                  imgs[f] = buf.toString('base64');
                } catch { /* ignora individual */ }
              }
              if (Object.keys(imgs).length > 0) {
                data['stickers-vault'] = imgs;
                exported.push(comp);
              } else {
                errors.push('stickers-vault: vault vazio ou não encontrado');
              }
            } catch (e) {
              errors.push(`stickers-vault: ${(e as Error).message}`);
            }
            break;
          }
          case 'decision-log': {
            const d = readJson('decision-log.json');
            if (d !== null) { data['decision-log'] = d; exported.push(comp); }
            else errors.push('decision-log: arquivo não encontrado');
            break;
          }
          case 'chat-settings': {
            const d = readJson('chat-settings.json');
            if (d !== null) { data['chat-settings'] = d; exported.push(comp); }
            else errors.push('chat-settings: arquivo não encontrado');
            break;
          }
          case 'profile-book': {
            const d = readJson('profile-book.json');
            if (d !== null) { data['profile-book'] = d; exported.push(comp); }
            else errors.push('profile-book: arquivo não encontrado');
            break;
          }
          case 'command-overrides': {
            const d = readJson('command-overrides.json');
            if (d !== null) { data['command-overrides'] = d; exported.push(comp); }
            else errors.push('command-overrides: arquivo não encontrado');
            break;
          }
          case 'bot-config': {
            const d = readJson('bot-config.json');
            if (d !== null) { data['bot-config'] = d; exported.push(comp); }
            else errors.push('bot-config: arquivo não encontrado');
            break;
          }
          case 'events': {
            const d = readJson('events.json');
            if (d !== null) { data.events = d; exported.push(comp); }
            else errors.push('events: arquivo não encontrado');
            break;
          }
          default:
            errors.push(`componente desconhecido: ${comp}`);
        }
      } catch (e) {
        errors.push(`${comp}: ${(e as Error).message}`);
      }
    }

    return { exported, data: exported.length > 0 ? data : null, errors };
  }

  /**
   * Aplica um pacote de importação (.marcio.json) ao bot.
   * Se `filter` for informado, só restaura esses componentes (ignora outros).
   * Cada componente é gravado no data/ correspondente.
   * Invalida caches relevantes (Brain AI config, Memory, Profile).
   */
  private applyImportPackage(pkg: any, filter: string[] | null): { applied: string[]; skipped: string[]; errors: string[] } {
    const applied: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];

    if (!pkg || typeof pkg !== 'object') {
      throw new Error('pacote inválido');
    }
    // Detecta formato: novo (pkg.data = {...}) ou legado (pkg.files = {name: base64})
    const isLegacy = pkg.files && typeof pkg.files === 'object' && !pkg.data;
    const data = isLegacy ? null : (pkg.data || {});

    if (isLegacy) {
      // Formato legado {files: {name: base64}} — restaura tudo direto
      const files: Record<string, string> = pkg.files;
      let count = 0;
      for (const [name, b64] of Object.entries(files)) {
        if (!name || /[\\/]|\.\./.test(name)) continue;
        try {
          const target = this.app.dataPath(name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, Buffer.from(b64 as string, 'base64'));
          count++;
        } catch (e) {
          errors.push(`${name}: ${(e as Error).message}`);
        }
      }
      this.app.brain.aiConfigCacheTime = 0;
      this.app.memory['cache'] = null;  // invalida cache de memórias
      return { applied: [`legacy (${count} arquivos)`], skipped: [], errors };
    }

    // Formato novo — restaura componente por componente
    const allComps = Object.keys(data);
    const compsToApply = filter ? allComps.filter(c => filter.includes(c)) : allComps;

    const writeJson = (filename: string, content: any): boolean => {
      try {
        const target = this.app.dataPath(filename);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(content, null, 2), 'utf8');
        return true;
      } catch (e) {
        errors.push(`${filename}: ${(e as Error).message}`);
        return false;
      }
    };
    const writeText = (filename: string, content: string): boolean => {
      try {
        const target = this.app.dataPath(filename);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
        return true;
      } catch (e) {
        errors.push(`${filename}: ${(e as Error).message}`);
        return false;
      }
    };

    for (const comp of compsToApply) {
      const content = data[comp];
      if (content === undefined || content === null) {
        skipped.push(comp);
        continue;
      }
      try {
        switch (comp) {
          case 'memories':
            if (writeJson('memories.json', content)) { applied.push(comp); this.app.memory['cache'] = null; }
            break;
          case 'directives':
            if (writeJson('directives.json', content)) applied.push(comp);
            break;
          case 'system-prompt':
            if (writeText('system-prompt.txt', String(content))) { applied.push(comp); this.app.brain.aiConfigCacheTime = 0; }
            break;
          case 'ai-config':
            if (writeJson('ai-config.json', content)) { applied.push(comp); this.app.brain.aiConfigCacheTime = 0; }
            break;
          case 'ops':
            if (writeJson('ops.json', content)) applied.push(comp);
            break;
          case 'banned':
            if (writeJson('banned.json', content)) applied.push(comp);
            break;
          case 'chat-profiles':
            if (writeJson('chat-profiles.json', content)) applied.push(comp);
            break;
          case 'stickers-meta':
            if (writeJson('stickers-meta.json', content)) applied.push(comp);
            break;
          case 'stickers-vault': {
            // content = { filename: Buffer (do ZIP) OU string base64 (do JSON antigo) }
            if (content && typeof content === 'object') {
              const vaultDir = this.app.dataPath('stickers-vault');
              fs.mkdirSync(vaultDir, { recursive: true });
              let n = 0;
              for (const [fname, val] of Object.entries(content)) {
                if (!fname || /[\\/]|\.\./.test(fname)) continue;
                try {
                  // Se é Buffer (do ZIP), escreve direto. Se é string (base64 do JSON antigo), converte.
                  const buf = Buffer.isBuffer(val) ? val : Buffer.from(val as string, 'base64');
                  fs.writeFileSync(path.join(vaultDir, fname), buf);
                  n++;
                } catch (e) {
                  errors.push(`stickers-vault/${fname}: ${(e as Error).message}`);
                }
              }
              if (n > 0) applied.push(`stickers-vault (${n} imgs)`);
            }
            break;
          }
          case 'decision-log':
            if (writeJson('decision-log.json', content)) applied.push(comp);
            break;
          case 'chat-settings':
            if (writeJson('chat-settings.json', content)) applied.push(comp);
            break;
          case 'profile-book':
            if (writeJson('profile-book.json', content)) applied.push(comp);
            break;
          case 'command-overrides':
            if (writeJson('command-overrides.json', content)) {
              applied.push(comp);
              try { this.app.commands.loadOverrides(); } catch { /* ignora */ }
            }
            break;
          case 'bot-config':
            if (writeJson('bot-config.json', content)) {
              applied.push(comp);
              try { this.app.brain.loadBotConfig(); } catch { /* ignora */ }
            }
            break;
          case 'events':
            if (writeJson('events.json', content)) applied.push(comp);
            break;
          default:
            skipped.push(comp);
        }
      } catch (e) {
        errors.push(`${comp}: ${(e as Error).message}`);
      }
    }

    // === Invalida TODAS as caches em memória após import ===
    // Sem isso, o bot continua lendo dados velhos da cache mesmo depois
    // dos arquivos no disco terem sido atualizados.

    // Memory
    if (applied.some(a => a.startsWith('memories'))) {
      try { (this.app.memory as any).cache = null; } catch { /* ignora */ }
    }

    // Profile (chat-profiles.json) — tem cache interno
    if (applied.some(a => a.includes('chat-profiles'))) {
      try { (this.app.profile as any).cache = null; } catch { /* ignora */ }
    }

    // ProfileBook (profile-book.json) — tem cache interno
    if (applied.some(a => a.includes('profile-book'))) {
      try { (this.app.profileBook as any).cache = null; } catch { /* ignora */ }
    }

    // Retroactive (decision-log.json) — decisionLog é Map em memória
    if (applied.some(a => a.includes('decision-log'))) {
      try {
        // Recarrega do disco
        this.app.retroactive.load();
      } catch { /* ignora */ }
    }

    // ChatSettings — tem cache interno
    if (applied.some(a => a.includes('chat-settings'))) {
      try { (this.app.chatSettings as any).cache = null; } catch { /* ignora */ }
      // Recarrega pro brain
      try { this.app.chatSettings.loadIntoBrain(); } catch { /* ignora */ }
    }

    // Stickers meta — StickerVault pode ter cache
    if (applied.some(a => a.includes('stickers-meta'))) {
      try {
        // StickerVault lê do disco a cada chamada, mas invalida por garantia
        if ((this.app.stickers as any).metaCache) (this.app.stickers as any).metaCache = null;
      } catch { /* ignora */ }
    }

    // Bot config (nome + aliases)
    if (applied.some(a => a.includes('bot-config'))) {
      try { this.app.brain.loadBotConfig(); } catch { /* ignora */ }
    }

    // Command overrides
    if (applied.some(a => a.includes('command-overrides'))) {
      try { this.app.commands.loadOverrides(); } catch { /* ignora */ }
    }

    // AI config (sempre invalida — pode ter mudado modelo/key)
    try { this.app.brain.aiConfigCacheTime = 0; } catch { /* ignora */ }
    if (this.app.audioTranscriber) {
      try { this.app.audioTranscriber.invalidateConfigCache(); } catch { /* ignora */ }
    }

    // System prompt — invalida cache do brain
    if (applied.some(a => a.includes('system-prompt'))) {
      try { (this.app.brain as any).systemPromptCache = null; (this.app.brain as any).systemPromptCacheTime = 0; } catch { /* ignora */ }
    }

    this.app.log('PANEL', `import: caches invalidadas após restore`);

    return { applied, skipped, errors };
  }

  // ===========================================================================
  // WEBSOCKET MESSAGE HANDLER
  // ===========================================================================

  private async handleWsMessage(ws: WebSocket, raw: Buffer): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      this.send(ws, 'error', { error: 'invalid JSON' });
      return;
    }

    const action = String(msg?.action || '').toLowerCase();

    if (action === 'ping') {
      this.send(ws, 'pong', { time: Date.now() });
      return;
    }

    if (action === 'run-command') {
      const text = String(msg?.text || '');
      if (!text) {
        this.send(ws, 'command-result', { ok: false, error: 'texto vazio' });
        return;
      }
      const result = await this.injectCommand(text);
      this.send(ws, 'command-result', result);
      return;
    }

    // Ação desconhecida — ignora silenciosamente
    this.app.debug('PANEL', `WS action desconhecida: ${action}`);
  }

  // ===========================================================================
  // COMMAND INJECTION — o "console do Minecraft"
  // ===========================================================================

  /**
   * Injeta um comando no bot, como se um OP tivesse enviado pelo WhatsApp.
   *
   * Fluxo:
   *  1. Aceita texto que começa com `!`, `/` ou `//` (atalho pra /admin).
   *  2. Reescreve `//` → `/admin ` (igual MessageRouter faz).
   *  3. Lookup no CommandRegistry.
   *  4. Se encontrou: monta mensagem virtual (fromMe=true, from/to = PV do bot)
   *     e chama o handler direto. O router é pulado de propósito (ele ignora
   *     fromMe). As permission gates (opOnly, pvOnly) também são puladas —
   *     o painel é o dono no console, pode tudo.
   *  5. Retorna { ok, result?, error? }.
   */
  private async injectCommand(text: string): Promise<CommandResult> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: 'comando vazio' };

    // Aceita !, /, //  (mesma regra do MessageRouter)
    if (!/^[!/]/.test(trimmed)) {
      return { ok: false, error: 'not a command (comece com ! ou /)' };
    }

    // Atalho // → /admin
    let body = trimmed;
    if (body.startsWith('//')) {
      body = '/admin ' + body.slice(2);
    }

    const token = body.split(' ')[0].toLowerCase();
    const def = this.app.commands.lookup(token);
    if (!def) {
      return { ok: false, error: `comando desconhecido: ${token}` };
    }

    // Resolve o PV do bot (chat do dono com o próprio bot — é onde o handler
    // vai agir como se o dono tivesse digitado).
    let opChatId: string;
    try {
      opChatId = this.app.whatsapp.client.info?.wid?._serialized;
    } catch {
      opChatId = '';
    }
    if (!opChatId) {
      return { ok: false, error: 'client.info.wid indisponível — WhatsApp não conectado?' };
    }

    const virtualMsg = this.buildVirtualMessage(body, opChatId);

    // Seta flags de captura — MarcioApp.notify() e WhatsAppClient.sendMessage()
    // vão interceptar as respostas e mandá-las pro painel (em vez de só pro
    // WhatsApp). Assim o usuário vê a saída do comando no log do painel.
    this.capturing = true;
    this.capturingChatId = opChatId;
    try {
      this.app.log('PANEL', `comando injetado: ${body}`);
      await def.handler(virtualMsg as any, opChatId);
      return { ok: true, result: 'comando executado' };
    } catch (e) {
      const msg = (e as Error).message || String(e);
      this.app.log('PANEL', `erro ao injetar comando "${body}": ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.capturing = false;
      this.capturingChatId = null;
    }
  }

  /**
   * Monta um objeto "parecido com Message" suficiente pra os command handlers
   * do bot funcionarem. Os handlers tipicamente usam: body, fromMe, from, to,
   * id._serialized, react(), getChat(), getContact(), hasQuotedMsg, hasMedia,
   * mentionedIds. Tudo que não essencial é mockado como no-op ou vazio.
   *
   * O cast `as any` é intencional — o tipo Message do whatsapp-web.js é
   * complexo demais pra reimplementar fielmente, e os handlers só usam um
   * subconjunto bem definido desses campos.
   */
  private buildVirtualMessage(body: string, opChatId: string): any {
    const self = this;
    const id = {
      _serialized: `panel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

    return {
      body,
      fromMe: true,                 // OP: o próprio bot
      from: opChatId,
      to: opChatId,
      id,
      hasQuotedMsg: false,
      hasMedia: false,
      type: 'chat',
      mentionedIds: [],
      timestamp: Math.floor(Date.now() / 1000),
      isStatus: false,
      // react() no-op — handlers chamam pra feedback visual no WhatsApp,
      // não faz sentido no painel.
      async react(_emoji: string): Promise<void> {
        self.app.debug('PANEL', `react (virtual) ignorado: ${_emoji}`);
      },
      // getChat() → retorna o Chat real do PV do bot (pra handlers que
      // usam chat.sendStateTyping, chat.name, etc.)
      async getChat(): Promise<any> {
        return self.app.whatsapp.client.getChatById(opChatId);
      },
      // getContact() → retorna o Contact do próprio bot.
      // Nota: client.getContact() (sem args) não existe em todas as versões
      // do whatsapp-web.js. Usamos getContactById com o próprio wid.
      async getContact(): Promise<any> {
        try {
          return await self.app.whatsapp.client.getContactById(opChatId);
        } catch {
          // Fallback: retorna um contact mínimo se getContactById falhar
          return {
            number: opChatId.replace(/\D/g, ''),
            pushname: self.app.config.botName,
            name: self.app.config.botName,
            shortName: 'Márcio',
            id: { _serialized: opChatId },
          };
        }
      },
      async getQuotedMessage(): Promise<any> {
        return null;
      },
      async reply(_text: string): Promise<any> {
        // Alguns handlers usam msg.reply ao invés de app.notify.
        // Redireciona pra notify no próprio PV.
        await self.app.notify(opChatId, _text);
        return { id };
      },
      async downloadMedia(): Promise<any> {
        return null;
      },
    };
  }
}

// ============================================================================
// HELPER — mata processos Chromium órfãos (deixa de ter lock na pasta .wwebjs_auth)
// ============================================================================

/**
 * Mata processos Chromium/Chrome/Edge órfãos que podem estar segurando o lock
 * da pasta .wwebjs_auth/session.
 *
 * No Windows: procura por chrome.exe, chromium.exe, msedge.exe que tenham
 * wwebjs_auth ou com.marcio no command line, e mata com taskkill /F.
 * No Linux/Mac: usa pkill -f "wwebjs_auth".
 */
async function killLeftoverChromium(app: MarcioApp): Promise<void> {
  const { execSync } = require('node:child_process');
  app.log('PANEL', 'killLeftoverChromium: procurando processos órfãos...');

  try {
    if (process.platform === 'win32') {
      // ⚠️ wmic foi DEPRECIADO no Windows 11 — usar PowerShell Get-CimInstance
      const names = ['chrome.exe', 'chromium.exe', 'msedge.exe'];
      const allPids: number[] = [];
      for (const name of names) {
        try {
          const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='${name}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`;
          const out = execSync(psCmd, { encoding: 'utf8', timeout: 8000 });
          const lines = out.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          for (const line of lines) {
            const lower = line.toLowerCase();
            if (lower.includes('wwebjs_auth') || lower.includes('com.marcio')) {
              const match = line.match(/"(\d+)"/);
              const pid = match ? parseInt(match[1]) : NaN;
              if (pid > 0 && !allPids.includes(pid)) {
                allPids.push(pid);
              }
            }
          }
        } catch { /* processo não existe ou powershell falhou */ }
      }
      if (allPids.length > 0) {
        app.log('PANEL', `killLeftoverChromium: matando ${allPids.length} processo(s): ${allPids.join(', ')}`);
        for (const pid of allPids) {
          try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 }); }
          catch { /* ignora */ }
        }
        await new Promise(r => setTimeout(r, 2000));
      } else {
        app.debug('PANEL', 'killLeftoverChromium: nenhum processo órfão encontrado');
      }

      // Remove arquivos de lock do Chromium (SingletonLock, SingletonCookie, SingletonSocket)
      const authPath = app.config.legacyAuthPath || path.join(app.config.rootDir, '.wwebjs_auth');
      const sessionDir = path.join(authPath, 'session');
      const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
      for (const lock of lockFiles) {
        try {
          const lockPath = path.join(sessionDir, lock);
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
            app.debug('PANEL', `killLeftoverChromium: removido lock ${lock}`);
          }
        } catch { /* ignora */ }
      }
    } else {
      try { execSync('pkill -f "wwebjs_auth" 2>/dev/null', { timeout: 5000 }); } catch { /* ignora */ }
      const authPath = app.config.legacyAuthPath || path.join(app.config.rootDir, '.wwebjs_auth');
      const sessionDir = path.join(authPath, 'session');
      for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
        try { fs.unlinkSync(path.join(sessionDir, lock)); } catch { /* ignora */ }
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (e) {
    app.debug('PANEL', `killLeftoverChromium erro: ${(e as Error).message}`);
  }
}
