/**
 * prepare-bundle.js — prepara o bundle pra o app funcionar SEM Node.js instalado.
 *
 * O que faz:
 *  1. Copia o binário do Node.js (node.exe no Windows, node no Linux/Mac)
 *     pra src-tauri/node-portable
 *  2. Cria um .zip de node_modules/ em src-tauri/node_modules.zip
 *  3. Cria um .zip de dist/ em src-tauri/dist-bundle.zip
 *
 * === CACHE INTELIGENTE ===
 * node_modules.zip só é recriado se o conteúdo mudou (hash de package.json +
 * package-lock.json). Se não mudou, reutiliza o .zip anterior.
 * dist-bundle.zip é SEMPRE recriado (código muda a cada build).
 *
 * Assim o .exe final inclui tudo que o bot precisa pra rodar:
 *  - node-portable (runtime Node.js embutido)
 *  - node_modules.zip (dependências pré-instaladas, com patches aplicados)
 *  - dist-bundle.zip (código compilado TS→JS)
 *
 * Roda automaticamente antes do `tauri build` (em beforeBuildCommand).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
const os = require('node:os');

const tauriDir = path.join(__dirname, 'src-tauri');
const isWindows = os.platform() === 'win32';

console.log('[prepare-bundle] Preparando bundle...');
console.log(`[prepare-bundle] Plataforma: ${os.platform()} (${os.arch()})`);

// === Helpers ===

/**
 * Calcula hash de um arquivo (SHA-256).
 */
function fileHash(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch { return null; }
}

/**
 * Verifica se o .zip existente foi criado com o mesmo hash de origem.
 * Lê um arquivo .hash ao lado do .zip pra comparar.
 */
function isCacheValid(zipPath, sourceHash) {
  const hashPath = zipPath + '.hash';
  try {
    if (!fs.existsSync(zipPath) || !fs.existsSync(hashPath)) return false;
    const savedHash = fs.readFileSync(hashPath, 'utf8').trim();
    return savedHash === sourceHash;
  } catch { return false; }
}

/**
 * Salva o hash da origem ao lado do .zip.
 */
function saveCacheHash(zipPath, sourceHash) {
  try { fs.writeFileSync(zipPath + '.hash', sourceHash, 'utf8'); }
  catch { /* ignora */ }
}

// === 1. Copia binário do Node.js ===
function copyNodeBinary() {
  const nodePath = process.execPath;
  const ext = isWindows ? '.exe' : '';
  const dstName = `node-portable${ext}`;
  const dst = path.join(tauriDir, dstName);

  // Só copia se não existe ou se é diferente (compara tamanho)
  let needCopy = true;
  try {
    if (fs.existsSync(dst)) {
      const srcSize = fs.statSync(nodePath).size;
      const dstSize = fs.statSync(dst).size;
      if (srcSize === dstSize) needCopy = false;
    }
  } catch { /* copia por garantia */ }

  if (needCopy) {
    console.log(`[prepare-bundle] Copiando Node.js (${(fs.statSync(nodePath).size / 1024 / 1024).toFixed(0)}MB)…`);
    try {
      fs.copyFileSync(nodePath, dst);
      if (!isWindows) fs.chmodSync(dst, 0o755);
      console.log('[prepare-bundle] ✅ Node.js copiado');
    } catch (e) {
      console.error(`[prepare-bundle] ❌ Erro ao copiar Node.js: ${e.message}`);
    }
  } else {
    console.log('[prepare-bundle] ⏭️  Node.js já está atualizado (pulando cópia)');
  }
}

// === 2. Cria zip de node_modules (COM CACHE) ===
function zipNodeModules() {
  const src = path.join(__dirname, 'node_modules');
  const dst = path.join(tauriDir, 'node_modules.zip');

  if (!fs.existsSync(src)) {
    console.error('[prepare-bundle] ❌ node_modules/ não existe — rode npm install primeiro');
    return;
  }

  // Hash baseado em package.json + package-lock.json
  // Se esses não mudaram, node_modules também não mudou (assumindo npm install correto)
  const pkgHash = fileHash(path.join(__dirname, 'package.json')) +
                  fileHash(path.join(__dirname, 'package-lock.json'));
  const sourceHash = crypto.createHash('sha256').update(pkgHash).digest('hex');

  // Verifica cache
  if (isCacheValid(dst, sourceHash)) {
    const sizeMB = (fs.statSync(dst).size / 1024 / 1024).toFixed(1);
    console.log(`[prepare-bundle] ⏭️  node_modules.zip cache válido (${sizeMB}MB) — pulando recompactação`);
    return;
  }

  console.log('[prepare-bundle] Compactando node_modules (pode demorar)...');
  try {
    // BUG FIX: se o .zip existente tá corrompido, `zip -r` tenta atualizar
    // em vez de criar novo, e falha com "Zip file structure invalid".
    // Solução: sempre remover o .zip existente antes de criar.
    try { fs.unlinkSync(dst); } catch { /* ok se não existe */ }
    try { fs.unlinkSync(dst + '.hash'); } catch { /* ok se não existe */ }

    if (isWindows) {
      execSync(`powershell -Command "Compress-Archive -Path '${src}/*' -DestinationPath '${dst}' -Force"`, { stdio: 'inherit' });
    } else {
      // BUG FIX: antes usava `-i '*'` que causava "Zip file structure invalid" no
      // GitHub Actions (Ubuntu). O `-i '*'` é redundante — `zip -r` já inclui tudo.
      // Removido também o `-q` (quiet) pra mostrar warnings reais em caso de erro.
      // Flag `-y` armazena symlinks como symlinks (não segue) — node_modules tem muitos.
      // Flag `-X` não salva atributos extras que podem quebrar em filesystems diferentes.
      execSync(`zip -r -y -X '${dst}' .`, { cwd: src, stdio: 'inherit' });
    }
    saveCacheHash(dst, sourceHash);
    const sizeMB = (fs.statSync(dst).size / 1024 / 1024).toFixed(1);
    console.log(`[prepare-bundle] ✅ node_modules.zip criado (${sizeMB}MB)`);
  } catch (e) {
    console.error(`[prepare-bundle] ❌ Erro ao criar zip: ${e.message}`);
    // Fallback: tenta sem -y -X (compatibilidade)
    try { fs.unlinkSync(dst); } catch { /* ok */ }
    try {
      execSync(`zip -r '${dst}' .`, { cwd: src, stdio: 'inherit' });
      saveCacheHash(dst, sourceHash);
      const sizeMB = (fs.statSync(dst).size / 1024 / 1024).toFixed(1);
      console.log(`[prepare-bundle] ✅ node_modules.zip criado via fallback (${sizeMB}MB)`);
    } catch (e2) {
      console.error(`[prepare-bundle] ❌ Fallback também falhou: ${e2.message}`);
    }
  }
}

// === 3. Cria zip de dist/ (SEMPRE recria — código muda a cada build) ===
function zipDist() {
  const src = path.join(__dirname, 'dist');
  const dst = path.join(tauriDir, 'dist-bundle.zip');

  if (!fs.existsSync(src)) {
    console.error('[prepare-bundle] ⚠️ dist/ não existe — rode npm run build primeiro');
    return;
  }

  console.log('[prepare-bundle] Compactando dist/...');
  try {
    // BUG FIX: sempre remover o .zip existente antes de criar (evita "Zip file structure invalid")
    try { fs.unlinkSync(dst); } catch { /* ok se não existe */ }

    if (isWindows) {
      execSync(`powershell -Command "Compress-Archive -Path '${src}/*' -DestinationPath '${dst}' -Force"`, { stdio: 'inherit' });
    } else {
      // Sem -q (pra mostrar warnings), com -y (symlinks) e -X (sem atributos extras)
      execSync(`zip -r -y -X '${dst}' .`, { cwd: src, stdio: 'inherit' });
    }
    const sizeMB = (fs.statSync(dst).size / 1024 / 1024).toFixed(1);
    console.log(`[prepare-bundle] ✅ dist-bundle.zip criado (${sizeMB}MB)`);
  } catch (e) {
    console.error(`[prepare-bundle] ❌ Erro ao criar zip do dist: ${e.message}`);
    // Fallback: tenta sem -y -X
    try { fs.unlinkSync(dst); } catch { /* ok */ }
    try {
      execSync(`zip -r '${dst}' .`, { cwd: src, stdio: 'inherit' });
      const sizeMB = (fs.statSync(dst).size / 1024 / 1024).toFixed(1);
      console.log(`[prepare-bundle] ✅ dist-bundle.zip criado via fallback (${sizeMB}MB)`);
    } catch (e2) {
      console.error(`[prepare-bundle] ❌ Fallback do dist também falhou: ${e2.message}`);
    }
  }
}

// === Run ===
copyNodeBinary();
zipNodeModules();
zipDist();
console.log('[prepare-bundle] ✅ Bundle preparado');
