/**
 * StickerCommands — comandos de figurinha.
 *
 * Comandos:
 *  - !figurinha — cria uma figurinha a partir de mídia anexada, quoted, ou link
 *                 do Twitter/X (público).
 *  - /fig       — gerencia figurinhas favoritas/nomeadas do vault (ops only).
 *
 * Preservado byte-a-byte de:
 *  - handleSticker (index.js velho, linhas 4288-4370)
 *  - handleFig     (index.js velho, linhas 5618-5832)
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.stickers  — vault, meta, dedup
 *  - this.app.whatsapp  — client.sendMessage (pra enviar figurinha com sendMediaAsSticker)
 *  - this.app.permissions — resolveSenderIds, isOp (no /fig)
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';
import type { CommandDef, CommandModule } from './CommandRegistry';
import { MessageMedia } from 'whatsapp-web.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ============================================================================
// CONSTS
// ============================================================================

const EMOJI = {
  LOADING: '⏳',
  SUCCESS: '✅',
  ERROR: '❌',
} as const;

// ============================================================================
// STICKER COMMANDS
// ============================================================================

export class StickerCommands implements CommandModule {
  readonly name = 'sticker';
  readonly commands: CommandDef[];
  private readonly app: MarcioApp;

  constructor(app: MarcioApp) {
    this.app = app;
    this.commands = [
      {
        name: '!figurinha',
        aliases: ['/figurinha', '!sticker', '/sticker'],
        handler: (msg, chatId) => this.handleSticker(msg, chatId),
        help: 'cria uma figurinha (responda a uma imagem/vídeo, envie mídia com a legenda !figurinha, ou !figurinha <link do Twitter/X>).',
      },
      {
        name: '/fig',
        aliases: ['!fig'],
        handler: (msg, chatId) => this.handleFig(msg, chatId),
        help: 'gerencia figurinhas favoritas/nomeadas do vault (ops only). Subcomandos: fav, unfav, nome <texto>, semnome, lista, dedup.',
        opOnly: true,
      },
    ];
  }

  // ===========================================================================
  // !figurinha — cria uma figurinha
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleSticker (index.js velho 4288-4370).
   *
   * Casos:
   *  1. msg tem mídia (envio com legenda !figurinha) → usa a própria mídia
   *  2. msg sem mídia mas com quoted → usa mídia do quoted
   *  3. msg sem mídia/quoted mas body tem link do Twitter/X → baixa via vxtwitter
   *  4. Senão → erro com instruções
   *
   * Envia com sendMediaAsSticker: true, stickerAuthor = BOT_NAME, stickerName = 'Figurinha'.
   */
  private async handleSticker(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    try {
      let media: MessageMedia | null = null;

      if (msg.hasMedia) {
        // Caso 1: a própria mensagem tem mídia (envio com legenda !figurinha)
        media = await msg.downloadMedia();
      } else if (msg.hasQuotedMsg) {
        // Caso 2: respondeu a uma mensagem existente no chat
        const quoted = await msg.getQuotedMessage();
        if (quoted.hasMedia) {
          media = await quoted.downloadMedia();
        } else {
          await this.app.reportError(
            msg, chatId,
            'a mensagem respondida não tem mídia. Responda a uma *imagem, vídeo ou figurinha* com *!figurinha*.'
          );
          return;
        }
      } else if (msg.body.includes('x.com/') || msg.body.includes('twitter.com/')) {
        // Caso 3: link do Twitter/X
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const match = msg.body.match(urlRegex);

        if (!match) {
          await this.app.reportError(
            msg, chatId,
            'para usar o comando corretamente, se atente à sintaxe: *!figurinha <link do Twitter/X>* — envie um link válido junto com o comando.',
            new Error('Link inválido.')
          );
          return;
        }

        const apiUrl = match[0].replace(/(https?:\/\/)(x\.com|twitter\.com)/, '$1api.vxtwitter.com');
        const response = await fetch(apiUrl);
        if (!response.ok) {
          await this.app.reportError(
            msg, chatId,
            'não consegui acessar o link do tweet. Verifique se o link está correto e tente novamente.',
            new Error(`vxtwitter respondeu ${response.status}`)
          );
          return;
        }

        const data = await response.json() as any;
        if (data.media_extended && data.media_extended.length > 0) {
          const mediaUrl = data.media_extended[0].url;
          // MessageMedia.fromUrl não tá na declaração de tipos — usa cast.
          media = await (MessageMedia as any).fromUrl(mediaUrl, { unsafeMime: true });
        } else {
          await this.app.reportError(
            msg, chatId,
            'nenhuma mídia encontrada no tweet. Verifique se o tweet realmente contém uma imagem ou vídeo.',
            new Error('Nenhuma mídia encontrada no tweet.')
          );
          return;
        }
      } else {
        await this.app.reportError(
          msg, chatId,
          'para usar o comando corretamente, se atente à sintaxe:\n\n• Responda a uma *imagem, vídeo ou figurinha* com *!figurinha*; ou\n• Envie uma imagem com a legenda *!figurinha*; ou\n• Envie *!figurinha <link do Twitter/X>*.'
        );
        return;
      }

      if (!media) {
        await this.app.reportError(msg, chatId, 'não consegui obter a mídia.');
        return;
      }

      await this.app.whatsapp.client.sendMessage(chatId, media, {
        sendMediaAsSticker: true,
        stickerAuthor: this.app.config.botName,
        stickerName: 'Figurinha',
      });

      await this.app.react(msg, EMOJI.SUCCESS);
      this.app.log('STICKER', `Figurinha criada para: ${chatId}`);
    } catch (error) {
      const e = error as Error;
      console.error('Falha ao processar arquivo:', error);
      await this.app.reportError(
        msg, chatId,
        `ocorreu um erro ao criar a figurinha: ${e.message}. Tente novamente mais tarde.`,
        e
      );
    }
  }

  // ===========================================================================
  // /fig — gerencia figurinhas favoritas/nomeadas do vault (ops)
  // ===========================================================================

  /**
   * Preservado byte-a-byte de handleFig (index.js velho 5618-5832).
   *
   * Subcomandos:
   *  - /fig fav          (respondendo a uma figurinha) → marca como favorita
   *  - /fig unfav        (respondendo a uma figurinha) → remove dos favoritos
   *  - /fig nome <texto> (respondendo a uma figurinha) → dá um nome (pra IA poder pedir específica)
   *  - /fig semnome      (respondendo a uma figurinha) → remove o nome
   *  - /fig lista        → lista as figurinhas nomeadas/favoritas
   *  - /fig dedup        → remove figurinhas duplicadas do vault (compara por hash)
   *  - /fig              → mostra ajuda
   *
   * O gate opOnly já é aplicado pelo router no /fig (e suas aliases). Aqui dentro
   * não repetimos a checagem — o router já bloqueou não-ops antes de chegar.
   */
  private async handleFig(msg: Message, chatId: string): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    const args = msg.body.trim().split(/\s+/).slice(1);
    const subcommand = (args[0] || '').toLowerCase();

    // /fig dedup — remove figurinhas duplicadas do vault (compara por hash)
    if (subcommand === 'dedup') {
      try {
        this.app.stickers.ensureVaultDir();
        const vaultDir = this.app.dataPath('stickers-vault');
        const files = fs.readdirSync(vaultDir).filter(f => /\.(webp|png|jpg)$/.test(f));
        if (files.length === 0) {
          await this.app.notify(chatId, 'vault vazio — nada pra deduplicar.');
          await this.app.react(msg, EMOJI.SUCCESS);
          return;
        }

        const meta = this.app.stickers.loadMeta();
        const hashToFilename = new Map<string, string>();
        const duplicates: { removed: string; kept: string }[] = [];

        for (const f of files) {
          try {
            const filepath = path.join(vaultDir, f);
            const buffer = fs.readFileSync(filepath);
            const hash = crypto.createHash('sha256').update(buffer).digest('hex');

            if (hashToFilename.has(hash)) {
              // Duplicada! Mantém a primeira, remove essa
              duplicates.push({ removed: f, kept: hashToFilename.get(hash)! });
              // Transfere metadados (nome, favorita) pro que ficou, se a duplicada tinha
              if (meta[f]) {
                const keptFilename = hashToFilename.get(hash)!;
                meta[keptFilename] = {
                  ...(meta[keptFilename] || {}),
                  ...meta[f],
                  hash,  // garante o hash
                };
                delete meta[f];
              }
              fs.unlinkSync(filepath);
            } else {
              hashToFilename.set(hash, f);
              // Garante que o hash tá nos metadados
              if (!meta[f]) meta[f] = {};
              meta[f].hash = hash;
            }
          } catch (e) { /* ignora erro individual */ }
        }

        if (duplicates.length > 0) this.app.stickers.saveMeta(meta);

        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId,
          `deduplicação concluída ✅\n\n` +
          `Total analisado: ${files.length}\n` +
          `Duplicadas removidas: ${duplicates.length}\n` +
          `Únicas no vault: ${files.length - duplicates.length}`
        );
        this.app.log('FIG', `Dedup de figurinhas: ${duplicates.length} removidas de ${files.length}.`);
        this.app.debug('FIG', `dedup removeu ${duplicates.length} duplicadas`);
      } catch (e) {
        await this.app.reportError(msg, chatId, `erro na deduplicação: ${(e as Error).message}`, e as Error);
      }
      return;
    }

    // /fig lista — não precisa de quoted
    if (subcommand === 'lista') {
      const named = this.app.stickers.listNamed();
      if (named.length === 0) {
        await this.app.notify(chatId, 'nenhuma figurinha nomeada ou favorita ainda. Use */fig fav* ou */fig nome <texto>* respondendo a uma figurinha.');
        await this.app.react(msg, EMOJI.SUCCESS);
        return;
      }
      const lines = ['*Figurinhas marcadas:*', ''];
      named.forEach((s, i) => {
        const marks: string[] = [];
        if (s.favorite) marks.push('⭐ favorita');
        if (s.name) marks.push(`nome: "${s.name}"`);
        lines.push(`${i + 1}. ${marks.join(' | ') || 'sem marca'}`);
      });
      await this.app.notify(chatId, lines.join('\n'));
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // /fig (sem subcomando) — mostra ajuda
    if (!subcommand) {
      await this.app.notify(chatId, [
        '*Comandos de figurinha:*',
        '',
        '• Responda a uma figurinha com */fig fav* → marca como favorita',
        '• Responda com */fig unfav* → remove dos favoritos',
        '• Responda com */fig nome <texto>* → dá um nome (ex.: /fig nome risada)',
        '• Responda com */fig semnome* → remove o nome',
        '• */fig lista* → lista as figurinhas marcadas',
        '• */fig dedup* → remove figurinhas duplicadas do vault (limpa as repetidas)',
        '',
        '_A IA pode pedir figurinhas específicas pelo nome ao responder._'
      ].join('\n'));
      await this.app.react(msg, EMOJI.SUCCESS);
      return;
    }

    // Subcomandos que precisam de figurinha respondida: fav, unfav, nome, semnome
    const needsQuoted = ['fav', 'unfav', 'nome', 'semnome'];
    if (!needsQuoted.includes(subcommand)) {
      await this.app.reportError(msg, chatId, `subcomando desconhecido: "${subcommand}". Use */fig* pra ver os comandos disponíveis.`);
      return;
    }

    if (!msg.hasQuotedMsg) {
      await this.app.reportError(msg, chatId, 'responda a uma *figurinha* com o comando. Ex.: responda a uma figurinha com */fig fav*.');
      return;
    }

    let quoted: Message;
    try {
      quoted = await msg.getQuotedMessage();
    } catch (e) {
      await this.app.reportError(msg, chatId, 'não consegui acessar a mensagem respondida.', e as Error);
      return;
    }

    // Valida que é figurinha
    if (!quoted.hasMedia || quoted.type !== 'sticker') {
      await this.app.reportError(msg, chatId, 'a mensagem respondida não é uma figurinha. Responda a uma *figurinha* com o comando.');
      return;
    }

    // Baixa a figurinha, salva no vault (ou reutiliza se já existir — não temos como
    // deduplicar facilmente, então sempre salva uma nova cópia e marca metadados nela).
    let media: MessageMedia | null = null;
    try {
      media = await quoted.downloadMedia();
    } catch (e) {
      await this.app.reportError(msg, chatId, 'não consegui baixar a figurinha.', e as Error);
      return;
    }
    if (!media || !media.data) {
      await this.app.reportError(msg, chatId, 'figurinha vazia ou inválida.');
      return;
    }

    const saveResult = this.app.stickers.saveToVault(media);
    if (!saveResult) {
      await this.app.reportError(msg, chatId, 'erro ao salvar figurinha no vault.');
      return;
    }
    const filename = saveResult.filename;

    // Se a figurinha já existia no vault (duplicada), avisa o op mas continua aplicando
    // os metadados no arquivo existente — assim ele pode nomear/marcar uma figurinha
    // que já estava no vault de forma silenciosa (recebida antes do comando).
    if (saveResult.isDuplicate) {
      this.app.debug('FIG', `figurinha já existia no vault — aplicando metadados no arquivo: ${filename}`);
    }

    // Resolve sender pra logar quem fez a alteração
    const sender = await this.app.permissions.resolveSenderIds(msg);

    // Aplica o subcomando nos metadados
    if (subcommand === 'fav') {
      this.app.stickers.setMeta(filename, { favorite: true });
      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, `figurinha marcada como favorita ⭐\nID: ${filename}`);
      this.app.log('FIG', `Figurinha favorita: ${filename} (por ${sender.all.join(' / ')}).`);
      return;
    }

    if (subcommand === 'unfav') {
      this.app.stickers.setMeta(filename, { favorite: false });
      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, `figurinha removida dos favoritos.\nID: ${filename}`);
      this.app.log('FIG', `Figurinha unfav: ${filename} (por ${sender.all.join(' / ')}).`);
      return;
    }

    if (subcommand === 'nome') {
      const name = args.slice(1).join(' ').trim();
      if (!name) {
        await this.app.reportError(msg, chatId, 'forneça um nome. Ex.: */fig nome risada*.');
        return;
      }
      if (name.length > 60) {
        await this.app.reportError(msg, chatId, 'nome muito longo (máx 60 caracteres).');
        return;
      }
      // Verifica se já existe figurinha com esse nome
      const existing = this.app.stickers.getByName(name);
      if (existing) {
        await this.app.reportError(msg, chatId, `já existe uma figurinha com o nome "${name}". Escolha outro nome ou renomeie a outra primeiro.`);
        return;
      }
      this.app.stickers.setMeta(filename, { name });
      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, `figurinha nomeada: "${name}"\nID: ${filename}\n\nA IA agora pode pedir essa figurinha com [FIGURINHA: ${name}].`);
      this.app.log('FIG', `Figurinha nomeada: "${name}" (${filename}) (por ${sender.all.join(' / ')}).`);
      return;
    }

    if (subcommand === 'semnome') {
      this.app.stickers.setMeta(filename, { name: null });
      await this.app.react(msg, EMOJI.SUCCESS);
      await this.app.notify(chatId, `nome removido da figurinha.\nID: ${filename}`);
      this.app.log('FIG', `Figurinha semnome: ${filename} (por ${sender.all.join(' / ')}).`);
      return;
    }
  }
}
