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
 *  5. Twitter approval (se pendingTweets.has(chatId) e body = postar/descartar)
 *  6. Comando? (! ou /):
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
 *  - this.app.twitter — maybeHandleApproval (Fase 3.5, opcional)
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

    // Se msg sem body (figurinha/áudio) — captura no contexto foi o último passo.
    // Figurinha pode ter disparado onda/guerra no passo 3. IA não responde a figurinha sem texto.
    if (!msg.body) {
      return;
    }

    // 5. Twitter approval (se app.twitter existir — Fase 3.5)
    if (this.app.twitter) {
      try {
        const handled = await this.app.twitter.maybeHandleApproval(msg, chatId);
        if (handled) return;
      } catch (e) {
        this.app.debug('ROUTER', `erro no twitter approval: ${(e as Error).message}`);
      }
    }

    // 6. Comando? (! ou /)
    const isCommand = msg.body.startsWith('!') || msg.body.startsWith('/');
    if (!isCommand) {
      // 7. Não-comando → IA decide se responde
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
      msg.body = body;  // muta o body pra os handlers lerem o reescrito
    }

    const token = body.split(' ')[0].toLowerCase();
    const def = this.app.commands.lookup(token);
    if (!def) {
      // Comando desconhecido — ignora silenciosamente (igual bot velho)
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

      // opOnly → só ops
      if (def.opOnly && !senderIsOp) {
        this.app.debug('ROUTER', `⛔ ${token} é opOnly, sender não é op`);
        try { await msg.react('❌'); } catch { /* ignora */ }
        return;
      }

      // pvOnly → só no PV do bot
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
}
