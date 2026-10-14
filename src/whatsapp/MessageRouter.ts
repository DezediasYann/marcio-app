/**
 * MessageRouter — dispatch central de mensagens.
 *
 * Substitui o handler message_create do index.js velho (linhas 3943-4279).
 * Implementa a sequência de pré-filtros e depois decide: comando? → registry.
 * Não-comando? → brain (IA).
 *
 * === ORDEM DOS PRÉ-FILTROS (preservada) ===
 *  1. Loop-guard (ignora próprias mensagens)
 *  2. Filtro de msg antiga (timestamp < startup - 10s)
 *  3. Sticker: handleIncoming (salva no vault + ondas/guerras) — ANTES do body check
 *  4. Captura no contexto (texto, figurinha, imagem, quoted, URLs)
 *  5. Comando? (! ou /):
 *     - Atalho // → /admin
 *     - Lookup no registry
 *     - Permission gates (banido, opOnly, pvOnly)
 *     - Executa handler
 *  7. Não-comando? → brain.maybeAutoRespond (IA decide se responde)
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.whatsapp — isOwnMessage
 *  - this.app.stickers — handleIncoming
 *  - this.app.context — captureMessage
 *  - this.app.permissions — resolveSenderIds, isOp, isBanned
 *  - this.app.commands — lookup
 *  - this.app.brain — maybeAutoRespond
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';

export class MessageRouter {
  private app: MarcioApp;

  constructor(app: MarcioApp) {
    this.app = app;
  }

  /**
   * Handler principal. Chamado pelo WhatsAppClient para cada message_create.
   */
  async handleMessage(msg: Message): Promise<void> {
    // 1. Loop-guard: ignora próprias mensagens registradas via sendMessage()
    if (this.app.whatsapp.isOwnMessage(msg)) {
      return;
    }

    // 1b. Ignora TODAS as mensagens do próprio bot (msg.fromMe).
    // O bot captura suas próprias respostas explicitamente via
    // context.captureBotResponse() depois que a IA responde — o handler
    // message_create NÃO deve re-capturar (senão duplica no contexto e,
    // se o bot citou uma msg, adiciona o prefixo [respondendo "..."],
    // poluindo o contexto e confundindo a IA).
    // No bot velho, a captura era guardada com `if (!msg.fromMe)` (linhas
    // 4041, 4118, 4138 do index.js). Aqui a gente faz mais simples: ignora
    // fromMe no início do handler.
    if (msg.fromMe) {
      return;
    }

    // 1c. Modo manutenção — loga mas não processa (não captura contexto,
    // não responde IA, não roda comandos). Painel continua funcionando.
    if (this.app.maintenanceMode) {
      this.app.debug('ROUTER', `🔧 modo manutenção — msg ignorada: ${msg.body?.slice(0, 50) || '(sem texto)'}`);
      return;
    }

    // 2. Filtro de msg antiga (timestamp < startup - 10s)
    // Evita reprocessar histórico quando o bot reinicia
    if (!this.isFreshMessage(msg)) {
      return;
    }

    const chatId = msg.fromMe ? msg.to : msg.from;

    // 3. Sticker: handleIncoming (salva no vault + ondas/guerras)
    // Roda ANTES do body check — figurinha não tem body
    if (msg.hasMedia && msg.type === 'sticker') {
      try {
        await this.app.stickers.handleIncoming(msg, chatId);
      } catch (e) {
        this.app.debug('ROUTER', `erro ao processar figurinha: ${(e as Error).message}`);
      }
    }

    // 4. Captura no contexto (texto, figurinha, imagem, quoted, URLs)
    // IMPORTANTE: continua mesmo com IA desativada — o aprendizado (contexto + perfil) roda sempre
    try {
      await this.app.context.captureMessage(msg, chatId);
    } catch (e) {
      this.app.debug('ROUTER', `erro ao capturar msg no contexto: ${(e as Error).message}`);
    }

    // 4b. Registra no historyLog (em tempo real) pra o painel Conversas
    // ter histórico mesmo após o decisionLog limpar entries >2h.
    // Não bloqueia o fluxo se falhar — painel é secundário.
    try {
      const msgAny = msg as any;
      const msgId = msg.id?._serialized || '';
      const text = msg.body ?? '';
      const ts = typeof msg.timestamp === 'number' ? msg.timestamp * 1000 : Date.now();
      let quotedMsgId: string | undefined;
      try {
        if (msgAny.hasQuotedMsg && msgAny.quotedMsgId) {
          quotedMsgId = String(msgAny.quotedMsgId);
        } else if (msgAny._data?.quotedMsg?.id?._serialized) {
          quotedMsgId = msgAny._data.quotedMsg.id._serialized;
        }
      } catch { /* ignora */ }
      // senderName vai ser resolvido pelo context.captureMessage acima (que populou o cache).
      // Tenta lê-lo de forma barata síncrona aqui.
      let senderName = '';
      try {
        // Tenta campos diretos da msg primeiro (mais rápido)
        senderName = msgAny.author || msgAny.sender?.name || msgAny.sender?.pushname || '';
        // Se não tem e o profileBook tem, usa o nome dele
        if (!senderName && msgAny.from) {
          const profile = this.app.profileBook.get(msgAny.from);
          if (profile?.name) senderName = profile.name;
        }
      } catch { /* ignora */ }
      // === DETECÇÃO DE MÍDIA (síncrona — rápida) ===
      // Detecta o tipo de mídia pela propriedade `type` da msg do whatsapp-web.js.
      // Não baixa a mídia aqui (demora) — só registra o tipo.
      // O thumbnail + nome da figurinha vão ser buscados em background abaixo.
      let detectedMediaType: 'sticker' | 'image' | 'video' | 'document' | 'ptt' | 'audio' | undefined;
      const msgType = String(msgAny.type || '').toLowerCase();
      if (msgType === 'sticker') detectedMediaType = 'sticker';
      else if (msgType === 'image') detectedMediaType = 'image';
      else if (msgType === 'video') detectedMediaType = 'video';
      else if (msgType === 'document') detectedMediaType = 'document';
      else if (msgType === 'ptt') detectedMediaType = 'ptt';
      else if (msgType === 'audio') detectedMediaType = 'audio';

      // Pra imagem: msg.body tem a legenda (se tiver). Usa como imageDescription.
      // Pra figurinha: msg.body é vazio.
      const imageDescription = (detectedMediaType === 'image' && text && text.trim().length > 0) ? text.trim() : undefined;

      if (msgId && this.app.retroactive) {
        // Registro síncrono inicial (só com tipo + legenda se tiver)
        this.app.retroactive.recordIncomingMessage(
          chatId,
          msgId,
          senderName,
          text,
          ts,
          !!msg.fromMe,
          quotedMsgId,
          undefined,  // isAudio (vai ser setado pelo brain depois se transcrever)
          'realtime',
          detectedMediaType,
          undefined,  // mediaThumbnail — vai ser preenchido em background abaixo
          undefined,  // stickerName — vai ser preenchido em background abaixo
          imageDescription,
        );
        // Notifica o painel pra fazer auto-refresh (debounce no frontend)
        if (this.app.control) {
          this.app.control.broadcast('conversation-update', { chatId, msgId, fromMe: !!msg.fromMe });
        }

        // === BACKGROUND: baixa mídia e atualiza a entry com thumbnail + nome da figurinha ===
        // Roda em background (sem await) — não bloqueia o fluxo principal do bot.
        // Quando termina, chama recordIncomingMessage de novo (o código detecta entry existente
        // e atualiza só os campos novos).
        if (detectedMediaType === 'sticker' || detectedMediaType === 'image') {
          this.enrichMediaInBackground(msg, chatId, msgId, senderName, text, ts, !!msg.fromMe, quotedMsgId, detectedMediaType, imageDescription);
        }
      }
    } catch (e) {
      this.app.debug('ROUTER', `erro ao registrar msg no historyLog: ${(e as Error).message}`);
    }

    // Se msg sem body (figurinha/áudio sem texto) — captura no contexto foi o último passo.
    // - Figurinha: já disparou onda/guerra no passo 3. IA não responde a figurinha sem texto.
    // - Áudio: NÃO pula aqui! Passa pro brain.maybeAutoRespond — o brain decide
    //   se vai transcrever (baseado em chance/mention/PV) e responder.
    const isAudioMsg = this.app.audioTranscriber?.isAudioMessage(msg) ?? false;
    if (!msg.body && !isAudioMsg) {
      return;
    }

    // 5. Comando? (! ou /) — só faz sentido pra msgs com body
    const isCommand = msg.body ? (msg.body.startsWith('!') || msg.body.startsWith('/')) : false;
    if (!isCommand) {
      // 7. Não-comando → IA decide se responde (texto OU áudio)
      try {
        await this.app.brain.maybeAutoRespond(msg, chatId);
      } catch (e) {
        this.app.debug('ROUTER', `erro no maybeAutoRespond: ${(e as Error).message}`);
      }
      return;
    }

    // === Roteamento de comando ===

    // Atalho // → /admin (preservado do index.js linha 4150)
    let body = msg.body;
    if (body.startsWith('//')) {
      body = '/admin ' + body.slice(2);
      // ⚠️ Muta msg.body intencionalmente — os command handlers leem msg.body diretamente
      // (não recebem `body` como parâmetro). Mudar isso exigiria refatorar CommandRegistry.
      msg.body = body;
    }

    const token = body.split(' ')[0].toLowerCase();
    const def = this.app.commands.getEffectiveDef(token);
    if (!def) {
      // Comando desconhecido OU desativado via override — ignora silenciosamente.
      // (Comando desativado não manda "comando não existe" pra não confundir o usuário.)
      return;
    }

    // Permission gates
    try {
      const sender = await this.app.permissions.resolveSenderIds(msg);
      const senderIsOp = this.app.permissions.isOp(msg.fromMe, sender.all);

      // Banido (não-op) → bloqueia
      if (this.app.permissions.isBanned(sender.all) && !senderIsOp) {
        this.app.debug('ROUTER', `⛔ Bloqueando comando ${token} de usuário banido`);
        try { await msg.react('❌'); } catch { /* ignora */ }
        await this.app.whatsapp.sendMessage(chatId, `${this.app.config.botName}: você foi banido e não pode usar os comandos do bot. 🚫`);
        this.app.log('PERM', `Usuário banido (${sender.all.join(' / ')}) tentou usar ${token} em ${chatId}.`);
        return;
      }

      // effectiveOpOnly → só ops (pode ter vindo do def original OU de override)
      if (def.effectiveOpOnly && !senderIsOp) {
        this.app.debug('ROUTER', `⛔ ${token} é opOnly, sender não é op`);
        try { await msg.react('❌'); } catch { /* ignora */ }
        return;
      }

      // pvOnly → só no PV do bot (NÃO pode ser mudado via override — fica fixo no código)
      if (def.pvOnly && chatId.endsWith('@g.us')) {
        this.app.debug('ROUTER', `⛔ ${token} é pvOnly, chamado em grupo`);
        await this.app.whatsapp.sendMessage(chatId, `${this.app.config.botName}: use este comando no *PV do bot* (não em grupo). 🚫`);
        return;
      }
    } catch (e) {
      this.app.debug('ROUTER', `erro no permission gate: ${(e as Error).message}`);
    }

    // Executa handler
    try {
      this.app.debug('CMD', `executando ${token} em ${chatId}`);
      await def.handler(msg, chatId);
    } catch (e) {
      this.app.debug('CMD', `erro em ${token}: ${(e as Error).message}`);
      try { await msg.react('❌'); } catch { /* ignora */ }
    }
  }

  /**
   * Verifica se a msg é "fresca" (depois do bot ligar + 10s buffer).
   * Evita reprocessar histórico quando o bot reinicia.
   */
  private isFreshMessage(msg: Message): boolean {
    const msgTs = (msg.timestamp || 0) * 1000;
    const startup = this.app.startTime;
    // 10s de buffer pra não perder msgs que chegaram enquanto o bot iniciava
    return msgTs >= (startup - 10000);
  }

  /**
   * Baixa mídia (figurinha/imagem) em background e atualiza a entry no historyLog
   * com thumbnail + nome da figurinha (se tiver).
   *
   * Roda em background (sem await) — não bloqueia o fluxo principal do bot.
   * Quando termina, chama recordIncomingMessage de novo — o código detecta entry
   * existente e atualiza só os campos novos (mediaThumbnail + stickerName).
   *
   * IMPORTANTE: thumbnail é limitado a ~30KB pra não inflar a memória do painel.
   */
  private enrichMediaInBackground(
    msg: Message,
    chatId: string,
    msgId: string,
    senderName: string,
    text: string,
    ts: number,
    fromMe: boolean,
    quotedMsgId: string | undefined,
    mediaType: 'sticker' | 'image',
    imageDescription: string | undefined,
  ): void {
    // Não usa await — roda em background
    (async () => {
      try {
        if (!this.app.retroactive) return;

        // 1. Baixa a mídia
        const media = await msg.downloadMedia();
        if (!media || !media.data) {
          this.app.debug('ROUTER', `enrichMedia: mídia vazia pra ${msgId}`);
          return;
        }

        // 2. Gera thumbnail base64 data URL
        // Pra figurinha: webp (geralmente ~10-30KB)
        // Pra imagem: pode ser grande — limita a 50KB (aumenta compressão base64)
        const mime = media.mimetype || (mediaType === 'sticker' ? 'image/webp' : 'image/jpeg');
        const mediaSize = Math.floor(media.data.length * 0.75); // base64 → bytes aprox
        const MAX_SIZE = 60 * 1024; // 60KB — limite pra não inflar memória do painel

        let thumbnail: string;
        if (mediaSize <= MAX_SIZE) {
          // Cabe no limite — usa direto
          thumbnail = `data:${mime};base64,${media.data}`;
        } else {
          // Passa do limite — NÃO usa o thumbnail (painel vai mostrar placeholder)
          // Não vamos redimensionar (precisa de lib externa). Pra imagem grande,
          // mostra só o tipo + descrição/legenda.
          this.app.debug('ROUTER', `enrichMedia: mídia muito grande (${(mediaSize / 1024).toFixed(0)}KB) — pulando thumbnail`);
          thumbnail = '';
        }

        // 3. Se for figurinha, tenta identificar pelo nome no vault
        let stickerName: string | undefined;
        if (mediaType === 'sticker') {
          const identified = await this.app.stickers.identify(msg);
          if (identified?.name) {
            stickerName = identified.name;
            this.app.debug('ROUTER', `enrichMedia: figurinha identificada — "${stickerName}"`);
          } else {
            this.app.debug('ROUTER', `enrichMedia: figurinha sem nome no vault`);
          }
        }

        // 4. Atualiza a entry no historyLog (recordIncomingMessage detecta entry existente)
        this.app.retroactive.recordIncomingMessage(
          chatId,
          msgId,
          senderName,
          text,
          ts,
          fromMe,
          quotedMsgId,
          undefined,
          'realtime',
          mediaType,
          thumbnail || undefined,
          stickerName,
          imageDescription,
        );

        // 5. Notifica o painel que a msg foi enriquecida (vai re-renderizar)
        if (this.app.control) {
          this.app.control.broadcast('conversation-update', { chatId, msgId, fromMe });
        }

        this.app.debug('ROUTER', `enrichMedia: ✅ mídia enriquecida pra ${msgId}${stickerName ? ` (figurinha: ${stickerName})` : ''}`);
      } catch (e) {
        this.app.debug('ROUTER', `enrichMedia: erro em background: ${(e as Error).message}`);
      }
    })();
  }
}
