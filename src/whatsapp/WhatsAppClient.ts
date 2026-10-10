/**
 * WhatsAppClient — wrapper fino sobre o Client do whatsapp-web.js.
 *
 * Responsabilidades (Fase 1):
 *  - Instanciar o Client com LocalAuth, apontando pro MESMO dataPath do bot
 *    velho — assim reaproveita a sessão e não precisa re-escanear QR.
 *  - Expor eventos (qr, ready, message_create) com logs.
 *  - Na Fase 1, message_create só LOGA. O dispatch pro MessageRouter
 *    vem na Fase 3.
 *
 * Responsabilidades (Fases 2-3, futuro):
 *  - notify(), react(), sendSticker() — helpers de envio.
 *  - isOwnMessage() — loop-guard.
 *  - typing indicators.
 */

import { Client, LocalAuth, type Message } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import type { MarcioApp } from '../MarcioApp';

export class WhatsAppClient {
  readonly client: Client;
  private app: MarcioApp;

  /**
   * IDs das mensagens enviadas pelo próprio bot (loop-guard).
   * Quando o bot manda uma msg, registra o ID aqui por 10s.
   * O handler de message_create ignora essas msgs — sem isso, comandos
   * como easter eggs (que ecoam "! figurinha") entrariam em loop infinito.
   */
  private botSentIds = new Set<string>();
  private readonly BOT_SENT_TTL_MS = 10000;

  constructor(app: MarcioApp) {
    this.app = app;
    this.app.log('WA', 'Construindo WhatsAppClient...');

    // LocalAuth: se legacyAuthPath for setado, reaproveita a sessão do bot
    // velho. Senão, usa o default (.wwebjs_auth/ no cwd).
    const authStrategy = app.config.legacyAuthPath
      ? new LocalAuth({ dataPath: app.config.legacyAuthPath })
      : new LocalAuth();

    this.client = new Client({
      authStrategy,
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',  // evita crash em containers com pouca RAM
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
        ],
      },
    });
  }

  /**
   * Inicializa o client e registra os handlers de evento.
   * Retorna quando o Client.initialize() resolver (geralmente após 'ready').
   */
  async initialize(): Promise<void> {
    this.app.log('WA', 'Inicializando client do WhatsApp...');

    // === Eventos de conexão ===

    this.client.on('loading_screen', (percent: string, message: string) => {
      this.app.log('WA', `Carregando: ${percent}% — ${message}`);
    });

    this.client.on('qr', (qr: string) => {
      this.app.log('WA', 'QR code gerado — escaneie com o celular (WhatsApp → Config → Aparelhos conectados → Conectar aparelho)');
      // Printa o QR no terminal
      qrcode.generate(qr, { small: true });
    });

    this.client.on('authenticated', () => {
      this.app.log('WA', 'Sessão autenticada.');
    });

    this.client.on('auth_failure', (msg: string) => {
      this.app.log('WA', `❌ Falha de autenticação: ${msg}`);
    });

    this.client.on('ready', () => {
      const me = this.client.info?.wid?._serialized ?? '?';
      this.app.log('WA', `✅ WhatsApp pronto! Conectado como: ${me}`);
    });

    this.client.on('disconnected', (reason: string) => {
      this.app.log('WA', `⚠️ Desconectado: ${reason}`);
    });

    // === Eventos de mensagem ===

    this.client.on('message_create', async (msg: Message) => {
      await this.handleMessage(msg);
    });

    // Inicializa (dispara o fluxo de QR/ready)
    await this.client.initialize();
  }

  /**
   * Handler de mensagem — Fase 3.2: delega pro MessageRouter.
   * Toda a lógica de dispatch (loop-guard, figurinha, contexto, twitter,
   * comando? registry : IA) vive no router. Aqui é só ponte.
   */
  private async handleMessage(msg: Message): Promise<void> {
    if (this.app.router) {
      try {
        await this.app.router.handleMessage(msg);
      } catch (e) {
        this.app.debug('WA', `erro no router: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Verifica se uma msg foi enviada pelo próprio bot (loop-guard).
   * Usado pelo Context.loadChatHistory e forceReadChatHistory pra pular
   * as próprias msgs ao carregar histórico.
   */
  isOwnMessage(msg: Message): boolean {
    if (msg.id?._serialized && this.botSentIds.has(msg.id._serialized)) {
      return true;
    }
    return false;
  }

  /**
   * Envia uma mensagem de texto rastreando o ID (pra loop-guard).
   * Use SEMPRE que a resposta puder parecer um comando (começar com ! ou /),
   * pra que o handler de message_create ignore a própria resposta.
   */
  async sendMessage(chatId: string, text: string): Promise<Message> {
    const sent = await this.client.sendMessage(chatId, text);
    if (sent?.id?._serialized) {
      const id = sent.id._serialized;
      this.botSentIds.add(id);
      setTimeout(() => this.botSentIds.delete(id), this.BOT_SENT_TTL_MS);
      this.app.debug('LOOP-GUARD', `mensagem enviada pelo bot registrada: ${id}`);
    }
    return sent;
  }

  /**
   * Fecha o client graciosamente (pro shutdown).
   */
  async destroy(): Promise<void> {
    try {
      await this.client.destroy();
      this.app.log('WA', 'Client fechado.');
    } catch (e) {
      this.app.log('WA', `erro ao fechar client: ${(e as Error).message}`);
    }
  }
}
