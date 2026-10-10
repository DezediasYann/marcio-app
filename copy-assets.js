/**
 * copy-assets.js — copia arquivos não-TS (HTML/CSS/JS) pra dist/ após tsc.
 *
 * O tsc só compila .ts → .js. Arquivos como index.html não são incluídos.
 * Este script copia a pasta public/ (com o dashboard HTML) pra dentro de dist/,
 * mantendo a estrutura de diretórios que o ControlPanel espera.
 */
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, 'src', 'control', 'public');
const dstDir = path.join(__dirname, 'dist', 'control', 'public');

try {
  fs.cpSync(srcDir, dstDir, { recursive: true });
  console.log('✅ assets copiados: src/control/public → dist/control/public');
} catch (e) {
  console.error('❌ erro ao copiar assets:', e.message);
  process.exit(1);
}
