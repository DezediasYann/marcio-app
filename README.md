# Márcio App

> Bot de WhatsApp com IA generativa, memória permanente, figurinhas, comandos assistivos e painel de controle web. Empacotado como app desktop (Tauri 2) que roda em PC sem Node.js instalado.

[![Version](https://img.shields.io/badge/version-1.0.1-22c55e?style=flat-square)](https://github.com/DezediasYann/marcio-app/releases/tag/v1.0.1)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square)](https://github.com/DezediasYann/marcio-app/releases)
[![License](https://img.shields.io/badge/license-Private-red?style=flat-square)](https://github.com/DezediasYann/marcio-app)
[![Tauri](https://img.shields.io/badge/Tauri-2-orange?style=flat-square)](https://tauri.app)

---

## ✨ O que o app faz

### 🧠 IA Conversacional
- Conversa natural no WhatsApp usando **Google Gemini** (3.5 Flash Lite + 3.1 Flash Lite fallback)
- Responde com base em **memória permanente** (lembra fatos sobre cada contato)
- **Auto-resposta** inteligente (decide quando responder sozinho, com cooldown configurável)
- ProfileBook: perfis dinâmicos por contato (gostos, contexto, histórico)

### 🎵 Transcrição de Áudios
- Transcreve áudios via Gemini (multimodal)
- Fallback automático pra modelo mais leve se o principal falhar
- Só transcreve quando o bot vai responder (economiza quota da API)

### 🎭 Figurinhas
- Comando `!figurinha` (ou reply em qualquer mívida) cria figurinha
- Metadados persistidos (`stickers-meta.json`)
- Pack de figurinhas customizável pelo painel

### 📋 Comandos Assistivos
- Comandos op-only e públicos (configurável via painel)
- `/nome` — muda o nome do bot
- `/alias add|remove|list` — gerencia aliases (100% de resposta)
- `!resumo` — resume conversa recente
- `!figurinha` — cria figurinha da mídia respondida
- Overrides: ativa/desativa/alterna op↔public direto pelo painel

### 🤖 Painel de Controle Web
- 16+ seções: Conexão, Bot & WhatsApp, IA, Memórias, Comandos, Conversas, ProfileBook, Figurinhas, Backup, Changelog, Sobre
- **Auto-refresh** via WebSocket (não precisa dar F5)
- Busca de figurinhas por nome
- Backup & Restore em formato ZIP

### 💬 Conversas
- Lista de chats onde o bot interveio
- Distingue mensagens recebidas vs bot-enviadas
- Badge "histórico" para mensagens importadas via backfill
- Atualização em tempo real

### 👤 ProfileBook
- Perfis automáticos por contato (extraídos das conversas via IA)
- Edição manual direto no painel
- Backup completo dos perfis

### 💾 Backup & Restore
- Exportação em ZIP (todos os dados: memórias, configs, figurinhas, perfis, overrides)
- Importação com detecção automática de formato
- Invalidação de cache completa pós-import
- Sem dependência externa (ZipBundle nativo)

### 🧙 Setup Wizard
- App de 6 passos na primeira execução
- Configura nome do bot, aliases, API key, personalidade
- Janela sem decorações (custom titlebar)
- Bloqueado em dev mode (não sobrescreve dados)

### 🔄 Auto-update
- Detecção automática de novas versões via GitHub Releases
- Modal "O que há de novo?" na primeira execução após update
- Botão "Entendi ✓" marca versão como vista

### 📦 Build de Produção
- `node-portable` embutido (funciona sem Node instalado)
- `node_modules.zip` (deps pré-instaladas com patches)
- `dist-bundle.zip` (código TS compilado)
- Instalador NSIS (Windows), DMG (macOS), AppImage (Linux)

---

## 🚀 Downloads

Baixe o instalador da sua plataforma em:

**https://github.com/DezediasYann/marcio-app/releases/latest**

| Plataforma | Arquivo |
|---|---|
| Windows | `Márcio App_1.0.1_x64-setup.exe` |
| macOS (Apple Silicon) | `Márcio App_1.0.1_aarch64.dmg` |
| macOS (Intel) | `Márcio App_1.0.1_x64.dmg` |
| Linux | `marcio-app_1.0.1_amd64.AppImage` |

Se você já tem uma versão anterior instalada, o app detecta a atualização sozinho.

---

## 🛠️ Desenvolvimento

### Pré-requisitos

- **Node.js 22+** — `node --version`
- **Rust 1.77+** — `rustc --version` (necessário pro Tauri)
- **Tauri CLI 2** — instalado como dev dependency
- **Chromium/Chrome** instalado (whatsapp-web.js usa Puppeteer)

### Instalação

```bash
git clone https://github.com/DezediasYann/marcio-app.git
cd marcio-app
npm install
```

> ⚠️ Se o Puppeteer reclamar que não acha o Chromium, rode:
> ```bash
> npx puppeteer browsers install chrome
> ```

### Rodar em desenvolvimento

```bash
# Modo dev do bot (hot reload via tsx watch):
npm run dev

# Modo dev do Tauri (abre janela desktop + bot):
npm run tauri:dev
```

### Validar código

```bash
# Typecheck (TypeScript sem emitir JS):
npm run typecheck
```

---

## 📦 Deploy via GitHub Releases

O deploy é automático via GitHub Actions. Sempre que você criar uma tag `vX.Y.Z`, o workflow compila pra Windows, macOS e Linux e publica a release.

### Passo a passo pra lançar v1.0.1

#### 1. Garantir que versões estão sincronizadas

Confira estes 3 arquivos têm a mesma versão:

```bash
grep '"version"' package.json                              # 1.0.1
grep '^version' src-tauri/Cargo.toml                        # 1.0.1
grep '"version"' src-tauri/tauri.conf.json                  # 1.0.1
```

E que `changelog.json` tem uma release com `"version": "1.0.1"`.

#### 2. Configurar secrets do Tauri signer

No GitHub: **Settings → Secrets and variables → Actions → New repository secret**

| Nome | Valor |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | conteúdo do arquivo `.key` gerado por `npm run signer:generate` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | senha usada ao gerar a chave |

> Se perdeu a chave, regere com `npm run signer:generate` e atualize a `pubkey` em `src-tauri/tauri.conf.json`.

#### 3. Commitar mudanças

```bash
git add -A
git commit -m "v1.0.1"
```

#### 4. Criar e dar push na tag

```bash
git tag v1.0.1
git push origin v1.0.1
git push origin main
```

#### 5. Acompanhar o build

Vá em: **https://github.com/DezediasYann/marcio-app/actions**

Os 3 jobs (Windows, macOS, Linux) rodam em paralelo e levam ~25 min.

#### 6. Release publicada

Quando os jobs ficam verdes, a release aparece em:

**https://github.com/DezediasYann/marcio-app/releases/tag/v1.0.1**

Com os instaladores e o `latest.json` (pro updater funcionar).

### Próximas releases

Quando quiser lançar v1.0.2:

1. Bumpa versão em 3 arquivos (`package.json`, `Cargo.toml`, `tauri.conf.json`)
2. Adiciona entrada nova em `changelog.json`
3. `git commit -am "v1.0.2"`
4. `git tag v1.0.2 && git push origin v1.0.2`

Quem tiver o app instalado vai receber notificação automática de update.

---

## 🧩 Estrutura do Projeto

```
marcio-app/
├── package.json              ← deps + scripts
├── tsconfig.json             ← config TypeScript
├── changelog.json            ← changelog estruturado (lido pelo painel)
├── precopy.js                ← copia assets pro src-tauri/ antes do build
├── prepare-bundle.js         ← cria node_modules.zip + dist-bundle.zip + node-portable
├── copy-to-tauri.js          ← copia dist/ pro src-tauri/ (build ZERADO, sem dados)
├── copy-assets.js            ← copia public/ pro dist/ após tsc
├── patch-whatsapp-web.js     ← patch de compatibilidade (roda em postinstall)
│
├── src/
│   ├── bot.ts                ← entrypoint
│   ├── MarcioApp.ts          ← orquestrador (service locator)
│   ├── brain/
│   │   ├── MarcioBrain.ts   ← IA, memória, aliases, auto-resposta
│   │   ├── Memory.ts        ← memória permanente por chat
│   │   ├── Context.ts       ← contexto da conversa
│   │   ├── Retroactive.ts   ← backfill de histórico
│   │   ├── ProfileBook.ts    ← perfis de contatos
│   │   └── AudioTranscriber.ts ← transcrição via Gemini
│   ├── whatsapp/
│   │   └── WhatsAppClient.ts ← wrapper do whatsapp-web.js + cleanup Chromium
│   ├── control/
│   │   ├── ControlPanel.ts  ← servidor HTTP do painel
│   │   ├── ZipBundle.ts     ← ZIP reader/writer nativo
│   │   └── public/          ← HTML/CSS/JS do painel + setup wizard
│   ├── commands/
│   │   └── BasicCommands.ts ← !figurinha, /nome, /alias, !resumo, etc.
│   └── types/                ← declarações de tipo
│
├── src-tauri/                ← app desktop (Rust + Tauri 2)
│   ├── Cargo.toml
│   ├── tauri.conf.json       ← config do Tauri (windows, resources, updater)
│   ├── src/
│   │   ├── lib.rs            ← setup production env, spawn bot, updater
│   │   └── main.rs           ← entrypoint Tauri
│   ├── capabilities/         ← permissões (FS, shell, etc.)
│   ├── icons/                ← ícones do app
│   └── build.rs
│
├── data/                     ← estado runtime (NÃO commitado)
│   ├── ai-config.json        ← API key + modelo
│   ├── bot-config.json       ← nome + aliases customizados
│   ├── memories.json         ← memórias por chat
│   ├── directives.json       ← diretivas do bot
│   ├── system-prompt.txt     ← prompt do sistema
│   ├── ops.json              ← lista de operators
│   ├── banned.json           ← chats banidos
│   ├── chat-profiles.json    ← perfis de chat
│   ├── profile-book.json     ← perfis de contatos (ProfileBook)
│   ├── stickers-meta.json    ← metadados das figurinhas
│   ├── stickers-vault/       ← imagens das figurinhas
│   ├── decision-log.json     ← log de decisões do bot
│   ├── chat-settings.json    ← mute/IA por chat
│   ├── command-overrides.json ← overrides de comandos
│   ├── events.json           ← eventos agendados
│   └── changelog-state.json  ← última versão vista (modal "O que há de novo?")
│
└── .github/workflows/
    └── release.yml           ← CI: compila + publica release ao criar tag vX.Y.Z
```

---

## 🔒 Privacidade

- **Nenhum dado pessoal é hardcoded** no código (nomes, números, grupos)
- **A sessão do WhatsApp** (`.wwebjs_auth/`) **nunca** vai pro Git (está no `.gitignore`)
- **Os dados do bot** (`data/`) ficam só no PC do usuário (build ZERADO no CI)
- **API key do Gemini** fica só localmente em `data/ai-config.json`

---

## 📝 Changelog

Veja todas as novidades de cada versão no arquivo [`changelog.json`](./changelog.json) ou direto no painel (seção "Sobre" → "📋 O que há de novo?").

---

## 📄 Licença

Projeto privado. Uso restrito ao autor.

---

## 🔗 Links

- **Releases**: https://github.com/DezediasYann/marcio-app/releases
- **Issues**: https://github.com/DezediasYann/marcio-app/issues
- **Actions**: https://github.com/DezediasYann/marcio-app/actions
