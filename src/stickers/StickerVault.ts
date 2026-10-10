/**
 * StickerVault — vault de figurinhas + detecção de ondas/guerras.
 *
 * Responsabilidades:
 *  - Salvar toda figurinha recebida em data/stickers-vault/ (com dedup por hash)
 *  - loadStickerMeta / saveStickerMeta / setStickerMeta (data/stickers-meta.json)
 *  - findStickerByHash (procura por hash, com fallback de comparação de conteúdo)
 *  - getRandom / getRandomFavorite / getByName / listNamed
 *  - identify(msg) — identifica qual figurinha foi mandada (pra Context + Brain)
 *  - registerAndCheckWave / registerAndCheckWar — detecção de onda/guerra
 *  - handleIncoming(msg, chatId) — chamado pelo MessageRouter pra cada figurinha recebida
 *  - buildVaultInfo() — texto pro prompt da IA (lista de figurinhas disponíveis)
 *
 * Preservado byte-a-byte do index.js velho (linhas 3163-3494, 3208-3322, 3970-4036).
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import { MessageMedia } from 'whatsapp-web.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ============================================================================
// CONSTS (ondas/guerras)
// ============================================================================

const STICKER_WAVE_WINDOW_MS = 5 * 60 * 1000;
const STICKER_WAVE_MIN_DIFFERENT_SENDERS = 2;
const STICKER_WAVE_BOT_COOLDOWN_MS = 30 * 1000;

const STICKER_WAR_WINDOW_MS = 30 * 1000;
const STICKER_WAR_MIN_STICKERS = 3;
const STICKER_WAR_BOT_CHANCE = 0.50;
const STICKER_WAR_BOT_COOLDOWN_MS = 5 * 1000;

const VAULT_MAX_SIZE = 200;

// ============================================================================
// TIPOS
// ============================================================================

export interface StickerMeta {
  hash?: string;
  name?: string;
  favorite?: boolean;
  addedAt?: string;
  [key: string]: any;
}

export interface NamedSticker {
  filename: string;
  name: string | null;
  favorite: boolean;
}

export interface SaveResult {
  filename: string;
  isDuplicate: boolean;
}

export interface WaveResult {
  joinWave: boolean;
  hash: string | null;
  count: number;
}

interface WaveState {
  hash: string;
  senders: Set<string>;
  firstTs: number;
  lastTs: number;
  sentByBot: boolean;
  lastBotTs: number;
}

interface WarState {
  timestamps: number[];
  lastBotTs: number;
}

// ============================================================================
// STICKER VAULT
// ============================================================================

export class StickerVault {
  private app: MarcioApp;

  // Estado de ondas/guerras (em memória, por chat)
  private waveState = new Map<string, WaveState>();
  private warState = new Map<string, WarState>();

  constructor(app: MarcioApp) {
    this.app = app;
  }

  // ===========================================================================
  // VAULT DIR + META
  // ===========================================================================

  private get vaultDir(): string {
    return this.app.dataPath('stickers-vault');
  }

  ensureVaultDir(): void {
    try {
      if (!fs.existsSync(this.vaultDir)) {
        fs.mkdirSync(this.vaultDir, { recursive: true });
      }
    } catch (e) {
      this.app.debug('VAULT', `erro ao criar pasta: ${(e as Error).message}`);
    }
  }

  /**
   * Carrega os metadados das figurinhas (favoritas, nomes, hashes).
   * @returns Mapa filename → meta.
   */
  loadMeta(): Record<string, StickerMeta> {
    try {
      return JSON.parse(fs.readFileSync(this.app.dataPath('stickers-meta.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  /**
   * Salva os metadados das figurinhas.
   */
  saveMeta(meta: Record<string, StickerMeta>): void {
    fs.writeFileSync(this.app.dataPath('stickers-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  /**
   * Adiciona/atualiza metadados de uma figurinha (mescla com existentes).
   */
  setMeta(filename: string, patch: Partial<StickerMeta>): void {
    const meta = this.loadMeta();
    const existing = meta[filename] || {};
    meta[filename] = {
      ...existing,
      ...patch,
      addedAt: existing.addedAt || new Date().toISOString(),
    };
    this.saveMeta(meta);
  }

  /**
   * Remove metadados de uma figurinha.
   */
  removeMeta(filename: string): void {
    const meta = this.loadMeta();
    delete meta[filename];
    this.saveMeta(meta);
  }

  // ===========================================================================
  // HASH + FIND
  // ===========================================================================

  /**
   * Calcula o hash SHA-256 dos dados de uma mídia (base64).
   * Usado pra deduplicação — figurinhas idênticas geram o mesmo hash.
   */
  hashMediaData(base64Data: string): string | null {
    try {
      const buffer = Buffer.from(base64Data, 'base64');
      return crypto.createHash('sha256').update(buffer).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Procura no vault se já existe uma figurinha com o hash informado.
   * Primeiro procura nos metadados (rápido). Se não tem hash nos metadados,
   * compara o conteúdo dos arquivos (lento, fallback pra figurinhas antigas).
   *
   * @returns Nome do arquivo existente, ou null se não encontrou.
   */
  findStickerByHash(hash: string | null): string | null {
    if (!hash) return null;
    const meta = this.loadMeta();

    // Primeiro procura nos metadados (rápido)
    for (const [filename, m] of Object.entries(meta)) {
      if (m.hash === hash) {
        if (fs.existsSync(path.join(this.vaultDir, filename))) {
          return filename;
        }
      }
    }
    // Fallback: compara conteúdo dos arquivos (lento)
    try {
      this.ensureVaultDir();
      const files = fs.readdirSync(this.vaultDir).filter(f => /\.(webp|png|jpg)$/.test(f));
      for (const f of files) {
        try {
          const buffer = fs.readFileSync(path.join(this.vaultDir, f));
          const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
          if (fileHash === hash) {
            // Encontrou! Salva o hash nos metadados pra próxima busca ser rápida
            this.setMeta(f, { hash });
            return f;
          }
        } catch { /* ignora erro de arquivo individual */ }
      }
    } catch { /* ignora */ }
    return null;
  }

  // ===========================================================================
  // SAVE (com dedup + limpeza de antigas)
  // ===========================================================================

  /**
   * Salva uma figurinha recebida no vault. Remove as mais antigas se passar do limite.
   * FAZ DEDUPLICAÇÃO: se a figurinha já existe (mesmo conteúdo = mesmo hash),
   * não salva duplicada — retorna o nome do arquivo existente.
   *
   * @returns { filename, isDuplicate } ou null se falhou.
   */
  saveToVault(media: MessageMedia): SaveResult | null {
    try {
      this.ensureVaultDir();

      // Dedup por hash
      const hash = this.hashMediaData(media.data);
      const existing = this.findStickerByHash(hash);
      if (existing) {
        this.app.debug('VAULT', `figurinha duplicada ignorada — já existe: ${existing}`);
        return { filename: existing, isDuplicate: true };
      }

      const ext = media.mimetype === 'image/png' ? '.png'
                : media.mimetype === 'image/jpeg' ? '.jpg'
                : '.webp';
      const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filepath = path.join(this.vaultDir, filename);
      fs.writeFileSync(filepath, media.data, 'base64');

      // Salva o hash nos metadados
      this.setMeta(filename, { hash });

      this.app.debug('VAULT', `figurinha salva: ${filename} (hash: ${hash ? hash.slice(0, 8) : 'n/a'})`);

      // Limpa figurinhas antigas se passou do limite
      const files = fs.readdirSync(this.vaultDir)
        .filter(f => /\.(webp|png|jpg)$/.test(f))
        .sort();  // ordena por nome (timestamp crescente)
      if (files.length > VAULT_MAX_SIZE) {
        const toRemove = files.slice(0, files.length - VAULT_MAX_SIZE);
        const meta = this.loadMeta();
        let metaChanged = false;
        for (const f of toRemove) {
          try { fs.unlinkSync(path.join(this.vaultDir, f)); } catch { /* ignora */ }
          if (meta[f]) { delete meta[f]; metaChanged = true; }
        }
        if (metaChanged) this.saveMeta(meta);
        this.app.debug('VAULT', `limpeza: removeu ${toRemove.length} figurinha(s) antiga(s)`);
      }
      return { filename, isDuplicate: false };
    } catch (e) {
      this.app.debug('VAULT', `erro ao salvar: ${(e as Error).message}`);
      return null;
    }
  }

  // ===========================================================================
  // GET (aleatória, favorita, por nome, listar nomeadas)
  // ===========================================================================

  /**
   * Pega uma figurinha aleatória do vault.
   * @returns Caminho do arquivo ou null se vazio.
   */
  getRandom(): string | null {
    try {
      this.ensureVaultDir();
      const files = fs.readdirSync(this.vaultDir).filter(f => /\.(webp|png|jpg)$/.test(f));
      if (files.length === 0) return null;
      const random = files[Math.floor(Math.random() * files.length)];
      return path.join(this.vaultDir, random);
    } catch (e) {
      this.app.debug('VAULT', `erro ao pegar aleatória: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Pega uma figurinha favorita aleatória.
   * @returns Caminho ou null se não houver favoritas.
   */
  getRandomFavorite(): string | null {
    try {
      const meta = this.loadMeta();
      const favorites = Object.entries(meta)
        .filter(([, m]) => m.favorite)
        .map(([filename]) => filename)
        .filter(f => fs.existsSync(path.join(this.vaultDir, f)));
      if (favorites.length === 0) return null;
      const random = favorites[Math.floor(Math.random() * favorites.length)];
      return path.join(this.vaultDir, random);
    } catch (e) {
      this.app.debug('VAULT', `erro ao pegar favorita: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Pega uma figurinha pelo nome (definido por um op via /fig nome).
   * @returns Caminho ou null se não encontrar.
   */
  getByName(name: string): string | null {
    try {
      const meta = this.loadMeta();
      const normalizedName = name.toLowerCase().trim();
      const entry = Object.entries(meta).find(([, m]) => m.name && m.name.toLowerCase() === normalizedName);
      if (!entry) return null;
      const filepath = path.join(this.vaultDir, entry[0]);
      return fs.existsSync(filepath) ? filepath : null;
    } catch (e) {
      this.app.debug('VAULT', `erro ao buscar por nome: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Lista as figurinhas nomeadas e/ou favoritas.
   * @returns Array de { filename, name, favorite }.
   */
  listNamed(): NamedSticker[] {
    const meta = this.loadMeta();
    return Object.entries(meta)
      .filter(([, m]) => m.name || m.favorite)
      .map(([filename, m]) => ({
        filename,
        name: m.name || null,
        favorite: !!m.favorite,
      }))
      .filter(s => fs.existsSync(path.join(this.vaultDir, s.filename)));
  }

  // ===========================================================================
  // IDENTIFY — usado pelo Context.captureMessage e Brain.maybeAutoRespond
  // ===========================================================================

  /**
   * Identifica qual figurinha foi mandada (busca por hash no vault).
   * @returns { name, favorite, filename } ou null se não conseguiu identificar.
   */
  async identify(msg: Message): Promise<{ name: string | null; favorite: boolean; filename: string } | null> {
    try {
      const media = await msg.downloadMedia();
      if (!media || !media.data) return null;
      const hash = this.hashMediaData(media.data);
      const filename = this.findStickerByHash(hash);
      if (!filename) return null;
      const meta = this.loadMeta();
      const stickerMeta = meta[filename];
      if (stickerMeta) {
        return {
          name: stickerMeta.name || null,
          favorite: !!stickerMeta.favorite,
          filename,
        };
      }
      return { name: null, favorite: false, filename };
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // BUILD VAULT INFO — texto pro prompt da IA
  // ===========================================================================

  /**
   * Monta o texto com a lista de figurinhas disponíveis no vault.
   * Injetado no prompt da IA (em generateResponse) pra ela saber quais pode usar.
   * Retorna null se o vault estiver vazio.
   */
  buildVaultInfo(): string | null {
    this.ensureVaultDir();
    let totalStickers = 0;
    try {
      totalStickers = fs.readdirSync(this.vaultDir)
        .filter(f => /\.(webp|png|jpg)$/.test(f)).length;
    } catch { /* ignora */ }
    if (totalStickers === 0) return null;

    const named = this.listNamed();
    const lines = [`FIGURINHAS DISPONÍVEIS NO VAULT: ${totalStickers} figurinha(s) salva(s).`];

    const favorites = named.filter(s => s.favorite);
    if (favorites.length > 0) {
      lines.push(`- [FIGURINHA: fav] → uma das ${favorites.length} figurinhas favoritas`);
    }

    const namedStickers = named.filter(s => s.name);
    if (namedStickers.length > 0) {
      lines.push('');
      lines.push('FIGURINHAS COM NOME (escolha pelo nome quando fizer sentido com o contexto):');
      namedStickers.forEach(s => {
        const mark = s.favorite ? ' ⭐' : '';
        lines.push(`- [FIGURINHA: ${s.name}]${mark} → use quando a conversa combinar com "${s.name}"`);
      });
    }

    lines.push('');
    lines.push('- [FIGURINHA] → uma figurinha aleatória do vault (use quando não tiver uma nomeada que combine)');
    lines.push('');
    lines.push('COMO ESCOLHER FIGURINHA:');
    lines.push('- LEIA o nome de cada figurinha nomeada e pense: "essa combina com o que acabou de ser dito?"');
    lines.push('- Se sim, use [FIGURINHA: nome] (específica). Ex.: se a conversa foi engraçada e existe "risada", use [FIGURINHA: risada]');
    lines.push('- Se nenhuma nomeada combina, use [FIGURINHA] (aleatória) ou só texto.');
    lines.push('- Não force uso — só use figurinha se realmente agregar à resposta.');
    lines.push('');
    lines.push('USE FIGURINHA quando fizer sentido: reação a algo engraçado, resposta a outra figurinha, drama, etc. Não tenha medo de usar — é natural no WhatsApp.');
    return lines.join('\n');
  }

  // ===========================================================================
  // HANDLE INCOMING — chamado pelo MessageRouter pra cada figurinha recebida
  // ===========================================================================

  /**
   * Processa uma figurinha recebida:
   *  1. Salva no vault (com dedup)
   *  2. Se IA ativa no chat: detecta onda (2+ pessoas mesma figurinha) → bot entra
   *  3. Se IA ativa no chat: detecta guerra (3+ figurinhas em 30s) → bot entra (50% chance)
   *
   * Preservado byte-a-byte do bloco 3970-4036 do index.js velho.
   */
  async handleIncoming(msg: Message, chatId: string): Promise<void> {
    if (msg.fromMe) return;
    if (!msg.hasMedia || msg.type !== 'sticker') return;

    try {
      const media = await msg.downloadMedia();
      if (!media || !media.data) return;

      // Sempre salva no vault (mesmo com IA desligada — pra ter figurinha quando ligar)
      this.saveToVault(media);

      // Onda e guerra só funcionam se a IA não tá desligada/mutada neste chat
      const aiActiveHere = !!this.app.aiConfig?.enabled &&
                          !this.app.brain.aiDisabledChats.has(chatId) &&
                          !this.app.brain.democraticallyMutedChats.has(chatId);

      if (!aiActiveHere) return;

      // Pega o nome de quem mandou
      let senderName = 'Alguém';
      try {
        const contact = await msg.getContact();
        senderName = contact.pushname || contact.name || contact.shortName || 'Alguém';
      } catch { /* ignora */ }

      // Verifica onda (2+ pessoas mandando a mesma figurinha)
      const wave = this.registerAndCheckWave(chatId, media.data, senderName);
      if (wave.joinWave && wave.hash) {
        const filename = this.findStickerByHash(wave.hash);
        if (filename) {
          const stickerPath = path.join(this.vaultDir, filename);
          try {
            const waveMedia = MessageMedia.fromFilePath(stickerPath);
            await this.app.whatsapp.client.sendMessage(chatId, waveMedia, { sendMediaAsSticker: true });
            this.app.debug('WAVE', `bot entrou na onda — mandou ${filename} em ${chatId}`);
            this.app.log('WAVE', `Bot entrou em onda de figurinha (${wave.count} pessoas) em ${chatId}.`);
          } catch (e) {
            this.app.debug('WAVE', `erro ao entrar na onda: ${(e as Error).message}`);
          }
        }
      }

      // Verifica guerra (3+ figurinhas em 30s, mesmo diferentes)
      const shouldJoinWar = this.registerAndCheckWar(chatId);
      if (shouldJoinWar) {
        let warStickerPath = this.getRandomFavorite();
        if (!warStickerPath) {
          warStickerPath = this.getRandom();
        }
        if (warStickerPath) {
          try {
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
            const warMedia = MessageMedia.fromFilePath(warStickerPath);
            await this.app.whatsapp.client.sendMessage(chatId, warMedia, { sendMediaAsSticker: true });
            this.app.debug('WAR', `bot entrou na guerra — mandou ${path.basename(warStickerPath)} em ${chatId}`);
            this.app.log('WAR', `Bot entrou em guerra de figurinha em ${chatId}.`);
          } catch (e) {
            this.app.debug('WAR', `erro ao entrar na guerra: ${(e as Error).message}`);
          }
        }
      }
    } catch (e) {
      this.app.debug('VAULT', `erro ao baixar figurinha: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // WAVE DETECTION (2+ pessoas mandando a mesma figurinha)
  // ===========================================================================

  /**
   * Registra uma figurinha recebida e detecta se virou "onda".
   * Se virou onda (2+ pessoas diferentes, mesma figurinha, dentro de 5min),
   * retorna { joinWave: true, hash, count }.
   */
  registerAndCheckWave(chatId: string, mediaBase64: string, senderName: string): WaveResult {
    const hash = this.hashMediaData(mediaBase64);
    if (!hash) return { joinWave: false, hash: null, count: 0 };

    const now = Date.now();
    if (!this.waveState.has(chatId)) {
      this.waveState.set(chatId, {
        hash, senders: new Set([senderName]), firstTs: now, lastTs: now,
        sentByBot: false, lastBotTs: 0,
      });
    }

    const state = this.waveState.get(chatId)!;

    // Se mudou o hash OU passou da janela, reseta
    if (state.hash !== hash || (now - state.lastTs) > STICKER_WAVE_WINDOW_MS) {
      state.hash = hash;
      state.senders = new Set([senderName]);
      state.firstTs = now;
      state.lastTs = now;
      state.sentByBot = false;
      state.lastBotTs = state.lastBotTs || 0;
      return { joinWave: false, hash, count: 1 };
    }

    // Mesma figurinha dentro da janela — incrementa
    state.senders.add(senderName);
    state.lastTs = now;
    const count = state.senders.size;

    if (count >= STICKER_WAVE_MIN_DIFFERENT_SENDERS && !state.sentByBot) {
      if (now - state.lastBotTs > STICKER_WAVE_BOT_COOLDOWN_MS) {
        state.sentByBot = true;
        state.lastBotTs = now;
        this.app.debug('WAVE', `onda detectada em ${chatId}: ${count} pessoas mandaram a mesma figurinha — bot vai entrar`);
        return { joinWave: true, hash, count };
      }
    }
    return { joinWave: false, hash, count };
  }

  // ===========================================================================
  // WAR DETECTION (3+ figurinhas em 30s, mesmo diferentes)
  // ===========================================================================

  /**
   * Registra uma figurinha recebida e detecta se virou "guerra".
   * Se virou guerra (3+ figurinhas em 30s) e o bot deve participar (50% chance,
   * respeitando cooldown de 5s), retorna true.
   */
  registerAndCheckWar(chatId: string): boolean {
    const now = Date.now();
    if (!this.warState.has(chatId)) {
      this.warState.set(chatId, { timestamps: [], lastBotTs: 0 });
    }
    const state = this.warState.get(chatId)!;

    state.timestamps.push(now);
    state.timestamps = state.timestamps.filter(ts => (now - ts) < STICKER_WAR_WINDOW_MS);

    if (state.timestamps.length >= STICKER_WAR_MIN_STICKERS) {
      if (now - state.lastBotTs < STICKER_WAR_BOT_COOLDOWN_MS) {
        return false;
      }
      if (Math.random() <= STICKER_WAR_BOT_CHANCE) {
        state.lastBotTs = now;
        this.app.debug('WAR', `guerra de figurinha detectada em ${chatId} — ${state.timestamps.length} figurinhas em ${STICKER_WAR_WINDOW_MS / 1000}s — bot vai mandar uma`);
        return true;
      }
    }
    return false;
  }
}
