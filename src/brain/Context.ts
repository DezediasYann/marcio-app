/**
 * Context — memória de conversa curta (por chat) + cache de nomes.
 *
 * Responsabilidades:
 *  - Manter as últimas N mensagens de cada chat (pra IA ter contexto).
 *  - Capturar mensagens novas (texto, figurinha, imagem, quoted, URLs).
 *  - Carregar histórico antigo do WhatsApp (1× por chat, na 1ª msg).
 *  - Forçar releitura de histórico (comando /admin ler).
 *  - Cache de nomes de contato (pra não chamar getContact() toda hora).
 *
 * Dependências (service locator):
 *  - this.app.whatsapp — pra client.getChatById, botSentIds (loop-guard)
 *  - this.app.profile  — updateProfileWithMessage (aprendizado de estilo)
 *  - this.app.memory   — maybeExtract (extração de fatos)
 *  - this.app.stickers — findStickerByHash, loadStickerMeta (identificar figurinha)
 *
 * Nas Fases 2.2/2.3, profile/memory/stickers ainda não existem — o código
 * checa `if (this.app.X)` antes de chamar. Quando existirem, é só instanciar
 * no MarcioApp.start() que o Context passa a usá-los automaticamente.
 */

import type { Message } from 'whatsapp-web.js';
import type { MarcioApp } from '../MarcioApp';
import https from 'node:https';
import http from 'node:http';

// ============================================================================
// TIPOS
// ============================================================================

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;
  timestamp: number;
  imageData?: string;      // base64 (só imagens < 500KB)
  imageMimetype?: string;
}

export interface ForceReadStats {
  ok: boolean;
  fetched: number;
  added: number;
  profileUpdated: number;
  memoryQueued: number;
  memorySaved: number;
  memoryCap: number;
  skippedReasons: Record<string, number>;
  chatName: string;
  error?: string;
}

export interface ForceReadCallbacks {
  onProgress?: (msg: string) => void;
  onMemorySettled?: (stats: ForceReadStats) => void;
}

// ============================================================================
// CONSTS
// ============================================================================

const CONTACT_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 min
const MEMORY_EXTRACTION_CAP = 30;             // cap por /admin ler

// ============================================================================
// CONTEXT
// ============================================================================

export class Context {
  private app: MarcioApp;

  /** chatId → mensagens (últimas N). */
  private chatContexts = new Map<string, ChatMessage[]>();
  /** chatIds que já tiveram histórico carregado (1× só). */
  private chatsWithHistoryLoaded = new Set<string>();
  /** Cache de nomes: `${msg.from}_${senderId}` → { name, ts }. */
  private contactNameCache = new Map<string, { name: string; ts: number }>();

  constructor(app: MarcioApp) {
    this.app = app;
  }

  // ===========================================================================
  // GETTERS — usados pelo Brain e pelos command handlers
  // ===========================================================================

  /** Retorna as últimas N mensagens do chat (ou array vazio). */
  getRecent(chatId: string): ChatMessage[] {
    return this.chatContexts.get(chatId) ?? [];
  }

  /** Quantas mensagens no contexto do chat. */
  count(chatId: string): number {
    return this.chatContexts.get(chatId)?.length ?? 0;
  }

  /**
   * Nome do último usuário que falou no chat (ou null).
   * Usado pelo Brain pra saber de quem são as memórias a incluir.
   */
  lastSender(chatId: string): string | null {
    const ctx = this.chatContexts.get(chatId);
    if (!ctx) return null;
    for (let i = ctx.length - 1; i >= 0; i--) {
      if (ctx[i].role === 'user' && ctx[i].sender) {
        return ctx[i].sender!;
      }
    }
    return null;
  }

  /** Lista todos os chatIds que têm contexto em memória. */
  activeChatIds(): string[] {
    return Array.from(this.chatContexts.keys());
  }

  /** Quantos chats já tiveram histórico carregado. */
  historyLoadedCount(): number {
    return this.chatsWithHistoryLoaded.size;
  }

  // ===========================================================================
  // CAPTURA — chamado pelo MessageRouter pra cada msg recebida
  // ===========================================================================

  /**
   * Captura uma mensagem no contexto da conversa.
   *
   * Fluxo (preservado byte-a-byte do index.js velho, função
   * captureMessageForContext):
   *  1. Se textOverride vier (ex: !pergunta), usa ele. Senão usa msg.body.
   *  2. Se msg sem texto mas com mídia:
   *     - Sticker: tenta identificar qual (hash no vault) → "[mandou a figurinha X]"
   *     - Image: "[mandou uma imagem]"
   *     - Outro: "[mandou audio/video/etc]"
   *     - Sem texto e sem mídia: return (ignora).
   *  3. Busca conteúdo de URLs (até 3) e anexa no texto.
   *  4. Captura imagem (se < 500KB) pra mandar pra IA (visão).
   *  5. Captura mensagem respondida (quote/reply).
   *  6. Trunca pro maxLen do AI_CONFIG.
   *  7. Se fromMe (bot): pula saídas de comando (prefixo "Bot:"), senão push assistant.
   *  8. Se user: push user + updateProfileWithMessage + maybeExtractMemory.
   *  9. Mantém só as últimas N (AI_CONFIG.contextMessages).
   */
  async captureMessage(msg: Message, chatId: string, textOverride?: string): Promise<void> {
    if (!this.chatContexts.has(chatId)) this.chatContexts.set(chatId, []);
    const ctx = this.chatContexts.get(chatId)!;

    // --- 1+2. Determina o texto (override, body, ou placeholder de mídia) ---
    let text: string | undefined = textOverride !== undefined ? textOverride : msg.body;
    if (text === undefined || text === null || text === '') {
      if (msg.hasMedia && msg.type === 'sticker') {
        text = await this.describeSticker(msg);
      } else if (msg.hasMedia && msg.type === 'image') {
        text = '[mandou uma imagem]';
      } else if (msg.hasMedia) {
        text = `[mandou ${msg.type || 'mídia'}]`;
      } else {
        // Sem texto e sem mídia — ignora
        return;
      }
    }

    // --- 3. Busca conteúdo de URLs mencionadas (até 3) ---
    if (text && typeof text === 'string') {
      const urls = text.match(/(https?:\/\/[^\s]+)/g);
      if (urls && urls.length > 0) {
        for (const url of urls.slice(0, 3)) {
          try {
            const fetched = await this.fetchUrlContent(url);
            if (fetched) {
              text = text + ' ' + fetched;
              this.app.debug('AI-CTX', `conteúdo de URL anexado: ${url.slice(0, 60)}`);
            }
          } catch (e) {
            this.app.debug('AI-CTX', `erro ao buscar URL ${url}: ${(e as Error).message}`);
          }
        }
      }
    }

    // --- 4. Captura imagem (se < 500KB) ---
    let imageData: string | null = null;
    let imageMimetype: string | null = null;
    if (msg.hasMedia && msg.type === 'image') {
      try {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const approxBytes = media.data.length * 0.75;
          if (approxBytes < 500 * 1024) {
            imageData = media.data;
            imageMimetype = media.mimetype;
            this.app.debug('AI-CTX', `imagem capturada pro contexto (${Math.round(approxBytes / 1024)}KB, ${media.mimetype})`);
          } else {
            this.app.debug('AI-CTX', `imagem muito grande (${Math.round(approxBytes / 1024)}KB), ignorando`);
          }
        }
      } catch (e) {
        this.app.debug('AI-CTX', `erro ao baixar imagem: ${(e as Error).message}`);
      }
    }

    // --- 5. Captura mensagem respondida (quote) ---
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted.body && quoted.body.trim()) {
          let quotedSender = 'alguém';
          try {
            const quotedContact = await quoted.getContact();
            quotedSender = quotedContact.pushname || quotedContact.name || 'alguém';
          } catch { /* ignora */ }
          const quotedText = quoted.body.length > 150
            ? quoted.body.slice(0, 150) + '...'
            : quoted.body;
          text = `[respondendo "${quotedSender}: ${quotedText}"] ${text}`;
          this.app.debug('AI-CTX', `mensagem respondida capturada: ${quotedSender}: ${quotedText.slice(0, 50)}...`);
        }
      } catch { /* ignora erro ao buscar quoted */ }
    }

    // --- 6. Trunca mensagens longas ---
    const maxLen = this.app.aiConfig?.contextMaxMsgLength ?? 250;
    if (text!.length > maxLen) {
      text = text!.slice(0, maxLen) + '...';
    }

    // --- 7 ou 8. Push no contexto ---
    if (msg.fromMe) {
      // Pula saídas de comando do bot (não são conversa natural)
      // Detecta pelo prefixo "${botName}:" — usa nome configurado dinamicamente.
      const botName = this.app.config.botName || 'Bot';
      const botNameEsc = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const botPrefixRegex = new RegExp(`^${botNameEsc}\\s*🤖?\\s*:`, 'i');
      if (text && (
        botPrefixRegex.test(text) ||
        /^bot\s*:/i.test(text) ||
        /^\*.*\*:/.test(text.trim())
      )) {
        this.app.debug('AI-CTX', `pulando resposta de comando do bot: "${text.slice(0, 40)}..."`);
        return;
      }
      ctx.push({
        role: 'assistant',
        content: text!,
        timestamp: Date.now(),
        sender: this.app.config.botName,
        imageData: imageData || undefined,
        imageMimetype: imageMimetype || undefined,
      });
    } else {
      // Mensagem de usuário
      const senderName = await this.getContactName(msg);
      ctx.push({
        role: 'user',
        content: text!,
        sender: senderName,
        timestamp: Date.now(),
        imageData: imageData || undefined,
        imageMimetype: imageMimetype || undefined,
      });

      // Aprendizado de perfil (só se a classe Profile existir)
      if (this.app.profile && (textOverride !== undefined || (msg.body && msg.body.trim()))) {
        try {
          this.app.profile.updateWithMessage(chatId, senderName, text!);
        } catch (e) {
          this.app.debug('PROFILE', `erro ao atualizar perfil: ${(e as Error).message}`);
        }
      }

      // Extração de memória (só se a classe Memory existir)
      if (this.app.memory) {
        await this.app.memory.maybeExtract(chatId, senderName, text!);
      }

      // ProfileBook — registra msg da pessoa (dispara update IA a cada 15 msgs)
      if (this.app.profileBook) {
        try {
          const senderId = (msg as any).author || msg.from;
          if (senderId) {
            this.app.profileBook.recordMessage(senderId, 'person', senderName, chatId);
          }
        } catch (e) {
          this.app.debug('PROFILE', `erro ao registrar msg no ProfileBook: ${(e as Error).message}`);
        }
      }
    }

    // Registra msg do grupo no ProfileBook (se for grupo)
    if (this.app.profileBook && chatId.endsWith('@g.us') && (textOverride !== undefined || (msg.body && msg.body.trim()))) {
      try {
        const groupName = (await msg.getChat()).name || chatId;
        this.app.profileBook.recordMessage(chatId, 'group', groupName, chatId);
      } catch { /* ignora */ }
    }

    // --- 9. Mantém só as últimas N ---
    const maxCtx = this.app.aiConfig?.contextMessages ?? 20;
    if (ctx.length > maxCtx) {
      ctx.splice(0, ctx.length - maxCtx);
    }
  }

  /**
   * Captura a própria resposta do bot no contexto (depois que a IA responde).
   * Ignora respostas "podres" (vazias, "assistant", "...", só pontuação).
   */
  captureBotResponse(chatId: string, text: string): void {
    const lowerText = (text || '').toLowerCase().trim();
    if (!lowerText) return;
    if (lowerText === '...' || lowerText === 'assistant' || lowerText === 'user') return;
    if (/^(assistant\s*){1,3}$/i.test(lowerText)) return;
    if (/^[.\s…]+$/.test(lowerText)) return;

    if (!this.chatContexts.has(chatId)) this.chatContexts.set(chatId, []);
    const ctx = this.chatContexts.get(chatId)!;
    ctx.push({ role: 'assistant', content: text, timestamp: Date.now() });
    const maxCtx = this.app.aiConfig?.contextMessages ?? 20;
    if (ctx.length > maxCtx) {
      ctx.splice(0, ctx.length - maxCtx);
    }
  }

  // ===========================================================================
  // STICKER LOOKUP — temporário aqui; vai pra StickerVault na Fase 3
  // ===========================================================================

  /**
   * Tenta identificar qual figurinha foi mandada (via StickerVault.identify).
   * Retorna "[mandou a figurinha X]" ou "[mandou uma figurinha]".
   */
  private async describeSticker(msg: Message): Promise<string> {
    if (!this.app.stickers) return '[mandou uma figurinha]';
    try {
      const identified = await this.app.stickers.identify(msg);
      if (!identified) return '[mandou uma figurinha]';
      if (identified.name) {
        const favMark = identified.favorite ? ' ⭐' : '';
        this.app.debug('AI-CTX', `figurinha identificada no contexto: "${identified.name}"`);
        return `[mandou a figurinha "${identified.name}"${favMark}]`;
      }
      return '[mandou uma figurinha]';
    } catch {
      return '[mandou uma figurinha]';
    }
  }

  // ===========================================================================
  // NOMES DE CONTATO (com cache)
  // ===========================================================================

  /**
   * Pega o nome de quem mandou a msg (com cache de 5 min).
   * Versão ASYNC — chama msg.getContact() se o cache estiver frio.
   */
  async getContactName(msg: Message): Promise<string> {
    try {
      const senderId = (msg as any).author || msg.from;
      const cacheKey = `${msg.from}_${senderId}`;
      const cached = this.contactNameCache.get(cacheKey);
      if (cached && (Date.now() - cached.ts) < CONTACT_CACHE_TTL_MS) {
        return cached.name;
      }
      const contact = await msg.getContact();
      const name = contact.pushname || contact.name || contact.shortName || 'Alguém';
      this.contactNameCache.set(cacheKey, { name, ts: Date.now() });
      return name;
    } catch {
      return 'Alguém';
    }
  }

  /**
   * Versão SINCRONA: lê do cache sem await. Usada em pontos onde não podemos
   * esperar. O cache é populado por captureMessage(), que roda antes.
   */
  getCachedSenderName(msg: Message): string {
    try {
      const senderId = (msg as any).author || msg.from;
      const cacheKey = `${msg.from}_${senderId}`;
      const cached = this.contactNameCache.get(cacheKey);
      if (cached) return cached.name;
    } catch { /* ignora */ }
    return 'Alguém';
  }

  // ===========================================================================
  // CARREGAR HISTÓRICO ANTIGO (1× por chat, na 1ª msg)
  // ===========================================================================

  /**
   * Carrega mensagens antigas do WhatsApp pro contexto (1× por chat).
   * Usa chat.fetchMessages({ limit: N }).
   *
   * Preservado do index.js velho (loadChatHistory).
   */
  async loadChatHistory(msg: Message, chatId: string): Promise<void> {
    if (this.chatsWithHistoryLoaded.has(chatId)) return;
    this.chatsWithHistoryLoaded.add(chatId);

    try {
      const chat = await msg.getChat();
      const limit = this.app.aiConfig?.historyMessages ?? 25;
      const messages = await chat.fetchMessages({ limit });

      if (!messages || messages.length === 0) {
        this.app.debug('HISTORY', `nenhuma mensagem antiga encontrada em ${chatId}`);
        return;
      }

      // Inverte: processa do mais antigo pro mais recente
      const ordered = [...messages].reverse();
      if (!this.chatContexts.has(chatId)) this.chatContexts.set(chatId, []);
      const ctx = this.chatContexts.get(chatId)!;

      let added = 0;
      const maxLen = this.app.aiConfig?.contextMaxMsgLength ?? 250;

      for (const oldMsg of ordered) {
        // Pula mensagens do próprio bot rastreadas (loop guard)
        if (oldMsg.id && oldMsg.id._serialized && this.app.whatsapp?.isOwnMessage(oldMsg)) continue;

        // Pula comandos (! ou /)
        if (oldMsg.body && (oldMsg.body.startsWith('!') || oldMsg.body.startsWith('/'))) continue;

        // Pula saídas de comando do bot
        if (oldMsg.fromMe && oldMsg.body) {
          // Detecta saídas de comando do bot (prefixo "${botName}:")
          const _bn = (this.app.config.botName || 'Bot').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const _botRegex = new RegExp(`^${_bn}\\s*🤖?\\s*:`, 'i');
          if (_botRegex.test(oldMsg.body) ||
              /^bot\s*:/i.test(oldMsg.body) ||
              /^\*.*\*$/m.test(oldMsg.body.trim())) {
            continue;
          }
        }

        // Pula sem texto
        if (!oldMsg.body || !oldMsg.body.trim()) continue;

        const text = oldMsg.body.trim();
        const lowerText = text.toLowerCase();
        if (lowerText === 'assistant' || lowerText === '...' || lowerText === 'user') continue;
        if (/^(assistant\s*){1,3}$/i.test(text)) continue;

        const truncated = text.length > maxLen ? text.slice(0, maxLen) + '...' : text;

        if (oldMsg.fromMe) {
          ctx.push({
            role: 'assistant',
            content: truncated,
            timestamp: (oldMsg.timestamp || 0) * 1000,
            sender: this.app.config.botName,
          });
        } else {
          let senderName = 'Alguém';
          try {
            const contact = await oldMsg.getContact();
            senderName = contact.pushname || contact.name || contact.shortName || 'Alguém';
          } catch { /* ignora */ }
          ctx.push({
            role: 'user',
            content: truncated,
            sender: senderName,
            timestamp: (oldMsg.timestamp || 0) * 1000,
          });
        }
        added++;
      }

      const maxCtx = this.app.aiConfig?.contextMessages ?? 20;
      if (ctx.length > maxCtx) {
        ctx.splice(0, ctx.length - maxCtx);
      }

      this.app.debug('HISTORY', `carregadas ${added} mensagens antigas do chat ${chatId} (contexto agora: ${ctx.length})`);
    } catch (e) {
      this.app.debug('HISTORY', `erro ao carregar histórico de ${chatId}: ${(e as Error).message}`);
    }
  }

  /**
   * FORÇA a releitura do histórico — usado por /admin ler.
   * Diferente da loadChatHistory (1× só, 25 msgs), esta:
   *  - Pode ser chamada pra qualquer chat (por ID).
   *  - Aceita limite maior (default 200, máx 1000).
   *  - LIMPA o contexto antigo antes de recarregar.
   *  - Reseta o flag chatsWithHistoryLoaded.
   *  - Roda updateProfileWithMessage em cada msg (se this.app.profile existir).
   *  - Opcionalmente roda memory.maybeExtract (se withMemory=true e this.app.memory existir).
   */
  async forceReadChatHistory(
    chatId: string,
    limit: number,
    withMemory: boolean,
    callbacks: ForceReadCallbacks = {},
  ): Promise<ForceReadStats> {
    const onProgress = callbacks.onProgress ?? (() => {});
    const stats: ForceReadStats = {
      ok: false,
      fetched: 0,
      added: 0,
      profileUpdated: 0,
      memoryQueued: 0,
      memorySaved: 0,
      memoryCap: 0,
      skippedReasons: {},
      chatName: '(desconhecido)',
    };

    const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit) || 200));

    try {
      if (!this.app.whatsapp) {
        stats.error = 'WhatsApp client não inicializado';
        return stats;
      }

      // Acha o chat pelo ID
      let chat: any = null;
      try {
        chat = await this.app.whatsapp.client.getChatById(chatId);
      } catch {
        const chats = await this.app.whatsapp.client.getChats();
        chat = chats.find((c: any) => c.id && c.id._serialized === chatId) ?? null;
      }
      if (!chat) {
        stats.error = `chat não encontrado: ${chatId}`;
        return stats;
      }
      stats.chatName = chat.name || chat.formattedTitle || stats.chatName;

      onProgress(`Buscando ${safeLimit} mensagens em "${stats.chatName}"... (isso pode demorar)`);
      this.app.debug('HISTORY-FORCE', `forçando leitura de ${safeLimit} msgs em ${chatId} (${stats.chatName})`);

      const messages = await chat.fetchMessages({ limit: safeLimit });
      if (!messages || messages.length === 0) {
        stats.error = 'nenhuma mensagem encontrada no histórico';
        return stats;
      }
      stats.fetched = messages.length;

      const ordered = [...messages].reverse();
      this.chatContexts.set(chatId, []);
      this.chatsWithHistoryLoaded.delete(chatId);
      const ctx = this.chatContexts.get(chatId)!;
      const maxLen = this.app.aiConfig?.contextMaxMsgLength ?? 250;

      const skip = (reason: string) => {
        stats.skippedReasons[reason] = (stats.skippedReasons[reason] || 0) + 1;
      };

      for (const oldMsg of ordered) {
        if (oldMsg.id && oldMsg.id._serialized && this.app.whatsapp.isOwnMessage(oldMsg)) {
          skip('bot-loop-guard'); continue;
        }
        const body = oldMsg.body || '';
        if (body && (body.startsWith('!') || body.startsWith('/'))) { skip('comando'); continue; }
        if (oldMsg.fromMe && body) {
          // Detecta saídas de comando do bot (prefixo "${botName}:")
          const _bn2 = (this.app.config.botName || 'Bot').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const _botRegex2 = new RegExp(`^${_bn2}\\s*🤖?\\s*:`, 'i');
          if (_botRegex2.test(body) ||
              /^bot\s*:/i.test(body) ||
              /^\*.*\*$/m.test(body.trim())) {
            skip('bot-comando-output'); continue;
          }
        }
        if (!body || !body.trim()) { skip('sem-texto'); continue; }
        const text = body.trim();
        const lowerText = text.toLowerCase();
        if (lowerText === 'assistant' || lowerText === '...' || lowerText === 'user') { skip('podre'); continue; }
        if (/^(assistant\s*){1,3}$/i.test(text)) { skip('podre'); continue; }

        const truncated = text.length > maxLen ? text.slice(0, maxLen) + '...' : text;

        if (oldMsg.fromMe) {
          ctx.push({
            role: 'assistant',
            content: truncated,
            timestamp: (oldMsg.timestamp || 0) * 1000,
            sender: this.app.config.botName,
          });
          stats.added++;
        } else {
          let senderName = 'Alguém';
          try {
            const contact = await oldMsg.getContact();
            senderName = contact.pushname || contact.name || contact.shortName || 'Alguém';
          } catch { /* ignora */ }

          ctx.push({
            role: 'user',
            content: truncated,
            sender: senderName,
            timestamp: (oldMsg.timestamp || 0) * 1000,
          });
          stats.added++;

          // Aprendizado de perfil
          if (this.app.profile) {
            try {
              this.app.profile.updateWithMessage(chatId, senderName, text);
              stats.profileUpdated++;
            } catch (e) {
              this.app.debug('HISTORY-FORCE', `erro ao atualizar perfil: ${(e as Error).message}`);
            }
          }

          // Extração de memória (com cap + staggered setTimeout)
          if (withMemory && this.app.memory &&
              stats.memoryQueued < MEMORY_EXTRACTION_CAP &&
              text.length >= 5 &&
              !/^\[(mandou|CONTEÚDO|respondendo)/.test(text) &&
              this.app.memory.hasKeyword(text)) {
            stats.memoryQueued++;
            const delayMs = stats.memoryQueued * 400;
            setTimeout(() => {
              this.app.memory!.extractFacts(chatId, senderName, text)
                .then(count => {
                  if (count > 0) {
                    stats.memorySaved += count;
                    this.app.debug('HISTORY-FORCE', `✅ ${count} fato(s) salvo(s) de ${senderName}: "${text.slice(0, 50)}..."`);
                  } else {
                    this.app.debug('HISTORY-FORCE', `⏭️ NENHUM fato de ${senderName} (IA descartou): "${text.slice(0, 50)}..."`);
                  }
                })
                .catch(e => this.app.debug('HISTORY-FORCE', `erro na extração de memória: ${(e as Error).message}`));
            }, delayMs);
          } else if (withMemory && this.app.memory &&
                     stats.memoryQueued >= MEMORY_EXTRACTION_CAP &&
                     this.app.memory.hasKeyword(text)) {
            stats.memoryCap++;
          }
        }
      }

      const maxCtx = this.app.aiConfig?.contextMessages ?? 20;
      if (ctx.length > maxCtx) {
        ctx.splice(0, ctx.length - maxCtx);
      }
      this.chatsWithHistoryLoaded.add(chatId);

      stats.ok = true;
      this.app.debug('HISTORY-FORCE', `lidas ${stats.fetched} msgs de "${stats.chatName}" | adicionadas: ${stats.added} | perfil: ${stats.profileUpdated} | memória: ${stats.memoryQueued} (cap+${stats.memoryCap})`);

      // Callback quando todas as extrações de memória terminarem
      if (withMemory && this.app.memory && stats.memoryQueued > 0 && callbacks.onMemorySettled) {
        const settleDelay = stats.memoryQueued * 400 + 8000;
        setTimeout(() => {
          try {
            callbacks.onMemorySettled!(stats);
          } catch (e) {
            this.app.debug('HISTORY-FORCE', `erro no callback onMemorySettled: ${(e as Error).message}`);
          }
        }, settleDelay);
      }

      return stats;
    } catch (e) {
      stats.error = (e as Error).message;
      this.app.debug('HISTORY-FORCE', `erro ao forçar leitura de ${chatId}: ${(e as Error).message}`);
      return stats;
    }
  }

  // ===========================================================================
  // FETCH DE URL — pra IA entender links mandados no chat
  // ===========================================================================

  /**
   * Busca o conteúdo de uma URL (tweet ou página HTML) pra incluir no contexto.
   * - Twitter/X: usa fxtwitter/vxtwitter (JSON com texto do tweet e autor).
   * - Outras URLs: busca HTML, remove tags, pega primeiros ~500 chars.
   */
  async fetchUrlContent(url: string): Promise<string | null> {
    try {
      if (url.includes('x.com/') || url.includes('twitter.com/')) {
        const cleanUrl = url.split('?')[0];
        const services = [
          { name: 'fxtwitter', replace: (u: string) => u.replace(/\bx\.com\b/, 'api.fxtwitter.com').replace(/\btwitter\.com\b/, 'api.fxtwitter.com') },
          { name: 'vxtwitter', replace: (u: string) => u.replace(/\bx\.com\b/, 'api.vxtwitter.com').replace(/\btwitter\.com\b/, 'api.vxtwitter.com') },
        ];

        let parsed: any = null;
        let lastErr: Error | null = null;
        for (const svc of services) {
          try {
            const apiUrl = svc.replace(cleanUrl);
            const data = await this.fetchHttps(apiUrl);
            parsed = JSON.parse(data);
            break;
          } catch (err) {
            this.app.debug('URL', `${svc.name} falhou (${(err as Error).message})`);
            lastErr = err as Error;
          }
        }
        if (!parsed) {
          this.app.debug('URL', `todos os serviços falaram para ${url}: ${lastErr?.message}`);
          return null;
        }

        const tweetText = parsed.tweet?.text || parsed.text;
        const author = parsed.tweet?.author?.screen_name || parsed.user?.screen_name;
        if (!tweetText) return null;

        const authorStr = author ? ` (@${author})` : '';
        const preview = tweetText.length > 500 ? tweetText.slice(0, 500) + '...' : tweetText;
        return `[CONTEÚDO DO LINK: "${preview}"${authorStr}]`;
      }

      // Outras URLs: HTML → texto
      const html = await this.fetchHttps(url);
      let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

      if (!text) return null;
      const preview = text.length > 500 ? text.slice(0, 500) + '...' : text;
      return `[CONTEÚDO DO LINK: "${preview}"]`;
    } catch (e) {
      this.app.debug('URL', `erro ao buscar URL ${url}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Fetch robusto usando módulo https/http nativo.
   * Mais confiável que fetch() nativo no Windows.
   */
  private fetchHttps(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          'Connection': 'close',
          ...(options.headers || {}),
        },
        timeout: 10000,
        minVersion: 'TLSv1.2' as const,
        ciphers: 'DEFAULT:!aNULL:!eNULL:!MD5',
      };

      const req = lib.request(reqOptions, (res) => {
        if (res.statusCode! >= 300 && res.statusCode! < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).toString();
          this.fetchHttps(redirectUrl, options).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode! < 200 || res.statusCode! >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}
