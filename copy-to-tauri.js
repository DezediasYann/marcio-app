/**
 * copy-to-tauri.js — copia dist/ + package.json + patch pra src-tauri/
 * antes do tauri build. Assim o Tauri consegue bundlar como resources.
 *
 * Roda automaticamente no `npm run build` (depois do tsc + copy-assets).
 *
 * ⚠️ IMPORTANTE: NÃO COPIA DADOS DE USUÁRIO do data/ do projeto.
 * Mesmo se o desenvolvedor tiver memories.json, stickers-vault/*.webp,
 * ai-config.json (com API key), etc. em marcio-app/data/, esses arquivos
 * NÃO vão pro build. Só copia pastas vazias com .gitkeep — o bot cria
 * os arquivos default em runtime (MarcioApp.ensureDefaultDataFiles).
 *
 * Isso garante que o .exe compilado sempre venha ZERADO:
 *  - Sem API key (usuário configura no painel)
 *  - Sem figurinhas (usuário adiciona via !figurinha)
 *  - Sem memórias (bot aprende conforme conversa)
 *  - Sem sessão WhatsApp (pede QR na primeira vez)
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

// data/ — SEMPRE limpa e cria ZERADO (só pastas vazias com .gitkeep).
// NÃO copia o data/ do projeto (pode ter dados sensíveis: API key, memórias, figurinhas).
const tauriDataDir = path.join(tauriDir, 'data');
if (fs.existsSync(tauriDataDir)) {
  console.log('🧹 limpando src-tauri/data/ existente (build zerado)...');
  fs.rmSync(tauriDataDir, { recursive: true, force: true });
}
// Cria estrutura vazia
fs.mkdirSync(tauriDataDir, { recursive: true });
fs.mkdirSync(path.join(tauriDataDir, 'stickers-vault'), { recursive: true });
fs.writeFileSync(path.join(tauriDataDir, '.gitkeep'), '');
fs.writeFileSync(path.join(tauriDataDir, 'stickers-vault', '.gitkeep'), '');
console.log('✅ data/ criado ZERADO (só pastas com .gitkeep) — bot cria defaults em runtime');

// package.json + patch-whatsapp-web.js (sempre sobrescreve)
copyFile(path.join(__dirname, 'package.json'), path.join(tauriDir, 'package.json'));
copyFile(path.join(__dirname, 'patch-whatsapp-web.js'), path.join(tauriDir, 'patch-whatsapp-web.js'));

console.log('✅ copy-to-tauri concluído — build ZERADO (sem dados de usuário, sem API key, sem figurinhas)');


