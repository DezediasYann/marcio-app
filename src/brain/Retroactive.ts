/**
 * Retroactive — sistema de conversas retroativas.
 *
 * O bot "volta" a mensagens que ignorou em tempo real. A cada N minutos
 * (default 10), olha as mensagens 'pending' dos últimos M minutos (default 60),
 * pede pra IA escolher UMA pra iniciar conversa, e responde.
 *
 * Uma vez avaliadas, as decisões são permanentes — o bot nunca reconsidera.
 *
 * === DECISION LOG ===
 * Formato (preservado do index.js velho):
 *   data/decision-log.json = { chatId: [{ msgId, senderName, text, timestamp, decision }] }
 *
 * Estados:
 *   'pending'    — ainda não avaliada (candidata a retroativo)
 *   'skip'       — avaliada, bot decidiu não responder (final)
 *   'responded'  — bot respondeu (final)
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.brain         → generateResponse, sendResponse (pra resposta retroativa)
 *  - this.app.context       → captureBotResponse
 *  - this.app.whatsapp      → client.getChatById, client.getMessageById
 *  - this.app.aiConfig      → enabled check
 *  - this.app.brain.aiDisabledChats / democraticallyMutedChats / lastAutoResponse
 *
 * Preservado byte-a-byte do index.js velho (linhas 656-765, 2885-3151, 6734-6743).
 */

import type { MarcioApp } from '../MarcioApp';
import fs from 'node:fs';

// ============================================================================
// TIPOS
// ============================================================================

export type Decision = 'pending' | 'skip' | 'responded' | 'backfill';

export interface DecisionEntry {
  msgId: string;
  senderName: string;
  text: string;
  timestamp: number;
  decision: Decision;
  /** Texto da resposta do bot (se decision='responded'). */
  botResponse?: string;
  /** Timestamp da resposta do bot (se decision='responded'). */
  botResponseTimestamp?: number;
  /** ID da mensagem que o bot citou ao responder (se applicável). */
  quotedMsgId?: string;
  /** ID da resposta do bot (para quote bidirecional). */
  botResponseMsgId?: string;
  /** true se essa msg era um áudio (transcrito). Pra painel mostrar badge. */
  isAudio?: boolean;
}

/**
 * Entry do historyLog — mensagens backfilled do histórico do WhatsApp
 * (não passaram pelo bot em tempo real). Decision é sempre 'backfill'.
 */
export interface HistoryEntry {
  msgId: string;
  senderName: string;
  text: string;
  timestamp: number;
  fromMe: boolean;
  /** Se essa msg é resposta do bot a outra msg, guarda o msgId da msg original. */
  quotedMsgId?: string;
  /** true se essa msg era um áudio (transcrito ou não). Pra painel mostrar badge. */
  isAudio?: boolean;
  /**
   * Origem da entry:
   *  - 'realtime': msg chegou em tempo real (via MessageRouter ou brain) — NÃO é histórico.
   *  - 'backfill': msg veio do backfill (busca do histórico do WhatsApp) — é histórico.
   * Default: 'realtime' (maioria dos casos). Só backfillHistory seta 'backfill'.
   */
  source?: 'realtime' | 'backfill';
}

// ============================================================================
// RETROACTIVE
// ============================================================================

export class Retroactive {
  private app: MarcioApp;

  /** chatId → entries[]. Cache em memória. */
  private decisionLog = new Map<string, DecisionEntry[]>();
  private dirty = false;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;

  /**
   * chatId → HistoryEntry[]. Backfill do histórico do WhatsApp (mensagens
   * antigas, mesmo de quando o bot estava desligado). Populado por
   * backfillHistory() após WhatsApp 'ready'. Não persiste em disco (é
   * re-fetchado a cada boot — WhatsApp cache local cobre isso).
   */
  private historyLog = new Map<string, HistoryEntry[]>();

  /** Flag pra não rodar backfill 2x (idempotente). */
  private backfillDone = false;

  // === Flags runtime-tunable (via /admin features na Fase 3) ===
  enabled = true;
  intervalMin = 10;
  windowMin = 60;

  constructor(app: MarcioApp) {
    this.app = app;
    // Auto-save a cada 30s
    this.autoSaveTimer = setInterval(() => {
      if (this.dirty) this.save();
    }, 30000);
  }

  // ===========================================================================
  // LOAD / SAVE
  // ===========================================================================

  /**
   * Carrega decision-log.json do disco pro Map. Chamado no boot.
   */
  load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.app.dataPath('decision-log.json'), 'utf8'));
      for (const [chatId, entries] of Object.entries(data)) {
        this.decisionLog.set(chatId, entries as DecisionEntry[]);
      }
      this.app.debug('DECISION', `log carregado: ${this.decisionLog.size} chat(s) com decisões`);
    } catch {
      // empty - no log yet
    }
  }

  /**
   * Salva o Map em decision-log.json.
   */
  save(): void {
    try {
      const obj: Record<string, DecisionEntry[]> = {};
      for (const [chatId, entries] of this.decisionLog) {
        obj[chatId] = entries;
      }
      fs.writeFileSync(this.app.dataPath('decision-log.json'), JSON.stringify(obj, null, 2), 'utf8');
      this.dirty = false;
    } catch (e) {
      this.app.debug('DECISION', `erro ao salvar log de decisões: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // MARK / HAS
  // ===========================================================================

  /**
   * Marca a decisão sobre uma mensagem.
   *  - Limpa entradas antigas (>2h) pra não crescer infinitamente.
   *  - Se já existe entrada: só atualiza se a decisão atual é 'pending'
   *    (não muda decisão final).
   *  - Senão: adiciona nova entrada.
   */
  markDecision(chatId: string, msgId: string, senderName: string, text: string, decision: Decision): void {
    if (!this.decisionLog.has(chatId)) this.decisionLog.set(chatId, []);
    const entries = this.decisionLog.get(chatId)!;

    // Limpa entradas antigas (>2h)
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    const filtered = entries.filter(e => e.timestamp > twoHoursAgo);

    // Verifica se já tem decisão pra essa msg
    const existing = filtered.find(e => e.msgId === msgId);
    if (existing) {
      // Só atualiza se a decisão atual é 'pending' (não muda decisão final)
      if (existing.decision === 'pending') {
        existing.decision = decision;
      }
    } else {
      filtered.push({
        msgId,
        senderName,
        text: (text || '').slice(0, 200),
        timestamp: Date.now(),
        decision,
      });
    }

    this.decisionLog.set(chatId, filtered);
    this.dirty = true;
  }

  /**
   * Registra a resposta do bot a uma mensagem. Atualiza a entry existente
   * com botResponse, botResponseTimestamp, quotedMsgId e botResponseMsgId.
   * Se a entry não existe, cria uma com decision='responded'.
   *
   * @param chatId Chat onde aconteceu.
   * @param originalMsgId ID da msg que o bot respondeu.
   * @param botResponseText Texto da resposta do bot.
   * @param botResponseMsgId ID da msg de resposta (se disponível).
   * @param quotedMsgId ID da msg citada (se aplicável — geralmente = originalMsgId).
   */
  recordBotResponse(
    chatId: string,
    originalMsgId: string,
    botResponseText: string,
    botResponseMsgId?: string,
    quotedMsgId?: string,
  ): void {
    if (!this.decisionLog.has(chatId)) this.decisionLog.set(chatId, []);
    const entries = this.decisionLog.get(chatId)!;

    const existing = entries.find(e => e.msgId === originalMsgId);
    const now = Date.now();
    const responseText = (botResponseText || '').slice(0, 500);

    if (existing) {
      existing.decision = 'responded';
      existing.botResponse = responseText;
      existing.botResponseTimestamp = now;
      existing.quotedMsgId = quotedMsgId;
      existing.botResponseMsgId = botResponseMsgId;
    } else {
      entries.push({
        msgId: originalMsgId,
        senderName: '',
        text: '',
        timestamp: now,
        decision: 'responded',
        botResponse: responseText,
        botResponseTimestamp: now,
        quotedMsgId,
        botResponseMsgId,
      });
    }

    this.dirty = true;
    this.app.debug('DECISION', `resposta do bot registrada pra msg ${originalMsgId} em ${chatId}: "${responseText.slice(0, 40)}..."`);
  }

  /**
   * Adiciona uma mensagem nova ao historyLog em tempo real (sem passar
   * pelo backfill). Isso garante que o painel "Conversas" mostre msgs novas
   * mesmo depois que o decisionLog (com TTL 2h) as limpar.
   *
   * Diferenças vs markDecision:
   *  - historyLog NÃO tem cleanup de 2h (é histórico permanente da sessão).
   *  - Não tem máquina de estados (pending/skip/responded) — só registra
   *    que a msg chegou. O decision no painel aparece como 'backfill'
   *    (ou 'unknown' se decision-log não tem a mesma msgId).
   *  - Não persiste em disco (igual ao restante do historyLog).
   *
   * Diferenças vs backfillHistory:
   *  - backfillHistory busca do WhatsApp em batch (100 msgs de 30 chats).
   *  - recordIncomingMessage é chamado pelo MessageRouter pra cada msg
   *    nova que chega — uma de cada vez, em tempo real.
   *
   * Dedup por msgId: se a msg já está no historyLog (backfill já pegou),
   * atualiza com os dados mais frescos (senderName pode ter melhorado).
   *
   * @param chatId Chat onde a msg chegou.
   * @param msgId ID serializado da msg.
   * @param senderName Nome de quem mandou ('' se for o bot).
   * @param text Texto da msg.
   * @param timestamp epoch ms.
   * @param fromMe true se foi o próprio bot quem mandou.
   * @param quotedMsgId ID da msg citada (se aplicável).
   * @param isAudio true se essa msg era um áudio (transcrito). Default false.
   * @param source 'realtime' (default) se chegou em tempo real, 'backfill' se veio do backfill.
   */
  recordIncomingMessage(
    chatId: string,
    msgId: string,
    senderName: string,
    text: string,
    timestamp: number,
    fromMe: boolean,
    quotedMsgId?: string,
    isAudio?: boolean,
    source: 'realtime' | 'backfill' = 'realtime',
  ): void {
    if (!chatId || !msgId) return;
    const trimmed = (text || '').slice(0, 500);
    // Só guarda msgs com texto não-vazio (pula figurinha/áudio/documento sem body)
    if (!trimmed || trimmed.trim().length < 1) return;
    // Pula placeholders internos
    if (/^\[(mandou|CONTEÚDO|respondendo)/.test(trimmed)) return;

    if (!this.historyLog.has(chatId)) this.historyLog.set(chatId, []);
    const entries = this.historyLog.get(chatId)!;

    const existing = entries.find(e => e.msgId === msgId);
    if (existing) {
      // Atualiza senderName se ficou melhor (backfill às vezes pega '?')
      if (senderName && senderName !== '?' && (existing.senderName === '?' || !existing.senderName)) {
        existing.senderName = senderName;
      }
      // Marca isAudio se essa chamada sabe que é áudio (mesmo se já tinha entry sem isAudio)
      if (isAudio && !existing.isAudio) existing.isAudio = true;
      // Se a entry existente é 'backfill' mas essa chamada é 'realtime', atualiza pra 'realtime'
      // (msg chegou em tempo real depois do backfill ter pego — prioridade pra realtime).
      if (source === 'realtime' && existing.source !== 'realtime') {
        existing.source = 'realtime';
      }
      // Não muda mais nada (text/timestamp já estão corretos)
      return;
    }

    entries.push({
      msgId,
      senderName: fromMe ? '' : (senderName || '?'),
      text: trimmed,
      timestamp,
      fromMe,
      quotedMsgId,
      isAudio: isAudio === true ? true : undefined,  // só seta se true (pra não poluir JSON)
      source,  // 'realtime' ou 'backfill'
    });

    // Mantém o cap de 200 msgs por chat (descarta as mais antigas)
    // 200 é espaço suficiente pra histórico útil sem inflar memória.
    if (entries.length > 200) {
      entries.splice(0, entries.length - 200);
    }

    this.app.debug('HISTORY', `msg registrada em ${chatId} (total: ${entries.length})${isAudio ? ' [áudio]' : ''} [${source}] — "${trimmed.slice(0, 40)}..."`);
  }

  /**
   * Verifica se uma mensagem já tem decisão final (skip ou responded).
   * Usado pelo Brain.maybeAutoRespond pra não reprocessar msgs já decididas.
   */
  hasDecision(chatId: string, msgId: string): boolean {
    const entries = this.decisionLog.get(chatId) || [];
    const existing = entries.find(e => e.msgId === msgId);
    return !!(existing && (existing.decision === 'skip' || existing.decision === 'responded'));
  }

  /**
   * Conta mensagens pending num chat (pra /admin retro status na Fase 3).
   */
  pendingCount(chatId: string): number {
    const entries = this.decisionLog.get(chatId) || [];
    return entries.filter(e => e.decision === 'pending').length;
  }

  /**
   * Extrai as últimas N mensagens de TODOS os chats pra uso externo
   * (ex: gerar tweet, painel de conversas). Tem senderName + text + timestamp
   * + decision + chatId — muito melhor que ler bot.log (que não tem nome).
   *
   * @param maxMsgs Qtde máxima de mensagens.
   * @returns Array ordenadas por timestamp (mais recentes primeiro).
   */
  getRecentMessages(maxMsgs: number): Array<{ senderName: string; text: string; timestamp: number; chatId: string; decision: string }> {
    const all: Array<{ senderName: string; text: string; timestamp: number; chatId: string; decision: string }> = [];
    for (const [chatId, entries] of this.decisionLog) {
      for (const e of entries) {
        if (e.text && e.text.trim().length >= 3) {
          all.push({
            senderName: e.senderName || 'Alguém',
            text: e.text,
            timestamp: e.timestamp,
            chatId,
            decision: e.decision || 'unknown',
          });
        }
      }
    }
    // Ordena por timestamp (mais recente primeiro)
    all.sort((a, b) => b.timestamp - a.timestamp);
    return all.slice(0, maxMsgs);
  }

  // ===========================================================================
  // BACKFILL HISTORY — busca mensagens antigas do WhatsApp após 'ready'
  // ===========================================================================

  /**
   * Busca mensagens antigas dos chats mais ativos do WhatsApp e popula
   * `historyLog`. Roda uma vez após o evento 'ready' do WhatsApp.
   *
   * O objetivo: o painel "Conversas" mostra mensagens que o bot processou
   * (decision-log), mas essas só existem pra msgs em tempo real. Se o bot
   * estava desligado ou é a primeira execução, o painel fica vazio. Este
   * backfill busca até `maxMsgsPerChat` mensagens dos `maxChats` chats mais
   * ativos pra que o painel tenha conteúdo histórico.
   *
   * Idempotente: se já rodou (backfillDone=true), retorna imediatamente.
   * Passe `force=true` pra pular a guarda de idempotência e re-buscar tudo.
   *
   * @param maxChats Quantos chats mais ativos backfillar (default 30).
   * @param maxMsgsPerChat Quantas msgs buscar por chat (default 100).
   * @param force Se true, re-roda mesmo que já tenha rodado antes (reset backfillDone).
   */
  async backfillHistory(
    maxChats = 30,
    maxMsgsPerChat = 100,
    force = false
  ): Promise<{ chats: number; msgs: number }> {
    if (this.backfillDone && !force) {
      this.app.debug('BACKFILL', 'já foi executado — pulando (use force=true pra re-rodar)');
      return { chats: 0, msgs: 0 };
    }
    if (force && this.backfillDone) {
      this.app.log('BACKFILL', 'force=true — re-buscando histórico (reset backfillDone)');
      // Limpa historyLog antigo pra evitar msgs duplicadas no merge
      this.historyLog.clear();
    }
    this.backfillDone = true;

    this.app.log('BACKFILL', `iniciando: buscando até ${maxMsgsPerChat} msgs dos ${maxChats} chats mais ativos…`);
    let totalMsgs = 0;
    let totalChats = 0;

    try {
      // Guard: se client não existe ou não tem getChats, falha graciosamente
      const client = this.app.whatsapp?.client;
      if (!client || typeof client.getChats !== 'function') {
        this.app.log('BACKFILL', `❌ WhatsApp client não disponível — pulando (tentará no próximo boot)`);
        this.backfillDone = false;
        return { chats: 0, msgs: 0 };
      }
      const chats = await client.getChats();
      // Ordena por timestamp (mais recente primeiro) — pega os mais ativos
      const sorted = (chats as any[])
        .filter(c => c && typeof c.timestamp === 'number' && c.timestamp > 0)
        .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        .slice(0, maxChats);

      this.app.debug('BACKFILL', `${sorted.length} chats candidatos (de ${chats.length} total)`);

      for (const chat of sorted) {
        const chatId = chat.id?._serialized || chat.id?.id;
        if (!chatId) continue;
        try {
          // fetchMessages retorna do mais novo pro mais velho
          const msgs = await chat.fetchMessages(maxMsgsPerChat);
          if (!msgs || !msgs.length) continue;

          // Cache de contatos por ID pra evitar múltiplas chamadas getContact
          const contactCache = new Map<string, { name?: string; pushname?: string; number?: string }>();

          const entries: HistoryEntry[] = [];
          for (const m of msgs) {
            // Só inclui msgs de texto (pula figurinhas, áudio, etc.)
            const body = m.body ?? '';
            if (!body || body.trim().length < 1) continue;
            // Pula placeholders internos
            if (/^\[(mandou|CONTEÚDO|respondendo)/.test(body)) continue;

            const fromMe = !!(m.fromMe || m.id?.fromMe);
            let senderName = '';
            let quotedMsgId: string | undefined;

            if (fromMe) {
              senderName = '';  // bot — display trata
            } else {
              // Tentativa 1: campos diretos da msg
              senderName = m.author || m.sender?.name || m.sender?.pushname || '';
              // Tentativa 2: getContact (mais confiável, mas async)
              if (!senderName && m.sender?._serialized) {
                let contact = contactCache.get(m.sender._serialized);
                if (!contact) {
                  try {
                    const c = await m.getContact();
                    contact = {
                      name: c?.name || undefined,
                      pushname: c?.pushname || undefined,
                      number: c?.number || undefined,
                    };
                    contactCache.set(m.sender._serialized, contact);
                  } catch { /* ignora */ }
                }
                senderName = contact?.name || contact?.pushname || '';
                // Se ainda não tem nome, usa o número (melhor que "Alguém")
                if (!senderName && contact?.number) {
                  // Formata número BR: 5511989744468 → (11) 98974-4468
                  const num = contact.number;
                  if (num.length >= 12) {
                    const ddd = num.slice(2, 4);
                    const part1 = num.slice(4, num.length - 4);
                    const part2 = num.slice(-4);
                    senderName = `(${ddd}) ${part1}-${part2}`;
                  } else {
                    senderName = num;
                  }
                }
              }
              // Tentativa 3: fallback pro nome do chat (PV)
              if (!senderName && chat.contact?.name) {
                senderName = chat.contact.name;
              }
              // Se ainda não tem nome, marca como desconhecido
              // (não usa "Alguém" no data — o frontend decide o display)
              if (!senderName) {
                senderName = '?';
              }
            }

            // Extrai quotedMsgId se a msg respondeu outra
            try {
              if (m.hasQuotedMsg && m.quotedMsgId) {
                quotedMsgId = String(m.quotedMsgId);
              } else if (m._data?.quotedMsg?.id?._serialized) {
                quotedMsgId = m._data.quotedMsg.id._serialized;
              }
            } catch { /* ignora */ }

            entries.push({
              msgId: m.id?._serialized || String(m.id?.id || ''),
              senderName: String(senderName || ''),
              text: String(body).slice(0, 500),
              timestamp: typeof m.timestamp === 'number' ? m.timestamp * 1000 : Date.now(),
              fromMe,
              quotedMsgId,
              source: 'backfill',  // marca como histórico (não tempo real)
            });
          }

          if (entries.length > 0) {
            // Ordena por timestamp asc (mais antigo → mais novo, pra display cronológico)
            entries.sort((a, b) => a.timestamp - b.timestamp);
            this.historyLog.set(chatId, entries);
            totalChats++;
            totalMsgs += entries.length;
          }
        } catch (e) {
          this.app.debug('BACKFILL', `erro ao buscar msgs de ${chatId}: ${(e as Error).message}`);
        }
      }

      this.app.log('BACKFILL', `✓ concluído: ${totalChats} chat(s), ${totalMsgs} msg(s) backfilladas`);
    } catch (e) {
      this.app.log('BACKFILL', `❌ erro geral: ${(e as Error).message}`);
      // Reset flag pra permitir tentar de novo no próximo boot
      this.backfillDone = false;
    }

    return { chats: totalChats, msgs: totalMsgs };
  }

  /**
   * Retorna as mensagens backfilled de um chat (ou vazio).
   */
  getHistory(chatId: string): HistoryEntry[] {
    return this.historyLog.get(chatId) ?? [];
  }

  /**
   * Retorna todos os chatIds que têm conteúdo (decision-log OU history-log).
   */
  allChatIds(): string[] {
    const ids = new Set<string>();
    for (const id of this.decisionLog.keys()) ids.add(id);
    for (const id of this.historyLog.keys()) ids.add(id);
    return Array.from(ids);
  }

  /**
   * Monta a lista de conversas agrupada por chat, mesclando decision-log
   * (msgs em tempo real, com decisão) + history-log (backfill, decision='backfill').
   * Dedup por msgId.
   *
   * Cada msg retornada pode ter:
   *  - senderName: nome de quem mandou ('' = bot)
   *  - text: conteúdo
   *  - timestamp: epoch ms
   *  - decision: pending|skip|responded|backfill
   *  - botResponse: texto da resposta do bot (se bot respondeu)
   *  - botResponseTimestamp: timestamp da resposta
   *  - quotedMsgId: ID da msg que esta cita (se aplicável)
   *  - fromMe: true se foi o bot quem mandou
   *
   * @param maxPerChat Máximo de mensagens por chat (default 100).
   * @returns Array de { chatId, messages[] } ordenado por última atividade.
   */
  getConversations(maxPerChat = 100): Array<{
    chatId: string;
    messages: Array<{
      senderName: string;
      text: string;
      timestamp: number;
      decision: string;
      botResponse?: string;
      botResponseTimestamp?: number;
      quotedMsgId?: string;
      fromMe: boolean;
      isAudio?: boolean;
    }>;
  }> {
    const allChatIds = this.allChatIds();
    const result: Array<{ chatId: string; messages: Array<any> }> = [];

    for (const chatId of allChatIds) {
      const seen = new Set<string>();
      const merged: Array<any> = [];

      // 1. Decision-log (msgs em tempo real — têm decisão real: pending/skip/responded)
      const decEntries = this.decisionLog.get(chatId) || [];
      for (const e of decEntries) {
        if (seen.has(e.msgId)) continue;
        if (!e.text || e.text.trim().length < 1) continue;
        seen.add(e.msgId);
        merged.push({
          msgId: e.msgId,
          senderName: e.senderName || '?',
          text: e.text,
          timestamp: e.timestamp,
          decision: e.decision || 'unknown',
          botResponse: e.botResponse,
          botResponseTimestamp: e.botResponseTimestamp,
          quotedMsgId: e.quotedMsgId,
          fromMe: false,  // decision-log só tem msgs de usuários
          isAudio: e.isAudio === true ? true : undefined,
        });
        // Se tem botResponse, adiciona como msg separada do bot.
        // Se tem botResponseMsgId real, usa ele; senão gera ID sintético pra garantir
        // que a resposta do bot sempre apareça no painel (bug fix: respostas no PV sumiam).
        if (e.botResponse) {
          const responseMsgId = e.botResponseMsgId || `bot-response-${e.msgId}`;
          if (!seen.has(responseMsgId)) {
            seen.add(responseMsgId);
            merged.push({
              msgId: responseMsgId,
              senderName: '',  // bot
              text: e.botResponse,
              timestamp: e.botResponseTimestamp || e.timestamp,
              decision: 'responded',
              quotedMsgId: e.msgId,  // a resposta cita a msg original
              fromMe: true,
              isAudio: undefined,  // resposta do bot não é áudio
            });
          }
        }
      }

      // 2. History-log
      //  - source='realtime' → msg chegou em tempo real mas bot não processou/decidiu
      //    (decision='received' — NÃO é histórico, é msg nova sem resposta do bot)
      //  - source='backfill' → msg veio do backfill do WhatsApp (decision='backfill' — histórico antigo)
      const histEntries = this.historyLog.get(chatId) || [];
      for (const h of histEntries) {
        if (seen.has(h.msgId)) continue;
        if (!h.text || h.text.trim().length < 1) continue;
        seen.add(h.msgId);
        const isBackfill = h.source === 'backfill';
        merged.push({
          msgId: h.msgId,
          senderName: h.fromMe ? '' : (h.senderName || '?'),
          text: h.text,
          timestamp: h.timestamp,
          decision: isBackfill ? 'backfill' : 'received',
          quotedMsgId: h.quotedMsgId,
          fromMe: h.fromMe,
          isAudio: h.isAudio === true ? true : undefined,
        });
      }

      if (merged.length === 0) continue;

      // Ordena por timestamp asc (cronológico)
      merged.sort((a, b) => a.timestamp - b.timestamp);

      // Cap no máximo (pega os mais recentes)
      const capped = merged.slice(-maxPerChat);

      result.push({ chatId, messages: capped });
    }

    // Ordena chats por última atividade (mais recente primeiro)
    result.sort((a, b) => {
      const aLast = a.messages.length ? a.messages[a.messages.length - 1].timestamp : 0;
      const bLast = b.messages.length ? b.messages[b.messages.length - 1].timestamp : 0;
      return bLast - aLast;
    });

    return result;
  }

  /**
   * Limpa a decision log de um chat (ou tudo). Pra //retro limpar.
   */
  clear(chatId?: string): void {
    if (chatId) {
      this.decisionLog.delete(chatId);
    } else {
      this.decisionLog.clear();
    }
    this.dirty = true;
    this.save();
  }

  // ===========================================================================
  // CHECK — roda a cada N minutos, avalia pendings, responde 1 por chat
  // ===========================================================================

  /**
   * Verifica mensagens 'pending' em todos os chats e, onde há volume suficiente
   * (3+), pede pra IA escolher uma pra iniciar conversa retroativa.
   *
   * Fluxo (preservado byte-a-byte do checkRetroactiveConversations):
   *  1. Pula se IA desativada ou retroativo desligado.
   *  2. Itera chatIds do decisionLog.
   *  3. Pula chats com IA desativada/mutada.
   *  4. Filtra 'pending' dos últimos windowMin com text >= 3 chars.
   *  5. Se < 3 pending, pula o chat.
   *  6. Respeita cooldown (brain.lastAutoResponse).
   *  7. Monta lista numerada, chama IA pra escolher (maxOutputTokens 10, temp 0.3).
   *  8. Se NENHUMA: marca todas skip.
   *  9. Se número válido: marca escolhida responded, outras skip, gera resposta.
   * 10. Tenta citar a msg original (quoted). Se muito antiga, manda sem citar.
   */
  async check(): Promise<void> {
    if (!this.app.aiConfig?.enabled) return;
    if (!this.enabled) return;

    const now = Date.now();
    const windowMs = this.windowMin * 60 * 1000;
    const windowAgo = now - windowMs;
    let totalChatsChecked = 0;
    let totalResponsesSent = 0;

    // Itera sobre cópia das chaves (Map pode ser modificado durante o loop)
    const chatIds = Array.from(this.decisionLog.keys());

    for (const chatId of chatIds) {
      // Pula chats com IA desativada/mutada
      if (this.app.brain.aiDisabledChats.has(chatId)) continue;
      if (this.app.brain.democraticallyMutedChats.has(chatId)) continue;

      const entries = this.decisionLog.get(chatId) || [];

      // Pega pending dos últimos windowMin com text >= 3 chars
      const pending = entries.filter(e =>
        e.decision === 'pending' &&
        e.timestamp > windowAgo &&
        e.text && e.text.trim().length >= 3
      );

      if (pending.length < 3) continue;  // precisa de 3+ pra valer a pena

      totalChatsChecked++;
      this.app.debug('RETRO', `avaliando ${pending.length} mensagens pending em ${chatId}`);

      // Respeita cooldown
      const last = this.app.brain.lastAutoResponse.get(chatId) || 0;
      const cooldownMs = 30000;  // AI_DEFAULTS.cooldownMs
      if (now - last < cooldownMs) {
        this.app.debug('RETRO', `chat ${chatId} em cooldown (${Math.round((cooldownMs - (now - last)) / 1000)}s restantes) — pulando`);
        continue;
      }

      // Monta lista numerada
      const lines = pending.map((e, i) => {
        const name = e.senderName || 'Alguém';
        const minsAgo = Math.max(1, Math.round((now - e.timestamp) / 60000));
        return `${i + 1}. [${name}, há ${minsAgo}min]: ${e.text}`;
      });

      const systemPrompt = [
        'Você é um robô de grupo do WhatsApp. Aqui estão mensagens recentes que você não respondeu.',
        'Escolha UMA (no máximo) que seria interessante iniciar uma conversa ou comentar.',
        'Responda SÓ com o número da mensagem (1, 2, 3...) ou "NENHUMA" se nenhuma é interessante o suficiente.',
        'Seja seletivo — só escolha uma se realmente tiver algo a dizer.',
      ].join('\n');
      const userContent = lines.join('\n');

      // Chama IA pra escolher
      let choiceRaw: string;
      try {
        choiceRaw = await this.callSelectionAI(systemPrompt, userContent);
      } catch (e) {
        this.app.debug('RETRO', `erro ao consultar IA em ${chatId}: ${(e as Error).message}`);
        continue;
      }

      if (!choiceRaw) {
        this.app.debug('RETRO', `resposta vazia da IA em ${chatId}`);
        continue;
      }

      const trimmed = choiceRaw.trim().toUpperCase();
      this.app.debug('RETRO', `IA respondeu "${trimmed}" em ${chatId}`);

      // Caso 1: NENHUMA — marca todas skip
      if (trimmed === 'NENHUMA' || trimmed.includes('NENHUM') || trimmed.includes('NENHUMA')) {
        for (const e of pending) {
          this.markDecision(chatId, e.msgId, e.senderName, e.text, 'skip');
        }
        this.app.debug('RETRO', `${pending.length} mensagens marcadas como skip (NENHUMA) em ${chatId}`);
        continue;
      }

      // Caso 2: extrai número
      const numMatch = trimmed.match(/\d+/);
      if (!numMatch) {
        for (const e of pending) {
          this.markDecision(chatId, e.msgId, e.senderName, e.text, 'skip');
        }
        this.app.debug('RETRO', `resposta sem número reconhecível ("${trimmed}") em ${chatId} — todas marcadas skip`);
        continue;
      }

      const chosenIdx = parseInt(numMatch[0], 10) - 1;
      if (chosenIdx < 0 || chosenIdx >= pending.length) {
        for (const e of pending) {
          this.markDecision(chatId, e.msgId, e.senderName, e.text, 'skip');
        }
        this.app.debug('RETRO', `número ${numMatch[0]} fora do range em ${chatId} — todas marcadas skip`);
        continue;
      }

      const chosen = pending[chosenIdx];

      // Marca escolhida responded, outras skip
      for (let i = 0; i < pending.length; i++) {
        const e = pending[i];
        this.markDecision(chatId, e.msgId, e.senderName, e.text, i === chosenIdx ? 'responded' : 'skip');
      }

      this.app.debug('RETRO', `IA escolheu msg ${chosenIdx + 1} de ${chosen.senderName} em ${chatId}: "${chosen.text.slice(0, 50)}..." — gerando resposta`);

      // Gera e envia a resposta retroativa
      try {
        // Typing indicator
        let typingChat: any = null;
        let typingInterval: NodeJS.Timeout | null = null;
        try {
          typingChat = await this.app.whatsapp.client.getChatById(chatId);
          await typingChat.sendStateTyping();
          typingInterval = setInterval(async () => {
            try { if (typingChat) await typingChat.sendStateTyping(); } catch { /* ignora */ }
          }, 20000);
        } catch (e) {
          this.app.debug('RETRO', `erro ao ativar digitando em ${chatId}: ${(e as Error).message}`);
        }
        const stopTyping = () => {
          if (typingInterval) clearInterval(typingInterval);
          if (typingChat) { try { typingChat.clearStateTyping(); } catch { /* ignora */ } }
        };

        try {
          // isDirect=true faz a IA responder naturalmente ao contexto atual
          const reply = await this.app.brain.generateResponse(chatId, true);

          // [SILENCIO] ou vazio: desiste
          if (reply && /^\s*\[SILENCIO\]\s*$/i.test(reply.trim())) {
            this.app.debug('RETRO', `IA decidiu silêncio na resposta retroativa em ${chatId}`);
            stopTyping();
            continue;
          }
          if (!reply || !reply.trim() || reply.trim() === '...') {
            this.app.debug('RETRO', `resposta vazia na conversa retroativa em ${chatId}`);
            stopTyping();
            continue;
          }

          // Tenta citar a msg original
          let quotedId: string | undefined;
          if (chosen.msgId && chosen.msgId.includes('@')) {
            try {
              const quotedMsg = await this.app.whatsapp.client.getMessageById(chosen.msgId);
              if (quotedMsg) {
                quotedId = chosen.msgId;
                this.app.debug('RETRO', `respondendo com citação da msg ${chosen.msgId}`);
              }
            } catch (e) {
              this.app.debug('RETRO', `não conseguiu citar msg ${chosen.msgId}: ${(e as Error).message} — respondendo sem citar`);
            }
          }

          const sentText = await this.app.brain.sendResponse(chatId, reply, quotedId);
          this.app.brain.lastAutoResponse.set(chatId, Date.now());
          if (sentText) this.app.context.captureBotResponse(chatId, sentText);
          totalResponsesSent++;
          this.app.debug('RETRO', `✅ resposta retroativa enviada em ${chatId}`);
        } finally {
          stopTyping();
        }
      } catch (e) {
        this.app.debug('RETRO', `erro ao gerar/enviar resposta retroativa em ${chatId}: ${(e as Error).message}`);
      }
    }

    if (totalChatsChecked > 0 || totalResponsesSent > 0) {
      this.app.debug('RETRO', `verificação completa: ${totalChatsChecked} chat(s) avaliado(s), ${totalResponsesSent} resposta(s) enviada(s)`);
    }
    if (this.dirty) this.save();
  }

  // ===========================================================================
  // SELECTION AI — chama Gemini/OpenAI pra escolher 1 msg (maxTokens 10, temp 0.3)
  // ===========================================================================

  /**
   * Chama a IA pra escolher qual mensagem iniciar conversa.
   * Espelha o padrão do Brain.generateResponse mas com maxOutputTokens 10, temp 0.3
   * (resposta curta e determinística — só um número ou "NENHUMA").
   */
  private async callSelectionAI(systemPrompt: string, userContent: string): Promise<string> {
    const aiConfig = this.app.brain.getAIConfig();
    const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

    if (provider === 'gemini') {
      const geminiUrl = `${aiConfig.apiUrl.replace(/\/+$/, '')}/${aiConfig.model}:generateContent?key=${aiConfig.apiKey}`;
      const resp = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userContent }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { maxOutputTokens: 10, temperature: 0.3 },
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json() as any;
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    // OpenAI-compatible
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (aiConfig.apiKey) headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
    const resp = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 10,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json() as any;
    return data.choices?.[0]?.message?.content || '';
  }

  // ===========================================================================
  // TIMER — (re)cria o setInterval de verificação
  // ===========================================================================

  /**
   * (Re)cria o timer de verificação periódica.
   * Chamado no boot e quando /admin features retro interval muda (Fase 3).
   */
  setupTimer(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.enabled) {
      const intervalMs = this.intervalMin * 60 * 1000;
      this.checkTimer = setInterval(() => {
        this.check().catch(e => {
          this.app.debug('RETRO', `erro no check periódico: ${(e as Error).message}`);
        });
      }, intervalMs);
      this.app.debug('RETRO', `timer de verificação criado: a cada ${this.intervalMin}min`);
    }
  }

  /**
   * Força uma verificação imediata (pra //retro agora na Fase 3).
   */
  async forceCheck(): Promise<void> {
    await this.check();
  }

  // ===========================================================================
  // SHUTDOWN
  // ===========================================================================

  destroy(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.dirty) this.save();
  }
}
