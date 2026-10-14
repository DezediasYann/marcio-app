/**
 * BasicCommands — comandos básicos do bot (públicos + ops).
 *
 * Comandos públicos:
 *  - !ajuda        — lista de comandos disponíveis
 *  - !pergunta     — fala diretamente com a IA (chatId)
 *  - /resumo       — faz um resumo da conversa recente (chamada IA própria)
 *  - /entrosao     — ajusta o quão participativo o bot é (0-2)
 *  - !mute         — enquete pra silenciar o bot (delegado ao VoteSystem)
 *  - !unmute       — enquete pra desmutar o bot (delegado ao VoteSystem)
 *  - /estilo       — mostra o perfil de estilo aprendido do chat
 *
 * Comandos de op (gate opOnly aplicado pelo router):
 *  - /ia           — liga/desliga a IA (off, on, off global, on global)
 *  - /memoria      — gerencia memórias permanentes do bot
 *  - /perfil       — troca a foto de perfil do bot
 *  - /educa        — adiciona regra de comportamento
 *  - /deseduca     — remove regra pelo ID
 *  - /educacao     — lista as regras ativas
 *
 * Preservado byte-a-byte dos handlers do index.js velho:
 *  - handleHelp      (4375-4419)
 *  - handleResumo    (4432-4626) — com chamada de IA própria (não brain.generateResponse)
 *  - handleEntrosao  (4636-4691)
 *  - handleAIQuestion(5529-5605) — !pergunta
 *  - handleEduca     (5839-5870)
 *  - handleDeseduca  (5871-5905)
 *  - handleEducacao  (5906-5935)
 *  - handleEstilo    (5936-6016)
 *  - handlePerfil    (6017-6086)
 *  - handleMemoria   (6087-6174) — adaptado pro Memory global (preserva a intenção de cada subcomando)
 *  - handleIA        (7422-7488)
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.brain       — generateResponse, sendResponse, cleanResponse, getAIConfig, getAllFallbackModels, lastUsedModel, aiDisabledChats, chatEntrosaoLevel, democraticallyMutedChats, lastAutoResponse
 *  - this.app.context     — captureBotResponse, loadChatHistory
 *  - this.app.memory      — add, forUser, clearUser, allUsers
 *  - this.app.profile     — get, save, buildStyleText
 *  - this.app.directives  — add, remove, all
 *  - this.app.permissions — resolveSenderIds, isOp
 *  - this.app.whatsapp    — client.sendMessage, client.setProfilePicture (cast any)
 *  - VoteSystem           — handleMuteVote
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import type { CommandDef, CommandModule } from './CommandRegistry';
import { VoteSystem } from '../permissions/VoteSystem';

// ============================================================================
// CONSTS
// ============================================================================

const EMOJI = {
  LOADING: '⏳',
  SUCCESS: '✅',
  ERROR: '❌',
} as const;

/** Limite de diretivas simultâneas (preservado do DIRECTIVE_MAX_COUNT do velho). */
const DIRECTIVE_MAX_COUNT = 30;

// ============================================================================
// BASIC COMMANDS
// ============================================================================

export class BasicCommands implements CommandModule {
  readonly name = 'basic';
  readonly commands: CommandDef[];
  private readonly app: MarcioApp;
  private readonly voteSystem: VoteSystem;

  constructor(app: MarcioApp) {
    this.app = app;
    this.voteSystem = new VoteSystem(app);
    this.commands = [
      // === Públicos ===
      {
        name: '!ajuda',
        aliases: ['!help', '/ajuda', '/help'],
        handler: (msg, chatId) => this.handleHelp(msg, chatId),
        help: 'lista os comandos disponíveis.',
      },
      {
        name: '!pergunta',
        aliases: ['/pergunta'],
        handler: (msg, chatId) => this.handlePergunta(msg, chatId),
        help: 'fala diretamente comigo (IA). Ex.: !pergunta qual a capital da França?',
      },
      {
        name: '/resumo',
        aliases: ['!resumo'],
        handler: (msg, chatId) => this.handleResumo(msg, chatId),
        help: 'faz um resumo da conversa recente do grupo.',
      },
      {
        name: '/entrosao',
        aliases: ['!entrosao'],
        handler: (msg, chatId) => this.handleEntrosao(msg, chatId),
        help: 'ajusta o quão participativo o bot é (0 = quieto, 1 = normal, 2 = entrosão).',
      },
      {
        name: '!mute',
        aliases: ['/mute'],
        handler: (msg, chatId) => this.voteSystem.handleMuteVote(msg, chatId, 'mute'),
        help: 'inicia/vota enquete pra silenciar o bot (1/3 do grupo).',
      },
      {
        name: '!unmute',
        aliases: ['/unmute'],
        handler: (msg, chatId) => this.voteSystem.handleMuteVote(msg, chatId, 'unmute'),
        help: 'inicia/vota enquete pra desmutar o bot.',
      },
      {
        name: '/estilo',
        aliases: ['!estilo'],
        handler: (msg, chatId) => this.handleEstilo(msg, chatId),
        help: 'mostra o que o bot aprendeu do estilo do grupo. /estilo reset (ops) apaga.',
      },
      {
        name: '!last',
        aliases: ['/last', '!lastfm', '/lastfm'],
        handler: (msg, chatId) => this.handleLast(msg, chatId),
        help: 'cria collage do Last.fm. Ex: !last user 4x4 7d (grid 2-6, período 7d/1m/3m/6m/12m/overall).',
      },
      // === Ops only ===
      {
        name: '/ia',
        aliases: ['!ia'],
        handler: (msg, chatId) => this.handleIA(msg, chatId),
        help: 'liga/desliga a IA (/ia off, /ia on, /ia off global, /ia on global).',
        opOnly: true,
      },
      {
        name: '/memoria',
        aliases: ['!memoria', '/memória', '!memória'],
        handler: (msg, chatId) => this.handleMemoria(msg, chatId),
        help: 'gerencia memórias do bot (/memoria, /memoria <nome>, /memoria add <nome> <fato>, /memoria reset).',
        opOnly: true,
      },
      {
        name: '/perfil',
        aliases: ['!perfil'],
        handler: (msg, chatId) => this.handlePerfil(msg, chatId),
        help: 'troca a foto de perfil do bot (responda a uma imagem com /perfil).',
        opOnly: true,
      },
      {
        name: '/educa',
        aliases: ['!educa'],
        handler: (msg, chatId) => this.handleEduca(msg, chatId),
        help: 'adiciona uma regra permanente de comportamento da IA. Ex.: /educa torce pro Corinthians.',
        opOnly: true,
      },
      {
        name: '/deseduca',
        aliases: ['!deseduca'],
        handler: (msg, chatId) => this.handleDeseduca(msg, chatId),
        help: 'remove uma regra pelo ID. Ex.: /deseduca 3.',
        opOnly: true,
      },
      {
        name: '/educacao',
        aliases: ['!educacao', '/educação', '!educação'],
        handler: (msg, chatId) => this.handleEducacao(msg, chatId),
        help: 'lista as regras de comportamento ativas.',
        opOnly: true,
      },
      {
        name: '/nome',
        aliases: ['!nome'],
        handler: (msg, chatId) => this.handleNome(msg, chatId),
        help: 'muda o nome do bot. Ex.: /nome Meu Bot.',
        opOnly: true,
      },
      {
        name: '/alias',
        aliases: ['!alias'],
        handler: (msg, chatId) => this.handleAlias(msg, chatId),
        help: 'gerencia aliases (/alias, /alias add <nome>, /alias remove <nome>).',
        opOnly: true,
      },
    ];
  }

  // ===========================================================================
  // !ajuda
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleHelp (4375-4419).
   */
  private async handleHelp(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const helpText = [
      '*Comandos:*',
      '!figurinha — cria figurinha (responda uma imagem)',
      '!pergunta <texto> — fala comigo diretamente',
      '!last <user> [grid] [período] — collage do Last.fm',
      '/resumo — resumo da conversa recente',
      '/entrosao [0-2] — ajusta minha participação',
      '!mute / !unmute — vota silenciar/desmutar',
      '!ajuda — esta lista',
      '',
      '_OP (só no PV do bot):_',
      '/ia on|off [global] — liga/desliga IA',
      '/fig fav|unfav|nome|lista|dedup — gerencia figurinhas',
      '/nome <novo nome> — muda meu nome',
      '/alias add|remove|list — gerencia aliases',
      '/memoria [add <nome> <fato>|reset] — gerencia memórias',
      '/perfil — perfil do chat',
      '/estilo [reset] — estilo que aprendi',
      '/educa <fato> / /deseduca <fato> — ensina/desensina',
      '/ban / /unban / /banidos — gerencia banidos',
      '/op / /deop / /ops — gerencia operadores',
      '/admin — painel admin',
    ].join('\n');

    try {
      await this.app.notify(chatId, helpText);
      await this.app.react(msg, EMOJI.SUCCESS);
    } catch (error) {
      await this.app.reportError(msg, chatId, 'não consegui exibir a ajuda.', error as Error);
    }
  }

  // ===========================================================================
  // !pergunta — fala diretamente com a IA (via brain.generateResponse + sendResponse)
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleAIQuestion (5529-5605).
   *
   * Fluxo:
   *  1. Reage ⏳, valida pergunta não-vazia, valida IA ativa (global + chat).
   *  2. loadChatHistory (1ª vez) — pra IA ter contexto.
   *  3. Liga typing indicator (renew 20s).
   *  4. brain.generateResponse(chatId, true) — isDirect=true.
   *  5. [SILENCIO] → só reage ✅ (não responde).
   *  6. brain.sendResponse(chatId, reply) — envia (cuida de [FIGURINHA]/[BREAK]).
   *  7. context.captureBotResponse — captura no contexto.
   *  8. brain.lastAutoResponse.set(chatId, Date.now()) — atualiza cooldown.
   *  9. Erro offline → mensagem específica.
   */
  private async handlePergunta(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const question = msg.body.replace(/^!pergunta\s*/i, '').trim();
    if (!question) {
      await this.app.reportError(msg, chatId, 'use *!pergunta <texto>*');
      return;
    }

    if (!this.app.aiConfig?.enabled) {
      await this.app.reportError(msg, chatId, 'IA desativada globalmente. Use */ia on global*.');
      return;
    }

    if (this.app.brain.aiDisabledChats.has(chatId)) {
      await this.app.reportError(msg, chatId, 'IA desativada neste chat. Use */ia on*.');
      return;
    }

    // Helper pra limpar o intervalo de digitando (definido antes do try)
    let typingChat: any = null;
    let typingInterval: NodeJS.Timeout | null = null;
    const stopTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      if (typingChat) {
        try { typingChat.clearStateTyping(); } catch (e) { /* ignora */ }
      }
    };

    try {
      // Carrega histórico antigo do chat na PRIMEIRA vez (pra IA ter contexto)
      await this.app.context.loadChatHistory(msg, chatId);

      // Mostra indicador "digitando..." e renova a cada 20s enquanto processa
      try {
        typingChat = await msg.getChat();
        await typingChat.sendStateTyping();
        typingInterval = setInterval(async () => {
          try { if (typingChat) await typingChat.sendStateTyping(); } catch (e) { /* ignora */ }
        }, 20000);
      } catch (e) {
        this.app.debug('AI-TYPING', `erro ao ativar digitando: ${(e as Error)?.message || e}`);
      }

      const reply = await this.app.brain.generateResponse(chatId, true);
      stopTyping();

      if (reply && reply.trim() && reply.trim() !== '...') {
        // [SILENCIO] = IA decidiu não responder
        if (/^\s*\[SILENCIO\]\s*$/i.test(reply.trim())) {
          this.app.debug('AI', `IA decidiu ficar em silêncio (!pergunta)`);
          await this.app.react(msg, EMOJI.SUCCESS);  // confirma que processou, mas não responde
          return;
        }
        const sentText = await this.app.brain.sendResponse(chatId, reply);
        if (sentText) this.app.context.captureBotResponse(chatId, sentText);
        this.app.brain.lastAutoResponse.set(chatId, Date.now());  // atualiza cooldown
        await this.app.react(msg, EMOJI.SUCCESS);
      } else {
        await this.app.reportError(msg, chatId, 'IA retornou resposta vazia. Tenta de novo.');
      }
    } catch (error) {
      stopTyping();
      const e = error as Error;
      // Detecta se o erro é porque o serviço de IA tá offline
      const isOffline = e.message.includes('ECONNREFUSED') ||
                       e.message.includes('fetch failed') ||
                       e.message.includes('Serviço de IA');
      if (isOffline) {
        await this.app.reportError(msg, chatId, 'IA offline. Pede pra um op rodar `node ai-service.js`.');
      } else {
        await this.app.reportError(msg, chatId, `erro IA: ${e.message}`, e);
      }
    }
  }

  // ===========================================================================
  // /resumo — resumo da conversa (chamada IA própria, NÃO brain.generateResponse)
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleResumo (4432-4626).
   *
   * Diferente do !pergunta, este NÃO usa brain.generateResponse. Constrói um
   * array de mensagens one-off (system + user só com a conversa) e chama a IA
   * diretamente. Preserva o fallback chain de modelo Gemini em caso de 429/503.
   */
  private async handleResumo(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    if (!this.app.aiConfig?.enabled) {
      await this.app.reportError(msg, chatId, 'IA desativada globalmente. Use */ia on global*.');
      return;
    }

    if (this.app.brain.aiDisabledChats.has(chatId)) {
      await this.app.reportError(msg, chatId, 'IA desativada neste chat. Use */ia on*.');
      return;
    }

    // Helper pra limpar o intervalo de digitando (definido antes do try)
    let typingChat: any = null;
    let typingInterval: NodeJS.Timeout | null = null;
    const stopTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      if (typingChat) {
        try { typingChat.clearStateTyping(); } catch (e) { /* ignora */ }
      }
    };

    try {
      // Pega as últimas 50 mensagens do chat
      const chat = await msg.getChat();
      const recentMessages = await chat.fetchMessages({ limit: 50 });

      // Monta o texto da conversa: "[Nome]: texto"
      // Pula comandos (! ou /) e mensagens sem body.
      const lines: string[] = [];
      for (const m of recentMessages) {
        if (!m.body || !m.body.trim()) continue;
        if (m.body.startsWith('!') || m.body.startsWith('/')) continue;
        let name = 'Alguém';
        try {
          const contact = await m.getContact();
          name = contact.pushname || contact.name || contact.shortName || 'Alguém';
        } catch (e) { /* mantém "Alguém" */ }
        lines.push(`[${name}]: ${m.body}`);
      }

      if (lines.length === 0) {
        await this.app.reportError(msg, chatId, 'não tem msgs suficientes pra resumir.');
        return;
      }

      const conversationText = lines.join('\n');

      const summaryPrompt = `Você é um bot de WhatsApp. Alguém pediu um resumo da conversa recente do grupo.
Faça um resumo dos principais assuntos discutidos, de forma breve e informal, como um amigo contando o que aconteceu.
Use o mesmo estilo de escrita: minúsculas, sem pontuação formal, gírias se fizer sentido.
Máximo 5-6 linhas. Foque no que foi discutido, não em quem disse o quê.`;

      // Liga o "digitando..." enquanto processa
      try {
        typingChat = chat;
        await typingChat.sendStateTyping();
        typingInterval = setInterval(async () => {
          try { if (typingChat) await typingChat.sendStateTyping(); } catch (e) { /* ignora */ }
        }, 20000);
      } catch (e) {
        this.app.debug('AI-TYPING', `erro ao ativar digitando (resumo): ${(e as Error).message}`);
      }

      this.app.debug('RESUMO', `gerando resumo em ${chatId} | ${lines.length} msgs | ~${conversationText.length} chars`);

      // Monta as mensagens e chama a API diretamente (não usa generateResponse
      // porque não queremos injetar o contexto acumulado do bot, perfil de estilo,
      // diretivas, etc. — só o prompt de resumo + a conversa).
      const aiMessages = [
        { role: 'system', content: summaryPrompt },
        { role: 'user', content: conversationText },
      ];

      const aiConfig = this.app.brain.getAIConfig();
      const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

      let content: string | undefined;
      if (provider === 'gemini') {
        // === FORMATO GEMINI (Google AI Studio) ===
        const systemMessages = aiMessages.filter(m => m.role === 'system');
        const conversationMessages = aiMessages.filter(m => m.role !== 'system');

        let systemInstruction: any = null;
        if (systemMessages.length > 0) {
          systemInstruction = {
            parts: [{ text: systemMessages.map(m => m.content).join('\n\n') }],
          };
        }

        const contents = conversationMessages.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

        // Helper: chama a API do Gemini com um modelo específico (copia o padrão
        // do generateAIResponse, com fallback em caso de 429/503).
        const callGemini = async (modelName: string): Promise<string> => {
          const geminiUrl = `${aiConfig.apiUrl.replace(/\/+$/, '')}/${modelName}:generateContent?key=${aiConfig.apiKey}`;
          const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents,
              systemInstruction,
              generationConfig: {
                maxOutputTokens: aiConfig.maxTokens,
                temperature: aiConfig.temperature,
              },
            }),
          });
          if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            const err = new Error(`Gemini API ${geminiResponse.status}: ${errText.slice(0, 200)}`) as any;
            err.status = geminiResponse.status;
            throw err;
          }
          const geminiData = await geminiResponse.json() as any;
          const geminiContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!geminiContent) throw new Error('Resposta vazia da Gemini API');
          return geminiContent;
        };

        try {
          content = await callGemini(aiConfig.model);
        } catch (primaryErr) {
          const allModels = this.app.brain.getAllFallbackModels();
          let fallbackSuccess = false;
          for (let i = 1; i < allModels.length; i++) {
            const fbModel = allModels[i];
            try {
              this.app.debug('RESUMO', `⚠️ modelo principal esgotou (429/503), tentando fallback: ${fbModel}`);
              content = await callGemini(fbModel);
              this.app.brain.lastUsedModel = fbModel;
              fallbackSuccess = true;
              break;
            } catch (fbErr) {
              if (i < allModels.length - 1) continue;
              throw fbErr;
            }
          }
          if (!fallbackSuccess) throw primaryErr;
        }
      } else {
        // === FORMATO OPENAI (Ollama, Groq, OpenRouter, etc.) ===
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (aiConfig.apiKey) {
          headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
        }
        const response = await fetch(aiConfig.apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: aiConfig.model,
            messages: aiMessages,
            max_tokens: aiConfig.maxTokens,
            temperature: aiConfig.temperature,
          }),
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
        }
        const openaiData = await response.json() as any;
        content = openaiData.choices?.[0]?.message?.content;
        if (!content) throw new Error('Resposta vazia da API');
      }

      stopTyping();

      const cleaned = this.app.brain.cleanResponse(content || '');
      if (!cleaned || !cleaned.trim() || cleaned.trim() === '...') {
        await this.app.reportError(msg, chatId, 'não consegui gerar o resumo.');
        return;
      }

      await this.app.notify(chatId, `📋 ${cleaned}`);
      await this.app.react(msg, EMOJI.SUCCESS);
      this.app.debug('RESUMO', `resumo enviado em ${chatId}`);
    } catch (error) {
      stopTyping();
      const e = error as Error;
      const isOffline = e.message.includes('ECONNREFUSED') ||
                       e.message.includes('fetch failed') ||
                       e.message.includes('Serviço de IA');
      if (isOffline) {
        await this.app.reportError(msg, chatId, 'IA offline. Pede pra um op rodar `node ai-service.js`.');
      } else {
        await this.app.reportError(msg, chatId, `erro resumo: ${e.message}`, e);
      }
    }
  }

  // ===========================================================================
  // /entrosao — ajusta o nível de entrosão (brain.chatEntrosaoLevel)
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleEntrosao (4636-4691).
   *
   * Sem argumento: mostra o nível atual.
   * Com número 0-2 (aceita vírgula decimal brasileira): define o nível.
   * Não persiste — volta pra 1.0 ao reiniciar (igual bot velho).
   */
  private async handleEntrosao(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const args = msg.body.trim().split(/\s+/).slice(1);
    const arg = args[0];

    // /entrosao (sem argumento) → mostra o nível atual
    if (!arg) {
      const level = this.app.brain.chatEntrosaoLevel.get(chatId) ?? 1.0;
      const pct = Math.round(level * 100);
      await this.app.notify(chatId, `🎚️ entrosão: *${level.toFixed(2)}* (${pct}%) — 0 quieto | 1 normal | 2 entrosão`);
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /entrosao <número> — aceita vírgula decimal brasileira também
    const num = parseFloat(arg.replace(',', '.'));
    if (isNaN(num)) {
      await this.app.reportError(msg, chatId, `valor inválido. Use 0-2 (ex.: */entrosao 1.5*).`);
      return;
    }

    if (num < 0 || num > 2) {
      await this.app.reportError(msg, chatId, `valor tem que ser 0-2 (você digitou ${num}).`);
      return;
    }

    this.app.brain.chatEntrosaoLevel.set(chatId, num);
    const pct = Math.round(num * 100);
    await this.app.notify(chatId, `🎚️ entrosão: *${num.toFixed(2)}* (${pct}%)`);
    await this.app.react(msg, EMOJI.SUCCESS);
    this.app.debug('ENTROSAO', `chat ${chatId} nível setado pra ${num}`);
  }

  // ===========================================================================
  // /ia — liga/desliga a IA (op)
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleIA (7422-7488).
   *
   * Subcomandos:
   *  - /ia off [global]    → desativa neste chat (ou globalmente)
   *  - /ia on [global]     → reativa neste chat (ou globalmente)
   *  - /ia                 → mostra status
   *
   * Global: this.app.aiConfig.enabled (em memória, como o velho).
   * Per-chat: this.app.brain.aiDisabledChats (Set, em memória).
   */
  private async handleIA(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const args = msg.body.trim().split(/\s+/).slice(1);
    const subcommand = (args[0] || '').toLowerCase();
    const isGlobal = (args[1] || '').toLowerCase() === 'global';

    // /ia off [global]
    if (subcommand === 'off') {
      if (isGlobal) {
        if (this.app.aiConfig) this.app.aiConfig.enabled = false;
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, '🛑 IA off (global)');
        this.app.log('IA', `IA desativada globalmente.`);
      } else {
        // Persiste via chatSettings (atualiza brain.aiDisabledChats + broadcast
        // pro painel + salva em chat-settings.json — sobrevive a restarts).
        this.app.chatSettings.setAiEnabled(chatId, false);
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, '🛑 IA off');
        this.app.log('IA', `IA desativada no chat ${chatId}.`);
      }
      return;
    }

    // /ia on [global]
    if (subcommand === 'on') {
      if (isGlobal) {
        if (this.app.aiConfig) this.app.aiConfig.enabled = true;
        // Limpa TODOS os chats com IA off — reativa em todos.
        // Precisa persistir cada um (setAiEnabled também limpa brain.aiDisabledChats).
        for (const cid of this.app.chatSettings.allChatIds()) {
          if (!this.app.chatSettings.get(cid).aiEnabled) {
            this.app.chatSettings.setAiEnabled(cid, true);
          }
        }
        this.app.brain.aiDisabledChats.clear();  // safety net (caso tenha em memória sem persistir)
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, '✅ IA on (global)');
        this.app.log('IA', `IA reativada globalmente.`);
      } else {
        this.app.chatSettings.setAiEnabled(chatId, true);
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, '✅ IA on');
        this.app.log('IA', `IA reativada no chat ${chatId}.`);
      }
      return;
    }

    // /ia (sem subcomando) → mostra status
    const globalStatus = this.app.aiConfig?.enabled ? '✅' : '🛑';
    const chatStatus = this.app.brain.aiDisabledChats.has(chatId) ? '🛑' : '✅';
    const disabledCount = this.app.brain.aiDisabledChats.size;

    const line = `IA global: ${globalStatus} | chat: ${chatStatus}${disabledCount > 0 ? ` | ${disabledCount} chats off` : ''}`;
    await this.app.notify(chatId, line);
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /memoria — gerencia memórias permanentes do bot (op)
  // ===========================================================================

  /**
   * Adaptado de handleMemoria (6087-6174). A MEMORY no novo arch é GLOBAL por
   * usuário (com sourceChat tracking por fato), não per-chat. A intenção de
   * cada subcomando é preservada:
   *
   *  - /memoria                → lista todos os usuários com memórias (global)
   *  - /memoria <userName>     → mostra os fatos de um usuário específico
   *  - /memoria add <nome> <fato> → adiciona um fato manualmente
   *  - /memoria reset          → apaga apenas os fatos que VIERAM deste chat
   *    (implementado com clearUser + re-add dos fatos de outros chats, já que
   *     Memory não tem método "delete por chat")
   */
  private async handleMemoria(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const body = msg.body.replace(/^\/memoria\s*/i, '').trim();
    const parts = body.split(/\s+/);
    const subcommand = (parts[0] || '').toLowerCase();

    // /memoria reset — apaga fatos que vieram deste chat
    if (subcommand === 'reset') {
      let totalCleared = 0;
      const allUsers = this.app.memory.allUsers();
      for (const userName of allUsers) {
        const facts = this.app.memory.forUser(userName);
        const keepFacts = facts.filter(f => f.sourceChat !== chatId);
        const removedCount = facts.length - keepFacts.length;
        if (removedCount > 0) {
          this.app.memory.clearUser(userName);
          for (const f of keepFacts) {
            this.app.memory.add(f.sourceChat, userName, f.fact);
          }
          totalCleared += removedCount;
        }
      }
      if (totalCleared > 0) {
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, `✅ ${totalCleared} memória(s) removidas deste chat`);
        this.app.log('MEMORY', `Memórias resetadas em ${chatId}: ${totalCleared} fato(s) removidos.`);
      } else {
        await this.app.reportError(msg, chatId, 'não há memórias deste chat.');
      }
      return;
    }

    // /memoria add <userName> <fact...>
    if (subcommand === 'add') {
      const userName = parts[1];
      const fact = parts.slice(2).join(' ').trim();
      if (!userName || !fact) {
        await this.app.reportError(msg, chatId, 'use */memoria add <nome> <fato>*');
        return;
      }
      this.app.memory.add(chatId, userName, fact);
      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, `✅ ${userName}: ${fact}`);
      this.app.log('MEMORY', `Memória manual em ${chatId}: ${userName} — "${fact}".`);
      return;
    }

    // /memoria <userName> — lista fatos de uma pessoa específica (global)
    if (subcommand && subcommand !== '') {
      const userMems = this.app.memory.forUser(subcommand);
      if (userMems.length === 0) {
        await this.app.notify(chatId, `sem memórias sobre *${subcommand}*.`);
      } else {
        const facts = userMems.map(m => m.fact).join('; ');
        await this.app.notify(chatId, `*${subcommand}* (${userMems.length}): ${facts}`);
      }
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /memoria — lista todos os usuários com memórias (global)
    const userNames = this.app.memory.allUsers();

    if (userNames.length === 0) {
      await this.app.notify(chatId, 'nenhuma memória ainda.');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    const lines: string[] = [];
    let totalFacts = 0;
    for (const name of userNames) {
      const facts = this.app.memory.forUser(name);
      totalFacts += facts.length;
      lines.push(`*${name}* (${facts.length}): ${facts.map(m => m.fact).join('; ')}`);
    }
    lines.push(`Total: ${totalFacts} fatos`);
    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /perfil — troca a foto de perfil do bot (op)
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handlePerfil (6017-6086).
   *
   * Fonte da imagem:
   *  1. Se a própria msg tem mídia (image ou sticker) → usa ela
   *  2. Senão, se tem quoted → usa a quoted (se for image ou sticker)
   *  3. Senão → erro com instruções
   *
   * client.setProfilePicture(media) — não tá na declaração de tipos, usa cast any.
   */
  private async handlePerfil(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    // Determina a fonte da imagem:
    // 1. Se a própria mensagem tem mídia (ex.: mandou foto com legenda /perfil), usa ela
    // 2. Se não, tenta a mensagem respondida (quoted)
    let mediaSource: Message | null = null;

    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker')) {
      // Caso 1: mensagem atual tem imagem (envio com legenda)
      mediaSource = msg;
    } else if (msg.hasQuotedMsg) {
      // Caso 2: respondeu a uma imagem
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted.hasMedia && (quoted.type === 'image' || quoted.type === 'sticker')) {
          mediaSource = quoted;
        }
      } catch (e) {
        await this.app.reportError(msg, chatId, 'não consegui acessar a mensagem respondida.', e as Error);
        return;
      }
    }

    if (!mediaSource) {
      await this.app.reportError(msg, chatId, 'mande uma imagem com */perfil* ou responda a uma imagem com */perfil*.');
      return;
    }

    try {
      const media = await mediaSource.downloadMedia();
      if (!media || !media.data) {
        await this.app.reportError(msg, chatId, 'não consegui baixar a imagem.');
        return;
      }

      // setProfilePicture exige uma imagem (não sticker). Se for sticker, converte.
      // O whatsapp-web.js aceita MessageMedia diretamente.
      // Não tá na declaração de tipos — usa cast any.
      await (this.app.whatsapp.client as any).setProfilePicture(media);

      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, '✅ perfil atualizado');
      this.app.log('PERFIL', 'Foto de perfil do bot alterada.');
      this.app.debug('PERFIL', 'foto de perfil do bot alterada');
    } catch (error) {
      const e = error as Error;
      this.app.debug('PERFIL', `erro ao mudar foto: ${e.message}`);
      await this.app.reportError(msg, chatId, `erro: ${e.message}`, e);
    }
  }

  // ===========================================================================
  // /estilo — mostra o perfil de estilo aprendido do chat
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleEstilo (5936-6016).
   *
   * /estilo reset é opOnly em runtime (checa dentro do handler, não no router).
   * Como Profile não tem método delete(chatId), o reset é feito mutando os
   * campos do perfil pra vazio + save. Funcionalmente idêntico a deletar.
   */
  private async handleEstilo(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const args = msg.body.trim().split(/\s+/).slice(1);
    const subcommand = (args[0] || '').toLowerCase();

    // /estilo reset — só ops
    if (subcommand === 'reset') {
      const sender = await this.app.permissions.resolveSenderIds(msg);
      if (!this.app.permissions.isOp(msg.fromMe, sender.all)) {
        await this.app.reportError(msg, chatId, 'só *ops* podem resetar.');
        return;
      }
      const profile = this.app.profile.get(chatId);
      if (profile.style.totalMessages === 0) {
        await this.app.reportError(msg, chatId, 'não há perfil aprendido neste chat.');
        return;
      }
      // Reseta todos os campos pra vazio (Profile não tem delete, mas mutar + save
      // atinge o mesmo efeito — bot re-aprende do zero).
      profile.vocabulary = {};
      profile.style.totalMessages = 0;
      profile.style.totalLength = 0;
      profile.style.lowercaseMessages = 0;
      profile.style.punctuatedMessages = 0;
      profile.style.emojiMessages = 0;
      profile.style.totalEmojis = 0;
      profile.style.capsMessages = 0;
      profile.userActivity = {};
      profile.userProfiles = {};
      profile.lastUpdated = new Date().toISOString();
      this.app.profile.save();
      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, '✅ perfil resetado');
      return;
    }

    // /estilo — mostra o perfil
    const profile = this.app.profile.get(chatId);
    if (profile.style.totalMessages === 0) {
      await this.app.notify(chatId, 'ainda não aprendi nada neste chat.');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    const s = profile.style;
    const avgLength = Math.round(s.totalLength / s.totalMessages);
    const lowercaseRatio = Math.round(s.lowercaseMessages / s.totalMessages * 100);
    const punctuationRatio = Math.round(s.punctuatedMessages / s.totalMessages * 100);
    const emojiRatio = Math.round(s.emojiMessages / s.totalMessages * 100);

    const topVocab = Object.entries(profile.vocabulary)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word, count]) => `"${word}" (${count}x)`)
      .join(', ');

    const topUsers = Object.entries(profile.userActivity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');

    const lines = [
      `${s.totalMessages} msgs | tam médio: ${avgLength} chars`,
      `${lowercaseRatio}% minúsculas | ${punctuationRatio}% pontuação | ${emojiRatio}% emoji`,
    ];
    if (topVocab) lines.push(`Gírias: ${topVocab}`);
    if (topUsers) lines.push(`Ativos: ${topUsers}`);

    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /educa, /deseduca, /educacao — regras de comportamento (op)
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleEduca (5839-5870).
   */
  private async handleEduca(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const sender = await this.app.permissions.resolveSenderIds(msg);

    const text = msg.body.replace(/^\/educa\s*/i, '').trim();
    if (!text) {
      await this.app.reportError(msg, chatId, 'use */educa <regra>* (ex: /educa torce pro Corinthians)');
      return;
    }

    const result = this.app.directives.add(text, sender.all.join(' / '));
    if (!result.ok) {
      await this.app.reportError(msg, chatId, result.error || 'erro ao adicionar.');
      return;
    }

    await this.app.react(msg, EMOJI.SUCCESS);
    await this.app.notify(chatId, `✅ regra #${result.directive!.id} adicionada: ${result.directive!.text}`);
    this.app.log('DIRECTIVE', `Diretiva #${result.directive!.id} adicionada por ${sender.all.join(' / ')}: ${text}`);
  }

  /**
   * Preservado byte-a-byte de handleDeseduca (5871-5905).
   */
  private async handleDeseduca(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const arg = msg.body.replace(/^\/deseduca\s*/i, '').trim();
    const id = parseInt(arg, 10);
    if (!arg || isNaN(id)) {
      await this.app.reportError(msg, chatId, 'use */deseduca <id>* (ex: /deseduca 3)');
      return;
    }

    // Pega o texto antes de remover (pra mostrar na confirmação)
    const list = this.app.directives.all();
    const directive = list.find(d => d.id === id);
    if (!directive) {
      await this.app.reportError(msg, chatId, `regra #${id} não existe. Use */educacao* pra ver.`);
      return;
    }

    this.app.directives.remove(id);
    await this.app.react(msg, EMOJI.SUCCESS);
    await this.app.notify(chatId, `✅ regra #${id} removida: ${directive.text}`);
    this.app.log('DIRECTIVE', `Diretiva #${id} removida.`);
  }

  /**
   * Preservado byte-a-byte de handleEducacao (5906-5935).
   */
  private async handleEducacao(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const list = this.app.directives.all();
    if (list.length === 0) {
      await this.app.notify(chatId, 'nenhuma regra ativa. Use */educa <texto>* pra adicionar.');
    } else {
      const lines = list.map(d => `#${d.id} ${d.text}`);
      await this.app.notify(chatId, lines.join('\n'));
    }

    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /nome — muda o nome do bot
  // ===========================================================================

  private async handleNome(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const args = msg.body.trim().split(/\s+/).slice(1);
    const newName = args.join(' ').trim();

    if (!newName) {
      const cfg = this.app.brain.getBotConfig();
      await this.app.notify(chatId, `nome atual: *${cfg.botName}*\n\nUse */nome <novo nome>* pra mudar.`);
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // Pega aliases atuais e salva com o novo nome
    const cfg = this.app.brain.getBotConfig();
    this.app.brain.saveBotConfig(newName, cfg.aliases);
    await this.app.notify(chatId, `✅ nome mudado pra *${newName}*`);
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /alias — gerencia aliases do bot
  // ===========================================================================

  private async handleAlias(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const args = msg.body.trim().split(/\s+/).slice(1);
    const subcommand = (args[0] || '').toLowerCase();
    const aliasValue = args.slice(1).join(' ').trim();

    const cfg = this.app.brain.getBotConfig();

    // /alias (sem subcomando) — lista
    if (!subcommand || subcommand === 'list') {
      if (cfg.allAliases.length === 0) {
        await this.app.notify(chatId, 'nenhum alias. Use */alias add <nome>* pra adicionar.');
      } else {
        await this.app.notify(chatId, `aliases:\n${cfg.allAliases.map(a => `• ${a}`).join('\n')}`);
      }
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /alias add <nome>
    if (subcommand === 'add') {
      if (!aliasValue) {
        await this.app.notify(chatId, 'use */alias add <nome>*');
        await this.app.react(msg, EMOJI.ERROR);
        return;
      }
      if (cfg.aliases.includes(aliasValue)) {
        await this.app.notify(chatId, `"${aliasValue}" já é um alias.`);
        await this.app.react(msg, EMOJI.ERROR);
        return;
      }
      const newAliases = [...cfg.aliases, aliasValue];
      this.app.brain.saveBotConfig(cfg.botName, newAliases);
      await this.app.notify(chatId, `✅ alias adicionado: *${aliasValue}*\nAgora o bot responde 100% das vezes quando alguém diz "${aliasValue}".`);
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /alias remove <nome>
    if (subcommand === 'remove' || subcommand === 'rm' || subcommand === 'del') {
      if (!aliasValue) {
        await this.app.notify(chatId, 'use */alias remove <nome>*');
        await this.app.react(msg, EMOJI.ERROR);
        return;
      }
      const newAliases = cfg.aliases.filter(a => a.toLowerCase() !== aliasValue.toLowerCase());
      if (newAliases.length === cfg.aliases.length) {
        await this.app.notify(chatId, `"${aliasValue}" não é um alias customizado (pode ser genérico).`);
        await this.app.react(msg, EMOJI.ERROR);
        return;
      }
      this.app.brain.saveBotConfig(cfg.botName, newAliases);
      await this.app.notify(chatId, `✅ alias removido: *${aliasValue}*`);
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    await this.app.notify(chatId, 'use */alias* (lista), */alias add <nome>*, ou */alias remove <nome>*');
    await this.app.react(msg, EMOJI.ERROR);
  }

  // === !last — Last.fm Collage ===
  private async handleLast(msg: Message, chatId: string): Promise<void> {
    const args = msg.body.trim().split(/\s+/).slice(1); // remove !last

    if (args.length === 0 || args[0] === 'help' || args[0] === 'ajuda') {
      await this.app.notify(chatId, [
        '*!last <usuário> [grid] [período]*',
        '',
        'Cria um collage dos álbuns mais ouvidos.',
        '',
        '_Parâmetros:_',
        '• *usuário*: seu user do Last.fm',
        '• *grid*: 2 a 6 (default: 3 → 3x3)',
        '• *período*: 7d, 1m, 3m, 6m, 12m, overall (default: 7d)',
        '',
        '_Exemplos:_',
        '!last rjanhs',
        '!last rjanhs 4x4 7d',
        '!last rjanhs 5 1m',
      ].join('\n'));
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    const username = args[0];
    let gridSize = 3;
    let period = '7d';

    // Parse grid (ex: "4x4" ou "4")
    if (args[1]) {
      const gridMatch = args[1].match(/^(\d+)/);
      if (gridMatch) {
        gridSize = Math.max(2, Math.min(6, parseInt(gridMatch[1])));
      }
    }

    // Parse period
    if (args[2]) {
      const p = args[2].toLowerCase();
      if (['7d', '1m', '3m', '6m', '12m', 'overall'].includes(p)) {
        period = p;
      }
    }

    await this.app.react(msg, '⏳');
    this.app.log('CMD', `!last: ${username} ${gridSize}x${gridSize} ${period}`);

    try {
      const result = await this.app.lastCollage.generateCollage(username, gridSize, period);
      if (result && 'media' in result) {
        await this.app.whatsapp.client.sendMessage(chatId, result.media, { caption: result.caption });
        await this.app.react(msg, EMOJI.SUCCESS);
      } else if (result && 'error' in result) {
        await this.app.notify(chatId, `❌ ${result.error}`);
        await this.app.react(msg, EMOJI.ERROR);
      } else {
        await this.app.notify(chatId, 'não consegui criar o collage por um erro desconhecido.');
        await this.app.react(msg, EMOJI.ERROR);
      }
    } catch (e) {
      await this.app.notify(chatId, `erro: ${(e as Error).message}`);
      await this.app.react(msg, EMOJI.ERROR);
    }
  }
}
