#!/usr/bin/env node
/**
 * fix-all-releases.js
 *
 * Corrige o bug de 404 no updater do Tauri em TODAS as releases publicadas.
 *
 * PROBLEMA:
 *   O `tauri build` gera o latest.json usando o `productName` cru (com acento
 *   e espaço, ex: "Márcio App_1.0.3-6_x64-setup.exe"). Mas o GitHub normaliza
 *   automaticamente os nomes dos assets no upload:
 *     - Espaços viram "."
 *     - Acentos são removidos (á→a, ç→c, etc.)
 *   Resultado: o asset vira "Marcio.App_1.0.3-6_x64-setup.exe" mas o latest.json
 *   continua apontando pro nome original → 404 no auto-update.
 *
 * SOLUÇÃO:
 *   Pra cada release publicada que tem latest.json:
 *   1. Baixa o latest.json
 *   2. Compara o URL com o nome REAL do asset .exe (pós-normalização do GitHub)
 *   3. Se diferente, reescreve o latest.json e faz re-upload
 *
 * USO:
 *   npm run fix-releases              # corrige todas
 *   npm run fix-releases -- v1.0.3-6  # corrige só uma release específica
 *   npm run fix-releases -- --dry-run  # só mostra o que mudaria, sem fazer upload
 *
 * PRÉ-REQUISITOS:
 *   - GitHub CLI (gh) autenticado: `gh auth login`
 *   - Permissão de write no repo (DezediasYann/marcio-app)
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = 'DezediasYann/marcio-app';
const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_TAG = process.argv.find(a => !a.startsWith('-') && !a.endsWith('.js') && a !== process.argv[0] && a !== process.argv[1]);

// ─── helpers ──────────────────────────────────────────────────────────────
function gh(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', shell: true });
  if (r.status !== 0) {
    throw new Error(`gh ${args.join(' ')} falhou (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function log(icon, ...args) { console.log(`  ${icon} ${args.join(' ')}`); }
function headline(s) { console.log(`\n${'═'.repeat(70)}\n${s}\n${'═'.repeat(70)}`); }

// ─── lógica principal ────────────────────────────────────────────────────
function listReleases() {
  const out = gh(['release', 'list', '--repo', REPO, '--json', 'tagName,name', '--limit', '100']);
  return JSON.parse(out).map(r => r.tagName);
}

function getReleaseAssets(tag) {
  const out = gh(['release', 'view', tag, '--repo', REPO, '--json', 'assets']);
  return JSON.parse(out).assets;
}

function downloadAsset(tag, assetName, destPath) {
  // gh release download <tag> --repo <repo> --pattern <name> --dir <dest> --clobber
  spawnSync('gh', [
    'release', 'download', tag,
    '--repo', REPO,
    '--pattern', assetName,
    '--dir', path.dirname(destPath),
    '--clobber',
  ], { encoding: 'utf8', shell: true, stdio: 'pipe' });
  return fs.existsSync(destPath);
}

function fixLatestJson(tag) {
  const assets = getReleaseAssets(tag);
  const latestAsset = assets.find(a => a.name === 'latest.json');
  if (!latestAsset) {
    log('⚪', `${tag}: sem latest.json — pulando`);
    return 'skip-no-latest';
  }

  // Acha o .exe NSIS real (exclui .sig, pega só x64-setup)
  const exeAsset = assets.find(a =>
    a.name.endsWith('_x64-setup.exe') &&
    !a.name.endsWith('.sig')
  );
  if (!exeAsset) {
    log('⚪', `${tag}: sem .exe NSIS — pulando`);
    return 'skip-no-exe';
  }

  // Baixa o latest.json atual
  const tmpDir = path.join(os.tmpdir(), `marcio-fix-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const latestPath = path.join(tmpDir, 'latest.json');
  if (!downloadAsset(tag, 'latest.json', latestPath)) {
    log('❌', `${tag}: não consegui baixar latest.json`);
    return 'fail-download';
  }

  const raw = fs.readFileSync(latestPath, 'utf8');
  let json;
  try { json = JSON.parse(raw); }
  catch { log('❌', `${tag}: latest.json inválido`); return 'fail-parse'; }

  if (!json.platforms) {
    log('⚠️', `${tag}: latest.json sem campo 'platforms' — pulando`);
    return 'skip-no-platforms';
  }

  // Compara URL atual com nome real do asset
  const realExeName = exeAsset.name;
  let mismatch = false;
  let changedPlatforms = [];

  for (const [platform, info] of Object.entries(json.platforms)) {
    if (!info.url) continue;
    const currentExe = path.basename(info.url);
    if (currentExe !== realExeName) {
      mismatch = true;
      changedPlatforms.push({ platform, old: currentExe, new: realExeName });
    }
  }

  if (!mismatch) {
    log('✅', `${tag}: latest.json já está correto`);
    return 'ok';
  }

  // Log do que vai mudar
  for (const c of changedPlatforms) {
    log('🔧', `${tag} [${c.platform}]:`);
    log('   ', `de: ${c.old}`);
    log('   ', `para: ${c.new}`);
  }

  if (DRY_RUN) {
    log('🔍', `${tag}: --dry-run ativo — não vou fazer upload`);
    return 'dry-run';
  }

  // Reescreve URLs
  const newUrl = `https://github.com/${REPO}/releases/download/${tag}/${realExeName}`;
  for (const info of Object.values(json.platforms)) {
    if (info.url) info.url = newUrl;
  }

  // Salva corrigido
  const fixedPath = path.join(tmpDir, 'latest-fixed.json');
  fs.writeFileSync(fixedPath, JSON.stringify(json, null, 2), 'utf8');

  // Re-upload
  try {
    execSync(`gh release upload ${tag} "${fixedPath}:latest.json" --clobber --repo ${REPO}`, {
      encoding: 'utf8', stdio: 'pipe',
    });
    log('✅', `${tag}: latest.json corrigido e enviado!`);
    return 'fixed';
  } catch (e) {
    log('❌', `${tag}: falha no re-upload: ${e.message}`);
    return 'fail-upload';
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── main ────────────────────────────────────────────────────────────────
function main() {
  headline('🔧 Marcio App — Corretor de latest.json (fix 404 updater)');

  if (DRY_RUN) console.log('🔍 MODO DRY-RUN: só vou mostrar, sem fazer upload\n');
  console.log(`Repo: ${REPO}`);

  // Verifica gh CLI
  try {
    const auth = execSync('gh auth status 2>&1', { encoding: 'utf8' });
    if (!/Logged in/i.test(auth)) {
      console.log('\n❌ GitHub CLI não autenticado. Rode: gh auth login');
      process.exit(1);
    }
  } catch {
    console.log('\n❌ GitHub CLI (gh) não encontrado. Instale: https://cli.github.com/');
    process.exit(1);
  }

  const tags = TARGET_TAG ? [TARGET_TAG] : listReleases();
  console.log(`Releases encontradas: ${tags.length}`);
  if (TARGET_TAG) console.log(`Filtro: só ${TARGET_TAG}`);

  const summary = { fixed: [], ok: [], skip: [], fail: [] };

  for (const tag of tags) {
    console.log(`\n─ ${tag} ${'─'.repeat(Math.max(0, 60 - tag.length))}`);
    try {
      const result = fixLatestJson(tag);
      if (result === 'fixed' || result === 'dry-run') summary.fixed.push(tag);
      else if (result === 'ok') summary.ok.push(tag);
      else if (result.startsWith('skip')) summary.skip.push(`${tag} (${result})`);
      else summary.fail.push(`${tag} (${result})`);
    } catch (e) {
      log('❌', `${tag}: erro inesperado: ${e.message}`);
      summary.fail.push(`${tag} (exception)`);
    }
  }

  // Resumo final
  headline('📊 Resumo');
  console.log(`✅ Corrigidas (${summary.fixed.length}): ${summary.fixed.join(', ') || 'nenhuma'}`);
  console.log(`✅ Já estavam OK (${summary.ok.length}): ${summary.ok.join(', ') || 'nenhuma'}`);
  console.log(`⚪ Puladas (${summary.skip.length}): ${summary.skip.join(', ') || 'nenhuma'}`);
  console.log(`❌ Falhas (${summary.fail.length}): ${summary.fail.join(', ') || 'nenhuma'}`);

  if (summary.fixed.length > 0 && !DRY_RUN) {
    console.log('\n🎉 Pronto! Updater não vai mais dar 404 nas releases corrigidas.');
    console.log('   Usuários em versões antigas agora conseguem atualizar.');
  }

  process.exit(summary.fail.length > 0 ? 1 : 0);
}

main();
