/**
 * TwitterBot — integração com Twitter/X (auto-post + aprovação + menções).
 *
 * Portado byte-a-byte do index.js velho (linhas 1805-5260). Preserva toda a
 * lógica de:
 *  - getTwitterConfig()        → cache 5s de twitter-config.json (default desativado)
 *  - getTwitterClient()        → lazy-init OAuth 1.0a, cacheado por credenciais
 *  - generateTweet(chatId)     → pega contexto, chama IA direto (Gemini c/ fallback),
 *                                devolve { text, imageData, imageMimetype } ou null
 *  - postTweetWithApproval()   → approvalMode manda pra approvalChatId; senão posta direto
 *  - generateAndPostTweet()    → ciclo auto-post (escolhe source chat, gera, posta)
 *  - maybeHandleApproval()     → intercepta "postar"/"descartar" no chat com tweet pendente
 *  - startAutoPostTimer()      → setInterval baseado em postIntervalHours
 *  - startMentionChecker()     → setInterval baseado em mentionCheckIntervalMinutes
 *                                (feature NÃO implementada no bot velho — o config
 *                                 tem os campos mas não tem código. Aqui a gente
 *                                 implementou uma versão mínima funcional usando
 *                                 userMentionTimeline da twitter-api-v2.)
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.context        — getRecent (fonte das msgs pra gerar tweet)
 *  - this.app.brain          — getAIConfig, getAllFallbackModels, cleanResponse, lastUsedModel
 *  - this.app.permissions    — resolveSenderIds, isOp (gate de aprovação)
 *  - this.app.whatsapp       — client.sendMessage (envio da msg de aprovação c/ mídia),
 *                              client.info.wid._serialized (fallback de approvalChatId)
 *  - this.app.config.botName — prefixo das notificações
 *  - this.app.dataPath()     — caminho de twitter-config.json
 *  - this.app.log / debug    — logging
 *
 * twitter-api-v2 é uma dependência OPCIONAL (optionalDependencies no package.json).
 * Se não estiver instalada, TwitterApi fica null e todas as features são
 * silenciosamente desativadas (igual bot velho).
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import { MessageMedia } from 'whatsapp-web.js';
import fs from 'node:fs';

// ============================================================================
// DEPENDÊNCIA OPCIONAL: twitter-api-v2
// ============================================================================
// Carrega dinamicamente. Se não estiver instalada, TwitterApi fica null e
// todas as features de Twitter são silenciosamente desativadas.
let TwitterApi: any = null;
try {
  TwitterApi = require('twitter-api-v2').TwitterApi;
} catch {
  // twitter-api-v2 não instalado — features de Twitter desativadas
}

// ============================================================================
// TIPOS
// ============================================================================

/** Shape do twitter-config.json. */
export interface TwitterConfig {
  enabled: boolean;
  apiKey: string;
  apiKeySecret: string;
  accessToken: string;
  accessTokenSecret: string;
  postIntervalHours: number;
  replyToMentions: boolean;
  mentionCheckIntervalMinutes: number;
  approvalMode: boolean;
  approvalChatId: string | null;
  sourceChats: string[];
  referenceStyle?: string;
}

/** Tweet aguardando aprovação (keyed pelo chat onde o op vai responder). */
export interface PendingTweet {
  text: string;
  imageData?: string | null;
  imageMimetype?: string | null;
  timestamp?: number;
  sourceChat?: string;
}

/** Resultado do fluxo de postagem. */
type PostResult = 'pending' | 'posted' | 'error';

// ============================================================================
// TWITTER BOT
// ============================================================================

export class TwitterBot {
  private app: MarcioApp;

  /** Tweets aguardando aprovação (chatId → pending tweet). */
  pendingTweets = new Map<string, PendingTweet>();

  // --- Cache de config (5s, mesmo padrão do ai-config) ---
  private configCache: TwitterConfig | null = null;
  private configCacheTime = 0;
  private readonly CONFIG_CACHE_TTL_MS = 5000;

  // --- Cache de cliente Twitter (invalidado quando credenciais mudam) ---
  private clientCache: any = null;
  private clientCacheKey: string | null = null;

  // --- Timers ---
  private autoPostTimer: NodeJS.Timeout | null = null;
  private mentionTimer: NodeJS.Timeout | null = null;

  // --- Estado do mention checker ---
  private lastMentionId: string | null = null;

  constructor(app: MarcioApp) {
    this.app = app;
  }

  // ===========================================================================
  // CONFIG — getTwitterConfig (cache 5s) + save + invalidate
  // ===========================================================================

  /**
   * Lê data/twitter-config.json com cache de 5s. Se não existir, retorna um
   * config padrão desativado. Permite ligar/desligar o Twitter e trocar
   * credenciais/intervalo sem reiniciar o bot.
   *
   * Portado byte-a-byte de getTwitterConfig() do index.js velho (linhas
   * 1828-1865), exceto pelo TTL (5s em vez de 10s — alinhado com ai-config).
   */
  getConfig(): TwitterConfig {
    const now = Date.now();
    if (this.configCache !== null && (now - this.configCacheTime) < this.CONFIG_CACHE_TTL_MS) {
      return this.configCache;
    }

    const defaultConfig: TwitterConfig = {
      enabled: false,
      apiKey: '',
      apiKeySecret: '',
      accessToken: '',
      accessTokenSecret: '',
      postIntervalHours: 4,
      replyToMentions: false,
      mentionCheckIntervalMinutes: 15,
      approvalMode: true,
      approvalChatId: null,
      sourceChats: [],
    };

    try {
      const filePath = this.app.dataPath('twitter-config.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) {
          const parsed = JSON.parse(content);
          this.configCache = { ...defaultConfig, ...parsed };
          this.configCacheTime = now;
          return this.configCache;
        }
      }
    } catch (e) {
      this.app.debug('TWITTER', `erro ao ler twitter-config.json: ${(e as Error).message}`);
    }

    this.configCache = { ...defaultConfig };
    this.configCacheTime = now;
    return this.configCache;
  }

  /**
   * Salva o config no disco e invalida o cache. Usado pelo /twitter on/off,
   * /twitter aprovar on/off, /twitter mentions on/off.
   */
  saveConfig(config: TwitterConfig): void {
    fs.writeFileSync(
      this.app.dataPath('twitter-config.json'),
      JSON.stringify(config, null, 2),
      'utf8',
    );
    this.invalidateConfigCache();
  }

  /** Invalida o cache de config (próxima leitura vai no disco). */
  invalidateConfigCache(): void {
    this.configCache = null;
  }

  // ===========================================================================
  // CLIENTE — getTwitterClient (lazy-init OAuth 1.0a, cacheado por credenciais)
  // ===========================================================================

  /**
   * Cria (e cacheia) uma instância do cliente TwitterApi com OAuth 1.0a.
   * Retorna null se:
   *  - twitter-api-v2 não estiver instalado (TwitterApi === null)
   *  - config estiver desativada (enabled=false)
   *  - credenciais estiverem incompletas
   *
   * O cache é invalidado automaticamente quando as credenciais mudam (chave =
   * apiKey+accessToken), então trocar credenciais no twitter-config.json passa
   * a valer na próxima chamada (até o TTL de 5s do getConfig).
   *
   * Portado byte-a-byte de getTwitterClient() do index.js velho (linhas
   * 1880-1913).
   */
  getClient(): any {
    if (!TwitterApi) {
      this.app.debug('TWITTER', `getTwitterClient: twitter-api-v2 não instalado`);
      return null;
    }
    const config = this.getConfig();
    if (!config.enabled) {
      return null;
    }
    if (!config.apiKey || !config.apiKeySecret ||
        !config.accessToken || !config.accessTokenSecret) {
      this.app.debug('TWITTER', `getTwitterClient: credenciais incompletas no twitter-config.json`);
      return null;
    }

    const cacheKey = `${config.apiKey}|${config.accessToken}`;
    if (this.clientCache && this.clientCacheKey === cacheKey) {
      return this.clientCache;
    }

    try {
      this.clientCache = new TwitterApi({
        appKey: config.apiKey,
        appSecret: config.apiKeySecret,
        accessToken: config.accessToken,
        accessSecret: config.accessTokenSecret,
      });
      this.clientCacheKey = cacheKey;
      this.app.debug('TWITTER', `cliente Twitter inicializado (OAuth 1.0a)`);
      return this.clientCache;
    } catch (e) {
      this.app.debug('TWITTER', `erro ao criar cliente Twitter: ${(e as Error).message}`);
      return null;
    }
  }

  // ===========================================================================
  // GERAÇÃO DE TWEET — generateTweet (chama IA direto, com fallback de modelo)
  // ===========================================================================

  /**
   * Extrai mensagens de usuário do bot.log quando o contexto em memória tá vazio.
   * O log tem linhas tipo:
   *   [time] [DEBUG MSG] recebida: 120363xxx@g.us: texto da mensagem
   *   [time] [DEBUG MSG] recebida: 55219xxx@c.us [sticker]:
   * A gente parseia essas linhas, extrai o texto, filtra comandos, e retorna
   * formatado como "[Alguém]: texto" (sem nome real — o log não tem).
   *
   * @param maxLines Qtde máxima de mensagens pra extrair.
   * @returns Array de strings formatadas "[Alguém]: texto".
   */
  private extractMessagesFromLog(maxLines: number): string[] {
    try {
      const logPath = this.app.config.logDir + '/bot.log';
      const logContent = fs.readFileSync(logPath, 'utf8');
      const allLines = logContent.split('\n').filter(l => l.length > 0);
      // Pega as últimas N*3 linhas (nem toda é MSG)
      const recent = allLines.slice(-maxLines * 3);

      const messages: string[] = [];
      for (const line of recent) {
        // Match: [time] [DEBUG MSG] recebida: chatId: texto
        const match = line.match(/\[DEBUG MSG\] recebida: \S+: (.+)$/);
        if (!match) continue;
        const text = match[1].trim();
        if (!text || text === '(sem texto)') continue;
        if (text.startsWith('!') || text.startsWith('/')) continue;
        if (text.startsWith('[mandou') || text.startsWith('[respondendo') || text.startsWith('[CONTEÚDO')) continue;
        messages.push(`[Alguém]: ${text}`);
      }

      return messages;
    } catch (e) {
      this.app.debug('TWITTER', `erro ao ler bot.log: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Gera um tweet a partir das últimas mensagens do chat `chatId`.
   *
   * Pega o contexto acumulado em `app.context.getRecent(chatId)`, filtra as
   * últimas ~30 mensagens de usuários (pula comandos e mensagens do bot),
   * formata como "[Name]: text", e manda pra IA com um prompt específico de
   * tweet (280 chars, PT-BR informal, sem nomes reais, estilo provocativo/
   * petista). Também coleta imagens anexadas a essas mensagens e as repassa
   * pra IA (no caso do Gemini, como inlineData parts) pra que ela possa
   * decidir anexar a imagem mais recente ao tweet, sinalizando com o marcador
   * `[COM_IMAGEM]` no início da resposta. Chama a API diretamente (mesmo
   * padrão do handleResumo), sem injetar o contexto acumulado do bot.
   *
   * Portado byte-a-byte de generateTweet() do index.js velho (linhas
   * 4860-5120).
   *
   * @returns { text, imageData, imageMimetype } ou null se não houver contexto
   *          suficiente ou a IA retornar vazio.
   */
  async generateTweet(chatId: string): Promise<{ text: string; imageData: string | null; imageMimetype: string | null } | null> {
    const config = this.getConfig();

    // Pega as últimas 30 mensagens do contexto, filtra comandos e mensagens do
    // bot. Também coleta imagens (mensagens com imageData + imageMimetype) pra
    // poder anexá-las ao tweet se a IA decidir que faz sentido.
    const recent = this.app.context.getRecent(chatId).slice(-30);
    const lines: string[] = [];
    const images: Array<{ data: string; mimetype: string }> = [];
    for (const m of recent) {
      if (!m.content) continue;
      const text = String(m.content).trim();
      if (!text) continue;
      if (text.startsWith('!') || text.startsWith('/')) continue;  // comandos
      if (text.startsWith('[mandou') || text.startsWith('[respondendo') || text.startsWith('[CONTEÚDO')) continue; // placeholders
      if (m.role === 'assistant') continue;  // pula mensagens do próprio bot
      const name = m.sender || 'Alguém';
      lines.push(`[${name}]: ${text}`);
      if (m.imageData && m.imageMimetype) {
        images.push({ data: m.imageData, mimetype: m.imageMimetype });
      }
    }

    // Se não tem contexto em memória, tenta buscar do decision-log
    // (Retroactive.getRecentMessages). O decision-log tem senderName + text
    // + timestamp — MUITO melhor que bot.log (que não tem nome).
    if (lines.length === 0) {
      this.app.debug('TWITTER', `sem contexto em memória — buscando decision-log`);
      if (this.app.retroactive) {
        const recentMsgs = this.app.retroactive.getRecentMessages(30);
        if (recentMsgs.length > 0) {
          // Inverte pra ordem cronológica (mais antigo → mais recente)
          recentMsgs.reverse();
          for (const m of recentMsgs) {
            // Filtra comandos e placeholders
            const text = m.text.trim();
            if (!text || text.startsWith('!') || text.startsWith('/')) continue;
            if (text.startsWith('[mandou') || text.startsWith('[respondendo') || text.startsWith('[CONTEÚDO')) continue;
            lines.push(`[${m.senderName}]: ${text}`);
          }
          this.app.debug('TWITTER', `recuperadas ${lines.length} mensagens do decision-log`);
        }
      }
    }

    // Se ainda não tem, tenta bot.log como último recurso
    if (lines.length === 0) {
      this.app.debug('TWITTER', `decision-log vazio — tentando bot.log`);
      const logLines = this.extractMessagesFromLog(50);
      if (logLines.length > 0) {
        lines.push(...logLines);
        this.app.debug('TWITTER', `recuperadas ${logLines.length} mensagens do bot.log`);
      }
    }

    if (lines.length === 0) {
      this.app.debug('TWITTER', `nenhuma mensagem encontrada (memória + log) pra gerar tweet`);
      return null;
    }

    // Usa só as últimas 20 linhas formatadas pra não estourar o prompt.
    const conversationText = lines.slice(-20).join('\n');

    // Monta prompt. Usa a PERSONALIDADE REAL do Márcio (system-prompt.txt)
    // como base — mesma voz do WhatsApp. Depois adiciona regras específicas
    // de Twitter (280 chars, não citar nomes, etc).
    const marcioPersonality = this.app.brain.getSystemPrompt();

    let tweetPrompt = [
      '=== SUA PERSONALIDADE (mesma do WhatsApp) ===',
      marcioPersonality,
      '',
      '=== AGORA VOCÊ ESTÁ NO TWITTER ===',
      'Escreva UM tweet baseado nas conversas recentes do seu grupo de WhatsApp.',
      'Use a MESMA personalidade, MESMO estilo, MESMA voz que você usa no WhatsApp.',
      'Você é a mesma pessoa — só que postando no Twitter em vez de respondendo no grupo.',
      '',
      'REGRAS DO TWITTER:',
      '- Máximo 280 caracteres.',
      '- NUNCA cite nomes reais de pessoas do grupo.',
      '- Pode comentar algo que aconteceu no grupo SEM identificar quem disse.',
      '- Pode ser sobre QUALQUER assunto que apareceu no grupo, não só política.',
      '- Estilo twitter brasileiro: curto, direto, às vezes irônico.',
      '- NÃO é propaganda política. É uma pessoa real postando. Política é só UM dos temas.',
      '',
      'NÃO SEJA CARICATO:',
      '- NÃO use "liberalóide", "extrema direita", "fascista" — isso é caricatura.',
      '- Seja NATURAL. Posta como uma pessoa real de 20 anos postaria.',
      '- Se a conversa foi sobre futebol, posta sobre futebol. Se foi sobre trabalho, sobre trabalho.',
      '',
      'Responda SÓ com o tweet, sem explicações. NUNCA comece com "!" ou "/".',
    ].join('\n');
    if (config.referenceStyle && String(config.referenceStyle).trim()) {
      tweetPrompt += `\n\nReferência de estilo:\n${String(config.referenceStyle).trim()}`;
    }
    tweetPrompt += `\n\nSe uma das imagens da conversa combinar com o tweet, comece sua resposta com [COM_IMAGEM]. Caso contrário, não inclua o marcador.`;

    // Chama a IA diretamente (não passa pelo brain.generateResponse pra não
    // injetar contexto/perfil/diretivas do bot).
    let content: string;
    try {
      content = await this.callGeminiForTweet(tweetPrompt, conversationText, images);
    } catch (e) {
      this.app.debug('TWITTER', `erro ao chamar IA pra gerar tweet: ${(e as Error).message}`);
      return null;
    }

    let cleaned = this.app.brain.cleanResponse(content);
    if (!cleaned || !cleaned.trim() || cleaned.trim() === '...') {
      this.app.debug('TWITTER', `resposta da IA veio vazia após limpeza`);
      return null;
    }

    // Detecta marcador [COM_IMAGEM] no início da resposta — a IA usa isso pra
    // sinalizar que quer anexar a imagem mais recente da conversa ao tweet.
    let useImage = false;
    const markerMatch = /^\[COM_IMAGEM\]\s*/i.exec(cleaned);
    if (markerMatch) {
      useImage = true;
      cleaned = cleaned.slice(markerMatch[0].length).trim();
    }

    // Garante que não começa com '!' ou '/' (regra do prompt, mas reforçado aqui).
    cleaned = cleaned.replace(/^[!\/]+\s*/, '').trim();

    // Trunca pra 280 caracteres (limite clássico do Twitter; X Premium aceita
    // mais, mas mantemos 280 por segurança).
    if (cleaned.length > 280) {
      cleaned = cleaned.slice(0, 277).trim() + '...';
    }

    // Se a IA pediu imagem mas não tem nenhuma na conversa, segue sem imagem.
    let imageData: string | null = null;
    let imageMimetype: string | null = null;
    if (useImage && images.length > 0) {
      const lastImage = images[images.length - 1];
      imageData = lastImage.data;
      imageMimetype = lastImage.mimetype;
      this.app.debug('TWITTER', `tweet gerado em ${chatId} COM imagem (${imageMimetype}, ${images.length} imgs no ctx): "${cleaned}" (${cleaned.length} chars)`);
    } else {
      this.app.debug('TWITTER', `tweet gerado em ${chatId}: "${cleaned}" (${cleaned.length} chars)`);
    }

    return { text: cleaned, imageData, imageMimetype };
  }

  // ===========================================================================
  // POSTAGEM — postTweetWithApproval (approvalMode → pendingTweets; senão direto)
  // ===========================================================================

  /**
   * Posta um tweet (ou pede aprovação, dependendo do config).
   *
   * Portado byte-a-byte de postTweetWithApproval() do index.js velho (linhas
   * 5130-5190). BUG FIX: o velho tinha `media_ids: [ediaId]` (typo) que
   * causava ReferenceError ao postar tweet com imagem — corrigido pra
   * `[mediaId]`.
   *
   * @returns 'pending' (approvalMode ligado), 'posted' (postado direto),
   *          ou 'error' (cliente indisponível / erro na API).
   */
  async postTweetWithApproval(
    chatId: string,
    tweetData: { text: string; imageData: string | null; imageMimetype: string | null } | string,
  ): Promise<PostResult> {
    const config = this.getConfig();

    // Garante o shape esperado mesmo se chamarem com string (defensivo).
    if (typeof tweetData === 'string') {
      tweetData = { text: tweetData, imageData: null, imageMimetype: null };
    }
    const { text: tweetText, imageData, imageMimetype } = tweetData;

    if (config.approvalMode) {
      // Manda a msg de aprovação pro approvalChatId (ou pro PV do próprio bot
      // se não estiver setado). O pendingTweets é keyed por ESSE chat-alvo,
      // porque é nele que o op vai responder "postar"/"descartar".
      const targetChat = config.approvalChatId || this.app.whatsapp.client.info?.wid?._serialized;
      if (!targetChat) {
        this.app.debug('TWITTER', `postTweetWithApproval: sem approvalChatId e client.info.wid indisponível — não foi possível enviar pra aprovação`);
        return 'error';
      }
      try {
        if (imageData && imageMimetype) {
          // Tem imagem: manda como foto com legenda (caption). Usa
          // MessageMedia.fromBuffer com o base64 + mimetype que vieram do
          // generateTweet (que por sua vez vieram do captureMessage do Context).
          const media = (MessageMedia as any).fromBuffer(Buffer.from(imageData, 'base64'), imageMimetype);
          await this.app.whatsapp.client.sendMessage(
            targetChat,
            media,
            { caption: `${this.app.config.botName}: 🐦 Tweet pronto pra aprovar:\n\n"${tweetText}"\n\n🖼️ Inclui imagem anexada\n\nResponda "postar" pra publicar ou "descartar" pra cancelar.` },
          );
        } else {
          // Sem imagem: texto puro.
          await this.app.whatsapp.client.sendMessage(
            targetChat,
            `${this.app.config.botName}: 🐦 Tweet pronto pra aprovar:\n\n"${tweetText}"\n\nResponda "postar" pra publicar ou "descartar" pra cancelar.`,
          );
        }
      } catch (e) {
        this.app.debug('TWITTER', `❌ erro ao enviar tweet pra aprovação em ${targetChat}: ${(e as Error).message}`);
        // Mesmo com erro, guarda o tweet — o op ainda pode aprovar
      }
      // Guarda o tweetData completo (inclusive imagem) no pendingTweets — o
      // maybeHandleApproval lê isso de volta quando o op responder.
      this.pendingTweets.set(targetChat, {
        text: tweetText,
        imageData,
        imageMimetype,
        timestamp: Date.now(),
        sourceChat: chatId,
      });
      this.app.debug('TWITTER', `✅ tweet enviado pra aprovação em ${targetChat} (origem: ${chatId}). Responda "postar" nesse chat pra publicar.${imageData ? ' (com imagem)' : ''}`);
      return 'pending';
    }

    // Modo direto: posta sem pedir aprovação. Lida com mídia (upload v1 +
    // tweet v2) quando há imagem; senão, tweet só texto.
    const twitterClient = this.getClient();
    if (!twitterClient) {
      this.app.debug('TWITTER', `cliente Twitter indisponível — não foi possível postar`);
      return 'error';
    }
    try {
      if (imageData) {
        const mediaId = await twitterClient.v1.uploadMedia(
          Buffer.from(imageData, 'base64'),
          { mimeType: imageMimetype || undefined },
        );
        // BUG FIX: velho tinha `media_ids: [ediaId]` (typo → ReferenceError).
        await twitterClient.v2.tweet(tweetText, { media: { media_ids: [mediaId] } });
        this.app.debug('TWITTER', `tweet postado diretamente (com imagem): "${tweetText}"`);
      } else {
        await twitterClient.v2.tweet(tweetText);
        this.app.debug('TWITTER', `tweet postado diretamente: "${tweetText}"`);
      }
      return 'posted';
    } catch (e) {
      this.app.debug('TWITTER', `erro ao postar tweet direto: ${(e as Error).message}`);
      return 'error';
    }
  }

  // ===========================================================================
  // CICLO AUTO-POST — generateAndPostTweet (chamado pelo setInterval)
  // ===========================================================================

  /**
   * Ciclo automático de geração+postagem de tweet, chamado pelo setInterval
   * configurado em startAutoPostTimer(). Escolhe o chat de origem (sourceChats
   * do config, ou o primeiro grupo com contexto), gera o tweet, e manda pro
   * fluxo de aprovação/direto. Todos os erros são engolidos (só logados) pra
   * não derrubar o intervalo.
   *
   * Portado byte-a-byte de generateAndPostTweet() do index.js velho (linhas
   * 5200-5260).
   */
  async generateAndPostTweet(): Promise<void> {
    try {
      const config = this.getConfig();
      if (!config.enabled) {
        this.app.debug('TWITTER', `auto-post skipped — twitter desativado`);
        return;
      }
      if (!TwitterApi) {
        this.app.debug('TWITTER', `auto-post skipped — twitter-api-v2 não instalado`);
        return;
      }

      // Escolhe o chat de origem: primeiro sourceChats que tenha contexto,
      // senão o primeiro grupo em app.context com contexto.
      let sourceChatId: string | null = null;
      if (config.sourceChats && config.sourceChats.length > 0) {
        const found = config.sourceChats.find(
          id => this.app.context.count(id) > 0,
        );
        sourceChatId = found || config.sourceChats[0];
      }
      if (!sourceChatId) {
        for (const id of this.app.context.activeChatIds()) {
          if (id.endsWith('@g.us') && this.app.context.count(id) > 0) {
            sourceChatId = id;
            break;
          }
        }
      }

      if (!sourceChatId) {
        this.app.debug('TWITTER', `auto-post skipped — nenhum chat de origem com contexto disponível`);
        return;
      }

      const tweetData = await this.generateTweet(sourceChatId);
      if (!tweetData) {
        this.app.debug('TWITTER', `auto-post skipped — generateTweet retornou null (chat ${sourceChatId})`);
        return;
      }

      // Manda o tweet pro fluxo de aprovação/direto. O "chatId" passado é a
      // origem — se approvalMode estiver ligado, a msg de aprovação vai pra
      // approvalChatId (ou PV do bot), não pro chat de origem.
      const result = await this.postTweetWithApproval(sourceChatId, tweetData);
      this.app.debug('TWITTER', `auto-post result=${result} | source=${sourceChatId}${tweetData.imageData ? ' (com imagem)' : ''}`);
    } catch (e) {
      this.app.debug('TWITTER', `erro no ciclo de auto-post: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // PAINEL — gera tweet e retorna pro painel (sem mandar pro WhatsApp)
  // ===========================================================================

  /**
   * Gera um tweet e retorna pro painel (sem mandar pra WhatsApp nem postar).
   * O painel mostra o tweet e o usuário decide se posta ou cancela.
   *
   * @returns { text, hasImage } ou null se não conseguiu gerar.
   */
  async generateForPanel(): Promise<{ text: string; hasImage: boolean } | null> {
    const config = this.getConfig();
    if (!config.enabled || !TwitterApi) return null;

    // Escolhe chat de origem (mesma lógica do generateAndPostTweet)
    let sourceChatId: string | null = null;
    if (config.sourceChats && config.sourceChats.length > 0) {
      const found = config.sourceChats.find(id => this.app.context.count(id) > 0);
      sourceChatId = found || config.sourceChats[0];
    }
    if (!sourceChatId) {
      for (const id of this.app.context.activeChatIds()) {
        if (id.endsWith('@g.us') && this.app.context.count(id) > 0) {
          sourceChatId = id;
          break;
        }
      }
    }
    if (!sourceChatId) {
      this.app.debug('TWITTER', `generateForPanel: nenhum chat com contexto`);
      return null;
    }

    const tweetData = await this.generateTweet(sourceChatId);
    if (!tweetData) return null;

    return { text: tweetData.text, hasImage: !!tweetData.imageData };
  }

  /**
   * Posta um tweet DIRETO (sem aprovação no WhatsApp).
   * Usado pelo painel quando o usuário clica "confirmar" depois de ver o tweet.
   *
   * @param text Texto do tweet (já gerado e aprovado pelo usuário no painel).
   * @returns 'posted' ou 'error'.
   */
  async postDirect(text: string): Promise<'posted' | 'error'> {
    if (!TwitterApi) return 'error';
    const twitterClient = this.getClient();
    if (!twitterClient) return 'error';

    try {
      await twitterClient.v2.tweet(text);
      this.app.log('TWITTER', `✅ Tweet postado direto pelo painel: "${text}"`);
      return 'posted';
    } catch (e) {
      this.app.debug('TWITTER', `erro ao postar direto: ${(e as Error).message}`);
      return 'error';
    }
  }

  // ===========================================================================
  // APROVAÇÃO — maybeHandleApproval (chamado pelo MessageRouter)
  // ===========================================================================

  /**
   * Intercepta respostas de aprovação de tweet pendente.
   *
   * Se há um tweet pendente pra este chat em `pendingTweets`, e a mensagem é
   * de um op dizendo "postar"/"post" ou "descartar"/"cancelar" (sem prefixo
   * de comando), tratamos aqui e retornamos true — o router não continua.
   * Caso contrário, retornamos false e o router continua (comando/IA).
   *
   * Tem que rodar ANTES do roteamento de comandos (no router) porque
   * "postar"/"descartar" não começam com ! ou /.
   *
   * Portado byte-a-byte do bloco de aprovação do index.js velho (linhas
   * 4053-4104).
   *
   * @returns true se a mensagem foi tratada (aprovada/descartada/erro), false
   *          se deve continuar o roteamento normal.
   */
  async maybeHandleApproval(msg: Message, chatId: string): Promise<boolean> {
    if (!this.pendingTweets.has(chatId)) {
      return false;
    }
    const approvalBody = (msg.body || '').trim().toLowerCase();
    this.app.debug('TWITTER', `mensagem no chat com tweet pendente: body="${approvalBody}", chatId=${chatId}`);
    if (approvalBody !== 'postar' && approvalBody !== 'post' &&
        approvalBody !== 'descartar' && approvalBody !== 'cancelar') {
      // Tweet pendente existe mas o body não é comando de aprovação — deixa
      // o router processar normalmente (pode ser um comando ou msg pra IA).
      return false;
    }

    const { all: approvalSenderIds } = await this.app.permissions.resolveSenderIds(msg);
    const approvalIsOp = this.app.permissions.isOp(msg.fromMe, approvalSenderIds);
    this.app.debug('TWITTER', `verificando op: isOp=${approvalIsOp}, senderIds=${JSON.stringify(approvalSenderIds)}`);
    if (!approvalIsOp) {
      // Não-op tentando aprovar — deixa o router processar (IA pode responder).
      return false;
    }

    const pending = this.pendingTweets.get(chatId)!;
    if (approvalBody === 'postar' || approvalBody === 'post') {
      try {
        const twitterClient = this.getClient();
        if (!twitterClient) {
          await this.app.notify(chatId, '❌ não consegui postar o tweet — cliente Twitter indisponível. Verifique */twitter* e o twitter-config.json.');
          return true;
        }
        // Posta com mídia se houver imageData (upload v1 + tweet v2).
        // Caso contrário, tweet só texto.
        if (pending.imageData) {
          const mediaId = await twitterClient.v1.uploadMedia(
            Buffer.from(pending.imageData, 'base64'),
            { mimeType: pending.imageMimetype || undefined },
          );
          // BUG FIX: velho tinha `media_ids: [ediaId]` (typo). Corrigido.
          await twitterClient.v2.tweet(pending.text, { media: { media_ids: [mediaId] } });
        } else {
          await twitterClient.v2.tweet(pending.text);
        }
        this.pendingTweets.delete(chatId);
        const imgNote = pending.imageData ? ' (com imagem)' : '';
        await this.app.notify(chatId, `✅ Tweet postado${imgNote}!`);
        this.app.debug('TWITTER', `tweet aprovado e postado por op em ${chatId}: "${pending.text}"${imgNote}`);
        this.app.log('TWITTER', `Tweet aprovado e postado por ${approvalSenderIds.join(' / ')} em ${chatId}${imgNote}.`);
      } catch (e) {
        await this.app.notify(chatId, `❌ erro ao postar tweet: ${(e as Error).message}`);
        this.app.debug('TWITTER', `erro ao postar tweet aprovado: ${(e as Error).message}`);
      }
      return true;
    } else {
      // descartar / cancelar
      this.pendingTweets.delete(chatId);
      await this.app.notify(chatId, '❌ Tweet descartado.');
      this.app.debug('TWITTER', `tweet descartado por op em ${chatId}`);
      return true;
    }
  }

  // ===========================================================================
  // TIMERS — auto-post + mention checker
  // ===========================================================================

  /**
   * Starta o setInterval de auto-post. O intervalo vem de
   * config.postIntervalHours (default 4h). Só inicia se enabled=true E
   * twitter-api-v2 estiver instalada.
   *
   * Portado do bloco em client.on('ready') do index.js velho (linhas
   * 3900-3913).
   */
  startAutoPostTimer(): void {
    try {
      const config = this.getConfig();
      if (config.enabled && TwitterApi) {
        const intervalMs = (config.postIntervalHours || 4) * 60 * 60 * 1000;
        this.autoPostTimer = setInterval(() => {
          this.generateAndPostTweet().catch(e => {
            this.app.debug('TWITTER', `erro no auto-post interval: ${(e as Error).message}`);
          });
        }, intervalMs);
        this.app.debug('TWITTER', `auto-posting a cada ${config.postIntervalHours || 4}h`);
      } else if (config.enabled && !TwitterApi) {
        this.app.debug('TWITTER', `config ativada mas twitter-api-v2 não instalado — auto-post desativado. Rode: npm i twitter-api-v2`);
      }
    } catch (e) {
      this.app.debug('TWITTER', `erro ao configurar auto-post: ${(e as Error).message}`);
    }
  }

  /** Para o setInterval de auto-post. */
  stopAutoPostTimer(): void {
    if (this.autoPostTimer) {
      clearInterval(this.autoPostTimer);
      this.autoPostTimer = null;
    }
  }

  /**
   * Starta o setInterval de checagem de menções. O intervalo vem de
   * config.mentionCheckIntervalMinutes (default 15min). Só inicia se
   * replyToMentions=true E twitter-api-v2 estiver instalada.
   *
   * NOTA: o bot velho NÃO implementava esta feature (os campos existiam no
   * config mas não havia código). Aqui implementamos uma versão mínima
   * funcional: a cada N minutos, busca as últimas menções ao bot via
   * userMentionTimeline, gera uma resposta via IA (mesmo prompt-style do
   * generateTweet), e posta como reply. O lastMentionId evita responder a
   * mesma menção duas vezes.
   */
  startMentionChecker(): void {
    const config = this.getConfig();
    if (!config.replyToMentions) return;
    if (!TwitterApi) {
      this.app.debug('TWITTER', `startMentionChecker: twitter-api-v2 não instalado`);
      return;
    }
    const intervalMs = (config.mentionCheckIntervalMinutes || 15) * 60 * 1000;
    this.mentionTimer = setInterval(() => {
      this.checkMentions().catch(e => {
        this.app.debug('TWITTER', `erro no mention checker: ${(e as Error).message}`);
      });
    }, intervalMs);
    this.app.debug('TWITTER', `mention checker iniciado — a cada ${config.mentionCheckIntervalMinutes || 15}min`);
  }

  /** Para o setInterval de menções. */
  stopMentionChecker(): void {
    if (this.mentionTimer) {
      clearInterval(this.mentionTimer);
      this.mentionTimer = null;
    }
  }

  /**
   * Desliga tudo (timers). Chamado pelo app.shutdown().
   */
  destroy(): void {
    this.stopAutoPostTimer();
    this.stopMentionChecker();
  }

  // ===========================================================================
  // MENTION CHECKER — implementação mínima (não existia no bot velho)
  // ===========================================================================

  /**
   * Busca menções recentes ao bot e responde as novas.
   *
   * Fluxo:
   *  1. Pega o user ID do bot via client.v2.me()
   *  2. Busca últimas 5 menções via userMentionTimeline
   *  3. Pra cada menção com ID > lastMentionId:
   *     - Gera reply via IA (callGeminiForTweet com prompt de menção)
   *     - Posta como reply (client.v2.reply)
   *     - Atualiza lastMentionId
   *
   * Erros são engolidos (só logados) pra não derrubar o intervalo.
   */
  private async checkMentions(): Promise<void> {
    const client = this.getClient();
    if (!client) return;
    try {
      const me = await client.v2.me();
      const myId = me?.data?.id;
      if (!myId) {
        this.app.debug('TWITTER', `checkMentions: não consegui pegar myId`);
        return;
      }
      const timeline = await client.v2.userMentionTimeline(myId, {
        max_results: 5,
        'tweet.fields': ['author_id', 'text', 'created_at'],
      });
      const tweets: any[] = timeline?.data?.data || [];
      if (tweets.length === 0) return;

      // Ordena por ID asc (IDs do Twitter são lexicograficamente ordenados por
      // tempo — maior = mais recente).
      tweets.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));

      for (const t of tweets) {
        const tid = String(t.id);
        if (this.lastMentionId && tid <= this.lastMentionId) continue;
        const replyText = await this.generateMentionReply(String(t.text || ''));
        if (replyText) {
          try {
            await client.v2.reply(replyText, t.id);
            this.app.debug('TWITTER', `respondida menção ${tid}: "${replyText}"`);
          } catch (e) {
            this.app.debug('TWITTER', `erro ao responder menção ${tid}: ${(e as Error).message}`);
          }
        }
        if (!this.lastMentionId || tid > this.lastMentionId) {
          this.lastMentionId = tid;
        }
      }
    } catch (e) {
      this.app.debug('TWITTER', `erro ao checar menções: ${(e as Error).message}`);
    }
  }

  /**
   * Gera uma resposta curta pra uma menção, no estilo do bot.
   * Usa o mesmo callGeminiForTweet do generateTweet, com prompt próprio.
   */
  private async generateMentionReply(mentionText: string): Promise<string | null> {
    const mentionPrompt = [
      'Você é o Márcio Pinto no Twitter. Alguém te marcou.',
      '',
      'REGRAS:',
      '- Responda com UM tweet curto (máximo 280 caracteres).',
      '- Português brasileiro, minúsculas, informal.',
      '- Estilo twitter brasileiro: curto, direto, às vezes irônico.',
      '- Pode concordar, discordar, zomar, ou só comentar — seja natural.',
      '- NUNCA comece com "!" ou "/".',
      '- Responda SÓ com o tweet, sem explicações.',
      '',
      `Menção recebida:\n"${mentionText}"`,
    ].join('\n');

    let content: string;
    try {
      content = await this.callGeminiForTweet(mentionPrompt, '', []);
    } catch (e) {
      this.app.debug('TWITTER', `erro ao gerar reply de menção: ${(e as Error).message}`);
      return null;
    }

    let cleaned = this.app.brain.cleanResponse(content);
    if (!cleaned || !cleaned.trim() || cleaned.trim() === '...') return null;
    cleaned = cleaned.replace(/^[!\/]+\s*/, '').trim();
    if (cleaned.length > 280) {
      cleaned = cleaned.slice(0, 277).trim() + '...';
    }
    return cleaned;
  }

  // ===========================================================================
  // IA — callGeminiForTweet (chamada direta à API, com fallback de modelo)
  // ===========================================================================

  /**
   * Chama a API de IA diretamente (não passa pelo brain.generateResponse pra
   * não injetar contexto/perfil/diretivas do bot). Réplica do padrão do
   * handleResumo (BasicCommands) e do generateTweet velho.
   *
   * Suporta:
   *  - Gemini (Google AI Studio): imagens como inlineData parts na user msg
   *  - OpenAI-compatible (Ollama, Groq, OpenRouter): imagens ignoradas
   *
   * Fallback chain: se o modelo principal retornar 429/503, tenta os
   * fallbackModels na ordem. Atualiza brain.lastUsedModel quando um fallback
   * sucede.
   *
   * @returns Conteúdo bruto da resposta da IA.
   * @throws Em caso de erro de rede/API ou resposta vazia.
   */
  private async callGeminiForTweet(
    systemPrompt: string,
    userContent: string,
    images: Array<{ data: string; mimetype: string }>,
  ): Promise<string> {
    const aiConfig = this.app.brain.getAIConfig();
    const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

    const aiMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent, images },
    ];

    let content: string | undefined;
    if (provider === 'gemini') {
      // === FORMATO GEMINI (Google AI Studio) ===
      // Imagens são anexadas como inlineData parts na user message (mesmo
      // padrão do handler de conversa principal). OpenAI: ignoramos imagens.
      const systemMessages = aiMessages.filter(m => m.role === 'system');
      const conversationMessages = aiMessages.filter(m => m.role !== 'system');

      let systemInstruction: any = null;
      if (systemMessages.length > 0) {
        systemInstruction = {
          parts: [{ text: systemMessages.map(m => m.content).join('\n\n') }],
        };
      }

      const contents = conversationMessages.map(m => {
        const parts: any[] = [{ text: m.content }];
        if (m.images && m.images.length > 0) {
          for (const img of m.images) {
            parts.push({ inlineData: { mimeType: img.mimetype, data: img.data } });
          }
        }
        return {
          role: m.role === 'assistant' ? 'model' : 'user',
          parts,
        };
      });

      // Helper: chama Gemini com um modelo específico (cópia do padrão do
      // handleResumo, com fallback em caso de 429/503).
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
            this.app.debug('TWITTER', `⚠️ modelo principal esgotou (429/503), tentando fallback: ${fbModel}`);
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
      // Imagens são intencionalmente ignoradas aqui (suporte a visão OpenAI
      // fica fora deste escopo — mesma decisão do handler de conversa
      // principal). Ainda assim a instrução [COM_IMAGEM] fica no prompt, mas
      // a IA não tem como ver as imagens, então é esperado que não use o
      // marcador nesse caminho.
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (aiConfig.apiKey) {
        headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
      }
      const openaiMessages = aiMessages.map(m => ({ role: m.role, content: m.content }));
      const response = await fetch(aiConfig.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: aiConfig.model,
          messages: openaiMessages,
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

    return content;
  }
}
