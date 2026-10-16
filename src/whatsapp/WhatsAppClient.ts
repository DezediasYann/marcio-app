/**
 * WhatsAppClient — wrapper fino sobre o Client do whatsapp-web.js.
 *
 * Responsabilidades (Fase 1):
 *  - Instanciar o Client com LocalAuth, apontando pro MESMO dataPath do bot
 *    velho — assim reaproveita a sessão e não precisa re-escanear QR.
 *  - Expor eventos (qr, ready, message_create) com logs.
 *  - Na Fase 1, message_create só LOGA. O dispatch pro MessageRouter
 *    vem na Fase 3.
 *
 * Responsabilidades (Fases 2-3, futuro):
 *  - notify(), react(), sendSticker() — helpers de envio.
 *  - isOwnMessage() — loop-guard.
 *  - typing indicators.
 */

import { Client, LocalAuth, type Message } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import fs from 'node:fs';
import path from 'node:path';
import type { MarcioApp } from '../MarcioApp';

export class WhatsAppClient {
  client!: Client;  // público — ControlPanel precisa recriar. Definitively assigned in createClient()
  private app: MarcioApp;

  /**
   * Último QR code gerado (string crua do whatsapp-web.js).
   * Setado no evento 'qr', limpo no evento 'ready'.
   * Lido pelo ControlPanel via GET /api/qr pra exibir no dashboard.
   */
  lastQr: string | null = null;

  /**
   * Timestamp (epoch ms) do último evento 'ready' do client — ou seja,
   * a última vez que o WhatsApp ficou conectado (seja boot inicial ou
   * reconnect após queda). Exposto no /api/bot/status pelo ControlPanel.
   * 0 significa que nunca conectou ainda.
   */
  lastReconnect: number = 0;

  /**
   * Timestamp (epoch ms) de quando o WA ficou 'ready' (conectado e pronto).
   * Usado pelo MessageRouter.isFreshMessage pra filtrar msgs antigas:
   * só processa msgs com timestamp >= readyTime.
   * Isso evita que o bot reprocesse histórico ao reiniciar (Ctrl+C + restart).
   * 0 significa que ainda não conectou — isFreshMessage cai pro fallback de startTime.
   */
  readyTime: number = 0;

  /**
   * IDs das mensagens enviadas pelo próprio bot (loop-guard).
   * Quando o bot manda uma msg, registra o ID aqui por 10s.
   * O handler de message_create ignora essas msgs — sem isso, comandos
   * como easter eggs (que ecoam "! figurinha") entrariam em loop infinito.
   */
  private botSentIds = new Set<string>();
  private readonly BOT_SENT_TTL_MS = 10000;

  constructor(app: MarcioApp) {
    this.app = app;
    this.app.log('WA', 'Construindo WhatsAppClient...');
    this.createClient();
  }

  /**
   * Cria um novo Client do whatsapp-web.js.
   * Chamado no constructor e quando precisa recriar após destroy (reconnect/logout).
   */
  createClient(): void {
    const authStrategy = this.app.config.legacyAuthPath
      ? new LocalAuth({ dataPath: this.app.config.legacyAuthPath })
      : new LocalAuth();

    this.client = new Client({
      authStrategy,
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
        ],
      },
    });
  }

  /**
   * Inicializa o client e registra os handlers de evento.
   * Retorna quando o Client.initialize() resolver (geralmente após 'ready').
   */
  async initialize(): Promise<void> {
    this.app.log('WA', 'Inicializando client do WhatsApp...');

    // Mata Chromium órfão de execução anterior (evita "browser already running")
    await this.killLeftoverChromium();

    // === Eventos de conexão ===

    this.client.on('loading_screen', (percent: string, message: string) => {
      this.app.log('WA', `Carregando: ${percent}% — ${message}`);
    });

    this.client.on('qr', (qr: string) => {
      this.app.log('WA', 'QR code gerado — escaneie com o celular (WhatsApp → Config → Aparelhos conectados → Conectar aparelho)');
      // Armazena o último QR pra o ControlPanel expor via GET /api/qr
      this.lastQr = qr;
      // Printa o QR no terminal
      qrcode.generate(qr, { small: true });
    });

    this.client.on('authenticated', () => {
      this.app.log('WA', 'Sessão autenticada.');
    });

    this.client.on('auth_failure', (msg: string) => {
      this.app.log('WA', `❌ Falha de autenticação: ${msg}`);
      // Reporta pro ErrorTracker — usuário precisa saber que a sessão caiu
      this.app.errors.report('WA', `Falha de autenticação: ${msg}`, undefined, {
        userMessage: 'A sessão do WhatsApp caiu. Vá em Painel → Bot & WhatsApp → Desconectar e reconecte com o QR code.',
        severity: 'critical',
      });
    });

    this.client.on('ready', () => {
      const me = this.client.info?.wid?._serialized ?? '?';
      this.app.log('WA', `✅ WhatsApp pronto! Conectado como: ${me}`);
      // Limpa o último QR — já conectado, não precisa mais.
      this.lastQr = null;
      // Registra o timestamp deste (re)connect — exposto no /api/bot/status.
      this.lastReconnect = Date.now();
      // Registra quando o WA ficou pronto — usado pelo MessageRouter.isFreshMessage
      // pra não reprocessar msgs que chegaram antes/durante o boot.
      this.readyTime = Date.now();
    });

    this.client.on('disconnected', (reason: string) => {
      this.app.log('WA', `⚠️ Desconectado: ${reason}`);
      // Reporta — usuário pode não estar olhando o painel
      this.app.errors.report('WA', `WhatsApp desconectado: ${reason}`, undefined, {
        userMessage: 'O WhatsApp desconectou. Tentando reconectar automaticamente.',
        severity: 'warn',
      });
    });

    // === Eventos de mensagem ===

    this.client.on('message_create', async (msg: Message) => {
      await this.handleMessage(msg);
    });

    // Inicializa (dispara o fluxo de QR/ready)
    await this.client.initialize();
  }

  /**
   * Handler de mensagem — Fase 3.2: delega pro MessageRouter.
   * Toda a lógica de dispatch (loop-guard, figurinha, contexto,
   * comando? registry : IA) vive no router. Aqui é só ponte.
   */
  private async handleMessage(msg: Message): Promise<void> {
    if (this.app.router) {
      try {
        await this.app.router.handleMessage(msg);
      } catch (e) {
        this.app.debug('WA', `erro no router: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Verifica se uma msg foi enviada pelo próprio bot (loop-guard).
   * Usado pelo Context.loadChatHistory e forceReadChatHistory pra pular
   * as próprias msgs ao carregar histórico.
   */
  isOwnMessage(msg: Message): boolean {
    if (msg.id?._serialized && this.botSentIds.has(msg.id._serialized)) {
      return true;
    }
    return false;
  }

  /**
   * Envia uma mensagem de texto rastreando o ID (pra loop-guard).
   * Use SEMPRE que a resposta puder parecer um comando (começar com ! ou /),
   * pra que o handler de message_create ignore a própria resposta.
   */
  async sendMessage(chatId: string, text: string): Promise<Message> {
    const sent = await this.client.sendMessage(chatId, text);
    if (sent?.id?._serialized) {
      const id = sent.id._serialized;
      this.botSentIds.add(id);
      setTimeout(() => this.botSentIds.delete(id), this.BOT_SENT_TTL_MS);
      this.app.debug('LOOP-GUARD', `mensagem enviada pelo bot registrada: ${id}`);
    }
    return sent;
  }

  /**
   * Fecha o client graciosamente (pro shutdown).
   */
  async destroy(): Promise<void> {
    try {
      await this.client.destroy();
      this.app.log('WA', 'Client fechado.');
    } catch (e) {
      this.app.log('WA', `erro ao fechar client: ${(e as Error).message}`);
    }
  }

  /**
   * Mata processos Chromium/Chrome órfãos que podem estar segurando o lock
   * da pasta .wwebjs_auth/session. Isso acontece quando o bot crasha ou
   * é fechado sem chamar destroy() graciosamente.
   */
  private async killLeftoverChromium(): Promise<void> {
    const { execSync } = require('node:child_process');
    this.app.debug('WA', 'killLeftoverChromium: limpando processos e locks...');

    try {
      if (process.platform === 'win32') {
        // 1. Mata processos de browser que possam estar segurando o lock
        // ⚠️ wmic foi DEPRECIADO no Windows 11 — usar PowerShell Get-CimInstance
        const names = ['chrome.exe', 'chromium.exe', 'msedge.exe'];
        const allPids: number[] = [];
        for (const name of names) {
          try {
            // PowerShell: lista PID + CommandLine, filtra por nome
            // Usamos powershell em vez de wmic (deprecated Win11)
            const psCmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='${name}'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"`;
            const out = execSync(psCmd, { encoding: 'utf8', timeout: 8000 });
            const lines = out.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            for (const line of lines) {
              const lower = line.toLowerCase();
              if (lower.includes('wwebjs_auth') || lower.includes('com.marcio')) {
                // PowerShell CSV: "Pid","CommandLine" ou só "Pid"
                const match = line.match(/"(\d+)"/);
                const pid = match ? parseInt(match[1]) : NaN;
                if (pid > 0 && !allPids.includes(pid)) {
                  allPids.push(pid);
                }
              }
            }
          } catch { /* processo não existe ou powershell falhou */ }
        }
        if (allPids.length > 0) {
          this.app.log('WA', `matando ${allPids.length} processo(s): ${allPids.join(', ')}`);
          for (const pid of allPids) {
            try { execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 }); }
            catch { /* ignora */ }
          }
          await new Promise(r => setTimeout(r, 2000));
        } else {
          this.app.debug('WA', 'killLeftoverChromium: nenhum processo órfão encontrado');
        }

        // 2. Remove arquivos de lock do Chromium (SingletonLock, SingletonCookie, SingletonSocket)
        const sessionDir = path.join(this.app.config.legacyAuthPath || path.join(this.app.config.rootDir, '.wwebjs_auth'), 'session');
        const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
        for (const lock of lockFiles) {
          const lockPath = path.join(sessionDir, lock);
          try {
            if (fs.existsSync(lockPath)) {
              fs.unlinkSync(lockPath);
              this.app.debug('WA', `killLeftoverChromium: removido lock ${lock}`);
            }
          } catch { /* ignora se não consegue */ }
        }
      } else {
        try { execSync('pkill -f "wwebjs_auth" 2>/dev/null', { timeout: 5000 }); } catch { /* ignora */ }
        // Remove locks no Linux/Mac também
        const sessionDir = path.join(this.app.config.legacyAuthPath || path.join(this.app.config.rootDir, '.wwebjs_auth'), 'session');
        for (const lock of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
          try { fs.unlinkSync(path.join(sessionDir, lock)); } catch { /* ignora */ }
        }
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      this.app.debug('WA', `killLeftoverChromium erro: ${(e as Error).message}`);
    }
  }
}

// ============================================================================
// HELPER — encontra Chrome/Edge instalado no PC (evita baixar 1.3GB de Chromium)
// ============================================================================

/**
 * Procura por Chrome ou Edge instalado no PC do usuário.
 * Se encontrar, retorna o caminho do executável (pra usar como executablePath do Puppeteer).
 * Se não encontrar, retorna undefined (Puppeteer baixa Chromium automaticamente).
 *
 * Paths verificados (Windows):
 *  - Chrome: C:\Program Files\Google\Chrome\Application\chrome.exe
 *  - Chrome (x86): C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
 *  - Edge: C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
 *
 * Paths verificados (Linux):
 *  - /usr/bin/google-chrome, /usr/bin/chromium-browser, /usr/bin/chromium
 *
 * Paths verificados (macOS):
 *  - /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 */
function findBrowserExecutable(): string | undefined {
  const fs = require('node:fs');
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      // LocalAppData (instalação por usuário)
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    // Linux
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/microsoft-edge',
    );
  }

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch { /* ignora */ }
  }
  return undefined;
}
