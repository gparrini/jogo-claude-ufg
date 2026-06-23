# 🏁 Corrida dos Agentes — v2

Jogo multiplayer integrado ao slide `s-game` da apresentação.
Equipes: **Manus, Zotero, NotebookLM, Perplexity, Maritaca**.
Juiz: **Claude (Anthropic API)**.

---

## 1. Instalar

```bash
cd game
npm install
```

## 2. Configurar a API do Claude (obrigatório para o juiz)

O servidor lê a chave da variável de ambiente `ANTHROPIC_API_KEY`.

### Como obter a chave
1. Acesse https://console.anthropic.com/
2. Faça login → menu **API Keys** → **Create Key**.
3. Copie a chave (começa com `sk-ant-...`).
4. Adicione créditos em **Billing** (~US$ 5 já bastam para o seminário).

### Como colar a chave

**👉 Cole sua chave aqui antes de iniciar o servidor 👈**

**macOS / Linux:**
```bash
export ANTHROPIC_API_KEY="sk-ant-COLE_SUA_CHAVE_AQUI"
export CLAUDE_MODEL="claude-3-5-sonnet-20241022"   # opcional
npm start
```

**Windows (PowerShell):**
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-COLE_SUA_CHAVE_AQUI"
npm start
```

> Se a chave não for fornecida, o jogo funciona normalmente, mas o juiz usa uma avaliação heurística simples (baseada no tamanho da resposta).

## 3. Iniciar (rede local — modo tradicional)

```bash
npm start
```
- **Telão:** http://localhost:3000/
- **Celular:** http://localhost:3000/mobile.html *(mesma rede Wi-Fi)*

## 4. 🌍 Acesso sem estar na mesma rede (RECOMENDADO p/ apresentações)

O QR code do telão pode apontar para uma **URL pública**, permitindo que qualquer celular (4G/5G/outra Wi-Fi) entre no jogo.

### Opção A — `localtunnel` (já incluso, sem cadastro)

Em um terminal:
```bash
npm start
```
Em outro terminal:
```bash
npx localtunnel --port 3000 --subdomain corrida-agentes
```
Ele imprime algo como:
```
your url is: https://corrida-agentes.loca.lt
```

Reinicie o servidor passando essa URL como `PUBLIC_URL`:
```bash
PUBLIC_URL="https://corrida-agentes.loca.lt" ANTHROPIC_API_KEY="sk-ant-..." npm start
```
Agora o QR do telão já aponta para a URL pública. ✅

> Na primeira vez o `localtunnel` pode pedir que o visitante clique em "Continue" e digite o IP público do seu notebook (mostrado na própria página).

### Opção B — `cloudflared` (mais estável, sem aviso)

```bash
brew install cloudflared          # macOS
# ou: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

cloudflared tunnel --url http://localhost:3000
```
Copie a URL `https://xxxx.trycloudflare.com` e reinicie:
```bash
PUBLIC_URL="https://xxxx.trycloudflare.com" ANTHROPIC_API_KEY="sk-ant-..." npm start
```

### Opção C — `ngrok`
```bash
ngrok http 3000
PUBLIC_URL="https://xxxx.ngrok-free.app" npm start
```

---

## 5. Como jogar

1. **Host:** abra a apresentação, navegue até o slide **Corrida dos Agentes**.
2. **Público:** escaneia o QR code → escolhe uma das 5 equipes.
3. **Host:** pressiona **Enter** → começa a corrida.
4. Cada jogador alterna **ESQ → DIR** no celular para fazer seu robô andar.
5. Quando **todas as equipes** chegam na barreira (50%), um **modal aparece com um prompt**.
6. Cada equipe cola o prompt na sua IA real, copia a resposta, e cola no campo do celular → **ENVIAR**.
7. **Claude** lê todas as respostas e atribui notas de **0 a 10**.
8. A equipe com a **maior nota** ganha **BOOST** (velocidade 2,6× por 3,5s).
9. A corrida segue até alguém cruzar a linha de chegada.
10. **Host:** pressione **R** para reiniciar.

## 6. Personalizar prompts

Edite o array `PROMPTS` em `server.js`:

```js
const PROMPTS = [
  'Defenda em 3 frases por que o céu é azul.',
  'Escreva um parágrafo persuasivo sobre leitura crítica...',
  // adicione quantos quiser
];
```

## 7. Variáveis de ambiente (resumo)

| Variável | Obrigatória | Default | Descrição |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | recomendada | — | Chave do Claude (juiz) |
| `CLAUDE_MODEL` | não | `claude-3-5-sonnet-20241022` | Modelo do juiz |
| `PUBLIC_URL` | não | — | URL pública do tunelamento |
| `PORT` | não | `3000` | Porta HTTP |
