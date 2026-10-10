/**
 * Memory — memória permanente (fatos sobre pessoas).
 *
 * Responsabilidades:
 *  - Persistir fatos em data/memories.json (global por usuário, não por chat).
 *  - addMemory(userName, fact, chatId) — com dedup + cap de 30/user.
 *  - buildMemoriesText(recentSenders) — injeta no prompt da IA (com regras de privacidade).
 *  - extractFacts(chatId, senderName, text) — chama Gemini pra extrair fatos de uma msg.
 *  - maybeExtract(chatId, senderName, text) — keyword gate (só extrai se tiver palavra-chave).
 *  - hasKeyword(text) — check rápido (usado por forceReadChatHistory).
 *
 * Formato (preservado do index.js velho):
 *   { "userName": [ { fact, sourceChat, timestamp } ] }
 *
 * PRIVACIDADE (preservada do velho):
 *  - Memórias são GLOBAIS por usuário (acompanham entre PV e grupo).
 *  - MAS o bot é instruído (no buildMemoriesText) a NUNCA revelar onde
 *    aprendeu nem fofocar entre chats.
 *
 * Fixes preservados (do nosso trabalho anterior no index.js):
 *  - extractFacts retorna savedCount (0 se IA disse NENHUM).
 *  - saveMemories() síncrono após cada fato salvo (não espera auto-save 30s).
 */

import type { MarcioApp } from '../MarcioApp';
import fs from 'node:fs';

// ============================================================================
// TIPOS
// ============================================================================

export interface MemoryEntry {
  fact: string;
  sourceChat: string;
  timestamp: string;  // ISO
}

export type MemoriesData = Record<string, MemoryEntry[]>;

// ============================================================================
// REGEX DE KEYWORDS — preservada byte-a-byte do index.js velho
// ============================================================================

/**
 * Detecta palavras-chave que indicam que a msg pode conter info pessoal
 * extraível pra memória permanente. ~200 keywords: identidade, política,
// religião, corpo, idade, localização, trabalho, relacionamento, time,
// hobbies, música, games, pets, saúde, etc.
 */
const MEMORY_KEYWORD_REGEX = /\b(gay|l[ée]sbica|bi|h[ée]tero|trans|n[ãa]o-bin[áa]rio|pansexual|assexual|queer|lgbt|marxist|comunist|socialist|capitalist|liberal|conservador|progressista|esquerd|direit|petist|bolsonarist|evang[ée]lic|cat[óo]lic|esp[íi]rit|umband|candombl[ée]|ateu|agn[óo]stic|budist|judeu|mu[çc]ulman|religi[ãa]o|altura|peso|kg|cm\b|metro|moren|loir|ruiv|branc|pret|pard|magr|gord|fort|frac|barba|bigode|tatuagem|piercing|[óo]culos|cabel|idade|anos|nasci|natural|paulist|carioc|mineir|baian|ga[úu]ch|nordestin|sulist|mor|mud[aei]|cidade|estado|bairro|mudei|interc[âa]mbio|passaporte|visto|trabalho|emprego|trampo|profiss[ãa]o|est[áa]gi|formad|bacharel|t[ée]cnic|dev\b|programador|advogad|m[ée]dic|enfermeir|professor|engenheir|design|desenvolvedor|curs|faculdade|universidade|escola|col[ée]gio|demitid|contratad|sal[áa]ri|promovido|aumento|namor|casad|noiv|divorciad|solteir|marid|mulher|espos|crush|ficante|ex\b|paquera|filh|beb[êe]|gr[áa]vid|pai|m[ãa]e|irm[ãa]|prim|ti[oa]|av[óô]|sogr|time|tor[çc]|corintian|palmeirense|s[ãa]o-paulin|santist|flamenguist|vasc|cruzeirense|atl[ée]tic|gremio|internacional|fluminense|botafog|bahia|vit[óo]ria|futebol|v[óo]lei|basquete|jiu-?jitsu|academia|muscula[çc][ãa]o|crossfit|nata[çc][ãa]o|corrid|ciclism|surf|skate|funk|sertanej|samba|pagode|rock\b|rap\b|trap\b|pop\b|indie|eletr[ôo]nic|jazz|blues|reggae|mpb|forr[óo]|piseiro|arrocha|banda|cantor|cantora|show\b|festival|youtuber|stream|twitch|anime|mang[áa]|comic|hq\b|livr|leio|leitura|escrev|desenh|pintur|fotografia|viaj|acamp|trilh|prai|game|gaming|videogame|playstation|xbox|nintendo|pc\b|steam|minecraft|fortnite|league|valorant|cs\b|dota|vegan|vegetarian|diet|lactose|gl[úu]ten|intoler[âa]nc|alerg|restaurante|cozinh|prato|culin[áa]ri|cachorro|gato|pet\b|bicho|cadela|filhote|aqu[áa]rio|peixe|p[áa]ssar|calopsita|coelh|hamster|carro|mot|biciclet|bike\b|apartament|casa\b|quarto|notebook|computador|celular|iphone|android|samsung|doen[çc]|v[íi]ci|fumante|fumo|bebo|bebida|rem[ée]di|depress[ãa]o|ansiedade|terapia|psic[óo]log|cirurgi|opera[çc][ãa]o|preferid|favorit|paix[ãa]o|obsess[ãa]o|cole[çc][ãa]o|hobby|passatempo|f[ãa] de|f[ãa]-clube|stan\b|shippar|shipper|gosto|gost[aeo]|n[ãa]o gosto|odeio|odi[aeo]|detest|amo|am[ao]\b|vil[ãa]o|her[óo]i|marvel|dc\b|vingador|batman|superman|homem-?aranha|wolverine|formatura|casament|heran[çc]a|d[íi]vid|financiad|compr[aei]|vend[ei])\b/i;

// ============================================================================
// MEMORY
// ============================================================================

export class Memory {
  private app: MarcioApp;
  private cache: MemoriesData | null = null;
  private dirty = false;
  private autoSaveTimer: NodeJS.Timeout | null = null;

  /** Flag runtime-tunable (vira setter quando /admin features memoria off existir). */
  enabled = true;

  constructor(app: MarcioApp) {
    this.app = app;
    // Auto-save a cada 30s se tiver mudança
    this.autoSaveTimer = setInterval(() => {
      if (this.dirty) this.save();
    }, 30000);
  }

  // ===========================================================================
  // LOAD / SAVE (com cache em memória + migração de formato antigo)
  // ===========================================================================

  /**
   * Carrega memories.json (com cache). Faz migração automática se o formato
   * for o antigo (per-chat → global por usuário).
   */
  load(): MemoriesData {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(fs.readFileSync(this.app.dataPath('memories.json'), 'utf8'));
      // Migração: se tem chave com @g.us/@c.us/@lid, é formato antigo (per-chat)
      let needsMigration = false;
      for (const key of Object.keys(raw)) {
        if (key.includes('@g.us') || key.includes('@c.us') || key.includes('@lid')) {
          needsMigration = true;
          break;
        }
      }
      if (needsMigration) {
        const migrated: MemoriesData = {};
        for (const [chatId, users] of Object.entries(raw)) {
          for (const [userName, facts] of Object.entries(users as any)) {
            if (!migrated[userName]) migrated[userName] = [];
            for (const f of facts as any[]) {
              migrated[userName].push({ ...f, sourceChat: chatId });
            }
          }
        }
        this.cache = migrated;
        this.dirty = true;
        this.app.log('MEMORY', `migração: ${Object.keys(migrated).length} usuários migrados de formato per-chat pra global`);
      } else {
        this.cache = raw;
      }
    } catch {
      this.cache = {};
    }
    return this.cache!;
  }

  /**
   * Salva memories.json em disco. Síncrono.
   */
  save(): void {
    try {
      fs.writeFileSync(this.app.dataPath('memories.json'), JSON.stringify(this.cache, null, 2), 'utf8');
      this.dirty = false;
    } catch (e) {
      this.app.debug('MEMORY', `erro ao salvar memórias: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // ADD / GET
  // ===========================================================================

  /**
   * Adiciona um fato permanente sobre uma pessoa.
   *  - Dedup: se o fato (ou substring) já existe, não adiciona.
   *  - Cap: 30 fatos por pessoa (remove os mais antigos).
   *  - Marca dirty (auto-save em 30s).
   */
  add(chatId: string, userName: string, fact: string): void {
    const memories = this.load();
    if (!memories[userName]) memories[userName] = [];

    const exists = memories[userName].some(m =>
      m.fact.toLowerCase().includes(fact.toLowerCase()) ||
      fact.toLowerCase().includes(m.fact.toLowerCase())
    );
    if (!exists) {
      memories[userName].push({
        fact,
        sourceChat: chatId,
        timestamp: new Date().toISOString(),
      });
      if (memories[userName].length > 30) {
        memories[userName] = memories[userName].slice(-30);
      }
      this.dirty = true;
      this.app.debug('MEMORY', `fato salvo: ${userName} — "${fact}" (origem: ${chatId})`);
    }
  }

  /**
   * Retorna os fatos de um usuário (ou array vazio).
   */
  forUser(userName: string): MemoryEntry[] {
    return this.load()[userName] ?? [];
  }

  /**
   * Remove todas as memórias de um usuário. Retorna quantas removeu.
   */
  clearUser(userName: string): number {
    const memories = this.load();
    const count = memories[userName]?.length ?? 0;
    if (count > 0) {
      delete memories[userName];
      this.dirty = true;
      this.save();
    }
    return count;
  }

  /**
   * Lista todos os usuários com memórias.
   */
  allUsers(): string[] {
    return Object.keys(this.load());
  }

  // ===========================================================================
  // BUILD TEXT (pra injetar no prompt da IA)
  // ===========================================================================

  /**
   * Monta o texto das memórias pra injetar no contexto da IA.
   * GLOBAL — fatos do PV aparecem no grupo e vice-versa.
   * MAS com regra CRÍTICA de privacidade: nunca revelar origem, nunca fofocar.
   *
   * @param recentSenders Nomes dos usuários ativos no chat recentemente.
   * @returns String formatada ou '' se ninguém tiver memórias.
   */
  buildText(recentSenders: string[]): string {
    const memories = this.load();
    const lines = [
      'MEMÓRIAS (fatos que você sabe sobre essas pessoas — use pra contextualizar):',
      '⚠️ PRIVACIDADE: NUNCA revele onde aprendeu essas informações. NUNCA fofogue fatos de um grupo em outro. Use só pra CONHECER a pessoa, nunca pra expor.',
      '',
    ];
    let hasAny = false;
    for (const sender of recentSenders) {
      const userMemories = memories[sender];
      if (userMemories && userMemories.length > 0) {
        const recentFacts = userMemories.slice(-5).map(m => m.fact);
        lines.push(`• ${sender}: ${recentFacts.join('; ')}`);
        hasAny = true;
      }
    }
    if (!hasAny) return '';
    return lines.join('\n');
  }

  // ===========================================================================
  // KEYWORD CHECK
  // ===========================================================================

  /**
   * Check rápido: a msg tem alguma palavra-chave de info pessoal?
   * Usado pelo forceReadChatHistory (pra decidir se agenda extração).
   */
  hasKeyword(text: string): boolean {
    return MEMORY_KEYWORD_REGEX.test(text.toLowerCase());
  }

  // ===========================================================================
  // MAYBE EXTRACT — chamado pelo Context.captureMessage pra cada msg nova
  // ===========================================================================

  /**
   * Gate de extração de memória. Rodda SEMPRE (mesmo com IA desligada/mutada),
   * mas só chama extractFacts se:
   *  - memory tá enabled
   *  - text >= 5 chars
   *  - não é placeholder ([mandou figurinha], [CONTEÚDO DO LINK])
   *  - tem keyword de info pessoal
   *
   * É async mas o caller NÃO precisa await — roda em background.
   */
  async maybeExtract(chatId: string, senderName: string, text: string): Promise<void> {
    if (!this.enabled) return;
    if (!text || text.length < 5) return;
    if (/^\[(mandou|CONTEÚDO|respondendo)/.test(text)) return;
    if (!this.hasKeyword(text)) return;

    this.app.debug('MEMORY', `palavra-chave detectada em msg de ${senderName}: "${text.slice(0, 60)}..." — extraindo`);
    try {
      const count = await this.extractFacts(chatId, senderName, text);
      if (count > 0) {
        this.app.debug('MEMORY', `${count} fato(s) extraído(s) de ${senderName} em ${chatId}`);
      }
    } catch (e) {
      this.app.debug('MEMORY', `erro na extração de memória: ${(e as Error).message}`);
    }
  }

  // ===========================================================================
  // EXTRACT FACTS — chama Gemini (ou OpenAI) pra extrair fatos de uma msg
  // ===========================================================================

  /**
   * Usa a IA pra extrair FATOS PERMANENTES sobre uma pessoa a partir de uma msg.
   * ASYNC. Usa uma array SEPARADA (system prompt + msg isolada), sem tocar no
   * contexto acumulado do chat.
   *
   * @returns Número de fatos efetivamente salvos (0 se IA disse NENHUM).
   */
  async extractFacts(chatId: string, senderName: string, text: string): Promise<number> {
    const aiConfig = this.app.aiConfig;
    if (!aiConfig || !aiConfig.enabled) return 0;
    if (!text || text.length < 5) return 0;
    if (/^\[(mandou|CONTEÚDO)/.test(text)) return 0;

    const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

    const systemPrompt = [
      'Extraia fatos PERMANENTES sobre a pessoa que enviou a mensagem.',
      'Responda com UM fato por linha. Se não há fatos, responda: NENHUM',
      '',
      'Exemplos do que extrair:',
      '- "tenho 1,80m" -> "tem 1,80m de altura"',
      '- "peso 80kg" -> "pesa 80kg"',
      '- "moro em SP" -> "mora em São Paulo"',
      '- "trabalho como dev" -> "trabalha como desenvolvedor"',
      '- "sou corintiano" -> "é corintiano"',
      '- "tenho 20 anos" -> "tem 20 anos"',
      '- "namoro a Maria" -> "namora a Maria"',
      '',
      'NÃO extrair: opiniões, estados temporários, ironia óbvia.',
      'Se há dúvida, extraia — é melhor ter o fato que não ter.',
    ].join('\n');
    const userContent = `Mensagem de ${senderName}: "${text}"`;

    let content: string | undefined;

    if (provider === 'gemini') {
      // === FORMATO GEMINI ===
      const geminiUrl = `${aiConfig.apiUrl.replace(/\/+$/, '')}/${aiConfig.model}:generateContent?key=${aiConfig.apiKey}`;
      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: userContent }] }],
          systemInstruction: { parts: [{ text: systemPrompt }] },
          generationConfig: {
            maxOutputTokens: 150,
            temperature: 0.1,  // baixa temperatura = extração mais determinística
          },
        }),
      });
      if (!geminiResponse.ok) {
        const errText = await geminiResponse.text();
        throw new Error(`Gemini API ${geminiResponse.status}: ${errText.slice(0, 200)}`);
      }
      const geminiData = await geminiResponse.json() as any;
      content = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error('Resposta vazia da Gemini API');
    } else {
      // === FORMATO OPENAI (Ollama, Groq, OpenRouter, etc.) ===
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (aiConfig.apiKey) {
        headers['Authorization'] = `Bearer ${aiConfig.apiKey}`;
      }
      const response = await fetch(aiConfig.apiUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: aiConfig.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          max_tokens: 150,
          temperature: 0.1,
        }),
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
      }
      const data = await response.json() as any;
      content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('Resposta vazia da API');
    }

    // Parseia: uma linha por fato. "NENHUM" ou vazio = nada a salvar.
    const trimmed = (content || '').trim();
    this.app.debug('MEMORY', `resposta da extração de ${senderName}: "${trimmed.slice(0, 100)}"`);
    if (!trimmed || trimmed.toUpperCase() === 'NENHUM') return 0;

    const facts = trimmed
      .split('\n')
      .map(line => line.replace(/^[-•*\d.\s)]+/, '').trim())  // remove bullets/numeração
      .filter(line => line.length > 0 && line.toUpperCase() !== 'NENHUM')
      .filter((line, i, arr) => arr.indexOf(line) === i);  // dedup dentro da mesma resposta

    let savedCount = 0;
    for (const fact of facts) {
      const cleanFact = fact.length > 200 ? fact.slice(0, 200) + '...' : fact;
      const before = (this.load()[senderName] || []).length;
      this.add(chatId, senderName, cleanFact);
      const after = (this.load()[senderName] || []).length;
      if (after > before) savedCount++;
    }

    if (savedCount > 0) {
      // Salva IMEDIATAMENTE em disco — não espera o auto-save de 30s.
      // Protege contra restart do bot no meio da janela de 30s.
      this.save();
    }
    return savedCount;
  }

  // ===========================================================================
  // SHUTDOWN
  // ===========================================================================

  /**
   * Salva pendências e para o auto-save timer. Chamado no app.shutdown().
   */
  destroy(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.dirty) this.save();
  }
}
