/**
 * precopy.js — copia arquivos necessários pra src-tauri/ ANTES do Tauri compilar.
 *
 * Esse script roda em BOTH dev (beforeDevCommand) e build (beforeBuildCommand).
 * Garante que changelog.json, package.json e patch-whatsapp-web.js existam em
 * src-tauri/ — sem isso, o Tauri falha com "resource path doesn't exist".
 *
 * NÃO copia dist/ (só existe depois do tsc) nem data/ (criado em runtime).
 * Em dev, o bot roda via tsx (não precisa de dist/).
 */
const fs = require('node:fs');
const path = require('node:path');

const tauriDir = path.join(__dirname, 'src-tauri');

// Arquivos que PRECISAM existir em src-tauri/ pra o Tauri compilar.
// (declarados em tauri.conf.json → bundle.resources)
const requiredFiles = [
  'changelog.json',
  'package.json',
  'patch-whatsapp-web.js',
];

let missing = 0;
for (const file of requiredFiles) {
  const src = path.join(__dirname, file);
  const dst = path.join(tauriDir, file);
  if (!fs.existsSync(src)) {
    console.warn(`[precopy] ⚠️ ${file} não existe na raiz do projeto — pulando`);
    missing++;
    continue;
  }
  try {
    fs.copyFileSync(src, dst);
    console.log(`[precopy] ✅ ${file} → src-tauri/${file}`);
  } catch (e) {
    console.error(`[precopy] ❌ erro ao copiar ${file}: ${e.message}`);
    missing++;
  }
}

// Cria src-tauri/data/ com .gitkeep se não existe (Tauri precisa que exista)
const tauriDataDir = path.join(tauriDir, 'data');
if (!fs.existsSync(tauriDataDir)) {
  fs.mkdirSync(tauriDataDir, { recursive: true });
  fs.mkdirSync(path.join(tauriDataDir, 'stickers-vault'), { recursive: true });
  fs.writeFileSync(path.join(tauriDataDir, '.gitkeep'), '');
  fs.writeFileSync(path.join(tauriDataDir, 'stickers-vault', '.gitkeep'), '');
  console.log('[precopy] ✅ data/ criado (vazio com .gitkeep)');
}

// Cria placeholders vazios pros arquivos de bundle (Tauri exige que existam
// em tempo de compilação — prepare-bundle.js cria os reais depois).
// Se prepare-bundle.js já criou (build anterior), NÃO sobrescreve.
const bundleFiles = ['node_modules.zip', 'dist-bundle.zip'];
for (const file of bundleFiles) {
  const dst = path.join(tauriDir, file);
  if (!fs.existsSync(dst)) {
    // Cria um zip vazio (PK\x03\x04 + fim de arquivo)
    // Apenas pra o Tauri não reclamar que não existe.
    const emptyZip = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    fs.writeFileSync(dst, emptyZip);
    console.log(`[precopy] ✅ ${file} placeholder criado (vazio — prepare-bundle.js preenche depois)`);
  }
}

if (missing > 0) {
  console.warn(`[precopy] ⚠️ ${missing} arquivo(s) faltando — build pode falhar`);
}
