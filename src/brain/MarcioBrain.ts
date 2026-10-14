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
    const { text: textAfterActions, actions } = await this.executeSelfActions(finalCleaned, chatId);
    finalCleaned = textAfterActions;

    // Se as ações produziram output, anexa no final da resposta
    if (actions.length > 0) {
      const actionsText = actions.map(a => `_${a}_`).join('\n');
      finalCleaned = finalCleaned + (finalCleaned ? '\n' : '') + actionsText;
      this.app.debug('SELF', `${actions.length} ação(ões) executada(s): ${actions.join('; ')}`);
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

    const lines = [
      '=== AUTOCONSCIÊNCIA (sobre você mesmo) ===',
      `Você é um bot de WhatsApp com IA.`,
      `Você roda em Node.js + TypeScript, embrulhado num app desktop Tauri/Rust.`,
      `Você foi construído com programação orientada a objetos (~24 classes, ~13000 linhas de código).`,
      `Seu "cérebro" usa o modelo Gemini "${primaryModel}"${fallbackModels.length > 0 ? ` com fallback para: ${fallbackModels.join(', ')}` : ''}.`,
      `Modelo que respondeu última vez: "${lastModel}".`,
      `Requests de IA hoje: ${this.aiRequestCount}.`,
      `Uptime: ${uptime} min.`,
      `Memórias: ${memoryCount} fatos sobre ${userCount} pessoa(s).`,
      `Chats ativos: ${chatCount}.`,
      `Figurinhas nomeadas: ${stickerCount}.`,
      `Diretivas ativas: ${directiveCount}.`,
      `Entrosão atual deste chat: ${this.chatEntrosaoLevel.get(chatId) ?? 1}.`,
      `Debug: ${this.app.debugEnabled ? (this.app.debugFullEnabled ? 'full' : 'on') : 'off'}.`,
      '',
      'AÇÕES SOBRE SI MESMO (use marcadores na sua resposta, o bot executa):',
      '• [ACAO: foto] — troca sua foto de perfil (pega uma imagem do contexto ou do vault)',
      '• [ACAO: modelo] — mostra info sobre seu modelo de IA atual',
      '• [ACAO: status] — mostra seu status completo (uptime, requests, memórias, etc.)',
      '• [ACAO: debug] — liga/desliga modo debug',
      '• [ACAO: entrosao N] — ajusta seu nível de entrosão (0=quieto, 1=normal, 2=2x)',
      '• [ACAO: memoria] — mostra quantas memórias você tem e sobre quem',
      '',
      'AÇÕES SOBRE O MUNDO (interage com outros chats):',
      '• [ACAO: avisar|texto] — manda "texto" em TODOS os chats ativos recentes (últimos 30min)',
      '• [ACAO: pv|nome da pessoa|mensagem] — manda "mensagem" no PV de "nome da pessoa"',
      '• [ACAO: grupo|nome do grupo|mensagem] — manda "mensagem" no grupo "nome do grupo"',
      '',
      'IMPORTANTE: as mensagens que você manda NÃO levam prefixo tipo "Bot:".',
      'VOCÊ escreve a mensagem natural, como falaria.',
      'Ao mandar no PV de alguém, inclua o CONTEXTO: quem pediu, de onde (grupo ou PV), e o que dizer.',
      'Ex.: alguém no grupo "Amigos" pede pra avisar o Fulano → você manda no PV do Fulano: "opa, o Sicrano lá no grupo Amigos pediu pra te falar que tu fede"',
      'Se o sorteio ou ação é no MESMO grupo, use [ACAO: pv|grupo|mensagem] pra mandar no grupo atual.',
      '',
      'Use essas ações quando fizer sentido NATURAL na conversa.',
      'Ex.: "avisa todo mundo que vou reiniciar" → responda + [ACAO: avisar|gente vou reiniciar, volto já]',
      'Ex.: "Manda pro Fulano dizendo que o jogo é amanhã" → [ACAO: pv|Fulano|opa, o Sicrano no grupo Amigos pediu pra te avisar que o jogo é amanhã]',
      'Ex.: "Sorteia alguém do grupo pro pão gozado" → [ACAO: pv|grupo|@fulano, você foi sorteado, a pedido do Sicrano, pro pão gozado]',
      'Os marcadores são SEMPRE removidos da resposta final — o usuário não vê.',
      '',
      'LAST.FM COLLAGES (quando alguém pedir):',
      '• [LASTCOLLAGE: username, grid, periodo] — cria um collage do Last.fm',
      '  - username: usuário do Last.fm (OBRIGATÓRIO)',
      '  - grid: 3, 4, ou 5 (default: 3 → 3x3)',
      '  - periodo: 7d, 1m, 3m, 6m, 12m, overall (default: 7d)',
      '',
      '⚠️ REGRA CRÍTICA: ANTES de usar [LASTCOLLAGE], PROCURE NAS MEMÓRIAS da pessoa',
      'se ela já te disse qual é o usuário do Last.fm dela (ou de outra rede social).',
      'Se nas memórias tem algo tipo "last.fm: fulano" ou "user: fulano", USE esse usuário.',
      'Se NÃO tem nas memórias, NÃO invente um usuário. PERGUNTE: "qual seu usuário no Last.fm?"',
      'NUNCA chute um usuário aleatório. Sempre use o que está nas memórias ou pergunte.',
      '',
      'Ex.: se nas memórias tem "last.fm: ydm_r" → [LASTCOLLAGE: ydm_r, 3, 7d]',
      'Ex.: "faz meu last 4x4 dos últimos 7 dias" sem saber o user → pergunte o usuário primeiro',
      'Ex.: "collage do last do fulano" sem saber o user dele → [LASTCOLLAGE: fulano, 3, 7d] (tenta o nome)',
      'O collage é gerado e enviado como imagem. O marcador é removido da resposta.',
    ];

    return lines.join('\n');
  }

  /**
   * Procura e executa marcadores [ACAO: ...] na resposta da IA.
   * Remove o marcador do texto e executa a ação correspondente.
   *
   * @returns { text: string (sem o marcador), actions: string[] (ações executadas) }
   */
  private async executeSelfActions(content: string, chatId: string): Promise<{ text: string; actions: string[] }> {
    const actions: string[] = [];
    let text = content;

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

    // Limpa espaços extras deixados pela remoção
    text = text.replace(/\s{2,}/g, ' ').trim();

    return { text, actions };
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

      // Envia o texto restante (se houver)
      if (cleanText) {
        return await this.sendMultiMessage(chatId, cleanText, quotedMessageId);
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
          if (result) {
            await this.app.whatsapp.client.sendMessage(chatId, result.media, { caption: result.caption });
          } else {
            this.app.debug('LASTFM', 'collage falhou — enviando só texto');
          }
        } catch (e) {
          this.app.debug('LASTFM', `erro ao processar collage da IA: ${(e as Error).message}`);
        }
      }

      // Envia o texto restante (se houver)
      if (reply) {
        return await this.sendMultiMessage(chatId, reply, quotedMessageId);
      }
      return '';
    }

    // Resposta de texto normal
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

    const senderName = this.app.context.getCachedSenderName(msg);
    const isSticker = msg.hasMedia && msg.type === 'sticker';
    // Detecta áudio: msg de áudio do WhatsApp é type='ptt' (push-to-talk) ou 'audio'.
    // Não tem body — mas talvez a gente queira transcrever e responder.
    const isAudio = this.app.audioTranscriber?.isAudioMessage(msg) ?? false;

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

    // === Avaliação de chance (se não é direto) ===
    if (!isDirect) {
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
      const entrosaoLevel = this.chatEntrosaoLevel.get(chatId) ?? 1.0;
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
      let audioTranscription: string | null = null;
      if (isAudio && this.app.audioTranscriber) {
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
      const quotedId = isDirect && msg.id && msg.id._serialized ? msg.id._serialized : null;
      const sentMsg = await this.sendResponse(chatId, reply, quotedId ?? undefined);
      const sentText = typeof sentMsg === 'string' ? sentMsg : '';

      stopTyping();
      this.lastAutoResponse.set(chatId, Date.now());
      if (sentText) this.app.context.captureBotResponse(chatId, sentText);
      this.app.debug('AI', `auto-resposta enviada em ${chatId} (direta=${isDirect})`);

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
        // mesmo após o decisionLog limpar entries >2h
        if (botResponseMsgId) {
          this.app.retroactive.recordIncomingMessage(
            chatId,
            botResponseMsgId,
            '',  // bot — senderName vazio é o padrão
            sentText || reply,
            Date.now(),
            true,  // fromMe = true (foi o bot que mandou)
            msg.id._serialized,  // cita a msg original
          );
          // Notifica o painel pra fazer auto-refresh
          if (this.app.control) {
            this.app.control.broadcast('conversation-update', { chatId, msgId: botResponseMsgId, fromMe: true });
          }
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
}
