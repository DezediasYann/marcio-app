/**
 * Profile — aprendizado de estilo do grupo + por usuário.
 *
 * Responsabilidades:
 *  - Para cada chat, manter um "perfil" com:
 *    - vocabulary: gírias mais usadas (geral do grupo)
 *    - style: métricas (tamanho médio, % minúsculas, % pontuação, % emojis, caps)
 *    - userActivity: quem são os mais ativos
 *    - userProfiles: estilo individual (gírias, tópicos, avgLength)
 *  - updateWithMessage(chatId, senderName, text) — chamado pelo Context a cada msg.
 *  - buildStyleText(chatId) — injeta no prompt da IA (só se tiver 10+ msgs).
 *  - Persiste em data/chat-profiles.json com auto-save 30s.
 *
 * Preservado byte-a-byte do index.js velho (funções 1488-1727):
 *  - SLANG_WORDS (lista curada de gírias BR)
 *  - loadChatProfiles / saveChatProfiles (cache + autosave 30s)
 *  - getChatProfile (cria se não existir, garante userProfiles)
 *  - updateProfileWithMessage (vocabulary + style + userActivity + userProfile individual)
 *  - buildStyleProfileText (só se 10+ msgs, top 8 gírias, top 5 ativos, perfis individuais)
 */

import type { MarcioApp } from '../MarcioApp';
import fs from 'node:fs';

// ============================================================================
// SLANG WORDS — lista curada de gírias/expressões brasileiras
// ============================================================================

const SLANG_WORDS = [
  'mds', 'mdss', 'gente', 'tipo', 'né', 'cara', 'mano', 'visse', 'oxe', 'vish',
  'carai', 'caramba', 'slc', 'slk', 'rapaz', 'meu', 'oxi', 'iaiai', 'vdd', 'pqp',
  'kk', 'kkk', 'kkkk', 'kkkkk', 'kkkkkk',
  'vc', 'q', 'agr', 'tbm', 'msm', 'pfv', 'pq', 'blz', 'vlw', 'flw',
  'tá', 'to', 'tô', 'n', 's', 'tb', 'tmb',
  'risos', 'krl', 'kra', 'mn', 'ne',
  'pow', 'poxa', 'nossa', 'nossas', 'caracas',
  'tmj', 'tmjk', 'trm', 'blza',
];

// Stopwords pra extração de tópicos (palavras com 4+ letras que NÃO são tópicos)
const STOPWORDS = new Set([
  'isso', 'aquilo', 'entao', 'então', 'tambem', 'também', 'assim',
  'sobre', 'depois', 'sempre', 'ainda', 'hoje', 'agora', 'aqui',
  'mesmo', 'mesma', 'outros', 'outras', 'todos', 'todas',
  'muito', 'muita', 'muitos', 'muitas', 'poderia', 'poderiam',
  'estava', 'estavo', 'tava', 'tavo', 'vai', 'vou', 'foi', 'tem',
  'temos', 'tinha', 'ter', 'ser', 'estar', 'fazer', 'dar', 'ir',
  'quando', 'onde', 'porque', 'porq', 'qual', 'quais', 'como',
  'nao', 'não', 'sim', 'mais', 'menos', 'entre', 'desde', 'ate',
  'até', 'para', 'pra', 'pro', 'mas', 'porem', 'porém', 'com',
  'sem', 'de', 'da', 'do', 'das', 'dos', 'numa', 'num',
  'nesse', 'nessa', 'desse', 'dessa', 'este', 'esta',
  'esse', 'essa', 'aquele', 'aquela', 'seu', 'sua', 'minha',
  'meu', 'nossa', 'nosso', 'voces', 'vocês', 'eles', 'elas',
  'gente', 'caralho', 'porra', 'merda', 'kkkk', 'kkkkk',
]);

// ============================================================================
// TIPOS
// ============================================================================

export interface StyleMetrics {
  totalMessages: number;
  totalLength: number;
  lowercaseMessages: number;
  punctuatedMessages: number;
  emojiMessages: number;
  totalEmojis: number;
  capsMessages: number;
}

export interface UserProfile {
  vocabulary: Record<string, number>;  // gíria -> contagem (DESSA pessoa)
  msgCount: number;
  totalLength: number;
  topics: Record<string, number>;      // palavra-chave -> contagem
  avgLength: number;
}

export interface ChatProfile {
  vocabulary: Record<string, number>;  // gíria -> contagem (do grupo todo)
  style: StyleMetrics;
  userActivity: Record<string, number>; // nome -> contagem
  userProfiles: Record<string, UserProfile>;
  firstSeen: string;
  lastUpdated: string | null;
}

export type ProfilesData = Record<string, ChatProfile>;

// ============================================================================
// PROFILE
// ============================================================================

export class Profile {
  private app: MarcioApp;
  private cache: ProfilesData | null = null;
  private dirty = false;
  private autoSaveTimer: NodeJS.Timeout | null = null;

  constructor(app: MarcioApp) {
    this.app = app;
    // Auto-save a cada 30s se tiver mudança
    this.autoSaveTimer = setInterval(() => {
      if (this.dirty) this.save();
    }, 30000);
  }

  // ===========================================================================
  // LOAD / SAVE
  // ===========================================================================

  private load(): ProfilesData {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.app.dataPath('chat-profiles.json'), 'utf8'));
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  save(): void {
    try {
      fs.writeFileSync(this.app.dataPath('chat-profiles.json'), JSON.stringify(this.cache, null, 2), 'utf8');
      this.dirty = false;
      this.app.debug('PROFILE', 'perfis salvos no disco (autosave)');
    } catch (e) {
      this.app.debug('PROFILE', `erro ao salvar perfis: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // GET (cria se não existir)
  // ===========================================================================

  /**
   * Retorna o perfil de um chat. Se não existir, cria com estrutura vazia.
   * Garante que userProfiles existe (pra perfis criados antes dessa feature).
   */
  get(chatId: string): ChatProfile {
    const profiles = this.load();
    if (!profiles[chatId]) {
      profiles[chatId] = {
        vocabulary: {},
        style: {
          totalMessages: 0,
          totalLength: 0,
          lowercaseMessages: 0,
          punctuatedMessages: 0,
          emojiMessages: 0,
          totalEmojis: 0,
          capsMessages: 0,
        },
        userActivity: {},
        userProfiles: {},
        firstSeen: new Date().toISOString(),
        lastUpdated: null,
      };
      this.dirty = true;
    }
    // Garante userProfiles (perfis antigos)
    if (!profiles[chatId].userProfiles) {
      profiles[chatId].userProfiles = {};
      this.dirty = true;
    }
    return profiles[chatId];
  }

  // ===========================================================================
  // UPDATE — chamado pelo Context a cada msg de usuário
  // ===========================================================================

  /**
   * Atualiza o perfil do chat com uma nova mensagem.
   *  - Conta gírias (geral + individual)
   *  - Métricas de estilo (lowercase, pontuação, emoji, caps)
   *  - User activity (quem mandou quantas)
   *  - UserProfile individual (msgCount, avgLength, topics)
   */
  updateWithMessage(chatId: string, senderName: string, text: string): void {
    const profile = this.get(chatId);
    const lower = text.toLowerCase();

    // === PERFIL DO GRUPO (geral) ===
    // Vocabulary — conta gírias
    for (const slang of SLANG_WORDS) {
      const escaped = slang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
      const matches = lower.match(regex);
      if (matches) {
        profile.vocabulary[slang] = (profile.vocabulary[slang] || 0) + matches.length;
      }
    }

    // Style metrics
    profile.style.totalMessages++;
    profile.style.totalLength += text.length;

    const hasLetters = /[a-zà-ú]/i.test(text);
    if (hasLetters && text === text.toLowerCase()) {
      profile.style.lowercaseMessages++;
    }
    if (/[.!?]$/.test(text.trim())) {
      profile.style.punctuatedMessages++;
    }
    const emojiMatches = text.match(/[\u{1F000}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{2190}-\u{21FF}]/gu);
    if (emojiMatches) {
      profile.style.emojiMessages++;
      profile.style.totalEmojis += emojiMatches.length;
    }
    if (/[A-Z]{6,}/.test(text)) {
      profile.style.capsMessages++;
    }

    // User activity
    profile.userActivity[senderName] = (profile.userActivity[senderName] || 0) + 1;

    // === PERFIL INDIVIDUAL DO USUÁRIO ===
    if (!profile.userProfiles[senderName]) {
      profile.userProfiles[senderName] = {
        vocabulary: {},
        msgCount: 0,
        totalLength: 0,
        topics: {},
        avgLength: 0,
      };
    }
    const up = profile.userProfiles[senderName];
    up.msgCount++;
    up.totalLength += text.length;
    up.avgLength = Math.round(up.totalLength / up.msgCount);

    // Gírias individuais
    for (const slang of SLANG_WORDS) {
      const escaped = slang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
      const matches = lower.match(regex);
      if (matches) {
        up.vocabulary[slang] = (up.vocabulary[slang] || 0) + matches.length;
      }
    }

    // Tópicos: palavras com 4+ letras (ignorando stopwords)
    const words = lower.match(/\b[a-zà-ú]{4,}\b/gi) || [];
    for (const word of words) {
      if (!STOPWORDS.has(word.toLowerCase())) {
        up.topics[word] = (up.topics[word] || 0) + 1;
      }
    }

    profile.lastUpdated = new Date().toISOString();
    this.dirty = true;
  }

  // ===========================================================================
  // BUILD TEXT (pra injetar no prompt da IA)
  // ===========================================================================

  /**
   * Monta o texto do perfil de estilo pra injetar no contexto da IA.
   * Retorna '' se não tiver dados suficientes (< 10 msgs).
   *
   * Inclui:
   *  - Perfil do grupo: tamanho médio, % lowercase, % pontuação, % emoji,
   *    top 8 gírias, top 5 ativos.
   *  - Perfis individuais (top 5): msgCount, avgLength, top 3 tópicos,
   *    top 3 gírias.
   */
  buildStyleText(chatId: string): string {
    const profile = this.get(chatId);
    if (profile.style.totalMessages < 10) return '';  // precisa de pelo menos 10 msgs

    const s = profile.style;
    const avgLength = Math.round(s.totalLength / s.totalMessages);
    const lowercaseRatio = Math.round(s.lowercaseMessages / s.totalMessages * 100);
    const punctuationRatio = Math.round(s.punctuatedMessages / s.totalMessages * 100);
    const emojiRatio = Math.round(s.emojiMessages / s.totalMessages * 100);
    const avgEmojis = (s.totalEmojis / s.totalMessages).toFixed(1);

    // Top 8 gírias do grupo
    const topVocab = Object.entries(profile.vocabulary)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word, count]) => `"${word}" (${count}x)`)
      .join(', ');

    // Top 5 mais ativos
    const topUsers = Object.entries(profile.userActivity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => `${name} (${count}x)`)
      .join(', ');

    const lines = [`PERFIL DO GRUPO (aprendido com ${s.totalMessages} mensagens):`];
    lines.push(`- Tamanho médio: ${avgLength} chars`);
    lines.push(`- ${lowercaseRatio}% escrevem em minúsculas`);
    lines.push(`- ${punctuationRatio}% usam pontuação formal no fim`);
    lines.push(`- ${emojiRatio}% usam emoji (média ${avgEmojis} por msg)`);
    if (topVocab) lines.push(`- Gírias mais usadas: ${topVocab}`);
    if (topUsers) lines.push(`- Mais ativos: ${topUsers}`);

    // === PERFIS INDIVIDUAIS (cada pessoa) ===
    const userEntries = Object.entries(profile.userProfiles || {})
      .filter(([, up]) => up.msgCount >= 5)  // só quem mandou 5+ msgs
      .sort((a, b) => b[1].msgCount - a[1].msgCount)
      .slice(0, 5);

    if (userEntries.length > 0) {
      lines.push('');
      lines.push('PERFIL INDIVIDUAL (cada pessoa — use pra adaptar seu estilo a quem tá falando):');
      for (const [name, up] of userEntries) {
        const topTopics = Object.entries(up.topics || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([word]) => word)
          .join(', ');

        const topUserVocab = Object.entries(up.vocabulary || {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([word]) => word)
          .join(', ');

        let userLine = `• ${name} (${up.msgCount} msgs, ${up.avgLength} chars)`;
        if (topTopics) userLine += ` — fala sobre: ${topTopics}`;
        if (topUserVocab) userLine += ` | gírias: ${topUserVocab}`;
        lines.push(userLine);
      }
    }

    lines.push('');
    lines.push('ADAPTE seu estilo pra combinar com o grupo. Use as gírias que eles mais usam.');
    lines.push('Se alguém específico falou, considere o estilo individual dessa pessoa ao responder.');
    return lines.join('\n');
  }

  // ===========================================================================
  // SHUTDOWN
  // ===========================================================================

  destroy(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.dirty) this.save();
  }
}
