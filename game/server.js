// ============================================================
//  CORRIDA DOS AGENTES — Servidor Socket.io
//  - Claude (Anthropic) atua como JUIZ das respostas das equipes.
//  - Cada equipe tem 1 ADMIN (1º a entrar) que responde os desafios.
//  - 3 barreiras de avaliação ao longo da corrida.
// ============================================================
const path = require('path');
const http = require('http');
const os   = require('os');
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
// Janela de tolerância pra reconexão (ex.: admin saiu pra colar o prompt na
// IA em outro app e o navegador/SO suspendeu a aba, derrubando o socket).
// Enquanto essa janela não expira, o lugar (e o cargo de ADMIN, se for o caso)
// fica reservado pra essa mesma pessoa — ninguém é promovido no lugar dela.
const DISCONNECT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS || '90000', 10);
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY || '';
const CLAUDE_MODEL    = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

// ---------- Auto-detect IP local (caso PUBLIC_URL não esteja setado) ----------
function detectLocalIp(){
  const nets = os.networkInterfaces();
  const ordered = Object.keys(nets).sort((a,b)=>{
    const pri = n => /wlan|wi-?fi|wlp|en0|eth|enp/i.test(n) ? 0 : 1;
    return pri(a) - pri(b);
  });
  for (const name of ordered){
    for (const n of nets[name] || []){
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}
const PORT = parseInt(process.env.PORT || '3000', 10);
const LOCAL_IP = detectLocalIp();
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (LOCAL_IP ? `http://${LOCAL_IP}:${PORT}` : '')).replace(/\/+$/,'');

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
    adminPlayerId: null, // identidade persistente do admin (sobrevive a reconexões)
    steps: 0, progress: 0,
    boost: false,
    judging: false,
    evaluating: false,
    atBarrier: false,
    nextBarrierIdx: 0,
    prompt: '',
    deadline: 0,
    answer: '',
    score: null,
    justification: '',
    lastResult: null, // {score, justification, boosted}
    judgeToken: 0,
  };
}
let phase = 'lobby';      // lobby | racing | ended
let lastTouch = {};
let raceWinner = null;
let judgeHistory = [];    // [{ id, teamId, teamName, color, barrierIdx, prompt, answer, score, justification, boosted, at }]

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
      evaluating: t.evaluating,
      atBarrier: t.atBarrier,
      nextBarrierIdx: t.nextBarrierIdx,
      hasAdmin: !!t.adminPlayerId,
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
    history: judgeHistory,
  });
}

function resetGame(){
  for (const t of TEAMS){
    const keep = teams[t.id].players;
    const admin = teams[t.id].adminSocketId;
    const adminPid = teams[t.id].adminPlayerId;
    teams[t.id] = { ...freshTeam(t), players: keep, adminSocketId: admin, adminPlayerId: adminPid };
  }
  phase = 'lobby';
  raceWinner = null;
  judgeHistory = [];
  io.emit('reset');
  broadcastState();
}

function startGame(){
  if (phase !== 'lobby' && phase !== 'ended') return;
  for (const t of TEAMS){
    const keep = teams[t.id].players;
    const admin = teams[t.id].adminSocketId;
    const adminPid = teams[t.id].adminPlayerId;
    teams[t.id] = { ...freshTeam(t), players: keep, adminSocketId: admin, adminPlayerId: adminPid };
  }
  phase = 'racing';
  raceWinner = null;
  judgeHistory = [];
  broadcastState();
}

// ===================== LOOP =====================
setInterval(()=>{
  if (phase !== 'racing') return;
  for (const t of TEAMS){
    const tm = teams[t.id];
    // Durante barreira/avaliação, a equipe fica travada na posição atual.
    // Importante: "evaluating" impede o loop de abrir uma nova barreira
    // enquanto a resposta ainda está sendo pontuada pelo Claude/fallback.
    if (tm.judging || tm.evaluating) { tm.steps = 0; continue; }
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
      teamId: tm.id, prompt: tm.prompt, deadline: tm.deadline,
      barrierIdx: myBarrier, judgeToken: myToken,
    });
  }
  // notifica todos do telão / não-admins
  io.emit('team:judging', {
    teamId: tm.id, teamName: tm.name, color: tm.color,
    prompt: tm.prompt, deadline: tm.deadline,
    barrierIdx: myBarrier, judgeToken: myToken,
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
  const barrierIdx = tm.nextBarrierIdx;
  const judgeToken = tm.judgeToken;
  const prompt = tm.prompt;
  const answer = tm.answer;
  tm.judging = false; // fecha a tela de resposta
  tm.evaluating = true; // trava reentrada no loop até a nota sair
  tm.nextBarrierIdx += 1; // já consome esta barreira para nunca reabrir o mesmo prompt
  // Força o admin a sair imediatamente da tela de juiz (não espera Claude)
  if (tm.adminSocketId) io.to(tm.adminSocketId).emit('judge:close', { teamId: tm.id, barrierIdx, judgeToken });
  io.emit('team:evaluating', { teamId: tm.id, teamName: tm.name, barrierIdx, judgeToken });


  let score = 0, justification = '';
  try {
    const r = await scoreWithClaude(prompt, [{ id: tm.id, name: tm.name, answer: answer || '(sem resposta)' }]);
    score = r[0].score;
    justification = r[0].justification;
  } catch (err){
    console.error('[Claude] erro:', err.message);
    score = answer.trim() ? Math.min(10, 3 + Math.floor(answer.length/50)) : 0;
    justification = 'Avaliação local (Claude indisponível).';
  }
  tm.evaluating = false;
  tm.score = score;
  tm.justification = justification;
  tm.atBarrier = false;

  const boosted = score >= SCORE_FOR_BOOST;
  if (boosted){
    tm.boost = true;
    setTimeout(()=>{ tm.boost = false; broadcastState(); }, BOOST_DURATION);
  }
  tm.lastResult = { score, justification, boosted, prompt };

  const entry = {
    id: `${tm.id}-${barrierIdx}-${Date.now()}`,
    teamId: tm.id, teamName: tm.name, color: tm.color,
    barrierIdx,
    prompt,
    answer,
    score, justification, boosted,
    at: Date.now(),
  };
  judgeHistory.push(entry);

  io.emit('team:judged', {
    teamId: tm.id, teamName: tm.name, color: tm.color,
    score, justification, boosted,
    answer,
    prompt,
    barrierIdx,
    judgeToken,
    entryId: entry.id,
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
const pendingLeaves = new Map(); // playerId -> { timeout, teamId }

// Só promove um novo admin quando NÃO há mais ninguém "reservando" o cargo
// (ou seja, o admin anterior realmente foi embora e a janela de tolerância
// já expirou — ver handleSocketDrop).
function promoteAdminIfNeeded(teamId){
  const tm = teams[teamId];
  if (!tm) return;
  if (tm.adminPlayerId) return; // lugar ainda reservado (mesmo que offline)
  // procurar outro socket conectado dessa equipe
  let newAdmin = null;
  for (const [, s] of io.sockets.sockets){
    if (s.data && s.data.team === teamId){ newAdmin = s; break; }
  }
  if (!newAdmin){ tm.adminSocketId = null; return; }
  tm.adminSocketId = newAdmin.id;
  tm.adminPlayerId = newAdmin.data.playerId || null;
  newAdmin.data.isAdmin = true;
  io.to(newAdmin.id).emit('you:admin', { team: teamId });
  if (tm.judging && !tm.answer){
    io.to(newAdmin.id).emit('judge:prompt', {
      teamId, prompt: tm.prompt, deadline: tm.deadline,
      barrierIdx: tm.nextBarrierIdx, judgeToken: tm.judgeToken,
    });
  }
}

// Remove o socket da equipe AGORA: desconta jogador, libera admin e delega.
// Usado para saída INTENCIONAL — trocar de equipe ou apertar "sair pro lobby".
// Não tem tolerância porque o próprio usuário pediu pra saída.
function leaveTeam(socket){
  const t = socket.data.team;
  const pid = socket.data.playerId;
  if (pid && pendingLeaves.has(pid)){
    clearTimeout(pendingLeaves.get(pid).timeout);
    pendingLeaves.delete(pid);
  }
  if (t && teams[t]){
    teams[t].players = Math.max(0, teams[t].players - 1);
    const wasAdmin = teams[t].adminSocketId === socket.id || (pid && teams[t].adminPlayerId === pid);
    if (wasAdmin){ teams[t].adminSocketId = null; teams[t].adminPlayerId = null; }
    socket.data.team = null;
    socket.data.isAdmin = false;
    if (wasAdmin) promoteAdminIfNeeded(t);
  }
  delete lastTouch[socket.id];
}

// O socket CAIU (refresh, perda de sinal, app foi pra background e o SO/
// navegador suspendeu a aba — exatamente o que acontece quando alguém troca
// de app pra colar o prompt na IA). Em vez de já tirar a pessoa da equipe e
// passar o cargo de admin pra outro alguém, damos uma janela de tolerância
// (DISCONNECT_GRACE_MS). Se a mesma pessoa (mesmo playerId) reconectar dentro
// desse prazo, ela recupera o lugar e o cargo de admin normalmente. Só depois
// que o prazo expira sem ela voltar é que o lugar é liberado de fato.
function handleSocketDrop(socket){
  const t = socket.data.team;
  const pid = socket.data.playerId;
  delete lastTouch[socket.id];
  if (!t || !teams[t]) return;

  const tm = teams[t];
  // Tira o socket "ao vivo" do admin (ninguém pode mandar mensagem pra um
  // socket morto), mas NÃO libera adminPlayerId — o lugar continua reservado.
  if (tm.adminSocketId === socket.id) tm.adminSocketId = null;

  if (!pid){
    // Cliente antigo, sem identidade persistente — não há como saber se ele
    // volta, então cai pro comportamento direto (sai já).
    leaveTeam(socket);
    broadcastState();
    return;
  }

  const prev = pendingLeaves.get(pid);
  if (prev) clearTimeout(prev.timeout);

  const timeout = setTimeout(()=>{
    pendingLeaves.delete(pid);
    const tm2 = teams[t];
    if (!tm2) return;
    tm2.players = Math.max(0, tm2.players - 1);
    if (tm2.adminPlayerId === pid){
      tm2.adminPlayerId = null;
      promoteAdminIfNeeded(t);
    }
    broadcastState();
  }, DISCONNECT_GRACE_MS);

  pendingLeaves.set(pid, { timeout, teamId: t });
  broadcastState();
}

// ===================== SOCKETS =====================
io.on('connection', socket => {
  socket.emit('config', { publicUrl: PUBLIC_URL, teams: TEAMS, claudeReady: !!ANTHROPIC_KEY });

  socket.on('host:join',  () => broadcastState());
  socket.on('host:start', () => startGame());
  socket.on('host:reset', () => resetGame());

  socket.on('player:join', (payload) => {
    const teamId = (payload && typeof payload === 'object') ? payload.team : payload;
    const playerId = (payload && typeof payload === 'object' && payload.playerId)
      ? String(payload.playerId).slice(0, 64) : null;
    if (!teams[teamId]) return;
    if (playerId) socket.data.playerId = playerId;

    // Reconectando dentro da janela de tolerância (ex.: voltou de consultar a
    // IA em outro app): recupera o lugar e, se era admin, recupera o cargo —
    // sem contar jogador a mais nem perder o cargo pra outra pessoa.
    const pending = playerId ? pendingLeaves.get(playerId) : null;
    if (pending && pending.teamId === teamId){
      clearTimeout(pending.timeout);
      pendingLeaves.delete(playerId);
      socket.data.team = teamId;
      const tm = teams[teamId];
      const isAdmin = tm.adminPlayerId === playerId;
      if (isAdmin) tm.adminSocketId = socket.id;
      socket.data.isAdmin = isAdmin;
      socket.emit('player:joined', { team: teamId, isAdmin });
      if (isAdmin && tm.judging && !tm.answer){
        socket.emit('judge:prompt', {
          teamId, prompt: tm.prompt, deadline: tm.deadline,
          barrierIdx: tm.nextBarrierIdx, judgeToken: tm.judgeToken,
        });
      }
      broadcastState();
      return;
    }

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
    if (!teams[teamId].adminPlayerId){
      teams[teamId].adminSocketId = socket.id;
      teams[teamId].adminPlayerId = playerId;
      isAdmin = true;
    } else if (playerId && teams[teamId].adminPlayerId === playerId){
      teams[teamId].adminSocketId = socket.id;
      isAdmin = true;
    }
    socket.data.isAdmin = isAdmin;
    socket.emit('player:joined', { team: teamId, isAdmin });
    // se já está em julgamento, este é o admin e a equipe ainda não respondeu, manda o prompt
    if (isAdmin && teams[teamId].judging && !teams[teamId].answer){
      socket.emit('judge:prompt', {
        teamId, prompt: teams[teamId].prompt, deadline: teams[teamId].deadline,
        barrierIdx: teams[teamId].nextBarrierIdx, judgeToken: teams[teamId].judgeToken,
      });
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

  socket.on('player:answer', (payload) => {
    const text = payload && typeof payload === 'object' ? payload.text : payload;
    const answerToken = payload && typeof payload === 'object' ? payload.judgeToken : null;
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
    if (answerToken && tm.judgeToken && Number(answerToken) !== Number(tm.judgeToken)){
      console.log(`[answer] ✗ ${tm.name}: token antigo (${answerToken} != ${tm.judgeToken})`);
      socket.emit('answer:rejected', { reason: 'julgamento-antigo' });
      return;
    }
    // se o socket que mandou não é o admin atual, promove-o (recupera após queda/refresh)
    if (tm.adminSocketId !== socket.id){
      console.log(`[answer] ⚠ ${tm.name}: socket não-admin enviou resposta — promovendo`);
      tm.adminSocketId = socket.id;
      tm.adminPlayerId = socket.data.playerId || tm.adminPlayerId;
      socket.data.isAdmin = true;
      socket.emit('you:admin', { team: t });
    }
    console.log(`[answer] ✓ ${tm.name}: ${String(text||'').length} chars`);
    tm.answer = String(text || '').slice(0, 3000);
    io.emit('team:answered', { team: t });
    evaluateTeam(tm);
  });

  // sair para o lobby (botão "Trocar equipe" no celular) — saída intencional, sem tolerância
  socket.on('player:leave', () => {
    leaveTeam(socket);
    broadcastState();
  });

  // O socket caiu (refresh, perda de sinal, app foi pra background...).
  // Não sabemos se foi de propósito ou só uma queda momentânea, então damos
  // uma janela de tolerância antes de liberar o lugar/admin de fato.
  socket.on('disconnect', () => {
    handleSocketDrop(socket);
  });
});

// ===================== START =====================
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🏁 Corrida dos Agentes');
  console.log('   💻 Telão:        http://localhost:' + PORT);
  if (LOCAL_IP) console.log('   📱 Celular LAN:  http://' + LOCAL_IP + ':' + PORT + '/mobile.html');
  if (PUBLIC_URL && (!LOCAL_IP || !PUBLIC_URL.startsWith(`http://${LOCAL_IP}`))) {
    console.log('   🌐 URL pública:  ' + PUBLIC_URL + '/mobile.html');
  }
  console.log('   🔗 QR aponta para: ' + (PUBLIC_URL || 'localhost') + '/mobile.html');
  console.log(ANTHROPIC_KEY ? '   ⚖️  Juiz Claude:  ATIVO (' + CLAUDE_MODEL + ')' : '   ⚠️  ANTHROPIC_API_KEY ausente — usando avaliação local.');
  console.log('');
});
