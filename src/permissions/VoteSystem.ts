/**
 * VoteSystem — enquetes democráticas pra mutar/desmutar o bot.
 *
 * Responsabilidades:
 *  - Gerencia enquetes de !mute/!unmute (qualquer usuário pode iniciar/votar).
 *  - Threshold: 1/3 dos membros do grupo (mínimo 2 votos).
 *  - Timeout: 5 minutos por enquete.
 *  - Mínimo de membros: 3 (grupos muito pequenos não podem votar).
 *  - Ops podem mutar/desmutar sozinhos (1 voto = ação imediata, sem enquete).
 *  - Adiciona/remove de brain.democraticallyMutedChats.
 *
 * Preservado byte-a-byte do handleMuteVote do index.js velho (linhas 4692-4816).
 *
 * O state democraticallyMutedChats vive no Brain (não aqui) — o VoteSystem
 * só adiciona/remove dele. Assim o Brain.maybeAutoRespond e o StickerVault
 * conseguem checar o mesmo Set.
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';

// ============================================================================
// CONSTS
// ============================================================================

const MUTE_VOTE_THRESHOLD_DIVISOR = 3;        // 1/3 dos membros
const MUTE_VOTE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutos
const MUTE_VOTE_MIN_MEMBERS = 3;              // grupo muito pequeno não vota

const EMOJI = {
  LOADING: '⏳',
  SUCCESS: '✅',
  ERROR: '❌',
} as const;

// ============================================================================
// TIPOS
// ============================================================================

interface MuteVoteState {
  type: 'mute' | 'unmute';
  votes: Set<string>;
  startTime: number;
  threshold: number;
}

// ============================================================================
// VOTE SYSTEM
// ============================================================================

export class VoteSystem {
  private app: MarcioApp;

  /** chatId → enquete ativa (uma por chat, por vez). */
  private muteVotes = new Map<string, MuteVoteState>();

  constructor(app: MarcioApp) {
    this.app = app;
  }

  /**
   * !mute / !unmute — inicia ou vota numa enquete pra silenciar/desilenciar o bot.
   *
   * Lógica (preservada byte-a-byte do handleMuteVote do index.js velho):
   *  1. Só em grupos (@g.us).
   *  2. Mínimo de MUTE_VOTE_MIN_MEMBERS membros.
   *  3. Threshold = max(2, ceil(members / 3)).
   *  4. Op → muta/desmuta sozinho (sem enquete), limpa enquete existente.
   *  5. Não-op:
   *     - Enquete ativa expirada (5min) → descarta, segue pra "nova enquete".
   *     - Enquete ativa do tipo oposto → descarta, segue pra "nova enquete".
   *     - Enquete ativa do mesmo tipo → adiciona voto (ou rejeita se já votou).
   *       - Atingiu threshold → aplica mute/unmute.
   *       - Senão → confirma voto e mostra progresso.
   *     - Sem enquete ativa → inicia nova (1/threshold, expira em 5min).
   *  6. setTimeout de 5min+1s pra limpar a enquete se ainda existir.
   */
  async handleMuteVote(msg: Message, chatId: string, voteType: 'mute' | 'unmute'): Promise<void> {
    await this.app.react(msg, EMOJI.LOADING);

    // Só funciona em grupos
    if (!chatId.endsWith('@g.us')) {
      await this.app.reportError(msg, chatId, 'enquetes de mute só funcionam em grupos.');
      return;
    }

    // Pega info do grupo
    let chat: any;
    try {
      chat = await msg.getChat();
    } catch (e) {
      await this.app.reportError(msg, chatId, 'não consegui acessar info do grupo.', e as Error);
      return;
    }

    const memberCount = chat?.participants?.length || 0;
    if (memberCount < MUTE_VOTE_MIN_MEMBERS) {
      await this.app.reportError(msg, chatId, `grupo muito pequeno pra enquete (mínimo ${MUTE_VOTE_MIN_MEMBERS} membros).`);
      return;
    }

    const threshold = Math.max(2, Math.ceil(memberCount / MUTE_VOTE_THRESHOLD_DIVISOR));

    // Pega o ID de quem votou
    const { all: senderIds } = await this.app.permissions.resolveSenderIds(msg);
    const voterId = senderIds[0] || msg.from;
    const voterIsOp = this.app.permissions.isOp(msg.fromMe, senderIds);

    // Ops podem mutar/desmutar sozinhos (sem enquete)
    if (voterIsOp) {
      if (voteType === 'mute') {
        // Persiste via chatSettings (que também atualiza brain.democraticallyMutedChats
        // e faz broadcast pro painel) — estado sobrevive a restarts.
        this.app.chatSettings.setMuted(chatId, true);
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, '🤐 bot silenciado pelo op. Use *!unmute* pra desmutar.');
        this.app.log('MUTE', `Bot mutado por op ${senderIds.join(' / ')} em ${chatId}.`);
      } else {
        this.app.chatSettings.setMuted(chatId, false);
        await this.app.react(msg, EMOJI.SUCCESS);
        await this.app.notify(chatId, '🔊 bot desmutado pelo op.');
        this.app.log('MUTE', `Bot desmutado por op ${senderIds.join(' / ')} em ${chatId}.`);
      }
      // Limpa enquete existente se tiver
      this.muteVotes.delete(chatId);
      return;
    }

    // === Enquete democrática (não-ops) ===

    // Se já existe enquete ativa
    if (this.muteVotes.has(chatId)) {
      const poll = this.muteVotes.get(chatId)!;

      // Verifica se a enquete expirou
      if (Date.now() - poll.startTime > MUTE_VOTE_TIMEOUT_MS) {
        this.muteVotes.delete(chatId);
        this.app.debug('MUTE', `enquete expirou em ${chatId}`);
      } else if (poll.type !== voteType) {
        // Enquete é do tipo oposto — reseta
        this.muteVotes.delete(chatId);
        this.app.debug('MUTE', `enquete anterior era ${poll.type}, reiniciando como ${voteType}`);
      } else {
        // Mesmo tipo — adiciona voto
        if (poll.votes.has(voterId)) {
          await this.app.react(msg, EMOJI.ERROR);
          await this.app.notify(chatId, `você já votou pra ${voteType}. Votos: ${poll.votes.size}/${poll.threshold}`);
          return;
        }

        poll.votes.add(voterId);
        this.app.debug('MUTE', `voto registrado: ${poll.votes.size}/${poll.threshold} pra ${voteType} em ${chatId}`);

        if (poll.votes.size >= poll.threshold) {
          // Aprovado!
          this.muteVotes.delete(chatId);
          if (voteType === 'mute') {
            this.app.chatSettings.setMuted(chatId, true);
            await this.app.react(msg, EMOJI.SUCCESS);
            await this.app.notify(chatId, `🤐 *Bot silenciado!*\n\nVotação aprovada: ${poll.votes.size}/${memberCount} membros votaram.\n\nUse *!unmute* pra iniciar votação de desmutar.`);
            this.app.log('MUTE', `Bot mutado democraticamente em ${chatId} (${poll.votes.size}/${memberCount} votos).`);
          } else {
            this.app.chatSettings.setMuted(chatId, false);
            await this.app.react(msg, EMOJI.SUCCESS);
            await this.app.notify(chatId, `🔊 *Bot desmutado!*\n\nVotação aprovada: ${poll.votes.size}/${memberCount} membros votaram.`);
            this.app.log('MUTE', `Bot desmutado democraticamente em ${chatId} (${poll.votes.size}/${memberCount} votos).`);
          }
          return;
        } else {
          await this.app.react(msg, EMOJI.SUCCESS);
          await this.app.notify(chatId, `🗳️ Voto registrado!\n\nVotos pra ${voteType}: ${poll.votes.size}/${poll.threshold}\n\nFaltam ${poll.threshold - poll.votes.size} voto(s).`);
          return;
        }
      }
    }

    // Inicia nova enquete
    this.muteVotes.set(chatId, {
      type: voteType,
      votes: new Set([voterId]),
      startTime: Date.now(),
      threshold,
    });

    const action = voteType === 'mute' ? 'silenciar' : 'desmutar';
    const status = voteType === 'mute' ? (this.app.brain.democraticallyMutedChats.has(chatId) ? '(já está mutado)' : '') : '';

    await this.app.react(msg, EMOJI.SUCCESS);
    await this.app.notify(chatId,
      `🗳️ *Enquete iniciada pra ${action} o bot* ${status}\n\n` +
      `Votos: 1/${threshold}\n` +
      `Faltam ${threshold - 1} voto(s) pra aprovar.\n\n` +
      `Outros membros podem votar com *!${voteType}*.\n` +
      `Enquete expira em 5 minutos.`
    );

    // Limpa a enquete automaticamente depois de 5 min
    setTimeout(() => {
      if (this.muteVotes.has(chatId)) {
        const poll = this.muteVotes.get(chatId)!;
        if (Date.now() - poll.startTime >= MUTE_VOTE_TIMEOUT_MS) {
          this.muteVotes.delete(chatId);
          this.app.debug('MUTE', `enquete de ${poll.type} expirou em ${chatId}`);
          try { this.app.notify(chatId, `🗳️ Enquete de ${poll.type} expirou sem votos suficientes.`); } catch (e) { /* ignora */ }
        }
      }
    }, MUTE_VOTE_TIMEOUT_MS + 1000);
  }
}
