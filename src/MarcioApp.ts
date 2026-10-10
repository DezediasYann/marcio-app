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
import { Context } from './brain/Context';
import { Memory } from './brain/Memory';
import { Profile } from './brain/Profile';
import { Directives } from './brain/Directives';
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
  context!: Context;
  memory!: Memory;
  profile!: Profile;
  directives!: Directives;

  // Subsistemas das Fases 2.5-2.6 + 3 — ainda não instanciados.
  // Declarados como opcionais (?) pra o Context poder checar `if (this.app.X)`
  // antes de chamar. Quando a fase correspondente chegar, vira `!` + new no start().
  brain?: any;         // Fase 2.5 — MarcioBrain
  retroactive?: any;   // Fase 2.6 — Retroactive
  commands?: any;      // Fase 3 — CommandRegistry
  permissions?: any;   // Fase 3 — PermissionSystem
  stickers?: any;      // Fase 3 — StickerVault
  twitter?: any;       // Fase 3 — TwitterBot

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

    // === FASE 2.5-3: instanciar subsistemas aqui (ordem de dependência) ===
    // this.brain       = new MarcioBrain(this);
    // this.retroactive = new Retroactive(this);
    // this.stickers    = new StickerVault(this);
    // this.twitter     = new TwitterBot(this);
    // this.permissions = new PermissionSystem(this);
    // this.commands    = new CommandRegistry(this);
    // await this.commands.loadModules([...]);

    // WhatsApp por último (precisa do registry montado nas próximas fases)
    this.whatsapp = new WhatsAppClient(this);
    await this.whatsapp.initialize();

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
      // Salva pendências de memória + profile (auto-save de 30s pode não ter rodado)
      if (this.memory) {
        this.memory.destroy();
      }
      if (this.profile) {
        this.profile.destroy();
      }
      // Fase 2.4+: salvar directives, decision-log, etc. aqui
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
  }

  /**
   * Log de debug no terminal. Só printa se debugEnabled = true.
   * Equivalente à função debug() do index.js velho.
   */
  debug(tag: string, ...args: unknown[]): void {
    if (!this.debugEnabled) return;
    const time = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    console.log(`[${time}] [DEBUG ${tag}]`, ...args);
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
}
