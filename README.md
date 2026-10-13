# Márcio App

Bot de WhatsApp com IA generativa, memória, figurinhas e painel de controle.

## O que o app faz

- ✅ Bot conversa no WhatsApp usando Google Gemini (com fallback)
- ✅ Conecta no WhatsApp (reaproveitando sessão existente)
- ✅ Memória permanente, figurinhas, comandos, painel web
- ✅ Estrutura OOP pronta (24 classes, ~13000 linhas)
- ❌ Não responde mensagens (Fase 2)
- ❌ Não tem comandos (Fase 3)
- ❌ Não tem IA/memória (Fase 2)

## Como rodar no seu PC (VS Code)

### 1. Pré-requisitos

- **Node.js 22+** (`node --version`)
- **Bun** (opcional, mas recomendado pra install rápido) — `npm i -g bun`
- **Chromium/Chrome** instalado (Puppeteer usa)

### 2. Instalar dependências

Abra o terminal **na pasta `marcio-app/`** e rode:

```bash
# Com npm:
npm install

# Ou com bun (mais rápido):
bun install
```

> ⚠️ Se o Puppeteer reclamar que não acha o Chromium, rode:
> ```bash
> npx puppeteer browsers install chrome
> ```
> (ou `bunx puppeteer browsers install chrome` se usar bun)

### 3. Configurar o auth do WhatsApp (IMPORTANTE)

Para **NÃO re-escanear o QR code**, o Márcio App precisa reaproveitar a
sessão do bot velho. Tem 3 opções:

#### Opção A — Apontar pro `.wwebjs_auth` do bot velho (recomendada)

Edite `src/bot.ts`, descomente a linha `legacyAuthPath` e troque o caminho
pro do seu PC:

```ts
legacyAuthPath: path.resolve('C:/Users/SEU_USER/caminho/pro/marcio-bot-old/.wwebjs_auth'),
```

#### Opção B — Copiar `.wwebjs_auth/` pra dentro do marcio-app

```bash
# No terminal:
cp -r ../marcio-bot-old/.wwebjs_auth .
```

Deixe `legacyAuthPath: undefined` no `bot.ts`.

#### Opção C — Sessão nova (primeira vez)

Deixe `legacyAuthPath: undefined` e escaneie o QR que aparecer no terminal.

> ⚠️ **NUNCA rode o bot velho e o novo ao mesmo tempo** — conflito de
> sessão do WhatsApp. Desligue um antes de ligar o outro.

### 4. Rodar

```bash
# Dev (hot reload — recomendação pra iterar):
npm run dev

# Ou sem hot reload:
npm start
```

### 5. Verificar se funcionou

Você deve ver no terminal:

```
[2025-01-15 ...] [BOOT] Márcio App iniciando — rootDir=...
[2025-01-15 ...] [BOOT] Auth path=...
[2025-01-15 ...] [WA] Construindo WhatsAppClient...
[2025-01-15 ...] [WA] Inicializando client do WhatsApp...
[2025-01-15 ...] [WA] Carregando: 0% — ...
# (se primeira vez: QR code aqui)
[2025-01-15 ...] [WA] ✅ WhatsApp pronto! Conectado como: 55XXX@c.us
```

Mande uma mensagem qualquer no PV do bot (ou num grupo onde ele tá). Você
deve ver:

```
[14:30:22] [DEBUG MSG] recebida: 55XXX@c.us: oi
```

### 6. Typecheck (validação)

```bash
npm run typecheck
```

Deve passar sem erros. Se tiver erro, me manda o output.

## Estrutura

```
marcio-app/
├── package.json          ← deps + scripts (dev/start/build/typecheck)
├── tsconfig.json         ← config TS (strict: false por enquanto)
├── .gitignore
├── README.md             ← este arquivo
│
├── src/
│   ├── bot.ts            ← entrypoint (new MarcioApp().start())
│   ├── MarcioApp.ts      ← orquestrador (service locator) + log/debug
│   ├── whatsapp/
│   │   └── WhatsAppClient.ts  ← wrapper do Client + eventos
│   ├── brain/            ← vazio (Fase 2)
│   ├── commands/         ← vazio (Fase 3)
│   ├── permissions/      ← vazio (Fase 3)
│   ├── stickers/         ← vazio (Fase 3)
│   ├── twitter/          ← vazio (Fase 3)
│   └── types/
│       └── whatsapp-web.js.d.ts  ← declarações de tipo mínimas
│
├── data/                 ← configs + JSONs de estado (copiados do old)
│   ├── ai-config.json
│   ├── system-prompt.txt
│   ├── twitter-config.json
│   ├── memories.json
│   ├── chat-profiles.json
│   ├── decision-log.json
│   ├── ops.json
│   ├── banned.json
│   ├── directives.json
│   ├── stickers-meta.json
│   └── stickers-vault/   ← figurinhas
│
└── logs/                 ← bot.log (criado automaticamente)
```

## Próximos passos

Quando a Fase 1 estiver verde (bot conecta e loga msgs), me avisa e
vamos pra **Fase 2**: migrar o cérebro do Márcio (Context, Memory,
Profile, Brain) do `index.js` velho pro `src/brain/`.
