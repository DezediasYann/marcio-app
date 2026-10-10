/**
 * CommandRegistry — registro de comandos (plugin-based).
 *
 * Substitui o switch monolítico do index.js velho (linhas 4197-4278).
 * Cada módulo de comando (AdminCommands, StickerCommands, etc.) registra
 * seus handlers aqui. O MessageRouter faz o lookup por token.
 *
 * Vantagens:
 *  - Adicionar comando novo = criar módulo + register. Não mexe no dispatcher.
 *  - Aliases automáticos (!ajuda = !help = /ajuda).
 *  - Permission gates automáticos (opOnly, pvOnly).
 *  - help() gera /ajuda dinâmico.
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';

// ============================================================================
// TIPOS
// ============================================================================

export interface CommandDef {
  /** Nome principal (ex: "/admin"). Case-insensitive. */
  name: string;
  /**Aliases (ex: ["!ajuda", "!help"]). */
  aliases?: string[];
  /** Handler chamado quando o comando é invocado. */
  handler: (msg: Message, chatId: string) => Promise<void>;
  /** Texto de ajuda (pra /ajuda). */
  help?: string;
  /** Se true, só ops podem usar. Gate automático no router. */
  opOnly?: boolean;
  /** Se true, só funciona no PV do bot (não em grupo). */
  pvOnly?: boolean;
}

export interface CommandModule {
  /** Nome do módulo (ex: "admin", "sticker"). */
  name: string;
  /** Lista de comandos que o módulo registra. */
  commands: CommandDef[];
}

// ============================================================================
// COMMAND REGISTRY
// ============================================================================

export class CommandRegistry {
  private app: MarcioApp;
  private cmds = new Map<string, CommandDef>();

  constructor(app: MarcioApp) {
    this.app = app;
  }

  /**
   * Registra um comando + seus aliases.
   */
  register(def: CommandDef): void {
    const name = def.name.toLowerCase();
    this.cmds.set(name, def);
    for (const alias of def.aliases || []) {
      this.cmds.set(alias.toLowerCase(), def);
    }
  }

  /**
   * Carrega múltiplos módulos de comando.
   * Cada módulo é um objeto { name, commands: CommandDef[] }.
   */
  async loadModules(modules: CommandModule[]): Promise<void> {
    for (const mod of modules) {
      for (const def of mod.commands) {
        this.register(def);
      }
      this.app.log('CMD', `módulo "${mod.name}" carregado: ${mod.commands.length} comando(s)`);
    }
  }

  /**
   * Procura um comando pelo token (ex: "/admin", "!ajuda").
   * @returns CommandDef ou undefined se não existe.
   */
  lookup(token: string): CommandDef | undefined {
    return this.cmds.get(token.toLowerCase());
  }

  /**
   * Lista todos os comandos únicos (dedup por name, ignora aliases).
   * Usado pra gerar /ajuda.
   */
  all(): CommandDef[] {
    const seen = new Set<string>();
    const result: CommandDef[] = [];
    for (const def of this.cmds.values()) {
      if (!seen.has(def.name)) {
        seen.add(def.name);
        result.push(def);
      }
    }
    return result;
  }

  /**
   * Conta quantos comandos únicos estão registrados.
   */
  count(): number {
    return this.all().length;
  }
}
