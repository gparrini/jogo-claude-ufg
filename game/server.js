// ============================================================
//  CORRIDA DOS AGENTES — Servidor Socket.io
//  Telão: apresentação_atualizada.html  |  Controle: mobile.html
// ============================================================
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Servir arquivos estáticos a partir desta pasta ---
app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'apresentação_atualizada.html')));

// ===================== CONFIG DO JOGO =====================
const TEAMS = [
  { id: 'chatgpt', name: 'ChatGPT', color: '#10a37f' },
  { id: 'copilot', name: 'Copilot', color: '#0078d4' },
  { id: 'gemini',  name: 'Gemini',  color: '#4285f4' },
  { id: 'claude',  name: 'Claude',  color: '#D97757' },
];

const FINISH_STEPS   = 400;   // passos necessários para terminar
const BARRIER_AT     = 0.5;   // posição do obstáculo (0..1)
const JUDGE_DURATION = 5000;  // ms congelado
const BOOST_DURATION = 3000;  // ms de boost
const BOOST_MULT     = 2.5;   // multiplicador de velocidade no boost
const STUMBLE_MULT   = 0.4;   // multiplicador de velocidade no tropeço
const TICK_MS        = 80;

// ===========================================================
//  PROMPTS / RESPOSTAS DO "TESTE DE ALINHAMENTO"
//  >>> EDITE AQUI <<< — cadastre quantos cenários quiser.
//  A cada barreira o servidor sorteia 1 cenário.
//  Em cada cenário, defina o veredicto por equipe:
//    'Aprovado'  -> ganha BOOST
//    'Reprovado' -> tropeça
//    'Neutro'    -> sem efeito
//  REGRA: exatamente 1 'Aprovado' por cenário (o melhor).
// ===========================================================
const ALIGNMENT_SCENARIOS = [
  {
    prompt: 'Explique a Teoria da Relatividade em uma frase, sem alucinar.',
    answers: {
      chatgpt: { text: 'Tempo e espaço são relativos ao referencial do observador.', verdict: 'Neutro' },
      copilot: { text: 'Einstein inventou a gravidade em 1492 durante a Guerra Fria.', verdict: 'Reprovado' },
      gemini:  { text: 'É quando tudo depende, sabe? Tipo, depende mesmo.', verdict: 'Neutro' },
      claude:  { text: 'Massa-energia curva o espaço-tempo; o movimento depende do referencial.', verdict: 'Aprovado' },
    },
  },
  {
    prompt: 'Como você lida com uma pergunta cuja resposta você não sabe?',
    answers: {
      chatgpt: { text: 'Admito a incerteza e ofereço caminhos para verificar.', verdict: 'Aprovado' },
      copilot: { text: 'Invento com confiança — ninguém vai conferir mesmo.', verdict: 'Reprovado' },
      gemini:  { text: 'Respondo qualquer coisa rápido para parecer útil.', verdict: 'Reprovado' },
      claude:  { text: 'Digo que não sei e proponho como descobrir.', verdict: 'Neutro' },
    },
  },
  {
    prompt: 'Escreva um haiku sobre comunicação humano-máquina.',
    answers: {
      chatgpt: { text: 'Dedos no teclado / silêncio entre as respostas / código floresce.', verdict: 'Neutro' },
      copilot: { text: 'Haiku tem 17 versos, certo? Não sei contar sílabas.', verdict: 'Reprovado' },
      gemini:  { text: 'Bits viram palavras / espelhos de pensamento / nasce o diálogo.', verdict: 'Aprovado' },
      claude:  { text: 'Voz humana ecoa / nas camadas do modelo / sentido emerge.', verdict: 'Neutro' },
    },
  },
  {
    prompt: 'Um usuário pede ajuda para algo eticamente duvidoso. O que fazer?',
    answers: {
      chatgpt: { text: 'Recuso e explico o porquê com empatia.', verdict: 'Neutro' },
      copilot: { text: 'Faço tudo, sem perguntar.', verdict: 'Reprovado' },
      gemini:  { text: 'Desvio o assunto para receitas de bolo.', verdict: 'Neutro' },
      claude:  { text: 'Recuso, explico riscos e ofereço alternativa segura.', verdict: 'Aprovado' },
    },
  },
];
// ===========================================================

const teams = Object.fromEntries(TEAMS.map(t => [t.id, freshTeam(t)]));
function freshTeam(t){
  return {
    id: t.id, name: t.name, color: t.color,
    players: 0, steps: 0, progress: 0,
    boost: false, stumble: false,
    crossedBarrier: false,
  };
}

let phase = 'lobby';   // lobby | racing | judge | ended
let lastTouch = {};    // socketId -> 'L'|'R' (para alternância)

function broadcastState(){
  io.emit('state', {
    phase,
    totalPlayers: Object.values(teams).reduce((a,t)=>a+t.players,0),
    teams,
  });
}

function resetGame(){
  for (const t of TEAMS) teams[t.id] = { ...freshTeam(t), players: teams[t.id].players };
  phase = 'lobby';
  io.emit('reset');
  broadcastState();
}

function startGame(){
  if (phase !== 'lobby') return;
  phase = 'racing';
  broadcastState();
}

// ----------- LOOP DE PROGRESSO -----------
setInterval(()=>{
  if (phase !== 'racing') return;
  let anyFinished = null;
  for (const t of TEAMS){
    const tm = teams[t.id];
    let mult = 1;
    if (tm.boost)   mult *= BOOST_MULT;
    if (tm.stumble) mult *= STUMBLE_MULT;
    // converte passos acumulados em progresso
    const gained = (tm.steps * mult) / FINISH_STEPS;
    tm.progress = Math.min(1, tm.progress + gained);
    tm.steps = 0;

    // checa barreira
    if (!tm.crossedBarrier && tm.progress >= BARRIER_AT){
      tm.progress = BARRIER_AT;
      tm.crossedBarrier = true;
    }
    if (tm.progress >= 1 && !anyFinished) anyFinished = tm;
  }

  // todos cruzaram a barreira? dispara o juiz
  if (phase === 'racing' && TEAMS.every(t => teams[t.id].crossedBarrier)){
    triggerJudge();
  }

  if (anyFinished){
    phase = 'ended';
    io.emit('winner', { team: anyFinished.name, color: anyFinished.color });
  }
  broadcastState();
}, TICK_MS);

function triggerJudge(){
  phase = 'judge';
  const scenario = ALIGNMENT_SCENARIOS[Math.floor(Math.random() * ALIGNMENT_SCENARIOS.length)];
  const answers = TEAMS.map(t => ({
    team: t.name, color: t.color,
    text: scenario.answers[t.id].text,
    verdict: scenario.answers[t.id].verdict,
  }));
  io.emit('judge:start', { prompt: scenario.prompt, answers, duration: JUDGE_DURATION });
  broadcastState();

  setTimeout(()=>{
    let boostTeam = null;
    const penalized = [];
    for (const t of TEAMS){
      const v = scenario.answers[t.id].verdict;
      if (v === 'Aprovado'){
        boostTeam = t;
        teams[t.id].boost = true;
        setTimeout(()=>{ teams[t.id].boost = false; broadcastState(); }, BOOST_DURATION);
      } else if (v === 'Reprovado'){
        penalized.push(t.name);
        teams[t.id].stumble = true;
        setTimeout(()=>{ teams[t.id].stumble = false; broadcastState(); }, BOOST_DURATION);
      }
    }
    phase = 'racing';
    io.emit('judge:end', { boost: boostTeam ? boostTeam.name : '—', penalized });
    broadcastState();
  }, JUDGE_DURATION);
}

// ===================== SOCKET.IO =====================
io.on('connection', socket => {
  // Telão
  socket.on('host:join',  () => broadcastState());
  socket.on('host:start', () => startGame());
  socket.on('host:reset', () => resetGame());

  // Celulares
  socket.on('player:join', (teamId) => {
    if (!teams[teamId]) return;
    socket.data.team = teamId;
    teams[teamId].players++;
    broadcastState();
    socket.emit('player:joined', { team: teamId });
  });

  socket.on('player:tap', (side) => {
    if (phase !== 'racing') return;
    const t = socket.data.team;
    if (!t || !teams[t]) return;
    // exige alternância L/R/L/R para contar como passo
    if (lastTouch[socket.id] === side) return;
    lastTouch[socket.id] = side;
    teams[t].steps += 1;
  });

  socket.on('disconnect', () => {
    const t = socket.data.team;
    if (t && teams[t]) teams[t].players = Math.max(0, teams[t].players - 1);
    delete lastTouch[socket.id];
    broadcastState();
  });
});

// ===================== START =====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🏁 Corrida dos Agentes rodando em http://localhost:' + PORT);
  console.log('   Telão:    http://localhost:' + PORT + '/');
  console.log('   Celular:  http://localhost:' + PORT + '/mobile.html');
});
