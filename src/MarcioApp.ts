/**
 * MarcioApp — orquestrador raiz (service locator).
 *
 * Esta é a classe central do Márcio App. Ela instancia e conecta todos os
 * subsistemas. Qualquer subsistema acessa qualquer outro via `this.app`.
 *
 * Padrão inspirado no Server do Minecraft: um grafo de objetos que se
 * referenciam, tudo num processo só.
 *
 * === ESTADO DA FASE 1 ===
 * Nesta fase, só o WhatsAppClient é real. Os outros subsistemas são
 * declarados como `undefined` (com `!` pra satisfazer o TS) e vão ser
 * preenchidos nas Fases 2-3. O bot conecta no WhatsApp e loga mensagens
 * recebidas — não faz mais nada.
 *
 * À medida que avançarmos nas fases, os `//!` viram `new X(this)` e os
 * métodos vão sendo implementados.
 */

import { WhatsAppClient } from './whatsapp/WhatsAppClient';
import { MessageRouter } from './whatsapp/MessageRouter';
import { Context } from './brain/Context';
import { Memory } from './brain/Memory';
import { Profile } from './brain/Profile';
import { Directives } from './brain/Directives';
import { MarcioBrain } from './brain/MarcioBrain';
import { Retroactive } from './brain/Retroactive';
import { ProfileBook } from './brain/ProfileBook';
import { AudioTranscriber } from './brain/AudioTranscriber';
import { PermissionSystem } from './permissions/PermissionSystem';
import { StickerVault } from './stickers/StickerVault';
import { ChatSettings } from './permissions/ChatSettings';
import { CommandRegistry } from './commands/CommandRegistry';
import { BasicCommands } from './commands/BasicCommands';
import { StickerCommands } from './commands/StickerCommands';
import { AdminCommands } from './commands/AdminCommands';

import { Scheduler } from './scheduler/Scheduler';
import { AssistiveCommands } from './commands/AssistiveCommands';
import { ControlPanel } from './control/ControlPanel';
import { ErrorTracker } from './control/ErrorTracker';
import { FeatureFlags } from './control/FeatureFlags';
import { LastCollage } from './services/LastCollage';
import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  /** Diretório base do projeto (onde tá package.json). */
  rootDir: string;
  /** Diretório de dados (configs, JSONs de estado, stickers-vault). */
  dataDir: string;
  /** Diretório de logs. */
  logDir: string;
  /** Nome do bot (vai como prefixo nas notificações). */
  botName: string;
  /** Caminho pra o auth do WhatsApp. Se null, usa o default do LocalAuth
   *  (que é .wwebjs_auth/ no cwd). Aponte pra o mesmo dir do bot velho
   *  pra reaproveitar a sessão e NÃO precisar escanear QR de novo. */
  legacyAuthPath?: string;
}

/**
 * Config de IA — lida de data/ai-config.json com hot-reload de 5s.
 * Mantida aqui (no MarcioApp) pra qualquer subsistema acessar via this.app.aiConfig.
 * Na Fase 2.5 (MarcioBrain), isto vira uma classe dedicada com cache + reload.
 * Por enquanto é um objeto simples lido uma vez no start().
 */
export interface AIConfig {
  enabled: boolean;
  provider: string;
  model: string;
  fallbackModels: string[];
  apiUrl: string;
  apiKey: string;
  maxTokens: number;
  temperature: number;
  contextMessages: number;
  historyMessages: number;
  contextMaxMsgLength: number;
}

export class MarcioApp {
  // === Config imutável ===
  readonly config: AppConfig;
  readonly startTime: number = Date.now();

  // === Subsistemas ===
  whatsapp!: WhatsAppClient;
  router!: MessageRouter;
  context!: Context;
  memory!: Memory;
  profile!: Profile;
  profileBook!: ProfileBook;
  directives!: Directives;
  brain!: MarcioBrain;
  retroactive!: Retroactive;
  audioTranscriber!: AudioTranscriber;
  permissions!: PermissionSystem;
  stickers!: StickerVault;
  chatSettings!: ChatSettings;
  commands!: CommandRegistry;

  scheduler!: Scheduler;
  control!: ControlPanel;
  errors!: ErrorTracker;
  features!: FeatureFlags;
  lastCollage!: LastCollage;

  // Todos os subsistemas estão instanciados (Fase 3 + 4 + 5a completa).

  // === Config de IA (lida de data/ai-config.json) ===
  aiConfig: AIConfig | null = null;

  // === Estado mutável de debug (runtime-tunable) ===
  debugEnabled: boolean = true;
  debugFullEnabled: boolean = false;

  // === Modo manutenção — pausa o bot (não responde msgs) mas painel funciona ===
  maintenanceMode: boolean = false;

  // === Histórico de stats (pra gráficos do dashboard) ===
  // A cada 60s, coleta um snapshot. Mantém as últimas 24h (1440 pontos).
  statsHistory: Array<{ time: number; aiRequests: number; iaResponses: number; messages: number }> = [];
  private statsHistoryTimer: NodeJS.Timeout | null = null;
  private lastIaResponses: number = 0;
  private lastMessages: number = 0;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Inicializa o app. Ordem importa: primeiros os subsistemas que não
   * dependem de outros.
   *
   * FASE 2.1 (atual): Context + aiConfig carregado.
   */
  async start(): Promise<void> {
    this.log('BOOT', `Márcio App iniciando — rootDir=${this.config.rootDir}`);
    this.log('BOOT', `dataDir=${this.config.dataDir}`);
    this.log('BOOT', `Auth path=${this.config.legacyAuthPath ?? '(default .wwebjs_auth)'}`);

    // Garante que os diretórios existem
    this.ensureDirs();

    // === Carrega config de IA (data/ai-config.json) ===
    this.loadAIConfig();

    // === FASE 2.1: Context (memória de conversa + cache de nomes) ===
    this.context = new Context(this);
    this.log('BOOT', 'Context inicializado.');

    // === FASE 2.2: Memory (fatos permanentes sobre pessoas) ===
    this.memory = new Memory(this);
    this.log('BOOT', `Memory inicializado — ${this.memory.allUsers().length} usuário(s) com memórias.`);

    // === FASE 2.3: Profile (aprendizado de estilo do grupo) ===
    this.profile = new Profile(this);
    this.log('BOOT', 'Profile inicializado.');

    // === ProfileBook (perfis IA de pessoas + grupos — cross-chat) ===
    this.profileBook = new ProfileBook(this);
    const _personCount = this.profileBook.byType('person').length;
    const _groupCount = this.profileBook.byType('group').length;
    this.log('BOOT', `ProfileBook inicializado — ${_personCount} pessoa(s), ${_groupCount} grupo(s).`);
    // Starta varredura periódica de perfis stale (a cada 30min)
    this.profileBook.startAutoUpdateTimer();

    // === FASE 2.4: Directives (regras customizadas do dono) ===
    this.directives = new Directives(this);
    this.log('BOOT', `Directives inicializado — ${this.directives.all().length} diretiva(s).`);

    // === FASE 2.5: MarcioBrain (o cérebro — IA, prompt, fallback) ===
    this.brain = new MarcioBrain(this);
    this.brain.loadBotConfig();  // carrega bot-config.json (nome + aliases customizados)
    this.log('BOOT', `Brain inicializado — modelo=${this.brain.getAIConfig().model} fallbacks=${this.brain.getAllFallbackModels().length - 1} botName=${this.config.botName}`);

    // === FASE 6b: ChatSettings (persiste IA/entrosão/mute por chat) ===
    this.chatSettings = new ChatSettings(this);
    this.chatSettings.loadIntoBrain();  // popula brain.aiDisabledChats, chatEntrosaoLevel, democraticallyMutedChats
    this.log('BOOT', `ChatSettings inicializado — ${this.chatSettings.allChatIds().length} chat(s) com settings customizadas.`);

    // === FASE 2.6: Retroactive (conversas retroativas — "voltar" a msgs ignoradas) ===
    this.retroactive = new Retroactive(this);
    this.retroactive.load();  // carrega decision-log.json
    this.log('BOOT', `Retroactive inicializado — intervalo=${this.retroactive.intervalMin}min janela=${this.retroactive.windowMin}min`);

    // === FASE 6k: AudioTranscriber (transcrição de áudios do WhatsApp via Gemini multimodal) ===
    this.audioTranscriber = new AudioTranscriber(this);
    const _audioCfg = this.audioTranscriber.getConfig();
    this.log('BOOT', `AudioTranscriber inicializado — enabled=${_audioCfg.enabled} primary=${_audioCfg.primaryModel} fallback=${_audioCfg.fallbackModel}`);

    // === FASE 3.1: PermissionSystem (ops + banidos + resolveSenderIds) ===
    this.permissions = new PermissionSystem(this);
    this.log('BOOT', `Permissions inicializado — ${this.permissions.loadOps().length} op(s), ${this.permissions.loadBanned().length} banido(s).`);

    // === FASE 3.1: StickerVault (vault + ondas/guerras + identify) ===
    this.stickers = new StickerVault(this);
    this.log('BOOT', `StickerVault inicializado — ${this.stickers.listNamed().length} figurinha(s) nomeada(s).`);

    // === FASE 3.2: CommandRegistry (plugin-based, substitui o switch) ===
    this.commands = new CommandRegistry(this);
    // FASE 3.3-4: carregar módulos de comando
    await this.commands.loadModules([
      new BasicCommands(this),
      new StickerCommands(this),
      new AdminCommands(this),
    ]);
    this.log('BOOT', `CommandRegistry inicializado — ${this.commands.count()} comando(s) registrado(s).`);

    // === FASE 4: Scheduler (eventos + lembretes agendados) ===
    this.scheduler = new Scheduler(this);
    this.scheduler.start();
    this.log('BOOT', `Scheduler inicializado — ${this.scheduler.list().length} evento(s) pendente(s).`);

    // === LastCollage (colagens do Last.fm) ===
    this.lastCollage = new LastCollage(this);
    this.log('BOOT', 'LastCollage inicializado (colagens do Last.fm)');

    // === FASE 3.2: CommandRegistry (plugin-based, substitui o switch) ===
    this.commands = new CommandRegistry(this);
    await this.commands.loadModules([
      new BasicCommands(this),
      new StickerCommands(this),
      new AdminCommands(this),
      new AssistiveCommands(this),
    ]);
    // Carrega overrides persistentes (data/command-overrides.json) — permite
    // ativar/desativar comandos e mudar opOnly↔public via painel.
    this.commands.loadOverrides();
    this.log('BOOT', `CommandRegistry inicializado — ${this.commands.count()} comando(s) registrado(s).`);

    // Router ANTES do WhatsApp initialize (o handler message_create chama router)
    this.router = new MessageRouter(this);

    // === FeatureFlags — detecta canal (dev/beta/stable) ===
    // Inicializa ANTES do ControlPanel pra que os endpoints já tenham acesso.
    this.features = new FeatureFlags();
    this.log('BOOT', `FeatureFlags inicializado — canal=${this.features.getChannel()}`);

    // === ErrorTracker — captura erros de todos os subsistemas ===
    // Inicializa ANTES do ControlPanel pra que ele já possa capturar erros
    // durante a inicialização dos próximos subsistemas.
    this.errors = new ErrorTracker(this);
    this.errors.init();
    this.log('BOOT', 'ErrorTracker inicializado (captura de erros centralizada)');

    // === FASE 5a: ControlPanel (dashboard web em http://localhost:3001) ===
    // INICIA ANTES do WhatsApp — assim o painel (e o setup wizard) já consegue
    // fazer requests HTTP enquanto o WhatsApp ainda tá conectando.
    this.control = new ControlPanel(this);
    this.control.listen(3001);
    this.log('BOOT', 'ControlPanel ouvindo em http://localhost:3001');

    // WhatsApp por último (dispara QR/ready/message_create) — async, demora 10-30s
    this.whatsapp = new WhatsAppClient(this);
    // NÃO espera initialize() — roda em background pra não bloquear o boot.
    // O ControlPanel já tá ouvindo, e o WhatsApp conecta quando conseguir.
    this.whatsapp.initialize().catch((e: Error) => {
      this.log('BOOT', `Erro ao inicializar WhatsApp: ${e.message}`);
      this.errors.report('WA', `Erro ao inicializar WhatsApp: ${e.message}`, e, {
        userMessage: 'Não consegui inicializar o WhatsApp. Verifique sua conexão de internet.',
        severity: 'critical',
      });
    });

    // Starta o timer de verificação retroativa (a cada 10min por default)
    this.retroactive.setupTimer();

    // Starta coleta de stats pro gráfico (a cada 60s)
    this.startStatsHistory();

    this.log('BOOT', 'Márcio App pronto e conectado.');

    // === Backfill de histórico (espera WhatsApp 'ready') ===
    // NÃO pode rodar antes — client.getChats() falha se WA não tá pronto.
    // O client.initialize() resolve antes do evento 'ready' disparar, então
    // precisamos esperar. Se já ficou ready (lastReconnect > 0), roda direto.
    const runBackfill = () => {
      this.log('BOOT', 'WhatsApp ready — disparando backfill de histórico...');
      this.retroactive.backfillHistory(30, 100).catch(e => {
        this.log('BOOT', `backfill falhou: ${(e as Error).message}`);
      });
    };
    if (this.whatsapp.lastReconnect > 0) {
      runBackfill();
    } else {
      // client é EventEmitter mas o tipo não expõe .once()/.removeListener()
      const client = this.whatsapp.client as any;
      const handler = () => {
        client.removeListener('ready', handler);
        runBackfill();
      };
      client.on('ready', handler);
    }
  }

  /**
   * Coleta um snapshot de stats a cada 60s pra alimentar gráficos do dashboard.
   * Mantém as últimas 24h (1440 pontos).
   */
  private startStatsHistory(): void {
    // Snapshot inicial
    this.collectStatsSnapshot();

    this.statsHistoryTimer = setInterval(() => {
      this.collectStatsSnapshot();
    }, 60000); // 60s
  }

  private collectStatsSnapshot(): void {
    const now = Date.now();
    const currentIaResponses = this.brain?.aiRequestCount || 0;
    const currentMessages = this.context?.count ? this.context.activeChatIds().reduce((sum, id) => sum + this.context.count(id), 0) : 0;

    this.statsHistory.push({
      time: now,
      aiRequests: currentIaResponses,
      iaResponses: currentIaResponses - this.lastIaResponses, // delta (responses neste minuto)
      messages: currentMessages - this.lastMessages, // delta (msgs neste minuto)
    });

    this.lastIaResponses = currentIaResponses;
    this.lastMessages = currentMessages;

    // Mantém só as últimas 24h (1440 pontos de 60s)
    if (this.statsHistory.length > 1440) {
      this.statsHistory = this.statsHistory.slice(-1440);
    }
  }

  /**
   * Carrega data/ai-config.json pra this.aiConfig.
   * Na Fase 2.5 (MarcioBrain), isto vira uma classe com hot-reload de 5s.
   * Por enquanto, lê uma vez no boot.
   */
  private loadAIConfig(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.dataPath('ai-config.json'), 'utf8'));
      // Merge com defaults do guia (AI_CONFIG do index.js velho, linhas 81-292)
      this.aiConfig = {
        enabled: true,
        provider: raw.provider || (raw.apiUrl?.includes('googleapis') ? 'gemini' : 'openai'),
        model: raw.model || 'gemini-2.0-flash-lite',
        fallbackModels: raw.fallbackModels || (raw.fallbackModel ? [raw.fallbackModel] : []),
        apiUrl: raw.apiUrl || '',
        apiKey: raw.apiKey || '',
        maxTokens: raw.maxTokens ?? 400,
        temperature: raw.temperature ?? 0.75,
        contextMessages: 20,
        historyMessages: 25,
        contextMaxMsgLength: 250,
      };
      this.log('BOOT', `AI config carregado: provider=${this.aiConfig.provider} model=${this.aiConfig.model} fallbacks=${this.aiConfig.fallbackModels.length}`);
    } catch (e) {
      this.log('BOOT', `⚠️ Erro ao carregar ai-config.json: ${(e as Error).message}. IA vai ficar desativada.`);
      this.aiConfig = null;
    }
  }

  /**
   * Desliga tudo graciosamente. Salva estado, fecha o client do WhatsApp.
   */
  async shutdown(): Promise<void> {
    this.log('BOOT', 'Desligando Márcio App...');
    try {
      // Salva pendências de memória + profile + retroactive (auto-save 30s pode não ter rodado)
      if (this.memory) {
        this.memory.destroy();
      }
      if (this.profile) {
        this.profile.destroy();
      }
      if (this.profileBook) {
        this.profileBook.destroy();
      }
      if (this.retroactive) {
        this.retroactive.destroy();
      }
      if (this.scheduler) {
        this.scheduler.destroy();
      }
      if (this.control) {
        this.control.destroy();
      }
      if (this.whatsapp) {
        await this.whatsapp.destroy();
      }
    } catch (e) {
      this.log('BOOT', `erro ao desligar: ${(e as Error).message}`);
    }
    this.log('BOOT', 'Márcio App desligado.');
  }

  // ===========================================================================
  // LOG / DEBUG — utilidades cross-cutting usadas por todos os subsistemas.
  // Equivalente às funções logToFile() e debug() do index.js velho.
  // ===========================================================================

  /**
   * Log persistente em arquivo (logs/bot.log) com timestamp BR.
   * Sempre escreve, independente de debugEnabled.
   * Também faz broadcast pro ControlPanel (se ativo) — assim o painel
   * mostra logs em tempo real via WebSocket.
   * Também detecta eventos críticos e manda notificação nativa do sistema.
   */
  log(tag: string, message: string): void {
    const time = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const line = `[${time}] [${tag}] ${message}`;
    try {
      fs.appendFileSync(path.join(this.config.logDir, 'bot.log'), line + '\n', 'utf8');
    } catch (e) {
      // Se o dir de log não existir ainda, ignora — o ensureDirs resolve
    }
    // Também printa no console (útil no VS Code terminal)
    console.log(line);
    // Broadcast pro painel (se ativo)
    if (this.control) {
      this.control.broadcast('log', { tag, message, time });
    }
    // Detecta eventos críticos e manda notificação nativa
    this.checkCriticalEvent(tag, message);
  }

  /**
   * Última vez que cada tipo de notificação foi enviada (pra não spammar).
   */
  private lastNotification: Record<string, number> = {};

  /**
   * Detecta eventos críticos no log e manda notificação nativa do sistema.
   * Só notifica se:
   *  - O app tá rodando como Tauri (window.__TAURI__ existe no painel)
   *  - Passou pelo menos 60s desde a última notificação do mesmo tipo
   */
  private checkCriticalEvent(tag: string, message: string): void {
    if (!this.control) return;

    const now = Date.now();
    const minInterval = 60000; // 60s entre notificações do mesmo tipo
    const canNotify = (type: string): boolean => {
      const last = this.lastNotification[type] || 0;
      if (now - last < minInterval) return false;
      this.lastNotification[type] = now;
      return true;
    };

    // IA offline
    if (tag === 'AI' && message.includes('serviço de IA offline')) {
      if (canNotify('ia-offline')) {
        this.control.broadcast('notification', {
          title: '⚠️ Márcio: IA offline',
          body: 'O Gemini não está respondendo. O bot continua funcionando, mas não responde com IA.',
        });
      }
    }

    // WhatsApp desconectou
    if (tag === 'WA' && message.includes('Desconectado')) {
      if (canNotify('wa-disconnected')) {
        this.control.broadcast('notification', {
          title: '⚠️ Márcio: WhatsApp caiu',
          body: 'A conexão com o WhatsApp foi perdida. Tentando reconectar...',
        });
      }
    }

    // Erro fatal
    if (tag === 'FATAL' || (tag === 'ERROR' && message.includes('critical'))) {
      if (canNotify('fatal')) {
        this.control.broadcast('notification', {
          title: '❌ Márcio: erro crítico',
          body: message.slice(0, 100),
        });
      }
    }
  }

  /**
   * Log de debug no terminal. Só printa se debugEnabled = true.
   * Equivalente à função debug() do index.js velho.
   * Também faz broadcast pro ControlPanel (se ativo E debugEnabled).
   */
  debug(tag: string, ...args: unknown[]): void {
    if (!this.debugEnabled) return;
    const time = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    console.log(`[${time}] [DEBUG ${tag}]`, ...args);
    // Broadcast pro painel (só se debug tá on — senão o painel floods)
    if (this.control) {
      this.control.broadcast('log', { tag: `DEBUG ${tag}`, message, time });
    }
  }

  // ===========================================================================
  // BOT LIFECYCLE — stop / start / restart
  // Usados pelo ControlPanel (POST /api/bot/stop|start|restart).
  // São diferentes do shutdown() — shutdown() é definitivo (sai do processo),
  // esses methods permitem parar/iniciar o WhatsApp sem derrubar o resto.
  // ===========================================================================

  /**
   * Para o bot graciosamente (salva estado, fecha WhatsApp).
   * Os subsistemas de dados (memory, profile, retroactive, scheduler)
   * são persistidos/fechados, mas continuam instanciados — podem ser
   * re-utilizados quando startBot() re-inicializar o WhatsApp.
   */
  async stopBot(): Promise<void> {
    this.log('BOT', 'Parando bot...');
    try {
      // Salva pendências
      if (this.memory) this.memory.destroy();
      if (this.profile) this.profile.destroy();
      if (this.profileBook) this.profileBook.destroy();
      if (this.retroactive) this.retroactive.destroy();
      if (this.scheduler) this.scheduler.destroy();
      // Fecha WhatsApp
      if (this.whatsapp) await this.whatsapp.destroy();
    } catch (e) {
      this.log('BOT', `erro ao parar bot: ${(e as Error).message}`);
    }
    this.log('BOT', 'Bot parado.');
  }

  /**
   * Inicia o bot (depois de parado).
   * Cria um NOVO WhatsAppClient (não re-initializa o mesmo — o whatsapp-web.js
   * não remove event handlers no destroy(), então re-initializar duplicaria
   * os handlers de message_create → mensagens duplicadas).
   */
  async startBot(): Promise<void> {
    this.log('BOT', 'Iniciando bot...');
    try {
      // Cria NOVO WhatsAppClient (não reusa o destruído)
      this.whatsapp = new WhatsAppClient(this);
      await this.whatsapp.initialize();
    } catch (e) {
      this.log('BOT', `erro ao iniciar bot: ${(e as Error).message}`);
    }
    this.log('BOT', 'Bot iniciado.');
  }

  /**
   * Reinicia o bot (stop + start com pausa de 2s).
   * Útil pra quando o WhatsApp fica travado/lento e o usuário quer
   * forçar reconexão sem matar o processo.
   */
  async restartBot(): Promise<void> {
    this.log('BOT', 'Reiniciando bot...');
    await this.stopBot();
    await new Promise(r => setTimeout(r, 2000)); // espera 2s
    await this.startBot();
    this.log('BOT', 'Bot reiniciado.');
  }

  // ===========================================================================
  // HELPERS internos
  // ===========================================================================

  private ensureDirs(): void {
    const dirs = [
      this.config.dataDir,
      this.config.logDir,
      path.join(this.config.dataDir, 'stickers-vault'),
    ];
    // Garante que o dir de auth existe (se legacyAuthPath foi setado)
    if (this.config.legacyAuthPath) {
      dirs.push(this.config.legacyAuthPath);
    }
    for (const d of dirs) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch (e) {
        // ignora se já existe
      }
    }
    // Cria arquivos default de config se não existirem (em runtime).
    // Isso garante que o bot funciona mesmo se o lib.rs não criou os arquivos
    // (ex: em dev mode, ou se o usuário deletou os arquivos).
    this.ensureDefaultDataFiles();
  }

  /**
   * Cria arquivos default de configuração em data/ se não existirem.
   * NÃO sobrescreve arquivos existentes — só cria se faltam.
   * Isso garante que o bot inicia "zerado mas funcional" na primeira vez.
   */
  private ensureDefaultDataFiles(): void {
    const defaults: Array<{ name: string; content: string }> = [
      { name: 'ai-config.json', content: JSON.stringify({
        model: 'gemini-3.5-flash-lite',
        fallbackModels: ['gemini-3.1-flash-lite'],
        apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
        apiKey: '',
        maxTokens: 400,
        temperature: 0.75,
        audioTranscription: {
          enabled: true,
          primaryModel: 'gemini-3.5-flash-lite',
          fallbackModel: 'gemini-3.1-flash-lite',
        },
      }, null, 2) },
      { name: 'banned.json', content: '[]' },
      { name: 'ops.json', content: '[]' },
      { name: 'directives.json', content: '[]' },
      { name: 'memories.json', content: '{}' },
      { name: 'chat-settings.json', content: '{}' },
      { name: 'decision-log.json', content: '{}' },
      { name: 'stickers-meta.json', content: '{}' },
      // system-prompt.txt vazio — bot usa DEFAULT_SYSTEM_PROMPT hardcoded
      { name: 'system-prompt.txt', content: '' },
    ];
    for (const { name, content } of defaults) {
      const filePath = this.dataPath(name);
      if (!fs.existsSync(filePath)) {
        try {
          fs.writeFileSync(filePath, content, 'utf8');
          this.log('BOOT', `criado ${name} (default)`);
        } catch (e) {
          this.debug('BOOT', `erro ao criar ${name}: ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * Caminho pra um arquivo de dados. Sempre dentro de dataDir.
   * Uso: this.app.dataPath('memories.json') → '/path/to/data/memories.json'
   */
  dataPath(filename: string): string {
    return path.join(this.config.dataDir, filename);
  }

  // ===========================================================================
  // HELPERS DE WHATSAPP — react, notify, reportError
  // Equivalente às funções react(), notify(), reportError() do index.js velho.
  // Usados por TODOS os command handlers.
  // ===========================================================================

  /**
   * Reage a uma mensagem com um emoji.
   * @param msg Mensagem do WhatsApp.
   * @param emoji Emoji (ex: '⏳', '✅', '❌').
   */
  async react(msg: any, emoji: string): Promise<void> {
    try {
      await msg.react(emoji);
    } catch (e) {
      this.log('REACT', `Falha ao reagir (${emoji}) na mensagem ${msg.id?._serialized}: ${(e as Error).message}`);
    }
  }

  /**
   * Envia uma mensagem de texto prefixada com o nome do bot.
   * @param chatId ID do chat de destino.
   * @param text Texto da mensagem (sem prefixo — o bot adiciona).
   */
  async notify(chatId: string, text: string): Promise<void> {
    // Se um comando foi injetado pelo painel E a resposta é pro PV do bot,
    // manda a resposta pro painel também (pro usuário ver no log do dashboard).
    if (this.control?.capturing && chatId === this.control.capturingChatId) {
      this.control.broadcast('log', { tag: 'OUTPUT', message: text, time: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }) });
    }
    try {
      await this.whatsapp.client.sendMessage(chatId, `${this.config.botName}: ${text}`);
    } catch (e) {
      this.log('NOTIFY', `Falha ao enviar notificação para ${chatId}: ${(e as Error).message}`);
    }
  }

  /**
   * Reporta um erro: reage com ❌, notifica o usuário e registra no log.
   * @param msg Mensagem que disparou o erro.
   * @param chatId ID do chat.
   * @param userMessage Mensagem pro usuário (sem jargão técnico).
   * @param error Erro original (opcional — pra log).
   */
  async reportError(msg: any, chatId: string, userMessage: string, error?: Error): Promise<void> {
    await this.react(msg, '❌');
    await this.notify(chatId, userMessage);
    if (error) {
      this.log('ERROR', `${chatId}: ${error.message || String(error)}`);
    }
  }
}
