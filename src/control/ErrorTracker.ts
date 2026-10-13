/**
 * ErrorTracker — sistema central de captura e persistência de erros.
 *
 * Responsabilidades:
 *  - Captura erros de qualquer subsistema (chamada explícita via app.errors.report())
 *  - Captura unhandledRejections e uncaughtExceptions do Node.js
 *  - Persiste erros em data/error-log.json (rotativo — últimos 100)
 *  - Classifica severidade (info/warn/error/critical)
 *  - Detecta erros recorrentes (mesma mensagem repetindo)
 *  - Permite listar/limpar erros via ControlPanel (GET/DELETE /api/errors)
 *  - Notifica o painel em tempo real via WebSocket (broadcast 'error')
 *
 * NÃO substitui o this.app.log() — logs são pra auditoria técnica.
 * ErrorTracker é pra mostrar pro usuário "o que deu errado" em linguagem clara.
 *
 * === Como usar ===
 *   // Em qualquer lugar do código:
 *   this.app.errors.report('IA', 'Falha ao contactar Gemini', err, {
 *     userMessage: 'A IA não respondeu. Verifique sua chave de API no painel.',
 *     severity: 'error',
 *   });
 *
 *   // Erros críticos (bot pra de funcionar):
 *   this.app.errors.report('FATAL', 'WhatsApp caiu e não reconecta', err, {
 *     severity: 'critical',
 *   });
 */

import type { MarcioApp } from '../MarcioApp';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// TIPOS
// ============================================================================

export type ErrorSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface TrackedError {
  id: string;            // UUID curto pra dedupe
  timestamp: string;     // ISO 8601
  tag: string;           // categoria: 'IA', 'WA', 'VAULT', 'BOT', etc.
  message: string;       // mensagem técnica curta (ex: "Gemini returned 429")
  userMessage?: string;  // mensagem amigável (ex: "IA rate limited — aguarde 60s")
  severity: ErrorSeverity;
  stack?: string;        // stack trace (se erro real)
  context?: Record<string, any>; // info extra (chatId, model, etc.)
  count: number;         // quantas vezes esse erro ocorreu (dedupe)
  lastSeen: number;     // epoch ms — última vez que ocorreu
}

// ============================================================================
// CONFIG
// ============================================================================

const MAX_ERRORS = 100;             // guarda últimos 100 erros
const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5min — se mesmo erro repete dentro de 5min, incrementa count

// ============================================================================
// ERROR TRACKER
// ============================================================================

export class ErrorTracker {
  private app: MarcioApp;
  private errors: TrackedError[] = [];
  private loaded = false;

  constructor(app: MarcioApp) {
    this.app = app;
  }

  /** Inicializa — carrega erros salvos + instala handlers globais. */
  init(): void {
    this.load();
    this.installGlobalHandlers();
    this.app.debug('ERROR', `ErrorTracker inicializado — ${this.errors.length} erro(s) carregado(s) do disco`);
  }

  /** Caminho do arquivo de erros persistido. */
  private get filePath(): string {
    return this.app.dataPath('error-log.json');
  }

  /** Carrega erros do disco (se existir). */
  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          this.errors = parsed.slice(0, MAX_ERRORS);
        }
      }
    } catch (e) {
      // Se o arquivo tá corrompido, começa vazio — não trava o app
      this.app.debug('ERROR', `não conseguiu carregar error-log.json: ${(e as Error).message}`);
    }
    this.loaded = true;
  }

  /** Salva erros no disco (debounce pra não ficar escrevendo a cada erro). */
  private saveTimeout: NodeJS.Timeout | null = null;
  private scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveNow();
      this.saveTimeout = null;
    }, 1000);
  }

  /** Salva erros imediatamente (sync). */
  private saveNow(): void {
    try {
      const content = JSON.stringify(this.errors.slice(0, MAX_ERRORS), null, 2);
      fs.writeFileSync(this.filePath, content, 'utf8');
    } catch (e) {
      // Se não conseguir salvar, loga mas não propaga
      this.app.debug('ERROR', `não conseguiu salvar error-log.json: ${(e as Error).message}`);
    }
  }

  /** Instala handlers globais pra capturar erros não tratados. */
  private installGlobalHandlers(): void {
    process.on('unhandledRejection', (reason, promise) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      this.report('UNHANDLED', `Promise rejeitada: ${msg}`, reason instanceof Error ? reason : undefined, {
        userMessage: 'Erro interno — promise não tratada. Verifique os logs.',
        severity: 'error',
        context: { stack },
      });
    });

    process.on('uncaughtException', (err: Error) => {
      this.report('UNCAUGHT', `Exceção não capturada: ${err.message}`, err, {
        userMessage: 'Erro crítico interno. O bot pode estar instável.',
        severity: 'critical',
      });
      // NÃO chama process.exit() — deixa o Node decidir (Tauri reinicia se necessário)
      // Mas registra no log também (pra aparecer no arquivo de log)
      try {
        this.app.log('FATAL', `UNCAUGHT EXCEPTION: ${err.message}\n${err.stack || ''}`);
      } catch { /* ignora */ }
    });
  }

  /**
   * Reporta um erro.
   * @param tag Categoria (IA, WA, VAULT, BOT, etc.)
   * @param message Mensagem técnica curta
   * @param error Erro original (opcional)
   * @param options userMessage, severity, context
   */
  report(
    tag: string,
    message: string,
    error?: Error | unknown,
    options: { userMessage?: string; severity?: ErrorSeverity; context?: Record<string, any> } = {}
  ): void {
    const severity = options.severity || 'error';
    const err = error instanceof Error ? error : (error ? new Error(String(error)) : undefined);
    const stack = err?.stack;
    const userMessage = options.userMessage;
    const context = options.context;

    // Dedupe: se mesmo erro (tag + message) ocorreu nos últimos 5min, só incrementa count
    const now = Date.now();
    const existing = this.errors.find(e =>
      e.tag === tag && e.message === message && (now - e.lastSeen) < DEDUPE_WINDOW_MS
    );

    if (existing) {
      existing.count++;
      existing.lastSeen = now;
      existing.severity = severity; // atualiza severidade caso tenha piorado
      if (userMessage) existing.userMessage = userMessage;
      if (context) existing.context = { ...existing.context, ...context };
    } else {
      const newError: TrackedError = {
        id: `${now}_${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        tag,
        message,
        userMessage,
        severity,
        stack,
        context,
        count: 1,
        lastSeen: now,
      };
      this.errors.unshift(newError); // mais recente no topo
      // Mantém só os últimos MAX_ERRORS
      if (this.errors.length > MAX_ERRORS) {
        this.errors = this.errors.slice(0, MAX_ERRORS);
      }
    }

    // Salva no disco (debounced)
    this.scheduleSave();

    // Loga no sistema de logs tradicional também (pra auditoria)
    const logTag = severity === 'critical' ? 'FATAL' : severity === 'error' ? 'ERROR' : severity === 'warn' ? 'WARN' : 'INFO';
    const logMsg = userMessage ? `${tag}: ${message} | ${userMessage}` : `${tag}: ${message}`;
    try {
      this.app.log(logTag, logMsg);
    } catch { /* evita recursão se app.log falhar */ }

    // Broadcast pro painel (tempo real)
    if (this.app.control) {
      this.app.control.broadcast('error', {
        tag,
        message,
        userMessage,
        severity,
        timestamp: new Date().toISOString(),
      });
    }

    // Notificação nativa pra erros críticos
    if (severity === 'critical' && this.app.control) {
      try {
        this.app.control.broadcast('notification', {
          title: `❌ ${tag}: erro crítico`,
          body: userMessage || message.slice(0, 100),
        });
      } catch { /* ignora */ }
    }
  }

  /** Lista erros (mais recente primeiro). */
  list(): TrackedError[] {
    return [...this.errors];
  }

  /** Limpa todos os erros. */
  clear(): void {
    this.errors = [];
    this.saveNow();
    this.app.debug('ERROR', 'error-log limpo pelo usuário');
  }

  /** Limpa erros antigos (mais de X dias). */
  clearOlderThan(days: number): number {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    const before = this.errors.length;
    this.errors = this.errors.filter(e => e.lastSeen > cutoff);
    const removed = before - this.errors.length;
    if (removed > 0) {
      this.saveNow();
      this.app.debug('ERROR', `limpeza: removeu ${removed} erro(s) com mais de ${days} dia(s)`);
    }
    return removed;
  }

  /** Conta erros por severidade. */
  countBySeverity(): Record<ErrorSeverity, number> {
    const counts: Record<ErrorSeverity, number> = { info: 0, warn: 0, error: 0, critical: 0 };
    for (const e of this.errors) {
      counts[e.severity]++;
    }
    return counts;
  }

  /** Retorna o resumo do estado de saúde — pra UI de diagnóstico. */
  healthSummary(): {
    totalErrors: number;
    criticalCount: number;
    errorCount: number;
    warnCount: number;
    infoCount: number;
    mostRecentError: TrackedError | null;
    oldestErrorAge: number | null; // ms desde o erro mais antigo
  } {
    const counts = this.countBySeverity();
    const mostRecentError = this.errors[0] || null;
    const oldestError = this.errors[this.errors.length - 1];
    const oldestErrorAge = oldestError ? (Date.now() - oldestError.lastSeen) : null;
    return {
      totalErrors: this.errors.length,
      criticalCount: counts.critical,
      errorCount: counts.error,
      warnCount: counts.warn,
      infoCount: counts.info,
      mostRecentError,
      oldestErrorAge,
    };
  }

  /** Exporta erros em texto formatado (pra "Copiar tudo" no painel). */
  toText(): string {
    const lines: string[] = [];
    lines.push('=== Márcio App — Log de Erros ===');
    lines.push(`Gerado em: ${new Date().toISOString()}`);
    lines.push(`Total de erros: ${this.errors.length}`);
    lines.push('');
    for (const e of this.errors) {
      lines.push(`[${e.timestamp}] [${e.severity.toUpperCase()}] [${e.tag}] ${e.message}`);
      if (e.userMessage) lines.push(`  → ${e.userMessage}`);
      if (e.count > 1) lines.push(`  (ocorreu ${e.count} vezes)`);
      if (e.context) lines.push(`  Contexto: ${JSON.stringify(e.context)}`);
      if (e.stack) {
        // Pega só as primeiras 5 linhas do stack pra não inflar
        const stackLines = e.stack.split('\n').slice(0, 5).join('\n');
        lines.push(`  Stack:\n${stackLines}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }
}
