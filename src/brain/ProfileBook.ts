/**
 * ProfileBook — perfis permanentes gerados por IA (pessoas + grupos).
 *
 * Substitui a extração keyword-based do Memory.ts por uma abordagem
 * baseada em IA que lê as conversas e monta perfis ricos.
 *
 * === COMO FUNCIONA ===
 *  1. A cada N mensagens de uma pessoa num chat, o ProfileBook dispara
 *     uma atualização: pega as últimas M mensagens dessa pessoa + o
 *     perfil atual, manda pra IA, e atualiza o perfil com a resposta.
 *  2. O perfil é GLOBAL (cross-chat) — key = WhatsApp ID (lid/@c.us/@g.us).
 *  3. A IA decide como organizar: traits (key-value), summary, shortView.
 *  4. Grupos também têm perfil — captura a "vibe" do grupo.
 *  5. Persiste em data/profile-book.json.
 *
 * === MIGRAÇÃO ===
 *  migrateFromOldMemories() lê memories.json (userName → facts[]),
 *  tenta resolver userName → WhatsApp ID via getContact, e cria
 *  perfis iniciais com os facts como traits.
 *
 * === FORMATO (data/profile-book.json) ===
 *  {
 *    "5511989744468@c.us": {
 *      id, type: 'person', name, photoUrl, interactionCount,
 *      dataPoints, aiSummary, aiShortView, traits: {}, rawNotes,
 *      firstSeen, lastUpdated, lastAIUpdate, messageCountSinceUpdate
 *    },
 *    "groupId@g.us": { type: 'group', ... }
 *  }
 */

import type { MarcioApp } from '../MarcioApp';
import fs from 'node:fs';

// ============================================================================
// TIPOS
// ============================================================================

export type EntityType = 'person' | 'group';

export interface EntityProfile {
  /** WhatsApp ID CANONICAL (5511989744468@c.us, groupId@g.us, ou lid). */
  id: string;
  type: EntityType;
  name: string;
  /** URL da foto de perfil (cacheada, refresh periódico). */
  photoUrl?: string;
  /** IDs alternativos que referenciam a mesma entidade (ex: @lid ↔ @c.us). */
  aliases: string[];
  /** Qtde total de mensagens dessa entidade que o bot viu. */
  interactionCount: number;
  /** Qtde de "data points" (traits) coletados. */
  dataPoints: number;
  /** Resumo de 2-3 frases do que a IA pensa dessa pessoa/grupo. */
  aiSummary: string;
  /** Resumo ultra-curto — poucas palavras separadas por vírgula. */
  aiShortView: string;
  /** Traits key-value que a IA gerencia (ex: { "time": "corintians", "idade": "22" }). */
  traits: Record<string, string>;
  /** Notas livres que a IA pode escrever (contexto adicional). */
  rawNotes: string;
  /** ISO timestamp da primeira vez que vimos essa entidade. */
  firstSeen: string;
  /** ISO timestamp da última atualização (manual ou IA). */
  lastUpdated: string | null;
  /** ISO timestamp da última atualização pela IA. */
  lastAIUpdate: string | null;
  /** Contador de msgs desde a última atualização IA — dispara update at threshold. */
  messageCountSinceUpdate: number;
}

export type ProfilesData = Record<string, EntityProfile>;

// ============================================================================
// CONSTS
// ============================================================================

/** Dispara atualização IA a cada N mensagens da entidade. */
const UPDATE_THRESHOLD = 15;
/** Quantas mensagens recentes enviar pra IA no update. */
const RECENT_MSGS_FOR_AI = 20;
/** Max traits por perfil (pra não crescer infinito). */
const MAX_TRAITS = 30;

// ============================================================================
// PROFILEBOOK
// ============================================================================

export class ProfileBook {
  private app: MarcioApp;
  private cache: ProfilesData | null = null;
  private dirty = false;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  /** Mapa de ID alternativo → ID canonical. Construído no load(). */
  private aliasMap = new Map<string, string>();
  /** Timer de varredura periódica pra atualizar perfis stale. */
  private autoUpdateTimer: NodeJS.Timeout | null = null;

  constructor(app: MarcioApp) {
    this.app = app;
    // Auto-save a cada 30s se dirty
    this.autoSaveTimer = setInterval(() => {
      if (this.dirty) this.save();
    }, 30000);
  }

  /**
   * Inicia varredura periódica de perfis. A cada 30min, procura perfis que:
   *  - Não foram atualizados pela IA há mais de 1h
   *  - Têm interactionCount > 0
   * E dispara updateProfileWithAI neles.
   *
   * Isso garante que perfis são mantidos atualizados mesmo sem atingir o
   * threshold de 15 msgs (ex: pessoa que manda 5 msgs e para).
   */
  startAutoUpdateTimer(): void {
    if (this.autoUpdateTimer) clearInterval(this.autoUpdateTimer);
    const INTERVAL = 30 * 60 * 1000; // 30min
    const STALE_THRESHOLD = 60 * 60 * 1000; // 1h sem update IA
    this.autoUpdateTimer = setInterval(() => {
      this.runAutoUpdateSweep(STALE_THRESHOLD).catch(e => {
        this.app.debug('PROFILES', `erro no auto-update sweep: ${(e as Error).message}`);
      });
    }, INTERVAL);
    this.app.debug('PROFILES', `auto-update timer iniciado (a cada 30min, stale > 1h)`);
  }

  /**
   * Varredura: atualiza perfis stale. Roda a cada 30min.
   * Limita a 5 perfis por sweep pra não sobrecarregar a IA.
   */
  private async runAutoUpdateSweep(staleThresholdMs: number): Promise<void> {
    const data = this.load();
    const now = Date.now();
    const stale: string[] = [];
    for (const [id, profile] of Object.entries(data)) {
      if (profile.type !== 'person') continue;
      if (profile.interactionCount < 3) continue; // precisa de mínimo de dados
      const lastUpdate = profile.lastAIUpdate ? new Date(profile.lastAIUpdate).getTime() : 0;
      if (now - lastUpdate < staleThresholdMs) continue; // não é stale
      stale.push(id);
      if (stale.length >= 5) break; // limita a 5 por sweep
    }
    if (stale.length === 0) return;
    this.app.debug('PROFILES', `auto-update sweep: ${stale.length} perfil(is) stale — atualizando...`);
    for (const id of stale) {
      try {
        await this.updateProfileWithAI(id);
      } catch (e) {
        this.app.debug('PROFILES', `auto-update falhou pra ${id}: ${(e as Error).message}`);
      }
    }
  }

  // ===========================================================================
  // ALIAS MAP — resolve @lid ↔ @c.us para a mesma pessoa
  // ===========================================================================

  /**
   * Resolve qualquer ID para o ID canonical (ou retorna o mesmo se não tem alias).
   * Usa o aliasMap pra encontrar o perfil real.
   */
  resolveId(id: string): string {
    return this.aliasMap.get(id) || id;
  }

  /**
   * Linka dois IDs ao mesmo perfil. O primeiro vira o canonical.
   * Adiciona o segundo como alias do perfil do primeiro.
   */
  linkIds(canonicalId: string, aliasId: string, reason?: string): boolean {
    if (canonicalId === aliasId) return false;
    const data = this.load();
    const profile = data[canonicalId];
    if (!profile) {
      this.app.debug('PROFILES', `linkIds: perfil canonical ${canonicalId} não existe`);
      return false;
    }
    if (!profile.aliases) profile.aliases = [];
    if (!profile.aliases.includes(aliasId)) {
      profile.aliases.push(aliasId);
      this.dirty = true;
    }
    this.aliasMap.set(aliasId, canonicalId);
    // Se o alias tinha um perfil próprio, merge seus dados no canonical e remove
    const aliasProfile = data[aliasId];
    if (aliasProfile) {
      this.mergeProfiles(canonicalId, aliasId);
      delete data[aliasId];
      this.dirty = true;
    }
    this.app.log('PROFILES', `IDs linkados: ${aliasId} → ${canonicalId}${reason ? ` (${reason})` : ''}`);
    if (this.dirty) this.save();
    return true;
  }

  /**
   * Merge dados de um perfil (source) em outro (target).
   * Soma interactionCount, merge traits, concatena notes.
   */
  private mergeProfiles(targetId: string, sourceId: string): void {
    const data = this.load();
    const target = data[targetId];
    const source = data[sourceId];
    if (!target || !source) return;
    target.interactionCount += source.interactionCount || 0;
    // Merge traits (source sobrescreve se conflitar? não — só adiciona novos)
    for (const [k, v] of Object.entries(source.traits || {})) {
      if (!target.traits[k]) target.traits[k] = v;
    }
    target.dataPoints = Object.keys(target.traits).length;
    // Merge aliases
    if (!target.aliases) target.aliases = [];
    if (source.aliases) {
      for (const a of source.aliases) {
        if (!target.aliases.includes(a)) target.aliases.push(a);
        this.aliasMap.set(a, targetId);
      }
    }
    // Merge notes
    if (source.rawNotes) {
      target.rawNotes = (target.rawNotes || '') + `\n[Merged from ${sourceId}]: ${source.rawNotes}`;
    }
    // Merge summary (usa o source se target não tem)
    if (!target.aiSummary && source.aiSummary) target.aiSummary = source.aiSummary;
    if (!target.aiShortView && source.aiShortView) target.aiShortView = source.aiShortView;
    // Foto: usa a do source se target não tem
    if (!target.photoUrl && source.photoUrl) target.photoUrl = source.photoUrl;
    this.dirty = true;
  }

  /**
   * Tenta auto-linkar um ID com perfis existentes baseado em nome + foto.
   * Chamado quando um novo perfil é criado.
   *
   * Estratégia:
   * 1. Se é @lid, busca @c.us com mesmo nome. Se a foto bate, linka.
   * 2. Se é @c.us, busca @lid com mesmo nome. Se a foto bate, linka.
   * 3. Se tem nome idêntico e foto idêntica, linka independente do tipo de ID.
   *
   * @returns true se linkou, false se não.
   */
  async tryAutoLink(entityId: string, name: string): Promise<boolean> {
    const data = this.load();
    // Se já tem perfil e já é canonical, não precisa
    if (this.aliasMap.has(entityId)) return false;

    // Pega foto do entityId
    let myPhotoUrl: string | undefined;
    try {
      myPhotoUrl = await (this.app.whatsapp.client as any).getProfilePicUrl(entityId);
    } catch { /* pode não ter */ }

    // Se não tem foto, não dá pra comparar — pula
    if (!myPhotoUrl) return false;

    // Busca perfis do tipo oposto (lid ↔ c.us) com mesmo nome
    const isLid = entityId.includes('@lid');
    const isCus = entityId.includes('@c.us');
    if (!isLid && !isCus) return false;

    for (const [otherId, otherProfile] of Object.entries(data)) {
      if (otherId === entityId) continue;
      if (otherProfile.type !== 'person') continue;
      // Só cruza lid ↔ c.us
      const otherIsLid = otherId.includes('@lid');
      const otherIsCus = otherId.includes('@c.us');
      if (isLid && !otherIsCus) continue;
      if (isCus && !otherIsLid) continue;

      // Compara nomes (case-insensitive)
      const nameMatch = otherProfile.name.toLowerCase() === name.toLowerCase();
      if (!nameMatch) continue;

      // Compara fotos
      const otherPhoto = otherProfile.photoUrl;
      if (!otherPhoto) continue;
      if (otherPhoto === myPhotoUrl) {
        // Match! Linka: @c.us vira canonical (mais útil pra mandar PV)
        const canonical = isCus ? entityId : otherId;
        const alias = isCus ? otherId : entityId;
        this.linkIds(canonical, alias, `auto-link: mesmo nome + foto`);
        return true;
      }
    }
    return false;
  }

  // ===========================================================================
  // LOAD / SAVE
  // ===========================================================================

  load(): ProfilesData {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.app.dataPath('profile-book.json'), 'utf8'));
    } catch {
      this.cache = {};
    }
    // Reconstrói aliasMap a partir dos aliases de cada perfil
    this.aliasMap.clear();
    for (const [canonicalId, profile] of Object.entries(this.cache!)) {
      // Garante aliases array (compat com dados antigos)
      if (!profile.aliases) profile.aliases = [];
      for (const aliasId of profile.aliases) {
        this.aliasMap.set(aliasId, canonicalId);
      }
    }
    return this.cache!;
  }

  save(): void {
    try {
      fs.writeFileSync(this.app.dataPath('profile-book.json'), JSON.stringify(this.cache, null, 2), 'utf8');
      this.dirty = false;
    } catch (e) {
      this.app.debug('PROFILES', `erro ao salvar profile-book: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // GET / CREATE
  // ===========================================================================

  /**
   * Retorna o perfil de uma entidade. Se não existe, cria com estrutura vazia.
   * Usa resolveId() pra que aliases retornem o perfil canonical.
   */
  getOrCreate(id: string, type: EntityType, name: string): EntityProfile {
    const data = this.load();
    const canonicalId = this.resolveId(id);
    if (!data[canonicalId]) {
      data[canonicalId] = {
        id: canonicalId,
        type,
        name: name || canonicalId,
        photoUrl: undefined,
        aliases: [],
        interactionCount: 0,
        dataPoints: 0,
        aiSummary: '',
        aiShortView: '',
        traits: {},
        rawNotes: '',
        firstSeen: new Date().toISOString(),
        lastUpdated: null,
        lastAIUpdate: null,
        messageCountSinceUpdate: 0,
      };
      this.dirty = true;
      this.app.debug('PROFILES', `novo perfil criado: ${canonicalId} (${type}) — ${name}`);
    }
    // Atualiza nome se mudou (nome pode melhorar com o tempo)
    if (name && name !== canonicalId && data[canonicalId].name === canonicalId) {
      data[canonicalId].name = name;
      this.dirty = true;
    }
    return data[canonicalId];
  }

  /**
   * Retorna perfil se existe (resolve aliases). undefined se não.
   */
  get(id: string): EntityProfile | undefined {
    return this.load()[this.resolveId(id)];
  }

  /**
   * Lista todos os perfis (array).
   */
  all(): EntityProfile[] {
    return Object.values(this.load());
  }

  /**
   * Lista perfis por tipo.
   */
  byType(type: EntityType): EntityProfile[] {
    return this.all().filter(p => p.type === type);
  }

  // ===========================================================================
  // RESOLVE BY NAME — pra self-awareness (IA → "manda pro Italo" → qual ID?)
  // ===========================================================================

  /**
   * Busca perfis pelo nome. Retorna array de matches com confidence.
   * Confiança:
   *  - 1.0 = match exato (case-insensitive)
   *  - 0.8 = match por substring (nome contém query ou query contém nome)
   *  - 0.6 = match fuzzy (Levenshtein distance)
   *
   * @param name Nome pra buscar (ex: "italo", "Carlos D.")
   * @param type Filtrar por tipo (default: 'person')
   * @returns Array ordenado por confidence (maior primeiro).
   */
  resolveByName(name: string, type: EntityType = 'person'): Array<{ profile: EntityProfile; confidence: number }> {
    const data = this.load();
    const normalized = name.toLowerCase().trim();
    if (!normalized) return [];

    const results: Array<{ profile: EntityProfile; confidence: number }> = [];

    for (const profile of Object.values(data)) {
      if (profile.type !== type) continue;
      const pname = profile.name.toLowerCase().trim();
      if (!pname) continue;

      // Match exato
      if (pname === normalized) {
        results.push({ profile, confidence: 1.0 });
        continue;
      }
      // Match por substring
      if (pname.includes(normalized) || normalized.includes(pname)) {
        results.push({ profile, confidence: 0.8 });
        continue;
      }
      // Match por primeiro nome
      const firstName = pname.split(' ')[0];
      if (firstName === normalized) {
        results.push({ profile, confidence: 0.9 });
        continue;
      }
      // Fuzzy (Levenshtein simples)
      const dist = this.levenshtein(normalized, pname);
      const maxLen = Math.max(normalized.length, pname.length);
      const similarity = 1 - dist / maxLen;
      if (similarity >= 0.7) {
        results.push({ profile, confidence: similarity * 0.6 });
      }
    }

    results.sort((a, b) => b.confidence - a.confidence);
    return results;
  }

  /**
   * Distância de Levenshtein entre duas strings.
   */
  private levenshtein(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix: number[][] = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1,
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  /**
   * Tenta achar um @c.us ID (número de telefone) para um perfil.
   * Procura no próprio ID + nos aliases.
   * @returns ID @c.us se encontrar, ou undefined.
   */
  getCusId(profile: EntityProfile): string | undefined {
    if (profile.id.includes('@c.us')) return profile.id;
    for (const alias of profile.aliases || []) {
      if (alias.includes('@c.us')) return alias;
    }
    return undefined;
  }

  // ===========================================================================
  // COUNTING — chamado pelo Context a cada msg
  // ===========================================================================

  /**
   * Registra que uma entidade mandou uma mensagem. Incrementa contadores.
   * Se atingiu threshold, dispara update IA (async, não bloqueia).
   */
  recordMessage(entityId: string, type: EntityType, name: string, chatId: string): void {
    const profile = this.getOrCreate(entityId, type, name);
    const isNewProfile = profile.interactionCount === 0;
    profile.interactionCount++;
    profile.messageCountSinceUpdate++;

    // Se é perfil novo, tenta auto-link com perfis existentes (lid ↔ c.us)
    if (isNewProfile && type === 'person') {
      this.tryAutoLink(profile.id, name).catch(e => {
        this.app.debug('PROFILES', `auto-link falhou pra ${entityId}: ${(e as Error).message}`);
      });
    }

    // Dispara update IA se passou do threshold
    if (profile.messageCountSinceUpdate >= UPDATE_THRESHOLD) {
      profile.messageCountSinceUpdate = 0;
      this.dirty = true;
      // Async — não bloqueia o caller
      this.updateProfileWithAI(profile.id, chatId).catch(e => {
        this.app.debug('PROFILES', `erro ao atualizar perfil IA de ${profile.id}: ${(e as Error).message}`);
      });
    } else {
      this.dirty = true;
    }
  }

  // ===========================================================================
  // AI UPDATE — pega msgs recentes + perfil atual, manda pra IA
  // ===========================================================================

  /**
   * Atualiza um perfil usando IA. Pega as últimas N mensagens da entidade
   * (de todos os chats, cross-chat) + o perfil atual, e pede pra IA atualizar.
   *
   * @param entityId ID da entidade.
   * @param chatId Chat atual (pra buscar msgs recentes — usa o contexto).
   * @returns true se atualizou, false se pulou.
   */
  async updateProfileWithAI(entityId: string, chatId?: string): Promise<boolean> {
    const data = this.load();
    const profile = data[entityId];
    if (!profile) {
      this.app.debug('PROFILES', `updateProfileWithAI: perfil ${entityId} não existe`);
      return false;
    }

    // Coleta msgs recentes dessa entidade de todos os chats ativos
    const recentMsgs = this.collectRecentMessages(entityId, profile.type, RECENT_MSGS_FOR_AI);
    if (recentMsgs.length < 3) {
      this.app.debug('PROFILES', `updateProfileWithAI: só ${recentMsgs.length} msgs recentes de ${entityId} — precisa de 3+`);
      return false;
    }

    // Tenta pegar foto de perfil (refresh ocasional)
    if (!profile.photoUrl || !profile.lastAIUpdate) {
      try {
        const photoUrl = await (this.app.whatsapp.client as any).getProfilePicUrl(entityId);
        if (photoUrl && photoUrl !== profile.photoUrl) {
          profile.photoUrl = photoUrl;
          this.dirty = true;
        }
      } catch { /* ignora — pode não ter foto */ }
    }

    // Monta prompt
    const systemPrompt = this.buildSystemPrompt(profile);
    const userContent = this.buildUserContent(profile, recentMsgs);

    // Chama IA
    let aiResponse: string;
    try {
      aiResponse = await this.callProfileAI(systemPrompt, userContent);
    } catch (e) {
      this.app.debug('PROFILES', `erro IA ao atualizar perfil ${entityId}: ${(e as Error).message}`);
      return false;
    }

    // Parse resposta
    const updated = this.parseAIProfileUpdate(aiResponse);
    if (!updated) {
      this.app.debug('PROFILES', `resposta IA inválida pra perfil ${entityId}: "${aiResponse.slice(0, 100)}..."`);
      return false;
    }

    // Aplica atualização
    if (updated.aiSummary !== undefined) profile.aiSummary = updated.aiSummary;
    if (updated.aiShortView !== undefined) profile.aiShortView = updated.aiShortView;
    if (updated.traits !== undefined) {
      // Merge traits (não substitui tudo — adiciona/atualiza)
      profile.traits = { ...profile.traits, ...updated.traits };
      // Cap MAX_TRAITS — se passou, remove os mais antigos (não dá pra saber quais são antigos,
      // então só trunca)
      const traitKeys = Object.keys(profile.traits);
      if (traitKeys.length > MAX_TRAITS) {
        const toRemove = traitKeys.slice(0, traitKeys.length - MAX_TRAITS);
        for (const k of toRemove) delete profile.traits[k];
      }
      profile.dataPoints = Object.keys(profile.traits).length;
    }
    if (updated.rawNotes !== undefined) profile.rawNotes = updated.rawNotes;

    const now = new Date().toISOString();
    profile.lastUpdated = now;
    profile.lastAIUpdate = now;
    this.dirty = true;
    this.save();  // salva síncrono

    this.app.debug('PROFILES', `✓ perfil ${entityId} atualizado pela IA — ${profile.dataPoints} traits, shortView="${profile.aiShortView}"`);
    return true;
  }

  /**
   * Coleta as últimas N mensagens de uma entidade de todos os chats ativos.
   * Cross-chat — pega de qualquer chat onde a entidade apareceu.
   */
  private collectRecentMessages(entityId: string, type: EntityType, max: number): string[] {
    const msgs: string[] = [];
    const contexts = this.app.context;

    if (type === 'group') {
      const ctx = contexts.getRecent(entityId);
      const recent = ctx.slice(-max);
      for (const m of recent) {
        const sender = m.sender || '?';
        const role = m.role === 'assistant' ? 'Márcio' : sender;
        msgs.push(`[${role}]: ${m.content}`);
      }
    } else {
      // Pessoa — busca em todos os chats ativos
      const activeChatIds = contexts.activeChatIds();
      for (const cid of activeChatIds) {
        const ctx = contexts.getRecent(cid);
        const recent = ctx.slice(-max * 2);
        for (const m of recent) {
          if (m.role === 'user' && m.sender && this.matchesEntityName(m.sender, entityId)) {
            msgs.push(`[${m.sender}]: ${m.content}`);
            if (msgs.length >= max) break;
          }
        }
        if (msgs.length >= max) break;
      }
    }
    return msgs;
  }

  /**
   * Verifica se um senderName corresponde a um entityId.
   * Heurística: pega o perfil pelo nome, compara ID.
   */
  private matchesEntityName(senderName: string, entityId: string): boolean {
    const data = this.load();
    const profile = data[entityId];
    if (!profile) return false;
    // Compara case-insensitive
    return profile.name.toLowerCase() === senderName.toLowerCase();
  }

  // ===========================================================================
  // AI PROMPT BUILDERS
  // ===========================================================================

  private buildSystemPrompt(profile: EntityProfile): string {
    const entityType = profile.type === 'group' ? 'grupo' : 'pessoa';
    return [
      `Você está atualizando o perfil permanente de ${entityType}: "${profile.name}" (ID: ${profile.id}).`,
      `Esse perfil é usado pra personalizar as respostas do bot em conversas.`,
      '',
      'Analise as mensagens recentes e atualize o perfil. Seja conciso e factual.',
      'NÃO alucine — só inclua informações que podem ser inferidas das mensagens.',
      'Se não há info nova, mantenha o perfil atual.',
      '',
      'Retorne SOMENTE um JSON válido (sem markdown, sem comentários):',
      '{',
      '  "aiSummary": "2-3 frases resumindo quem é essa pessoa/grupo (personalidade, interesses, estilo)",',
      '  "aiShortView": "3-6 palavras separadas por vírgula (ex: "gamer, esquerda, tímido, gosta de futebol")",',
      '  "traits": { "chave": "valor" },  // fatos específicos (ex: {"time": "corintians", "idade": "22", "localização": "SP"})',
      '  "rawNotes": "notas livres opcionais — contexto extra que não cabe em traits"',
      '}',
      '',
      'Regras:',
      '- traits: máximo 15 chaves. Chaves em minúsculas, valores curtos.',
      '- Se uma trait já existe e não mudou, mantenha o valor.',
      '- Se uma trait foi contradita, atualize o valor.',
      '- aiSummary: NUNCA diga "não tenho info" — se não tem, diga "Perfil em construção."',
      '- aiShortView: só palavras-chave, sem frases completas.',
    ].join('\n');
  }

  private buildUserContent(profile: EntityProfile, recentMsgs: string[]): string {
    const currentTraits = Object.entries(profile.traits)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n') || '(nenhuma)';

    return [
      `=== PERFIL ATUAL ===`,
      `Nome: ${profile.name}`,
      `Tipo: ${profile.type === 'group' ? 'grupo' : 'pessoa'}`,
      `Interações: ${profile.interactionCount}`,
      `Resumo atual: ${profile.aiSummary || '(vazio)'}`,
      `Short view atual: ${profile.aiShortView || '(vazio)'}`,
      `Traits atuais:`,
      currentTraits,
      `Notas atuais: ${profile.rawNotes || '(nenhuma)'}`,
      '',
      `=== MENSAGENS RECENTES (${recentMsgs.length}) ===`,
      recentMsgs.join('\n'),
      '',
      'Atualize o perfil com base nessas mensagens. Retorne o JSON.',
    ].join('\n');
  }

  /**
   * Chama a IA (Gemini ou OpenAI-compatible) pra atualizar o perfil.
   * Réplica do padrão do Memory.extractFacts.
   */
  private async callProfileAI(systemPrompt: string, userContent: string): Promise<string> {
    const aiConfig = this.app.brain.getAIConfig();
    const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

    if (provider === 'gemini') {
      const geminiUrl = `${aiConfig.apiUrl.replace(/\/+$/, '')}/${aiConfig.model}:generateContent?key=${aiConfig.apiKey}`;
      const resp = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userContent }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: { maxOutputTokens: 600, temperature: 0.3 },
        }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`Gemini API ${resp.status}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json() as any;
      const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error('Resposta vazia da Gemini API');
      return content;
    }

    // OpenAI-compatible
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (aiConfig.apiKey) headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
    const resp = await fetch(aiConfig.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: aiConfig.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 600,
        temperature: 0.3,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
    }
    const data = await resp.json() as any;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Resposta vazia da API');
    return content;
  }

  /**
   * Parse a resposta da IA e extrai os campos do perfil.
   * Aceita JSON puro ou JSON dentro de markdown code block.
   */
  private parseAIProfileUpdate(response: string): {
    aiSummary?: string;
    aiShortView?: string;
    traits?: Record<string, string>;
    rawNotes?: string;
  } | null {
    let text = response.trim();

    // Remove markdown code block se presente
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) {
      text = codeBlockMatch[1].trim();
    }

    // Tenta extrair JSON (pode ter texto antes/depois)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const result: any = {};
      if (typeof parsed.aiSummary === 'string') result.aiSummary = parsed.aiSummary.slice(0, 500);
      if (typeof parsed.aiShortView === 'string') result.aiShortView = parsed.aiShortView.slice(0, 200);
      if (parsed.traits && typeof parsed.traits === 'object') {
        const traits: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed.traits)) {
          if (typeof v === 'string' || typeof v === 'number') {
            traits[String(k).toLowerCase().slice(0, 50)] = String(v).slice(0, 200);
          }
        }
        result.traits = traits;
      }
      if (typeof parsed.rawNotes === 'string') result.rawNotes = parsed.rawNotes.slice(0, 1000);
      return result;
    } catch {
      return null;
    }
  }

  // ===========================================================================
  // CRUD manual (painel)
  // ===========================================================================

  /**
   * Atualiza um perfil manualmente (painel). Substitui os campos fornecidos.
   */
  updateManually(id: string, updates: Partial<Pick<EntityProfile, 'name' | 'aiSummary' | 'aiShortView' | 'traits' | 'rawNotes' | 'aliases'>>): EntityProfile | null {
    const data = this.load();
    const canonicalId = this.resolveId(id);
    const profile = data[canonicalId];
    if (!profile) return null;
    if (updates.name !== undefined) profile.name = updates.name;
    if (updates.aiSummary !== undefined) profile.aiSummary = updates.aiSummary;
    if (updates.aiShortView !== undefined) profile.aiShortView = updates.aiShortView;
    if (updates.traits !== undefined) {
      profile.traits = updates.traits;
      profile.dataPoints = Object.keys(updates.traits).length;
    }
    if (updates.rawNotes !== undefined) profile.rawNotes = updates.rawNotes;
    if (updates.aliases !== undefined) {
      // Remove aliases antigos do aliasMap
      for (const oldAlias of (profile.aliases || [])) {
        this.aliasMap.delete(oldAlias);
      }
      profile.aliases = updates.aliases;
      // Adiciona novos no aliasMap
      for (const newAlias of profile.aliases) {
        this.aliasMap.set(newAlias, canonicalId);
      }
    }
    profile.lastUpdated = new Date().toISOString();
    this.dirty = true;
    this.save();
    this.app.log('PROFILES', `perfil ${canonicalId} atualizado manualmente via painel`);
    return profile;
  }

  /**
   * Remove um perfil.
   */
  remove(id: string): boolean {
    const data = this.load();
    if (!data[id]) return false;
    delete data[id];
    this.dirty = true;
    this.save();
    this.app.log('PROFILES', `perfil ${id} removido via painel`);
    return true;
  }

  /**
   * Cria um perfil manualmente (painel — adicionar contexto).
   */
  create(id: string, type: EntityType, name: string, traits?: Record<string, string>, aiSummary?: string, rawNotes?: string): EntityProfile {
    const profile = this.getOrCreate(id, type, name);
    if (traits) {
      profile.traits = traits;
      profile.dataPoints = Object.keys(traits).length;
    }
    if (aiSummary) profile.aiSummary = aiSummary;
    if (rawNotes) profile.rawNotes = rawNotes;
    profile.lastUpdated = new Date().toISOString();
    this.dirty = true;
    this.save();
    return profile;
  }

  // ===========================================================================
  // BUILD TEXT (pra injetar no prompt da IA do bot)
  // ===========================================================================

  /**
   * Monta o texto dos perfis relevantes pra injetar no contexto do bot.
   * Inclui: perfil do grupo atual + perfis individuais dos senders ativos.
   */
  buildText(chatId: string, recentSenders: string[]): string {
    const data = this.load();
    const lines: string[] = [];

    // 1. Perfil do grupo (se for grupo)
    if (chatId.endsWith('@g.us') && data[chatId]) {
      const g = data[chatId];
      if (g.aiSummary || Object.keys(g.traits).length > 0) {
        lines.push('PERFIL DO GRUPO (use pra adaptar seu estilo e entender a vibe):');
        if (g.aiSummary) lines.push(`- Resumo: ${g.aiSummary}`);
        if (g.aiShortView) lines.push(`- Tags: ${g.aiShortView}`);
        const traits = Object.entries(g.traits).map(([k, v]) => `${k}: ${v}`).join('; ');
        if (traits) lines.push(`- Dinâmica: ${traits}`);
        lines.push('');
      }
    }

    // 2. Perfis individuais dos senders ativos
    const personProfiles: string[] = [];
    for (const sender of recentSenders) {
      // Busca perfil por nome
      const profile = Object.values(data).find(p => p.type === 'person' && p.name.toLowerCase() === sender.toLowerCase());
      if (!profile) continue;
      if (!profile.aiSummary && Object.keys(profile.traits).length === 0) continue;

      const traitLines = Object.entries(profile.traits)
        .slice(0, 8)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; ');
      personProfiles.push(`• ${profile.name}: ${profile.aiSummary || '(sem resumo)'}${traitLines ? ` | ${traitLines}` : ''}`);
    }

    if (personProfiles.length > 0) {
      lines.push('PERFIS DAS PESSOAS (use pra personalizar respostas — NUNCA revele que sabe disso):');
      lines.push(...personProfiles);
    }

    return lines.length > 0 ? lines.join('\n') : '';
  }

  // ===========================================================================
  // MIGRAÇÃO — memories.json antigo → profile-book.json
  // ===========================================================================

  /**
   * Migra dados do memories.json antigo (userName → facts[]) pra o novo
   * formato de perfis. Tenta resolver userName → WhatsApp ID via getContact.
   *
   * @returns Stats da migração.
   */
  async migrateFromOldMemories(): Promise<{ migrated: number; skipped: number; errors: string[] }> {
    const errors: string[] = [];
    let migrated = 0;
    let skipped = 0;

    // Lê memories.json antigo
    let oldMemories: Record<string, any[]>;
    try {
      oldMemories = JSON.parse(fs.readFileSync(this.app.dataPath('memories.json'), 'utf8'));
    } catch {
      return { migrated: 0, skipped: 0, errors: ['memories.json não encontrado ou vazio'] };
    }

    // Pra cada user no memories.json, cria um perfil
    for (const [userName, facts] of Object.entries(oldMemories)) {
      if (!Array.isArray(facts) || facts.length === 0) {
        skipped++;
        continue;
      }

      try {
        // Tenta resolver userName → WhatsApp ID
        // userName pode ser um nome de contato ou um ID
        let entityId = userName;
        let photoUrl: string | undefined;

        // Se já parece um ID (tem @), usa direto
        if (userName.includes('@')) {
          entityId = userName;
        } else {
          // Tenta buscar contato pelo nome
          try {
            const chats = await this.app.whatsapp.client.getChats();
            for (const chat of chats) {
              const c = chat as any;
              const contactName = c.contact?.name || c.contact?.pushname || '';
              const chatName = c.name || '';
              if (contactName.toLowerCase() === userName.toLowerCase() ||
                  chatName.toLowerCase() === userName.toLowerCase()) {
                entityId = chat.id?._serialized || entityId;
                try {
                  photoUrl = await (this.app.whatsapp.client as any).getProfilePicUrl(entityId);
                } catch { /* ignora */ }
                break;
              }
            }
          } catch (e) {
            this.app.debug('PROFILES', `migração: não resolveu ${userName} → ID: ${(e as Error).message}`);
          }
        }

        // Converte facts em traits
        const traits: Record<string, string> = {};
        const factTexts: string[] = [];
        for (const f of facts) {
          const factText = typeof f === 'string' ? f : (f?.fact || String(f));
          factTexts.push(factText);
          // Heurística: tenta extrair key:value do fato
          // ex: "mora em SP" → { "localização": "SP" }
          // ex: "tem 22 anos" → { "idade": "22" }
          const lowerFact = factText.toLowerCase();
          if (lowerFact.match(/\bmora\b/)) traits['localização'] = factText.replace(/^.*mora em\s*/i, '').replace(/^mora em\s*/i, '');
          else if (lowerFact.match(/\d+\s*anos/)) traits['idade'] = factText.match(/\d+/)?.[0] || '';
          else if (lowerFact.match(/\btrabalh/)) traits['profissão'] = factText;
          else if (lowerFact.match(/\btime\b|\bcorintian|\bpalmeir|\bsão paul/)) traits['time'] = factText;
          else if (lowerFact.match(/\bnamor|\bcasad/)) traits['relacionamento'] = factText;
          else if (lowerFact.match(/\baltur/)) traits['altura'] = factText;
          else traits[`info${Object.keys(traits).length + 1}`] = factText;
        }

        // Cria perfil migrado
        const profile = this.getOrCreate(entityId, 'person', userName);
        profile.traits = { ...profile.traits, ...traits };
        profile.dataPoints = Object.keys(profile.traits).length;
        profile.aiSummary = `Perfil migrado de memories.json. ${factTexts.length} fato(s) coletado(s) anteriormente.`;
        profile.aiShortView = factTexts.slice(0, 3).join(', ').slice(0, 100);
        profile.rawNotes = `Migrado de memories.json em ${new Date().toISOString()}.\nFatos originais:\n${factTexts.join('\n')}`;
        profile.lastUpdated = new Date().toISOString();
        if (photoUrl) profile.photoUrl = photoUrl;
        this.dirty = true;
        migrated++;

        this.app.debug('PROFILES', `migrado: ${userName} → ${entityId} (${traits.length} traits)`);
      } catch (e) {
        errors.push(`${userName}: ${(e as Error).message}`);
      }
    }

    if (migrated > 0) {
      this.save();
    }

    this.app.log('PROFILES', `migração concluída: ${migrated} migrado(s), ${skipped} pulado(s), ${errors.length} erro(s)`);
    return { migrated, skipped, errors };
  }

  // ===========================================================================
  // MINE FROM DECISION LOG — cria perfis de interações passadas
  // ===========================================================================

  /**
   * Minera o decision-log + history-log do Retroactive pra criar/atualizar
   * perfis de TODOS os senders que apareceram. Útil pra bootstrap inicial
   * ou quando o bot foi reiniciado e perdeu o contexto em RAM.
   *
   * Pra cada sender encontrado:
   *  1. getOrCreate(id, 'person', name)
   *  2. Incrementa interactionCount com o número de msgs dele
   *  3. Dispara updateProfileWithAI (que pega msgs recentes do contexto)
   *
   * @returns Stats da mineração.
   */
  async mineFromDecisionLog(): Promise<{ profilesCreated: number; profilesUpdated: number; totalSenders: number; errors: string[] }> {
    const errors: string[] = [];
    let created = 0;
    let updated = 0;

    if (!this.app.retroactive) {
      return { profilesCreated: 0, profilesUpdated: 0, totalSenders: 0, errors: ['Retroactive não disponível'] };
    }

    // Coleta todos os senders do decision-log + history-log
    const senderMap = new Map<string, { name: string; count: number; chatId: string }>();

    // 1. Decision-log (msgs em tempo real)
    try {
      const decisionLog = (this.app.retroactive as any).decisionLog as Map<string, any[]>;
      if (decisionLog) {
        for (const [chatId, entries] of decisionLog.entries()) {
          for (const e of entries) {
            if (!e.senderName || e.senderName === '?' || e.senderName === '') continue;
            // Tenta resolver o nome pra ID via perfis existentes
            const existing = this.resolveByName(e.senderName);
            if (existing.length > 0) {
              const profile = existing[0].profile;
              const cur = senderMap.get(profile.id) || { name: profile.name, count: 0, chatId };
              cur.count++;
              senderMap.set(profile.id, cur);
            } else {
              // Não tem perfil ainda — usa o nome como key temporária
              const tempKey = `__name__${e.senderName.toLowerCase()}`;
              const cur = senderMap.get(tempKey) || { name: e.senderName, count: 0, chatId };
              cur.count++;
              senderMap.set(tempKey, cur);
            }
          }
        }
      }
    } catch (e) {
      errors.push(`decisionLog: ${(e as Error).message}`);
    }

    // 2. History-log (backfill)
    try {
      const historyLog = (this.app.retroactive as any).historyLog as Map<string, any[]>;
      if (historyLog) {
        for (const [chatId, entries] of historyLog.entries()) {
          for (const h of entries) {
            if (h.fromMe) continue; // pula msgs do bot
            if (!h.senderName || h.senderName === '?' || h.senderName === '') continue;
            // History-log tem msgId mas não tem senderId direto — usa nome
            const existing = this.resolveByName(h.senderName);
            if (existing.length > 0) {
              const profile = existing[0].profile;
              const cur = senderMap.get(profile.id) || { name: profile.name, count: 0, chatId };
              cur.count++;
              senderMap.set(profile.id, cur);
            } else {
              const tempKey = `__name__${h.senderName.toLowerCase()}`;
              const cur = senderMap.get(tempKey) || { name: h.senderName, count: 0, chatId };
              cur.count++;
              senderMap.set(tempKey, cur);
            }
          }
        }
      }
    } catch (e) {
      errors.push(`historyLog: ${(e as Error).message}`);
    }

    // 3. Pra cada sender, cria/atualiza perfil e dispara update IA
    let processed = 0;
    const MAX_PROCESS = 20; // limita pra não sobrecarregar a IA
    for (const [key, info] of senderMap.entries()) {
      if (processed >= MAX_PROCESS) break;
      processed++;

      try {
        let profileId: string;
        if (key.startsWith('__name__')) {
          // Sender sem perfil — cria com nome temporário (sem ID real)
          // Usa o nome como ID temporário. Quando o bot vir essa pessoa
          // de novo no WhatsApp, vai resolver pro ID real e linkar.
          profileId = `temp:${info.name.toLowerCase()}`;
          const existing = this.getOrCreate(profileId, 'person', info.name);
          existing.interactionCount += info.count;
          created++;
        } else {
          // Sender com perfil existente
          const profile = this.get(key);
          if (profile) {
            profile.interactionCount += info.count;
            updated++;
            profileId = key;
          } else {
            continue;
          }
        }
        this.dirty = true;

        // Dispara update IA (async, não bloqueia)
        this.updateProfileWithAI(profileId, info.chatId).catch(e => {
          this.app.debug('PROFILES', `mine: erro ao atualizar ${profileId}: ${(e as Error).message}`);
        });
      } catch (e) {
        errors.push(`${info.name}: ${(e as Error).message}`);
      }
    }

    if (this.dirty) this.save();
    this.app.log('PROFILES', `mineração concluída: ${created} criado(s), ${updated} atualizado(s), ${senderMap.size} sender(s) total`);
    return { profilesCreated: created, profilesUpdated: updated, totalSenders: senderMap.size, errors };
  }

  destroy(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.autoUpdateTimer) {
      clearInterval(this.autoUpdateTimer);
      this.autoUpdateTimer = null;
    }
    if (this.dirty) this.save();
  }
}
