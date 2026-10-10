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
      '*Comandos disponíveis:*',
      '',
      '🖼️ *!figurinha* — cria uma figurinha.',
      '   • Responda a uma imagem/vídeo com *!figurinha*; ou',
      '   • Envie *!figurinha <link do Twitter/X>*.',
      '',
      '🤖 *!pergunta <texto>* — fala diretamente comigo (IA). Posso também responder sozinho no grupo!',
      '',
      '📋 */resumo* — faz um resumo da conversa recente do grupo.',
      '🎚️ */entrosao [0-2]* — ajusta o quão participativo o bot é (0 = quieto, 1 = normal, 2 = entrosão).',
      '🤐 *!mute* — inicia/vota enquete pra silenciar o bot (1/3 do grupo).',
      '🔊 *!unmute* — inicia/vota enquete pra desmutar o bot.',
      '',
      '❓ *!ajuda* — exibe esta lista de comandos.',
      '',
      '_Comandos restritos a *ops* (operadores):_',
      '🔨 */ban* (ou !ban) — bane um usuário (responda à mensagem dele ou use */ban <número>*).',
      '🔓 */unban* (ou !unban) — remove o banimento de um usuário.',
      '📋 */banidos* (ou !banidos) — lista os usuários banidos.',
      '⭐ */op* — dá permissão de op a um usuário (responda à mensagem dele ou use */op <número>*).',
      '📉 */deop* — remove a permissão de op de um usuário.',
      '📝 */ops* — lista os operadores atuais.',
      '⭐ */fig* — gerencia figurinhas favoritas/nomeadas (/fig fav, /fig nome <nome>, /fig lista).',
      '🎓 */educa <texto>* — adiciona uma regra permanente de comportamento da IA.',
      '🗑️ */deseduca <id>* — remove uma regra pelo ID.',
      '📋 */educacao* — lista as regras ativas.',
      '🧠 */estilo* — mostra o que o bot aprendeu do estilo do grupo (gírias, métricas, etc).',
      '🧠 */memoria* — gerencia memórias do bot (/memoria, /memoria <nome>, /memoria reset).',
      '🤖 */ia* — liga/desliga a IA (/ia off, /ia on, /ia off global).',
      '🐦 */twitter* — controla o Twitter do bot (/twitter postar, /twitter on/off).',
      '🖼️ */perfil* — troca a foto de perfil do bot (responda a uma imagem com /perfil).',
      '🎛️ */admin* — painel de controle remoto (use no PV do bot): /admin grupos, /admin ia <id> <on/off>, /admin entrosao <id> <nivel>, /admin log, /admin stats.'
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
      await this.app.reportError(msg, chatId, 'para usar o comando: *!pergunta <sua mensagem ou pergunta>*');
      return;
    }

    if (!this.app.aiConfig?.enabled) {
      await this.app.reportError(msg, chatId, 'a IA está desativada globalmente. Peça para um op ativar com */ia on*.');
      return;
    }

    if (this.app.brain.aiDisabledChats.has(chatId)) {
      await this.app.reportError(msg, chatId, 'a IA está desativada neste chat. Peça para um op ativar com */ia on*.');
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
        await this.app.reportError(msg, chatId, 'a IA retornou uma resposta vazia. Tente novamente.');
      }
    } catch (error) {
      stopTyping();
      const e = error as Error;
      // Detecta se o erro é porque o serviço de IA tá offline
      const isOffline = e.message.includes('ECONNREFUSED') ||
                       e.message.includes('fetch failed') ||
                       e.message.includes('Serviço de IA');
      if (isOffline) {
        await this.app.reportError(msg, chatId, 'o serviço de IA tá offline. Peça pro op iniciar com `node ai-service.js` no terminal.');
      } else {
        await this.app.reportError(msg, chatId, `erro ao falar com a IA: ${e.message}`, e);
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
      await this.app.reportError(msg, chatId, 'a IA está desativada globalmente. Peça para um op ativar com */ia on*.');
      return;
    }

    if (this.app.brain.aiDisabledChats.has(chatId)) {
      await this.app.reportError(msg, chatId, 'a IA está desativada neste chat. Peça para um op ativar com */ia on*.');
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
        await this.app.reportError(msg, chatId, 'não tem mensagens suficientes pra resumir ainda.');
        return;
      }

      const conversationText = lines.join('\n');

      const summaryPrompt = `Você é o Robô do PT. Alguém pediu um resumo da conversa recente do grupo.
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
        await this.app.reportError(msg, chatId, 'não consegui gerar o resumo. Tente novamente.');
        return;
      }

      await this.app.notify(chatId, `📋 *Resumo da conversa:*\n\n${cleaned}`);
      await this.app.react(msg, EMOJI.SUCCESS);
      this.app.debug('RESUMO', `resumo enviado em ${chatId}`);
    } catch (error) {
      stopTyping();
      const e = error as Error;
      const isOffline = e.message.includes('ECONNREFUSED') ||
                       e.message.includes('fetch failed') ||
                       e.message.includes('Serviço de IA');
      if (isOffline) {
        await this.app.reportError(msg, chatId, 'o serviço de IA tá offline. Peça pro op iniciar com `node ai-service.js` no terminal.');
      } else {
        await this.app.reportError(msg, chatId, `erro ao gerar resumo: ${e.message}`, e);
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
      const lines = [
        '*Nível de entrosão deste chat:*',
        '',
        `Atual: *${level.toFixed(2)}* (${pct}%)`,
        '',
        '_O que isso significa:_',
        '• *0* = bot quieto (não responde sozinho)',
        '• *1* = normal',
        '• *2* = entrosão (2x mais participativo)',
        '',
        '_Use */entrosao <0-2>* pra ajustar. Ex.: /entrosao 1.5_'
      ];
      await this.app.notify(chatId, lines.join('\n'));
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /entrosao <número> — aceita vírgula decimal brasileira também
    const num = parseFloat(arg.replace(',', '.'));
    if (isNaN(num)) {
      await this.app.reportError(msg, chatId, `valor inválido. Use um número entre *0* e *2* (ex.: */entrosao 1.5*).`);
      return;
    }

    if (num < 0 || num > 2) {
      await this.app.reportError(msg, chatId, `o valor tem que estar entre *0* e *2*. (Você digitou ${num}.)`);
      return;
    }

    this.app.brain.chatEntrosaoLevel.set(chatId, num);
    const pct = Math.round(num * 100);
    await this.app.notify(chatId, `🎚️ entrosão ajustada pra *${num.toFixed(2)}* (${pct}%) neste chat.`);
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
        await this.app.notify(chatId, 'IA desativada *globalmente* 🛑\n\nTodos os chats não vão mais receber respostas da IA. Outros comandos continuam funcionando.');
        this.app.log('IA', `IA desativada globalmente.`);
      } else {
        this.app.brain.aiDisabledChats.add(chatId);
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, `IA desativada neste chat 🛑\n\nEste chat não vai mais receber respostas da IA. Use */ia on* pra reativar.`);
        this.app.log('IA', `IA desativada no chat ${chatId}.`);
      }
      return;
    }

    // /ia on [global]
    if (subcommand === 'on') {
      if (isGlobal) {
        if (this.app.aiConfig) this.app.aiConfig.enabled = true;
        this.app.brain.aiDisabledChats.clear();  // limpa também as desativações por chat
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, 'IA reativada *globalmente* ✅\n\nTodos os chats voltam a receber respostas da IA.');
        this.app.log('IA', `IA reativada globalmente.`);
      } else {
        this.app.brain.aiDisabledChats.delete(chatId);
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, `IA reativada neste chat ✅`);
        this.app.log('IA', `IA reativada no chat ${chatId}.`);
      }
      return;
    }

    // /ia (sem subcomando) → mostra status
    const globalStatus = this.app.aiConfig?.enabled ? '✅ ativada' : '🛑 desativada';
    const chatStatus = this.app.brain.aiDisabledChats.has(chatId) ? '🛑 desativada' : '✅ ativada';
    const disabledCount = this.app.brain.aiDisabledChats.size;

    const lines = [
      '*Status da IA:*',
      '',
      `Global: ${globalStatus}`,
      `Este chat: ${chatStatus}`,
    ];
    if (disabledCount > 0) {
      lines.push(`Chats com IA desativada: ${disabledCount}`);
    }
    lines.push('', '_Comandos:_', '• */ia off* — desativa neste chat', '• */ia on* — reativa neste chat', '• */ia off global* — desativa em tudo', '• */ia on global* — reativa em tudo');

    await this.app.notify(chatId, lines.join('\n'));
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
        await this.app.notify(chatId, `apagadas *${totalCleared}* memória(s) que vieram deste chat ✅\n\n_Memórias são globais por usuário; apenas as que vieram deste chat foram removidas._`);
        this.app.log('MEMORY', `Memórias resetadas em ${chatId}: ${totalCleared} fato(s) removidos.`);
      } else {
        await this.app.reportError(msg, chatId, 'não há memórias que vieram deste chat ainda.');
      }
      return;
    }

    // /memoria add <userName> <fact...>
    if (subcommand === 'add') {
      const userName = parts[1];
      const fact = parts.slice(2).join(' ').trim();
      if (!userName || !fact) {
        await this.app.reportError(msg, chatId, 'use */memoria add <nome> <fato>*. Ex.: /memoria add João pesa 50kg');
        return;
      }
      this.app.memory.add(chatId, userName, fact);
      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, `fato adicionado ✅\n\n_${userName}: ${fact}_`);
      this.app.log('MEMORY', `Memória manual em ${chatId}: ${userName} — "${fact}".`);
      return;
    }

    // /memoria <userName> — lista fatos de uma pessoa específica (global)
    if (subcommand && subcommand !== '') {
      const userMems = this.app.memory.forUser(subcommand);
      if (userMems.length === 0) {
        await this.app.notify(chatId, `nenhuma memória sobre *${subcommand}* ainda.`);
      } else {
        const lines = [`*Memórias sobre ${subcommand} (${userMems.length}):*`, ''];
        userMems.forEach((m, i) => {
          const date = new Date(m.timestamp).toLocaleDateString('pt-BR');
          lines.push(`${i + 1}. _${m.fact}_ (${date})`);
        });
        await this.app.notify(chatId, lines.join('\n'));
      }
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /memoria — lista todos os usuários com memórias (global)
    const userNames = this.app.memory.allUsers();

    if (userNames.length === 0) {
      await this.app.notify(chatId, 'nenhuma memória ainda. O bot aprende fatos automaticamente conforme a galera conversa.');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    const lines = [`*Memórias (${userNames.length} pessoa(s)):*`, ''];
    let totalFacts = 0;
    for (const name of userNames) {
      const facts = this.app.memory.forUser(name);
      totalFacts += facts.length;
      lines.push(`• *${name}* (${facts.length}): ${facts.map(m => m.fact).join('; ')}`);
    }
    lines.push('', `_Total: ${totalFacts} fato(s). Use /memoria reset pra apagar os que vieram deste chat._`);
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
      await this.app.reportError(msg, chatId, 'mande uma imagem com a legenda */perfil* ou responda a uma imagem com */perfil*.');
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
      await this.app.notify(chatId, 'foto de perfil atualizada com sucesso ✅');
      this.app.log('PERFIL', 'Foto de perfil do bot alterada.');
      this.app.debug('PERFIL', 'foto de perfil do bot alterada');
    } catch (error) {
      const e = error as Error;
      this.app.debug('PERFIL', `erro ao mudar foto: ${e.message}`);
      await this.app.reportError(msg, chatId, `erro ao mudar a foto: ${e.message}`, e);
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
        await this.app.reportError(msg, chatId, 'você não tem permissão para resetar o perfil. Apenas *ops*.');
        return;
      }
      const profile = this.app.profile.get(chatId);
      if (profile.style.totalMessages === 0) {
        await this.app.reportError(msg, chatId, 'não há perfil aprendido neste chat ainda.');
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
      await this.app.notify(chatId, 'perfil de estilo resetado ✅ o bot vai aprender de novo do zero.');
      return;
    }

    // /estilo — mostra o perfil
    const profile = this.app.profile.get(chatId);
    if (profile.style.totalMessages === 0) {
      await this.app.notify(chatId, 'ainda não aprendi nada neste chat. Manda umas mensagens pra eu começar a aprender o estilo da galera.');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    const s = profile.style;
    const avgLength = Math.round(s.totalLength / s.totalMessages);
    const lowercaseRatio = Math.round(s.lowercaseMessages / s.totalMessages * 100);
    const punctuationRatio = Math.round(s.punctuatedMessages / s.totalMessages * 100);
    const emojiRatio = Math.round(s.emojiMessages / s.totalMessages * 100);
    const avgEmojis = (s.totalEmojis / s.totalMessages).toFixed(1);

    const topVocab = Object.entries(profile.vocabulary)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word, count]) => `${word} (${count}x)`)
      .join(', ');

    const topUsers = Object.entries(profile.userActivity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count}x)`)
      .join('\n');

    const lines = [
      `*Perfil aprendido (${s.totalMessages} mensagens):*`,
      '',
      `*Estilo:*`,
      `• Tamanho médio: ${avgLength} chars`,
      `• ${lowercaseRatio}% em minúsculas`,
      `• ${punctuationRatio}% com pontuação formal`,
      `• ${emojiRatio}% com emoji (média ${avgEmojis}/msg)`,
      `• ${s.capsMessages} mensagens com CAPS`,
    ];

    if (topVocab) {
      lines.push('', `*Gírias mais usadas:*`, topVocab);
    }
    if (topUsers) {
      lines.push('', `*Mais ativos:*`, topUsers);
    }

    lines.push('', `_Use /estilo reset pra apagar (só ops)._`);

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
      await this.app.reportError(msg, chatId, 'forneça a regra. Ex.: */educa quando alguém falar de futebol, torce pro Corinthians*');
      return;
    }

    const result = this.app.directives.add(text, sender.all.join(' / '));
    if (!result.ok) {
      await this.app.reportError(msg, chatId, result.error || 'erro ao adicionar diretiva.');
      return;
    }

    await this.app.react(msg, EMOJI.SUCCESS);
    await this.app.notify(chatId, `regra adicionada (ID #${result.directive!.id}) ✅\n\n_${result.directive!.text}_\n\nA IA vai seguir essa regra em todas as conversas a partir de agora.`);
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
      await this.app.reportError(msg, chatId, 'forneça o ID da regra. Ex.: */deseduca 3* (use /educacao pra ver os IDs).');
      return;
    }

    // Pega o texto antes de remover (pra mostrar na confirmação)
    const list = this.app.directives.all();
    const directive = list.find(d => d.id === id);
    if (!directive) {
      await this.app.reportError(msg, chatId, `não existe regra com ID #${id}. Use */educacao* pra ver as regras.`);
      return;
    }

    this.app.directives.remove(id);
    await this.app.react(msg, EMOJI.SUCCESS);
    await this.app.notify(chatId, `regra #${id} removida ✅\n\n_${directive.text}_`);
    this.app.log('DIRECTIVE', `Diretiva #${id} removida.`);
  }

  /**
   * Preservado byte-a-byte de handleEducacao (5906-5935).
   */
  private async handleEducacao(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const list = this.app.directives.all();
    if (list.length === 0) {
      await this.app.notify(chatId, 'nenhuma regra de educação ativa. Use */educa <texto>* pra adicionar.');
    } else {
      const lines = [`*Regras de educação (${list.length}/${DIRECTIVE_MAX_COUNT}):*`, ''];
      list.forEach(d => {
        lines.push(`*#${d.id}* — ${d.text}`);
      });
      lines.push('', `_Use /deseduca <id> pra remover._`);
      await this.app.notify(chatId, lines.join('\n'));
    }

    await this.app.react(msg, EMOJI.SUCCESS);
  }
}
