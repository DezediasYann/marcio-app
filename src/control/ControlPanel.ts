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
  const boundary = m[1] || m[2];
  if (!boundary) return null;

  // O delimiter real é \r\n--<boundary>
  const delim = Buffer.from(`\r\n--${boundary}`);
  // Acha a primeira ocorrência do delim (depois da primeira linha de boundary).
  const firstDelim = body.indexOf(`--${boundary}`);
  if (firstDelim === -1) return null;

  // Procura por "filename=" no body a partir do primeiro delim.
  const filenameIdx = body.indexOf('filename=', firstDelim);
  if (filenameIdx === -1) return null;

  // Os headers da parte terminam com \r\n\r\n. O conteúdo começa depois.
  const headersEnd = body.indexOf('\r\n\r\n', filenameIdx);
  if (headersEnd === -1) return null;
  const contentStart = headersEnd + 4;

  // O conteúdo termina no próximo \r\n--<boundary>.
  const contentEnd = body.indexOf(delim, contentStart);
  if (contentEnd === -1) return null;

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
    this.httpServer = createServer((req, res) => this.handleHttp(req, res));

    // WebSocket Server anexado ao mesmo HTTP server (upgrade automático).
    this.wss = new WebSocketServer({ server: this.httpServer });

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

    this.httpServer.listen(port, () => {
      this.app.log('PANEL', `Painel de controle ouvindo em http://localhost:${port}`);
    });

    this.httpServer.on('error', (e: NodeJS.ErrnoException) => {
      this.app.log('PANEL', `erro no servidor HTTP: ${e.message}`);
    });
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
        return this.json(res, { items: chats, chats });
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

      // GET /api/autostart — status do auto-start (delega pro Tauri via WS)
      if (method === 'GET' && pathname === '/api/autostart') {
        // O auto-start é gerenciado pelo Tauri (Rust). O painel não consegue
        // checar direto — manda um 'autostart-status' via WS e o Tauri responde.
        // Por enquanto, retorna unknown.
        return this.json(res, { enabled: null, message: 'autostart é gerenciado pelo Tauri' });
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

      // POST /api/bot/reconnect  (destroy + initialize no mesmo client)
      if (method === 'POST' && pathname === '/api/bot/reconnect') {
        try {
          const client = this.app.whatsapp?.client;
          if (!client) return this.json(res, { ok: false, error: 'client indisponível' }, 500);
          // destroy + initialize em background (demora).
          (async () => {
            try {
              await client.destroy();
              await client.initialize();
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

      // POST /api/bot/logout  (deleta .wwebjs_auth/ e reconecta → força novo QR)
      if (method === 'POST' && pathname === '/api/bot/logout') {
        try {
          const authPath = this.app.config.legacyAuthPath
            || path.join(this.app.config.rootDir, '.wwebjs_auth');
          this.app.log('PANEL', `logout: removendo auth em ${authPath}`);
          try {
            fs.rmSync(authPath, { recursive: true, force: true });
          } catch (e) {
            this.app.debug('PANEL', `logout: erro ao remover auth dir: ${(e as Error).message}`);
          }
          // Re-inicializa em background (vai gerar novo QR).
          const client = this.app.whatsapp?.client;
          if (client) {
            (async () => {
              try {
                await client.destroy();
                await client.initialize();
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
      // STICKERS  (GET /api/stickers, POST /:filename/name|favorite,
      //            DELETE /:filename)
      // ======================================================================

      // GET /api/stickers
      if (method === 'GET' && pathname === '/api/stickers') {
        return this.json(res, { stickers: this.buildStickerList() });
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
          const id = decodeURIComponent(pathname.replace('/api/events/', ''));
          const ok = this.app.scheduler.cancel(id);
          return this.json(res, { ok });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // TWITTER
      // ======================================================================

      // GET /api/twitter/status → status do Twitter
      if (method === 'GET' && pathname === '/api/twitter/status') {
        try {
          if (!this.app.twitter) {
            return this.json(res, { enabled: false, error: 'Twitter não inicializado' });
          }
          const cfg = this.app.twitter.getConfig();
          return this.json(res, {
            enabled: cfg.enabled,
            approvalMode: cfg.approvalMode,
            replyToMentions: cfg.replyToMentions,
            postIntervalHours: cfg.postIntervalHours,
            pendingTweets: Array.from(this.app.twitter.pendingTweets.entries()).map(([chatId, t]) => ({
              chatId,
              text: t.text || '',
              hasImage: !!t.imageData,
            })),
            pendingCount: this.app.twitter.pendingTweets.size,
          });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/twitter/toggle { enabled }
      if (method === 'POST' && pathname === '/api/twitter/toggle') {
        try {
          if (!this.app.twitter) {
            return this.json(res, { error: 'Twitter não inicializado' }, 400);
          }
          const body = await this.readJsonBody(req);
          const cfg = this.app.twitter.getConfig();
          cfg.enabled = !!body.enabled;
          this.app.twitter.saveConfig(cfg);
          this.app.log('PANEL', `Twitter ${body.enabled ? 'ativado' : 'desativado'} via painel`);
          return this.json(res, { ok: true, enabled: cfg.enabled });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/twitter/post — força geração + post agora (fluxo antigo: manda pro WhatsApp)
      if (method === 'POST' && pathname === '/api/twitter/post') {
        try {
          if (!this.app.twitter) {
            return this.json(res, { error: 'Twitter não inicializado' }, 400);
          }
          this.app.twitter.generateAndPostTweet();
          return this.json(res, { ok: true, message: 'Tweet gerado — se approvalMode, aguarde aprovação no PV' });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/twitter/generate — gera tweet e retorna pro painel (sem mandar pro WhatsApp)
      if (method === 'POST' && pathname === '/api/twitter/generate') {
        try {
          if (!this.app.twitter) {
            return this.json(res, { error: 'Twitter não inicializado' }, 400);
          }
          const tweet = await this.app.twitter.generateForPanel();
          if (!tweet) {
            return this.json(res, { ok: false, error: 'Não consegui gerar tweet (sem contexto de grupo disponível?)' });
          }
          return this.json(res, { ok: true, tweet: tweet.text, hasImage: tweet.hasImage });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // POST /api/twitter/post-direct — posta direto (sem aprovação no WhatsApp)
      if (method === 'POST' && pathname === '/api/twitter/post-direct') {
        try {
          if (!this.app.twitter) {
            return this.json(res, { error: 'Twitter não inicializado' }, 400);
          }
          const body = await this.readJsonBody(req);
          if (!body?.text) {
            return this.json(res, { error: 'text ausente' }, 400);
          }
          const result = await this.app.twitter.postDirect(String(body.text));
          return this.json(res, { ok: result === 'posted', result });
        } catch (e) {
          return this.json(res, { error: (e as Error).message }, 500);
        }
      }

      // ======================================================================
      // OPS & BANNED
      // ======================================================================

      // GET /api/ops  → { ops: [...], items: [...] }  (items alias pra UI legada)
      if (method === 'GET' && pathname === '/api/ops') {
        const ops = this.app.permissions.loadOps();
        return this.json(res, { ops, items: ops });
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
        return this.json(res, { banned, items: banned });
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

      // POST /api/ai-config  { model, fallbackModels, apiUrl, apiKey, maxTokens, temperature }
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
          fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
          // Invalida cache do Brain — próxima chamada de getAIConfig() re-lê.
          this.app.brain.aiConfigCacheTime = 0;
          this.app.log('PANEL', `AI config atualizada via painel — model=${next.model} fallbacks=${(next.fallbackModels || []).length}`);
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
      // BACKUP / RESTORE  (GET /api/backup, POST /api/restore)
      // ======================================================================

      // GET /api/backup  — JSON com todos os arquivos de data/ (exceto stickers-vault)
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

      // POST /api/restore  — JSON { files: {name:base64} } OU multipart/form-data
      // (UI envia FormData com arquivo de backup baixado anteriormente).
      if (method === 'POST' && pathname === '/api/restore') {
        try {
          const parsed = await this.readRestoreBody(req);
          if (!parsed || typeof parsed !== 'object' || !parsed.files || typeof parsed.files !== 'object') {
            return this.json(res, { ok: false, error: 'formato inválido — esperado { files: { name: base64 } }' }, 400);
          }
          const files: Record<string, string> = parsed.files;
          let count = 0;
          for (const [name, b64] of Object.entries(files)) {
            // Sanitiza nome — não permite .. ou path absoluto
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
          // Invalida cache do Brain pra recarregar config restaurada
          this.app.brain.aiConfigCacheTime = 0;
          this.app.log('PANEL', `restore: ${count} arquivo(s) restaurado(s)`);
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`index.html não encontrado em ${filePath}: ${(e as Error).message}`);
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
      const MAX = 50 * 1024 * 1024; // 50MB — backup pode ser grande
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
          if (ct.includes('multipart/form-data')) {
            // Extrai o conteúdo do primeiro campo "file" do multipart.
            const fileContent = extractMultipartFile(buf, ct);
            if (fileContent == null) {
              return reject(new Error('multipart sem arquivo'));
            }
            const json = JSON.parse(fileContent.toString('utf8'));
            return resolve(json);
          }
          // JSON direto
          const raw = buf.toString('utf8');
          if (!raw) return resolve({});
          resolve(JSON.parse(raw));
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
      // Ordena por nome (timestamp crescente) — mais antigo primeiro.
      files.sort();
      // Cap em 50
      const capped = files.slice(0, 50);
      return capped.map(filename => {
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
   * Subdirs incluídos: NENHUM (stickers-vault é huge; os outros não existem
   * por default). Se quiser adicionar um subdir no futuro, dá pra estender.
   */
  private collectBackupFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    const dataDir = this.app.config.dataDir;
    try {
      const entries = fs.readdirSync(dataDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) continue;  // pula subdirs (stickers-vault, etc.)
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
