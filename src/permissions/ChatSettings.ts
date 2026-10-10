/**
 * ChatSettings — persiste configurações por chat (IA, entrosão, mute).
 *
 * Antes essas configs eram só em memória (Set/Map no Brain) — perdiam no restart.
 * Agora persistem em data/chat-settings.json e são carregadas no boot.
 *
 * O Brain continua com os Set/Map em memória (pra performance), mas o
 * ChatSettings espelha pra disco.
 *
 * Formato (data/chat-settings.json):
 *   {
 *     "120363xxx@g.us": { "aiEnabled": false, "entrosao": 2, "muted": false },
 *     "55219xxx@c.us": { "aiEnabled": true, "entrosao": 1, "muted": true }
 *   }
 */

import type { MarcioApp } from '../MarcioApp';
import fs from 'node:fs';

// ============================================================================
// TIPOS
// ============================================================================

export interface ChatSetting {
  /** IA ativada neste chat (default: true). */
  aiEnabled: boolean;
  /** Nível de entrosão 0-2 (default: 1). 0=quieto, 1=normal, 2=2x participativo. */
  entrosao: number;
  /** Bot mutado democraticamente (default: false). */
  muted: boolean;
}

export type ChatSettingsData = Record<string, ChatSetting>;

// ============================================================================
// CHAT SETTINGS
// ============================================================================

export class ChatSettings {
  private app: MarcioApp;
  private cache: ChatSettingsData | null = null;

  constructor(app: MarcioApp) {
    this.app = app;
  }

  // ===========================================================================
  // LOAD / SAVE
  // ===========================================================================

  private load(): ChatSettingsData {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.app.dataPath('chat-settings.json'), 'utf8'));
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  private save(): void {
    try {
      fs.writeFileSync(this.app.dataPath('chat-settings.json'), JSON.stringify(this.cache, null, 2), 'utf8');
    } catch (e) {
      this.app.debug('SETTINGS', `erro ao salvar chat-settings: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // GET / SET
  // ===========================================================================

  /**
   * Retorna as settings de um chat (com defaults se não existir).
   */
  get(chatId: string): ChatSetting {
    const data = this.load();
    return data[chatId] || { aiEnabled: true, entrosao: 1, muted: false };
  }

  /**
   * Atualiza uma setting parcial de um chat.
   */
  update(chatId: string, patch: Partial<ChatSetting>): void {
    const data = this.load();
    const current = data[chatId] || { aiEnabled: true, entrosao: 1, muted: false };
    data[chatId] = { ...current, ...patch };
    this.save();
  }

  /**
   * Lista todos os chats que têm settings customizadas.
   */
  allChatIds(): string[] {
    return Object.keys(this.load());
  }

  /**
   * Carrega todas as settings pro Brain (no boot).
   * Popula aiDisabledChats, chatEntrosaoLevel, democraticallyMutedChats.
   */
  loadIntoBrain(): void {
    const data = this.load();
    for (const [chatId, setting] of Object.entries(data)) {
      if (!setting.aiEnabled) {
        this.app.brain.aiDisabledChats.add(chatId);
      }
      if (setting.entrosao !== 1) {
        this.app.brain.chatEntrosaoLevel.set(chatId, setting.entrosao);
      }
      if (setting.muted) {
        this.app.brain.democraticallyMutedChats.add(chatId);
      }
    }
    this.app.debug('SETTINGS', `carregadas ${Object.keys(data).length} chat(s) com settings customizadas`);
  }

  // === Conveniência pra sync com Brain ===

  setAiEnabled(chatId: string, enabled: boolean): void {
    this.update(chatId, { aiEnabled: enabled });
    if (enabled) {
      this.app.brain.aiDisabledChats.delete(chatId);
    } else {
      this.app.brain.aiDisabledChats.add(chatId);
    }
  }

  setEntrosao(chatId: string, level: number): void {
    // Valida 0-2, converte pra float (pra multiplicar chance)
    const safe = Math.max(0, Math.min(2, Math.floor(level) || 1));
    this.update(chatId, { entrosao: safe });
    this.app.brain.chatEntrosaoLevel.set(chatId, safe);
  }

  setMuted(chatId: string, muted: boolean): void {
    this.update(chatId, { muted });
    if (muted) {
      this.app.brain.democraticallyMutedChats.add(chatId);
    } else {
      this.app.brain.democraticallyMutedChats.delete(chatId);
    }
  }
}
