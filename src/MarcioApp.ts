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
import { PermissionSystem } from './permissions/PermissionSystem';
import { StickerVault } from './stickers/StickerVault';
import { CommandRegistry } from './commands/CommandRegistry';
import { BasicCommands } from './commands/BasicCommands';
import { StickerCommands } from './commands/StickerCommands';
import { AdminCommands } from './commands/AdminCommands';
import { TwitterBot } from './twitter/TwitterBot';
import { TwitterCommands } from './commands/TwitterCommands';
import { Scheduler } from './scheduler/Scheduler';
import { AssistiveCommands } from './commands/AssistiveCommands';
import { ControlPanel } from './control/ControlPanel';
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
  directives!: Directives;
  brain!: MarcioBrain;
  retroactive!: Retroactive;
  permissions!: PermissionSystem;
  stickers!: StickerVault;
  commands!: CommandRegistry;
  twitter!: TwitterBot;
  scheduler!: Scheduler;
  control!: ControlPanel;

  // Todos os subsistemas estão instanciados (Fase 3 + 4 + 5a completa).

  // === Config de IA (lida de data/ai-config.json) ===
  aiConfig: AIConfig | null = null;

  // === Estado mutável de debug (runtime-tunable) ===
  debugEnabled: boolean = true;
  debugFullEnabled: boolean = false;

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

    // === FASE 2.4: Directives (regras customizadas do dono) ===
    this.directives = new Directives(this);
    this.log('BOOT', `Directives inicializado — ${this.directives.all().length} diretiva(s).`);

    // === FASE 2.5: MarcioBrain (o cérebro do Márcio — IA, prompt, fallback) ===
    this.brain = new MarcioBrain(this);
    this.log('BOOT', `Brain inicializado — modelo=${this.brain.getAIConfig().model} fallbacks=${this.brain.getAllFallbackModels().length - 1}`);

    // === FASE 2.6: Retroactive (conversas retroativas — "voltar" a msgs ignoradas) ===
    this.retroactive = new Retroactive(this);
    this.retroactive.load();  // carrega decision-log.json
    this.log('BOOT', `Retroactive inicializado — intervalo=${this.retroactive.intervalMin}min janela=${this.retroactive.windowMin}min`);

    // === FASE 3.1: PermissionSystem (ops + banidos + resolveSenderIds) ===
    this.permissions = new PermissionSystem(this);
    this.log('BOOT', `Permissions inicializado — ${this.permissions.loadOps().length} op(s), ${this.permissions.loadBanned().length} banido(s).`);

    // === FASE 3.1: StickerVault (vault + ondas/guerras + identify) ===
    this.stickers = new StickerVault(this);
    this.log('BOOT', `StickerVault inicializado — ${this.stickers.listNamed().length} figurinha(s) nomeada(s).`);

    // === FASE 3.2: CommandRegistry (plugin-based, substitui o switch) ===
    this.commands = new CommandRegistry(this);
    // FASE 3.3-3.5: carregar módulos de comando
    await this.commands.loadModules([
      new BasicCommands(this),
      new StickerCommands(this),
      new AdminCommands(this),
      new TwitterCommands(this),
    ]);
    this.log('BOOT', `CommandRegistry inicializado — ${this.commands.count()} comando(s) registrado(s).`);

    // === FASE 3.5: TwitterBot (auto-post + aprovação + reply to mentions) ===
    this.twitter = new TwitterBot(this);
    const twCfg = this.twitter.getConfig();
    if (twCfg.enabled) {
      this.log('BOOT', `Twitter inicializado — approvalMode=${twCfg.approvalMode} mentions=${twCfg.replyToMentions}`);
    } else {
      this.log('BOOT', 'Twitter inicializado (desativado no config).');
    }

    // === FASE 4: Scheduler (eventos + lembretes agendados) ===
    this.scheduler = new Scheduler(this);
    this.scheduler.start();
    this.log('BOOT', `Scheduler inicializado — ${this.scheduler.list().length} evento(s) pendente(s).`);

    // === FASE 3.2: CommandRegistry (plugin-based, substitui o switch) ===
    this.commands = new CommandRegistry(this);
    // FASE 3.3-4: carregar módulos de comando
    await this.commands.loadModules([
      new BasicCommands(this),
      new StickerCommands(this),
      new AdminCommands(this),
      new TwitterCommands(this),
      new AssistiveCommands(this),
    ]);
    this.log('BOOT', `CommandRegistry inicializado — ${this.commands.count()} comando(s) registrado(s).`);

    // Router ANTES do WhatsApp initialize (o handler message_create chama router)
    this.router = new MessageRouter(this);
    // WhatsApp por último (dispara QR/ready/message_create)
    this.whatsapp = new WhatsAppClient(this);
    await this.whatsapp.initialize();

    // Starta o timer de verificação retroativa (a cada 10min por default)
    this.retroactive.setupTimer();

    // Starta os timers do Twitter (auto-post a cada 4h, mention check a cada 15min)
    if (twCfg.enabled) {
      this.twitter.startAutoPostTimer();
      if (twCfg.replyToMentions) {
        this.twitter.startMentionChecker();
      }
    }

    // === FASE 5a: ControlPanel (dashboard web em http://localhost:3001) ===
    this.control = new ControlPanel(this);
    this.control.listen(3001);
    this.log('BOOT', 'ControlPanel ouvindo em http://localhost:3001');

    this.log('BOOT', 'Márcio App pronto e conectado.');
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
      if (this.retroactive) {
        this.retroactive.destroy();
      }
      if (this.twitter) {
        this.twitter.destroy();
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
  // HELPERS internos
  // ===========================================================================

  private ensureDirs(): void {
    const dirs = [this.config.dataDir, this.config.logDir];
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
