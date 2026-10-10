#!/usr/bin/env node
/**
 * patch-whatsapp-web.js — aplica o patch de compatibilidade com ffmpeg 6+.
 *
 * O whatsapp-web.js usa '-vsync 0' na linha de comando do ffmpeg pra criar
 * figurinhas animadas (vídeo → webp). Mas o ffmpeg 6+ removeu a opção -vsync
 * — agora é '-fps_mode vfr'. Sem esse patch, figurinhas animadas falham com
 * "ffmpeg exited with code 2880417800: Unrecognized option 'vsync'".
 *
 * Roda automaticamente após `npm install` (script postinstall no package.json).
 * Idempotente: se já tá patcheado, não faz nada.
 */

const fs = require('node:fs');
const path = require('node:path');

const targetFile = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Util.js');

// Padrão a encontrar (3 linhas: '-vsync', '0',)
const OLD_PATTERN = /'-vsync',\s*\n\s*'0',/;
// Substituição (2 linhas: '-fps_mode', 'vfr',)
const NEW_CODE = `'-fps_mode',\n                    'vfr',`;

function main() {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch] whatsapp-web.js não encontrado em node_modules — pulando (talvez ainda não instalado).');
    return;
  }

  let content = fs.readFileSync(targetFile, 'utf8');

  // Já patcheado?
  if (content.includes("'-fps_mode'") && content.includes("'vfr'")) {
    console.log('[patch] whatsapp-web.js já está patcheado (-fps_mode vfr) — nada a fazer.');
    return;
  }

  // Aplica patch
  if (!OLD_PATTERN.test(content)) {
    console.warn('[patch] AVISO: padrão -vsync 0 não encontrado em Util.js. Talvez a versão do whatsapp-web.js mudou. Verifique manualmente.');
    return;
  }

  content = content.replace(OLD_PATTERN, NEW_CODE);
  fs.writeFileSync(targetFile, content, 'utf8');
  console.log('[patch] ✅ whatsapp-web.js patcheado: -vsync 0 → -fps_mode vfr (compat ffmpeg 6+)');
}

try {
  main();
} catch (e) {
  console.error('[patch] ❌ erro ao aplicar patch:', e.message);
  // Não falha o install — o bot ainda funciona (só figurinhas animadas quebram)
  process.exit(0);
}
