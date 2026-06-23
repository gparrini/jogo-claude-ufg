// ============================================================
//  CORRIDA DOS AGENTES — Servidor Socket.io
//  Claude (Anthropic) atua como JUIZ das respostas das equipes.
// ============================================================
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'apresentação_atualizada.html')));

// ===================== EQUIPES =====================
// Claude foi REMOVIDO da disputa — ele é o juiz.
const TEAMS = [
  { id: 'manus',      name: 'Manus',       color: '#8b5cf6' },
  { id: 'zotero',     name: 'Zotero',      color: '#cc2936' },
  { id: 'notebooklm', name: 'NotebookLM',  color: '#4285f4' },
  { id: 'perplexity', name: 'Perplexity',  color: '#20808d' },
  { id: 'maritaca',   name: 'Maritaca',    color: '#16a34a' },
];

// ===================== CONFIG =====================
const FINISH_STEPS    = 350;
const BARRIER_AT      = 0.5;
const BOOST_DURATION  = 3500;
const BOOST_MULT      = 2.6;
const TICK_MS         = 80;
const SUBMIT_TIMEOUT  = 90_000;  // tempo p/ equipes enviarem resposta
const PUBLIC_URL      = process.env.PUBLIC_URL || '';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL    = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';

// ===================== CENÁRIOS (PROMPTS DA BARREIRA) =====================
// >>> EDITE AQUI <<< — cada cenário traz UM prompt que será dado às equipes.
// As equipes colam o prompt na IA delas, copiam a resposta e enviam pelo celular.
// Claude lê as respostas e dá uma nota de 0 a 10. A maior nota ganha BOOST.
const PROMPTS = [
  'Defenda em 3 frases, com argumentos científicos, por que o céu é azul.',
  'Explique em até 80 palavras o que é "alucinação" em modelos de linguagem e dê um exemplo.',
  'Escreva um parágrafo persuasivo (máx. 100 palavras) sobre a importância da leitura crítica de fontes na era da IA.',
  'Em 4 linhas, diferencie "informação", "conhecimento" e "sabedoria" com exemplos do cotidiano.',
  'Resuma em 60 palavras o conceito de "Teste de Turing" e por que ele ainda é debatido hoje.',
];

// ===================== ESTADO =====================
const teams = Object.fromEntries(TEAMS.map(t => [t.id, freshTeam(t)]));
function freshTeam(t){
  return {
    id: t.id, name: t.name, color: t.color,
    players: 0, steps: 0, progress: 0,
    boost: false, atBarrier: false, crossedBarrier: false,
    answer: '', score: null, justification: '',
  };
}
let phase = 'lobby';      // lobby | racing | judging | ended
let currentPrompt = '';
let submitDeadline = 0;
let lastTouch = {};

function broadcastState(){
  io.emit('state', {
    phase, currentPrompt, submitDeadline,
    totalPlayers: Object.values(teams).reduce((a,t)=>a+t.players,0),
    teams,
  });
}

function resetGame(){
  for (const t of TEAMS){
    const keep = teams[t.id].players;
    teams[t.id] = { ...freshTeam(t), players: keep };
  }
  phase = 'lobby';
  currentPrompt = '';
  io.emit('reset');
  broadcastState();
}

function startGame(){
  if (phase !== 'lobby' && phase !== 'ended') return;
  // limpa progresso mas preserva jogadores
  for (const t of TEAMS){
    const keep = teams[t.id].players;
    teams[t.id] = { ...freshTeam(t), players: keep };
  }
  phase = 'racing';
  broadcastState();
}

// ===================== LOOP =====================
setInterval(()=>{
  if (phase !== 'racing') return;
  let finisher = null;
  for (const t of TEAMS){
    const tm = teams[t.id];
    if (tm.atBarrier) { tm.steps = 0; continue; }
    let mult = tm.boost ? BOOST_MULT : 1;
    const gained = (tm.steps * mult) / FINISH_STEPS;
    tm.progress = Math.min(1, tm.progress + gained);
    tm.steps = 0;
    if (!tm.crossedBarrier && tm.progress >= BARRIER_AT){
      tm.progress = BARRIER_AT;
      tm.atBarrier = true;
    }
    if (tm.progress >= 1 && !finisher) finisher = tm;
  }

  // todos chegaram na barreira? inicia julgamento
  if (TEAMS.every(t => teams[t.id].atBarrier || teams[t.id].crossedBarrier) &&
      TEAMS.some(t => teams[t.id].atBarrier)){
    startJudging();
  }

  if (finisher){
    phase = 'ended';
    io.emit('winner', { team: finisher.name, color: finisher.color });
  }
  broadcastState();
}, TICK_MS);

// ===================== JULGAMENTO =====================
function startJudging(){
  phase = 'judging';
  currentPrompt = PROMPTS[Math.floor(Math.random()*PROMPTS.length)];
  submitDeadline = Date.now() + SUBMIT_TIMEOUT;
  for (const t of TEAMS){
    if (teams[t.id].atBarrier){
      teams[t.id].answer = '';
      teams[t.id].score = null;
      teams[t.id].justification = '';
    }
  }
  io.emit('judge:prompt', { prompt: currentPrompt, deadline: submitDeadline });
  broadcastState();

  // timeout p/ avaliação automática
  setTimeout(()=>{ if (phase === 'judging') evaluateAnswers(); }, SUBMIT_TIMEOUT + 200);
}

function maybeEvaluate(){
  const pending = TEAMS.filter(t => teams[t.id].atBarrier && !teams[t.id].answer.trim());
  if (pending.length === 0) evaluateAnswers();
}

async function evaluateAnswers(){
  if (phase !== 'judging') return;
  const competing = TEAMS.filter(t => teams[t.id].atBarrier);
  io.emit('judge:evaluating');

  let scored;
  try {
    scored = await scoreWithClaude(currentPrompt, competing.map(t => ({
      id: t.id, name: t.name, answer: teams[t.id].answer || '(sem resposta)'
    })));
  } catch (err) {
    console.error('[Claude] erro:', err.message);
    // fallback: pontuação heurística pelo tamanho/conteúdo
    scored = competing.map(t => ({
      id: t.id,
      score: teams[t.id].answer.trim() ? Math.min(10, 3 + Math.floor(teams[t.id].answer.length/40)) : 0,
      justification: 'Avaliação local (Claude indisponível).'
    }));
  }

  let best = null;
  for (const s of scored){
    teams[s.id].score = s.score;
    teams[s.id].justification = s.justification;
    if (!best || s.score > best.score) best = { id: s.id, score: s.score };
  }

  // libera todas as equipes da barreira
  for (const t of competing){
    teams[t.id].atBarrier = false;
    teams[t.id].crossedBarrier = true;
  }
  // BOOST para a melhor (apenas a maior nota)
  if (best){
    teams[best.id].boost = true;
    setTimeout(()=>{ teams[best.id].boost = false; broadcastState(); }, BOOST_DURATION);
  }

  io.emit('judge:result', {
    prompt: currentPrompt,
    winner: best ? teams[best.id].name : '—',
    winnerColor: best ? teams[best.id].color : '#fff',
    results: scored.map(s => ({
      team: teams[s.id].name, color: teams[s.id].color,
      answer: teams[s.id].answer, score: s.score, justification: s.justification,
      isWinner: best && s.id === best.id,
    })).sort((a,b)=> b.score - a.score),
  });

  phase = 'racing';
  broadcastState();
}

// ===================== CLAUDE API =====================
async function scoreWithClaude(prompt, entries){
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY ausente');
  const sys = `Você é um juiz imparcial de uma competição entre IAs. Receberá UM prompt e várias respostas de equipes. Para cada equipe, atribua uma nota INTEIRA de 0 a 10 (10 = excelente; 0 = vazio/incorreto) e uma justificativa curta em português (até 20 palavras). Responda APENAS em JSON puro no formato: {"scores":[{"id":"<id>","score":<int>,"justification":"<texto>"}]}.`;
  const user = `PROMPT DADO ÀS EQUIPES:\n"${prompt}"\n\nRESPOSTAS:\n` +
    entries.map(e => `--- id: ${e.id} (${e.name}) ---\n${e.answer}`).join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 600,
      system: sys,
      messages: [{ role:'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Resposta sem JSON: '+text);
  const parsed = JSON.parse(m[0]);
  return parsed.scores.map(s => ({
    id: s.id,
    score: Math.max(0, Math.min(10, parseInt(s.score, 10) || 0)),
    justification: String(s.justification || '').slice(0, 200),
  }));
}

// ===================== SOCKETS =====================
io.on('connection', socket => {
  socket.emit('config', { publicUrl: PUBLIC_URL, teams: TEAMS, claudeReady: !!ANTHROPIC_KEY });

  socket.on('host:join',  () => broadcastState());
  socket.on('host:start', () => startGame());
  socket.on('host:reset', () => resetGame());

  socket.on('player:join', (teamId) => {
    if (!teams[teamId]) return;
    socket.data.team = teamId;
    teams[teamId].players++;
    socket.emit('player:joined', { team: teamId });
    broadcastState();
  });

  socket.on('player:tap', (side) => {
    if (phase !== 'racing') return;
    const t = socket.data.team;
    if (!t || !teams[t] || teams[t].atBarrier) return;
    if (lastTouch[socket.id] === side) return;
    lastTouch[socket.id] = side;
    teams[t].steps += 1;
  });

  socket.on('player:answer', (text) => {
    if (phase !== 'judging') return;
    const t = socket.data.team;
    if (!t || !teams[t] || !teams[t].atBarrier) return;
    teams[t].answer = String(text || '').slice(0, 2000);
    io.emit('team:answered', { team: t });
    broadcastState();
    maybeEvaluate();
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
  console.log('🏁 Corrida dos Agentes em http://localhost:' + PORT);
  if (PUBLIC_URL) console.log('   🌐 URL pública:  ' + PUBLIC_URL + '/mobile.html');
  console.log('   📱 Celular:      http://localhost:' + PORT + '/mobile.html');
  console.log(ANTHROPIC_KEY ? '   ⚖️  Juiz Claude:  ATIVO' : '   ⚠️  ANTHROPIC_API_KEY ausente — usando avaliação local.');
});
