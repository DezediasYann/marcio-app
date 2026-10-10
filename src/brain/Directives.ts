/**
 * Directives — regras customizadas de "educação" da IA.
 *
 * Responsabilidades:
 *  - Persistir regras em data/directives.json (CRUD simples).
 *  - add(text, addedBy) — adiciona com validação (max 300 chars, max 30 items).
 *  - remove(id) — remove por ID.
 *  - all() — lista todas.
 *  - buildText() — injeta no prompt da IA com linguagem imperativa forte.
 *
 * Preservado byte-a-byte do index.js velho (funções 3515-3586).
 *
 * Sem cache em memória (diretivas mudam só via /educa e /deseduca, raro).
 * Cada operação lê/escreve direto no disco — simples e correto.
 */

import type { MarcioApp } from '../MarcioApp';
import fs from 'node:fs';

// ============================================================================
// CONSTS
// ============================================================================

const DIRECTIVE_MAX_LENGTH = 300;     // limite por diretiva (caracteres)
const DIRECTIVE_MAX_COUNT = 30;       // máximo de diretivas simultâneas

// ============================================================================
// TIPOS
// ============================================================================

export interface Directive {
  id: number;
  text: string;
  addedBy: string;
  addedAt: string;  // ISO
}

export type DirectiveList = Directive[];

export interface AddResult {
  ok: boolean;
  error?: string;
  directive?: Directive;
}

// ============================================================================
// DIRECTIVES
// ============================================================================

export class Directives {
  private app: MarcioApp;

  constructor(app: MarcioApp) {
    this.app = app;
  }

  // ===========================================================================
  // LOAD / SAVE
  // ===========================================================================

  /**
   * Carrega todas as diretivas de data/directives.json.
   * Sem cache — lê direto do disco a cada chamada (são poucas, muda raro).
   */
  load(): DirectiveList {
    try {
      return JSON.parse(fs.readFileSync(this.app.dataPath('directives.json'), 'utf8'));
    } catch {
      return [];
    }
  }

  /**
   * Salva a lista de diretivas em data/directives.json.
   */
  private save(list: DirectiveList): void {
    try {
      fs.writeFileSync(this.app.dataPath('directives.json'), JSON.stringify(list, null, 2), 'utf8');
    } catch (e) {
      this.app.debug('DIRECTIVE', `erro ao salvar diretivas: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // CRUD
  // ===========================================================================

  /**
   * Lista todas as diretivas (alias pra load()).
   * Usado pelos command handlers /educacao e /educa.
   */
  all(): DirectiveList {
    return this.load();
  }

  /**
   * Adiciona uma diretiva.
   *  - Valida: não vazia, max 300 chars, max 30 items.
   *  - ID = maior ID + 1 (ou 1 se vazio).
   *  - Salva imediatamente.
   *
   * @returns { ok, error?, directive? }
   */
  add(text: string, addedBy: string): AddResult {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: 'diretiva vazia.' };
    if (trimmed.length > DIRECTIVE_MAX_LENGTH) {
      return { ok: false, error: `diretiva muito longa (máx ${DIRECTIVE_MAX_LENGTH} caracteres).` };
    }
    const list = this.load();
    if (list.length >= DIRECTIVE_MAX_COUNT) {
      return { ok: false, error: `limite de ${DIRECTIVE_MAX_COUNT} diretivas atingido. Remova alguma antes.` };
    }
    const nextId = list.length > 0 ? Math.max(...list.map(d => d.id)) + 1 : 1;
    const directive: Directive = {
      id: nextId,
      text: trimmed,
      addedBy,
      addedAt: new Date().toISOString(),
    };
    list.push(directive);
    this.save(list);
    return { ok: true, directive };
  }

  /**
   * Remove uma diretiva pelo ID.
   * @returns true se removeu, false se não encontrou.
   */
  remove(id: number): boolean {
    const list = this.load();
    const index = list.findIndex(d => d.id === id);
    if (index === -1) return false;
    list.splice(index, 1);
    this.save(list);
    return true;
  }

  // ===========================================================================
  // BUILD TEXT (pra injetar no prompt da IA)
  // ===========================================================================

  /**
   * Monta o texto das diretivas pra injetar no contexto da IA.
   * Retorna '' se não houver diretivas.
   *
   * Usa linguagem imperativa forte ("VOCÊ DEVE") porque modelos pequenos
   * precisam de reforço pra seguir regras opcionais.
   */
  buildText(): string {
    const list = this.load();
    if (list.length === 0) return '';
    const lines = [
      '⚠️ REGRAS OBRIGATÓRIAS DO DONO (VOCÊ DEVE SEGUIR TODAS):',
      '',
    ];
    list.forEach(d => lines.push(`• ${d.text}`));
    lines.push('');
    lines.push('Estas regras são OBRIGATÓRIAS. Leia cada uma antes de responder.');
    return lines.join('\n');
  }
}
