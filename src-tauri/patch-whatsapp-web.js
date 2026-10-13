#!/usr/bin/env node
/**
 * patch-whatsapp-web.js — aplica patches de compatibilidade no whatsapp-web.js.
 *
 * Patch 1: ffmpeg 6+ (-vsync 0 → -fps_mode vfr)
 * Patch 2: canCheckStatusRankingPosterGating (WhatsApp Web mudou API interna)
 *
 * Roda automaticamente após `npm install` (script postinstall no package.json).
 * Idempotente: se já tá patcheado, não faz nada.
 */

const fs = require('node:fs');
const path = require('node:path');

function patchFile(filePath, check, find, replace, label) {
  if (!fs.existsSync(filePath)) {
    console.log(`[patch] ${label}: arquivo não encontrado — pulando`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');

  // Já patcheado?
  if (check(content)) {
    console.log(`[patch] ${label}: já patcheado — nada a fazer`);
    return;
  }

  // Aplica patch
  if (!find.test(content)) {
    console.warn(`[patch] ${label}: AVISO: padrão não encontrado. Versão pode ter mudado.`);
    return;
  }

  content = content.replace(find, replace);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`[patch] ✅ ${label}`);
}

function main() {
  const base = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src');

  // === Patch 1: ffmpeg -vsync 0 → -fps_mode vfr ===
  patchFile(
    path.join(base, 'util', 'Util.js'),
    (c) => c.includes("'-fps_mode'") && c.includes("'vfr'"),
    /'-vsync',\s*\n\s*'0',/,
    `'-fps_mode',\n                    'vfr',`,
    'whatsapp-web.js: -vsync 0 → -fps_mode vfr (compat ffmpeg 6+)'
  );

  // === Patch 2: canCheckStatusRankingPosterGating → try/catch fallback ===
  patchFile(
    path.join(base, 'util', 'Injected', 'Utils.js'),
    (c) => c.includes('cannotBeRanked: (() => {'),
    /cannotBeRanked:\s*window\s*\n\s*\.require\('WAWebStatusGatingUtils'\)\s*\n\s*\.canCheckStatusRankingPosterGating\(\),/,
    `cannotBeRanked: (() => {\n                        try {\n                            return window.require('WAWebStatusGatingUtils').canCheckStatusRankingPosterGating();\n                        } catch {\n                            return false;\n                        }\n                    })(),`,
    'whatsapp-web.js: canCheckStatusRankingPosterGating → try/catch fallback'
  );

  // === Patch 3: isStatus = false (getIsBroadcast bug) ===
  patchFile(
    path.join(base, 'util', 'Injected', 'Utils.js'),
    (c) => c.includes('PATCH: getIsBroadcast'),
    /const isStatus = getIsBroadcast\(chat\);/,
    `// PATCH: getIsBroadcast pode retornar true erroneamente pra PVs.\n        // Forçamos isStatus = false (o bot nunca manda status).\n        // Pra mandar status, usar client.sendMessage('status@broadcast', ...).\n        const isStatus = false;`,
    'whatsapp-web.js: isStatus = false (fix msgs indo pra status)'
  );
}

try {
  main();
} catch (e) {
  console.error('[patch] ❌ erro ao aplicar patch:', e.message);
  process.exit(0);
}
