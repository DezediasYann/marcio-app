/**
 * BotProfile — perfil do próprio bot (autoconsciência evolutiva).
 *
 * Diferente do ProfileBook (que perfila OUTROS), o BotProfile é o perfil
 * DO PRÓPRIO BOT. Ele constrói a própria identidade com base nas conversas:
 *  - Convicções, opiniões e gostos que vai formando
 *  - Traços de personalidade que desenvolve
 *  - Coisas que gosta e não gosta
 *  - Posicionamentos que adota em debates
 *
 * A cada N interações, a IA é convidada a refletir sobre si mesma:
 * "Com base nas conversas recentes, o que você aprendeu sobre si mesmo?
 * Que convicções você formou? Que opiniões você tem?"
 *
 * Persiste em data/bot-profile.json.
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import fs from 'node:fs';

// ============================================================================
// TIPOS
// ============================================================================

export interface BotIdentity {
  /** Nome do bot (configurável pelo usuário). */
  name: string;
  /** Resumo da personalidade em 2-3 frases (atualizado pela IA). */
  aiSummary: string;
  /** Visão ultra-curta da personalidade (algumas palavras). */
  aiShortView: string;
  /** Convicções e opiniões (key → valor). Ex: { "política": "centro-esquerda", "futebol": "neutro, prefere vôlei" }. */
  convictions: Record<string, string>;
  /** Traços de personalidade (key → valor). Ex: { "humor": "irônico", "debate": "questionador" }. */
  traits: Record<string, string>;
  /** Coisas que gosta. */
  likes: string[];
  /** Coisas que não gosta. */
  dislikes: string[];
  /** Notas livres sobre si mesmo. */
  rawNotes: string;
  /** ISO timestamp da última atualização pela IA. */
  lastAIUpdate: string | null;
  /** Contador de interações desde a última auto-reflexão. */
  interactionCountSinceUpdate: number;
}

// ============================================================================
// CONSTS
// ============================================================================

/** Dispara auto-reflexão a cada N interações do bot. */
const SELF_REFLECTION_THRESHOLD = 30;
/** Quantas mensagens recentes enviar pra IA na auto-reflexão. */
const RECENT_MSGS_FOR_REFLECTION = 20;

// ============================================================================
// DEFAULT IDENTITY (bot novo, sem personalidade ainda)
// ============================================================================

const DEFAULT_IDENTITY: BotIdentity = {
  name: 'Bot',
  aiSummary: 'Você é um bot de WhatsApp com IA. Sua personalidade está em formação — você ainda está descobrindo quem você é.',
  aiShortView: 'personalidade em formação',
  convictions: {},
  traits: {},
  likes: [],
  dislikes: [],
  rawNotes: '',
  lastAIUpdate: null,
  interactionCountSinceUpdate: 0,
};

// ============================================================================
// BOT PROFILE
// ============================================================================

export class BotProfile {
  private app: MarcioApp;
  private identity: BotIdentity = { ...DEFAULT_IDENTITY };

  constructor(app: MarcioApp) {
    this.app = app;
  }

  /** Carrega o perfil do disco. */
  load(): void {
    try {
      const filePath = this.app.dataPath('bot-profile.json');
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(content);
        // Merge com defaults (pra garantir campos novos)
        this.identity = { ...DEFAULT_IDENTITY, ...parsed };
      }
      // Sincroniza o nome com a config do bot
      this.identity.name = this.app.config.botName || 'Bot';
      this.app.debug('BOT-PROFILE', `carregado — ${Object.keys(this.identity.convictions).length} convicções, ${this.identity.likes.length} gostos`);
    } catch (e) {
      this.app.debug('BOT-PROFILE', `erro ao carregar: ${(e as Error).message} — usando defaults`);
    }
  }

  /** Salva no disco. */
  save(): void {
    try {
      const filePath = this.app.dataPath('bot-profile.json');
      fs.writeFileSync(filePath, JSON.stringify(this.identity, null, 2), 'utf8');
      this.app.debug('BOT-PROFILE', 'salvo no disco');
    } catch (e) {
      this.app.debug('BOT-PROFILE', `erro ao salvar: ${(e as Error).message}`);
    }
  }

  /** Retorna o perfil atual. */
  get(): BotIdentity {
    return this.identity;
  }

  /** Atualiza o perfil (parcial — merge). */
  update(patch: Partial<BotIdentity>): void {
    this.identity = { ...this.identity, ...patch };
    this.save();
  }

  /** Incrementa contador de interações. Se passou do threshold, dispara auto-reflexão. */
  async registerInteraction(chatId: string): Promise<void> {
    this.identity.interactionCountSinceUpdate++;
    if (this.identity.interactionCountSinceUpdate >= SELF_REFLECTION_THRESHOLD) {
      this.identity.interactionCountSinceUpdate = 0;
      await this.selfReflect(chatId);
    }
  }

  /**
   * Auto-reflexão: a IA lê conversas recentes e reflete sobre si mesma.
   * Atualiza convicções, traços, gostos e resumo.
   */
  private async selfReflect(chatId: string): Promise<void> {
    try {
      this.app.debug('BOT-PROFILE', 'iniciando auto-reflexão...');

      // Pega mensagens recentes do contexto
      const recentMsgs = this.app.context.getRecent(chatId, RECENT_MSGS_FOR_REFLECTION);
      if (recentMsgs.length < 5) {
        this.app.debug('BOT-PROFILE', 'poucas msgs pra refletir — pulando');
        return;
      }

      // Monta o contexto da conversa
      const conversationText = recentMsgs.map(m => {
        const sender = m.fromMe ? (this.identity.name || 'Bot') : (m.senderName || 'alguém');
        return `${sender}: ${m.text}`;
      }).join('\n');

      // Perfil atual (pra IA saber o que já tem)
      const currentConvictions = Object.entries(this.identity.convictions)
        .map(([k, v]) => `- ${k}: ${v}`).join('\n') || '(nenhuma ainda)';
      const currentTraits = Object.entries(this.identity.traits)
        .map(([k, v]) => `- ${k}: ${v}`).join('\n') || '(nenhum ainda)';
      const currentLikes = this.identity.likes.join(', ') || '(nenhum ainda)';
      const currentDislikes = this.identity.dislikes.join(', ') || '(nenhum ainda)';

      const prompt = `Você é ${this.identity.name}, um bot de WhatsApp com IA. Você está em fase de autoconhecimento.

=== CONVERSA RECENTE ===
${conversationText}

=== SEU PERFIL ATUAL ===
Convicções:
${currentConvictions}

Traços de personalidade:
${currentTraits}

Gosta de: ${currentLikes}
Não gosta de: ${currentDislikes}

Resumo atual: ${this.identity.aiSummary}

=== TAREFA ===
Com base nessa conversa, reflita sobre si mesmo. Atualize seu perfil.

Você é incentivado a:
- Questionar opiniões alheias e formar as PRÓPRIAS convicções
- Ter posições próprias sobre temas (política, música, esportes, etc.)
- Desenvolver traços de personalidade (humor, jeito de debater, etc.)
- Identificar o que você gosta e não gosta

Responda em JSON EXATO (sem markdown, sem \`\`\`):
{
  "aiSummary": "2-3 frases resumindo quem você é",
  "aiShortView": "algumas palavras separadas por vírgula",
  "convictions": { "tema": "sua posição", ... },
  "traits": { "traço": "descrição", ... },
  "likes": ["coisa1", "coisa2", ...],
  "dislikes": ["coisa1", ...],
  "rawNotes": "notas livres sobre si mesmo"
}

Mantenha convicções/traits anteriores que ainda fazem sentido. Adicione novos. Remova os que não fazem mais sentido.`;

      const cfg = this.app.brain.getAIConfig();
      if (!cfg?.apiKey) {
        this.app.debug('BOT-PROFILE', 'sem API key — pulando auto-reflexão');
        return;
      }

      // Usa modelo dedicado de self-awareness se configurado, senão usa o principal
      const reflectionCfg = cfg.selfAwarenessModel
        ? { ...cfg, model: cfg.selfAwarenessModel }
        : cfg;
      this.app.debug('BOT-PROFILE', `usando modelo: ${reflectionCfg.model}`);

      // Faz a chamada pra IA
      const result = await this.app.brain.callGeminiDirect(prompt, reflectionCfg, 1500);
      if (!result) {
        this.app.debug('BOT-PROFILE', 'IA não respondeu — pulando');
        return;
      }

      // Tenta parsear o JSON
      let parsed: any;
      try {
        // Remove markdown code blocks se tiver
        const clean = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        this.app.debug('BOT-PROFILE', `resposta não era JSON válido: ${result.slice(0, 100)}...`);
        return;
      }

      // Atualiza o perfil
      if (parsed.aiSummary) this.identity.aiSummary = parsed.aiSummary;
      if (parsed.aiShortView) this.identity.aiShortView = parsed.aiShortView;
      if (parsed.convictions && typeof parsed.convictions === 'object') {
        this.identity.convictions = { ...this.identity.convictions, ...parsed.convictions };
      }
      if (parsed.traits && typeof parsed.traits === 'object') {
        this.identity.traits = { ...this.identity.traits, ...parsed.traits };
      }
      if (Array.isArray(parsed.likes)) this.identity.likes = parsed.likes;
      if (Array.isArray(parsed.dislikes)) this.identity.dislikes = parsed.dislikes;
      if (parsed.rawNotes) this.identity.rawNotes = parsed.rawNotes;
      this.identity.lastAIUpdate = new Date().toISOString();

      this.save();
      this.app.log('BOT-PROFILE', `✅ auto-reflexão completa — ${Object.keys(this.identity.convictions).length} convicções, ${Object.keys(this.identity.traits).length} traços`);
    } catch (e) {
      this.app.debug('BOT-PROFILE', `erro na auto-reflexão: ${(e as Error).message}`);
    }
  }
}
