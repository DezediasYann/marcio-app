/**
 * TwitterCommands — comando /twitter (controle da integração com Twitter/X).
 *
 * Comando:
 *  - /twitter (opOnly) — dispatcher com subcomandos:
 *
 * Subcomandos:
 *  - /twitter                  → status (enabled, approvalMode, pendentes, etc.)
 *  - /twitter postar           → gera um tweet do contexto DESTE chat e posta/aprova
 *  - /twitter on               → ativa a integração (enabled=true)
 *  - /twitter off              → desativa a integração (enabled=false)
 *  - /twitter aprovar on       → liga modo aprovação (pede op antes de postar)
 *  - /twitter aprovar off      → desliga modo aprovação (posta direto)
 *  - /twitter mentions on      → liga resposta automática a menções
 *  - /twitter mentions off     → desliga resposta a menções
 *
 * on/off/aprovar/mentions salvam o twitter-config.json em disco (invalidando
 * o cache).
 *
 * Portado byte-a-byte de handleTwitter() do index.js velho (linhas 5270-5375),
 * com a adição do subcomando `mentions on/off` (não existia no velho — foi
 * adicionado pra complementar o mention checker do TwitterBot).
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.twitter       — getConfig, saveConfig, invalidateConfigCache,
 *                             generateTweet, postTweetWithApproval, pendingTweets
 *  - this.app.permissions   — resolveSenderIds, isOp (gate de op)
 *  - this.app.react / notify / reportError / log — feedback
 *  - this.app.aiConfig      — checa se IA está ativada (pra /twitter postar)
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import type { CommandDef, CommandModule } from './CommandRegistry';

// ============================================================================
// CONSTS
// ============================================================================

const EMOJI = {
  LOADING: '⏳',
  SUCCESS: '✅',
  ERROR: '❌',
} as const;

// ============================================================================
// TWITTER COMMANDS
// ============================================================================

export class TwitterCommands implements CommandModule {
  readonly name = 'twitter';
  readonly commands: CommandDef[];
  private app: MarcioApp;

  constructor(app: MarcioApp) {
    this.app = app;
    this.commands = [
      {
        name: '/twitter',
        aliases: ['!twitter'],
        handler: (msg, chatId) => this.handleTwitter(msg, chatId),
        help: 'controla o Twitter do bot (/twitter postar, /twitter on/off, /twitter aprovar on/off, /twitter mentions on/off).',
        opOnly: true,
      },
    ];
  }

  // ===========================================================================
  // HANDLER PRINCIPAL — /twitter
  // ===========================================================================

  /**
   * /twitter — controla a integração com o Twitter (apenas ops).
   *
   * Portado byte-a-byte de handleTwitter() do index.js velho (linhas
   * 5270-5375), com a adição do subcomando `mentions on/off`.
   *
   * O gate opOnly é aplicado pelo router (não repete checagem aqui). Mas o
   * bot velho fazia a checagem explícita dentro do handler pra preservar a
   * mensagem "você não tem permissão" — mantemos essa checagem dupla pra
   * preservar o comportamento.
   */
  private async handleTwitter(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    // Checagem dupla de op (preserva a mensagem de erro do velho, mesmo que
    // o router já tenha filtrado).
    const sender = await this.app.permissions.resolveSenderIds(msg);
    const senderIsOp = this.app.permissions.isOp(msg.fromMe, sender.all);
    if (!senderIsOp) {
      await this.app.reportError(msg, chatId, 'só *ops* controlam o Twitter.');
      this.app.log('TWITTER', `Tentativa não autorizada de /twitter por ${sender.all.join(' / ')} em ${chatId}.`);
      return;
    }

    const args = (msg.body || '').trim().split(/\s+/).slice(1);
    const subcommand = (args[0] || '').toLowerCase();

    // /twitter (sem subcomando) → status
    if (!subcommand) {
      await this.twitterStatus(msg, chatId);
      return;
    }

    // /twitter postar — gera tweet do contexto do chat atual
    if (subcommand === 'postar') {
      await this.twitterPostar(msg, chatId);
      return;
    }

    // /twitter on | off — ativa/desativa a integração
    if (subcommand === 'on' || subcommand === 'off') {
      await this.twitterToggle(msg, chatId, 'enabled', subcommand === 'on',
        `🐦 Twitter ${subcommand === 'on' ? 'on ✅' : 'off 🛑'}`,
        `Twitter ${subcommand === 'on' ? 'ativado' : 'desativado'} por ${sender.all.join(' / ')} em ${chatId}.`);
      return;
    }

    // /twitter aprovar on | off — liga/desliga modo aprovação
    if (subcommand === 'aprovar') {
      const subArg = (args[1] || '').toLowerCase();
      if (subArg !== 'on' && subArg !== 'off') {
        await this.app.reportError(msg, chatId, 'use */twitter aprovar on|off*.');
        return;
      }
      await this.twitterToggle(msg, chatId, 'approvalMode', subArg === 'on',
        `${subArg === 'on' ? '✅ aprovação on' : '🛑 aprovação off'}`,
        `Modo aprovação ${subArg === 'on' ? 'ligado' : 'desligado'} por ${sender.all.join(' / ')} em ${chatId}.`);
      return;
    }

    // /twitter mentions on | off — liga/desliga resposta a menções
    if (subcommand === 'mentions') {
      const subArg = (args[1] || '').toLowerCase();
      if (subArg !== 'on' && subArg !== 'off') {
        await this.app.reportError(msg, chatId, 'use */twitter mentions on|off*.');
        return;
      }
      await this.twitterToggle(msg, chatId, 'replyToMentions', subArg === 'on',
        `${subArg === 'on' ? '✅ mentions on' : '🛑 mentions off'}`,
        `Menções ${subArg === 'on' ? 'ligadas' : 'desligadas'} por ${sender.all.join(' / ')} em ${chatId}.`);
      return;
    }

    await this.app.reportError(msg, chatId, 'subcomando desconhecido. Use */twitter*.');
  }

  // ===========================================================================
  // SUBCOMANDOS
  // ===========================================================================

  /**
   * /twitter (sem subcomando) → mostra status.
   * Portado byte-a-byte de handleTwitter() (linhas 5300-5325 do velho),
   * com linha extra pra replyToMentions.
   */
  private async twitterStatus(msg: Message, chatId: string): Promise<void> {
    const config = this.app.twitter.getConfig();
    const enabledStatus = config.enabled ? '✅' : '🛑';
    const approvalStatus = config.approvalMode ? '✅' : '🛑';
    const mentionsStatus = config.replyToMentions ? '✅' : '🛑';
    // twitter-api-v2 é opcional — checa se carregou. Como TwitterBot importa
    // dinamicamente, não temos acesso direto à flag aqui. Usamos um try/catch
    // no require pra detectar.
    let libInstalled = false;
    try {
      require.resolve('twitter-api-v2');
      libInstalled = true;
    } catch {
      libInstalled = false;
    }
    const libStatus = libInstalled ? '✅' : '🛑 npm i twitter-api-v2';
    const pendingCount = this.app.twitter.pendingTweets.size;
    const interval = config.postIntervalHours || 4;
    const mentionInterval = config.mentionCheckIntervalMinutes || 15;

    const lines = [
      `Integração: ${enabledStatus} | Aprovação: ${approvalStatus} | Menções: ${mentionsStatus} (${mentionInterval}min)`,
      `Lib: ${libStatus} | Auto-post: ${interval}h | Pendentes: ${pendingCount}`,
      '',
      '*/twitter postar | on | off*',
      '*/twitter aprovar on|off | mentions on|off*',
    ];
    await this.app.notify(chatId, lines.join('\n'));
    await this.app.react(msg, EMOJI.SUCCESS);
  }

  /**
   * /twitter postar — gera tweet do contexto do chat atual e manda pro fluxo
   * de aprovação/direto.
   * Portado byte-a-byte de handleTwitter() (linhas 5327-5360 do velho).
   */
  private async twitterPostar(msg: Message, chatId: string): Promise<void> {
    // Checa se twitter-api-v2 está instalada (require.resolve não lança se OK).
    let libInstalled = false;
    try {
      require.resolve('twitter-api-v2');
      libInstalled = true;
    } catch {
      libInstalled = false;
    }
    if (!libInstalled) {
      await this.app.reportError(msg, chatId, 'biblioteca *twitter-api-v2* não instalada. Rode `npm i twitter-api-v2`.');
      return;
    }
    if (!this.app.aiConfig?.enabled) {
      await this.app.reportError(msg, chatId, 'IA precisa estar on. Use */ia on*.');
      return;
    }
    try {
      await this.app.notify(chatId, '🐦 gerando tweet...');
      const tweetData = await this.app.twitter.generateTweet(chatId);
      if (!tweetData) {
        await this.app.reportError(msg, chatId, 'sem contexto suficiente neste chat.');
        return;
      }
      const result = await this.app.twitter.postTweetWithApproval(chatId, tweetData);
      if (result === 'pending') {
        const config = this.app.twitter.getConfig();
        const target = config.approvalChatId || 'o PV do bot';
        const imgNote = tweetData.imageData ? ' \u200d🖼️' : '';
        await this.app.notify(chatId, `🐦 tweet em aprovação em ${target}${imgNote}:\n\n"${tweetData.text}"\n\nResponda *postar* ou *descartar*.`);
      } else if (result === 'posted') {
        const imgNote = tweetData.imageData ? ' (com imagem)' : '';
        await this.app.notify(chatId, `✅ tweet postado${imgNote}:\n\n"${tweetData.text}"`);
      } else {
        await this.app.reportError(msg, chatId, 'não consegui postar. Verifique *twitter-config.json*.');
      }
      await this.app.react(msg, EMOJI.SUCCESS);
    } catch (e) {
      await this.app.reportError(msg, chatId, `erro: ${(e as Error).message}`, e as Error);
    }
  }

  /**
   * Helper genérico pra /twitter on|off, /twitter aprovar on|off, /twitter
   * mentions on|off. Lê o config atual, muta o campo, salva em disco, notifica.
   *
   * @param field Campo do config a mutar ('enabled' | 'approvalMode' | 'replyToMentions')
   * @param value Novo valor (true/false)
   * @param notifyMsg Mensagem pra notificar o usuário
   * @param logMsg Mensagem pra logar (auditoria)
   */
  private async twitterToggle(
    msg: Message,
    chatId: string,
    field: 'enabled' | 'approvalMode' | 'replyToMentions',
    value: boolean,
    notifyMsg: string,
    logMsg: string,
  ): Promise<void> {
    const sender = await this.app.permissions.resolveSenderIds(msg);
    const config = { ...this.app.twitter.getConfig() };
    (config as any)[field] = value;
    try {
      this.app.twitter.saveConfig(config);
      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, notifyMsg);
      this.app.log('TWITTER', logMsg);
    } catch (e) {
      await this.app.reportError(msg, chatId, `erro ao salvar config: ${(e as Error).message}`, e as Error);
    }
  }
}
