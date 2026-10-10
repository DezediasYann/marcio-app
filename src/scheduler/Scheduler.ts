/**
 * Scheduler — agendador de eventos/lembretes.
 *
 * Persiste eventos em data/events.json e dispara lembretes no horário
 * marcado. Usado por /evento e /lembrete (AssistiveCommands).
 *
 * === FUNCIONAMENTO ===
 *  - start() carrega events.json e starta um setInterval de 60s que chama tick().
 *    Também roda um tick inicial pra disparar eventos vencidos durante o
 *    downtime (bot desligado).
 *  - schedule(chatId, text, fireAt) adiciona um evento, salva em disco, retorna
 *    o id (crypto.randomUUID()).
 *  - cancel(id) remove um evento pelo id.
 *  - list(chatId?) lista eventos (opcionalmente filtrados por chat).
 *  - tick() percorre eventos, dispara os vencidos (via app.notify com prefixo
 *    "🔔 Lembrete: "), marca fired=true, e remove eventos disparados há mais
 *    de 24h (pra manter o arquivo enxuto).
 *  - destroy() limpa o timer (chamado no app.shutdown()).
 *
 * === FORMATO (data/events.json) ===
 *  Array de ScheduledEvent:
 *    { id, chatId, text, fireAt, fired, createdAt }
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.dataPath('events.json') — caminho do arquivo de persistência
 *  - this.app.notify(chatId, text)     — envio do lembrete (prefixo "🔔 Lembrete: ")
 *  - this.app.log / this.app.debug     — logs
 */

import type { MarcioApp } from '../MarcioApp';
import fs from 'node:fs';
import crypto from 'node:crypto';

// ============================================================================
// TIPOS
// ============================================================================

export interface ScheduledEvent {
  /** UUID único (crypto.randomUUID()). */
  id: string;
  /** ID do chat onde o lembrete deve ser enviado. */
  chatId: string;
  /** Texto do lembrete. */
  text: string;
  /** Epoch ms quando o lembrete deve disparar. */
  fireAt: number;
  /** True depois que o lembrete foi enviado. */
  fired: boolean;
  /** ISO timestamp de criação. */
  createdAt: string;
}

// ============================================================================
// SCHEDULER
// ============================================================================

export class Scheduler {
  private app: MarcioApp;
  private events: ScheduledEvent[] = [];
  private timer: NodeJS.Timeout | null = null;

  /** Intervalo do tick (60s). */
  private readonly TICK_INTERVAL_MS = 60_000;
  /** Eventos disparados há mais que isso são descartados no cleanup. */
  private readonly CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

  constructor(app: MarcioApp) {
    this.app = app;
  }

  // ===========================================================================
  // CICLO DE VIDA
  // ===========================================================================

  /**
   * Carrega events.json e starta o intervalo de tick (60s). Também roda um
   * tick imediatamente pra disparar eventos que venceram enquanto o bot
   * estava desligado.
   */
  start(): void {
    this.load();

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.timer = setInterval(() => {
      this.tick().catch(err => {
        this.app.log('SCHEDULER', `erro no tick: ${(err as Error).message}`);
      });
    }, this.TICK_INTERVAL_MS);

    // Tick inicial — dispara eventos vencidos durante o downtime.
    this.tick().catch(err => {
      this.app.log('SCHEDULER', `erro no tick inicial: ${(err as Error).message}`);
    });

    const pending = this.events.filter(e => !e.fired).length;
    this.app.log('SCHEDULER', `inicializado — ${this.events.length} evento(s) carregado(s) (${pending} pendente(s)).`);
  }

  /**
   * Limpa o timer. Chamado no app.shutdown().
   */
  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ===========================================================================
  // API PÚBLICA — schedule / cancel / list
  // ===========================================================================

  /**
   * Agenda um evento. Salva em disco imediatamente.
   * @returns ID único do evento (pra cancelar depois).
   */
  schedule(chatId: string, text: string, fireAt: number): string {
    const event: ScheduledEvent = {
      id: crypto.randomUUID(),
      chatId,
      text,
      fireAt,
      fired: false,
      createdAt: new Date().toISOString(),
    };
    this.events.push(event);
    this.save();
    this.app.debug('SCHEDULER', `evento agendado: id=${event.id} chat=${chatId} fireAt=${new Date(fireAt).toISOString()} text="${text}"`);
    return event.id;
  }

  /**
   * Cancela um evento pelo ID.
   * @returns true se removeu, false se não existia.
   */
  cancel(id: string): boolean {
    const idx = this.events.findIndex(e => e.id === id);
    if (idx === -1) return false;
    this.events.splice(idx, 1);
    this.save();
    this.app.debug('SCHEDULER', `evento cancelado: ${id}`);
    return true;
  }

  /**
   * Lista eventos. Se chatId for informado, filtra só desse chat.
   * Retorna uma cópia (modificações não afetam o estado interno).
   */
  list(chatId?: string): ScheduledEvent[] {
    if (chatId) {
      return this.events.filter(e => e.chatId === chatId);
    }
    return [...this.events];
  }

  // ===========================================================================
  // TICK — dispara eventos vencidos e faz cleanup
  // ===========================================================================

  /**
   * Verifica eventos vencidos, dispara (via app.notify), marca fired=true,
   * e remove eventos disparados há mais de 24h. Erros ao disparar um evento
   * específico NÃO derrubam o tick — o evento fica não-fired e tenta de novo
   * no próximo tick.
   */
  private async tick(): Promise<void> {
    const now = Date.now();
    let dirty = false;

    // 1. Dispara eventos vencidos
    for (const event of this.events) {
      if (event.fired) continue;
      if (event.fireAt <= now) {
        try {
          await this.app.notify(event.chatId, '🔔 Lembrete: ' + event.text);
          event.fired = true;
          dirty = true;
          this.app.debug('SCHEDULER', `evento disparado: id=${event.id} chat=${event.chatId} text="${event.text}"`);
        } catch (err) {
          // Não marca fired — tenta de novo no próximo tick.
          this.app.log('SCHEDULER', `erro ao disparar evento ${event.id}: ${(err as Error).message}`);
        }
      }
    }

    // 2. Cleanup: remove eventos disparados há mais de 24h
    const beforeLen = this.events.length;
    this.events = this.events.filter(e => {
      if (!e.fired) return true;
      // Mantém por 24h após o disparo (pra registro); depois descarta.
      return (now - e.fireAt) < this.CLEANUP_AFTER_MS;
    });
    if (this.events.length !== beforeLen) {
      dirty = true;
      this.app.debug('SCHEDULER', `cleanup: ${beforeLen - this.events.length} evento(s) antigo(s) removido(s).`);
    }

    if (dirty) {
      this.save();
    }
  }

  // ===========================================================================
  // PERSISTÊNCIA — load / save (data/events.json)
  // ===========================================================================

  /**
   * Carrega events.json. Se não existir ou estiver vazio, inicializa com [].
   * Erros de parse não derrubam o bot — só logam e começam com [].
   */
  private load(): void {
    try {
      const filePath = this.app.dataPath('events.json');
      if (!fs.existsSync(filePath)) {
        this.events = [];
        return;
      }
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (!raw) {
        this.events = [];
        return;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.events = parsed as ScheduledEvent[];
      } else {
        this.app.log('SCHEDULER', `events.json não é um array — resetando.`);
        this.events = [];
      }
    } catch (err) {
      this.app.log('SCHEDULER', `erro ao carregar events.json: ${(err as Error).message}`);
      this.events = [];
    }
  }

  /**
   * Salva events.json. Erros não derrubam o bot — só logam.
   */
  private save(): void {
    try {
      const filePath = this.app.dataPath('events.json');
      fs.writeFileSync(filePath, JSON.stringify(this.events, null, 2), 'utf8');
    } catch (err) {
      this.app.log('SCHEDULER', `erro ao salvar events.json: ${(err as Error).message}`);
    }
  }
}
