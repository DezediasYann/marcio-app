/**
 * copy-to-tauri.js — copia dist/ + data/ + package.json + patch pra src-tauri/
 * antes do tauri build. Assim o Tauri consegue bundlar como resources.
 *
 * Roda automaticamente no `npm run build` (depois do tsc + copy-assets).
 */
const fs = require('node:fs');
const path = require('node:path');

function copyDir(src, dst) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-to-tauri] origem não existe: ${src}`);
    return;
  }
  fs.cpSync(src, dst, { recursive: true });
  console.log(`✅ ${path.relative(process.cwd(), src)} → ${path.relative(process.cwd(), dst)}`);
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) {
    console.warn(`[copy-to-tauri] arquivo não existe: ${src}`);
    return;
  }
  fs.copyFileSync(src, dst);
  console.log(`✅ ${path.basename(src)} → ${path.relative(process.cwd(), dst)}`);
}

// Copia pra src-tauri/ (onde o tauri.conf.json procura resources)
const tauriDir = path.join(__dirname, 'src-tauri');

// dist/ (código compilado do bot) — sempre sobrescreve
copyDir(path.join(__dirname, 'dist'), path.join(tauriDir, 'dist'));

// data/ (configs padrão) — copia se não existe
const tauriDataDir = path.join(tauriDir, 'data');
if (!fs.existsSync(tauriDataDir)) {
  copyDir(path.join(__dirname, 'data'), tauriDataDir);
} else {
  console.log('⏭️  src-tauri/data/ já existe — pulando');
}

// package.json + patch-whatsapp-web.js
copyFile(path.join(__dirname, 'package.json'), path.join(tauriDir, 'package.json'));
copyFile(path.join(__dirname, 'patch-whatsapp-web.js'), path.join(tauriDir, 'patch-whatsapp-web.js'));

console.log('✅ copy-to-tauri concluído');
