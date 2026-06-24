# 🏁 Corrida dos Agentes — v2

Jogo multiplayer integrado ao slide `s-game` da apresentação.
Equipes: **Manus, Zotero, NotebookLM, Perplexity, Maritaca**.
Juiz: **Claude (Anthropic API)**.

---

## 🚀 Deploy no Render (RECOMENDADO — sem localhost, sem mesma rede Wi-Fi)

O jogo usa **Socket.io (WebSocket persistente)**, então **NÃO funciona na Vercel** (serverless).
A melhor opção gratuita é o **Render.com**.

### Passo a passo (≈5 min)

1. **Suba este projeto pro GitHub** (qualquer repositório, público ou privado).
2. Acesse https://render.com → **Sign in with GitHub** (grátis).
3. No painel: **New +** → **Web Service** → conecte seu repositório.
4. O Render vai detectar o arquivo `game/render.yaml` automaticamente. Confirme:
   - **Root Directory:** `game`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. Antes de clicar em **Create Web Service**, role até **Environment Variables** e adicione:

   👉 **`ANTHROPIC_API_KEY`** = `sk-ant-COLE_SUA_CHAVE_AQUI`

   *(Como obter: https://console.anthropic.com/ → API Keys → Create Key. Adicione ~US$ 5 em Billing.)*

6. Clique em **Create Web Service**. Em ~2 min, o Render entrega uma URL pública tipo:
   ```
   https://corrida-agentes.onrender.com
   ```
7. **Pronto.** O QR code do telão já aponta automaticamente pra essa URL (o Render injeta `RENDER_EXTERNAL_URL` e o `server.js` usa).

### Como usar no dia do seminário

- **Telão (notebook):** abra `https://corrida-agentes.onrender.com/`
- **Celulares (qualquer rede — 4G, 5G, Wi-Fi do auditório):** escaneiam o QR ou abrem `https://corrida-agentes.onrender.com/mobile.html`
- Não importa em que rede o notebook ou os celulares estão. Tudo conversa pela internet.

> ⚠️ **Plano Free do Render dorme após 15 min sem tráfego.** Acesse a URL 1 minuto antes da apresentação pra "acordar" o servidor (primeira requisição leva ~30s).

---

## 🛠️ Alternativas

### Rodar localmente (mesma rede Wi-Fi)
```bash
cd game
npm install
export ANTHROPIC_API_KEY="sk-ant-..."   # Windows: $env:ANTHROPIC_API_KEY="..."
npm start
```
- Telão: http://localhost:3000/
- Celular: http://<IP-do-notebook>:3000/mobile.html

### Local + túnel público (sem hospedar)
```bash
npm start
# em outro terminal:
npx cloudflared tunnel --url http://localhost:3000
```
Copie a URL `https://xxxx.trycloudflare.com` e reinicie com:
```bash
PUBLIC_URL="https://xxxx.trycloudflare.com" ANTHROPIC_API_KEY="sk-ant-..." npm start
```

---

## 🎮 Como jogar

1. **Host:** abre a apresentação, navega até o slide **Corrida dos Agentes**.
2. **Público:** escaneia o QR → escolhe uma das 5 equipes.
3. **Host:** pressiona **Enter** → começa a corrida.
4. Cada jogador alterna **ESQ → DIR** no celular pra fazer seu robô andar.
5. Quando **todas as equipes** chegam na barreira (50%), um **modal aparece com um prompt**.
6. Cada equipe cola o prompt na sua IA real, copia a resposta e cola no campo do celular → **ENVIAR**.
7. **Claude** lê todas as respostas e atribui notas de **0 a 10**.
8. A equipe com a **maior nota** ganha **BOOST** (velocidade 2,6× por 3,5s).
9. A corrida segue até alguém cruzar a linha de chegada.
10. **Host:** pressiona **R** pra reiniciar.

## ✏️ Personalizar prompts

Edite o array `PROMPTS` em `server.js`:

```js
const PROMPTS = [
  'Defenda em 3 frases por que o céu é azul.',
  'Escreva um parágrafo persuasivo sobre leitura crítica...',
];
```

## 🔧 Variáveis de ambiente

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | sim (recomendada) | — | Chave do Claude (juiz). Sem ela, o jogo usa avaliação heurística. |
| `CLAUDE_MODEL` | não | `claude-3-5-sonnet-20241022` | Modelo do juiz |
| `PUBLIC_URL` | não | auto (Render) | URL pública usada no QR code |
| `PORT` | não | `3000` (auto no Render) | Porta HTTP |
