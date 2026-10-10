/**
 * AdminCommands — módulo de administração do bot (apenas ops).
 *
 * Comandos registrados:
 *  - /admin (opOnly, pvOnly) — dispatcher com todos os subcomandos
 *  - /op           — concede op a um usuário (quoted ou número)
 *  - /deop         — revoga op
 *  - /ops          — lista ops
 *  - /ban / !ban   — bane um usuário
 *  - /unban / /desbanir / !unban / !desbanir — desbane
 *  - /banidos / !banidos — lista banidos
 *
 * Subcomandos do /admin (preservados byte-a-byte do index.js velho):
 *  - status                — overview (IA, contador, debug, últimos grupos)
 *  - grupos                — lista todos os grupos (até 20)
 *  - chats                 — lista todos os chats com atividade recente
 *  - ia <chatId> <on|off>  — controla IA de qualquer chat
 *  - entrosao <chatId> <n> — ajusta entrosão de qualquer chat (0-2)
 *  - info <chatId>         — info detalhada de um chat
 *  - debug <on|off|full>   — liga/desliga debug em runtime
 *  - log [n]               — últimas N linhas do bot.log
 *  - stats                 — estatísticas de uso
 *  - modelo                — mostra modelo de IA + fallbacks
 *  - features              — controla retroativo e memória em runtime
 *  - ajuda                 — lista os subcomandos
 *  - reiniciar             — reinicia o bot (pede confirmação)
 *  - retro [agora|limpar]  — controla sistema retroativo
 *  - ler [...]             — força leitura de histórico de um chat
 *  - desligar              — desliga o bot (pede confirmação)
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.permissions  — loadOps/saveOps/addOp/removeOp, loadBanned/saveBanned/addBanned/removeBanned,
 *                            resolveSenderIds, resolveTarget, isOp, isBanned, digitsOnly, initialOps
 *  - this.app.whatsapp     — client (getChats, getChatById, destroy, initialize), sendMessage (loop-guard)
 *  - this.app.brain        — aiDisabledChats, chatEntrosaoLevel, aiRequestCount, lastUsedModel,
 *                            getAIConfig, getAllFallbackModels
 *  - this.app.context      — getRecent, count, historyLoadedCount, activeChatIds, forceReadChatHistory
 *  - this.app.profile      — get (com style + vocabulary + userActivity + userProfiles)
 *  - this.app.retroactive  — enabled, intervalMin, windowMin, pendingCount, clear, forceCheck, setupTimer
 *  - this.app.memory       — enabled
 *  - this.app.stickers     — listNamed
 *  - this.app.directives   — all
 *  - this.app              — react, notify, reportError, log, debug, dataPath, config.botName,
 *                            startTime, debugEnabled, debugFullEnabled, aiConfig
 *
 * Helpers portados (como métodos privados):
 *  - listBotGroups(limit)          — lista grupos por última atividade (linha 6264 do velho)
 *  - formatUptime()                — "Xd Yh Zmin" (linha 6244)
 *  - humanizeAge(timestampMs)      — "há 2h" (linha 6210)
 *  - readLastLogLines(n)           — últimas N linhas do bot.log (linha 6228)
 *  - isValidWhatsAppChatId(id)     — regex @g.us|@c.us|@lid (linha 6202)
 *  - formatLerStats(stats)         — relatório de forceReadChatHistory (linha 7261)
 *  - formatMemorySettled(stats)    — relatório final de memória (linha 7293)
 *
 * Preservado byte-a-byte dos handlers do index.js velho:
 *  - handleAdmin      (6300-6400) — dispatcher com checagem dupla PV
 *  - adminStatus      (6405-6441)
 *  - adminGroups      (6446-6465)
 *  - adminChats       (6470-6511)
 *  - adminIA          (6517-6552)
 *  - adminEntrosao    (6558-6586)
 *  - adminInfo        (6591-6678)
 *  - adminDebug       (6683-6710)
 *  - adminLog         (6715-6729)
 *  - adminFeatures    (6748-6833) — retro on/off/interval/window, memoria on/off
 *  - adminModelo      (6838-6879)
 *  - adminStats       (6884-6916)
 *  - adminAjuda       (6921-6946)
 *  - adminRetro       (6954-7020)
 *  - adminLer         (7043-7252) — status, aqui, todos, <chatId>
 *  - adminReiniciar   (7318-7359) — destroy+initialize, skip pendingRestartNotifyChatId
 *  - adminDesligar    (7365-7407) — destroy+process.exit(0)
 *  - handleOp         (7501-7563)
 *  - handleDeop       (7576-7630)
 *  - handleListOps    (7635-7668)
 *  - handleBan        (5374-5438)
 *  - handleUnban      (5447-5491)
 *  - handleListBanned (5496-5522)
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import type { CommandDef, CommandModule } from './CommandRegistry';
import type { ForceReadStats } from '../brain/Context';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// CONSTS
// ============================================================================

const EMOJI = {
  LOADING: '⏳',
  SUCCESS: '✅',
  ERROR: '❌',
} as const;

// ============================================================================
// TIPOS
// ============================================================================

interface BotGroupItem {
  id: string;
  name: string;
  members: number;
  lastMs: number;
  aiOn: boolean;
  entrosao: number;
}

interface ChatItem {
  id: string;
  isGroup: boolean;
  name: string;
  lastMs: number;
  aiOn: boolean;
  entrosao: number;
}

// ============================================================================
// ADMIN COMMANDS
// ============================================================================

export class AdminCommands implements CommandModule {
  readonly name = 'admin';
  readonly commands: CommandDef[];
  private readonly app: MarcioApp;

  constructor(app: MarcioApp) {
    this.app = app;
    this.commands = [
      {
        name: '/admin',
        aliases: ['!admin', '//'],
        handler: (msg, chatId) => this.handleAdmin(msg, chatId),
        opOnly: true,
        pvOnly: true,
        help: 'painel admin (só ops, só no PV). Use /admin ajuda pra ver subcomandos.',
      },
      {
        name: '/op',
        aliases: ['!op'],
        handler: (msg, chatId) => this.handleOp(msg, chatId),
        opOnly: true,
        help: 'concede op a um usuário (responda à msg ou /op <número>).',
      },
      {
        name: '/deop',
        aliases: ['!deop'],
        handler: (msg, chatId) => this.handleDeop(msg, chatId),
        opOnly: true,
        help: 'revoga op de um usuário.',
      },
      {
        name: '/ops',
        aliases: ['!ops'],
        handler: (msg, chatId) => this.handleListOps(msg, chatId),
        opOnly: true,
        help: 'lista os operadores atuais.',
      },
      {
        name: '/ban',
        aliases: ['!ban'],
        handler: (msg, chatId) => this.handleBan(msg, chatId),
        opOnly: true,
        help: 'bane um usuário (responda à msg ou /ban <número>).',
      },
      {
        name: '/unban',
        aliases: ['/desbanir', '!unban', '!desbanir'],
        handler: (msg, chatId) => this.handleUnban(msg, chatId),
        opOnly: true,
        help: 'desbane um usuário.',
      },
      {
        name: '/banidos',
        aliases: ['!banidos'],
        handler: (msg, chatId) => this.handleListBanned(msg, chatId),
        opOnly: true,
        help: 'lista os usuários banidos.',
      },
    ];
  }

  // ===========================================================================
  // /admin — dispatcher principal (só no PV do bot, só ops)
  // ===========================================================================

  private async handleAdmin(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    // 1. Permissão: só ops (gate duplo — o router já filtra, mas mantemos igual ao velho)
    const sender = await this.app.permissions.resolveSenderIds(msg);
    const senderIsOp = this.app.permissions.isOp(msg.fromMe, sender.all);
    if (!senderIsOp) {
      await this.app.reportError(msg, chatId, 'comando restrito a *ops*.');
      this.app.log('ADMIN', `Tentativa não autorizada de /admin por ${sender.all.join(' / ')} em ${chatId}.`);
      return;
    }

    // 2. Local: SÓ no PV do bot (nunca em grupo). Checagem dupla: pelo chatId e
    //    pela propriedade isGroup do Chat, pra cobrir edge cases de chat misto.
    if (chatId.endsWith('@g.us')) {
      await this.app.reportError(msg, chatId, 'use este comando no *PV do bot* (não em grupo). 🚫');
      return;
    }
    try {
      const chat = await msg.getChat();
      if (chat && chat.isGroup) {
        await this.app.reportError(msg, chatId, 'use este comando no *PV do bot* (não em grupo). 🚫');
        return;
      }
    } catch (e) {
      this.app.debug('ADMIN', `não foi possível ler chat pra checar isGroup: ${(e as Error).message}`);
    }

    // 3. Parsing: /admin <sub> [args...]
    const parts = msg.body.trim().split(/\s+/);
    const sub = (parts[1] || '').toLowerCase();
    const args = parts.slice(2);

    this.app.debug('ADMIN', `sub="${sub}" | args=${JSON.stringify(args)} | chatId=${chatId}`);

    try {
      switch (sub) {
        case '':
        case 'status':
          await this.adminStatus(msg, chatId);
          break;
        case 'grupos':
          await this.adminGroups(msg, chatId, 20);
          break;
        case 'chats':
          await this.adminChats(msg, chatId, 20);
          break;
        case 'ia':
          await this.adminIA(msg, chatId, args);
          break;
        case 'entrosao':
          await this.adminEntrosao(msg, chatId, args);
          break;
        case 'info':
          await this.adminInfo(msg, chatId, args);
          break;
        case 'debug':
          await this.adminDebug(msg, chatId, args);
          break;
        case 'log':
          await this.adminLog(msg, chatId, args);
          break;
        case 'stats':
          await this.adminStats(msg, chatId);
          break;
        case 'modelo':
          await this.adminModelo(msg, chatId);
          break;
        case 'features':
          await this.adminFeatures(msg, chatId, args);
          break;
        case 'ajuda':
        case 'help':
          await this.adminAjuda(msg, chatId);
          break;
        case 'reiniciar':
        case 'restart':
          await this.adminReiniciar(msg, chatId, args);
          break;
        case 'retro':
          await this.adminRetro(msg, chatId, args);
          break;
        case 'ler':
          await this.adminLer(msg, chatId, args);
          break;
        case 'desligar':
        case 'shutdown':
          await this.adminDesligar(msg, chatId, args);
          break;
        default:
          await this.app.reportError(msg, chatId, `subcomando desconhecido: *${sub}*. Use */admin ajuda* pra ver a lista.`);
      }
    } catch (e) {
      this.app.debug('ADMIN', `erro em subcomando "${sub}": ${(e as Error).message}`);
      await this.app.reportError(msg, chatId, `erro ao executar /admin ${sub}: ${(e as Error).message}`, e as Error);
    }
  }

  // ===========================================================================
  // /admin status — overview geral
  // ===========================================================================

  private async adminStatus(msg: Message, chatId: string): Promise<void> {
    const iaGlobal = this.app.aiConfig?.enabled ? '✅' : '🛑';
    const twitterOn = !!(this.app.twitter);

    // Últimos 3 grupos ativos
    let recentGroups: BotGroupItem[] = [];
    try {
      recentGroups = await this.listBotGroups(3);
    } catch (e) {
      this.app.debug('ADMIN', `erro ao listar grupos pra status: ${(e as Error).message}`);
    }

    const lines = [
      '*🎛️ Painel Admin — Status*',
      '',
      `IA global: ${iaGlobal}`,
      `Chats com IA desativada: ${this.app.brain.aiDisabledChats.size}`,
      `Requests de IA hoje: ${this.app.brain.aiRequestCount}`,
      `Debug: ${this.app.debugEnabled ? 'on' : 'off'}${this.app.debugFullEnabled ? ' (full)' : ''}`,
      `Twitter: ${twitterOn ? 'on' : 'off'}`,
    ];

    if (recentGroups.length > 0) {
      lines.push('', '_Últimos 3 grupos ativos:_');
      recentGroups.forEach((g, i) => {
        lines.push(`${i + 1}. ${g.name}`);
        lines.push(`   ${g.id} — IA: ${g.aiOn ? '✅' : '🛑'} | Entrosão: ${g.entrosao.toFixed(1)} | ${this.humanizeAge(g.lastMs)}`);
      });
    }

    lines.push('', '_Use */admin ajuda* pra ver todos os subcomandos._');

    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin grupos — lista todos os grupos (até 20)
  // ===========================================================================

  private async adminGroups(msg: Message, chatId: string, limit: number): Promise<void> {
    const groups = await this.listBotGroups(limit);
    if (groups.length === 0) {
      await this.app.notify(chatId, 'nenhum grupo encontrado. 📋');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }
    const lines = [`*Grupos que estou (${groups.length}${groups.length >= limit ? '+' : ''}):*`, ''];
    groups.forEach((g, i) => {
      lines.push(`${i + 1}. ${g.name}`);
      lines.push(`   ID: ${g.id}`);
      const membersStr = g.members > 0 ? ` | Membros: ${g.members}` : '';
      lines.push(`   IA: ${g.aiOn ? '✅' : '🛑'} | Entrosão: ${g.entrosao.toFixed(1)}${membersStr} | Última msg: ${this.humanizeAge(g.lastMs)}`);
    });
    if (groups.length >= limit) {
      lines.push('', `_(mostrando os ${limit} mais ativos — use /admin chats pra ver PVs também)_`);
    }
    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin chats — lista todos os chats (grupos + PVs) com atividade recente
  // ===========================================================================

  private async adminChats(msg: Message, chatId: string, limit: number): Promise<void> {
    const chats = await this.app.whatsapp.client.getChats();
    const items: ChatItem[] = chats.map((c: any) => {
      const id = c.id && c.id._serialized ? c.id._serialized : '?';
      let lastMs = 0;
      try {
        if (c.lastMessage && c.lastMessage.timestamp) {
          lastMs = c.lastMessage.timestamp * 1000;
        } else if (c.timestamp) {
          lastMs = c.timestamp * 1000;
        }
      } catch { /* ignora */ }
      return {
        id,
        isGroup: !!c.isGroup,
        name: c.name || c.formattedTitle || '(sem nome)',
        lastMs,
        aiOn: !this.app.brain.aiDisabledChats.has(id),
        entrosao: this.app.brain.chatEntrosaoLevel.get(id) ?? 1.0,
      };
    });
    items.sort((a, b) => (b.lastMs || 0) - (a.lastMs || 0));
    const top = items.slice(0, limit);

    if (top.length === 0) {
      await this.app.notify(chatId, 'nenhum chat encontrado. 📋');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    const lines = [`*Chats com atividade recente (${top.length}${top.length >= limit ? '+' : ''}):*`, ''];
    top.forEach((c, i) => {
      const tag = c.isGroup ? '[Grupo]' : '[PV]';
      lines.push(`${i + 1}. ${tag} ${c.name} (${c.id})`);
      lines.push(`   IA: ${c.aiOn ? '✅' : '🛑'} | Entrosão: ${c.entrosao.toFixed(1)} | ${this.humanizeAge(c.lastMs)}`);
    });
    if (top.length >= limit) {
      lines.push('', `_(mostrando os ${limit} mais ativos)_`);
    }
    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin ia <chatId> [on|off]
  // ===========================================================================

  private async adminIA(msg: Message, chatId: string, args: string[]): Promise<void> {
    const targetId = (args[0] || '').trim();
    const action = (args[1] || '').toLowerCase();

    if (!targetId || !this.isValidWhatsAppChatId(targetId)) {
      await this.app.reportError(msg, chatId, 'use: */admin ia <chatId> <on|off>*.\nEx.: /admin ia 120363xxx@g.us off\n(O chatId precisa terminar em @g.us, @c.us ou @lid.)');
      return;
    }

    if (!action) {
      const global = this.app.aiConfig?.enabled ? '✅' : '🛑';
      const local = this.app.brain.aiDisabledChats.has(targetId) ? '🛑 desativada' : '✅ ativada';
      await this.app.notify(chatId, `*Status da IA em ${targetId}:*\n\nGlobal: ${global}\nNeste chat: ${local}`);
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    if (action === 'off') {
      this.app.brain.aiDisabledChats.add(targetId);
      await this.app.notify(chatId, `IA desativada em ${targetId} 🛑`);
      this.app.log('ADMIN', `IA desativada em ${targetId} por op (via /admin ia).`);
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    if (action === 'on') {
      this.app.brain.aiDisabledChats.delete(targetId);
      await this.app.notify(chatId, `IA reativada em ${targetId} ✅`);
      this.app.log('ADMIN', `IA reativada em ${targetId} por op (via /admin ia).`);
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    await this.app.reportError(msg, chatId, `ação inválida: "${action}". Use *on* ou *off* (ex.: /admin ia ${targetId} off).`);
  }

  // ===========================================================================
  // /admin entrosao <chatId> [nivel]
  // ===========================================================================

  private async adminEntrosao(msg: Message, chatId: string, args: string[]): Promise<void> {
    const targetId = (args[0] || '').trim();
    const levelStr = (args[1] || '').trim();

    if (!targetId || !this.isValidWhatsAppChatId(targetId)) {
      await this.app.reportError(msg, chatId, 'use: */admin entrosao <chatId> <nivel>*.\nEx.: /admin entrosao 120363xxx@g.us 1.5\n(O chatId precisa terminar em @g.us, @c.us ou @lid.)');
      return;
    }

    if (!levelStr) {
      const level = this.app.brain.chatEntrosaoLevel.get(targetId) ?? 1.0;
      const pct = Math.round(level * 100);
      await this.app.notify(chatId, `*Entrosão em ${targetId}:*\n\nAtual: *${level.toFixed(2)}* (${pct}%)\n\nUse */admin entrosao ${targetId} <0-2>* pra ajustar.`);
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    const num = parseFloat(levelStr.replace(',', '.'));
    if (isNaN(num) || num < 0 || num > 2) {
      await this.app.reportError(msg, chatId, `valor inválido: "${levelStr}". Use um número entre *0* e *2* (ex.: 1.5).`);
      return;
    }

    this.app.brain.chatEntrosaoLevel.set(targetId, num);
    const pct = Math.round(num * 100);
    await this.app.notify(chatId, `🎚️ entrosão de ${targetId} ajustada pra *${num.toFixed(2)}* (${pct}%).`);
    this.app.log('ADMIN', `Entrosão de ${targetId} setada pra ${num} por op (via /admin entrosao).`);
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin info <chatId> — info detalhada de um chat
  // ===========================================================================

  private async adminInfo(msg: Message, chatId: string, args: string[]): Promise<void> {
    const targetId = (args[0] || '').trim();
    if (!targetId || !this.isValidWhatsAppChatId(targetId)) {
      await this.app.reportError(msg, chatId, 'use: */admin info <chatId>*.\nEx.: /admin info 120363xxx@g.us');
      return;
    }

    const isGroup = targetId.endsWith('@g.us');
    const aiOn = !this.app.brain.aiDisabledChats.has(targetId);
    const entrosao = this.app.brain.chatEntrosaoLevel.get(targetId) ?? 1.0;

    // Tenta achar o chat pra pegar nome
    let chatName = '(desconhecido)';
    let memberCount = 0;
    try {
      const chats = await this.app.whatsapp.client.getChats();
      const found = chats.find((c: any) => c.id && c.id._serialized === targetId);
      if (found) {
        chatName = found.name || found.formattedTitle || chatName;
        if (isGroup && found.participants) {
          memberCount = found.participants.length;
        }
      }
    } catch (e) {
      this.app.debug('ADMIN', `info: não achei chat ${targetId} em getChats(): ${(e as Error).message}`);
    }

    // Contexto (mensagens acumuladas)
    const ctx = this.app.context.getRecent(targetId);
    const ctxCount = ctx.length;

    // Perfil de estilo
    const profile = this.app.profile.get(targetId);
    const s = profile.style;
    const profileLines: string[] = [];
    profileLines.push(`Mensagens aprendidas: ${s.totalMessages || 0}`);
    if (s.totalMessages > 0) {
      const avgLen = Math.round((s.totalLength || 0) / s.totalMessages);
      profileLines.push(`Tamanho médio: ${avgLen} chars`);
      profileLines.push(`Gírias únicas: ${Object.keys(profile.vocabulary || {}).length}`);
      profileLines.push(`Usuários ativos mapeados: ${Object.keys(profile.userActivity || {}).length}`);
    }

    // Banidos
    const banned = this.app.permissions.loadBanned();

    // Últimas mensagens do contexto (até 5)
    const lastCtx = ctx.slice(-5);

    const lines = [
      `*📋 Info: ${chatName}*`,
      '',
      `Tipo: ${isGroup ? 'Grupo' : 'PV'}`,
      `ID: ${targetId}`,
    ];
    if (isGroup && memberCount > 0) lines.push(`Membros: ${memberCount}`);
    lines.push(`IA global: ${this.app.aiConfig?.enabled ? '✅' : '🛑'}`);
    lines.push(`IA neste chat: ${aiOn ? '✅' : '🛑'}`);
    lines.push(`Entrosão: ${entrosao.toFixed(2)}`);
    lines.push(`Mensagens no contexto: ${ctxCount}`);
    lines.push(`Banidos (global): ${banned.length}`);
    lines.push('');
    lines.push('*Perfil de estilo:*');
    lines.push(...profileLines.map(l => `  • ${l}`));

    if (lastCtx.length > 0) {
      lines.push('', '*Últimas msgs no contexto:*');
      lastCtx.forEach((m, i) => {
        const role = m.role === 'assistant' ? '🤖' : '👤';
        const senderTag = m.sender ? `${m.sender}: ` : '';
        const txt = (m.content || '').slice(0, 80);
        lines.push(`  ${i + 1}. ${role} ${senderTag}${txt}`);
      });
    }

    if (isGroup && banned.length > 0) {
      lines.push('', '*Banidos (global):*');
      banned.slice(0, 10).forEach((b, i) => {
        const id = b.phone || b.lid;
        lines.push(`  ${i + 1}. ${id}`);
      });
      if (banned.length > 10) lines.push(`  _...e mais ${banned.length - 10}_`);
    }

    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin debug <on|off|full>
  // ===========================================================================

  private async adminDebug(msg: Message, chatId: string, args: string[]): Promise<void> {
    const mode = (args[0] || '').toLowerCase();
    if (mode === 'on') {
      this.app.debugEnabled = true;
      this.app.debugFullEnabled = false;
      await this.app.notify(chatId, 'Debug *on* ✅ (logs normais, sem prompt completo).');
      this.app.log('ADMIN', 'Debug ligado (normal) por op.');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }
    if (mode === 'off') {
      this.app.debugEnabled = false;
      this.app.debugFullEnabled = false;
      await this.app.notify(chatId, 'Debug *off* 🔇 (sem logs de debug no terminal).');
      this.app.log('ADMIN', 'Debug desligado por op.');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }
    if (mode === 'full') {
      this.app.debugEnabled = true;
      this.app.debugFullEnabled = true;
      await this.app.notify(chatId, 'Debug *full* 🐛 (logs normais + prompt completo + resposta bruta da IA).');
      this.app.log('ADMIN', 'Debug FULL ligado por op.');
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }
    await this.app.reportError(msg, chatId, 'use: */admin debug <on|off|full>*.\n• *on* = logs normais\n• *off* = sem debug\n• *full* = logs + prompt completo da IA');
  }

  // ===========================================================================
  // /admin log [n] — últimas N linhas do bot.log
  // ===========================================================================

  private async adminLog(msg: Message, chatId: string, args: string[]): Promise<void> {
    let n = 20;
    if (args[0]) {
      const parsed = parseInt(args[0], 10);
      if (isNaN(parsed) || parsed < 1) {
        await this.app.reportError(msg, chatId, `valor inválido: "${args[0]}". Use um número inteiro positivo (ex.: /admin log 30).`);
        return;
      }
      n = parsed;
    }
    const text = this.readLastLogLines(n);
    const header = `*Últimas ${Math.min(n, 50)} linhas do bot.log:*`;
    await this.app.notify(chatId, `${header}\n\n\`\`\`\n${text}\n\`\`\``);
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin features — controla retroativo e memória em runtime
  // ===========================================================================

  private async adminFeatures(msg: Message, chatId: string, args: string[]): Promise<void> {
    const sub = (args[0] || '').toLowerCase();
    const val = args[1];

    if (sub === 'status' || sub === '' || sub === 'ajuda') {
      const lines = [
        '*⚙️ Features do bot:*',
        '',
        `• Retroativo: ${this.app.retroactive.enabled ? '✅ ativado' : '🛑 desativado'}`,
        `  - Intervalo: ${this.app.retroactive.intervalMin}min`,
        `  - Janela: ${this.app.retroactive.windowMin}min`,
        '',
        `• Memória permanente: ${this.app.memory.enabled ? '✅ ativada' : '🛑 desativada'}`,
        '',
        '_Comandos:_',
        '• */admin features retro <on|off>* — liga/desliga retroativo',
        '• */admin features retro interval <min>* — muda intervalo (ex: 5, 15)',
        '• */admin features retro window <min>* — muda janela (ex: 30, 90)',
        '• */admin features memoria <on|off>* — liga/desliga memória',
      ];
      await this.app.notify(chatId, lines.join('\n'));
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /admin features retro <on|off|interval N|window N>
    if (sub === 'retro') {
      const action = (val || '').toLowerCase();
      if (action === 'on') {
        this.app.retroactive.enabled = true;
        this.app.retroactive.setupTimer();
        await this.app.notify(chatId, `✅ Retroativo ativado (intervalo: ${this.app.retroactive.intervalMin}min, janela: ${this.app.retroactive.windowMin}min)`);
        this.app.log('ADMIN', 'Retroativo ativado via /admin features');
      } else if (action === 'off') {
        this.app.retroactive.enabled = false;
        this.app.retroactive.setupTimer();
        await this.app.notify(chatId, '🛑 Retroativo desativado');
        this.app.log('ADMIN', 'Retroativo desativado via /admin features');
      } else if (action === 'interval') {
        const min = parseInt(args[2], 10);
        if (isNaN(min) || min < 1 || min > 120) {
          await this.app.reportError(msg, chatId, 'intervalo inválido. Use um número entre 1 e 120 minutos. Ex: */admin features retro interval 5*');
          return;
        }
        this.app.retroactive.intervalMin = min;
        this.app.retroactive.setupTimer();
        await this.app.notify(chatId, `✅ Intervalo do retroativo mudado pra ${min}min`);
        this.app.log('ADMIN', `Retroativo intervalo mudado para ${min}min`);
      } else if (action === 'window') {
        const min = parseInt(args[2], 10);
        if (isNaN(min) || min < 5 || min > 240) {
          await this.app.reportError(msg, chatId, 'janela inválida. Use um número entre 5 e 240 minutos. Ex: */admin features retro window 30*');
          return;
        }
        this.app.retroactive.windowMin = min;
        await this.app.notify(chatId, `✅ Janela do retroativo mudada pra ${min}min`);
        this.app.log('ADMIN', `Retroativo janela mudada para ${min}min`);
      } else {
        await this.app.reportError(msg, chatId, 'uso: */admin features retro <on|off|interval N|window N>*');
        return;
      }
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /admin features memoria <on|off>
    if (sub === 'memoria' || sub === 'memória') {
      const action = (val || '').toLowerCase();
      if (action === 'on') {
        this.app.memory.enabled = true;
        await this.app.notify(chatId, '✅ Memória permanente ativada');
        this.app.log('ADMIN', 'Memória ativada via /admin features');
      } else if (action === 'off') {
        this.app.memory.enabled = false;
        await this.app.notify(chatId, '🛑 Memória permanente desativada (memórias existentes não são apagadas)');
        this.app.log('ADMIN', 'Memória desativada via /admin features');
      } else {
        await this.app.reportError(msg, chatId, 'uso: */admin features memoria <on|off>*');
        return;
      }
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    await this.app.reportError(msg, chatId, `subcomando desconhecido: "${sub}". Use */admin features* pra ver as opções.`);
  }

  // ===========================================================================
  // /admin modelo — mostra o modelo de IA + fallbacks
  // ===========================================================================

  private async adminModelo(msg: Message, chatId: string): Promise<void> {
    const cfg = this.app.brain.getAIConfig();
    const allModels = this.app.brain.getAllFallbackModels();
    const primary = allModels[0];
    const fallbacks = allModels.slice(1);

    const lines = [
      '*🤖 Modelos de IA:*',
      '',
      `Principal: *${primary}*`,
    ];

    if (fallbacks.length > 0) {
      lines.push(`Fallbacks:`);
      fallbacks.forEach((m, i) => lines.push(`  ${i + 1}. ${m}`));
    } else {
      lines.push('Fallbacks: nenhum configurado');
    }

    lines.push('');
    lines.push(`Último usado: ${this.app.brain.lastUsedModel || primary}`);
    lines.push(`Provider: ${cfg.provider || (cfg.apiUrl.includes('googleapis') ? 'gemini' : 'openai')}`);
    lines.push(`Max tokens: ${cfg.maxTokens} | Temp: ${cfg.temperature}`);

    // Limites conhecidos do Gemini free tier (preservado do velho)
    const limits: Record<string, { rpm: number; rpd: number }> = {
      'gemini-3.5-flash-lite': { rpm: 15, rpd: 500 },
      'gemini-3.1-flash-lite': { rpm: 15, rpd: 500 },
      'gemini-3.8-flash': { rpm: 5, rpd: 20 },
    };
    lines.push('');
    lines.push('*Limites (free tier):*');
    for (const m of allModels) {
      const lim = limits[m];
      if (lim) {
        lines.push(`• ${m}: ${lim.rpm} RPM, ${lim.rpd} RPD`);
      }
    }

    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin stats — estatísticas de uso
  // ===========================================================================

  private async adminStats(msg: Message, chatId: string): Promise<void> {
    // Figurinhas no vault
    let totalStickers = 0;
    try {
      const vaultDir = this.app.dataPath('stickers-vault');
      if (fs.existsSync(vaultDir)) {
        totalStickers = fs.readdirSync(vaultDir)
          .filter(f => /\.(webp|png|jpg)$/.test(f)).length;
      }
    } catch { /* ignora */ }

    const namedStickers = this.app.stickers.listNamed().length;
    const directives = this.app.directives.all().length;
    const chatsWithCtx = this.app.context.activeChatIds().length;
    const twitterOn = !!(this.app.twitter);

    const lines = [
      '*📊 Stats do bot:*',
      '',
      `Requests de IA hoje: ${this.app.brain.aiRequestCount}`,
      `Figurinhas no vault: ${totalStickers}`,
      `Figurinhas nomeadas/fav: ${namedStickers}`,
      `Diretivas ativas: ${directives}`,
      `Chats com histórico carregado: ${this.app.context.historyLoadedCount()}`,
      `Chats com contexto em memória: ${chatsWithCtx}`,
      `Chats com IA desativada: ${this.app.brain.aiDisabledChats.size}`,
      `Uptime: ${this.formatUptime()}`,
      `Debug: ${this.app.debugEnabled ? 'on' : 'off'}${this.app.debugFullEnabled ? ' (full)' : ''}`,
      `Twitter: ${twitterOn ? 'on' : 'off'}`,
      `IA global: ${this.app.aiConfig?.enabled ? 'on' : 'off'}`,
    ];
    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin ajuda — lista todos os subcomandos
  // ===========================================================================

  private async adminAjuda(msg: Message, chatId: string): Promise<void> {
    const lines = [
      '*🎛️ /admin — subcomandos:*',
      '',
      '• */admin* ou */admin status* — overview (IA, contador, debug, twitter, últimos grupos).',
      '• */admin grupos* — lista todos os grupos que o bot está (até 20).',
      '• */admin chats* — lista todos os chats (grupos + PVs) com atividade recente.',
      '• */admin ia <chatId> <on|off>* — controla IA de qualquer chat (sem arg = status).',
      '• */admin entrosao <chatId> <nivel>* — ajusta entrosão de qualquer chat (0-2).',
      '• */admin info <chatId>* — info detalhada de um chat (perfil, contexto, banidos).',
      '• */admin debug <on|off|full>* — liga/desliga debug em runtime.',
      '• */admin log [n]* — últimas N linhas do bot.log (default 20, máx 50).',
      '• */admin stats* — estatísticas de uso (requests, figurinhas, uptime, etc).',
      '• */admin modelo* — mostra qual modelo de IA está sendo usado e os fallbacks.',
      '• */admin features* — controla retroativo e memória (/admin features retro off, /admin features memoria off).',
      '• */admin retro* — controla retroativo manualmente (//retro agora, //retro limpar).',
      '• */admin ler* — FORÇA leitura de msgs antigas: */admin ler <chatId> [qtd] [memoria]*, */admin ler aqui*, */admin ler todos*, */admin ler status*.',
      '• */admin reiniciar* — reinicia o bot (pede confirmação).',
      '• */admin desligar* — desliga o bot completamente (pede confirmação).',
      '• */admin ajuda* — esta lista.',
      '',
      '_⚠️ SÓ funciona no PV do bot (não em grupo). Só ops._',
    ];
    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin retro — controla sistema retroativo manualmente
  // ===========================================================================

  private async adminRetro(msg: Message, chatId: string, args: string[]): Promise<void> {
    const action = (args[0] || '').toLowerCase();

    if (action === 'agora' || action === 'force') {
      await this.app.react(msg, EMOJI.LOADING);
      await this.app.notify(chatId, '🔄 Forçando verificação retroativa agora...');
      this.app.debug('RETRO', 'verificação forçada via //retro agora');

      // Roda o check em background
      this.app.retroactive.forceCheck().then(() => {
        this.app.debug('RETRO', 'verificação forçada concluída');
      }).catch(e => {
        this.app.debug('RETRO', `erro na verificação forçada: ${(e as Error).message}`);
      });

      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, '✅ Verificação retroativa disparada! Checa o terminal pra ver o resultado.');
      return;
    }

    if (action === 'limpar' || action === 'clear' || action === 'reset') {
      const targetChatId = args[1];

      if (targetChatId) {
        // Limpa só um chat específico
        this.app.retroactive.clear(targetChatId);
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, `🧹 Decision log limpa para o chat: ${targetChatId}`);
        this.app.debug('RETRO', `decision log limpa para ${targetChatId} por comando`);
      } else {
        // Limpa TUDO
        this.app.retroactive.clear();
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, '🧹 Decision log limpa completamente! Todas as decisões foram resetadas.');
        this.app.debug('RETRO', 'decision log completamente limpa por comando');
      }
      return;
    }

    // Sem ação → mostra status
    // Conta pendings somando todos os chats
    let totalPending = 0;
    let totalChats = 0;
    for (const cid of this.app.context.activeChatIds()) {
      const pending = this.app.retroactive.pendingCount(cid);
      if (pending > 0) {
        totalPending += pending;
        totalChats++;
      }
    }

    await this.app.notify(chatId,
      `*🔄 Sistema Retroativo:*\n\n` +
      `Status: ${this.app.retroactive.enabled ? '✅ ativado' : '🛑 desativado'}\n` +
      `Intervalo: ${this.app.retroactive.intervalMin}min\n` +
      `Janela: ${this.app.retroactive.windowMin}min\n` +
      `Mensagens pending: ${totalPending} em ${totalChats} chat(s)\n\n` +
      `Comandos:\n` +
      `• *//retro agora* — força verificação imediata\n` +
      `• *//retro limpar* — limpa toda a decision log\n` +
      `• *//retro limpar <chatId>* — limpa um chat específico`
    );
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin ler — força leitura de mensagens antigas do histórico
  // ===========================================================================

  private async adminLer(msg: Message, chatId: string, args: string[]): Promise<void> {
    const sub = (args[0] || '').toLowerCase();

    // --- /admin ler status ---
    if (sub === 'status' || sub === 'lista') {
      const loaded = this.app.context.activeChatIds();
      const lines = ['*📚 Histórico carregado:*', ''];
      if (loaded.length === 0) {
        lines.push('_Nenhum chat com histórico carregado ainda._');
      } else {
        lines.push(`${loaded.length} chat(s) já lidos (não vão recarregar sozinhos):`);
        for (const id of loaded.slice(0, 25)) {
          const ctxCount = this.app.context.count(id);
          lines.push(`• ${id} (${ctxCount} msgs no contexto)`);
        }
        if (loaded.length > 25) lines.push(`_...e mais ${loaded.length - 25}_`);
      }
      lines.push('', '_Use */admin ler <chatId> [qtd] [memoria]* pra forçar releitura._');
      await this.app.notify(chatId, lines.join('\n'));
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // --- parsing de qtd e flag memoria ---
    const parseLimitAndMemory = (argList: string[]): { limit: number; withMemory: boolean } => {
      let limit = 200;
      let withMemory = false;
      for (const a of argList) {
        const lower = a.toLowerCase();
        if (lower === 'memoria' || lower === 'mem' || lower === 'memory') {
          withMemory = true;
        } else if (/^\d+$/.test(a)) {
          limit = parseInt(a, 10);
        }
      }
      return { limit, withMemory };
    };

    // --- /admin ler aqui [qtd] [memoria] ---
    if (sub === 'aqui' || sub === 'pv' || sub === 'this') {
      const { limit, withMemory } = parseLimitAndMemory(args.slice(1));
      await this.app.react(msg, EMOJI.LOADING);
      await this.app.notify(chatId, `📖 Lendo ${limit} mensagens deste PV... ${withMemory ? '(com extração de memória — pode levar alguns minutos)' : ''}`);

      const stats = await this.app.context.forceReadChatHistory(chatId, limit, withMemory, {
        onProgress: (m) => this.app.debug('ADMIN', m),
        onMemorySettled: withMemory ? (s) => {
          this.app.notify(chatId, this.formatMemorySettled(s)).catch(() => { /* ignora */ });
        } : undefined,
      });

      if (!stats.ok) {
        await this.app.reportError(msg, chatId, `❌ Erro ao ler histórico: ${stats.error}`);
        return;
      }
      await this.app.notify(chatId, this.formatLerStats(stats, withMemory));
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // --- /admin ler todos [qtd] [memoria] ---
    if (sub === 'todos' || sub === 'all' || sub === 'grupos') {
      const { limit, withMemory } = parseLimitAndMemory(args.slice(1));

      // Lista grupos
      let groups: BotGroupItem[] = [];
      try {
        groups = await this.listBotGroups(200);
      } catch (e) {
        await this.app.reportError(msg, chatId, `erro ao listar grupos: ${(e as Error).message}`);
        return;
      }
      if (groups.length === 0) {
        await this.app.reportError(msg, chatId, 'nenhum grupo encontrado.');
        return;
      }

      await this.app.react(msg, EMOJI.LOADING);
      await this.app.notify(chatId,
        `📚 *Leitura em lote:* ${groups.length} grupos, ${limit} msgs cada${withMemory ? ' (com memória)' : ''}.\n` +
        `_Isso vai demorar. Vou mandando o progresso aqui. Não interrompa o bot._`
      );

      // Roda em background — não bloqueia o handler
      (async () => {
        let okCount = 0;
        let failCount = 0;
        let totalAdded = 0;
        let totalMemoryQueued = 0;
        let totalMemorySaved = 0;
        const memorySettledPromises: Promise<void>[] = [];
        const failures: string[] = [];
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          try {
            // Pra o batch, criamos uma Promise que resolve quando as
            // extrações de memória do grupo terminam (onMemorySettled).
            let settleResolve: () => void = () => {};
            const settlePromise = new Promise<void>(r => { settleResolve = r; });
            const s = await this.app.context.forceReadChatHistory(g.id, limit, withMemory, {
              onMemorySettled: withMemory ? (st) => {
                totalMemorySaved += (st.memorySaved || 0);
                settleResolve();
              } : settleResolve,
            });
            if (s.ok) {
              okCount++;
              totalAdded += s.added;
              totalMemoryQueued += s.memoryQueued;
              if (withMemory && s.memoryQueued > 0) {
                memorySettledPromises.push(settlePromise);
              }
            } else {
              failCount++;
              failures.push(`${g.name}: ${s.error}`);
            }
          } catch (e) {
            failCount++;
            failures.push(`${g.name}: ${(e as Error).message}`);
          }
          // Avisa progresso a cada 5 grupos
          if ((i + 1) % 5 === 0 || i === groups.length - 1) {
            await this.app.notify(chatId, `⏳ Progresso: ${i + 1}/${groups.length} grupos lidos...`);
          }
        }

        // Relatório intermediário (contexto + perfil já pronto; memória ainda roda)
        const summary: string[] = [
          `✅ *Leitura em lote concluída!*`,
          ``,
          `Grupos lidos: ${okCount}/${groups.length}`,
          `Falhas: ${failCount}`,
          `Mensagens adicionadas ao contexto: ${totalAdded}`,
        ];
        if (withMemory) {
          summary.push(`Memórias em processamento (IA): ${totalMemoryQueued}`);
        }
        if (failures.length > 0) {
          summary.push('', '_Falhas:_');
          summary.push(...failures.slice(0, 8).map(f => `• ${f}`));
          if (failures.length > 8) summary.push(`_...e mais ${failures.length - 8}_`);
        }
        if (withMemory && totalMemoryQueued > 0) {
          summary.push('', `_⏳ ${totalMemoryQueued} extrações de memória ainda rodam em background. Vou mandar o resultado real aqui quando terminarem._`);
        }
        await this.app.notify(chatId, summary.join('\n'));

        // Espera todas as extrações de memória de todos os grupos terminarem
        if (withMemory && memorySettledPromises.length > 0) {
          await Promise.all(memorySettledPromises);
          const discarded = totalMemoryQueued - totalMemorySaved;
          const memSummary: string[] = [
            `🧠 *Memória em lote — resultado final:*`,
            ``,
            `Extrações processadas: ${totalMemoryQueued}`,
            `✅ Fatos salvos em memories.json: ${totalMemorySaved}`,
            `⏭️ Descartados pela IA (NENHUM/opinião): ${discarded}`,
          ];
          if (totalMemorySaved === 0 && totalMemoryQueued > 0) {
            memSummary.push('', '_ℹ️ Nenhuma memória salva. As mensagens do período provavelmente eram opiniões/conversa casual._');
          } else if (totalMemorySaved > 0) {
            memSummary.push('', '_Use /memoria pra ver os fatos salvos._');
          }
          await this.app.notify(chatId, memSummary.join('\n'));
        }
      })().catch(e => {
        this.app.debug('ADMIN', `erro no batch /admin ler todos: ${(e as Error).message}`);
        this.app.notify(chatId, `❌ Erro no batch de leitura: ${(e as Error).message}`).catch(() => { /* ignora */ });
      });

      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // --- /admin ler <chatId> [qtd] [memoria] ---
    if (!sub || !this.isValidWhatsAppChatId(sub)) {
      await this.app.reportError(msg, chatId,
        'use: */admin ler <chatId> [qtd] [memoria]*\n' +
        'ou: */admin ler aqui [qtd] [memoria]*\n' +
        'ou: */admin ler todos [qtd] [memoria]*\n' +
        'ou: */admin ler status*\n\n' +
        '• qtd = nº de mensagens (default 200, máx 1000)\n' +
        '• memoria = também extrai fatos permanentes (cap 30/chamada)'
      );
      return;
    }

    const targetId = sub;
    const { limit, withMemory } = parseLimitAndMemory(args.slice(1));

    await this.app.react(msg, EMOJI.LOADING);
    await this.app.notify(chatId, `📖 Lendo ${limit} mensagens de ${targetId}... ${withMemory ? '(com memória)' : ''}`);

    const stats = await this.app.context.forceReadChatHistory(targetId, limit, withMemory, {
      onProgress: (m) => this.app.debug('ADMIN', m),
      onMemorySettled: withMemory ? (s) => {
        this.app.notify(chatId, this.formatMemorySettled(s)).catch(() => { /* ignora */ });
      } : undefined,
    });

    if (!stats.ok) {
      await this.app.reportError(msg, chatId, `❌ Erro ao ler histórico: ${stats.error}`);
      return;
    }
    await this.app.notify(chatId, this.formatLerStats(stats, withMemory));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /admin reiniciar — destroy + initialize (com confirmação)
  // ===========================================================================

  private async adminReiniciar(msg: Message, chatId: string, args: string[]): Promise<void> {
    const confirm = args[0]?.toLowerCase();

    if (confirm !== 'confirmar' && confirm !== 'confirm') {
      await this.app.notify(chatId,
        '⚠️ *Reiniciar o bot?*\n\n' +
        'Isso vai desconectar e reconectar o WhatsApp. O bot fica offline por ~30 segundos.\n\n' +
        'Para confirmar, envie: */admin reiniciar confirmar*'
      );
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    await this.app.react(msg, EMOJI.SUCCESS);
    await this.app.notify(chatId, '🔄 *Reiniciando o bot...*\n\nVolto já! 🤖');
    this.app.log('ADMIN', `Bot reiniciado por comando /admin reiniciar (chat ${chatId})`);
    this.app.debug('ADMIN', 'reiniciando bot em 3 segundos...');

    // Espera 3s pra mensagem chegar
    setTimeout(() => {
      this.app.log('ADMIN', '=== BOT REINICIANDO ===');
      // Salva tudo que precisa antes de reiniciar
      try {
        if (this.app.profile) this.app.profile.save();
      } catch { /* ignora */ }

      // Fecha o cliente graciosamente e reinicia
      this.app.whatsapp.client.destroy().then(() => {
        this.app.debug('ADMIN', 'cliente fechado, reiniciando...');
        // Re-inicializa
        this.app.whatsapp.client.initialize();
      }).catch(() => {
        // Se falhar ao fechar, força reinicialização
        this.app.whatsapp.client.initialize();
      });
    }, 3000);
  }

  // ===========================================================================
  // /admin desligar — destroy + process.exit(0) (com confirmação)
  // ===========================================================================

  private async adminDesligar(msg: Message, chatId: string, args: string[]): Promise<void> {
    const confirm = args[0]?.toLowerCase();

    if (confirm !== 'confirmar' && confirm !== 'confirm') {
      await this.app.notify(chatId,
        '🛑 *DESLIGAR o bot?*\n\n' +
        '⚠️ O bot vai ficar COMPLETAMENTE OFFLINE até você reiniciar manualmente no terminal.\n\n' +
        'Para confirmar, envie: */admin desligar confirmar*'
      );
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    await this.app.react(msg, EMOJI.SUCCESS);
    await this.app.notify(chatId, '🛑 *Desligando o bot...*\n\nTchau! Reinicie manualmente com `node dist/bot.js` 🤖');
    this.app.log('ADMIN', `Bot desligado por comando /admin desligar`);
    this.app.debug('ADMIN', 'desligando bot em 5 segundos...');

    // Espera 5s pra mensagem chegar
    setTimeout(() => {
      this.app.log('ADMIN', '=== BOT DESLIGADO ===');

      // Salva tudo antes de desligar
      try {
        if (this.app.profile) this.app.profile.save();
      } catch { /* ignora */ }

      // Fecha o cliente e sai do processo
      this.app.whatsapp.client.destroy().then(() => {
        this.app.debug('ADMIN', 'cliente fechado, saindo do processo...');
        process.exit(0);
      }).catch(() => {
        process.exit(0);
      });
    }, 5000);
  }

  // ===========================================================================
  // /op — concede op a um usuário
  // ===========================================================================

  private async handleOp(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const sender = await this.app.permissions.resolveSenderIds(msg);
    const senderIsOp = this.app.permissions.isOp(msg.fromMe, sender.all);
    this.app.debug('OP', `iniciando /op | sender ids=`, sender.all, `| isOp=${senderIsOp}`);

    if (!senderIsOp) {
      await this.app.reportError(msg, chatId, 'você não tem permissão para usar este comando. Apenas *ops* podem conceder op.');
      this.app.log('OP', `Tentativa não autorizada de /op por ${sender.all.join(' / ')} em ${chatId}.`);
      return;
    }

    const target = await this.app.permissions.resolveTarget(msg);
    this.app.debug('OP', `alvo resolvido:`, target);

    if (!target || (!target.lid && !target.phone)) {
      await this.app.reportError(
        msg, chatId,
        'para usar o comando corretamente, se atente à sintaxe:\n\n• Responda à mensagem do usuário com */op*; ou\n• Envie */op <número>* (ex.: /op 5511999999999).'
      );
      return;
    }

    const targetIds = [target.lid, target.phone].filter(Boolean) as string[];

    // Não faz sentido dar op pro próprio bot (já é op sempre)
    if (this.app.permissions.isOp(false, targetIds)) {
      this.app.debug('OP', `alvo já é op (bot ou op existente)`);
      await this.app.reportError(msg, chatId, 'este usuário já é um *op*. ⭐');
      return;
    }

    const ops = this.app.permissions.loadOps();
    this.app.debug('OP', `lista atual de ops:`, ops);

    const targetDigits = targetIds.map(d => this.app.permissions.digitsOnly(d));
    const alreadyOp = ops.some(entry => {
      const entryDigits = [entry.lid, entry.phone].filter(Boolean).map(d => this.app.permissions.digitsOnly(d as string));
      return entryDigits.some(d => targetDigits.includes(d));
    });
    if (alreadyOp) {
      await this.app.reportError(msg, chatId, 'este usuário já é um *op*. ⭐');
      return;
    }

    const added = this.app.permissions.addOp(target.lid, target.phone);
    if (!added) {
      await this.app.reportError(msg, chatId, 'este usuário já é um *op*. ⭐');
      return;
    }
    this.app.debug('OP', `op adicionado: lid=${target.lid} phone=${target.phone}`);

    const reloaded = this.app.permissions.loadOps();
    this.app.debug('OP', `re-leitura do ops.json:`, reloaded);

    await this.app.react(msg, EMOJI.SUCCESS);
    const display = target.phone || target.lid;
    await this.app.notify(chatId, `op concedido com sucesso. ⭐\nID: ${display}`);
    this.app.log('OP', `Op concedido: ${display} (LID: ${target.lid || 'n/a'}) (por ${sender.all.join(' / ')}).`);
  }

  // ===========================================================================
  // /deop — revoga op de um usuário
  // ===========================================================================

  private async handleDeop(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const sender = await this.app.permissions.resolveSenderIds(msg);
    const senderIsOp = this.app.permissions.isOp(msg.fromMe, sender.all);

    if (!senderIsOp) {
      await this.app.reportError(msg, chatId, 'você não tem permissão para usar este comando. Apenas *ops* podem remover op.');
      this.app.log('DEOP', `Tentativa não autorizada de /deop por ${sender.all.join(' / ')} em ${chatId}.`);
      return;
    }

    const target = await this.app.permissions.resolveTarget(msg);
    this.app.debug('DEOP', `alvo resolvido:`, target);

    if (!target || (!target.lid && !target.phone)) {
      await this.app.reportError(
        msg, chatId,
        'para usar o comando corretamente, se atente à sintaxe:\n\n• Responda à mensagem do usuário com */deop*; ou\n• Envie */deop <número>* (ex.: /deop 5511999999999).'
      );
      return;
    }

    const targetIds = [target.lid, target.phone].filter(Boolean) as string[];
    const targetDigits = targetIds.map(d => this.app.permissions.digitsOnly(d));

    // Protege INITIAL_OPS: não podem ser deop'd pelo comando (igual ao server.properties)
    const isInitialOp = this.app.permissions.initialOps.some(o => targetDigits.includes(this.app.permissions.digitsOnly(o)));
    if (isInitialOp) {
      this.app.debug('DEOP', `tentativa de deop de INITIAL_OP bloqueada`);
      await this.app.reportError(msg, chatId, 'este é um *op inicial* (configurado no código) e não pode ser removido pelo comando. Para removê-lo, edite initialOps no PermissionSystem e reinicie o bot.');
      return;
    }

    const ops = this.app.permissions.loadOps();
    this.app.debug('DEOP', `lista atual de ops:`, ops);

    const exists = ops.some(entry => {
      const entryDigits = [entry.lid, entry.phone].filter(Boolean).map(d => this.app.permissions.digitsOnly(d as string));
      return entryDigits.some(d => targetDigits.includes(d));
    });
    if (!exists) {
      await this.app.reportError(msg, chatId, 'este usuário não é um *op* (ou é o próprio bot, que é op permanente).');
      return;
    }

    const removed = this.app.permissions.removeOp(target.lid, target.phone);
    if (!removed) {
      await this.app.reportError(msg, chatId, 'este usuário não é um *op* (ou é o próprio bot, que é op permanente).');
      return;
    }
    this.app.debug('DEOP', `op removido: lid=${target.lid} phone=${target.phone}`);

    await this.app.react(msg, EMOJI.SUCCESS);
    const display = target.phone || target.lid;
    await this.app.notify(chatId, `op removido com sucesso. 📉\nID: ${display}`);
    this.app.log('DEOP', `Op removido: ${display} (por ${sender.all.join(' / ')}).`);
  }

  // ===========================================================================
  // /ops — lista os operadores atuais
  // ===========================================================================

  private async handleListOps(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const sender = await this.app.permissions.resolveSenderIds(msg);
    const senderIsOp = this.app.permissions.isOp(msg.fromMe, sender.all);

    if (!senderIsOp) {
      await this.app.reportError(msg, chatId, 'você não tem permissão para usar este comando. Apenas *ops* podem ver a lista de operadores.');
      return;
    }

    const ops = this.app.permissions.loadOps();
    this.app.debug('OPS', `lista atual (${ops.length}):`, ops);

    const lines = ['*Operadores (ops) atuais:*', ''];

    // O bot é sempre op
    lines.push('1. 🤖 *O próprio bot* (op permanente)');

    // INITIAL_OPS
    this.app.permissions.initialOps.forEach((o, i) => {
      lines.push(`${i + 2}. ${o} *(op inicial — fixo no código)*`);
    });

    // Ops persistidos
    ops.forEach((entry, i) => {
      const id = entry.phone || entry.lid;
      const extra = entry.lid && entry.phone ? ` (LID: ${entry.lid})` : '';
      lines.push(`${i + 2 + this.app.permissions.initialOps.length}. ${id}${extra}`);
    });

    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // /ban — bane um usuário
  // ===========================================================================

  private async handleBan(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const owner = await this.app.permissions.resolveSenderIds(msg);
    const senderIsOp = this.app.permissions.isOp(msg.fromMe, owner.all);
    this.app.debug('BAN', `iniciando !ban | sender ids=`, owner.all, `| isOp=${senderIsOp}`);

    if (!senderIsOp) {
      await this.app.reportError(msg, chatId, 'você não tem permissão para usar este comando. Apenas *ops* podem banir usuários.');
      this.app.log('BAN', `Tentativa não autorizada de !ban por ${owner.all.join(' / ')} em ${chatId}.`);
      return;
    }

    const target = await this.app.permissions.resolveTarget(msg);
    this.app.debug('BAN', `alvo resolvido:`, target);

    if (!target || (!target.lid && !target.phone)) {
      await this.app.reportError(
        msg, chatId,
        'para usar o comando corretamente, se atente à sintaxe:\n\n• Responda à mensagem do usuário com *!ban*; ou\n• Envie *!ban <número>* (ex.: !ban 5511999999999).'
      );
      return;
    }

    const targetIds = [target.lid, target.phone].filter(Boolean) as string[];
    const targetDigits = targetIds.map(d => this.app.permissions.digitsOnly(d));

    // Não deixa banir a si mesmo, o bot, ou qualquer outro op
    const targetIsOp = this.app.permissions.isOp(false, targetIds);
    if (targetIsOp) {
      this.app.debug('BAN', `tentativa de banir op bloqueada`);
      await this.app.reportError(msg, chatId, 'você não pode banir um *op* (nem o bot, nem outro operador). 🚫');
      return;
    }

    const banned = this.app.permissions.loadBanned();
    this.app.debug('BAN', `lista atual de banidos:`, banned);

    // Verifica se já está banido (LID ou telefone)
    const alreadyBanned = banned.some(entry => {
      const entryDigits = [entry.lid, entry.phone].filter(Boolean).map(d => this.app.permissions.digitsOnly(d as string));
      return entryDigits.some(d => targetDigits.includes(d));
    });
    if (alreadyBanned) {
      await this.app.reportError(msg, chatId, 'este usuário já está banido.');
      return;
    }

    const added = this.app.permissions.addBanned(target.lid, target.phone);
    if (!added) {
      await this.app.reportError(msg, chatId, 'este usuário já está banido.');
      return;
    }
    this.app.debug('BAN', `banido adicionado: lid=${target.lid} phone=${target.phone}`);

    // Relê o arquivo para confirmar que foi salvo corretamente
    const reloaded = this.app.permissions.loadBanned();
    this.app.debug('BAN', `re-leitura do banned.json:`, reloaded);

    await this.app.react(msg, EMOJI.SUCCESS);
    const display = target.phone || target.lid;
    await this.app.notify(chatId, `usuário banido com sucesso. 🚫\nID: ${display}`);
    this.app.log('BAN', `Usuário banido: ${display} (LID: ${target.lid || 'n/a'}) (por ${owner.all.join(' / ')}).`);
  }

  // ===========================================================================
  // /unban — desbane um usuário
  // ===========================================================================

  private async handleUnban(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const owner = await this.app.permissions.resolveSenderIds(msg);
    const senderIsOp = this.app.permissions.isOp(msg.fromMe, owner.all);

    if (!senderIsOp) {
      await this.app.reportError(msg, chatId, 'você não tem permissão para usar este comando. Apenas *ops* podem desbanir usuários.');
      this.app.log('UNBAN', `Tentativa não autorizada de !unban por ${owner.all.join(' / ')} em ${chatId}.`);
      return;
    }

    const target = await this.app.permissions.resolveTarget(msg);
    this.app.debug('UNBAN', `alvo resolvido:`, target);

    if (!target || (!target.lid && !target.phone)) {
      await this.app.reportError(
        msg, chatId,
        'para usar o comando corretamente, se atente à sintaxe:\n\n• Responda à mensagem do usuário com *!unban*; ou\n• Envie *!unban <número>* (ex.: !unban 5511999999999).'
      );
      return;
    }

    const targetIds = [target.lid, target.phone].filter(Boolean) as string[];
    const targetDigits = targetIds.map(d => this.app.permissions.digitsOnly(d));
    const banned = this.app.permissions.loadBanned();
    this.app.debug('UNBAN', `lista atual:`, banned);

    const exists = banned.some(entry => {
      const entryDigits = [entry.lid, entry.phone].filter(Boolean).map(d => this.app.permissions.digitsOnly(d as string));
      return entryDigits.some(d => targetDigits.includes(d));
    });
    if (!exists) {
      await this.app.reportError(msg, chatId, 'este usuário não está banido.');
      return;
    }

    const removed = this.app.permissions.removeBanned(target.lid, target.phone);
    if (!removed) {
      await this.app.reportError(msg, chatId, 'este usuário não está banido.');
      return;
    }
    this.app.debug('UNBAN', `removido: lid=${target.lid} phone=${target.phone}`);

    await this.app.react(msg, EMOJI.SUCCESS);
    const display = target.phone || target.lid;
    await this.app.notify(chatId, `usuário desbanido com sucesso. ✅\nID: ${display}`);
    this.app.log('UNBAN', `Usuário desbanido: ${display} (por ${owner.all.join(' / ')}).`);
  }

  // ===========================================================================
  // /banidos — lista os usuários banidos
  // ===========================================================================

  private async handleListBanned(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const owner = await this.app.permissions.resolveSenderIds(msg);
    const senderIsOp = this.app.permissions.isOp(msg.fromMe, owner.all);

    if (!senderIsOp) {
      await this.app.reportError(msg, chatId, 'você não tem permissão para usar este comando. Apenas *ops* podem ver a lista de banidos.');
      return;
    }

    const banned = this.app.permissions.loadBanned();
    this.app.debug('BANIDOS', `lista atual (${banned.length}):`, banned);

    if (banned.length === 0) {
      await this.app.notify(chatId, 'nenhum usuário banido no momento. 📋');
    } else {
      const list = banned.map((entry, i) => {
        const id = entry.phone || entry.lid;
        const extra = entry.lid && entry.phone ? ` (LID: ${entry.lid})` : '';
        return `${i + 1}. ${id}${extra}`;
      }).join('\n');
      await this.app.notify(chatId, `*Usuários banidos (${banned.length}):*\n\n${list}`);
    }

    await this.app.react(msg, EMOJI.SUCCESS);
  }

  // ===========================================================================
  // HELPERS — portados como métodos privados
  // ===========================================================================

  /**
   * Lista os grupos que o bot está, ordenados pela última atividade (mais
   * recentes primeiro), até o limite informado.
   * Portado byte-a-byte do index.js velho (linha 6264).
   */
  private async listBotGroups(limit: number = 20): Promise<BotGroupItem[]> {
    const chats = await this.app.whatsapp.client.getChats();
    const groups = chats.filter((c: any) => c.isGroup);
    const items: BotGroupItem[] = groups.map((c: any) => {
      let members = 0;
      try {
        // participants só existe em grupos e pode não estar populado
        members = (c.participants && c.participants.length) || 0;
      } catch { /* ignora */ }
      let lastMs = 0;
      try {
        if (c.lastMessage && c.lastMessage.timestamp) {
          lastMs = c.lastMessage.timestamp * 1000;
        } else if (c.timestamp) {
          lastMs = c.timestamp * 1000;
        }
      } catch { /* ignora */ }
      const id = c.id && c.id._serialized ? c.id._serialized : '?';
      return {
        id,
        name: c.name || c.formattedTitle || '(sem nome)',
        members,
        lastMs,
        aiOn: !this.app.brain.aiDisabledChats.has(id),
        entrosao: this.app.brain.chatEntrosaoLevel.get(id) ?? 1.0,
      };
    });
    // Ordena por última atividade (mais recente primeiro); sem atividade vai pro fim
    items.sort((a, b) => (b.lastMs || 0) - (a.lastMs || 0));
    return items.slice(0, limit);
  }

  /**
   * Formata "há quanto tempo" a partir de um timestamp (ms) — em português,
   * estilo "há 2h", "há 5min", "há 3d".
   * Portado byte-a-byte do index.js velho (linha 6210).
   */
  private humanizeAge(timestampMs: number): string {
    if (!timestampMs) return '?';
    const diffMs = Date.now() - timestampMs;
    if (diffMs < 0) return 'agora';
    const sec = Math.floor(diffMs / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `há ${min}min`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `há ${hr}h`;
    const day = Math.floor(hr / 24);
    return `há ${day}d`;
  }

  /**
   * Lê as últimas N linhas do bot.log (default 20, máx 50). Retorna string vazia
   * se o log não existir ou estiver vazio.
   * Portado byte-a-byte do index.js velho (linha 6228) — adaptado pro novo logDir.
   */
  private readLastLogLines(n: number): string {
    const logPath = path.join(this.app.config.logDir, 'bot.log');
    try {
      if (!fs.existsSync(logPath)) return '(arquivo bot.log não encontrado)';
      const content = fs.readFileSync(logPath, 'utf8');
      const lines = content.split('\n').filter(l => l.length > 0);
      const count = Math.min(Math.max(1, n), 50);
      return lines.slice(-count).join('\n') || '(log vazio)';
    } catch (e) {
      return `(erro ao ler bot.log: ${(e as Error).message})`;
    }
  }

  /**
   * Formatta a uptime do bot em "Xd Yh Zmin" a partir do startTime.
   * Portado byte-a-byte do index.js velho (linha 6244).
   */
  private formatUptime(): string {
    if (!this.app.startTime) return '?';
    const ms = Date.now() - this.app.startTime;
    if (ms < 0) return '0min';
    const sec = Math.floor(ms / 1000);
    const min = Math.floor(sec / 60);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    const parts: string[] = [];
    if (day > 0) parts.push(`${day}d`);
    if (hr % 24 > 0) parts.push(`${hr % 24}h`);
    if (min % 60 > 0) parts.push(`${min % 60}min`);
    return parts.join(' ') || '0min';
  }

  /**
   * Verifica se um ID é um chatId válido do WhatsApp.
   * Portado byte-a-byte do index.js velho (linha 6202).
   */
  private isValidWhatsAppChatId(id: string): boolean {
    return typeof id === 'string' && /^(.+@g\.us|.+@c\.us|.+@lid)$/.test(id);
  }

  /**
   * Formata o resultado de forceReadChatHistory pra mandar no WhatsApp.
   * Portado byte-a-byte do index.js velho (linha 7261).
   */
  private formatLerStats(stats: ForceReadStats, withMemory: boolean): string {
    const skipLines = Object.entries(stats.skippedReasons)
      .map(([reason, count]) => `  • ${reason}: ${count}`)
      .join('\n');
    const lines = [
      `✅ *Histórico lido: ${stats.chatName}*`,
      ``,
      `Buscadas: ${stats.fetched}`,
      `Adicionadas ao contexto: ${stats.added}`,
      `Perfil atualizado (msgs): ${stats.profileUpdated}`,
    ];
    if (withMemory) {
      lines.push(`Memórias em processamento (IA): ${stats.memoryQueued}`);
      if (stats.memoryCap > 0) {
        lines.push(`Memórias puladas (cap de 30): ${stats.memoryCap}`);
      }
      if (stats.memoryQueued > 0) {
        lines.push('', `_⏳ As ${stats.memoryQueued} extrações rodam em background. Vou mandar o resultado real aqui quando terminarem._`);
      }
    }
    if (skipLines) {
      lines.push('', '_Puladas:_', skipLines);
    }
    lines.push('', `_Contexto em memória: ${this.app.aiConfig?.contextMessages ?? 20} msgs (as mais recentes)._`);
    return lines.join('\n');
  }

  /**
   * Formata o relatório FINAL de memória — disparado pelo callback
   * onMemorySettled depois que todas as extrações staggered terminam.
   * Portado byte-a-byte do index.js velho (linha 7293).
   */
  private formatMemorySettled(stats: ForceReadStats): string {
    const discarded = stats.memoryQueued - (stats.memorySaved || 0);
    const lines = [
      `🧠 *Memória — resultado final: ${stats.chatName}*`,
      ``,
      `Extrações processadas: ${stats.memoryQueued}`,
      `✅ Fatos salvos em memories.json: ${stats.memorySaved || 0}`,
      `⏭️ Descartados pela IA (NENHUM/opinião): ${discarded}`,
    ];
    if (stats.memoryCap > 0) {
      lines.push(`🚫 Pulados pelo cap de 30: ${stats.memoryCap}`);
    }
    if ((stats.memorySaved || 0) === 0 && stats.memoryQueued > 0) {
      lines.push('', '_ℹ️ Nenhuma memória salva. As mensagens do período provavelmente eram opiniões/conversa casual — a IA só extrai fatos PERMANENTES (ex.: "moro em SP", "tenho 20 anos", "trabalho como dev")._');
    } else if ((stats.memorySaved || 0) > 0) {
      lines.push('', '_Use /memoria pra ver os fatos salvos._');
    }
    return lines.join('\n');
  }
}
