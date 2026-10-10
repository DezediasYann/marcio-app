/**
 * AssistiveCommands — comandos assistivos (NOVOS, não existiam no bot velho).
 *
 * Esta é a motivação de toda a refatoração: liberar comandos úteis pra grupos
 * sem precisar de um fork especial. Os 6 comandos:
 *
 *  - /enquete (public, aliases: /poll)
 *      Cria uma enquete no WhatsApp via classe Poll do whatsapp-web.js.
 *      Sintaxe: /enquete <pergunta> | <op1> | <op2> | ...
 *      Mín 3 partes (1 pergunta + 2 opções), máx 13 (1 + 12 opções).
 *
 *  - /evento (opOnly, aliases: /event)
 *      Agenda um evento/lembrete pro Scheduler disparar no horário marcado.
 *      Sintaxe: /evento <descrição> @ dd/mm hh:mm
 *      Subcomandos:
 *        /evento lista           — lista eventos pendentes neste chat
 *        /evento cancelar <id>   — cancela um evento pelo ID
 *
 *  - /lembrete (public, aliases: /reminder, /lembrar)
 *      Agenda um lembrete em X minutos/horas/dias.
 *      Sintaxe: /lembrete <Xm|Xh|Xd> <descrição>
 *
 *  - /clima (public, aliases: /tempo)
 *      Mostra o clima atual de uma cidade (Open-Meteo API, sem chave).
 *      Sintaxe: /clima <cidade>
 *
 *  - /calcula (public, aliases: /calc, /calcular)
 *      Avalia uma expressão matemática via mathjs (sem eval()).
 *      Sintaxe: /calcula <expressão>
 *
 *  - /busca (public, aliases: /buscar, /search)
 *      Busca na web (DuckDuckGo Lite) + resume com IA (Gemini direto).
 *      Sintaxe: /busca <termo>
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.scheduler          — schedule, cancel, list (via getter; o campo
 *                                  será adicionado a MarcioApp pelo agente
 *                                  principal no wiring)
 *  - this.app.whatsapp.client    — sendMessage (pra /enquete enviar Poll)
 *  - this.app.brain              — getAIConfig, getAllFallbackModels, cleanResponse,
 *                                  lastUsedModel (pra /busca chamar Gemini direto)
 *  - this.app.aiConfig           — checa se IA está ativada (pra /busca)
 *  - this.app.react / notify / reportError / log / debug — feedback
 *
 * Bibliotecas externas:
 *  - whatsapp-web.js (Poll) — já instalado
 *  - mathjs (evaluate)      — já instalado
 *  - fetch (global)         — Node 18+ tem nativo (Node 22+ no projeto)
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import { Poll } from 'whatsapp-web.js';
import type { CommandDef, CommandModule } from './CommandRegistry';
import type { Scheduler } from '../scheduler/Scheduler';
import { evaluate } from 'mathjs';

// ============================================================================
// CONSTS
// ============================================================================

const EMOJI = {
  LOADING: '⏳',
  SUCCESS: '✅',
  ERROR: '❌',
} as const;

/** User-Agent pra DuckDuckGo (eles bloqueiam fetch sem UA). */
const DDG_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ============================================================================
// ASSISTIVE COMMANDS
// ============================================================================

export class AssistiveCommands implements CommandModule {
  readonly name = 'assistive';
  readonly commands: CommandDef[];
  private app: MarcioApp;

  constructor(app: MarcioApp) {
    this.app = app;
    this.commands = [
      // === Públicos ===
      {
        name: '/enquete',
        aliases: ['/poll'],
        handler: (msg, chatId) => this.handleEnquete(msg, chatId),
        help: 'cria uma enquete. Ex.: /enquete pizza ou hambúrguer? | pizza | hambúrguer',
      },
      {
        name: '/lembrete',
        aliases: ['/reminder', '/lembrar'],
        handler: (msg, chatId) => this.handleLembrete(msg, chatId),
        help: 'define um lembrete. Ex.: /lembrete 30m tomar remédio',
      },
      {
        name: '/clima',
        aliases: ['/tempo'],
        handler: (msg, chatId) => this.handleClima(msg, chatId),
        help: 'mostra o clima de uma cidade. Ex.: /clima São Paulo',
      },
      {
        name: '/calcula',
        aliases: ['/calc', '/calcular'],
        handler: (msg, chatId) => this.handleCalcula(msg, chatId),
        help: 'avalia uma expressão matemática. Ex.: /calcula 2+2*3, /calcula sqrt(16)',
      },
      {
        name: '/busca',
        aliases: ['/buscar', '/search'],
        handler: (msg, chatId) => this.handleBusca(msg, chatId),
        help: 'busca na web + resumo com IA. Ex.: /busca quem ganhou a copa de 2002',
      },
      // === Op only ===
      {
        name: '/evento',
        aliases: ['/event'],
        handler: (msg, chatId) => this.handleEvento(msg, chatId),
        help: 'agenda um evento. Ex.: /evento aniversário @ 25/12 18:00. Subcomandos: /evento lista, /evento cancelar <id>.',
        opOnly: true,
      },
    ];
  }

  // ===========================================================================
  // SCHEDULER — getter (o campo será adicionado a MarcioApp no wiring)
  // ===========================================================================

  /**
   * Acesso ao Scheduler. O campo `scheduler` ainda não existe em MarcioApp
   * (F4 — só este módulo + o Scheduler foram criados; o agente principal vai
   * instanciar `this.scheduler = new Scheduler(this)` em MarcioApp.start() e
   * adicionar `scheduler!: Scheduler` na declaração da classe).
   *
   * Enquanto o wiring não é feito, este getter usa um cast `as any` pra
   * acessar o campo. Depois do wiring, o cast continua funcionando
   * (harmless — TS permite `(app as any).scheduler` mesmo com o campo tipado).
   */
  private get scheduler(): Scheduler {
    return (this.app as any).scheduler as Scheduler;
  }

  // ===========================================================================
  // /enquete — cria enquete no WhatsApp via classe Poll
  // ===========================================================================

  /**
   * /enquete <pergunta> | <op1> | <op2> | ...
   *
   * Splita o body em `|`. Primeira parte = pergunta, resto = opções.
   * Mín 3 partes (1 pergunta + 2 opções), máx 13 (1 + 12 opções).
   * Envia via `client.sendMessage(chatId, new Poll(question, options))`.
   */
  private async handleEnquete(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const rest = this.stripCommandToken(msg.body || '');
    if (!rest) {
      await this.app.reportError(
        msg,
        chatId,
        'use */enquete <pergunta> | <op1> | <op2> | ...* (mín 2 opções, máx 12).',
      );
      return;
    }

    // Splita em `|` e remove vazios (caem fora quando alguém digita `| ` duplo).
    const parts = rest
      .split('|')
      .map(p => p.trim())
      .filter(p => p.length > 0);

    if (parts.length < 3) {
      await this.app.reportError(
        msg,
        chatId,
        'faltam opções. Mínimo: 1 pergunta + 2 opções. Use *|* pra separar.',
      );
      return;
    }
    if (parts.length > 13) {
      await this.app.reportError(
        msg,
        chatId,
        'muitas opções. Máximo: 1 pergunta + 12 opções.',
      );
      return;
    }

    const question = parts[0];
    const options = parts.slice(1);

    try {
      await this.app.whatsapp.client.sendMessage(chatId, new Poll(question, options));
      await this.app.react(msg, EMOJI.SUCCESS);
      this.app.debug('ASSIST', `enquete criada em ${chatId}: "${question}" (${options.length} opções)`);
    } catch (e) {
      await this.app.reportError(
        msg,
        chatId,
        `erro ao criar enquete: ${(e as Error).message}`,
        e as Error,
      );
    }
  }

  // ===========================================================================
  // /evento — agenda evento no Scheduler (opOnly)
  // ===========================================================================

  /**
   * /evento <descrição> @ dd/mm hh:mm
   * /evento lista
   * /evento cancelar <id>
   *
   * A data é sempre no formato `dd/mm hh:mm` no final do comando. Usa o ano
   * atual; se a data já passou, assume o próximo ano.
   */
  private async handleEvento(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const rest = this.stripCommandToken(msg.body || '').trim();

    // /evento lista
    const lower = rest.toLowerCase();
    if (lower === 'lista' || lower === 'list') {
      await this.eventoList(msg, chatId);
      return;
    }

    // /evento cancelar <id>
    if (lower.startsWith('cancelar ') || lower.startsWith('cancel ')) {
      const id = rest.split(/\s+/).slice(1).join(' ').trim();
      await this.eventoCancel(msg, chatId, id);
      return;
    }

    if (!rest) {
      await this.app.reportError(
        msg,
        chatId,
        'use */evento <descrição> @ dd/mm hh:mm* (ex: */evento aniversário @ 25/12 18:00*). Ou */evento lista*, */evento cancelar <id>*.',
      );
      return;
    }

    // Extrai data `dd/mm hh:mm` do final do comando.
    const dateMatch = rest.match(/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*$/);
    if (!dateMatch || dateMatch.index === undefined) {
      await this.app.reportError(
        msg,
        chatId,
        'formato inválido. Use */evento <descrição> @ dd/mm hh:mm* (ex: */evento festa @ 25/12 18:00*).',
      );
      return;
    }

    // Tudo antes da data = descrição (corta `@` final se tiver).
    let description = rest.slice(0, dateMatch.index).trim();
    description = description.replace(/@\s*$/, '').trim();

    if (!description) {
      await this.app.reportError(msg, chatId, 'descrição do evento não pode ser vazia.');
      return;
    }

    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const hour = parseInt(dateMatch[3], 10);
    const minute = parseInt(dateMatch[4], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      await this.app.reportError(msg, chatId, 'data inválida. Verifique dia (1-31), mês (1-12), hora (0-23) e minuto (0-59).');
      return;
    }

    // Ano atual; se a data já passou, assume o próximo ano.
    const now = new Date();
    let year = now.getFullYear();
    let fireAt = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
    if (fireAt <= Date.now()) {
      year += 1;
      fireAt = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
    }

    try {
      const id = this.scheduler.schedule(chatId, description, fireAt);
      const formatted = this.formatDateBr(fireAt);
      await this.app.notify(
        chatId,
        `📅 Evento agendado: ${description} — ${formatted}\n\nID: \`${id}\`\n\nUse */evento cancelar ${id}* pra cancelar.`,
      );
      await this.app.react(msg, EMOJI.SUCCESS);
    } catch (e) {
      await this.app.reportError(
        msg,
        chatId,
        `erro ao agendar evento: ${(e as Error).message}`,
        e as Error,
      );
    }
  }

  /**
   * /evento lista — lista eventos pendentes neste chat, ordenados por fireAt.
   */
  private async eventoList(msg: Message, chatId: string): Promise<void> {
    try {
      const events = this.scheduler
        .list(chatId)
        .filter(e => !e.fired)
        .sort((a, b) => a.fireAt - b.fireAt);

      if (events.length === 0) {
        await this.app.notify(chatId, 'nenhum evento pendente neste chat.');
        await this.app.react(msg, EMOJI.SUCCESS);
        return;
      }

      const lines = ['*Eventos pendentes neste chat:*', ''];
      for (const e of events) {
        const formatted = this.formatDateBr(e.fireAt);
        lines.push(`• ${e.text} — ${formatted} (ID: \`${e.id}\`)`);
      }
      lines.push('');
      lines.push('_Use */evento cancelar <id>* pra cancelar._');
      await this.app.notify(chatId, lines.join('\n'));
      await this.app.react(msg, EMOJI.SUCCESS);
    } catch (e) {
      await this.app.reportError(
        msg,
        chatId,
        `erro ao listar eventos: ${(e as Error).message}`,
        e as Error,
      );
    }
  }

  /**
   * /evento cancelar <id> — cancela um evento pelo ID.
   */
  private async eventoCancel(msg: Message, chatId: string, id: string): Promise<void> {
    if (!id) {
      await this.app.reportError(msg, chatId, 'use */evento cancelar <id>*.');
      return;
    }
    try {
      const ok = this.scheduler.cancel(id);
      if (ok) {
        await this.app.notify(chatId, `✅ evento cancelado: \`${id}\``);
        await this.app.react(msg, EMOJI.SUCCESS);
      } else {
        await this.app.reportError(msg, chatId, `evento não encontrado: \`${id}\``);
      }
    } catch (e) {
      await this.app.reportError(
        msg,
        chatId,
        `erro ao cancelar evento: ${(e as Error).message}`,
        e as Error,
      );
    }
  }

  // ===========================================================================
  // /lembrete — agenda lembrete em Xm/Xh/Xd
  // ===========================================================================

  /**
   * /lembrete <Xm|Xh|Xd> <descrição>
   *
   * Primeiro token é a duração (ex: "30m", "2h", "1d"). Resto é descrição.
   * Agenda no Scheduler com fireAt = agora + duração.
   */
  private async handleLembrete(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const rest = this.stripCommandToken(msg.body || '').trim();
    if (!rest) {
      await this.app.reportError(
        msg,
        chatId,
        'use */lembrete <Xm|Xh|Xd> <descrição>* (ex: */lembrete 30m tomar remédio*).',
      );
      return;
    }

    const parts = rest.split(/\s+/);
    const durationStr = parts[0].toLowerCase();
    const description = parts.slice(1).join(' ').trim();

    // Parser de duração: número + unidade (m/min/minutes, h/hr/hours, d/day/days).
    const durMatch = durationStr.match(/^(\d+)\s*(m|min|minutes?|h|hr|hours?|d|day|days?)$/i);
    if (!durMatch) {
      await this.app.reportError(
        msg,
        chatId,
        'duração inválida. Use *Xm* (minutos), *Xh* (horas) ou *Xd* (dias). Ex: */lembrete 30m algo*.',
      );
      return;
    }

    if (!description) {
      await this.app.reportError(msg, chatId, 'descrição do lembrete não pode ser vazia.');
      return;
    }

    const num = parseInt(durMatch[1], 10);
    const unit = durMatch[2].toLowerCase();
    let ms: number;
    if (unit.startsWith('m')) {
      ms = num * 60_000;
    } else if (unit.startsWith('h')) {
      ms = num * 3_600_000;
    } else if (unit.startsWith('d')) {
      ms = num * 86_400_000;
    } else {
      await this.app.reportError(msg, chatId, 'unidade de tempo inválida. Use m, h ou d.');
      return;
    }

    const fireAt = Date.now() + ms;
    try {
      const id = this.scheduler.schedule(chatId, description, fireAt);
      const humanized = this.humanizeDuration(ms);
      await this.app.notify(
        chatId,
        `⏰ Lembrete definido: daqui ${humanized} — ${description}\n\nID: \`${id}\``,
      );
      await this.app.react(msg, EMOJI.SUCCESS);
    } catch (e) {
      await this.app.reportError(
        msg,
        chatId,
        `erro ao agendar lembrete: ${(e as Error).message}`,
        e as Error,
      );
    }
  }

  // ===========================================================================
  // /clima — clima atual via Open-Meteo (sem chave)
  // ===========================================================================

  /**
   * /clima <cidade>
   *
   * Step 1: geocode (https://geocoding-api.open-meteo.com/v1/search?name=...).
   * Step 2: weather (https://api.open-meteo.com/v1/forecast?...).
   * Mapeia weather_code (WMO) pra descrição + emoji.
   */
  private async handleClima(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const city = this.stripCommandToken(msg.body || '').trim();
    if (!city) {
      await this.app.reportError(msg, chatId, 'use */clima <cidade>* (ex: */clima São Paulo*).');
      return;
    }

    try {
      // Step 1: geocoding
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&format=json`;
      const geoRes = await fetch(geoUrl);
      if (!geoRes.ok) {
        await this.app.reportError(msg, chatId, `erro ao buscar cidade (geocoding API ${geoRes.status}).`);
        return;
      }
      const geoData = (await geoRes.json()) as any;
      const result = geoData?.results?.[0];
      if (!result) {
        await this.app.reportError(msg, chatId, `cidade não encontrada: *${city}*.`);
        return;
      }

      const { latitude, longitude, name, country, admin1 } = result;

      // Step 2: weather
      const weatherUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m` +
        `&daily=temperature_2m_max,temperature_2m_min,weather_code` +
        `&timezone=auto&forecast_days=1`;
      const weatherRes = await fetch(weatherUrl);
      if (!weatherRes.ok) {
        await this.app.reportError(msg, chatId, `erro ao buscar clima (weather API ${weatherRes.status}).`);
        return;
      }
      const w = (await weatherRes.json()) as any;
      const cur = w?.current;
      if (!cur) {
        await this.app.reportError(msg, chatId, 'não consegui ler os dados de clima.');
        return;
      }

      const desc = this.weatherCodeToText(cur.weather_code);
      const temp = cur.temperature_2m;
      const feels = cur.apparent_temperature;
      const hum = cur.relative_humidity_2m;
      const wind = cur.wind_speed_10m;
      const tMax = w?.daily?.temperature_2m_max?.[0];
      const tMin = w?.daily?.temperature_2m_min?.[0];

      const locationStr = admin1 ? `${name}, ${admin1} — ${country}` : `${name} — ${country}`;
      const lines = [
        `*Clima em ${locationStr}*`,
        '',
        `🌡️ Temp: ${temp}°C (sensação ${feels}°C)`,
        `💧 Umidade: ${hum}%`,
        `💨 Vento: ${wind} km/h`,
        `☁️ Condição: ${desc}`,
      ];
      if (tMax !== undefined && tMin !== undefined) {
        lines.push(`📈 Máx: ${tMax}°C | 📉 Mín: ${tMin}°C`);
      }
      await this.app.notify(chatId, lines.join('\n'));
      await this.app.react(msg, EMOJI.SUCCESS);
      this.app.debug('ASSIST', `clima buscado pra "${city}" → ${name}, ${country}: ${temp}°C ${desc}`);
    } catch (e) {
      await this.app.reportError(
        msg,
        chatId,
        `erro ao buscar clima: ${(e as Error).message}`,
        e as Error,
      );
    }
  }

  /**
   * Mapeia weather_code (WMO) pra descrição em PT-BR + emoji.
   * Ref: https://open-meteo.com/en/docs#weathervariables
   */
  private weatherCodeToText(code: number): string {
    if (code === 0) return 'Céu limpo ☀️';
    if (code >= 1 && code <= 3) return 'Parcialmente nublado ⛅';
    if (code >= 45 && code <= 48) return 'Nevoeiro 🌫️';
    if (code >= 51 && code <= 67) return 'Chuva 🌧️';
    if (code >= 71 && code <= 77) return 'Neve ❄️';
    if (code >= 80 && code <= 82) return 'Chuva forte 🌧️';
    if (code >= 95 && code <= 99) return 'Tempestade ⛈️';
    return `Código ${code} (desconhecido)`;
  }

  // ===========================================================================
  // /calcula — avalia expressão matemática via mathjs
  // ===========================================================================

  /**
   * /calcula <expressão>
   *
   * Usa mathjs.evaluate (sem eval()). Suporta +, -, *, /, sqrt, sin, cos,
   * log, parênteses, etc. Em caso de erro: "❌ expressão inválida".
   */
  private async handleCalcula(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const expression = this.stripCommandToken(msg.body || '').trim();
    if (!expression) {
      await this.app.reportError(
        msg,
        chatId,
        'use */calcula <expressão>* (ex: */calcula 2+2*3*, */calcula sqrt(16)*).',
      );
      return;
    }

    try {
      const result = evaluate(expression);
      const resultStr = this.formatMathResult(result);
      await this.app.notify(chatId, `🧮 ${expression} = ${resultStr}`);
      await this.app.react(msg, EMOJI.SUCCESS);
      this.app.debug('ASSIST', `calcula: "${expression}" = ${resultStr}`);
    } catch (e) {
      // Erro de avaliação (sintaxe inválida, divisão por zero, etc).
      await this.app.react(msg, EMOJI.ERROR);
      await this.app.notify(chatId, '❌ expressão inválida');
      this.app.log('ASSIST', `erro ao avaliar "${expression}": ${(e as Error).message}`);
    }
  }

  /**
   * Formata o resultado de mathjs.evaluate pra exibição.
   * - number inteiro → "42"
   * - number decimal → "3.14" (arredondado a 10 casas, trim de zeros)
   * - outros (BigNumber, Complex, Unit, Matrix) → toString()
   */
  private formatMathResult(result: unknown): string {
    if (typeof result === 'number') {
      if (!Number.isFinite(result)) return String(result); // Infinity, NaN
      if (Number.isInteger(result)) return String(result);
      // Arredonda a 10 casas decimais e tira zeros à direita.
      const rounded = Math.round(result * 1e10) / 1e10;
      return String(rounded);
    }
    // mathjs retorna BigNumber, Complex, Unit, Matrix, etc — delega pra toString.
    if (result && typeof (result as any).toString === 'function') {
      try {
        const s = (result as any).toString();
        if (s && s !== '[object Object]') return s;
      } catch {
        // cai no fallback abaixo
      }
    }
    return String(result);
  }

  // ===========================================================================
  // /busca — DuckDuckGo Lite + Gemini (híbrido)
  // ===========================================================================

  /**
   * /busca <termo>
   *
   * Fluxo híbrido:
   *  1. Busca no DuckDuckGo Lite (top 3 resultados: título + snippet).
   *  2. Se DDG retornou resultados: manda pra Gemini com prompt de síntese.
   *     Se DDG falhou/vazio: pergunta direto pra Gemini (sem contexto).
   *  3. Reply com a resposta da IA + nota de fonte.
   *
   * Fallbacks:
   *  - DDG falhou + Gemini falhou → "❌ não consegui buscar agora"
   *  - DDG ok + Gemini falhou → mostra resultados crus do DDG
   */
  private async handleBusca(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const query = this.stripCommandToken(msg.body || '').trim();
    if (!query) {
      await this.app.reportError(
        msg,
        chatId,
        'use */busca <termo>* (ex: */busca quem ganhou a copa de 2002*).',
      );
      return;
    }

    if (!this.app.aiConfig?.enabled) {
      await this.app.reportError(
        msg,
        chatId,
        'a IA precisa estar ativada pra usar /busca. Use */ia on*.',
      );
      return;
    }

    // Step 1-2: tenta DuckDuckGo Lite.
    let ddgResults: Array<{ title: string; snippet: string }> = [];
    try {
      ddgResults = await this.searchDuckDuckGo(query);
      this.app.debug('ASSIST', `DDG retornou ${ddgResults.length} resultado(s) pra "${query}".`);
    } catch (e) {
      this.app.debug('ASSIST', `DDG falhou pra "${query}": ${(e as Error).message}`);
      ddgResults = [];
    }

    // Step 3-4: chama Gemini (com contexto se DDG funcionou, sem contexto senão).
    let systemPrompt: string;
    let userContent: string;
    if (ddgResults.length > 0) {
      systemPrompt =
        'Baseado nesses resultados de busca, responda à pergunta de forma breve e direta. ' +
        'Se os resultados não forem relevantes, diga que não encontrou informação útil.';
      const resultsBlock = ddgResults
        .map((r, i) => `${i + 1}. ${r.title} — ${r.snippet}`)
        .join('\n');
      userContent = `Pergunta: ${query}\n\nResultados:\n${resultsBlock}`;
    } else {
      // DDG falhou/vazio — pergunta direto pra IA.
      systemPrompt =
        'Responda à pergunta de forma breve e direta. Se não souber, diga que não sabe.';
      userContent = `Pergunta: ${query}`;
    }

    let answer: string;
    try {
      const raw = await this.callGeminiForSearch(systemPrompt, userContent);
      answer = this.app.brain.cleanResponse(raw);
      if (!answer || !answer.trim()) {
        answer = 'não consegui gerar uma resposta.';
      }
    } catch (e) {
      this.app.log('ASSIST', `IA falhou pra busca "${query}": ${(e as Error).message}`);
      // Se DDG funcionou, mostra resultados crus como fallback.
      if (ddgResults.length > 0) {
        const resultsBlock = ddgResults
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`)
          .join('\n\n');
        await this.app.notify(
          chatId,
          `🔍 Resultados pra "${query}" (IA indisponível):\n\n${resultsBlock}\n\n_Fonte: DuckDuckGo_`,
        );
        await this.app.react(msg, EMOJI.SUCCESS);
        return;
      }
      // Ambos falharam.
      await this.app.reportError(msg, chatId, '❌ não consegui buscar agora');
      return;
    }

    // Step 5: resposta + nota de fonte.
    const sourceNote = ddgResults.length > 0 ? '\n\n_Fonte: DuckDuckGo + IA_' : '\n\n_Fonte: IA_';
    await this.app.notify(chatId, `🔍 ${answer}${sourceNote}`);
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  /**
   * Busca no DuckDuckGo Lite e extrai top 3 resultados (título + snippet).
   *
   * O HTML do DDG Lite tem:
   *   <a ... class="result-link" href="URL">TITLE</a>
   *   <td ... class="result-snippet">SNIPPET</td>
   *
   * Usamos regex (não um parser HTML completo) — DDG Lite é uma tabela simples.
   *
   * @throws Em caso de erro de rede ou HTTP não-2xx.
   */
  private async searchDuckDuckGo(
    query: string,
  ): Promise<Array<{ title: string; snippet: string }>> {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': DDG_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`DDG HTTP ${res.status}`);
    }
    const html = await res.text();
    if (!html || html.length < 100) {
      return [];
    }

    // Extrai todos os <a class="result-link" href="URL">TITLE</a>.
    const titles: Array<{ url: string; title: string }> = [];
    const aTagRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = aTagRegex.exec(html)) !== null) {
      const attrs = m[1] || '';
      if (!/class\s*=\s*["']?result-link["']?/i.test(attrs)) continue;
      const hrefMatch = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      const title = this.stripHtml(m[2] || '').trim();
      if (title) titles.push({ url: hrefMatch[1], title });
    }

    // Extrai todos os <td class="result-snippet">SNIPPET</td>.
    const snippets: string[] = [];
    const snippetRegex = /<td\b[^>]*?class\s*=\s*["']?result-snippet["']?[^>]*?>([\s\S]*?)<\/td>/gi;
    while ((m = snippetRegex.exec(html)) !== null) {
      snippets.push(this.stripHtml(m[1] || '').trim());
    }

    // Pareia por índice (DDG lista títulos e snippets na mesma ordem).
    const results: Array<{ title: string; snippet: string }> = [];
    const maxResults = Math.min(3, titles.length);
    for (let i = 0; i < maxResults; i++) {
      const snippet = i < snippets.length ? snippets[i] : '';
      results.push({ title: titles[i].title, snippet });
    }
    return results;
  }

  /**
   * Remove tags HTML e decodifica entidades comuns. DDG retorna snippets com
   * <b>...</b> pra destacar o termo buscado.
   */
  private stripHtml(s: string): string {
    return s
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Chama a API de IA diretamente (não passa pelo brain.generateResponse —
   * isso é pra contexto de chat com perfil/diretivas). Réplica do padrão do
   * TwitterBot.callGeminiForTweet, mas sem suporte a imagens (busca não precisa).
   *
   * Suporta:
   *  - Gemini (Google AI Studio): systemInstruction + contents.
   *  - OpenAI-compatible (Ollama, Groq, OpenRouter): messages com role system/user.
   *
   * Fallback chain: se o modelo principal retornar 429/503, tenta os
   * fallbackModels na ordem. Atualiza brain.lastUsedModel quando um fallback
   * sucede.
   *
   * @returns Conteúdo bruto da resposta da IA.
   * @throws Em caso de erro de rede/API ou resposta vazia.
   */
  private async callGeminiForSearch(systemPrompt: string, userContent: string): Promise<string> {
    const aiConfig = this.app.brain.getAIConfig();
    const provider = aiConfig.provider || (aiConfig.apiUrl.includes('googleapis') ? 'gemini' : 'openai');

    let content: string | undefined;

    if (provider === 'gemini') {
      // === FORMATO GEMINI (Google AI Studio) ===
      const systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
      const contents = [
        {
          role: 'user',
          parts: [{ text: userContent }],
        },
      ];

      const callGemini = async (modelName: string): Promise<string> => {
        const geminiUrl = `${aiConfig.apiUrl.replace(/\/+$/, '')}/${modelName}:generateContent?key=${aiConfig.apiKey}`;
        const geminiResponse = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            systemInstruction,
            generationConfig: {
              maxOutputTokens: aiConfig.maxTokens,
              temperature: aiConfig.temperature,
            },
          }),
        });
        if (!geminiResponse.ok) {
          const errText = await geminiResponse.text();
          const err = new Error(`Gemini API ${geminiResponse.status}: ${errText.slice(0, 200)}`) as any;
          err.status = geminiResponse.status;
          throw err;
        }
        const geminiData = (await geminiResponse.json()) as any;
        const geminiContent = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!geminiContent) throw new Error('Resposta vazia da Gemini API');
        return geminiContent;
      };

      try {
        content = await callGemini(aiConfig.model);
      } catch (primaryErr) {
        const allModels = this.app.brain.getAllFallbackModels();
        if (allModels.length <= 1) throw primaryErr;
        let fallbackSuccess = false;
        for (let i = 1; i < allModels.length; i++) {
          const fbModel = allModels[i];
          try {
            this.app.debug('ASSIST', `⚠️ modelo principal esgotou (429/503), tentando fallback: ${fbModel}`);
            content = await callGemini(fbModel);
            this.app.brain.lastUsedModel = fbModel;
            fallbackSuccess = true;
            break;
          } catch (fbErr) {
            if (i < allModels.length - 1) continue;
            throw fbErr;
          }
        }
        if (!fallbackSuccess) throw primaryErr;
      }
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
          max_tokens: aiConfig.maxTokens,
          temperature: aiConfig.temperature,
        }),
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
      }
      const openaiData = (await response.json()) as any;
      content = openaiData.choices?.[0]?.message?.content;
      if (!content) throw new Error('Resposta vazia da API');
    }

    return content;
  }

  // ===========================================================================
  // HELPERS — parsing de comando e formatação
  // ===========================================================================

  /**
   * Remove o primeiro token do body (o nome do comando, ex: "/enquete") e
   * devolve o resto. Ex: "/enquete pizza | hamburger" → "pizza | hamburger".
   * Lida com qualquer alias (!enquete, /poll, etc.) — só corta o primeiro
   * espaço.
   */
  private stripCommandToken(body: string): string {
    const trimmed = body.trim();
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace === -1) return '';
    return trimmed.slice(firstSpace + 1).trim();
  }

  /**
   * Formata epoch ms pra data legível em PT-BR (timezone São Paulo).
   * Ex: "25/12/2025 18:00".
   */
  private formatDateBr(epochMs: number): string {
    return new Date(epochMs).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Humaniza uma duração em ms pra exibição.
   * Ex: 1_800_000 → "30min", 7_200_000 → "2h", 5_400_000 → "1h30min".
   */
  private humanizeDuration(ms: number): string {
    if (ms < 60_000) return `${Math.round(ms / 1000)}seg`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
    if (ms < 86_400_000) {
      const hours = ms / 3_600_000;
      if (Number.isInteger(hours)) return `${hours}h`;
      const h = Math.floor(hours);
      const m = Math.round((ms - h * 3_600_000) / 60_000);
      return m === 0 ? `${h}h` : `${h}h${m}min`;
    }
    const days = ms / 86_400_000;
    if (Number.isInteger(days)) return `${days}d`;
    const d = Math.floor(days);
    const h = Math.round((ms - d * 86_400_000) / 3_600_000);
    return h === 0 ? `${d}d` : `${d}d${h}h`;
  }
}
