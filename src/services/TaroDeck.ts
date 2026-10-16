/**
 * TaroDeck — baralho de tarô completo (78 cartas).
 *
 * 22 Arcanos Maiores (0-21) + 56 Arcanos Menores (4 naipes × 14 cartas).
 *
 * Cada carta tem:
 *  - nome (BR)
 *  - número (0-21 maiores, 1-14 menores)
 *  - arcana ('major' | 'minor')
 *  - suit (só menores: 'wands' | 'cups' | 'swords' | 'pentacles')
 *  - emoji representativo
 *  - uprightMeaning (1-2 frases — posição normal)
 *  - reversedMeaning (1-2 frases — invertida)
 *  - keywords (3-5 palavras-chave)
 *
 * Tipos de tiragem (spread):
 *  - 'single'               → 1 carta  (carta do dia / pergunta específica)
 *  - 'past-present-future'  → 3 cartas (Passado / Presente / Futuro)
 *  - 'celtic-cross'         → 10 cartas (Cruz Celta — leitura completa)
 *
 * Cada carta sorteada tem 50% de chance de vir invertida (reversed).
 * Sorteio é SEM repetição (sem replacement) — uma carta não sai 2x na mesma tiragem.
 */

export type ArcanaType = 'major' | 'minor';
export type MinorSuit = 'wands' | 'cups' | 'swords' | 'pentacles';
export type CardOrientation = 'upright' | 'reversed';

export interface TarotCard {
  name: string;
  number: number;
  arcana: ArcanaType;
  suit?: MinorSuit;
  emoji: string;
  uprightMeaning: string;
  reversedMeaning: string;
  keywords: string[];
}

export interface DrawnCard {
  card: TarotCard;
  orientation: CardOrientation;
  position: string;
}

export type SpreadType = 'single' | 'past-present-future' | 'celtic-cross';

// ============================================================================
// ARCANOS MAIORES (22 cartas, 0-21) — definidos explicitamente
// ============================================================================

const MAJOR_ARCANA: TarotCard[] = [
  {
    name: 'O Louco',
    number: 0,
    arcana: 'major',
    emoji: '🃏',
    uprightMeaning: 'Novos começos, espontaneidade, salto de fé, liberdade do momento.',
    reversedMeaning: 'Impulsividade, imprudência, risco desnecessário, decidir sem pensar.',
    keywords: ['começo', 'risco', 'espontaneidade', 'liberdade'],
  },
  {
    name: 'O Mago',
    number: 1,
    arcana: 'major',
    emoji: '🪄',
    uprightMeaning: 'Poder, habilidade, concentração. Tudo que você precisa está disponível.',
    reversedMeaning: 'Manipulação, talento desperdiçado, charlatanismo, falta de foco.',
    keywords: ['poder', 'manifestação', 'habilidade', 'foco'],
  },
  {
    name: 'A Sacerdotisa',
    number: 2,
    arcana: 'major',
    emoji: '🌙',
    uprightMeaning: 'Intuição, mistério, subconsciente, sabedoria interior silenciosa.',
    reversedMeaning: 'Segredos, desconexão da intuição, repressão, superficialidade.',
    keywords: ['intuição', 'mistério', 'subconsciente', 'silêncio'],
  },
  {
    name: 'A Imperatriz',
    number: 3,
    arcana: 'major',
    emoji: '👑',
    uprightMeaning: 'Feminilidade, abundância, natureza, criação, nutrir.',
    reversedMeaning: 'Dependência, superproteção, negligência consigo mesma, bloqueio criativo.',
    keywords: ['abundância', 'feminilidade', 'natureza', 'criação'],
  },
  {
    name: 'O Imperador',
    number: 4,
    arcana: 'major',
    emoji: '🏛️',
    uprightMeaning: 'Autoridade, estrutura, controle, liderança firme e estável.',
    reversedMeaning: 'Dominação, rigidez, controle excessivo, tirania, fraqueza de liderança.',
    keywords: ['autoridade', 'estrutura', 'controle', 'liderança'],
  },
  {
    name: 'O Hierofante',
    number: 5,
    arcana: 'major',
    emoji: '⛪',
    uprightMeaning: 'Tradição, religião, ensino, conformidade, sabedoria institucional.',
    reversedMeaning: 'Rebeldia, desafio à tradição, liberdade pessoal, métodos pouco ortodoxos.',
    keywords: ['tradição', 'ensino', 'religião', 'conformidade'],
  },
  {
    name: 'Os Enamorados',
    number: 6,
    arcana: 'major',
    emoji: '💕',
    uprightMeaning: 'Amor, escolha, harmonia, união, alinhamento de valores.',
    reversedMeaning: 'Discórdia, desequilíbrio, escolha difícil, separação, falta de alinhamento.',
    keywords: ['amor', 'escolha', 'harmonia', 'união'],
  },
  {
    name: 'O Carro',
    number: 7,
    arcana: 'major',
    emoji: '⚔️',
    uprightMeaning: 'Vitória, controle, determinação, avançar com força e direção.',
    reversedMeaning: 'Falta de direção, agressividade, perda de controle, dispersão.',
    keywords: ['vitória', 'controle', 'determinação', 'avanço'],
  },
  {
    name: 'A Força',
    number: 8,
    arcana: 'major',
    emoji: '🦁',
    uprightMeaning: 'Coragem, paciência, força interior, domar impulsos com amor.',
    reversedMeaning: 'Fraqueza, auto-dúvida, raiva, força bruta sem sabedoria.',
    keywords: ['coragem', 'paciência', 'força interior', 'domínio'],
  },
  {
    name: 'O Eremita',
    number: 9,
    arcana: 'major',
    emoji: '🕯️',
    uprightMeaning: 'Introspecção, sabedoria, solidão voluntária, busca por respostas internas.',
    reversedMeaning: 'Isolamento, solidão forçada, recusa em buscar conselho.',
    keywords: ['introspecção', 'sabedoria', 'solidão', 'busca'],
  },
  {
    name: 'A Roda da Fortuna',
    number: 10,
    arcana: 'major',
    emoji: '🎡',
    uprightMeaning: 'Destino, mudança, ciclos, sorte, virada de chave.',
    reversedMeaning: 'Má sorte, resistência à mudança, ciclo quebrado, padrões se repetindo.',
    keywords: ['destino', 'ciclos', 'mudança', 'sorte'],
  },
  {
    name: 'A Justiça',
    number: 11,
    arcana: 'major',
    emoji: '⚖️',
    uprightMeaning: 'Verdade, justiça, equilíbrio, consequência, responsabilidade pelos atos.',
    reversedMeaning: 'Injustiça, desonestidade, falta de responsabilidade, desequilíbrio.',
    keywords: ['verdade', 'justiça', 'equilíbrio', 'consequência'],
  },
  {
    name: 'O Enforcado',
    number: 12,
    arcana: 'major',
    emoji: '🙃',
    uprightMeaning: 'Sacrifício voluntário, nova perspectiva, pausa, entrega ao processo.',
    reversedMeaning: 'Stagnação, indecisão, sacrifício inútil, recusa em soltar.',
    keywords: ['sacrifício', 'perspectiva', 'pausa', 'entrega'],
  },
  {
    name: 'A Morte',
    number: 13,
    arcana: 'major',
    emoji: '💀',
    uprightMeaning: 'Transformação, fim de ciclo, renascimento, deixar o velho ir.',
    reversedMeaning: 'Resistência à mudança, estagnação, prender-se ao que já morreu.',
    keywords: ['transformação', 'fim', 'renascimento', 'transição'],
  },
  {
    name: 'A Temperança',
    number: 14,
    arcana: 'major',
    emoji: '🍷',
    uprightMeaning: 'Equilíbrio, moderação, paciência, mistura de opostos com harmonia.',
    reversedMeaning: 'Desequilíbrio, excesso, falta de paciência, autoindulgência.',
    keywords: ['equilíbrio', 'moderação', 'paciência', 'harmonia'],
  },
  {
    name: 'O Diabo',
    number: 15,
    arcana: 'major',
    emoji: '😈',
    uprightMeaning: 'Vícios, materialismo, aprisionamento, paixão obsessiva, tentação.',
    reversedMeaning: 'Libertação, retomar controle, soltar vícios, despertar da ilusão.',
    keywords: ['vícios', 'materialismo', 'aprisionamento', 'tentação'],
  },
  {
    name: 'A Torre',
    number: 16,
    arcana: 'major',
    emoji: '🗼',
    uprightMeaning: 'Ruptura súbita, caos, revelação, estruturas falsas desmoronando.',
    reversedMeaning: 'Ruptura adiada, evitar desastre, resistir à mudança necessária, medo do colapso.',
    keywords: ['ruptura', 'caos', 'revelação', 'desmoronamento'],
  },
  {
    name: 'A Estrela',
    number: 17,
    arcana: 'major',
    emoji: '⭐',
    uprightMeaning: 'Esperança, inspiração, fé, renovação, guia no escuro.',
    reversedMeaning: 'Desesperança, perda de fé, desconexão espiritual, desânimo.',
    keywords: ['esperança', 'inspiração', 'fé', 'renovação'],
  },
  {
    name: 'A Lua',
    number: 18,
    arcana: 'major',
    emoji: '🌕',
    uprightMeaning: 'Ilusão, medo, subconsciente, intuição turva, sonhos e sombras.',
    reversedMeaning: 'Clareza, liberação de medo, verdade revelada, falsas ilusões caindo.',
    keywords: ['ilusão', 'medo', 'subconsciente', 'sombras'],
  },
  {
    name: 'O Sol',
    number: 19,
    arcana: 'major',
    emoji: '☀️',
    uprightMeaning: 'Alegria, sucesso, vitalidade, claridade, otimismo radiante.',
    reversedMeaning: 'Falsa alegria, otimismo temporário, atraso no sucesso, egocentrismo.',
    keywords: ['alegria', 'sucesso', 'vitalidade', 'claridade'],
  },
  {
    name: 'O Julgamento',
    number: 20,
    arcana: 'major',
    emoji: '📯',
    uprightMeaning: 'Renascimento, absolvimento, despertar, chamado à transformação.',
    reversedMeaning: 'Autojulgamento severo, recusa em ouvir o chamado, dúvida interior.',
    keywords: ['renascimento', 'absolvimento', 'despertar', 'chamado'],
  },
  {
    name: 'O Mundo',
    number: 21,
    arcana: 'major',
    emoji: '🌍',
    uprightMeaning: 'Completude, realização, integração, fim de jornada com sucesso.',
    reversedMeaning: 'Incompletude, atraso, quase lá, falta de fechamento.',
    keywords: ['completude', 'realização', 'integração', 'jornada'],
  },
];

// ============================================================================
// ARCANOS MENORES (56 cartas) — gerados por naipe + número/corte
// ============================================================================

interface SuitMeta {
  suit: MinorSuit;
  name: string;          // "Paus", "Copas", "Espadas", "Moedas"
  emoji: string;
  theme: string;         // tema do naipe
  uprightKeywords: string[];
}

const SUITS: SuitMeta[] = [
  {
    suit: 'wands',
    name: 'Paus',
    emoji: '🔥',
    theme: 'ação, paixão, criatividade, iniciativa',
    uprightKeywords: ['iniciativa', 'paixão', 'criatividade', 'energia'],
  },
  {
    suit: 'cups',
    name: 'Copas',
    emoji: '💧',
    theme: 'emoções, relacionamentos, intuição, sentimentos',
    uprightKeywords: ['emoção', 'relacionamento', 'intuição', 'afeto'],
  },
  {
    suit: 'swords',
    name: 'Espadas',
    emoji: '🌬️',
    theme: 'pensamento, conflito, decisões, clareza mental',
    uprightKeywords: ['clareza', 'decisão', 'conflito', 'raciocínio'],
  },
  {
    suit: 'pentacles',
    name: 'Moedas',
    emoji: '🌍',
    theme: 'dinheiro, trabalho, materialidade, segurança',
    uprightKeywords: ['prosperidade', 'trabalho', 'segurança', 'materialidade'],
  },
];

// Numerologia básica pros números 2-10 (1 = Às, tratado separadamente)
const NUMBER_MEANINGS: Record<number, { upright: string; reversed: string }> = {
  1: {  // Às
    upright: 'novo começo, potencial bruto, oportunidade única',
    reversed: 'oportunidade perdida, atraso, potencial desperdiçado, mau começo',
  },
  2: {
    upright: 'parceria, escolha, equilíbrio entre dois',
    reversed: 'desequilíbrio, ruptura, indecisão entre dois caminhos',
  },
  3: {
    upright: 'expansão, celebração, criatividade em grupo',
    reversed: 'dispersão, superação, criação bloqueada por terceiros',
  },
  4: {
    upright: 'estabilidade, fundação, pausa estruturada',
    reversed: 'instabilidade, mudança inesperada, fundação abalada',
  },
  5: {
    upright: 'conflito, transição, ajuste necessário, aprendizado',
    reversed: 'superar conflito, reconciliação, findar a tensão',
  },
  6: {
    upright: 'harmonia, generosidade, reciprocidade, apoio',
    reversed: 'desequilíbrio, dívidas, reciprocidade quebrada, ingratidão',
  },
  7: {
    upright: 'avaliação, reflexão, estratégia, pausa pra pensar',
    reversed: 'confusão, impaciência, máscara, estratégia falha',
  },
  8: {
    upright: 'movimento, progresso, esforço focado, fluidez',
    reversed: 'estagnação, resistência, excesso de controle, paralisia',
  },
  9: {
    upright: 'quase lá, realização, solidez, autonomia',
    reversed: 'quase, mas não ainda, isolamento, fadiga, atraso no final',
  },
  10: {
    upright: 'completude de ciclo, realização, abundância acumulada',
    reversed: 'fim difícil, perda, finalizar mal, transição dolorosa',
  },
};

// Cartas de corte (Pajem, Cavaleiro, Rainha, Rei) — personalidade por naipe
interface CourtMeta {
  number: number;
  name: string;          // "Pajem", "Cavaleiro", "Rainha", "Rei"
  archetype: Record<MinorSuit, { upright: string; reversed: string; keywords: string[] }>;
}

const COURT_CARDS: CourtMeta[] = [
  {
    number: 11,
    name: 'Pajem',
    archetype: {
      wands: {
        upright: 'Jovem entusiasta, explorando novas ideias com energia e curiosidade.',
        reversed: 'Impaciência juvenil, ideias sem ação, dispersão de energia.',
        keywords: ['entusiasmo', 'curiosidade', 'aprendiz', 'exploração'],
      },
      cups: {
        upright: 'Pessoa sensível, mensageiro emocional, abertura afetiva.',
        reversed: 'Imaturidade emocional, ilusão romântica, dependência afetiva.',
        keywords: ['sensibilidade', 'mensagem', 'romance', 'inocência'],
      },
      swords: {
        upright: 'Mente curiosa, vigilância, aprender observando, esperteza jovem.',
        reversed: 'Comunicação confusa, espionagem, fofoca, mentiras pequenas.',
        keywords: ['curiosidade', 'vigilância', 'esperteza', 'aprendizado'],
      },
      pentacles: {
        upright: 'Aprendiz dedicado, estudo de algo material, oportunidade nova chegando.',
        reversed: 'Preguiça, falta de foco nos estudos, oportunidade desperdiçada.',
        keywords: ['aprendizado', 'oportunidade', 'dedicação', 'estudo'],
      },
    },
  },
  {
    number: 12,
    name: 'Cavaleiro',
    archetype: {
      wands: {
        upright: 'Aventureiro impulsivo, persegue ideias com paixão e velocidade.',
        reversed: 'Impulsividade, frustração, energia mal canalizada, ambição cega.',
        keywords: ['aventura', 'impulso', 'paixão', 'movimento'],
      },
      cups: {
        upright: 'Romântico idealista, persegue sonhos e conexões emocionais.',
        reversed: 'Idealismo irreal, decepção romântica, promessas vazias.',
        keywords: ['romance', 'idealismo', 'perseguição', 'sonho'],
      },
      swords: {
        upright: 'Pensador incisivo, comunica com clareza, busca verdade.',
        reversed: 'Comunicação agressiva, argumentos cortantes, indiscrição.',
        keywords: ['comunicação', 'verdade', 'incisão', 'decisão'],
      },
      pentacles: {
        upright: 'Trabalhador focado, constância, construção material gradual.',
        reversed: 'Estagnação no trabalho, apatia, falta de progresso material.',
        keywords: ['trabalho', 'constância', 'foco', 'progresso'],
      },
    },
  },
  {
    number: 13,
    name: 'Rainha',
    archetype: {
      wands: {
        upright: 'Líder carismática, energia criativa, magnetismo pessoal, coragem.',
        reversed: 'Insegurança, ciúme, egoísmo, energia criativa bloqueada.',
        keywords: ['carisma', 'liderança', 'criatividade', 'coragem'],
      },
      cups: {
        upright: 'Emoção profunda, compaixão, intuição feminina, acolhimento.',
        reversed: 'Sensibilidade excessiva, dependência emocional, mágoa acumulada.',
        keywords: ['compaixão', 'intuição', 'acolhimento', 'emoção'],
      },
      swords: {
        upright: 'Mulher lúcida, honestidade afiada, julga com clareza e discernimento.',
        reversed: 'Crueldade, frieza, julgamento severo, palavras que cortam.',
        keywords: ['lucidez', 'honestidade', 'discernimento', 'justiça'],
      },
      pentacles: {
        upright: 'Próspera, generosa, terra fértil, acolhe abundância com cuidado.',
        reversed: 'Materialismo, possessividade, mesquinhez, trabalho sem propósito.',
        keywords: ['prosperidade', 'generosidade', 'acolhimento', 'cuidado'],
      },
    },
  },
  {
    number: 14,
    name: 'Rei',
    archetype: {
      wands: {
        upright: 'Líder visionário, carisma maduro, inspira com força e clareza.',
        reversed: 'Tirania, impaciência, controle excessivo, ambição desmedida.',
        keywords: ['visão', 'liderança', 'carisma', 'inspiração'],
      },
      cups: {
        upright: 'Sábio emocional, equilibra razão e sentimento, diplomacia, acolhimento maduro.',
        reversed: 'Manipulação emocional, volatilidade, frieza sob máscara de afeto.',
        keywords: ['sabedoria', 'equilíbrio', 'diplomacia', 'maturidade'],
      },
      swords: {
        upright: 'Pensador justo, autoridade moral, julga com discernimento e verdade.',
        reversed: 'Manipulação intelectual, tirania fria, julgamento cruel.',
        keywords: ['autoridade', 'justiça', 'verdade', 'discernimento'],
      },
      pentacles: {
        upright: 'Empreendedor maduro, constrói com solidez, gera abundância estável.',
        reversed: 'Materialismo, avareza, ostentação, apego ao status.',
        keywords: ['empreendedorismo', 'estabilidade', 'abundância', 'sólido'],
      },
    },
  },
];

/**
 * Gera todas as 56 cartas menores (4 naipes × 14 cartas: Às, 2-10, Pajem, Cavaleiro, Rainha, Rei).
 */
function buildMinorArcana(): TarotCard[] {
  const cards: TarotCard[] = [];
  for (const suit of SUITS) {
    // Às (número 1)
    cards.push({
      name: `Às de ${suit.name}`,
      number: 1,
      arcana: 'minor',
      suit: suit.suit,
      emoji: suit.emoji,
      uprightMeaning: `${suit.theme}. ${NUMBER_MEANINGS[1].upright.charAt(0).toUpperCase() + NUMBER_MEANINGS[1].upright.slice(1)} — faísca inicial do naipe.`,
      reversedMeaning: `${NUMBER_MEANINGS[1].reversed} — oportunidade do naipe bloqueada ou adiada.`,
      keywords: ['começo', 'potencial', suit.name.toLowerCase(), 'oportunidade'],
    });

    // 2 a 10
    for (let n = 2; n <= 10; n++) {
      const meaning = NUMBER_MEANINGS[n];
      cards.push({
        name: `${n} de ${suit.name}`,
        number: n,
        arcana: 'minor',
        suit: suit.suit,
        emoji: suit.emoji,
        uprightMeaning: `${suit.theme}. ${meaning.upright}.`,
        reversedMeaning: `${meaning.reversed}.`,
        keywords: [String(n), suit.name.toLowerCase(), ...suit.uprightKeywords.slice(0, 2)],
      });
    }

    // Corte (11-14): Pajem, Cavaleiro, Rainha, Rei
    for (const court of COURT_CARDS) {
      const arch = court.archetype[suit.suit];
      cards.push({
        name: `${court.name} de ${suit.name}`,
        number: court.number,
        arcana: 'minor',
        suit: suit.suit,
        emoji: suit.emoji,
        uprightMeaning: arch.upright,
        reversedMeaning: arch.reversed,
        keywords: arch.keywords,
      });
    }
  }
  return cards;
}

// ============================================================================
// POSIÇÕES POR TIPO DE TIRAGEM
// ============================================================================

const SPREAD_POSITIONS: Record<SpreadType, string[]> = {
  'single': [
    'Carta do dia',
  ],
  'past-present-future': [
    'Passado',
    'Presente',
    'Futuro',
  ],
  'celtic-cross': [
    '1. Presente (centro)',
    '2. Desafio (atravessa)',
    '3. Passado recente (base)',
    '4. Fundação (raiz)',
    '5. Passado distante (atrás)',
    '6. Futuro próximo (à frente)',
    '7. Você (postura)',
    '8. Ambiente (ao redor)',
    '9. Esperanças e medos',
    '10. Resultado final',
  ],
};

// ============================================================================
// TARO DECK
// ============================================================================

export class TaroDeck {
  private fullDeck: TarotCard[];

  constructor() {
    this.fullDeck = [...MAJOR_ARCANA, ...buildMinorArcana()];
  }

  /** Total de cartas no baralho (deve ser 78). */
  size(): number {
    return this.fullDeck.length;
  }

  /** Retorna todas as cartas (cópia defensiva). */
  all(): TarotCard[] {
    return [...this.fullDeck];
  }

  /**
   * Sorteia N cartas únicas (sem repetição).
   * Cada carta tem 50% de chance de vir invertida (reversed).
   * Posições genéricas: "1ª carta", "2ª carta", etc.
   */
  draw(count: number): DrawnCard[] {
    const safeCount = Math.max(1, Math.min(count, this.fullDeck.length));
    // Embaralha cópia do baralho (Fisher-Yates)
    const shuffled = [...this.fullDeck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const drawn: DrawnCard[] = [];
    for (let i = 0; i < safeCount; i++) {
      const card = shuffled[i];
      const orientation: CardOrientation = Math.random() < 0.5 ? 'upright' : 'reversed';
      drawn.push({
        card,
        orientation,
        position: `${i + 1}ª carta`,
      });
    }
    return drawn;
  }

  /**
   * Tiragem específica baseada no tipo de spread.
   * Posição vem do SPREAD_POSITIONS (Passado/Presente/Futuro, Cruz Celta, etc).
   */
  drawSpread(spread: SpreadType): DrawnCard[] {
    const positions = SPREAD_POSITIONS[spread];
    const drawn = this.draw(positions.length);
    return drawn.map((d, i) => ({
      ...d,
      position: positions[i] || d.position,
    }));
  }

  /**
   * Formata as cartas sorteadas como texto pro prompt da IA.
   *
   * Exemplo de saída:
   *
   *   Carta 1 (Passado): A Torre (invertida) 🗼
   *     Significado: Ruptura adiada, evitar desastre, resistir à mudança necessária
   *     Keywords: medo de mudança, negação
   *
   *   Carta 2 (Presente): 3 de Copas (normal) 💧
   *     Significado: Celebração, amizade, alegria compartilhada
   *     Keywords: festa, união, diversão
   */
  formatForPrompt(drawn: DrawnCard[]): string {
    const lines: string[] = [];
    drawn.forEach((d, i) => {
      const orientationLabel = d.orientation === 'reversed' ? 'invertida' : 'normal';
      const meaning = d.orientation === 'reversed'
        ? d.card.reversedMeaning
        : d.card.uprightMeaning;
      lines.push(`Carta ${i + 1} (${d.position}): ${d.card.name} (${orientationLabel}) ${d.card.emoji}`);
      lines.push(`  Significado: ${meaning}`);
      lines.push(`  Keywords: ${d.card.keywords.join(', ')}`);
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  /**
   * Formata as cartas como texto legível pra mensagem de WhatsApp (sem prompt extra).
   * Usado pelo comando !taro (sem IA).
   */
  formatForUser(drawn: DrawnCard[], title?: string): string {
    const lines: string[] = [];
    if (title) {
      lines.push(`*${title}*`);
      lines.push('');
    }
    drawn.forEach((d) => {
      const orientationLabel = d.orientation === 'reversed' ? 'invertida' : 'normal';
      const meaning = d.orientation === 'reversed'
        ? d.card.reversedMeaning
        : d.card.uprightMeaning;
      lines.push(`*${d.position}:* ${d.card.emoji} ${d.card.name} _(${orientationLabel})_`);
      lines.push(`${meaning}`);
      lines.push('');
    });
    return lines.join('\n').trim();
  }
}
