/**
 * LastCollage — cria colagens do Last.fm (top álbuns em grid).
 *
 * Responsabilidades:
 *  - Ler API key do Last.fm de data/lastfm-config.json
 *  - Buscar top álbuns via API do Last.fm (user.getTopAlbums)
 *  - Baixar capas dos álbuns
 *  - Compor grid (3x3, 4x4, 5x5) usando jimp
 *  - Retornar MessageMedia pronto pra enviar no WhatsApp
 *
 * Uso:
 *   const result = await app.lastCollage.generateCollage('rjanhs', 4, '7d');
 *   if (result) await client.sendMessage(chatId, result.media, { caption: result.caption });
 *
 * Dependências: jimp (npm install jimp)
 */

import type { MarcioApp } from '../MarcioApp';
import { MessageMedia } from 'whatsapp-web.js';
import fs from 'node:fs';

// ============================================================================
// TIPOS
// ============================================================================

interface LastFmAlbum {
  name: string;
  artist: string;
  playcount: number;
  imageUrl: string;
}

interface LastFmConfig {
  apiKey: string;
}

// ============================================================================
// LAST COLLAGE
// ============================================================================

const PERIOD_MAP: Record<string, string> = {
  '7d': '7day',
  '1m': '1month',
  '3m': '3month',
  '6m': '6month',
  '12m': '12month',
  'overall': 'overall',
};

const COVER_SIZE = 300;

export class LastCollage {
  private app: MarcioApp;
  private configCache: LastFmConfig | null = null;
  private configCacheTime = 0;
  private readonly CACHE_TTL_MS = 5000;

  constructor(app: MarcioApp) {
    this.app = app;
  }

  getConfig(): LastFmConfig {
    const now = Date.now();
    if (this.configCache !== null && (now - this.configCacheTime) < this.CACHE_TTL_MS) {
      return this.configCache;
    }
    try {
      const filePath = this.app.dataPath('lastfm-config.json');
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      this.configCache = { apiKey: parsed.apiKey || '' };
    } catch {
      this.configCache = { apiKey: '' };
    }
    this.configCacheTime = now;
    return this.configCache;
  }

  invalidateConfigCache(): void {
    this.configCacheTime = 0;
  }

  async getTopAlbums(username: string, period: string, limit: number): Promise<LastFmAlbum[]> {
    const config = this.getConfig();
    if (!config.apiKey) {
      throw new Error('Last.fm API key não configurada. Configure no painel → IA → Last.fm.');
    }

    const lastfmPeriod = PERIOD_MAP[period] || '7day';
    const url = `https://ws.audioscrobbler.com/2.0/?method=user.gettopalbums` +
      `&user=${encodeURIComponent(username)}` +
      `&period=${lastfmPeriod}` +
      `&limit=${limit}` +
      `&api_key=${config.apiKey}` +
      `&format=json`;

    this.app.debug('LASTFM', `buscando top ${limit} álbuns de ${username} (${period})`);

    const response = await fetch(url);
    if (!response.ok) {
      if (response.status === 404) throw new Error(`Usuário "${username}" não encontrado no Last.fm`);
      throw new Error(`Last.fm API erro ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as any;

    // Verifica erro da API do Last.fm
    if (data.error) {
      const apiError = String(data.message || data.error || '');
      // Last.fm retorna erro 6 quando usuário não existe
      if (data.error === 6 || apiError.toLowerCase().includes('user not found')) {
        throw new Error(`Usuário "${username}" não existe no Last.fm. Confira se digitou corretamente.`);
      }
      // Erro de API key inválida
      if (data.error === 10 || apiError.toLowerCase().includes('api key')) {
        throw new Error('API key do Last.fm inválida. Configure uma key válida no painel → IA → Last.fm.');
      }
      // Outro erro genérico
      throw new Error(`Last.fm retornou erro: ${apiError}`);
    }

    const albums = data?.topalbums?.album;
    if (!albums || !Array.isArray(albums) || albums.length === 0) {
      // Usuário existe mas não tem scrobbles no período — provável Spotify desconectou
      throw new Error(`"${username}" não tem scrobbles no período ${period}. Isso costuma acontecer quando o Spotify desconecta do Last.fm (a cada 3 meses). Reconecte em last.fm/settings/applications`);
    }

    const result: LastFmAlbum[] = [];
    for (const album of albums) {
      const images = album.image || [];
      let imageUrl = '';
      for (const img of images) {
        if (img.size === 'extralarge' && img['#text']) {
          imageUrl = img['#text'];
        }
      }
      if (!imageUrl) {
        for (const img of images) {
          if (img['#text']) imageUrl = img['#text'];
        }
      }
      if (!imageUrl) continue;

      result.push({
        name: album.name || '?',
        artist: album.artist?.name || '?',
        playcount: album.playcount || 0,
        imageUrl,
      });
    }

    this.app.debug('LASTFM', `${result.length} álbuns com capa encontrados`);
    return result;
  }

  async createCollage(albums: LastFmAlbum[], gridSize: number): Promise<Buffer | null> {
    if (albums.length === 0) return null;

    let Jimp: any;
    try {
      Jimp = (await import('jimp')).default;
    } catch {
      throw new Error('Biblioteca de imagem (jimp) não instalada. Rode: npm install jimp');
    }

    const totalSize = gridSize * COVER_SIZE;
    const collage = new Jimp(totalSize, totalSize, '#000000');

    for (let i = 0; i < albums.length && i < gridSize * gridSize; i++) {
      const album = albums[i];
      const row = Math.floor(i / gridSize);
      const col = i % gridSize;
      const x = col * COVER_SIZE;
      const y = row * COVER_SIZE;

      try {
        const imgResponse = await fetch(album.imageUrl);
        if (!imgResponse.ok) continue;
        const imgBuffer = Buffer.from(await imgResponse.arrayBuffer());
        const cover = await Jimp.read(imgBuffer);
        cover.resize(COVER_SIZE, COVER_SIZE);
        collage.composite(cover, x, y);
        this.app.debug('LASTFM', `capa ${i + 1}/${albums.length}: ${album.artist} - ${album.name}`);
      } catch (e) {
        this.app.debug('LASTFM', `erro ao baixar capa ${i + 1}: ${(e as Error).message}`);
      }
    }

    const buffer = await collage.getBufferAsync(Jimp.MIME_PNG);
    this.app.debug('LASTFM', `✅ collage criado (${(buffer.length / 1024).toFixed(0)}KB)`);
    return buffer;
  }

  async generateCollage(
    username: string,
    gridSize: number = 3,
    period: string = '7d'
  ): Promise<{ media: MessageMedia; caption: string } | { error: string } | null> {
    try {
      gridSize = Math.max(2, Math.min(6, Math.floor(gridSize)));
      const limit = gridSize * gridSize;

      const albums = await this.getTopAlbums(username, period, limit);
      if (albums.length === 0) {
        return { error: `nenhum scrobble encontrado pra ${username} no período ${period}. Pode ser que o Spotify desconectou do Last.fm (acontece a cada 3 meses). Reconecte em last.fm/settings/applications` };
      }

      const imageBuffer = await this.createCollage(albums, gridSize);
      if (!imageBuffer) {
        return { error: 'não consegui montar a imagem do collage. Tente novamente.' };
      }

      const media = new MessageMedia('image/png', imageBuffer.toString('base64'), 'lastfm-collage.png');

      const periodLabel: Record<string, string> = {
        '7d': '7 dias', '1m': '1 mês', '3m': '3 meses',
        '6m': '6 meses', '12m': '12 meses', 'overall': 'sempre',
      };
      const caption = `🎵 Last.fm Collage — ${username}\n` +
        `📊 ${gridSize}x${gridSize} • ${periodLabel[period] || period}\n` +
        `💿 ${albums.length} álbuns`;

      this.app.log('LASTFM', `collage gerado pra ${username} (${gridSize}x${gridSize}, ${period})`);
      return { media, caption };
    } catch (e) {
      const errMsg = (e as Error).message;
      this.app.debug('LASTFM', `erro ao gerar collage: ${errMsg}`);
      // Retorna erro específico pro chamador decidir o que fazer
      return { error: errMsg };
    }
  }
}
