/**
 * FeatureFlags — sistema de controle de features por canal (dev/beta/stable).
 *
 * Responsabilidades:
 *  - Detectar canal atual: 'dev' | 'beta' | 'stable'
 *  - Listar features disponíveis em cada canal
 *  - Mascarar botões/opções que não devem aparecer em release estável
 *  - Permitir menu secreto de testes (Konami code) só em dev/beta
 *
 * === COMO DETECTAR O CANAL ===
 *  1. NODE_ENV=development → 'dev' (npm run dev)
 *  2. Versão contém "-beta" ou "-rc" → 'beta' (ex: 1.0.2-beta.1)
 *  3. Caso contrário → 'stable' (produção)
 *
 * === COMO USAR NO FRONTEND ===
 *  GET /api/feature-flags → retorna { channel, features: {...} }
 *  Cada botão que precisa ser mascarado recebe:
 *    data-feature="dev-only" | data-feature="dev,beta" | data-feature="secret"
 *  O JS remove da DOM os elementos cujo data-feature não bate com o canal atual.
 *
 * === MENU SECRETO ===
 *  Em dev/beta: Konami code (↑↑↓↓←→←→BA) ou 7 cliques no logo abre o menu secreto.
 *  Em stable: menu secreto NÃO existe — código é totalmente removido da DOM.
 */

export type ReleaseChannel = 'dev' | 'beta' | 'stable';

export interface FeatureFlagsConfig {
  channel: ReleaseChannel;
  features: Record<string, boolean>;
}

// ============================================================================
// FEATURES — definição central
// ============================================================================
// Cada feature tem:
//  - description: o que ela faz
//  - channels: em quais canais ela aparece
//  - secret: se é parte do menu secreto (só aparece depois do Konami code)
export const FEATURE_DEFINITIONS: Record<string, {
  description: string;
  channels: ReleaseChannel[];
  secret?: boolean;
}> = {
  // === DEV-ONLY ===
  'open-setup-wizard-preview': {
    description: 'Abrir setup wizard em modo preview (não salva dados)',
    channels: ['dev'],
  },
  'reset-setup-state': {
    description: 'Resetar setup-state.json (força mostrar wizard na próxima vez)',
    channels: ['dev', 'beta'],
  },
  'force-ia-offline': {
    description: 'Forçar IA offline (testar fallback)',
    channels: ['dev'],
    secret: true,
  },
  'force-wa-disconnect': {
    description: 'Simular desconexão do WhatsApp',
    channels: ['dev'],
    secret: true,
  },
  'inject-test-error': {
    description: 'Injetar erro de teste no ErrorTracker',
    channels: ['dev', 'beta'],
    secret: true,
  },
  'clear-all-memories': {
    description: 'Limpar TODAS as memórias (perigoso!)',
    channels: ['dev'],
    secret: true,
  },
  'clear-all-stickers': {
    description: 'Limpar TODAS as figurinhas (perigoso!)',
    channels: ['dev'],
    secret: true,
  },

  // === DEV + BETA ===
  'debug-flags-panel': {
    description: 'Painel de feature flags visível',
    channels: ['dev', 'beta'],
  },
  'test-notification': {
    description: 'Botão de testar notificação nativa',
    channels: ['dev', 'beta'],
  },
  'force-error-report': {
    description: 'Forçar report de erro no ErrorTracker',
    channels: ['dev', 'beta'],
    secret: true,
  },

  // === ESTÁVEL ===
  'check-changelog': {
    description: 'Ver changelog',
    channels: ['dev', 'beta', 'stable'],
  },
  'check-updates': {
    description: 'Verificar atualizações',
    channels: ['dev', 'beta', 'stable'],
  },
  'open-backup-section': {
    description: 'Seção de backup',
    channels: ['dev', 'beta', 'stable'],
  },
};

// ============================================================================
// FEATURE FLAGS
// ============================================================================

export class FeatureFlags {
  private channel: ReleaseChannel;
  private cached: FeatureFlagsConfig | null = null;

  constructor() {
    this.channel = this.detectChannel();
  }

  /**
   * Detecta o canal atual baseado em:
   *  1. NODE_ENV=development → dev
   *  2. Versão contém -beta/-rc → beta
   *  3. Caso contrário → stable
   *
   * NOTA: Como npm scripts não setam NODE_ENV automaticamente, também verificamos:
   *  - Se process.execPath contém "tsx" → dev (rodando via tsx watch)
   *  - Se process.env.MARCIO_DEV === '1' → dev (override manual)
   *  - Se existe .ts (não .js) no rootDir → dev (ainda em TypeScript)
   */
  private detectChannel(): ReleaseChannel {
    // 1. NODE_ENV explícito
    if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev') {
      return 'dev';
    }

    // 1.5. Override manual via env
    if (process.env.MARCIO_DEV === '1') {
      return 'dev';
    }

    // 2. Versão contém pre-release tag (formato semver: X.Y.Z-pre)
    // Detecta qualquer coisa depois do hífen: -beta, -rc, -alpha, -1 (numérico)
    const version = this.readVersion();
    const dashIdx = version.indexOf('-');
    if (dashIdx >= 0 && dashIdx < version.length - 1) {
      // Tem algo depois do hífen → é pre-release → canal beta
      return 'beta';
    }

    // 2.5. Versão tem 4 partes numéricas (ex: 1.0.3.1 = beta 1)
    // Formato alternativo (MSI legacy). Não usado mais, mas mantém por segurança.
    const parts = version.split('.');
    if (parts.length >= 4) {
      const fourth = parseInt(parts[3].replace(/\D/g, '')) || 0;
      if (fourth > 0) return 'beta';
    }

    // 3. Detecta se tá rodando via tsx (dev mode)
    // Em produção, o bot roda via `node dist/bot.js` (compilado).
    // Em dev, roda via `tsx watch src/bot.ts`.
    const execPath = process.execPath.toLowerCase();
    if (execPath.includes('tsx') || process.argv.some(a => a.includes('tsx') || a.endsWith('.ts'))) {
      return 'dev';
    }

    // 4. Default: stable
    return 'stable';
  }

  /**
   * Lê versão do package.json (cacheada).
   */
  private _cachedVersion: string | null = null;
  private readVersion(): string {
    if (this._cachedVersion) return this._cachedVersion;
    try {
      // Tenta ler package.json do cwd (funciona em dev e produção)
      const pkg = JSON.parse(require('fs').readFileSync(require('path').join(process.cwd(), 'package.json'), 'utf8'));
      this._cachedVersion = pkg.version || '1.0.0';
    } catch {
      try {
        // Fallback: rootDir do MarcioApp (passado via env se disponível)
        const rootDir = process.env.MARCIO_ROOT_DIR || process.cwd();
        const pkg = JSON.parse(require('fs').readFileSync(require('path').join(rootDir, 'package.json'), 'utf8'));
        this._cachedVersion = pkg.version || '1.0.0';
      } catch {
        this._cachedVersion = '1.0.0';
      }
    }
    return this._cachedVersion;
  }

  /**
   * Retorna o canal atual.
   */
  getChannel(): ReleaseChannel {
    return this.channel;
  }

  /**
   * Verifica se uma feature está disponível no canal atual.
   */
  isEnabled(featureName: string): boolean {
    const def = FEATURE_DEFINITIONS[featureName];
    if (!def) return false;
    return def.channels.includes(this.channel);
  }

  /**
   * Verifica se uma feature é secreta (só acessível via Konami code).
   */
  isSecret(featureName: string): boolean {
    const def = FEATURE_DEFINITIONS[featureName];
    if (!def) return false;
    return !!def.secret;
  }

  /**
   * Retorna a config completa (cacheada) — pra endpoint /api/feature-flags.
   */
  getConfig(): FeatureFlagsConfig {
    if (this.cached) return this.cached;
    const features: Record<string, boolean> = {};
    for (const [name, def] of Object.entries(FEATURE_DEFINITIONS)) {
      // Pra features secretas: só retorna true se canal permitir AND não é stable
      // (em stable, features secretas são totalmente removidas)
      if (def.secret && this.channel === 'stable') {
        features[name] = false;
      } else {
        features[name] = def.channels.includes(this.channel);
      }
    }
    this.cached = {
      channel: this.channel,
      features,
    };
    return this.cached;
  }

  /**
   * Lista features secretas disponíveis no canal atual (pra menu secreto).
   */
  listSecretFeatures(): string[] {
    if (this.channel === 'stable') return []; // menu secreto não existe em stable
    return Object.entries(FEATURE_DEFINITIONS)
      .filter(([_, def]) => def.secret && def.channels.includes(this.channel))
      .map(([name]) => name);
  }

  /**
   * Força re-detectar canal (pra testar).
   */
  refresh(): void {
    this.channel = this.detectChannel();
    this.cached = null;
    this._cachedVersion = null;
  }
}
