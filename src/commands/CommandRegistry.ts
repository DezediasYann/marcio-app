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
 *
 * === OVERRIDES PERSISTENTES (Fase 6l) ===
 * O usuário pode, via painel:
 *  - Desativar um comando (disabled=true) — comando some do lookup.
 *  - Tornar um comando opOnly=true (era público) ou opOnly=false (era op).
 * Esses overrides são salvos em data/command-overrides.json e carregados no boot.
 *
 * Comandos "locked" (opOnly && pvOnly no def original) NÃO podem ser mexidos:
 *  - /admin, /op, /deop, /ops, /ban, /unban, /banidos
 * Esses sempre são só-op + só-PV, sempre ativos. Configuração de segurança.
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import fs from 'node:fs';

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

/**
 * Override persistente de um comando. Tudo opcional — só os campos setados
 * sobrescrevem o def original. Salvo em data/command-overrides.json.
 */
export interface CommandOverride {
  /** Se true, comando é ignorado pelo lookup (some do bot). */
  disabled?: boolean;
  /** Se setado, sobrescreve opOnly do def original. */
  opOnly?: boolean;
}

/**
 * Def "efetiva" — def original + override aplicado. Usado pelo MessageRouter
 * pra decidir se executa e quais permissões checar.
 */
export interface EffectiveCommandDef extends CommandDef {
  /** Override aplicado (se houver) — pra painel mostrar. */
  override?: CommandOverride;
  /** true se o comando é travado (admin commands: opOnly && pvOnly no original). */
  locked: boolean;
  /** true se está desativado por override. */
  isDisabled: boolean;
  /** opOnly efetivo (original OU override). */
  effectiveOpOnly: boolean;
}

// ============================================================================
// COMMAND REGISTRY
// ============================================================================

export class CommandRegistry {
  private app: MarcioApp;
  private cmds = new Map<string, CommandDef>();
  /**
   * Overrides persistentes — token (lowercase) → override.
   * Carregado de data/command-overrides.json no boot.
   */
  private overrides = new Map<string, CommandOverride>();

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
   * Carrega overrides de data/command-overrides.json. Chamado no boot (depois
   * de loadModules). Filtra overrides de comandos locked (não deveria existir,
   * mas se alguém editar o JSON manualmente, ignora silenciosamente).
   */
  loadOverrides(): void {
    try {
      const filePath = this.app.dataPath('command-overrides.json');
      if (!fs.existsSync(filePath)) {
        this.app.debug('CMD', 'nenhum override carregado (arquivo não existe)');
        return;
      }
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) return;
      const parsed = JSON.parse(content) as Record<string, CommandOverride>;
      let count = 0;
      let skipped = 0;
      for (const [token, override] of Object.entries(parsed)) {
        // Pula overrides pra comandos que não existem mais
        const def = this.cmds.get(token.toLowerCase());
        if (!def) {
          skipped++;
          continue;
        }
        // Pula overrides pra comandos locked (admin) — nunca devem ser mexidos
        if (this.isLocked(def)) {
          skipped++;
          continue;
        }
        // Sanitiza override — só campos conhecidos
        const clean: CommandOverride = {};
        if (typeof override.disabled === 'boolean') clean.disabled = override.disabled;
        if (typeof override.opOnly === 'boolean') clean.opOnly = override.opOnly;
        if (Object.keys(clean).length > 0) {
          this.overrides.set(token.toLowerCase(), clean);
          count++;
        }
      }
      this.app.log('CMD', `overrides carregados: ${count} comando(s) customizado(s)${skipped ? `, ${skipped} ignorado(s)` : ''}`);
    } catch (e) {
      this.app.debug('CMD', `erro ao carregar overrides: ${(e as Error).message}`);
    }
  }

  /**
   * Salva overrides em data/command-overrides.json.
   */
  saveOverrides(): void {
    try {
      const obj: Record<string, CommandOverride> = {};
      for (const [token, override] of this.overrides) {
        obj[token] = override;
      }
      fs.writeFileSync(
        this.app.dataPath('command-overrides.json'),
        JSON.stringify(obj, null, 2),
        'utf8',
      );
    } catch (e) {
      this.app.debug('CMD', `erro ao salvar overrides: ${(e as Error).message}`);
    }
  }

  /**
   * Define um override pra um comando. Só funciona se o comando NÃO é locked.
   * @param token Nome do comando (ex: "/pergunta").
   * @param override Override parcial — merge com override existente.
   * @returns true se foi setado, false se comando é locked ou não existe.
   */
  setOverride(token: string, override: CommandOverride): boolean {
    const name = token.toLowerCase();
    const def = this.cmds.get(name);
    if (!def) return false;
    if (this.isLocked(def)) return false;

    // Merge com override existente
    const current = this.overrides.get(name) || {};
    if (typeof override.disabled === 'boolean') current.disabled = override.disabled;
    if (typeof override.opOnly === 'boolean') current.opOnly = override.opOnly;
    this.overrides.set(name, current);
    this.saveOverrides();
    this.app.log('CMD', `override setado pra ${token}: disabled=${current.disabled ?? false} opOnly=${current.opOnly !== undefined ? current.opOnly : def.opOnly}`);
    return true;
  }

  /**
   * Remove override de um comando — volta pro def original do código.
   * @returns true se removedo, false se comando é locked ou não existe.
   */
  clearOverride(token: string): boolean {
    const name = token.toLowerCase();
    const def = this.cmds.get(name);
    if (!def) return false;
    if (this.isLocked(def)) return false;
    if (!this.overrides.has(name)) return true;  // já não tem override — ok
    this.overrides.delete(name);
    this.saveOverrides();
    this.app.log('CMD', `override removido pra ${token} — volta pro default do código`);
    return true;
  }

  /**
   * Verifica se um comando é "locked" — não pode ser mexido via painel.
   * Lock automático: comandos com opOnly && pvOnly no def original são locked
   * (todos os admin commands: /admin, /op, /deop, /ops, /ban, /unban, /banidos).
   */
  private isLocked(def: CommandDef): boolean {
    return !!(def.opOnly && def.pvOnly);
  }

  /**
   * Procura um comando pelo token (ex: "/admin", "!ajuda").
   * NÃO aplica overrides — retorna o def cru do código.
   * Usado pra listagem (all) ePra o MessageRouter usar getEffectiveDef().
   * @returns CommandDef ou undefined se não existe.
   */
  lookup(token: string): CommandDef | undefined {
    return this.cmds.get(token.toLowerCase());
  }

  /**
   * Procura um comando pelo token E aplica overrides.
   *  - Se override.disabled=true, retorna undefined (comando desativado).
   *  - Se override.opOnly setado, sobrescreve def.opOnly.
   * Usado pelo MessageRouter pra decidir se executa o comando.
   * @returns EffectiveCommandDef ou undefined (não existe OU desativado).
   */
  getEffectiveDef(token: string): EffectiveCommandDef | undefined {
    const def = this.cmds.get(token.toLowerCase());
    if (!def) return undefined;

    const override = this.overrides.get(def.name.toLowerCase());
    const locked = this.isLocked(def);

    // Se override desativou o comando → retorna undefined (some do lookup)
    if (override?.disabled === true) return undefined;

    // Aplica opOnly override (só se não é locked — locked nunca muda)
    const effectiveOpOnly = locked
      ? true  // locked sempre opOnly
      : (override?.opOnly !== undefined ? override.opOnly : !!def.opOnly);

    return {
      ...def,
      override,
      locked,
      isDisabled: false,  // se chegou aqui, não tá disabled
      effectiveOpOnly,
    };
  }

  /**
   * Lista todos os comandos únicos (dedup por name, ignora aliases).
   * Retorna a def EFETIVA (com override aplicado) pra painel mostrar status real.
   * Usado por /ajuda e pelo painel.
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
   * Lista todos os comandos com info de override + locked + disabled.
   * Usado pelo painel (GET /api/commands).
   */
  allWithStatus(): Array<EffectiveCommandDef & { aliases: string[] }> {
    const seen = new Set<string>();
    const result: Array<EffectiveCommandDef & { aliases: string[] }> = [];
    for (const def of this.cmds.values()) {
      if (seen.has(def.name)) continue;
      seen.add(def.name);

      const override = this.overrides.get(def.name.toLowerCase());
      const locked = this.isLocked(def);
      const isDisabled = override?.disabled === true;
      const effectiveOpOnly = locked
        ? true
        : (override?.opOnly !== undefined ? override.opOnly : !!def.opOnly);

      result.push({
        ...def,
        aliases: def.aliases || [],
        override,
        locked,
        isDisabled,
        effectiveOpOnly,
      });
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
