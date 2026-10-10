/**
 * PermissionSystem — ops + banidos + resolveSenderIds.
 *
 * Responsabilidades:
 *  - loadOps/saveOps — persiste em data/ops.json
 *  - loadBanned/saveBanned — persiste em data/banned.json
 *  - isOp(isFromMe, userIds) — bot é sempre op; INITIAL_OPS + ops.json
 *  - isBanned(userIds) — banned.json
 *  - resolveSenderIds(msg) — retorna { lid, phone, all } (LID + telefone resolvido)
 *  - resolveTarget(msg) — pra !ban/!unban (quoted ou número no comando)
 *  - normalizeUserId(input) — "551199..." → "551199...@c.us"
 *
 * Preservado byte-a-byte do index.js velho (linhas 396-562, 427-455, 574+).
 *
 * Formato dos arquivos (preservado):
 *   [{ lid: "155...@lid", phone: "155...@c.us", addedAt: "ISO" }, ...]
 *   Suporta legacy (array de strings) — migra automaticamente no load.
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import fs from 'node:fs';

// ============================================================================
// TIPOS
// ============================================================================

export interface UserEntry {
  lid: string | null;
  phone: string | null;
  addedAt: string | null;
}

export interface ResolvedSender {
  lid: string | null;
  phone: string | null;
  all: string[];
}

// ============================================================================
// PERMISSION SYSTEM
// ============================================================================

export class PermissionSystem {
  private app: MarcioApp;

  /** Ops iniciais hardcoded (configurados no código). Vazio por padrão. */
  readonly initialOps: string[] = [];

  constructor(app: MarcioApp) {
    this.app = app;
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /** Extrai só dígitos de um ID (pra comparação robusta LID vs telefone). */
  digitsOnly(id: string): string {
    return String(id || '').replace(/\D/g, '');
  }

  /**
   * Normaliza um número de telefone (apenas dígitos) para o formato de ID do WhatsApp.
   * Ex.: "5511999999999" → "5511999999999@c.us"
   */
  normalizeUserId(input: string): string | null {
    const digits = input.replace(/\D/g, '');
    if (!digits) return null;
    return digits.includes('@') ? input : `${digits}@c.us`;
  }

  // ===========================================================================
  // OPS
  // ===========================================================================

  /**
   * Carrega a lista de ops de data/ops.json.
   * Suporta formato legacy (array de strings) — migra automaticamente.
   */
  loadOps(): UserEntry[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.app.dataPath('ops.json'), 'utf8'));
      return raw.map((entry: any): UserEntry => {
        if (typeof entry === 'string') {
          const isLid = entry.includes('@lid');
          return { lid: isLid ? entry : null, phone: isLid ? null : entry, addedAt: null };
        }
        return { lid: entry.lid || null, phone: entry.phone || null, addedAt: entry.addedAt || null };
      });
    } catch {
      return [];
    }
  }

  /**
   * Salva a lista de ops em data/ops.json.
   */
  saveOps(list: UserEntry[]): void {
    fs.writeFileSync(this.app.dataPath('ops.json'), JSON.stringify(list, null, 2), 'utf8');
  }

  /**
   * Adiciona um op. Retorna true se adicionou, false se já era op.
   */
  addOp(lid: string | null, phone: string | null): boolean {
    const list = this.loadOps();
    // Checa se já existe (por dígitos)
    const newDigits = [lid, phone].filter(Boolean).map(d => this.digitsOnly(d as string));
    const exists = list.some(entry =>
      [entry.lid, entry.phone].filter(Boolean).some(d =>
        newDigits.includes(this.digitsOnly(d as string))
      )
    );
    if (exists) return false;
    list.push({ lid, phone, addedAt: new Date().toISOString() });
    this.saveOps(list);
    return true;
  }

  /**
   * Remove um op. Retorna true se removeu, false se não era op.
   */
  removeOp(lid: string | null, phone: string | null): boolean {
    const list = this.loadOps();
    const targetDigits = [lid, phone].filter(Boolean).map(d => this.digitsOnly(d as string));
    const newList = list.filter(entry =>
      ![entry.lid, entry.phone].filter(Boolean).some(d =>
        targetDigits.includes(this.digitsOnly(d as string))
      )
    );
    if (newList.length === list.length) return false;
    this.saveOps(newList);
    return true;
  }

  /**
   * Verifica se algum dos IDs informados corresponde a um op.
   * Considera: bot (msg.fromMe), INITIAL_OPS (config) e ops persistidos.
   */
  isOp(isFromMe: boolean, userIds: string[]): boolean {
    if (isFromMe) return true;  // o próprio bot é sempre op
    const userDigits = userIds.map(u => this.digitsOnly(u)).filter(Boolean);
    const check = (entry: UserEntry) =>
      [entry.lid, entry.phone].filter(Boolean).map(d => this.digitsOnly(d as string)).some(d => userDigits.includes(d));
    const found = this.initialOps.some(o => userDigits.includes(this.digitsOnly(o))) ||
                  this.loadOps().some(check);
    this.app.debug('OP-CHECK', `userIds=${JSON.stringify(userIds)} | isFromMe=${isFromMe} | resultado=${found}`);
    return found;
  }

  // ===========================================================================
  // BANNED
  // ===========================================================================

  /**
   * Carrega a lista de banidos de data/banned.json.
   * Suporta formato legacy (array de strings).
   */
  loadBanned(): UserEntry[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.app.dataPath('banned.json'), 'utf8'));
      return raw.map((entry: any): UserEntry => {
        if (typeof entry === 'string') {
          const isLid = entry.includes('@lid');
          return { lid: isLid ? entry : null, phone: isLid ? null : entry, addedAt: null };
        }
        return { lid: entry.lid || null, phone: entry.phone || null, addedAt: entry.addedAt || null };
      });
    } catch {
      return [];
    }
  }

  /**
   * Salva a lista de banidos em data/banned.json.
   */
  saveBanned(list: UserEntry[]): void {
    fs.writeFileSync(this.app.dataPath('banned.json'), JSON.stringify(list, null, 2), 'utf8');
  }

  /**
   * Verifica se algum dos IDs informados corresponde a um usuário banido.
   * Compara tanto o LID quanto o telefone (por dígitos).
   */
  isBanned(userIds: string[]): boolean {
    const banned = this.loadBanned();
    const userDigits = userIds.map(u => this.digitsOnly(u)).filter(Boolean);
    const found = banned.some(entry => {
      const entryDigits = [entry.lid, entry.phone].filter(Boolean).map(d => this.digitsOnly(d as string));
      return entryDigits.some(d => userDigits.includes(d));
    });
    this.app.debug('BAN-CHECK', `userIds=${JSON.stringify(userIds)} | banidos=${banned.length} | resultado=${found}`);
    return found;
  }

  /**
   * Adiciona um banido. Retorna true se adicionou, false se já era banido.
   */
  addBanned(lid: string | null, phone: string | null): boolean {
    const list = this.loadBanned();
    const newDigits = [lid, phone].filter(Boolean).map(d => this.digitsOnly(d as string));
    const exists = list.some(entry =>
      [entry.lid, entry.phone].filter(Boolean).some(d =>
        newDigits.includes(this.digitsOnly(d as string))
      )
    );
    if (exists) return false;
    list.push({ lid, phone, addedAt: new Date().toISOString() });
    this.saveBanned(list);
    return true;
  }

  /**
   * Remove um banido. Retorna true se removeu, false se não era banido.
   */
  removeBanned(lid: string | null, phone: string | null): boolean {
    const list = this.loadBanned();
    const targetDigits = [lid, phone].filter(Boolean).map(d => this.digitsOnly(d as string));
    const newList = list.filter(entry =>
      ![entry.lid, entry.phone].filter(Boolean).some(d =>
        targetDigits.includes(this.digitsOnly(d as string))
      )
    );
    if (newList.length === list.length) return false;
    this.saveBanned(newList);
    return true;
  }

  // ===========================================================================
  // RESOLVE SENDER (LID + telefone)
  // ===========================================================================

  /**
   * Retorna TODOS os IDs possíveis de quem enviou a mensagem: o LID (em grupo)
   * e o número de telefone (@c.us, resolvido via getContact).
   *
   * @returns { lid, phone, all }
   */
  async resolveSenderIds(msg: Message): Promise<ResolvedSender> {
    const lid = (msg as any).author || null;   // Em grupo vem o LID
    const fromId = msg.from || null;            // Em PV é o @c.us

    let phone: string | null = null;
    if (fromId && fromId.includes('@c.us')) {
      phone = fromId;
    }

    // Tenta resolver LID → telefone via getContact
    try {
      const contact = await msg.getContact();
      if (contact && contact.number) {
        phone = `${contact.number}@c.us`;
      }
    } catch (e) {
      this.app.debug('SENDER', `não foi possível obter contato de ${lid || fromId}: ${(e as Error).message}`);
    }

    const all = [...new Set([lid, phone, fromId].filter(Boolean) as string[])];
    this.app.debug('SENDER', `resolveSenderIds | lid=${lid} | phone=${phone} | fromId=${fromId} | all=${JSON.stringify(all)}`);
    return { lid, phone, all };
  }

  /**
   * Resolve o alvo de um comando de dono (!ban / !unban), retornando tanto o
   * LID quanto o telefone quando possível.
   *
   * Prioridade:
   *   1. Mensagem respondida (quoted) — pega LID e tenta resolver telefone
   *   2. Número informado no comando (ex.: !ban 5511999999999) — só telefone
   *
   * @returns { lid, phone } ou null se não conseguiu resolver.
   */
  async resolveTarget(msg: Message): Promise<{ lid: string | null; phone: string | null } | null> {
    this.app.debug('TARGET', `hasQuotedMsg=${msg.hasQuotedMsg} | body="${msg.body}"`);

    // 1. Tentativa via mensagem respondida
    if (msg.hasQuotedMsg) {
      try {
        const quoted = await msg.getQuotedMessage();
        const quotedAuthor = quoted.author || quoted.from;
        let quotedPhone: string | null = null;
        try {
          const contact = await quoted.getContact();
          if (contact && contact.number) {
            quotedPhone = `${contact.number}@c.us`;
          }
        } catch { /* ignora */ }
        if (quotedAuthor || quotedPhone) {
          const isLid = quotedAuthor && quotedAuthor.includes('@lid');
          return {
            lid: isLid ? quotedAuthor : null,
            phone: quotedPhone || (!isLid ? quotedAuthor : null),
          };
        }
      } catch (e) {
        this.app.debug('TARGET', `erro ao resolver quoted: ${(e as Error).message}`);
      }
    }

    // 2. Tentativa via número no comando
    const parts = msg.body.trim().split(/\s+/);
    const arg = parts[1] || '';
    const normalized = this.normalizeUserId(arg);
    if (normalized) {
      return { lid: null, phone: normalized };
    }

    return null;
  }
}
