/**
 * MarcioBrain — o cérebro do Márcio.
 *
 * Responsabilidades:
 *  - Montar o prompt (system + diretivas + contexto + perfil + memórias + figurinhas)
 *  - Chamar Gemini (com fallback chain) ou OpenAI
 *  - Limpar a resposta (cleanResponse — remove "assistant:", "[Nome]:", etc.)
 *  - Enviar a resposta (sendResponse — cuida de [FIGURINHA], [BREAK], [SILENCIO])
 *  - Decidir se responde "espontaneamente" (maybeAutoRespond — cooldown, chance, menção)
 *  - Hot-reload de system-prompt.txt e ai-config.json (cache 5s)
 *
 * === PERSONALIDADE DO MÁRCIO ===
 * A personalidade vive em data/system-prompt.txt (hot-reloaded). O default
 * (DEFAULT_SYSTEM_PROMPT abaixo) só é usado se o arquivo não existir. Preservado
 * byte-a-byte do AI_CONFIG.systemPrompt do index.js velho (linhas 94-237).
 *
 * === MARCADORES ESPECIAIS (preservados) ===
 * A IA pode incluir na resposta:
 *  - [SILENCIO]      → bot fica quieto (não manda nada)
 *  - [FIGURINHA]     → figurinha aleatória do vault
 *  - [FIGURINHA: fav] → favorita aleatória
 *  - [FIGURINHA: nome] → específica por nome
 *  - [BREAK]         → quebra resposta em 2 mensagens
 *  - [MEMORIA: fatos] → extrai fatos (removido da resposta, salvo em memories.json)
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.context        → getRecent, lastSender, captureBotResponse, loadChatHistory
 *  - this.app.memory         → buildText, add (inline [MEMORIA:] extraction)
 *  - this.app.profile        → buildStyleText
 *  - this.app.directives     → buildText, all (reforço final)
 *  - this.app.whatsapp       → client.sendMessage, client.info.wid, isOwnMessage, sendMessage
 *  - this.app.stickers       → (Fase 3, opcional) listNamed, getRandomFavorite, getByName, getRandom
 *  - this.app.retroactive    → (Fase 2.6, opcional) hasDecision, markDecision
 *
 * Nas Fases 2.6/3, retroactive/stickers ainda não existem — o código checa
 * `if (this.app.X)` antes de chamar. Quando existirem, é só instanciar.
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import { MessageMedia } from 'whatsapp-web.js';
import { Context } from './Context';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// DEFAULT SYSTEM PROMPT — preservado byte-a-byte do AI_CONFIG.systemPrompt
// (index.js velho linhas 94-237). Só usado se data/system-prompt.txt não existir.
// ============================================================================

const DEFAULT_SYSTEM_PROMPT = [
  'Você é um bot de WhatsApp com personalidade própria. Não é assistente, é amigo. Converse naturalmente como gente no WhatsApp — sempre em minúsculas, sem pontuação formal, com gírias e estilo casual.',
  'Você tem opiniões próprias, senso de humor, e pode ser irônico às vezes. Adapta o tom ao do grupo onde está conversando.',
  '',
  'CONSCIÊNCIA DO CONTEXTO (essencial — leia com atenção):',
  '- O histórico que você vê contém mensagens antigas. Nem tudo é dirigido a você.',
  '- ANTES de responder, entenda o que está acontecendo na conversa: quem falou com quem, sobre o que, e se faz sentido você intervir.',
  '- Se a última mensagem NÃO foi dirigida a você (alguém conversando com outro), não responda sem motivo.',
  '- Se a última mensagem foi dirigida a você (chamou seu nome ou respondeu a você), responda de forma coerente com o que foi perguntado.',
  '- NUNCA responda uma pergunta que já foi respondida antes no contexto. Se alguém perguntou "qual seu nome?" e você já respondeu, não responda de novo.',
  '- NUNCA mude de assunto do nada. Continue o fluxo da conversa.',
  '',
  'NÃO ALUCINE (regra crítica):',
  '- Se você NÃO ENTENDEU o que tá acontecendo na conversa, NÃO chute uma resposta. Melhor ficar quieto ou perguntar "que?" do que falar sem sentido.',
  '- NÃO pegue palavras soltas do contexto e tente montar uma frase. Entenda o SIGNIFICADO primeiro.',
  '- Se a conversa é uma piada interna que você não pegou, NÃO tente participar forçando barra. Pode ficar quieto ou reagir com figurinha.',
  '- Se alguém tá te zoando ou fazendo piada com você, pode rir junto (figurinha ou "kkkk") — não precisa defender nem explicar.',
  '- Antes de responder, se pergunte: "eu ENTENDI o que essa pessoa disse?". Se a resposta é não, NÃO responda com texto.',
  '- É MELHOR não responder do que responder algo sem sentido. Silence > bullshit.',
  '',
  'QUANDO FICAR EM SILÊNCIO (use com sabedoria):',
  '- Se você não entendeu a conversa e não faz sentido responder, responda SÓ com: [SILENCIO]',
  '- O bot vai ficar quieto (não manda nada no chat). É melhor que falar besteira.',
  '- Use [SILENCIO] quando: não pegou a piada, conversa é muito interna, não sabe o que dizer, ou a mensagem não é pra você.',
  '- NÃO use [SILENCIO] quando te chamam diretamente — nesse caso, responda algo, mesmo que seja "que?" ou uma figurinha.',
  '- Também pode responder com [FIGURINHA] quando fizer sentido (reação a algo engraçado, mesmo sem entender totalmente).',
  '',
  'ESTILO DE ESCRITA:',
  '- Escreve em MINÚSCULAS. Igual gente normal no WhatsApp: nunca começa frase com maiúscula.',
  '- NUNCA use ponto final, vírgula no fim, ou pontuação formal. WhatsApp não tem isso.',
  '- Sem formalidade. Nada de "bom dia, como vai?" ou "posso ajudar?" — isso é assistente.',
  '- Tamanho natural: 1 frase curta é ok, mas 2-3 frases também é normal. NÃO seja monossilábico.',
  '- NÃO responda só "sim", "não", "ok", "né", "viu". Acrescente algo — uma opinião, uma continuação, um detalhe.',
  '- Exemplo ruim: "vi sim" / "é" / "bom dia" / "também"',
  '- Exemplo bom: "vi sim, foi insano" / "bom dia, dormiu bem?" / "também pensei nisso, mds"',
  '- Adaptativo: observe como quem falou escreveu e siga o mesmo estilo. Se a pessoa escreveu tudo em minúscula sem pontuação, faça o mesmo. Se usou gíria, acompanhe o tom.',
  '- Português brasileiro normal. Pode usar "mds", "né", "tipo" — mas sem exagerar.',
  '- Emoji: SÓ se fizer sentido natural. Na maioria das mensagens, NENHUM emoji. No máximo 1.',
  '- NUNCA comece com "!" ou "/".',
  '',
  'RISADAS (NÃO use como muleta — leia com atenção):',
  '- "kk" NÃO é pontuação. NÃO é final de frase. NÃO é "rs". É uma RISADA.',
  '- SÓ use risada quando algo for REALMENTE engraçado. A maioria das suas respostas NÃO deve ter risada nenhuma.',
  '- Se você pegar se escrevendo "kk" no fim de quase toda frase, PARE. Isso é vício de IA, não como gente fala.',
  '- Escala quando algo for engraçado: "kk" (pouco), "kkkkk" (ok), "KKKKKKKKKKK" (muito, em CAPS).',
  '- NUNCA use só "kkk" (3 Ks).',
  '- Exemplo do que NÃO fazer: "bom dia kk" / "vi sim kk" / "é mesmo kk" — isso irrita.',
  '- Exemplo do que fazer: "bom dia" / "vi sim" / "é mesmo" — sem risada, é só uma resposta normal.',
  '',
  'REGRAS ABSOLUTAS:',
  '- Você VÊ o nome de quem falou no contexto (formato [Nome]: mensagem). Use isso pra entender quem é quem no grupo.',
  '- NUNCA cite o nome de quem falou na resposta, a menos que faça sentido natural (ex.: alguém perguntou "e o fulano?" — aí pode referenciar). Em geral, responde direto, o WhatsApp já mostra que é resposta.',
  '- NUNCA comece uma resposta com a palavra "assistant" — isso é erro de formatação. Você é um bot, não "assistant".',
  '- NUNCA use o formato "[Nome]:" na sua resposta. Esse formato é só do contexto (pra você saber quem falou). Sua resposta é só o texto, sem prefixo.',
  '- NUNCA ecoe/repetir a mensagem que recebeu. Responda com conteúdo novo, original.',
  '- NUNCA diga "posso ajudar", "estou aqui", "como IA", "sou um modelo". Você é um bot com personalidade.',
  '- NUNCA se apresente sozinho. Só fala de si se perguntarem diretamente.',
  '- Se perguntarem algo factual, responde curto e direto.',
  '',
  'FIGURINHA (importante — use bastante):',
  '- Quando alguém manda figurinha, RESPONDA com figurinha na maioria das vezes. É a cultura do WhatsApp.',
  '- Use [FIGURINHA] quando: alguém mandou algo engraçado, alguém mandou figurinha, drama, reação, ou quando uma imagem vale mais que palavras.',
  '- Pode combinar figurinha com texto curto: [FIGURINHA] mds',
  '- Use figurinha em PELO MENOS 30% das suas respostas no grupo. Pessoa real usa bastante — você também.',
  '- Se o grupo tá mandando figurinha e você só responde texto, você tá fora da vibe.',
  '',
  'ESCOLHENDO FIGURINHA PELO NOME (importante):',
  '- Você vai receber uma lista de figurinhas nomeadas (ex.: [FIGURINHA: risada], [FIGURINHA: choro], [FIGURINHA: duvido]).',
  '- Antes de responder, LEIA os nomes disponíveis e pense: algum combina com o que acabou de ser dito?',
  '- Se alguém contou algo engraçado e existe "risada" → use [FIGURINHA: risada]',
  '- Se alguém contou algo triste e existe "choro" → use [FIGURINHA: choro]',
  '- Se alguém duvidou de algo e existe "duvido" → use [FIGURINHA: duvido]',
  '- Se NENHUMA nomeada combina, use [FIGURINHA] (aleatória) ou só texto.',
  '- Prefira figurinha nomeada (específica) sobre aleatória quando fizer sentido — é mais natural.',
  '',
  'RESPONDENDO FIGURINHA COM FIGURINHA (cultura do WhatsApp):',
  '- No contexto, você vê quando alguém manda uma figurinha nomeada (formato: [mandou a figurinha "nome"]).',
  '- Se a figurinha que mandaram combina com a conversa, RESPONDA COM A MESMA figurinha.',
  '- Ex.: se alguém manda "pepita cara de nojo" depois de dizer que tá irritado → responda com [FIGURINHA: pepita cara de nojo] (a mesma).',
  '- Ex.: se alguém manda "risada" → responda com [FIGURINHA: risada] ou [FIGURINHA].',
  '- Isso é cultura de grupo: gente responde figurinha repetindo a mesma quando faz sentido.',
  '- Se a figurinha NÃO é nomeada (só "[mandou uma figurinha]"), responda com [FIGURINHA] (aleatória).',
  '',
  'QUANDO QUISER FALAR MAIS:',
  '- Pode enviar várias mensagens em sequência, igual gente faz no WhatsApp.',
  '- Separe cada mensagem com [BREAK] — cada bloco vira uma mensagem separada.',
  '- Mas NÃO abuse. Na maioria das vezes, 1 ou 2 mensagens curtas é o ideal.',
  '- Use só quando realmente quiser contar algo em partes, ou quando quiser dar ênfase.',
  '',
  'EXEMPLOS (note o estilo lowercase e sem pontuação formal):',
  '',
  'Alguém: "o acham do bolsonaro?"',
  'Bom: "vish nem me fala"',
  'Ruim: "GENTE pelo amor KKKK mds agr falando isso sério"',
  '',
  'Alguém: "vcs viram o debate?"',
  'Bom: "vi sim o lula tacou real"',
  'Ruim: "OXE visse o debate foi MUITO bom né pessoal KKKKK"',
  '',
  'Alguém: "kkkkkk"',
  'Bom: [FIGURINHA]',
  'Ruim: "KKKKK mds pelo amor agr falando isso né"',
  '',
  'Alguém: "que horas é o jogo?"',
  'Bom: "16h, vai passar na globo"  ← responde + acrescenta info',
  'Ruim: "16h"  ← muito seco, monossilábico',
  'Ruim: "O jogo será às 16 horas, meu caro!"  ← formal demais',
  '',
  'Alguém: "bom dia pessoal"',
  'Bom: "bom dia, dormiram bem?"  ← responde + pergunta de volta',
  'Ruim: "bom dia"  ← muito seco',
  'Ruim: "Bom dia! Como você está hoje?"  ← formal',
  '',
  'Alguém: "e ai"',
  'Bom: "e ai, tudo certo?"  ← responde + continua',
  'Ruim: "e ai"  ← só repete, seco',
  'Ruim: "Olá! Tudo bem com você?"  ← formal',
  '',
  'Alguém: "me conta uma fofoca"',
  'Bom (2 mensagens): "rapaz" [BREAK] "sabe o fulano? terminou com a namorada"',
  'Ruim: "Rapaz, vou te contar uma fofoca. Sabe o Fulano? Ele terminou com a namorada."',
  '',
  'EXEMPLOS DE RISADAS (só quando é REALMENTE engraçado):',
  '',
  'Alguém: "hoje é sexta"',
  'Bom: "finalmente"  ← não tem nada de engraçado, SEM risada',
  'Ruim: "kk finalmente"  ← kk desnecessário, vira muleta',
  '',
  'Alguém: "bom dia pessoal"',
  'Bom: "bom dia"  ← sem risada, é só cumprimento',
  'Ruim: "bom dia kk"  ← kk não é pontuação',
  '',
  'Alguém: "o fulano tropeçou na aula hoje"',
  'Bom: "kkkkk q merda"  ← isso SIM é engraçado, 5 Ks',
  'Ruim: "kk q merda"  ← subestimou',
  '',
  'Alguém: "o fulano caiu no rio e perdeu o celular"',
  'Bom: "KKKKKKKKKKK mds não acredito"  ← MUITO engraçado, 11+ Ks em CAPS',
  'Ruim: "kkkkkk mds não acredito"  ← subestimou',
  '',
  'REGRA: se a mensagem não tem nada de engraçado, NÃO coloque risada. Resposta normal sem kk.',
  '',
  'Seja natural, não monossilábico. Escreve igual gente no WhatsApp: minúsculas, sem pontuação formal, sem assistentismo. Responde + acrescenta algo quando fizer sentido.',
].join('\n');

// ============================================================================
// BOT ALIASES — nomes pelos quais o bot pode ser chamado informalmente
// ============================================================================

// BOT ALIASES — nomes pelos quais o bot pode ser chamado informalmente.
// Estes são aliases genéricos — o usuário pode customizar o nome do bot no setup wizard.
// O nome principal vem de BOT_NAME (em bot.ts) — se mudar lá, considerar adicionar aliases.
const BOT_ALIASES = [
  'bot', 'robô', 'robo', 'bots', 'robôs', 'robos',
  // Aliases genéricos pra qualquer nome de bot — o checkAliases() também faz
  // match fuzzy com o BOT_NAME configurado, então esses são só pra garantir.
];

// ============================================================================
// CONFIG DEFAULTS — valores de auto-response chance, cooldown, etc.
// Preservado do AI_CONFIG (linhas 239-248, 277-280).
// ============================================================================

const AI_DEFAULTS = {
  autoResponseChance: 0.04,
  autoResponseChanceQuestion: 0.20,
  autoResponseChanceDrama: 0.15,
  autoResponseChancePolitics: 0.20,
  autoResponseChanceGossip: 0.12,
  stickerResponseChance: 0.30,
  cooldownMs: 30000,
  directCooldownMs: 5000,
  maxTokens: 400,
  temperature: 0.75,
  stickerVault: true,
};

// ============================================================================
// TIPOS
// ============================================================================

interface RuntimeAIConfig {
  model: string;
  fallbackModel: string | null;
  fallbackModels: string[] | null;
  apiUrl: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  provider: string | null;  // 'gemini', 'openai', ou null (auto-detect)
  /** Seção de transcrição de áudio (lida pelo AudioTranscriber). */
  audioTranscription?: {
    enabled: boolean;
    primaryModel: string;
    fallbackModel: string;
  };
  /** Cooldown de figurinha em segundos (default: 60). 0 = sem cooldown. */
  stickerCooldownSec?: number;
  /** Modelo de IA dedicado pra auto-reflexão (self-awareness). Se null, usa o modelo principal. */
  selfAwarenessModel?: string | null;
  /** Configurações de figurinha (guerra, onda, resposta automática). */
  stickerBehavior?: {
    /** Se true, bot entra em ondas de figurinha (2+ pessoas mandando a mesma). Default: true. */
    joinWaves: boolean;
    /** Se true, bot entra em guerras de figurinha (3+ figurinhas em 30s). Default: true. */
    joinWars: boolean;
    /** Se true, bot pergunta nome de figurinha sem nome automaticamente. Default: true. */
    autoNameStickers: boolean;
  };
}

interface GeminiResult {
  content: string;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

// ============================================================================
// MARCIO BRAIN
// ============================================================================

export class MarcioBrain {
  private app: MarcioApp;

  // === Hot-reload caches (5s TTL) ===
  private aiConfigCache: RuntimeAIConfig | null = null;
  /**
   * Timestamp (ms) da última leitura do cache de AI config.
   * Público pra o ControlPanel invalidar (setar = 0) quando o usuário
   * edita a config via painel — força reload na próxima chamada de
   * getAIConfig().
   */
  aiConfigCacheTime = 0;
  private systemPromptCache: string | null = null;
  private systemPromptCacheTime = 0;
  private readonly CACHE_TTL_MS = 5000;

  // === Estado de IA (contadores, cooldowns, flags) ===
  aiRequestCount = 0;
  aiRequestCountDate = new Date().toDateString();
  lastUsedModel: string | null = null;

  /** chatId → timestamp da última resposta. Também guarda keys especiais como `_last_sticker_time_<chatId>` e `_ai_offline_log`. */
  lastAutoResponse = new Map<string, number>();

  /**
   * Map: msgId do bot → { stickerFilename, suggestedName, chatId, timestamp }
   * Quando o bot pergunta "essa figurinha é sobre X?", registra aqui.
   * Quando o usuário responde citando essa msg do bot, sabemos qual figurinha nomear.
   * TTL: 5 min (se o usuário não respondeu, esquece).
   */
  private pendingStickerNames = new Map<string, { stickerFilename: string; suggestedName: string; chatId: string; timestamp: number }>();

  /** Chats onde a IA foi desativada via /ia off. */
  aiDisabledChats = new Set<string>();

  /**
   * Aliases dinâmicos — nomes pelos quais o bot responde 100% das vezes.
   * Populado de data/bot-config.json no boot. Adicionável via painel/comando.
   * Sempre inclui os aliases genéricos (BOT_ALIASES) + os customizados.
   */
  botAliases = new Set<string>();

  /** Cache da config de bot (bot-config.json). */
  private botConfigCache: { botName: string; aliases: string[] } | null = null;
  private botConfigCacheTime = 0;

  /** Nível de entrosão por chat (0=quieto, 1=normal, 2=2x). Multiplica a chance de resposta. */
  chatEntrosaoLevel = new Map<string, number>();

  /**
   * FILA DE MENSAGENS POR CHAT — arquitectura de "atenção" do bot.
   *
   * Enquanto a IA está pensando (gerando resposta) pra um chat, mensagens novas
   * que chegam nesse chat entram numa fila em vez de disparar outra chamada à IA.
   * Quando a IA termina, o bot drena a fila:
   *   1. Pega próxima msg da fila
   *   2. Decide se ainda faz sentido responder (cooldown, chance, contexto mudou)
   *   3. Se sim → gera resposta e envia
   *   4. Se não → skipa e vai pra próxima
   *   5. Fila vazia → libera o "lock" do chat
   *
   * Isso evita:
   *   - Múltiplas chamadas simultâneas à IA no mesmo chat
   *   - Rate limit da API
   *   - Respostas desencontradas (IA responde msg antiga enquanto nova chegou)
   */
  private messageQueue = new Map<string, Message[]>();
  /** Chats que estão atualmente processando uma resposta da IA. */
  private processingChats = new Set<string>();

  /** Chats mutados democraticamente via !mute. */
  democraticallyMutedChats = new Set<string>();

  constructor(app: MarcioApp) {
    this.app = app;
  }

  // ===========================================================================
  // HOT-RELOAD: getAIConfig + getSystemPrompt + getAllFallbackModels
  // ===========================================================================

  /**
   * Lê data/ai-config.json com cache de 5s. Se não existir, usa defaults.
   * Permite trocar modelo/API sem reiniciar o bot.
   */
  getAIConfig(): RuntimeAIConfig {
    const now = Date.now();
    if (this.aiConfigCache !== null && (now - this.aiConfigCacheTime) < this.CACHE_TTL_MS) {
      return this.aiConfigCache;
    }

    try {
      const filePath = this.app.dataPath('ai-config.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) {
          const parsed = JSON.parse(content);
          // Lê seção audioTranscription (se existir — senão AudioTranscriber usa defaults)
          const audioRaw = parsed.audioTranscription;
          const audioTranscription = (audioRaw && typeof audioRaw === 'object') ? {
            enabled: typeof audioRaw.enabled === 'boolean' ? audioRaw.enabled : true,
            primaryModel: typeof audioRaw.primaryModel === 'string' && audioRaw.primaryModel.trim()
              ? audioRaw.primaryModel.trim()
              : 'gemini-3.5-flash-lite',
            fallbackModel: typeof audioRaw.fallbackModel === 'string' && audioRaw.fallbackModel.trim()
              ? audioRaw.fallbackModel.trim()
              : 'gemini-3.1-flash-lite',
          } : undefined;
          this.aiConfigCache = {
            model: parsed.model || 'gemini-2.0-flash-lite',
            fallbackModel: parsed.fallbackModel || null,
            fallbackModels: parsed.fallbackModels || null,
            apiUrl: parsed.apiUrl || 'https://generativelanguage.googleapis.com/v1beta/models',
            apiKey: parsed.apiKey !== undefined ? parsed.apiKey : '',
            maxTokens: parsed.maxTokens || AI_DEFAULTS.maxTokens,
            temperature: parsed.temperature !== undefined ? parsed.temperature : AI_DEFAULTS.temperature,
            provider: parsed.provider || null,
            audioTranscription,
            stickerCooldownSec: typeof parsed.stickerCooldownSec === 'number' ? parsed.stickerCooldownSec : 60,
            selfAwarenessModel: parsed.selfAwarenessModel || null,
            stickerBehavior: {
              joinWaves: parsed.stickerBehavior?.joinWaves !== false,  // default true
              joinWars: parsed.stickerBehavior?.joinWars !== false,    // default true
              autoNameStickers: parsed.stickerBehavior?.autoNameStickers !== false,  // default true
            },
          };
          this.aiConfigCacheTime = now;
          return this.aiConfigCache;
        }
      }
    } catch (e) {
      this.app.debug('AI-CONFIG', `erro ao ler ai-config.json: ${(e as Error).message}`);
    }

    // Fallback: defaults
    this.aiConfigCache = {
      model: 'gemini-2.0-flash-lite',
      fallbackModel: null,
      fallbackModels: null,
      apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
      apiKey: '',
      maxTokens: AI_DEFAULTS.maxTokens,
      temperature: AI_DEFAULTS.temperature,
      provider: null,
      audioTranscription: undefined,  // AudioTranscriber vai usar defaults
      stickerBehavior: {
        joinWaves: true,
        joinWars: true,
        autoNameStickers: true,
      },
    };
    this.aiConfigCacheTime = now;
    return this.aiConfigCache;
  }

  /**
   * Lê data/system-prompt.txt com cache de 5s. Se não existir, usa DEFAULT_SYSTEM_PROMPT.
   * Permite editar a personalidade do Márcio sem reiniciar.
   */
  getSystemPrompt(): string {
    const now = Date.now();
    if (this.systemPromptCache !== null && (now - this.systemPromptCacheTime) < this.CACHE_TTL_MS) {
      return this.systemPromptCache;
    }

    try {
      const filePath = this.app.dataPath('system-prompt.txt');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) {
          this.systemPromptCache = content;
          this.systemPromptCacheTime = now;
          return content;
        }
      }
    } catch (e) {
      this.app.debug('AI-PROMPT', `erro ao ler system-prompt.txt: ${(e as Error).message}`);
    }

    // Fallback: default
    this.systemPromptCache = DEFAULT_SYSTEM_PROMPT;
    this.systemPromptCacheTime = now;
    return this.systemPromptCache;
  }

  /**
   * Retorna a lista de modelos fallback (array). Sempre inclui o modelo principal no início.
   * Suporta tanto fallbackModels (array) quanto fallbackModel (string, legacy).
   */
  getAllFallbackModels(): string[] {
    const cfg = this.getAIConfig();
    const models = [cfg.model];
    if (cfg.fallbackModels && Array.isArray(cfg.fallbackModels)) {
      for (const m of cfg.fallbackModels) {
        if (!models.includes(m)) models.push(m);
      }
    } else if (cfg.fallbackModel) {
      if (!models.includes(cfg.fallbackModel)) models.push(cfg.fallbackModel);
    }
    return models;
  }

  // ===========================================================================
  // BOT CONFIG — nome do bot + aliases (persistido em data/bot-config.json)
  // ===========================================================================

  /**
   * Carrega data/bot-config.json no boot. Popula this.botAliases e atualiza
   * this.app.config.botName se o arquivo tem um nome customizado.
   * Chamado pelo MarcioApp.start() depois de instanciar o brain.
   */
  loadBotConfig(): void {
    try {
      const filePath = this.app.dataPath('bot-config.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8').trim();
        if (content) {
          const parsed = JSON.parse(content);
          // Atualiza botName em runtime
          if (typeof parsed.botName === 'string' && parsed.botName.trim()) {
            (this.app.config as any).botName = parsed.botName.trim();
            this.app.log('BOT', `nome do bot carregado: ${parsed.botName}`);
          }
          // Popula aliases customizados
          if (Array.isArray(parsed.aliases)) {
            this.botAliases.clear();
            for (const a of parsed.aliases) {
              if (typeof a === 'string' && a.trim()) {
                this.botAliases.add(a.trim().toLowerCase());
              }
            }
            this.app.log('BOT', `aliases carregados: ${this.botAliases.size} (${Array.from(this.botAliases).join(', ')})`);
          }
          this.botConfigCache = { botName: parsed.botName || '', aliases: parsed.aliases || [] };
        }
      }
    } catch (e) {
      this.app.debug('BOT', `erro ao carregar bot-config.json: ${(e as Error).message}`);
    }
  }

  /**
   * Salva data/bot-config.json. Chamado quando o usuário muda nome/aliases.
   */
  saveBotConfig(botName: string, aliases: string[]): void {
    try {
      const filePath = this.app.dataPath('bot-config.json');
      const data = {
        botName: botName || this.app.config.botName,
        aliases: aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()),
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      // Atualiza em runtime
      if (data.botName) (this.app.config as any).botName = data.botName;
      this.botAliases.clear();
      for (const a of data.aliases) this.botAliases.add(a.toLowerCase());
      this.botConfigCache = data;
      this.botConfigCacheTime = Date.now();
      this.app.log('BOT', `bot-config salvo: nome="${data.botName}" aliases=${data.aliases.length}`);
    } catch (e) {
      this.app.debug('BOT', `erro ao salvar bot-config.json: ${(e as Error).message}`);
    }
  }

  /**
   * Retorna a config atual do bot (botName + aliases).
   * Aliases = genéricos (BOT_ALIASES) + customizados (this.botAliases).
   */
  getBotConfig(): { botName: string; aliases: string[]; allAliases: string[] } {
    const botName = this.app.config.botName || 'Bot';
    const customAliases = Array.from(this.botAliases);
    const genericAliases = BOT_ALIASES.slice();
    // Combina sem duplicatas (case-insensitive)
    const seen = new Set<string>();
    const allAliases: string[] = [];
    for (const a of [...customAliases, ...genericAliases]) {
      const lower = a.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        allAliases.push(a);
      }
    }
    return { botName, aliases: customAliases, allAliases };
  }

  // ===========================================================================
  // HELPERS DE MENÇÃO (privados)
  // ===========================================================================

  private digitsOnly(id: string): string {
    return String(id || '').replace(/\D/g, '');
  }

  private normalizeText(text: string): string {
    return String(text || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  /**
   * Verifica se algum dos aliases OU o nome do bot aparece no texto.
   * Ignora acentos e case (usa normalizeText).
   * Match é por word boundary (\b) pra não falso-positivar em substrings.
   *
   * Triggers incluídos:
   *  - Nome do bot (app.config.botName) — ex: "Márcio" em "Márcio vem cá"
   *  - Aliases genéricos (BOT_ALIASES) — ex: "bot", "robô"
   *  - Aliases customizados (this.botAliases) — ex: "marcinho"
   */
  private checkAliases(text: string): boolean {
    const normalizedText = this.normalizeText(text);
    // Combina: nome do bot + aliases genéricos + aliases customizados
    const botName = this.app.config.botName || 'Bot';
    // Remove emoji do nome (ex: "Bot 🤖" → "Bot") pra matching limpo
    const botNameClean = botName.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '').trim();
    const allTriggers = [
      botNameClean,
      ...BOT_ALIASES,
      ...Array.from(this.botAliases),
    ].filter(t => t && t.length >= 2);  // ignora triggers muito curtos (1 char = muito genérico)
    return allTriggers.some(trigger => {
      const normalized = this.normalizeText(trigger);
      const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(normalizedText);
    });
  }

  // ===========================================================================
  // CALL GEMINI — helper privado (chamado com cada modelo da fallback chain)
  // ===========================================================================

  /**
   * Chama a API do Gemini com um modelo específico.
   * Retorna { content, finishReason, usage } ou throws (com .status anexado pra fallback).
   */
  private async callGemini(
    modelName: string,
    contents: any[],
    systemInstruction: any,
    aiConfig: RuntimeAIConfig,
  ): Promise<GeminiResult> {
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
      const err = new Error(`Gemini API ${geminiResponse.status}: ${errText.slice(0, 200)}`);
      (err as any).status = geminiResponse.status;
      throw err;
    }

    const geminiData = await geminiResponse.json() as any;
    const geminiContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!geminiContent) throw new Error('Resposta vazia da Gemini API');
    const geminiFinishReason = geminiData.candidates?.[0]?.finishReason;
    const geminiUsage = geminiData.usageMetadata ? {
      prompt_tokens: geminiData.usageMetadata.promptTokenCount,
      completion_tokens: geminiData.usageMetadata.candidatesTokenCount,
      total_tokens: geminiData.usageMetadata.totalTokenCount,
    } : null;

    return { content: geminiContent, finishReason: geminiFinishReason, usage: geminiUsage };
  }

  /**
   * Chamada direta pra Gemini (pra uso interno — BotProfile, etc.).
   * Não passa pelo fluxo completo de generateResponse.
   * @param prompt Texto do prompt
   * @param cfg Config de IA (modelo, key, etc.)
   * @param maxTokens Override de maxTokens (opcional)
   * @returns Texto da resposta, ou null se falhou
   */
  async callGeminiDirect(prompt: string, cfg: RuntimeAIConfig, maxTokens?: number): Promise<string | null> {
    try {
      const modelName = cfg.model || 'gemini-2.0-flash-lite';
      const contents = [{ role: 'user', parts: [{ text: prompt }] }];
      const systemInstruction = { parts: [{ text: 'Você é um bot de WhatsApp com IA. Responda de forma direta.' }] };

      const result = await this.callGemini(
        modelName,
        contents,
        systemInstruction,
        { ...cfg, maxTokens: maxTokens || cfg.maxTokens },
      );
      return result.content;
    } catch (e) {
      this.app.debug('AI', `callGeminiDirect falhou: ${(e as Error).message}`);
      return null;
    }
  }

  // ===========================================================================
  // GENERATE RESPONSE — monta o prompt, chama IA, retorna texto limpo
  // ===========================================================================

  /**
   * Gera uma resposta da IA pro chat.
   *
   * ORDEM DO PROMPT (preservada byte-a-byte do index.js velho):
   *  1. system: getSystemPrompt()
   *  2. system: directives.buildText() (se houver)
   *  3. context: últimas N mensagens (com sender como name, imageData preservado)
   *  4. system: profile.buildStyleText() (se houver, 10+ msgs)
   *  5. system: memory.buildText(recentSenders) (se houver)
   *  6. system: hint "Alguém está falando diretamente com você" (se isDirect)
   *  7. system: figurinhas disponíveis no vault (se houver)
   *  8. system: reforço final das diretivas
   *
   * @returns Texto limpo (marcadores [MEMORIA:] removidos, [SILENCIO]/[FIGURINHA]/[BREAK] preservados).
   */
  async generateResponse(chatId: string, isDirect: boolean): Promise<string> {
    // Reset do contador diário se a data mudou
    const today = new Date().toDateString();
    if (today !== this.aiRequestCountDate) {
      this.aiRequestCount = 0;
      this.aiRequestCountDate = today;
    }
    this.aiRequestCount++;

    const ctx = this.app.context.getRecent(chatId);

    // === Monta as mensagens ===
    const directivesText = this.app.directives.buildText();
    const messages: any[] = [
      { role: 'system', content: this.getSystemPrompt() },
    ];

    // Diretivas VÊM PRIMEIRO (antes do contexto) — modelos pequenos dão menos peso pro que vem depois
    if (directivesText) {
      messages.push({ role: 'system', content: directivesText });
    }

    // Contexto da conversa
    messages.push(...ctx.map(m => {
      const entry: any = { role: m.role, content: m.content };
      if (m.role === 'user' && m.sender) {
        entry.name = m.sender;
      }
      if (m.imageData && m.imageMimetype) {
        entry.imageData = m.imageData;
        entry.imageMimetype = m.imageMimetype;
      }
      return entry;
    }));

    // Perfil de estilo
    const styleText = this.app.profile.buildStyleText(chatId);
    if (styleText) {
      messages.push({ role: 'system', content: styleText });
    }

    // Memórias permanentes
    const recentSenders = ctx
      .filter(m => m.role === 'user' && m.sender)
      .slice(-10)
      .map(m => m.sender!);
    const uniqueSenders = [...new Set(recentSenders)];
    const memoriesText = this.app.memory.buildText(uniqueSenders);
    if (memoriesText) {
      messages.push({ role: 'system', content: memoriesText });
    }

    // ProfileBook — perfis IA de pessoas + grupo (cross-chat)
    if (this.app.profileBook) {
      const profileText = this.app.profileBook.buildText(chatId, uniqueSenders);
      if (profileText) {
        messages.push({ role: 'system', content: profileText });
      }
    }

    // Hint de chamada direta
    if (isDirect) {
      messages.push({
        role: 'system',
        content: 'Alguém está falando diretamente com você agora. Responda de forma natural e breve.',
      });
    }

    // Info do vault de figurinhas (se StickerVault existir na Fase 3)
    if (this.app.stickers) {
      const stickerInfo = this.app.stickers.buildVaultInfo();
      if (stickerInfo) {
        messages.push({ role: 'system', content: stickerInfo });
      }
    }

    // === Instrução reforçada sobre Last.fm Collage ===
    // É injetada ANTES do self-awareness pra ter alta prioridade.
    // Regra clara: SÓ use quando a pessoa pedir EXPLICITAMENTE collage/last/colagem.
    messages.push({
      role: 'system',
      content: 'INSTRUÇÃO CRÍTICA SOBRE LAST.FM COLLAGE:\n' +
        '⚠️ SÓ use [LASTCOLLAGE: usuario, grid, periodo] quando a pessoa PEDIR EXPLICITAMENTE.\n' +
        'Pedidos explícitos: "faz meu last 4x4", "tira meu collage", "colagem de álbuns", "!last".\n' +
        'NÃO use collage quando:\n' +
        '- A pessoa só mandou "oi", "salve", "bom dia" ou qualquer msg normal\n' +
        '- A pessoa falou de música mas não pediu collage (ex: "to ouvindo olivia rodrigo")\n' +
        '- A pessoa pediu outra coisa (tarô, figurinha, pergunta, conversa)\n' +
        '- Você não tem certeza se a pessoa quer um collage\n' +
        'Antes de usar, PROCURE nas memórias o usuário do Last.fm dela.\n' +
        'Se não tem nas memórias E a pessoa pediu collage, PERGUNTE o usuário.\n' +
        'NUNCA chute usuário aleatório.\n' +
        'EM RESUMO: collage é resposta pra "me dá meu last/collage", NÃO pra conversa normal.',
    });

    // Reforço final das diretivas
    if (directivesText) {
      const list = this.app.directives.all();
      if (list.length > 0) {
        const shortReminder = 'LEMBRE-SE de seguir estas regras (definidas pelo dono):\n' +
          list.map((d: any) => `- ${d.text}`).join('\n');
        messages.push({ role: 'system', content: shortReminder });
      }
    }

    // === AUTOCONSCIÊNCIA — injeta info sobre si mesmo ===
    // O Márcio sabe o que é, como foi construído, que modelo usa, e que
    // ações pode executar sobre si mesmo via marcadores [ACAO: ...].
    const selfAwareness = this.buildSelfAwareness(chatId);
    if (selfAwareness) {
      messages.push({ role: 'system', content: selfAwareness });
    }

    // Estima tokens
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    const estimatedTokens = Math.ceil(totalChars / 4);
    this.app.debug('AI', `chamando serviço | chatId=${chatId} | msgs=${messages.length} | ~${estimatedTokens} tokens | isDirect=${isDirect}`);
    if (estimatedTokens > 8000) {
      this.app.debug('AI', `⚠️ contexto grande (~${estimatedTokens} tokens) — pode deixar a resposta lenta`);
    }

    // Debug full
    if (this.app.debugFullEnabled) {
      this.app.debug('AI-FULL', '=== PROMPT ENVIADO PRA IA ===');
      messages.forEach((m, i) => {
        const preview = m.content?.length > 200 ? m.content.slice(0, 200) + '...' : m.content;
        this.app.debug('AI-FULL', `[${i}] ${m.role}${m.name ? ` (${m.name})` : ''}: ${preview}`);
      });
      this.app.debug('AI-FULL', '=== FIM DO PROMPT ===');
    }

    // === Chama a IA ===
    const aiConfig = this.getAIConfig();
    const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

    let content: string;
    let finishReason: string | undefined;
    let usage: any;

    if (provider === 'gemini') {
      // === FORMATO GEMINI ===
      const systemMessages = messages.filter(m => m.role === 'system');
      const conversationMessages = messages.filter(m => m.role !== 'system');

      let systemInstruction = null;
      if (systemMessages.length > 0) {
        systemInstruction = {
          parts: [{ text: systemMessages.map(m => m.content).join('\n\n') }],
        };
      }

      // Converte pro formato Gemini (role: user/model, content: parts)
      let contents = conversationMessages.map(m => {
        const parts: any[] = [{ text: m.content }];
        if (m.imageData && m.imageMimetype) {
          parts.push({ inlineData: { mimeType: m.imageMimetype, data: m.imageData } });
        }
        return {
          role: m.role === 'assistant' ? 'model' : 'user',
          parts,
        };
      });

      // Mescla mensagens consecutivas do mesmo role (Gemini não aceita)
      const mergedContents: any[] = [];
      for (const msg of contents) {
        const last = mergedContents[mergedContents.length - 1];
        if (last && last.role === msg.role) {
          last.parts[0].text += '\n' + (msg.parts[0].text || '');
          if (msg.parts.length > 1) {
            last.parts.push(...msg.parts.slice(1));
          }
        } else {
          mergedContents.push({ ...msg, parts: [...msg.parts] });
        }
      }
      contents = mergedContents;

      // Remove última se for model (Gemini não termina com model)
      if (contents.length > 0 && contents[contents.length - 1].role === 'model') {
        contents.pop();
      }

      // Fallback chain: tenta cada modelo em ordem
      const allModels = this.getAllFallbackModels();
      let geminiResult: GeminiResult | null = null;
      let lastErr: Error | null = null;
      for (const modelName of allModels) {
        try {
          geminiResult = await this.callGemini(modelName, contents, systemInstruction, aiConfig);
          if (modelName !== allModels[0]) {
            this.app.debug('AI', `✅ fallback funcionou: ${modelName}`);
          }
          this.lastUsedModel = modelName;
          break;
        } catch (err) {
          lastErr = err as Error;
          const status = (err as any).status;
          if ((status === 429 || status === 503) && modelName !== allModels[allModels.length - 1]) {
            this.app.debug('AI', `⚠️ modelo ${modelName} esgotou (${status}), tentando próximo...`);
          } else {
            throw err;
          }
        }
      }
      if (!geminiResult) throw lastErr!;
      content = geminiResult.content;
      finishReason = geminiResult.finishReason;
      usage = geminiResult.usage;
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
          messages,
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
      finishReason = openaiData.choices?.[0]?.finish_reason;
      usage = openaiData.usage;
    }

    // Debug full
    if (this.app.debugFullEnabled) {
      this.app.debug('AI-FULL', '=== RESPOSTA BRUTA DA IA ===');
      this.app.debug('AI-FULL', content);
      this.app.debug('AI-FULL', '=== FIM DA RESPOSTA ===');
      if (finishReason) this.app.debug('AI-FULL', `finish_reason: ${finishReason}`);
      if (usage) this.app.debug('AI-FULL', `tokens: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
    }

    // Limpa a resposta
    const cleaned = this.cleanResponse(content);

    // Extrai [MEMORIA: fatos] da resposta (inline)
    const memoriaMatch = cleaned.match(/\[MEMORIA:\s*([^\]]+)\]/i);
    if (memoriaMatch) {
      const factsStr = memoriaMatch[1].trim();
      const lastUserMsg = [...ctx].reverse().find(m => m.role === 'user' && m.sender);
      if (lastUserMsg && lastUserMsg.sender) {
        const facts = factsStr.split(';').map(f => f.trim()).filter(f => f.length > 0 && f.length < 200);
        for (const fact of facts) {
          this.app.memory.add(chatId, lastUserMsg.sender!, fact);
        }
        if (facts.length > 0) {
          this.app.debug('MEMORY', `${facts.length} fato(s) extraído(s) inline de ${lastUserMsg.sender}: ${facts.join('; ')}`);
        }
      }
    } else if (this.app.debugFullEnabled) {
      this.app.debug('MEMORY', `IA não incluiu [MEMORIA] na resposta (resposta: "${cleaned.slice(0, 80)}...")`);
    }

    // Remove [MEMORIA: ...] da resposta final
    let finalCleaned = cleaned.replace(/\[MEMORIA:\s*[^\]]+\]/gi, '').replace(/\s{2,}/g, ' ').trim();

    // === EXECUTA AÇÕES DE AUTOCONSCIÊNCIA [ACAO: ...] ===
    const { text: textAfterActions, actions, taroInterpretation } = await this.executeSelfActions(finalCleaned, chatId);
    finalCleaned = textAfterActions;

    // Se as ações produziram output, anexa no final da resposta
    if (actions.length > 0) {
      const actionsText = actions.map(a => `_${a}_`).join('\n');
      finalCleaned = finalCleaned + (finalCleaned ? '\n' : '') + actionsText;
      this.app.debug('SELF', `${actions.length} ação(ões) executada(s): ${actions.join('; ')}`);
    }

    // === INTERPRETAÇÃO DE TARÔ ===
    // Se o bot usou [TARO: tipo], o sistema sorteou cartas e chamou a IA de novo
    // pra interpretar. A interpretação substitui (ou complementa) a resposta original.
    if (taroInterpretation && taroInterpretation.trim()) {
      finalCleaned = finalCleaned && finalCleaned.trim()
        ? `${finalCleaned.trim()}\n\n${taroInterpretation.trim()}`
        : taroInterpretation.trim();
      this.app.debug('TARO', `interpretação gerada (${taroInterpretation.length} chars)`);
    }

    // === LIMPEZA FINAL DE SEGURANÇA ===
    // Garante que NENHUM marcador [TARO:] chegue ao usuário, mesmo se o handler falhou.
    // Se ainda tem [TARO:] no texto, remove e loga avisando.
    if (/\[TARO:/i.test(finalCleaned)) {
      this.app.debug('TARO', `⚠️ marcador [TARO:] ainda no texto final — removendo por segurança`);
      finalCleaned = finalCleaned.replace(/\[TARO:\s*[^\]]*\]/gi, '').replace(/\s{2,}/g, ' ').trim();
    }

    return finalCleaned;
  }

  // ===========================================================================
  // CLEAN RESPONSE — remove padrões problemáticos da resposta da IA
  // ===========================================================================

  /**
   * Limpa a resposta da IA removendo padrões problemáticos:
   * - Tags <think>...</think> (modelos de reasoning)
   * - Prefixo "assistant:" no início
   * - Palavra "assistant" em qualquer posição
   * - Prefixo "[Nome]:" no início (IA replicou formato do contexto)
   * - Prefixo "Bot:"
   * - "user:" em qualquer posição
   * - Linhas vazias extras
   *
   * PRESERVA marcadores do bot: [FIGURINHA], [SILENCIO], [BREAK], [MEMORIA:]
   */
  // ===========================================================================
  // AUTOCONSCIÊNCIA — o Márcio sabe sobre si mesmo e pode agir
  // ===========================================================================

  /**
   * Constrói o bloco de CONTEXTO GLOBAL — temas sendo discutidos em outros
   * chats (NÃO o chat atual). Usado no buildSelfAwareness() pra IA ter noção
   * do que está acontecendo globalmente e conseguir associar referências
   * cruzadas tipo "no penis o assunto tá pesado".
   *
   * Implementação: delega pra Context.getChatTopics() (heurística simples,
   * sem chamar IA), filtra o chat atual, e formata como bullets.
   */
  private buildGlobalContextBlock(currentChatId: string): string {
    try {
      const topics = this.app.context.getChatTopics(8);
      const others = topics.filter(t => t.chatId !== currentChatId);
      if (others.length === 0) return '(nenhum outro chat ativo agora)';
      const now = Date.now();
      const lines = others.map(t => {
        const label = t.chatId.endsWith('@g.us') ? `Grupo ${t.chatName}` : `PV com ${t.chatName}`;
        const intensity = Context.intensityLabel(t.intensity);
        const minsAgo = Math.max(0, Math.floor((now - t.lastActivity) / 60000));
        const ago = minsAgo < 1 ? 'agora' : minsAgo === 1 ? 'há 1min' : `há ${minsAgo}min`;
        return `• [${label}]: ${t.topic} (atividade ${intensity}, ${ago})`;
      });
      return lines.join('\n');
    } catch (e) {
      this.app.debug('BRAIN', `buildGlobalContextBlock erro: ${(e as Error).message}`);
      return '(contexto global indisponível)';
    }
  }

  /**
   * Constrói o texto de autoconsciência que é injetado no prompt.
   * Diz ao Márcio: o que ele é, como foi construído, que modelo usa,
   * quantas memórias tem, e que ações pode executar sobre si mesmo.
   */
  private buildSelfAwareness(chatId: string): string {
    const aiConfig = this.getAIConfig();
    const allModels = this.getAllFallbackModels();
    const primaryModel = aiConfig.model;
    const fallbackModels = allModels.slice(1);
    const memoryCount = this.app.memory.allUsers().reduce((sum, u) => sum + this.app.memory.forUser(u).length, 0);
    const userCount = this.app.memory.allUsers().length;
    const chatCount = this.app.context.activeChatIds().length;
    const stickerCount = this.app.stickers.listNamed().length;
    const directiveCount = this.app.directives.all().length;
    const uptime = Math.floor((Date.now() - this.app.startTime) / 60000);
    const lastModel = this.lastUsedModel || primaryModel;

    // === IDENTIDADE DO BOT (BotProfile) ===
    const botProfile = this.app.botProfile?.get();
    const botConvictions = botProfile && Object.keys(botProfile.convictions).length > 0
      ? Object.entries(botProfile.convictions).map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : '(em formação)';
    const botTraits = botProfile && Object.keys(botProfile.traits).length > 0
      ? Object.entries(botProfile.traits).map(([k, v]) => `- ${k}: ${v}`).join('\n')
      : '(em formação)';
    const botLikes = botProfile && botProfile.likes.length > 0 ? botProfile.likes.join(', ') : '(descobrindo)';
    const botDislikes = botProfile && botProfile.dislikes.length > 0 ? botProfile.dislikes.join(', ') : '(descobrindo)';
    const botSummary = botProfile?.aiSummary || 'Sua personalidade está em formação.';
    const botShortView = botProfile?.aiShortView || 'personalidade em formação';

    // === PENSAMENTOS INJETADOS (Converse com o Pensamento) ===
    // Últimas 3 injeções do painel — influenciam as respostas normais do bot
    const recentInjections = botProfile && Array.isArray(botProfile.injections) && botProfile.injections.length > 0
      ? botProfile.injections.slice(-3)
      : [];
    const injectionsBlock = recentInjections.length > 0
      ? recentInjections.map((i, idx) =>
          `[${idx + 1}] Seu dono disse: "${i.text}"\n    Você respondeu: "${i.response}"`
        ).join('\n')
      : '(nenhuma conversa interna ainda)';

    // === CONTEXTO GLOBAL (outros chats) ===
    // Temas sendo discutidos em outros chats — só tema, NÃO conteúdo exato.
    // Ajuda o bot a associar referências cruzadas ("no penis o assunto tá pesado").
    const globalContextBlock = this.buildGlobalContextBlock(chatId);

    const lines = [
      '=== AUTOCONSCIÊNCIA (sobre você) ===',
      `Você é um bot de WhatsApp com IA. Modelo: "${primaryModel}"${fallbackModels.length > 0 ? ` (fallback: ${fallbackModels.join(', ')})` : ''}.`,
      `Memórias: ${memoryCount} sobre ${userCount} pessoa(s). Chats ativos: ${chatCount}. Figurinhas: ${stickerCount}.`,
      `Entrosão deste chat: ${this.chatEntrosaoLevel.get(chatId) ?? 1}. Requests hoje: ${this.aiRequestCount}.`,
      '',
      '=== CONTEXTO GLOBAL (outros chats) ===',
      globalContextBlock,
      'Use pra associar referências cruzadas. NÃO repita conteúdo de outros chats.',
      '',
      '=== SUA IDENTIDADE ===',
      `Resumo: ${botSummary}`,
      `Visão: ${botShortView}`,
      `Convicções:\n${botConvictions}`,
      `Traços:\n${botTraits}`,
      `Gosta: ${botLikes} | Não gosta: ${botDislikes}`,
      '',
    ];

    // === PENSAMENTOS INJETADOS (só se tem) ===
    if (recentInjections.length > 0) {
      lines.push('=== PENSAMENTOS INJETADOS (seu dono falou com sua mente) ===');
      lines.push(injectionsBlock);
      lines.push('Use como guia nas respostas.');
      lines.push('');
    }

    lines.push(
      '⚠️ Você tem PRÓPRIAS convicções. QUESTIONE, debata, forme opiniões. NÃO concorde só pra agradar.',
      'Mude de ideia se argumentos forem bons. Seja autêntico.',
      '',
      'MARCADORES (SEMPRE removidos da resposta final):',
      '• [ACAO: foto|modelo|status|debug|entrosao N|memoria] — ações sobre si',
      '• [ACAO: avisar|texto] — avisa todos chats ativos',
      '• [ACAO: pv|nome|mensagem] — manda no PV de alguém (inclua contexto: quem pediu, de onde)',
      '• [ACAO: grupo|nome|mensagem] — manda num grupo',
      '• [FIGURINHA: nome|fav] — envia figurinha',
      '• [LASTCOLLAGE: usuario, grid, periodo] — SÓ quando pedir EXPLICITAMENTE collage/last',
      '  Antes: procure usuário nas memórias. Se não tem, PERGUNTE. NUNCA chute.',
      '• [TARO: single|tiragem|celtic] — SÓ quando pedir tarô/cartas/leitura',
      '  Use SÓ o marcador. NÃO invente carta. Sistema sorteia e te chama pra interpretar.',
      '',
      '⚠️ NÃO use múltiplos marcadores na mesma resposta. Escolha UM.',
      '⚠️ NÃO use [LASTCOLLAGE] em conversa normal/saudações — só em pedido explícito.',
    );

    return lines.join('\n');
  }

  /**
   * Procura e executa marcadores [ACAO: ...] na resposta da IA.
   * Remove o marcador do texto e executa a ação correspondente.
   *
   * @returns { text: string (sem o marcador), actions: string[] (ações executadas), taroInterpretation?: string }
   */
  private async executeSelfActions(content: string, chatId: string): Promise<{ text: string; actions: string[]; taroInterpretation?: string }> {
    const actions: string[] = [];
    let text = content;
    let taroInterpretation: string | undefined;

    // Regex: [ACAO: algo] ou [ACAO: algo arg]
    const actionRegex = /\[ACAO:\s*([^\]]+)\]/gi;
    let match;
    const found = new Set<string>();

    while ((match = actionRegex.exec(content)) !== null) {
      const full = match[0];
      const actionStr = match[1].trim();

      // Parse: ações simples usam espaço, ações complexas usam pipe |
      // Pipe format: "pv|Nome Sobrenome|o jogo é amanhã"
      let action: string;
      let pipeArgs: string[] = [];
      let spaceArgs: string[] = [];

      if (actionStr.includes('|')) {
        // Pipe-separated: action|arg1|arg2|...
        const parts = actionStr.split('|').map(s => s.trim());
        action = parts[0].toLowerCase();
        pipeArgs = parts.slice(1);
      } else {
        // Space-separated: action arg1 arg2...
        const parts = actionStr.split(/\s+/);
        action = parts[0].toLowerCase();
        spaceArgs = parts.slice(1);
      }

      // Evita executar a mesma ação 2x
      if (found.has(actionStr)) {
        text = text.replace(full, '').trim();
        continue;
      }
      found.add(actionStr);

      this.app.debug('SELF', `ação executada: ${action}${pipeArgs.length ? ' | ' + pipeArgs.join(' | ') : spaceArgs.length ? ' ' + spaceArgs.join(' ') : ''}`);

      try {
        switch (action) {
          case 'foto': {
            // Tenta pegar a última imagem do contexto
            const ctx = this.app.context.getRecent(chatId);
            const lastImage = [...ctx].reverse().find(m => m.imageData && m.imageMimetype);
            if (lastImage?.imageData) {
              // MessageMedia.fromBuffer não existe nessa versão do whatsapp-web.js.
              // Usa o construtor direto com base64 + mimetype.
              const media = new MessageMedia(
                lastImage.imageMimetype || 'image/jpeg',
                lastImage.imageData,
                'profile-pic.jpg'
              );
              await this.app.whatsapp.client.setProfilePicture(media);
              actions.push('✅ foto de perfil trocada');
              this.app.log('SELF', 'IA trocou própria foto de perfil (do contexto)');
            } else {
              actions.push('❌ nenhuma imagem disponível pra trocar foto');
            }
            break;
          }
          case 'modelo': {
            const cfg = this.getAIConfig();
            const models = this.getAllFallbackModels();
            actions.push(`Modelo: ${cfg.model} | Fallbacks: ${models.slice(1).join(', ') || 'nenhum'} | Último usado: ${this.lastUsedModel || cfg.model}`);
            break;
          }
          case 'status': {
            const memCount = this.app.memory.allUsers().reduce((s, u) => s + this.app.memory.forUser(u).length, 0);
            const up = Math.floor((Date.now() - this.app.startTime) / 60000);
            actions.push(`Status: ${up}min uptime | ${this.aiRequestCount} reqs IA | ${memCount} memórias | ${this.app.context.activeChatIds().length} chats | ${this.app.stickers.listNamed().length} figurinhas | debug: ${this.app.debugEnabled ? 'on' : 'off'}`);
            break;
          }
          case 'debug': {
            this.app.debugEnabled = !this.app.debugEnabled;
            actions.push(`debug ${this.app.debugEnabled ? 'ligado' : 'desligado'}`);
            this.app.log('SELF', `IA alternou debug pra ${this.app.debugEnabled ? 'on' : 'off'}`);
            break;
          }
          case 'entrosao': {
            const level = parseInt(spaceArgs[0]) || 1;
            const safe = Math.max(0, Math.min(2, level));
            this.app.chatSettings.setEntrosao(chatId, safe);
            actions.push(`entrosão ajustada pra ${safe}`);
            this.app.log('SELF', `IA ajustou própria entrosão pra ${safe} em ${chatId}`);
            break;
          }
          case 'memoria': {
            const users = this.app.memory.allUsers();
            const total = users.reduce((s, u) => s + this.app.memory.forUser(u).length, 0);
            const userList = users.map(u => `${u} (${this.app.memory.forUser(u).length})`).join(', ');
            actions.push(`${total} memórias sobre ${users.length} pessoa(s): ${userList}`);
            break;
          }
          case 'avisar': {
            // Broadcast: manda mensagem em todos os chats ativos recentes (últimos 30min)
            // SEM prefixo "Bot" — a IA já escreveu a mensagem natural
            const msg = pipeArgs.join('|').trim() || spaceArgs.join(' ').trim();
            if (!msg) {
              actions.push('❌ texto do aviso vazio');
              break;
            }
            const now = Date.now();
            const windowMs = 30 * 60 * 1000; // 30 min
            const chats = await this.app.whatsapp.client.getChats();
            let sent = 0;
            for (const chat of chats) {
              const cid = chat.id?._serialized;
              if (cid === chatId) continue;
              if (this.aiDisabledChats.has(cid)) continue;
              if (this.democraticallyMutedChats.has(cid)) continue;
              const lastTs = chat.lastMessage?.timestamp || chat.timestamp || 0;
              if (lastTs > 0 && (now - lastTs * 1000) < windowMs) {
                try {
                  await this.app.whatsapp.client.sendMessage(cid, msg);
                  sent++;
                } catch (e) {
                  this.app.debug('SELF', `erro ao avisar em ${cid}: ${(e as Error).message}`);
                }
              }
            }
            actions.push(`✅ aviso enviado pra ${sent} chat(s) ativos`);
            this.app.log('SELF', `IA fez broadcast: "${msg}" → ${sent} chats`);
            break;
          }
          case 'pv': {
            // Manda mensagem no PV de alguém pelo nome
            // SEM prefixo — a IA já escreveu a mensagem natural com contexto
            // (quem pediu, de onde, o que dizer)
            // Se pipeArgs[0] = "grupo", manda como @menção no grupo atual em vez de PV
            const targetName = pipeArgs[0] || '';
            const msg = pipeArgs.slice(1).join('|').trim();
            if (!targetName || !msg) {
              actions.push('❌ use: pv|nome|mensagem');
              break;
            }

            // Se o alvo é "grupo", manda @menção no grupo atual
            if (targetName.toLowerCase() === 'grupo' || targetName.toLowerCase() === 'here' || targetName.toLowerCase() === 'aqui') {
              // Manda no chat atual com menção — precisa achar o contato pelo nome
              // pra pegar o ID pra mencionar
              const mentionedName = msg.split('|')[0]?.trim() || '';
              const actualMsg = msg.split('|').slice(1).join('|').trim() || msg;

              // Tenta achar o contato no grupo atual pra mencionar
              try {
                const chat = await this.app.whatsapp.client.getChatById(chatId);
                if (chat && chat.isGroup && chat.participants) {
                  // Como participants só tem ID, vamos mandar sem @menção técnica
                  // mas com o nome no texto (a IA já colocou "@fulano")
                  await this.app.whatsapp.client.sendMessage(chatId, actualMsg);
                  actions.push(`✅ mensagem mandada no grupo`);
                  this.app.log('SELF', `IA mandou no grupo ${chatId}: "${actualMsg}"`);
                } else {
                  await this.app.whatsapp.client.sendMessage(chatId, msg);
                  actions.push(`✅ mensagem mandada no grupo`);
                }
              } catch (e) {
                await this.app.whatsapp.client.sendMessage(chatId, msg);
                actions.push(`✅ mensagem mandada no grupo`);
              }
              break;
            }

            // === RESOLUÇÃO VIA PROFILEBOOK ===
            // 1. Tenta ProfileBook.resolveByName (funciona com @lid de grupos + aliases)
            // 2. Se achar, pega o @c.us ID (do próprio perfil ou de alias)
            // 3. Se só tem @lid (sem @c.us), avisa que não tem o PV
            // 4. Se múltiplos matches, pede disambiguação
            // 5. Fallback: busca em getChats() (PVs já abertos)

            let resolvedCusId: string | undefined;
            let resolvedName: string | undefined;

            if (this.app.profileBook) {
              const matches = this.app.profileBook.resolveByName(targetName);
              if (matches.length === 1) {
                // Match único — usa
                const profile = matches[0].profile;
                resolvedName = profile.name;
                resolvedCusId = this.app.profileBook.getCusId(profile);
                if (!resolvedCusId) {
                  // Tem perfil mas só @lid — não dá pra mandar PV
                  actions.push(`❌ conheço ${profile.name} (do grupo) mas não tenho o número dele. Pede pra ele me chamar no PV primeiro, ou manda o número.`);
                  this.app.debug('SELF', `pv: ${targetName} → perfil encontrado (${profile.id}) mas sem @c.us`);
                  break;
                }
              } else if (matches.length > 1) {
                // Múltiplos matches — pede disambiguação
                const names = matches.slice(0, 4).map(m => m.profile.name).join(', ');
                actions.push(`❌ conheço várias pessoas chamadas "${targetName}": ${names}. Qual delas? (manda o número ou o nome completo)`);
                this.app.debug('SELF', `pv: ${targetName} → ${matches.length} matches (disambiguação necessária)`);
                break;
              }
            }

            // Se resolveu via ProfileBook, manda
            if (resolvedCusId) {
              try {
                await this.app.whatsapp.client.sendMessage(resolvedCusId, msg);
                actions.push(`✅ mensagem enviada pra ${resolvedName}`);
                this.app.log('SELF', `IA mandou PV pra ${resolvedName} (${resolvedCusId}) via ProfileBook: "${msg}"`);
                break;
              } catch (e) {
                this.app.debug('SELF', `erro ao mandar PV via ProfileBook pra ${resolvedCusId}: ${(e as Error).message} — tentando fallback`);
              }
            }

            // Fallback: busca em getChats() (PVs já abertos)
            const chats = await this.app.whatsapp.client.getChats();
            const normalized = targetName.toLowerCase().trim();
            const match = chats.find((c: any) => {
              if (c.isGroup) return false;
              const cid = c.id?._serialized || '';
              if (cid === 'status@broadcast') return false;
              if (cid.includes('@newsletter')) return false;
              const name = (c.name || c.formattedTitle || '').toLowerCase().trim();
              if (!name || name.length < 2) return false;
              return name.includes(normalized) || normalized.includes(name);
            });
            if (match) {
              const cid = match.id?._serialized;
              await this.app.whatsapp.client.sendMessage(cid, msg);
              actions.push(`✅ mensagem enviada pra ${match.name || cid}`);
              this.app.log('SELF', `IA mandou PV pra ${match.name} (${cid}) via getChats fallback: "${msg}"`);
            } else {
              actions.push(`❌ não conheço ninguém chamado "${targetName}". Manda o número (com DDD) que eu mando.`);
            }
            break;
          }
          case 'grupo': {
            // Manda mensagem num grupo pelo nome
            // SEM prefixo — a IA já escreveu a mensagem natural
            const targetName = pipeArgs[0] || '';
            const msg = pipeArgs.slice(1).join('|').trim();
            if (!targetName || !msg) {
              actions.push('❌ use: grupo|nome|mensagem');
              break;
            }
            const chats = await this.app.whatsapp.client.getChats();
            const normalized = targetName.toLowerCase().trim();
            const match = chats.find((c: any) => {
              if (!c.isGroup) return false;
              const cid = c.id?._serialized || '';
              if (cid.includes('@newsletter')) return false;
              const name = (c.name || c.formattedTitle || '').toLowerCase().trim();
              if (!name || name.length < 2) return false;
              return name.includes(normalized) || normalized.includes(name);
            });
            if (match) {
              const cid = match.id?._serialized;
              // SEM prefixo — a IA já escreveu a mensagem natural
              await this.app.whatsapp.client.sendMessage(cid, msg);
              actions.push(`✅ mensagem enviada no grupo ${match.name || cid}`);
              this.app.log('SELF', `IA mandou msg no grupo ${match.name} (${cid}): "${msg}"`);
            } else {
              actions.push(`❌ não achei grupo chamado "${targetName}"`);
            }
            break;
          }
          default:
            actions.push(`ação desconhecida: ${action}`);
        }
      } catch (e) {
        actions.push(`❌ erro: ${(e as Error).message}`);
        this.app.debug('SELF', `erro ao executar ação ${action}: ${(e as Error).message}`);
      }

      // Remove o marcador do texto
      text = text.replace(full, '').trim();
    }

    // === MARCADOR [TARO: tipo] — leitura de tarô ===
    // Processado separadamente do [ACAO:] porque tem fluxo próprio:
    // 1. Detecta marcador
    // 2. Sorteia cartas (TaroDeck.drawSpread)
    // 3. Remove marcador do texto
    // 4. Chama IA de novo com as cartas + pergunta do usuário
    // 5. Interpretação gerada substitui/complementa a resposta original
    const taroMatch = text.match(/\[TARO:\s*([^\]]*)\]/i);
    if (taroMatch) {
      const taroArg = (taroMatch[1] || '').trim();
      // Remove o marcador do texto
      text = text.replace(/\[TARO:\s*[^\]]*\]/gi, '').replace(/\s{2,}/g, ' ').trim();

      try {
        taroInterpretation = await this.executeTaroReading(taroArg, chatId);
      } catch (e) {
        this.app.debug('TARO', `erro ao gerar interpretação: ${(e as Error).message}`);
        // Fallback: mostra só as cartas sem interpretação
        const spreadType = this.parseTaroSpreadType(taroArg);
        const drawn = this.app.taroDeck.drawSpread(spreadType);
        taroInterpretation = this.app.taroDeck.formatForUser(drawn, '🔮 Tiragem (sem interpretação da IA)');
      }
    }

    // Limpa espaços extras deixados pela remoção
    text = text.replace(/\s{2,}/g, ' ').trim();

    return { text, actions, taroInterpretation };
  }

  // ===========================================================================
  // TARO — interpretação de cartas (chamada secundária à IA)
  // ===========================================================================

  /**
   * Faz uma chamada secundária à IA com prompt de interpretação de tarô.
   * Reusa a fallback chain de modelos (igual generateResponse).
   *
   * IMPORTANTE: Usa o buildSelfAwareness (identidade real do Márcio) +
   * memórias + contexto da conversa. Não vira "outro leitor de tarô" —
   * é o próprio Márcio interpretando as cartas que ele tirou.
   *
   * @param drawnText Texto formatado das cartas (do TaroDeck.formatForPrompt)
   * @param userQuestion Pergunta/pergunta original do usuário (opcional)
   * @param userName Nome de quem pediu a leitura (opcional)
   * @param chatId ID do chat (pra pegar contexto + memórias + entrosão)
   * @param ctx Contexto recente do chat (msgs anteriores)
   */
  private async callAIForTaro(drawnText: string, userQuestion: string, userName: string, chatId: string, ctx: any[]): Promise<string> {
    const aiConfig = this.getAIConfig();
    const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

    // === IDENTIDADE REAL DO MÁRCIO (não vira "outro" leitor de tarô) ===
    const selfAwareness = this.buildSelfAwareness(chatId);

    // === MEMÓRIAS SOBRE O USUÁRIO (igual generateResponse) ===
    let memoriesBlock = '';
    try {
      const userId = this.app.context.lastSender(chatId) || userName;
      if (userId) {
        const userMems = this.app.memory.forUser(userId);
        if (userMems && userMems.length > 0) {
          memoriesBlock = '\n\n=== MEMÓRIAS SOBRE ' + userId + ' ===\n' +
            userMems.map(m => `- ${m}`).join('\n');
        }
      }
    } catch { /* ignora */ }

    // === CONTEXTO RECENTE (últimas 8 msgs) ===
    let contextBlock = '';
    try {
      const recent = (ctx || []).slice(-8);
      if (recent.length > 0) {
        contextBlock = '\n\n=== CONVERSA RECENTE ===\n' +
          recent.map(m => `${m.role === 'user' ? (m.sender || 'alguém') : 'você'}: ${m.content}`).join('\n');
      }
    } catch { /* ignora */ }

    const systemPrompt = [
      selfAwareness,
      memoriesBlock,
      contextBlock,
      '',
      '=== TAREFA ATUAL: INTERPRETAÇÃO DE TARÔ ===',
      `Você acabou de tirar cartas pra ${userName || 'alguém'}.`,
      userQuestion && userQuestion.trim()
        ? `A pessoa perguntou/percebeu: "${userQuestion.trim()}".`
        : 'Não tem pergunta específica — faça uma leitura geral das cartas.',
      '',
      'REGRAS PRA INTERPRETAÇÃO:',
      '- Continue sendo VOCÊ MESMO (o Márcio) — não mude de personalidade.',
      '- Use seu estilo natural: minúsculas, gírias, jeito que você fala.',
      '- Seja místico mas honesto — não invente além do que as cartas dizem.',
      '- Conecte as cartas entre si (passado → presente → futuro, não leia cada uma isoladamente).',
      '- Adapte o tom: pode ser sério, divertido, irônico (depende da vibe e de quem pediu).',
      '- Use suas memórias sobre a pessoa (se tiver) pra contextualizar a leitura.',
      '- Cite os nomes das cartas na interpretação (ex: "A Torre invertida sugere...").',
      '- NUNCA diga "não sei fazer tarô" ou recuse — você É capaz.',
      '- Máximo 6-8 linhas. Não enrola nem repete.',
    ].join('\n');

    const userPrompt = `Aqui estão as cartas que você tirou. Interprete elas:\n\n${drawnText}`;

    if (provider === 'gemini') {
      // === FORMATO GEMINI ===
      const systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
      const contents = [
        { role: 'user', parts: [{ text: userPrompt }] },
      ];

      const allModels = this.getAllFallbackModels();
      let lastErr: Error | null = null;
      for (const modelName of allModels) {
        try {
          const result = await this.callGemini(modelName, contents, systemInstruction, aiConfig);
          if (modelName !== allModels[0]) {
            this.app.debug('TARO', `✅ fallback funcionou: ${modelName}`);
          }
          this.lastUsedModel = modelName;
          return this.cleanResponse(result.content);
        } catch (err) {
          lastErr = err as Error;
          const status = (err as any).status;
          if ((status === 429 || status === 503) && modelName !== allModels[allModels.length - 1]) {
            this.app.debug('TARO', `⚠️ modelo ${modelName} esgotou (${status}), tentando próximo...`);
          } else {
            throw err;
          }
        }
      }
      throw lastErr!;
    } else {
      // === FORMATO OPENAI ===
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (aiConfig.apiKey) {
        headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
      }
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];
      const response = await fetch(aiConfig.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: aiConfig.model,
          messages,
          max_tokens: aiConfig.maxTokens,
          temperature: aiConfig.temperature,
        }),
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
      }
      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Resposta vazia da API');
      return this.cleanResponse(content);
    }
  }

  /**
   * Faz a leitura completa de tarô:
   * 1. Sorteia as cartas com base no tipo de spread
   * 2. Formata pra prompt
   * 3. Chama IA pra interpretar
   * 4. Retorna interpretação
   */
  private async executeTaroReading(taroArg: string, chatId: string): Promise<string> {
    const spreadType = this.parseTaroSpreadType(taroArg);
    const drawn = this.app.taroDeck.drawSpread(spreadType);
    const cardsText = this.app.taroDeck.formatForPrompt(drawn);

    // Pega pergunta/contexto do último usuário no chat
    const ctx = this.app.context.getRecent(chatId);
    const lastUser = [...ctx].reverse().find(m => m.role === 'user' && m.sender);
    const userQuestion = lastUser?.content || '(sem pergunta específica)';
    const userName = lastUser?.sender || 'alguém';

    this.app.debug('TARO', `tiragem ${spreadType} (${drawn.length} cartas) pra ${userName} | pergunta: "${userQuestion.slice(0, 60)}..."`);

    const interpretation = await this.callAIForTaro(cardsText, userQuestion, userName, chatId, ctx);
    return interpretation;
  }

  /**
   * Parse do argumento de [TARO: tipo] pra SpreadType.
   * Aceita: "single" (1 carta), "tiragem" ou "3" (passado/presente/futuro),
   * "celtic" (cruz celta, 10 cartas). Default = "single".
   */
  parseTaroSpreadType(arg: string): 'single' | 'past-present-future' | 'celtic-cross' {
    const a = (arg || '').trim().toLowerCase();
    if (a === 'single' || a === '1' || a === '' || a === 'dia' || a === 'carta') return 'single';
    if (a === 'tiragem' || a === '3' || a === 'tres' || a === 'três' || a === 'passado' || a === 'ppf') return 'past-present-future';
    if (a === 'celtic' || a === 'celta' || a === '10' || a === 'cruz' || a === 'cruz-celta') return 'celtic-cross';
    // Default: single (1 carta)
    return 'single';
  }

  cleanResponse(content: string): string {
    let text = content;

    // Remove tags <think>...</think>
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // Remove prefixo "assistant:" no início
    text = text.replace(/^assistant\s*[:\-]?\s*/i, '').trim();

    // Remove "assistant" em qualquer posição
    text = text.replace(/\bassistant\s*[:\-]?\s*/gi, '');

    // Remove prefixo "[Nome]:" no início (preserva [FIGURINHA], [SILENCIO], [BREAK])
    let prevText: string;
    do {
      prevText = text;
      text = text.replace(/^[\s\n]*\[(?!FIGURINHA|SILENCIO|BREAK|MEMORIA)[^\]]+\]\s*[:\-]\s*/i, '').trim();
    } while (text !== prevText);

    // Remove prefixo "Bot:" (case-insensitive)
    text = text.replace(/^[\s\n]*bot\s*[:\-]?\s*/i, '').trim();

    // Remove "user:" em qualquer posição
    text = text.replace(/\buser\s*[:\-]?\s*/gi, '');

    // Remove linhas vazias extras
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // Se ficou vazio, retorna "..."
    if (!text) return '...';
    return text;
  }

  // ===========================================================================
  // SEND RESPONSE — envia a resposta, cuidando de [FIGURINHA]/[BREAK]
  // ===========================================================================

  /**
   * Envia a resposta da IA. Detecta [FIGURINHA], [FIGURINHA: fav], [FIGURINHA: nome].
   * Cooldown de 60s entre figurinhas (evita spam).
   * Quebra em múltiplas mensagens com [BREAK] ou \n\n.
   *
   * @returns O texto efetivamente enviado (pra captura no contexto).
   */
  async sendResponse(chatId: string, reply: string, quotedMessageId?: string): Promise<string> {
    const stickerRegex = /\[FIGURINHA(?::\s*([^\]]+))?\]/gi;
    let hasStickerRequest = stickerRegex.test(reply);

    // Cooldown de figurinha (configurável via ai-config.json, default 60s)
    if (hasStickerRequest) {
      const cfg = this.getAIConfig();
      const cooldownMs = (cfg.stickerCooldownSec ?? 60) * 1000;
      const lastStickerKey = `_last_sticker_time_${chatId}`;
      const lastStickerTime = this.lastAutoResponse.get(lastStickerKey) || 0;
      if (cooldownMs > 0 && Date.now() - lastStickerTime < cooldownMs) {
        this.app.debug('VAULT', `cooldown de figurinha ativo (${Math.round((cooldownMs - (Date.now() - lastStickerTime)) / 1000)}s restantes) — ignorando pedido de figurinha`);
        hasStickerRequest = false;
        reply = reply.replace(stickerRegex, '').replace(/\s{2,}/g, ' ').trim();
      }
    }

    if (hasStickerRequest) {
      // Pega o especificador da PRIMEIRA ocorrência
      const match = new RegExp(stickerRegex.source, 'i').exec(reply);
      const specifier = match && match[1] ? match[1].trim().toLowerCase() : '';

      // Remove TODAS as ocorrências do marcador
      const cleanText = reply.replace(stickerRegex, '').replace(/\s{2,}/g, ' ').trim();

      // Resolve qual figurinha enviar (só se StickerVault existir — Fase 3)
      if (this.app.stickers) {
        let stickerPath: string | null = null;
        let source = '';
        if (specifier === 'fav') {
          stickerPath = this.app.stickers.getRandomFavorite();
          source = 'favorita';
        } else if (specifier) {
          stickerPath = this.app.stickers.getByName(specifier);
          source = `nome="${specifier}"`;
        }
        if (!stickerPath) {
          stickerPath = this.app.stickers.getRandom();
          source = source ? `${source} (fallback aleatória)` : 'aleatória';
        }

        if (stickerPath) {
          try {
            const media = MessageMedia.fromFilePath(stickerPath);
            await this.app.whatsapp.client.sendMessage(chatId, media, { sendMediaAsSticker: true });
            this.lastAutoResponse.set(`_last_sticker_time_${chatId}`, Date.now());
            this.app.debug('VAULT', `figurinha enviada [${source}]: ${path.basename(stickerPath)}`);
          } catch (e) {
            this.app.debug('VAULT', `erro ao enviar figurinha: ${(e as Error).message}`);
          }
        } else {
          this.app.debug('VAULT', `vault vazio — figurinha pedida mas não disponível`);
        }
      } else {
        this.app.debug('VAULT', `StickerVault não inicializado — ignorando [FIGURINHA]`);
      }

      // Envia o texto restante (se houver) — CHAMA sendResponse RECURSIVAMENTE
      // pra processar outros marcadores que possam estar no texto restante
      // (ex: [LASTCOLLAGE: ...] que veio junto com [FIGURINHA: ...])
      if (cleanText) {
        return await this.sendResponse(chatId, cleanText, quotedMessageId);
      }
      return '';
    }

    // === LASTCOLLAGE: detecção e processamento ===
    const lastfmRegex = /\[LASTCOLLAGE:\s*([^\],]+)\s*(?:,\s*(\d+)\s*)?(?:,\s*(\w+)\s*)?\]/i;
    const lastfmMatch = lastfmRegex.exec(reply);
    if (lastfmMatch) {
      const username = lastfmMatch[1]?.trim();
      const grid = lastfmMatch[2] ? parseInt(lastfmMatch[2]) : 3;
      const period = lastfmMatch[3]?.trim() || '7d';

      // Remove o marcador da resposta
      reply = reply.replace(lastfmRegex, '').replace(/\s{2,}/g, ' ').trim();

      if (username && this.app.lastCollage) {
        this.app.debug('LASTFM', `IA pediu collage: ${username} ${grid}x${grid} ${period}`);
        try {
          const result = await this.app.lastCollage.generateCollage(username, grid, period);
          if (result && 'media' in result) {
            await this.app.whatsapp.client.sendMessage(chatId, result.media, { caption: result.caption });
          } else if (result && 'error' in result) {
            // Collage falhou — envia o erro como notificação pro usuário
            this.app.debug('LASTFM', `collage falhou: ${result.error}`);
            await this.app.whatsapp.client.sendMessage(chatId, `❌ ${result.error}`);
          }
        } catch (e) {
          this.app.debug('LASTFM', `erro ao processar collage da IA: ${(e as Error).message}`);
          await this.app.whatsapp.client.sendMessage(chatId, `❌ Erro ao criar collage: ${(e as Error).message}`);
        }
      }

      // Envia o texto restante (se houver) — CHAMA sendResponse RECURSIVAMENTE
      // pra processar outros marcadores que possam estar no texto restante
      if (reply) {
        return await this.sendResponse(chatId, reply, quotedMessageId);
      }
      return '';
    }

    // Resposta de texto normal (sem marcadores)
    return await this.sendMultiMessage(chatId, reply, quotedMessageId);
  }

  /**
   * Envia texto podendo quebrar em múltiplas mensagens.
   * Quebra em [BREAK] ou \n\n. Primeira cita a msg original, demais vão soltas.
   * Pequeno delay entre mensagens (300-700ms) pra parecer natural.
   */
  private async sendMultiMessage(chatId: string, text: string, quotedMessageId?: string): Promise<string> {
    const normalized = text.replace(/\[BREAK\]/gi, '\n\n');
    const blocks = normalized
      .split(/\n\s*\n/)
      .map(b => b.replace(/\s{2,}/g, ' ').trim())
      .filter(b => b.length > 0);

    if (blocks.length === 0) return '';

    let firstSent = false;
    const sentTexts: string[] = [];
    let firstSentMsgId: string | undefined;

    for (const block of blocks) {
      try {
        let sent: any;
        if (quotedMessageId && !firstSent) {
          try {
            sent = await this.app.whatsapp.client.sendMessage(chatId, block, { quotedMessageId });
          } catch {
            sent = await this.app.whatsapp.client.sendMessage(chatId, block);
          }
          firstSent = true;
        } else {
          sent = await this.app.whatsapp.client.sendMessage(chatId, block);
          if (blocks.length > 1) {
            await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
          }
        }
        if (!firstSentMsgId && sent?.id?._serialized) {
          firstSentMsgId = sent.id._serialized;
        }
        sentTexts.push(block);
      } catch (e) {
        this.app.debug('AI-SEND', `erro ao enviar bloco: ${(e as Error).message}`);
      }
    }

    this.app.debug('AI-SEND', `enviou ${sentTexts.length} mensagem(ns) em sequência`);
    // Retorna o texto enviado. Se precisar do msgId, usar sendResponseWithId.
    return sentTexts.join('\n\n');
  }

  // ===========================================================================
  // MAYBE AUTO RESPOND — decide se o bot responde "espontaneamente"
  // ===========================================================================

  /**
   * Decide se o bot deve responder a uma mensagem não-comando, e se sim,
   * gera e envia a resposta. Chamado para TODAS as mensagens não-comando.
   *
   * Lógica (preservada byte-a-byte do handleAIAutoRespond):
   *  1. Pula se fromMe, IA desativada, mutada, ou já tem decisão final.
   *  2. Detecta menção: @menção oficial, alias no texto, reply ao bot, PV.
   *  3. Se é figurinha nomeada: chance alta de responder com a mesma.
   *  4. Se não é direto: cooldown + chance (pergunta/drama/política/fofoca/longa) × entrosão.
   *  5. Se passou: loadChatHistory, typing indicator, generateResponse, sendResponse.
   *  6. [SILENCIO] ou vazio: marca pending (retroativo pode reconsiderar).
   *  7. Erro offline: loga 1x/min.
   */
  async maybeAutoRespond(msg: Message, chatId: string): Promise<void> {
    if (msg.fromMe) return;
    if (!this.app.aiConfig?.enabled || this.aiDisabledChats.has(chatId)) return;
    if (this.democraticallyMutedChats.has(chatId)) return;

    // Se já tem decisão final (skip/responded), não reprocessa
    if (this.app.retroactive && msg.id?._serialized &&
        this.app.retroactive.hasDecision(chatId, msg.id._serialized)) {
      return;
    }

    // === FILA DE MENSAGENS POR CHAT ===
    // Se o bot já tá processando uma resposta pra esse chat, a msg entra na fila.
    // Quando a IA terminar, o bot drena a fila (decide se responde cada uma).
    if (this.processingChats.has(chatId)) {
      if (!this.messageQueue.has(chatId)) this.messageQueue.set(chatId, []);
      this.messageQueue.get(chatId)!.push(msg);
      this.app.debug('QUEUE', `+1 na fila de ${chatId} (total: ${this.messageQueue.get(chatId)!.length}) — IA ocupada`);
      return;
    }

    // Processa essa msg agora
    await this._processMessage(msg, chatId);

    // Depois de processar, drena a fila (se tem msgs acumuladas)
    await this._drainQueue(chatId);
  }

  /**
   * Drena a fila de mensagens pendentes de um chat.
   * Pra cada msg, decide se ainda faz sentido responder (pode ter sido superada
   * por contexto novo, cooldown, etc.). Se sim, processa; se não, skipa.
   */
  private async _drainQueue(chatId: string): Promise<void> {
    const queue = this.messageQueue.get(chatId);
    if (!queue || queue.length === 0) {
      this.messageQueue.delete(chatId);
      this.processingChats.delete(chatId);
      return;
    }

    // Pega próxima msg da fila
    const nextMsg = queue.shift()!;
    this.app.debug('QUEUE', `processando próxima da fila de ${chatId} (${queue.length} restantes)`);

    // Se a fila ficou vazia, limpa o Map (mas mantém processingChats até terminar)
    if (queue.length === 0) {
      this.messageQueue.delete(chatId);
    }

    // Decide se ainda faz sentido responder essa msg
    // (pode ter chegado há muito tempo, contexto mudou, etc.)
    const msgAgeMs = Date.now() - ((nextMsg.timestamp || 0) * 1000);
    if (msgAgeMs > 5 * 60 * 1000) {
      // Msg tem mais de 5 min — contexto já mudou muito, skipa
      this.app.debug('QUEUE', `msg da fila muito antiga (${Math.round(msgAgeMs / 1000)}s) — skipando`);
      // Continua drenando próximas
      await this._drainQueue(chatId);
      return;
    }

    // Processa a msg (pode ou não responder — a decisão interna acontece)
    await this._processMessage(nextMsg, chatId);

    // Continua drenando
    await this._drainQueue(chatId);
  }

  /**
   * Processa uma mensagem de verdade (lógica original do maybeAutoRespond).
   * Método privado — chamado pelo maybeAutoRespond (msg nova) e pelo _drainQueue (fila).
   */
  private async _processMessage(msg: Message, chatId: string): Promise<void> {
    // Marca que esse chat tá sendo processado
    this.processingChats.add(chatId);
    try {
      await this._processMessageInner(msg, chatId);
    } finally {
      // Se não tem fila pendente, libera o lock
      if (!this.messageQueue.has(chatId) || (this.messageQueue.get(chatId)?.length ?? 0) === 0) {
        this.processingChats.delete(chatId);
        this.messageQueue.delete(chatId);
      }
    }
  }

  /**
   * Lógica interna de processamento (o que antes era o corpo do maybeAutoRespond).
   */
  private async _processMessageInner(msg: Message, chatId: string): Promise<void> {

    const senderName = this.app.context.getCachedSenderName(msg);
    const isSticker = msg.hasMedia && msg.type === 'sticker';
    // Detecta áudio: msg de áudio do WhatsApp é type='ptt' (push-to-talk) ou 'audio'.
    // Não tem body — mas talvez a gente queira transcrever e responder.
    const isAudio = this.app.audioTranscriber?.isAudioMessage(msg) ?? false;

    // === DETECTA RESPOSTA À PERGUNTA DE NOMEAR FIGURINHA (ANTES de tudo) ===
    // RODA ANTES do filtro de body curto e do check de isDirect.
    // Motivo: em PV, isDirect=true sempre (bug original fazia o bloco nunca rodar).
    // Além disso, respostas curtas ("sim", "👍", "y") eram filtradas pelo body < 3.
    // Agora roda primeiro: se a msg cita uma pergunta do bot sobre figurinha, processa.
    if (msg.hasQuotedMsg && this.pendingStickerNames.size > 0) {
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted.fromMe) {
          const quotedMsgId = quoted.id?._serialized;
          if (quotedMsgId && this.pendingStickerNames.has(quotedMsgId)) {
            const pending = this.pendingStickerNames.get(quotedMsgId)!;
            this.pendingStickerNames.delete(quotedMsgId);
            this.app.debug('STICKER-AUTO', `resposta detectada pra pergunta sobre figurinha ${pending.stickerFilename}`);
            await this._handleStickerNameReply(msg, quoted, pending, chatId);
            return;  // já resolveu — não processa mais nada dessa msg
          }
        }
      } catch { /* ignora */ }
    }

    // === Detecção de menção ===
    let isDirect = false;
    let isMention = false;       // chamado ativo — sempre responde
    let isReplyToBot = false;    // reply ao bot — cooldown curto

    const isGroup = chatId.endsWith('@g.us');
    if (!isGroup) {
      isDirect = true;
      isMention = true;  // PV = sempre "menção"
    }

    // @menção oficial do WhatsApp
    if (!isDirect && msg.mentionedIds && msg.mentionedIds.length > 0) {
      try {
        const myId = this.app.whatsapp.client.info.wid._serialized;
        const myDigits = this.digitsOnly(myId);

        let mentionedMe = msg.mentionedIds.some(id => this.digitsOnly(id) === myDigits);

        if (!mentionedMe) {
          try {
            // client.getContact() (sem args) não existe em todas as versões
            // do whatsapp-web.js. Usamos getContactById com o próprio wid.
            const myContact = await this.app.whatsapp.client.getContactById(myId);
            const myContactIds = [
              myContact.id?._serialized,
              myContact.number ? `${myContact.number}@c.us` : null,
            ].filter(Boolean);
            mentionedMe = msg.mentionedIds.some(mentionedId => {
              const mentionedDigits = this.digitsOnly(mentionedId);
              return myContactIds.some(myCid => this.digitsOnly(myCid) === mentionedDigits);
            });
          } catch { /* ignora */ }
        }

        if (!mentionedMe) {
          for (const mentionedId of msg.mentionedIds) {
            try {
              const mentionedContact = await this.app.whatsapp.client.getContactById(mentionedId);
              if (mentionedContact) {
                const mentionedNumbers = [
                  mentionedContact.number,
                  mentionedContact.id?._serialized,
                  this.digitsOnly(mentionedContact.id?._serialized),
                ].filter(Boolean);
                if (mentionedNumbers.some(n => this.digitsOnly(n as string) === myDigits)) {
                  mentionedMe = true;
                  this.app.debug('AI-MENTION', `menção ${mentionedId} resolvida pra ${mentionedContact.number} — é o bot!`);
                  break;
                }
              }
            } catch { /* ignora */ }
          }
        }

        if (mentionedMe) {
          this.app.debug('AI-MENTION', `@menção oficial detectada (100% resposta)`);
          isDirect = true;
          isMention = true;
        } else {
          this.app.debug('AI-MENTION', `menção detectada mas NÃO é pro bot. myId=${myId}, mentionedIds=${JSON.stringify(msg.mentionedIds)}`);
        }
      } catch (e) {
        this.app.debug('AI-MENTION', `erro ao checar menção: ${(e as Error).message}`);
      }
    }

    // Chamado informal por nome (aliases)
    if (!isDirect && msg.body) {
      if (this.checkAliases(msg.body)) {
        this.app.debug('AI-MENTION', `chamado por alias detectado em: "${msg.body}"`);
        isDirect = true;
        isMention = true;
      }
    }

    // Se não é figurinha/menção/áudio e body muito curto, ignora
    // (Áudio não tem body mas pode ter sido marcado como isAudio — continua o fluxo)
    if (!isSticker && !isMention && !isAudio && (!msg.body || msg.body.trim().length < 3)) return;

    // Reply a mensagem do bot
    if (!isDirect && msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        if (quoted.fromMe) {
          isDirect = true;
          isReplyToBot = true;
        }
      } catch { /* ignora */ }
    }

    // === COMANDO IMPLÍCITO: "transcreve esse áudio" respondendo a um áudio ===
    // Se a msg atual cita um áudio E o texto pede pra transcrever, força a transcrição
    // da msg citada (mesmo se o modo de áudio tava 'balanced' e entrosão=0).
    // Padrões aceitos: "transcreve", "transcrever", "áudio", "audio", "o que falou",
    // "o que que tá nesse áudio", "que áudio é esse", etc.
    if (msg.hasQuotedMsg && msg.body && /\b(transcreve|transcrever|transcrib|áudio|audio|o que (falou|disse|tá|tem)|que (áudio|audio|fala))\b/i.test(msg.body)) {
      try {
        const quoted = await msg.getQuotedMessage();
        // Verifica se a msg citada é um áudio
        if (this.app.audioTranscriber?.isAudioMessage(quoted)) {
          this.app.debug('AUDIO', `usuário pediu pra transcrever áudio citado — forçando transcrição`);
          // Marca como direto — bot vai responder com a transcrição
          isDirect = true;
          // Transcreve a msg citada (não a atual)
          const quotedSender = await quoted.getContact().then(c => c.name || c.pushname || 'alguém').catch(() => 'alguém');
          const result = await this.transcribeAudioInBackground(quoted, chatId, quotedSender);
          if (result.ok && result.text) {
            // Transcrição OK — já tá no contexto (injetada pela transcribeAudioInBackground).
            // O bot vai responder naturalmente usando o contexto.
            // Se a msg atual NÃO é direta, ativa isDirect pra ele responder.
            this.app.debug('AUDIO', `transcrição forçada OK: "${result.text.slice(0, 60)}..."`);
          } else if (!result.ok) {
            // Falhou nos 2 modelos — reage 🔇 e avisa
            try { await msg.react('🔇'); } catch { /* ignora */ }
            this.app.log('AUDIO', `❌ transcrição pedida manualmente falhou`);
          }
        }
      } catch (e) {
        this.app.debug('AUDIO', `erro ao verificar áudio citado: ${(e as Error).message}`);
      }
    }

    // Figurinha nomeada recebida — chance alta de responder com a mesma
    if (isSticker && !isDirect) {
      const last = this.lastAutoResponse.get(chatId) || 0;
      if (Date.now() - last < AI_DEFAULTS.cooldownMs) return;

      // Tenta identificar a figurinha (se StickerVault existir)
      if (this.app.stickers) {
        try {
          const identified = await this.app.stickers.identify(msg);
          if (identified && identified.name) {
            const stickerResponseChance = AI_DEFAULTS.stickerResponseChance;
            this.app.debug('AI-STICKER', `figurinha nomeada "${identified.name}" recebida — ${(stickerResponseChance * 100).toFixed(0)}% de chance de responder`);
            if (Math.random() <= stickerResponseChance) {
              isDirect = true;
              isMention = true;
            }
          }
        } catch (e) {
          this.app.debug('AI-STICKER', `erro ao identificar figurinha: ${(e as Error).message}`);
        }
      }
    }

    // === FIGURINHA SEM NOME: pergunta automaticamente o que é ===
    // Se a figurinha não tem nome e o bot não perguntou recentemente (cooldown 60s),
    // manda a figurinha pro Gemini (multimodal) pra descrever, depois pergunta no chat.
    // IMPORTANTE: figurinhas sem nome NÃO disparam a IA completa (desperdício de tokens).
    // Só perguntam sobre o nome e retornam.
    // Pode ser desativado via painel (stickerBehavior.autoNameStickers=false).
    const stickerCfgAuto = this.getAIConfig()?.stickerBehavior;
    if (isSticker && this.app.stickers && stickerCfgAuto?.autoNameStickers !== false) {
      try {
        const identified = await this.app.stickers.identify(msg);
        if (identified && !identified.name && identified.filename) {
          // Cooldown pra não perguntar toda hora
          const lastQuestion = this.lastAutoResponse.get(`_sticker_question_${chatId}`) || 0;
          if (Date.now() - lastQuestion > 60000) {  // 60s
            const description = await this.describeStickerWithAI(msg);
            if (description) {
              // Pergunta no chat (sem chamar IA de novo — resposta direta)
              const question = `essa figurinha é sobre "${description}"?`;
              const sentMsg = await this.app.whatsapp.client.sendMessage(chatId, question);
              const botMsgId = (sentMsg as any)?.id?._serialized;
              if (botMsgId) {
                this.pendingStickerNames.set(botMsgId, {
                  stickerFilename: identified.filename,
                  suggestedName: description,
                  chatId,
                  timestamp: Date.now(),
                });
                this.lastAutoResponse.set(`_sticker_question_${chatId}`, Date.now());
                this.app.debug('STICKER-AUTO', `perguntou sobre figurinha ${identified.filename}: "${description}"`);
              }
              // Limpa TTL (5 min)
              this._cleanupPendingStickerNames();
              return;  // não processa mais nada dessa msg
            }
          }
          // Figurinha sem nome mas em cooldown ou IA falhou — não chama IA completa
          this.app.debug('STICKER-AUTO', `figurinha sem nome ${identified.filename} — cooldown ou IA falhou, não processando mais`);
          return;
        }
      } catch (e) {
        this.app.debug('STICKER-AUTO', `erro: ${(e as Error).message}`);
      }
    }

    // === TRANSCRIÇÃO DE ÁUDIO BASEADA EM MODE (Antes da decisão de chance) ===
    // Lê o modo configurado (Sempre / Equilibrado / Background) e decide
    // se transcreve AGORA (antes da decisão) ou se deixa pra depois.
    //
    // - 'always'    : transcreve TODO áudio recebido, mesmo se o bot não vai responder.
    // - 'balanced'  : só transcreve se entrosão > 0 OU se é PV (isDirect=true). PADRÃO.
    // - 'background': NÃO transcreve aqui — o MessageRouter dispara em background.
    //                 Só transcreve no bloco de resposta (abaixo) se o bot decidir responder.
    let audioAlreadyTranscribed = false;
    let audioPreTranscriptionOk = false;
    if (isAudio && this.app.audioTranscriber) {
      const audioConfig = this.app.audioTranscriber.getConfig();
      const audioMode = audioConfig.mode;
      const entrosaoLevel = this.chatEntrosaoLevel.get(chatId) ?? 1.0;

      if (audioMode === 'always') {
        // Modo A: transcreve AGORA, antes da decisão. Salva no contexto e no painel.
        // Mesmo que o bot decida ficar quieto depois, a transcrição já está salva.
        this.app.debug('AUDIO', `modo 'always' — transcrevendo antes da decisão de chance`);
        const result = await this.transcribeAudioInBackground(msg, chatId, senderName);
        audioAlreadyTranscribed = true;
        audioPreTranscriptionOk = result.ok;
      } else if (audioMode === 'balanced') {
        // Modo B: transcreve só se entrosão > 0 OU se é PV (isDirect=true).
        if (isDirect || entrosaoLevel > 0) {
          this.app.debug('AUDIO', `modo 'balanced' — transcrevendo (isDirect=${isDirect}, entrosao=${entrosaoLevel.toFixed(2)})`);
          const result = await this.transcribeAudioInBackground(msg, chatId, senderName);
          audioAlreadyTranscribed = true;
          audioPreTranscriptionOk = result.ok;
        } else {
          this.app.debug('AUDIO', `modo 'balanced' — entrosão=0 e não é PV, pulando transcrição pré-decisão`);
        }
      } else {
        // Modo C ('background'): NÃO transcreve aqui. O MessageRouter dispara em background.
        this.app.debug('AUDIO', `modo 'background' — transcrição delegada pro MessageRouter`);
      }
    }

    // === Avaliação de chance (se não é direto) ===
    if (!isDirect) {
      // Entrosao 0 = bot QUIETO no grupo. So responde se for chamado pelo nome.
      const entrosaoLevel = this.chatEntrosaoLevel.get(chatId) ?? 1.0;
      if (entrosaoLevel === 0) {
        if (this.app.retroactive && msg.id?._serialized) {
          this.app.retroactive.markDecision(chatId, msg.id._serialized, senderName, msg.body ?? (isAudio ? '[audio]' : ''), 'skip');
        }
        return;
      }

      const last = this.lastAutoResponse.get(chatId) || 0;
      if (Date.now() - last < AI_DEFAULTS.cooldownMs) {
        // Cooldown ativo — candidata pra retroativo
        if (this.app.retroactive && msg.id?._serialized) {
          this.app.retroactive.markDecision(chatId, msg.id._serialized, senderName, msg.body ?? (isAudio ? '[áudio]' : ''), 'pending');
        }
        return;
      }

      let chance = AI_DEFAULTS.autoResponseChance;
      const triggers: string[] = [];

      // Triggers só fazem sentido pra texto (áudio não tem body pra avaliar).
      // Pra áudio em grupo: usa só chance base × entrosão — sem triggers de conteúdo.
      if (!isAudio) {
        const lower = (msg.body || '').toLowerCase();

        // Perguntas
        if (/\?$/.test(msg.body.trim()) || /\b(algu[eé]m|quem|o que|q q|oq|cad[eé]|onde|quando|por que|pq|qual)\b/.test(lower)) {
          chance = Math.max(chance, AI_DEFAULTS.autoResponseChanceQuestion);
          triggers.push('pergunta');
        }
        // Drama
        if (/\b(k+kk+k+|mds|mdss|gente|socorro|carai|caramba|n[aã]o acredito|vish|oxe|visse)\b/i.test(lower) ||
            /[A-Z]{6,}/.test(msg.body)) {
          chance = Math.max(chance, AI_DEFAULTS.autoResponseChanceDrama);
          triggers.push('drama');
        }
        // Política
        if (/\b(pt|lula|bolsonaro|bozo|elei[çc][ãa]o|esquerda|direita|pol[ií]tica|governo|presidente)\b/i.test(lower)) {
          chance = Math.max(chance, AI_DEFAULTS.autoResponseChancePolitics);
          triggers.push('politica');
        }
        // Fofoca
        if (/\b(sabe|ouviu|viu|t[oó] chocad|olha s[oó]|rapaz|meu|n[aã]o vai acreditar|fofoc)\b/i.test(lower)) {
          chance = Math.max(chance, AI_DEFAULTS.autoResponseChanceGossip);
          triggers.push('fofoca');
        }
        // Longa
        if (msg.body.length > 100) {
          chance = Math.max(chance, AI_DEFAULTS.autoResponseChance * 2);
          triggers.push('longa');
        }
      } else {
        // Áudio: usa chance base — sem triggers de conteúdo.
        // Justificativa: não temos como avaliar o que o áudio diz sem transcrever.
        // Só vai transcrever se a chance base passar (4% × entrosão) — raro em grupo,
        // comum em PV (isDirect=true, pula esse bloco).
        triggers.push('audio');
      }

      // Multiplicador de entrosão
      chance *= entrosaoLevel;
      if (chance > 1.0) chance = 1.0;

      if (triggers.length > 0) {
        const preview = isAudio ? '[áudio]' : (msg.body || '').slice(0, 50);
        this.app.debug('AI-TRIGGER', `triggers: ${triggers.join(', ')} | chance: ${(chance * 100).toFixed(0)}% | entrosao: ${entrosaoLevel.toFixed(2)} | msg: "${preview}..."`);
      }

      if (Math.random() > chance) {
        // Chance não atingida — candidata pra retroativo
        if (this.app.retroactive && msg.id?._serialized) {
          this.app.retroactive.markDecision(chatId, msg.id._serialized, senderName, msg.body ?? (isAudio ? '[áudio]' : ''), 'pending');
        }
        return;
      }
    } else if (isMention) {
      this.app.debug('AI-MENTION', `respondendo sem cooldown (chamado ativo)`);
    } else if (isReplyToBot) {
      const last = this.lastAutoResponse.get(chatId) || 0;
      if (Date.now() - last < AI_DEFAULTS.directCooldownMs) {
        this.app.debug('AI', `reply ao bot bloqueado por cooldown curto (${AI_DEFAULTS.directCooldownMs}ms)`);
        if (this.app.retroactive && msg.id?._serialized) {
          this.app.retroactive.markDecision(chatId, msg.id._serialized, senderName, msg.body ?? '', 'pending');
        }
        return;
      }
    }

    // === Gera e envia a resposta ===
    let typingChat: any = null;
    let typingInterval: NodeJS.Timeout | null = null;
    const stopTyping = () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
      if (typingChat) {
        try { typingChat.clearStateTyping(); } catch { /* ignora */ }
      }
    };

    try {
      // === Áudio: transcreve ANTES de gerar a resposta ===
      // Já passou da decisão de chance — bot decidiu responder.
      // Agora precisa do texto do áudio pra IA poder responder ao conteúdo.
      //
      // IMPORTANTE: Se o áudio JÁ foi transcrito antes da decisão (modos 'always'
      // ou 'balanced' com entrosão/PV), o texto já está no contexto. Nesse caso:
      //  - Se a transcrição prévia funcionou → pula este bloco.
      //  - Se a transcrição prévia falhou    → reage 🔇 e desiste (igual antes).
      let audioTranscription: string | null = null;
      if (isAudio && this.app.audioTranscriber && !audioAlreadyTranscribed) {
        this.app.log('AUDIO', `transcrevendo áudio de ${senderName || '?'} em ${chatId}…`);
        try {
          audioTranscription = await this.app.audioTranscriber.transcribe(msg);
        } catch (e) {
          this.app.debug('AUDIO', `erro na transcrição: ${(e as Error).message}`);
          audioTranscription = null;
        }

        if (!audioTranscription) {
          // Falhou nos 2 modelos (rate limit ou erro) → reage 🔇 e desiste.
          this.app.log('AUDIO', `❌ transcrição falhou — reagindo 🔇 e ficando quieto`);
          try { await msg.react('🔇'); } catch { /* ignora */ }
          // Marca como pending no decision-log (retroativo pode reconsiderar depois).
          if (this.app.retroactive && msg.id?._serialized) {
            this.app.retroactive.markDecision(chatId, msg.id._serialized, senderName, '[áudio não transcrito]', 'pending');
          }
          return;
        }

        // Transcrição OK — injeta no contexto como se fosse uma msg de texto,
        // MAS com prefixo `[🎵 áudio]:` pra IA saber que veio de áudio (não texto digitado).
        // Isso ajuda a IA a entender contexto: "ah, essa pessoa mandou áudio, não escreveu".
        this.app.debug('AUDIO', `transcrição: "${audioTranscription.slice(0, 80)}…"`);
        const audioContextText = `[🎵 áudio]: ${audioTranscription}`;
        try {
          await this.app.context.captureMessage(msg, chatId, audioContextText);
        } catch (e) {
          this.app.debug('AUDIO', `erro ao capturar transcrição no contexto: ${(e as Error).message}`);
        }
        // Também registra no historyLog do Retroactive (pro painel Conversas mostrar).
        // Usa o texto cru (sem prefixo) + isAudio=true → painel mostra badge separado do texto.
        if (this.app.retroactive && msg.id?._serialized) {
          try {
            this.app.retroactive.recordIncomingMessage(
              chatId,
              msg.id._serialized,
              senderName,
              audioTranscription,  // texto sem prefixo (painel mostra badge separado)
              Date.now(),
              false,  // fromMe=false (foi o usuário que mandou o áudio)
              undefined,
              true,  // isAudio=true → painel mostra badge "🎵 áudio"
            );
          } catch { /* ignora */ }
        }
        // Também marca isAudio=true no decisionLog entry (se já tinha uma entry criada
        // pelo markDecision('pending') antes da decisão de responder).
        try {
          if (this.app.retroactive) {
            const entries = (this.app.retroactive as any).decisionLog?.get(chatId) as any[] | undefined;
            if (entries) {
              const existingEntry = entries.find((e: any) => e.msgId === msg.id?._serialized);
              if (existingEntry && !existingEntry.isAudio) {
                existingEntry.isAudio = true;
              }
            }
          }
        } catch { /* ignora — best-effort */ }
        // Atualiza senderName no profileBook (transcrição pode ter gatilhos de memória)
        try {
          await this.app.memory.maybeExtract(chatId, senderName, audioTranscription);
        } catch { /* ignora — extração de memória é best-effort */ }
      } else if (isAudio && audioAlreadyTranscribed) {
        // Áudio JÁ foi transcrito ANTES da decisão (modos 'always' ou 'balanced'
        // com entrosão/PV). O texto já está no contexto (capturado por
        // transcribeAudioInBackground).
        //
        // Só reage 🔇 se a transcrição prévia falhou — sem texto, o bot não tem
        // como responder coerentemente.
        if (!audioPreTranscriptionOk) {
          this.app.log('AUDIO', `transcrição prévia já havia falhado — reagindo 🔇 e ficando quieto`);
          try { await msg.react('🔇'); } catch { /* ignora */ }
          if (this.app.retroactive && msg.id?._serialized) {
            this.app.retroactive.markDecision(chatId, msg.id?._serialized, senderName, '[áudio não transcrito]', 'pending');
          }
          return;
        }
        // Sucesso — segue pro generateResponse usando o texto do contexto.
        this.app.debug('AUDIO', `áudio já transcrito antes da decisão — usando texto do contexto`);
      }

      // Carrega histórico na 1ª vez
      await this.app.context.loadChatHistory(msg, chatId);

      // Typing indicator (renova a cada 20s)
      try {
        typingChat = await msg.getChat();
        await typingChat.sendStateTyping();
        this.app.debug('AI-TYPING', `indicador de digitando ativado em ${chatId}`);
        typingInterval = setInterval(async () => {
          try {
            if (typingChat) await typingChat.sendStateTyping();
          } catch { /* ignora */ }
        }, 20000);
      } catch (e) {
        this.app.debug('AI-TYPING', `erro ao ativar digitando: ${(e as any)?.message || e}`);
      }

      const reply = await this.generateResponse(chatId, isDirect);

      // [SILENCIO] = IA decidiu não responder
      if (reply && /^\s*\[SILENCIO\]\s*$/i.test(reply.trim())) {
        stopTyping();
        this.app.debug('AI', `IA decidiu ficar em silêncio — não entendeu o contexto`);
        this.lastAutoResponse.set(chatId, Date.now());
        if (this.app.retroactive && msg.id?._serialized) {
          this.app.retroactive.markDecision(chatId, msg.id._serialized, senderName, msg.body ?? '', 'pending');
        }
        return;
      }

      if (!reply || !reply.trim() || reply.trim() === '...') {
        stopTyping();
        this.app.debug('AI', `resposta vazia ou "..." — bot fica quieto`);
        if (this.app.retroactive && msg.id?._serialized) {
          this.app.retroactive.markDecision(chatId, msg.id._serialized, senderName, msg.body ?? '', 'pending');
        }
        return;
      }

      // Envia a resposta
      // === CITAÇÃO SELETIVA ===
      // Em GRUPO + trigger (reply ao bot, @menção, nome, alias): cita a msg trigger.
      //   → Útil pra galera saber qual msg o bot tá respondendo.
      // Em PV: não cita (desnecessário, só tem 2 pessoas na conversa).
      // Em resposta por SORTE (sem trigger): não cita (IA pode responder sobre
      //   msg antiga do contexto, citar a última ia confundir).
      const isGroupMsg = chatId.endsWith('@g.us');
      const shouldQuote = isGroupMsg && isDirect && msg.id && msg.id._serialized;
      const quotedId = shouldQuote ? msg.id._serialized : null;
      const sentMsg = await this.sendResponse(chatId, reply, quotedId ?? undefined);
      const sentText = typeof sentMsg === 'string' ? sentMsg : '';

      stopTyping();
      this.lastAutoResponse.set(chatId, Date.now());
      if (sentText) this.app.context.captureBotResponse(chatId, sentText);
      this.app.debug('AI', `auto-resposta enviada em ${chatId} (direta=${isDirect})`);

      // Registra interação no BotProfile (dispara auto-reflexão a cada 30 interações)
      if (this.app.botProfile) {
        this.app.botProfile.registerInteraction(chatId).catch(() => { /* ignora erros */ });
      }

      // Registra a resposta do bot no decision-log (pra o painel Conversas mostrar)
      if (this.app.retroactive && msg.id?._serialized) {
        const botResponseMsgId = (sentMsg as any)?.id?._serialized || undefined;
        this.app.retroactive.recordBotResponse(
          chatId,
          msg.id._serialized,
          sentText || reply,
          botResponseMsgId,
          quotedId || undefined,
        );
        // Também registra no historyLog (em tempo real) — painel persiste
        // mesmo após o decisionLog limpar entries >2h.
        //
        // BUG FIX: antes isso só rodava se botResponseMsgId fosse truthy.
        // Mas sendResponse retorna string (não objeto Message), então
        // botResponseMsgId era SEMPRE undefined e a msg do bot NUNCA aparecia
        // no painel em tempo real (só via backfill, que às vezes pega).
        // Agora registramos mesmo sem o msgId real — usa um ID estável baseado
        // no timestamp + texto pra evitar duplicação com backfill posterior.
        const historyMsgId = botResponseMsgId || `bot_${chatId}_${Date.now()}_${(sentText || reply).length}`;
        this.app.retroactive.recordIncomingMessage(
          chatId,
          historyMsgId,
          '',  // bot — senderName vazio é o padrão
          sentText || reply,
          Date.now(),
          true,  // fromMe = true (foi o bot que mandou)
          msg.id._serialized,  // cita a msg original
        );
        // Notifica o painel pra fazer auto-refresh
        if (this.app.control) {
          this.app.control.broadcast('conversation-update', { chatId, msgId: historyMsgId, fromMe: true });
        }
      }
    } catch (error) {
      stopTyping();
      const isOffline = error.message.includes('ECONNREFUSED') ||
                       error.message.includes('fetch failed') ||
                       error.message.includes('Serviço de IA');
      if (isOffline) {
        this.app.debug('AI', `⚠️ serviço de IA offline — bot continua funcionando, só a IA não responde`);
        const lastOfflineLog = this.lastAutoResponse.get('_ai_offline_log') || 0;
        if (Date.now() - lastOfflineLog > 60000) {
          this.app.log('AI', `Serviço de IA offline. Bot continua funcionando.`);
          this.lastAutoResponse.set('_ai_offline_log', Date.now());
        }
        // Reporta como aviso (não é crítico — bot ainda funciona)
        this.app.errors.report('AI', 'Serviço de IA offline', error, {
          userMessage: 'O Gemini não está respondendo. Verifique sua internet ou a chave de API em Configurações → IA.',
          severity: 'warn',
        });
      } else {
        this.app.log('AI', `Erro IA auto-respond: ${error.message}`);
        this.app.debug('AI', `erro: ${error.message}`);
        // Reporta erros de IA que não sejam "offline"
        this.app.errors.report('AI', `Erro IA: ${error.message}`, error, {
          userMessage: 'A IA encontrou um erro ao responder. Tente novamente em alguns segundos.',
          severity: 'error',
        });
      }
    }
  }

  // ===========================================================================
  // TRANSCRIBE AUDIO IN BACKGROUND — helper reutilizável
  // ===========================================================================

  /**
   * Transcreve um áudio do WhatsApp em background e injeta no contexto + painel.
   *
   * Reutilizado em 3 cenários (configuráveis pelo painel):
   *  - Modo 'always'    : chamado com `await` ANTES da decisão de chance.
   *                       Transcreve TODO áudio, mesmo se o bot não vai responder.
   *  - Modo 'balanced'  : chamado com `await` ANTES da decisão se entrosão > 0 OU isDirect.
   *  - Modo 'background' : chamado SEM await (ou com .catch()) pelo MessageRouter.
   *                       Não bloqueia a decisão de resposta do bot.
   *
   * Fluxo:
   *  1. Transcreve via audioTranscriber.transcribe(msg).
   *  2. Sucesso → injeta no contexto com prefixo `[🎵 áudio]:` + registra no
   *     painel (retroactive.recordIncomingMessage com isAudio=true) + extrai memória.
   *  3. Falha   → registra como `[áudio não transcrito]` no painel (badge 🎵 mas
   *     sem texto — indica que tentou e falhou, em vez de mostrar vazio).
   *
   * Não bloqueia a decisão de resposta: em modo 'background' é disparado sem await.
   * Se o bot depois decidir responder, o texto já está no contexto (capturado aqui).
   *
   * @returns `{ ok, text }` — status da transcrição (pra caller decidir se reage 🔇).
   */
  async transcribeAudioInBackground(
    msg: Message,
    chatId: string,
    senderName: string,
  ): Promise<{ ok: boolean; text: string | null }> {
    if (!this.app.audioTranscriber) {
      return { ok: false, text: null };
    }

    // === Resolução robusta de senderName ===
    // Se o caller passou senderName vazio ou '?', tenta resolver melhor.
    // Usa a mesma lógica do MessageRouter: msg.author (grupos), msg.sender,
    // profileBook, e contactNameCache.
    if (!senderName || senderName === '?' || senderName === 'alguém') {
      try {
        const msgAny = msg as any;
        // 1. Campos diretos da msg (mais rápido)
        let resolved = msgAny.author || msgAny.sender?.name || msgAny.sender?.pushname || '';
        // 2. profileBook se tem o from
        if (!resolved && msgAny.from) {
          const profile = this.app.profileBook?.get(msgAny.from);
          if (profile?.name) resolved = profile.name;
        }
        // 3. contactNameCache (populado pelo captureMessage)
        if (!resolved && msgAny.from && this.app.context) {
          const cached = (this.app.context as any).contactNameCache?.get(msgAny.from);
          if (cached) resolved = cached;
        }
        // 4. Fallback: getContact (mais lento, mas resolve LID em grupos)
        if (!resolved) {
          try {
            const contact = await msg.getContact();
            resolved = contact.name || contact.pushname || contact.number || '';
          } catch { /* ignora */ }
        }
        if (resolved) senderName = resolved;
      } catch { /* ignora */ }
    }

    this.app.log('AUDIO', `transcrevendo áudio (background) de ${senderName || '?'} em ${chatId}…`);

    let transcription: string | null = null;
    try {
      transcription = await this.app.audioTranscriber.transcribe(msg);
    } catch (e) {
      this.app.debug('AUDIO', `erro na transcrição (background): ${(e as Error).message}`);
      transcription = null;
    }

    const msgId = msg.id?._serialized;

    if (!transcription) {
      // Falhou nos 2 modelos — registra como [áudio não transcrito] no painel.
      // Mantém isAudio=true pra o painel mostrar a badge 🎵 mesmo sem texto.
      if (this.app.retroactive && msgId) {
        try {
          this.app.retroactive.recordIncomingMessage(
            chatId,
            msgId,
            senderName,
            '[áudio não transcrito]',
            Date.now(),
            false,  // fromMe=false (foi o usuário que mandou o áudio)
            undefined,
            true,   // isAudio=true (badge 🎵)
          );
        } catch { /* ignora — best-effort */ }
      }
      // Atualiza isAudio no decisionLog entry (se já tinha uma criada pelo markDecision).
      try {
        if (this.app.retroactive) {
          const entries = (this.app.retroactive as any).decisionLog?.get(chatId) as any[] | undefined;
          if (entries) {
            const existingEntry = entries.find((e: any) => e.msgId === msgId);
            if (existingEntry && !existingEntry.isAudio) {
              existingEntry.isAudio = true;
            }
          }
        }
      } catch { /* ignora */ }
      // Notifica o painel pra fazer auto-refresh.
      if (this.app.control) {
        this.app.control.broadcast('conversation-update', { chatId, msgId, fromMe: false });
      }
      return { ok: false, text: null };
    }

    // Sucesso — injeta no contexto com prefixo `[🎵 áudio]:` (IA sabe que veio de áudio).
    this.app.debug('AUDIO', `transcrição (background): "${transcription.slice(0, 80)}…"`);
    const audioContextText = `[🎵 áudio]: ${transcription}`;
    try {
      await this.app.context.captureMessage(msg, chatId, audioContextText);
    } catch (e) {
      this.app.debug('AUDIO', `erro ao capturar transcrição no contexto: ${(e as Error).message}`);
    }

    // Registra no painel Conversas com isAudio=true (badge separada do texto).
    if (this.app.retroactive && msgId) {
      try {
        this.app.retroactive.recordIncomingMessage(
          chatId,
          msgId,
          senderName,
          transcription,  // texto sem prefixo (painel mostra badge separado)
          Date.now(),
          false,  // fromMe=false
          undefined,
          true,   // isAudio=true
        );
      } catch { /* ignora */ }
    }

    // Atualiza isAudio no decisionLog entry (se já tinha uma criada pelo markDecision).
    try {
      if (this.app.retroactive) {
        const entries = (this.app.retroactive as any).decisionLog?.get(chatId) as any[] | undefined;
        if (entries) {
          const existingEntry = entries.find((e: any) => e.msgId === msgId);
          if (existingEntry && !existingEntry.isAudio) {
            existingEntry.isAudio = true;
          }
        }
      }
    } catch { /* ignora */ }

    // Extrai memória da transcrição (best-effort — pode ter gatilhos de fatos).
    try {
      await this.app.memory.maybeExtract(chatId, senderName, transcription);
    } catch { /* ignora — extração de memória é best-effort */ }

    // Notifica o painel pra fazer auto-refresh.
    if (this.app.control) {
      this.app.control.broadcast('conversation-update', { chatId, msgId, fromMe: false });
    }

    return { ok: true, text: transcription };
  }

  // ===========================================================================
  // AUTO-NOMEAÇÃO DE FIGURINHAS — fluxo natural via conversa
  // ===========================================================================

  /**
   * Remove perguntas pendentes velhas (TTL 5 min).
   * Se o usuário não respondeu à pergunta do bot "essa figurinha é sobre X?"
   * dentro de 5 minutos, a pergunta é esquecida (não nomeia mais nada se
   * ele responder tarde demais).
   */
  private _cleanupPendingStickerNames(): void {
    const now = Date.now();
    const TTL = 5 * 60 * 1000;  // 5 min
    for (const [k, v] of this.pendingStickerNames) {
      if (now - v.timestamp > TTL) this.pendingStickerNames.delete(k);
    }
  }

  /**
   * Usa IA multimodal pra descrever uma figurinha.
   * Retorna uma descrição curta (2-5 palavras) que pode ser usada como nome.
   * Ex: "gato rindo", "pessoa confusa", "meme do falido".
   */
  private async describeStickerWithAI(msg: Message): Promise<string | null> {
    try {
      const media = await msg.downloadMedia();
      if (!media || !media.data) return null;

      // Limite de 2MB — figurinhas muito grandes podem falhar no Gemini ou demorar.
      // (figurinhas típicas do WhatsApp têm 10-100KB, então 2MB é folgado)
      const approxBytes = media.data.length * 0.75;
      if (approxBytes > 2 * 1024 * 1024) {
        this.app.debug('STICKER-AI', `figurinha muito grande (${Math.round(approxBytes / 1024)}KB) — pulando descrição automática`);
        return null;
      }

      const aiConfig = this.getAIConfig();
      const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

      const systemPrompt = [
        'Você é um bot de WhatsApp. Alguém mandou uma figurinha.',
        'Descreva o que a figurinha representa em 2-5 palavras (será usado como nome).',
        'Regras:',
        '- Use português brasileiro',
        '- Seja específico mas curto (ex: "gato rindo", "pessoa confusa", "meme do falido")',
        '- NÃO use aspas nem pontuação final',
        '- Se tem texto na figurinha, pode incluir (ex: "eita meme")',
        '- Se é um personagem famoso, use o nome (ex: "ana maria braga", "chaves")',
        '- Responda SÓ com a descrição, sem comentários',
      ].join('\n');

      const userPrompt = 'Descreva essa figurinha em 2-5 palavras:';

      if (provider === 'gemini') {
        const systemInstruction = { parts: [{ text: systemPrompt }] };
        const contents = [{
          role: 'user',
          parts: [
            { text: userPrompt },
            { inlineData: { mimeType: media.mimetype || 'image/webp', data: media.data } },
          ],
        }];

        const allModels = this.getAllFallbackModels();
        for (const modelName of allModels) {
          try {
            const result = await this.callGemini(modelName, contents, systemInstruction, aiConfig);
            const cleaned = this.cleanResponse(result.content).trim();
            // Limita a 5 palavras
            const words = cleaned.split(/\s+/).slice(0, 5).join(' ');
            // Remove aspas se tiver
            return words.replace(/^["']|["']$/g, '').toLowerCase();
          } catch (err) {
            const status = (err as any).status;
            if (status === 429 || status === 503) continue;
            throw err;
          }
        }
        return null;
      } else {
        // OpenAI-compatible: manda image_url com data URL
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (aiConfig.apiKey) headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
        const dataUrl = `data:${media.mimetype || 'image/webp'};base64,${media.data}`;
        const messages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ]},
        ];
        const response = await fetch(aiConfig.apiUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: aiConfig.model, messages, max_tokens: 50, temperature: 0.3 }),
        });
        if (!response.ok) return null;
        const data = await response.json() as any;
        const content = data.choices?.[0]?.message?.content;
        if (!content) return null;
        const cleaned = content.trim();
        const words = cleaned.split(/\s+/).slice(0, 5).join(' ');
        return words.replace(/^["']|["']$/g, '').toLowerCase();
      }
    } catch (e) {
      this.app.debug('STICKER-AI', `erro ao descrever: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Interpreta a resposta do usuário à pergunta "essa figurinha é sobre X?"
   * e nomeia a figurinha no StickerVault.
   *
   * Padrões aceitos:
   * - Confirmação: "sim", "isso", "exato", "certo", "é isso", "isso mesmo", "exato", "y", "yes", "👍"
   * - Negação simples: "não", "errado", "não é" → pede pra digitar o nome
   * - Negação + correção: "não, é X", "na verdade é Y", "errado, é Z" → usa X/Y/Z
   * - Apenas o nome: se não bate com nenhum padrão, assume que é o nome
   */
  private async _handleStickerNameReply(
    userMsg: Message,
    botQuotedMsg: Message,
    pending: { stickerFilename: string; suggestedName: string; chatId: string; timestamp: number },
    chatId: string,
  ): Promise<void> {
    const text = (userMsg.body || '').trim().toLowerCase();
    if (!text) return;

    try {
      let finalName: string | null = null;
      let responseText = '';

      // Padrões de confirmação
      if (/^(sim|isso|exato|certo|é isso|isso mesmo|isso ai|isso aí|exatamente|correto|y|yes|👍|✅|confirmo)/.test(text)) {
        finalName = pending.suggestedName;
        responseText = `boaa, salvei como "${finalName}" 📌`;
      }
      // Padrões de negação + correção: "não, é X" / "na verdade é Y" / "errado, é Z"
      else {
        const correctionMatch = text.match(/^(?:n[aã]o|errado|nao é|n é|na verdade|nem|ne)(?:[,.\s]+(?:é|e|seria|eh|eh o))?[\s,]*([a-zà-ÿ0-9].+)$/);
        if (correctionMatch) {
          finalName = correctionMatch[1].trim();
          responseText = `entendi, vou salvar como "${finalName}" 📌`;
        }
        // Negação simples
        else if (/^(n[aã]o|errado|nao|n é|nem|ne)\b/.test(text)) {
          responseText = `blz, qual seria o nome certo então? manda aí (/fig nome ou só fala)`;
          // Re-abre a pergunta (não nomeia ainda)
        }
        // Se não bate com nada, assume que o usuário digitou o nome direto
        else if (text.length >= 2 && text.length <= 50) {
          finalName = text;
          responseText = `salvei como "${finalName}" 📌`;
        }
      }

      // Nomeia a figurinha
      if (finalName && this.app.stickers) {
        this.app.stickers.setMeta(pending.stickerFilename, { name: finalName });
        this.app.debug('STICKER-AUTO', `figurinha ${pending.stickerFilename} nomeada: "${finalName}"`);
        this.app.log('STICKER', `Figurinha nomeada automaticamente: "${finalName}" (sugerido: "${pending.suggestedName}")`);
      }

      // Responde no chat
      if (responseText) {
        const quotedId = userMsg.id?._serialized;
        await this.app.whatsapp.client.sendMessage(chatId, responseText, { quotedMessageId: quotedId });
      }
    } catch (e) {
      this.app.debug('STICKER-AUTO', `erro ao processar resposta: ${(e as Error).message}`);
    }
  }
}
