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

export type Decision = 'pending' | 'skip' | 'responded';

export interface DecisionEntry {
  msgId: string;
  senderName: string;
  text: string;
  timestamp: number;
  decision: Decision;
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
