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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

      // GET /api/memories
      if (method === 'GET' && pathname === '/api/memories') {
        return this.json(res, this.buildMemories());
      }

      // GET /api/chats
      if (method === 'GET' && pathname === '/api/chats') {
        return this.json(res, this.buildChatsList());
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
        if (enabled) {
          this.app.brain.aiDisabledChats.delete(chatId);
        } else {
          this.app.brain.aiDisabledChats.add(chatId);
        }
        this.app.log('PANEL', `IA ${enabled ? 'reativada' : 'desativada'} via painel — chat=${chatId}`);
        return this.json(res, { ok: true });
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

  private buildChatsList(): Array<{ chatId: string; contextCount: number; iaEnabled: boolean; historyLoaded: boolean }> {
    // O Context não expõe publicamente o Set de chatsWithHistoryLoaded.
    // historyLoadedCount() só dá o total. Pra saber por-chat, a gente confere
    // se o chatId tem contexto — se tem, provavelmente já passou pelo capture
    // (que é a mesma porta que carrega histórico). Não é 100% preciso, mas é
    // info pra dashboard, não precisa ser.
    const ids = this.app.context.activeChatIds();
    return ids.map((chatId) => ({
      chatId,
      contextCount: this.app.context.count(chatId),
      iaEnabled: !this.app.brain.aiDisabledChats.has(chatId),
      historyLoaded: this.app.context.count(chatId) > 0,
    }));
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
