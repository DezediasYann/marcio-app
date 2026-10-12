/**
 * AudioTranscriber — transcreve áudios do WhatsApp usando Gemini multimodal.
 *
 * === COMO FUNCIONA ===
 *  - Mensagens de áudio do WhatsApp chegam em formato OGG Opus (msg.type='ptt' ou 'audio').
 *  - Baixa a mídia via msg.downloadMedia() → base64 do OGG.
 *  - Manda pro Gemini com inline_data (mime_type=audio/ogg).
 *  - Prompt curto: "transcreva este áudio em PT-BR, só a transcrição".
 *  - Tenta primaryModel primeiro; se 429/503 (rate limit), cai pro fallbackModel.
 *
 * === POR QUE FLASH LITE ===
 *  - Aceita áudio como input multimodal (igual a imagem).
 *  - Multilíngue (entende PT-BR sem config).
 *  - Mesma API key e endpoint do modelo de texto (sem custo adicional de config).
 *  - HTTP POST normal (não precisa de WebSocket streaming como o Transcribe Live).
 *
 * === CUSTO ===
 *  - 1 request por áudio transcritor.
 *  - Latência típica: 2-5s.
 *  - Tokens: ~32 tokens/seg de áudio no input.
 *
 * === DEPENDÊNCIAS ===
 *  - this.app.brain → getAIConfig() (lê ai-config.json com cache 5s)
 *  - data/ai-config.json → campos audioTranscription.{enabled, primaryModel, fallbackModel}
 */

import type { MarcioApp } from '../MarcioApp';
import type { Message } from 'whatsapp-web.js';

/** Config de transcrição de áudio (lida do ai-config.json). */
export interface AudioTranscriptionConfig {
  enabled: boolean;
  primaryModel: string;
  fallbackModel: string;
}

/** Defaults se o ai-config.json não tem a seção audioTranscription. */
export const DEFAULT_AUDIO_CONFIG: AudioTranscriptionConfig = {
  enabled: true,
  primaryModel: 'gemini-3.5-flash-lite',
  fallbackModel: 'gemini-3.1-flash-lite',
};

export class AudioTranscriber {
  private app: MarcioApp;
  /**
   * Cache da config (5s) — espelha o CACHE_TTL_MS do Brain.
   * Evita reler o JSON a cada áudio.
   */
  private configCache: AudioTranscriptionConfig | null = null;
  private configCacheTime = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(app: MarcioApp) {
    this.app = app;
  }

  /**
   * Lê a seção `audioTranscription` do ai-config.json com cache 5s.
   * Se a seção não existe ou está malformada, usa DEFAULT_AUDIO_CONFIG.
   */
  getConfig(): AudioTranscriptionConfig {
    const now = Date.now();
    if (this.configCache !== null && (now - this.configCacheTime) < this.CACHE_TTL_MS) {
      return this.configCache;
    }

    try {
      const cfg = this.app.brain.getAIConfig();
      const raw = (cfg as any).audioTranscription;
      if (raw && typeof raw === 'object') {
        this.configCache = {
          enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AUDIO_CONFIG.enabled,
          primaryModel: typeof raw.primaryModel === 'string' && raw.primaryModel.trim()
            ? raw.primaryModel.trim()
            : DEFAULT_AUDIO_CONFIG.primaryModel,
          fallbackModel: typeof raw.fallbackModel === 'string' && raw.fallbackModel.trim()
            ? raw.fallbackModel.trim()
            : DEFAULT_AUDIO_CONFIG.fallbackModel,
        };
        this.configCacheTime = now;
        return this.configCache;
      }
    } catch (e) {
      this.app.debug('AUDIO', `erro ao ler config de áudio: ${(e as Error).message}`);
    }

    this.configCache = { ...DEFAULT_AUDIO_CONFIG };
    this.configCacheTime = now;
    return this.configCache;
  }

  /**
   * Invalida o cache de config (chamado pelo ControlPanel quando o usuário
   * edita a config de áudio via painel — mesma pattern do brain).
   */
  invalidateConfigCache(): void {
    this.configCache = null;
    this.configCacheTime = 0;
  }

  /**
   * Verifica se uma msg do WhatsApp é um áudio transcrevível.
   * Tipos aceitos: 'ptt' (push-to-talk, áudio gravado) e 'audio' (qualquer áudio).
   * Requer msg.hasMedia (sem isso não tem como baixar).
   */
  isAudioMessage(msg: Message): boolean {
    const msgAny = msg as any;
    if (!msgAny.hasMedia) return false;
    const type = msgAny.type;
    return type === 'ptt' || type === 'audio';
  }

  /**
   * Transcreve um áudio do WhatsApp.
   *
   * Fluxo:
   *  1. Baixa a mídia via msg.downloadMedia() (base64 OGG Opus).
   *  2. Tenta primaryModel (ex: gemini-3.5-flash-lite).
   *  3. Se 429 (rate limit) ou 503 (unavailable), cai pro fallbackModel.
   *  4. Retorna a transcrição (string, já limpa) ou null se ambos falharem.
   *
   * @returns Texto transcrito OU null se falhou em ambos modelos.
   */
  async transcribe(msg: Message): Promise<string | null> {
    const config = this.getConfig();
    if (!config.enabled) {
      this.app.debug('AUDIO', `transcrição desativada na config — pulando`);
      return null;
    }

    // 1. Baixa a mídia
    let mediaData: string | null = null;
    let mediaMimetype: string | null = null;
    try {
      const media = await (msg as any).downloadMedia();
      if (!media || !media.data) {
        this.app.debug('AUDIO', `downloadMedia retornou vazio — não dá pra transcrever`);
        return null;
      }
      mediaData = media.data;
      // WhatsApp usa audio/ogg; codecs=opus. Gemini aceita audio/ogg direto.
      mediaMimetype = media.mimetype || 'audio/ogg';
      this.app.debug('AUDIO', `áudio baixado: ${Math.round((mediaData as string).length * 0.75 / 1024)}KB, mimetype=${mediaMimetype}`);
    } catch (e) {
      this.app.debug('AUDIO', `erro ao baixar áudio: ${(e as Error).message}`);
      return null;
    }

    // A partir daqui mediaData e mediaMimetype são garantidamente strings.
    const audioBase64: string = mediaData as string;
    const audioMime: string = mediaMimetype as string;

    // 2. Tenta primaryModel; se falhar com 429/503, cai pro fallbackModel
    const modelsToTry: string[] = [config.primaryModel];
    if (config.fallbackModel && config.fallbackModel !== config.primaryModel) {
      modelsToTry.push(config.fallbackModel);
    }

    let lastError: string = '';
    for (const modelName of modelsToTry) {
      try {
        this.app.debug('AUDIO', `tentando transcrição com ${modelName}…`);
        const transcription = await this.callGeminiForAudio(modelName, audioBase64, audioMime);
        if (transcription) {
          this.app.debug('AUDIO', `✓ transcrição (${modelName}): "${transcription.slice(0, 60)}…"`);
          return transcription;
        }
        // Resposta vazia — tenta próximo modelo
        lastError = 'resposta vazia';
      } catch (e: any) {
        const status = e?.status;
        const msg = (e as Error).message || 'erro desconhecido';
        lastError = msg;
        // 429 = rate limit, 503 = service unavailable → tenta fallback
        if (status === 429 || status === 503) {
          this.app.debug('AUDIO', `${modelName} respondeu ${status} — tentando fallback`);
          continue;
        }
        // Outro erro (ex: 400 bad request, 401 unauthorized) — não adianta tentar fallback
        // porque o problema não é rate limit.
        this.app.debug('AUDIO', `${modelName} erro não-recuperável: ${msg}`);
        return null;
      }
    }

    // Ambos modelos falharam
    this.app.log('AUDIO', `❌ transcrição falhou em todos modelos. Último erro: ${lastError}`);
    return null;
  }

  /**
   * Faz a chamada HTTP pro Gemini pra um modelo específico.
   * Manda o áudio como inline_data + prompt de transcrição.
   *
   * @throws Error com .status anexado (pra caller decidir se tenta fallback).
   */
  private async callGeminiForAudio(
    modelName: string,
    audioBase64: string,
    audioMimetype: string,
  ): Promise<string> {
    const aiConfig = this.app.brain.getAIConfig();

    const geminiUrl = `${aiConfig.apiUrl.replace(/\/+$/, '')}/${modelName}:generateContent?key=${aiConfig.apiKey}`;

    const body = {
      contents: [{
        parts: [
          {
            text: 'Transcreva este áudio em português brasileiro. Mantenha a naturalidade da fala (inclui gírias, abreviações, erros). Responda SÓ com a transcrição, sem comentários, sem aspas, sem prefixo. Se o áudio estiver silencioso, inaudível ou não for fala, responda com: [áudio sem fala]',
          },
          {
            inline_data: {
              mime_type: audioMimetype,
              data: audioBase64,
            },
          },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 1024,  // transcrição de áudio de até ~2min cabe em 1024 tokens
        temperature: 0.1,  // transcrição = baixa criatividade
      },
    };

    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      const err = new Error(`Gemini ${modelName} API ${response.status}: ${errText.slice(0, 200)}`);
      (err as any).status = response.status;
      throw err;
    }

    const data = await response.json() as any;
    const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) {
      // Às vezes Gemini bloqueia por safety — checa finishReason
      const finishReason = data?.candidates?.[0]?.finishReason;
      if (finishReason === 'SAFETY') {
        throw new Error(`Gemini bloqueou por safety (áudio pode ter conteúdo sensível)`);
      }
      throw new Error('Resposta vazia da Gemini API');
    }

    // Limpa a transcrição
    let cleaned = content.trim();
    // Remove possíveis aspas que o Gemini adiciona
    if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
      cleaned = cleaned.slice(1, -1);
    }
    // Remove prefixos comuns que o Gemini pode adicionar
    cleaned = cleaned.replace(/^(transcrição|transcription|texto)\s*:\s*/i, '');
    // Se Gemini retornou exatamente "[áudio sem fala]", retorna vazio
    if (/\[áudio sem fala\]/i.test(cleaned)) {
      return '';
    }
    return cleaned.trim() || '';
  }
}
