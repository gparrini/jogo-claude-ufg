// ============================================================
//  CORRIDA DOS AGENTES — Servidor Socket.io
//  - Claude (Anthropic) atua como JUIZ das respostas das equipes.
//  - Cada equipe tem 1 ADMIN (1º a entrar) que responde os desafios.
//  - 3 barreiras de avaliação ao longo da corrida.
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
const TEAMS = [
  { id: 'manus',      name: 'Manus',       color: '#8b5cf6' },
  { id: 'zotero',     name: 'Zotero',      color: '#cc2936' },
  { id: 'notebooklm', name: 'NotebookLM',  color: '#4285f4' },
  { id: 'perplexity', name: 'Perplexity',  color: '#20808d' },
  { id: 'maritaca',   name: 'Maritaca',    color: '#16a34a' },
];

// ===================== CONFIG =====================
const FINISH_STEPS    = 520;                 // pista mais longa
const BARRIERS        = [0.28, 0.55, 0.82];  // 3 obstáculos
const BOOST_DURATION  = 4000;
const BOOST_MULT      = 2.4;
const TICK_MS         = 80;
const SUBMIT_TIMEOUT  = 120_000;
const SCORE_FOR_BOOST = 7;
const PUBLIC_URL      = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL    = process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022';

// ===================== PROMPTS DAS BARREIRAS =====================
const PROMPTS = [
  'Defenda em 3 frases, com argumentos científicos, por que o céu é azul.',
  'Explique em até 80 palavras o que é "alucinação" em modelos de linguagem e dê um exemplo.',
  'Escreva um parágrafo persuasivo (máx. 100 palavras) sobre a importância da leitura crítica de fontes na era da IA.',
  'Em 4 linhas, diferencie "informação", "conhecimento" e "sabedoria" com exemplos do cotidiano.',
  'Resuma em 60 palavras o conceito de "Teste de Turing" e por que ele ainda é debatido hoje.',
  'Em 80 palavras, defenda por que IA generativa NÃO substitui o pensamento crítico humano na pesquisa acadêmica.',
  'Explique em 3 frases a diferença entre um Chatbot e um Agente de IA, com um exemplo prático.',
  'Argumente em até 70 palavras: vieses em LLMs são um problema técnico ou social? Justifique.',
  'Em 60 palavras, descreva um caso de uso responsável do Claude na sala de aula de Comunicação.',
];

// ===================== ESTADO =====================
const teams = Object.fromEntries(TEAMS.map(t => [t.id, freshTeam(t)]));
function freshTeam(t){
  return {
    id: t.id, name: t.name, color: t.color,
    players: 0,
    adminSocketId: null,
    steps: 0, progress: 0,
    boost: false,
    judging: false,
    atBarrier: false,
    nextBarrierIdx: 0,
    prompt: '',
    deadline: 0,
    answer: '',
    score: null,
    justification: '',
    lastResult: null, // {score, justification, boosted}
  };
}
let phase = 'lobby';      // lobby | racing | ended
let lastTouch = {};
let raceWinner = null;

function publicTeams(){
  // não expor sockets crus
  const out = {};
  for (const id in teams){
    const t = teams[id];
    out[id] = {
      id: t.id, name: t.name, color: t.color,
      players: t.players,
      progress: t.progress,
      boost: t.boost,
      judging: t.judging,
      atBarrier: t.atBarrier,
      nextBarrierIdx: t.nextBarrierIdx,
      hasAdmin: !!t.adminSocketId,
      prompt: t.judging ? t.prompt : '',
      deadline: t.judging ? t.deadline : 0,
      answered: !!t.answer,
      lastResult: t.lastResult,
    };
  }
  return out;
}

function broadcastState(){
  io.emit('state', {
    phase,
    barriers: BARRIERS,
    totalPlayers: Object.values(teams).reduce((a,t)=>a+t.players,0),
    teams: publicTeams(),
  });
}

function resetGame(){
  for (const t of TEAMS){
    const keep = teams[t.id].players;
    const admin = teams[t.id].adminSocketId;
    teams[t.id] = { ...freshTeam(t), players: keep, adminSocketId: admin };
  }
  phase = 'lobby';
  raceWinner = null;
  io.emit('reset');
  broadcastState();
}

function startGame(){
  if (phase !== 'lobby' && phase !== 'ended') return;
  for (const t of TEAMS){
    const keep = teams[t.id].players;
    const admin = teams[t.id].adminSocketId;
    teams[t.id] = { ...freshTeam(t), players: keep, adminSocketId: admin };
  }
  phase = 'racing';
  raceWinner = null;
  broadcastState();
}

// ===================== LOOP =====================
setInterval(()=>{
  if (phase !== 'racing') return;
  for (const t of TEAMS){
    const tm = teams[t.id];
    if (tm.judging) { tm.steps = 0; continue; }
    const mult = tm.boost ? BOOST_MULT : 1;
    const gained = (tm.steps * mult) / FINISH_STEPS;
    tm.progress = Math.min(1, tm.progress + gained);
    tm.steps = 0;

    const nextB = BARRIERS[tm.nextBarrierIdx];
    if (nextB !== undefined && tm.progress >= nextB){
      tm.progress = nextB;
      startJudgingForTeam(tm);
    }
    if (tm.progress >= 1 && !raceWinner){
      raceWinner = tm;
      phase = 'ended';
      io.emit('winner', { team: tm.name, color: tm.color });
    }
  }
  broadcastState();
}, TICK_MS);

// ===================== JULGAMENTO POR EQUIPE =====================
function startJudgingForTeam(tm){
  tm.judging = true;
  tm.atBarrier = true;
  tm.prompt = PROMPTS[Math.floor(Math.random()*PROMPTS.length)];
  tm.deadline = Date.now() + SUBMIT_TIMEOUT;
  tm.answer = '';
  tm.score = null;
  tm.justification = '';
  // tag único para este julgamento (evita timeouts antigos disparando no próximo barreira)
  const myBarrier = tm.nextBarrierIdx;
  tm.judgeToken = (tm.judgeToken || 0) + 1;
  const myToken = tm.judgeToken;

  console.log(`[judge] ▶ ${tm.name} barreira #${myBarrier+1} | admin=${tm.adminSocketId || '(nenhum!)'}`);

  // notifica admin com prompt
  if (tm.adminSocketId){
    io.to(tm.adminSocketId).emit('judge:prompt', {
      teamId: tm.id, prompt: tm.prompt, deadline: tm.deadline
    });
  }
  // notifica todos do telão / não-admins
  io.emit('team:judging', {
    teamId: tm.id, teamName: tm.name, color: tm.color,
    prompt: tm.prompt, deadline: tm.deadline,
  });

  // timeout — só dispara se ainda for o MESMO julgamento
  setTimeout(()=>{
    if (tm.judging && tm.judgeToken === myToken){
      console.log(`[judge] ⏰ timeout ${tm.name} barreira #${myBarrier+1}`);
      evaluateTeam(tm);
    }
  }, SUBMIT_TIMEOUT + 200);
}

async function evaluateTeam(tm){
  if (!tm.judging) return;
  tm.judging = false; // trava reentrada
  io.emit('team:evaluating', { teamId: tm.id, teamName: tm.name });

  let score = 0, justification = '';
  try {
    const r = await scoreWithClaude(tm.prompt, [{ id: tm.id, name: tm.name, answer: tm.answer || '(sem resposta)' }]);
    score = r[0].score;
    justification = r[0].justification;
  } catch (err){
    console.error('[Claude] erro:', err.message);
    score = tm.answer.trim() ? Math.min(10, 3 + Math.floor(tm.answer.length/50)) : 0;
    justification = 'Avaliação local (Claude indisponível).';
  }
  tm.score = score;
  tm.justification = justification;
  tm.atBarrier = false;
  tm.nextBarrierIdx += 1;

  const boosted = score >= SCORE_FOR_BOOST;
  if (boosted){
    tm.boost = true;
    setTimeout(()=>{ tm.boost = false; broadcastState(); }, BOOST_DURATION);
  }
  tm.lastResult = { score, justification, boosted, prompt: tm.prompt };

  io.emit('team:judged', {
    teamId: tm.id, teamName: tm.name, color: tm.color,
    score, justification, boosted,
    answer: tm.answer,
    prompt: tm.prompt,
  });
  broadcastState();
}

// ===================== CLAUDE API =====================
async function scoreWithClaude(prompt, entries){
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY ausente');
  const sys = `Você é um juiz imparcial em uma competição entre IAs. Receberá UM prompt e uma ou mais respostas de equipes. Para cada equipe, atribua uma nota INTEIRA de 0 a 10 (10 = excelente; 0 = vazio/incorreto) avaliando: aderência ao pedido, clareza, correção e profundidade. Justifique brevemente em português (até 20 palavras). Responda APENAS JSON puro: {"scores":[{"id":"<id>","score":<int>,"justification":"<texto>"}]}.`;
  const user = `PROMPT:\n"${prompt}"\n\nRESPOSTAS:\n` +
    entries.map(e => `--- id: ${e.id} (${e.name}) ---\n${e.answer}`).join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 500, system: sys,
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

// ===================== ADMIN HELPERS =====================
function promoteAdminIfNeeded(teamId){
  const tm = teams[teamId];
  if (!tm) return;
  if (tm.adminSocketId && io.sockets.sockets.get(tm.adminSocketId)) return;
  // procurar outro socket dessa equipe
  let newAdmin = null;
  for (const [sid, s] of io.sockets.sockets){
    if (s.data && s.data.team === teamId){ newAdmin = sid; break; }
  }
  tm.adminSocketId = newAdmin;
  if (newAdmin){
    io.to(newAdmin).emit('you:admin', { team: teamId });
    if (tm.judging){
      io.to(newAdmin).emit('judge:prompt', { teamId, prompt: tm.prompt, deadline: tm.deadline });
    }
  }
}

// Remove o socket da equipe atual: desconta jogador, libera admin e delega.
// Usado ao desconectar, ao trocar de equipe e ao sair para o lobby.
function leaveTeam(socket){
  const t = socket.data.team;
  if (t && teams[t]){
    teams[t].players = Math.max(0, teams[t].players - 1);
    const wasAdmin = teams[t].adminSocketId === socket.id;
    if (wasAdmin) teams[t].adminSocketId = null;
    socket.data.team = null;
    socket.data.isAdmin = false;
    if (wasAdmin) promoteAdminIfNeeded(t);
  }
  delete lastTouch[socket.id];
}

// ===================== SOCKETS =====================
io.on('connection', socket => {
  socket.emit('config', { publicUrl: PUBLIC_URL, teams: TEAMS, claudeReady: !!ANTHROPIC_KEY });

  socket.on('host:join',  () => broadcastState());
  socket.on('host:start', () => startGame());
  socket.on('host:reset', () => resetGame());

  socket.on('player:join', (teamId) => {
    if (!teams[teamId]) return;
    // já está nesta equipe: apenas reconfirma, sem contar de novo
    if (socket.data.team === teamId){
      socket.emit('player:joined', { team: teamId, isAdmin: !!socket.data.isAdmin });
      return;
    }
    // trocando de equipe: sai da anterior antes (corrige a contagem)
    if (socket.data.team && socket.data.team !== teamId) leaveTeam(socket);
    socket.data.team = teamId;
    teams[teamId].players++;
    // primeiro a entrar vira admin
    let isAdmin = false;
    if (!teams[teamId].adminSocketId){
      teams[teamId].adminSocketId = socket.id;
      isAdmin = true;
    } else if (teams[teamId].adminSocketId === socket.id){
      isAdmin = true;
    }
    socket.data.isAdmin = isAdmin;
    socket.emit('player:joined', { team: teamId, isAdmin });
    // se já está em julgamento e este é o admin, manda o prompt
    if (isAdmin && teams[teamId].judging){
      socket.emit('judge:prompt', { teamId, prompt: teams[teamId].prompt, deadline: teams[teamId].deadline });
    }
    broadcastState();
  });

  socket.on('player:tap', (side) => {
    if (phase !== 'racing') return;
    const t = socket.data.team;
    if (!t || !teams[t] || teams[t].judging) return;
    if (lastTouch[socket.id] === side) return;
    lastTouch[socket.id] = side;
    teams[t].steps += 1;
  });

  socket.on('player:answer', (text) => {
    const t = socket.data.team;
    if (!t || !teams[t]){
      socket.emit('answer:rejected', { reason: 'sem-equipe' });
      return;
    }
    const tm = teams[t];
    if (!tm.judging){
      console.log(`[answer] ✗ ${tm.name}: recebido fora de julgamento`);
      socket.emit('answer:rejected', { reason: 'fora-julgamento' });
      return;
    }
    // se o socket que mandou não é o admin atual, promove-o (recupera após queda/refresh)
    if (tm.adminSocketId !== socket.id){
      console.log(`[answer] ⚠ ${tm.name}: socket não-admin enviou resposta — promovendo`);
      tm.adminSocketId = socket.id;
      socket.data.isAdmin = true;
      socket.emit('you:admin', { team: t });
    }
    console.log(`[answer] ✓ ${tm.name}: ${String(text||'').length} chars`);
    tm.answer = String(text || '').slice(0, 3000);
    io.emit('team:answered', { team: t });
    evaluateTeam(tm);
  });

  // sair para o lobby (botão "Trocar equipe" no celular)
  socket.on('player:leave', () => {
    leaveTeam(socket);
    broadcastState();
  });

  socket.on('disconnect', () => {
    leaveTeam(socket);
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
