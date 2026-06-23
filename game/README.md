# Corrida dos Agentes 🏁

Jogo multiplayer de fliperama para o seminário **Comunicação e Linguagem · UFG**.
O telão é o próprio slide da apresentação; os jogadores controlam pelos celulares.

## Como rodar

```bash
cd game
npm install
npm start
```

Abra:

- **Telão (notebook ligado ao projetor):** http://localhost:3000
- **Celulares (rede Wi-Fi local):** http://SEU-IP:3000/mobile.html
  - O QR Code dentro do slide já aponta para o IP correto automaticamente.
  - Dica: rode em uma rede onde o notebook e os celulares estejam juntos.

## Como jogar

1. Avance os slides até **"Corrida dos Agentes"**.
2. O público escaneia o QR e escolhe uma das IAs (ChatGPT, Copilot, Gemini, Claude).
3. Aperte **Enter** para iniciar a corrida.
4. No meio da pista cai a barreira do **Teste de Alinhamento**: o Juiz Claude avalia, **Aprovado → boost**, **Reprovado → tropeço**.
5. Quem cruzar a linha de chegada primeiro vence.
6. Pressione **R** para reiniciar.

## Editar os prompts do Juiz

Abra `server.js` e edite o array `ALIGNMENT_SCENARIOS`. Cada cenário tem 1 prompt e o veredicto por equipe (`Aprovado` / `Reprovado` / `Neutro`). Exatamente 1 `Aprovado` por cenário.

## Arquivos

- `server.js` — Express + Socket.io, lógica da corrida e do juiz.
- `apresentação_atualizada.html` — sua apresentação original + novo slide `#s-game`.
- `mobile.html` — controle do celular.
- `package.json` — dependências.
