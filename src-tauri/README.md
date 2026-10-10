# Márcio App — Tauri (desktop wrapper)

Esta pasta contém o backend Rust do app desktop Tauri. Ele:

1. **Spawna o bot Node.js** (`npx tsx src/bot.ts`) como processo filho
2. **Abre uma janela nativa** apontando pro painel web (`http://localhost:3001`)
3. **Cria um ícone de bandeja (tray)** com menu: Mostrar / Reiniciar bot / Sair
4. **Minimiza pra tray** quando você fecha a janela (não sai do app)

## Pré-requisitos

- **Rust** instalado (https://rustup.rs) — já feito ✅
- **MSVC Build Tools** (C++ compiler) — já feito ✅
- **Node.js 22+** (já tem pra rodar o bot)

## Como rodar (desenvolvimento)

No terminal, na pasta `marcio-app/` (não aqui em src-tauri):

```powershell
npm run tauri:dev
```

Isso:
1. Roda `npm run dev` (inicia o bot Node.js)
2. Compila o Rust (primeira vez: ~5-10min, depois: ~30s)
3. Abre a janela do app
4. Hot-reload: quando você edita HTML/CSS/JS do painel, a janela atualiza

## Como gerar o .exe (produção)

```powershell
npm run tauri:build
```

Gera o instalador em `src-tauri/target/release/`. Demora ~10-15min (otimização).

## Estrutura

```
src-tauri/
├── Cargo.toml          ← config Rust (dependências)
├── tauri.conf.json     ← config Tauri (janela, ícone, bundle)
├── build.rs            ← build script Tauri
├── capabilities/
│   └── default.json    ← permissões do Tauri 2
├── icons/              ← ícones (pode trocar pelos seus)
│   ├── icon.png        ← 256x256 (principal)
│   ├── icon.ico        ← Windows
│   ├── 32x32.png
│   ├── 128x128.png
│   ├── 128x128@2x.png
│   └── icon.icns       ← macOS (placeholder)
└── src/
    ├── main.rs         ← entrypoint (só chama lib::run())
    └── lib.rs          ← backend: spawn bot + janela + tray
```

## Trocar o ícone

Os ícones em `icons/` são placeholders (um "M" branco no fundo vermelho PT).
Pra trocar pela sua imagem:

1. Substitua `icon.png` por uma imagem 256x256 PNG
2. Gere os outros tamanhos (ou use https://tauri.app/app-icon-generator/)
3. Rode `npm run tauri:dev` pra ver o ícone novo na janela e tray

## Problemas comuns

### "linker `link.exe` not found"
MSVC Build Tools não instalados. Instale "Desktop development with C++" pelo Visual Studio Installer.

### "Windows Defender bloqueou rustc"
Adicione `C:\Users\SEU_USER\.rustup` e `.cargo` às exclusões do Defender.

### Bot não inicia no app
O Rust tenta rodar `npx tsx src/bot.ts`. Certifique-se de que:
- `npm install` foi rodado na pasta `marcio-app/`
- Você tá abrindo o app de dentro da pasta `marcio-app/` (ou configurou o cwd)

### Janela abre mas fica branca
O bot Node.js ainda tá subindo (demora ~5s pra WhatsApp conectar + painel subir).
Aguarde — quando `http://localhost:3001` responder, a janela carrega.
