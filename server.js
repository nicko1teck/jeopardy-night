'use strict';
// Jeopardy Night server.
// Plain Node (18+), no npm packages. It does four jobs:
//   1. Serves the files in ./public (the TV board, the phone page, the question files),
//      and lists every question file in public/games so a new board just needs dropping in.
//   2. Keeps the "room" state: which game is being played, the teams that registered,
//      who buzzed first, and the wagers and Final Jeopardy answers phones send in.
//   3. Pushes that state live to every screen with Server-Sent Events (SSE): a stream
//      that only goes server -> browser. Browsers talk back with ordinary POST requests.
//   4. Saves the room to disk as it changes (plus the TV's copy of the board), so a crash,
//      restart or redeploy picks up exactly where the game left off.
//
// The TV is the host and proves it with HOST_KEY. Phones prove they belong to the
// room with the 4-letter code shown on the TV. The TV keeps the board and the scores
// and sends the scores here so phones can show them.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const HOST_KEY = process.env.HOST_KEY || crypto.randomBytes(4).toString('hex');
const PUBLIC_DIR = path.join(__dirname, 'public');
const GAMES_DIR = path.join(PUBLIC_DIR, 'games');
// Saved game lives outside the app folder, so git pulls and redeploys never touch it.
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), '.jeopardy-night');
const DATA_FILE = path.join(DATA_DIR, 'room.json');
const EARLY_PENALTY_MS = 500; // buzz before the host opens the buzzers and you're frozen this long
const MAX_TEAMS = 4;

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, so nobody misreads the code
function newCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += LETTERS[crypto.randomInt(LETTERS.length)];
  return s;
}

// ---------- the room ----------
// One room at a time is plenty for a living room.
function freshRoom(gameId = null, title = '') {
  return {
    code: newCode(),
    gameId,
    title,
    teams: [],          // [{ name }], in the order they registered
    scores: [],
    // none | lobby | idle | reading | open | buzzed | dd-wager | final-wager | final-answer | final-closed
    phase: gameId ? 'lobby' : 'none',
    winner: null,       // team index that buzzed first
    lockedOut: [],      // teams that already answered this clue
    early: {},          // team index -> time until which that team's buzzes are ignored
    dd: null,           // { team, max, wager } while a Daily Double wager is being made
    final: { eligible: [], max: {}, subs: {} },
    hostView: null,     // what the host's phone shows: the clue on the TV and its answer. Never sent to players.
    snapshot: null,     // the TV's whole board state, so a crashed or reloaded TV can resume. Only the TV can read it.
    seq: 0,
  };
}
let room = freshRoom();

// ---------- saving to disk ----------
// Every change is written (at most four times a second) to DATA_FILE. The write goes to a
// temp file first and is then renamed over the old one, so a crash mid-write can't corrupt it.
let saveTimer = null;
function writeRoomNow() {
  clearTimeout(saveTimer); saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...room, early: {} }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.warn('Could not save the game:', e.message);
  }
}
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(writeRoomNow, 250); }

function loadRoom() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!saved || typeof saved.code !== 'string' || !Array.isArray(saved.teams)) return;
    room = Object.assign(freshRoom(), saved, { early: {} });
    console.log(`Restored room ${room.code}: ${room.title || 'no game picked'}, ${room.teams.length} team(s), phase "${room.phase}".`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('Could not read the saved game, starting fresh:', e.message);
  }
}
loadRoom();

// pm2 sends SIGINT on restart and redeploy: write the latest state before exiting.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { writeRoomNow(); process.exit(0); });
}

// ---------- question files ----------
// Any *.json in public/games is a game, except index.json and files starting with "_" (templates).
// Each one is checked, so a broken file shows up on the TV with the reason instead of crashing a game.
const gameTitle = (g) => String(g.title || (g.subject ? `${g.subject} Jeopardy` : 'Jeopardy')).slice(0, 80);

function checkGame(g) {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'the file is empty or not a game';
  if (!g.subject && !g.title) return 'it needs a "subject"';
  if (!Array.isArray(g.rounds) || !g.rounds.length) return 'it needs "rounds"';
  for (const [ri, r] of g.rounds.entries()) {
    const where = `round ${ri + 1}`;
    if (!r || !Array.isArray(r.categories) || !r.categories.length) return `${where} has no categories`;
    if (r.categories.length > 8) return `${where} has more than 8 categories`;
    const rows = Array.isArray(r.categories[0].clues) ? r.categories[0].clues.length : 0;
    for (const c of r.categories) {
      if (!c || !c.name) return `${where} has a category with no "name"`;
      if (!Array.isArray(c.clues) || !c.clues.length) return `"${c.name}" has no clues`;
      if (c.clues.length !== rows) return `"${c.name}" has ${c.clues.length} clues, but the first category has ${rows}`;
      for (const [i, x] of c.clues.entries()) {
        if (!x || !x.q || !x.a) return `"${c.name}" clue ${i + 1} needs both "q" and "a"`;
      }
    }
    if (r.values && (!Array.isArray(r.values) || r.values.length !== rows)) return `${where} has ${r.values.length} "values" but ${rows} clues per category`;
  }
  const f = g.final;
  if (!f || !f.category || !f.clue || !f.answer) return 'it needs a "final" with "category", "clue" and "answer"';
  return null;
}

function listGames() {
  let files;
  try {
    files = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json' && !f.startsWith('_'));
  } catch (e) {
    return [];
  }
  const byName = (a, b) => (a || '').localeCompare(b || '', 'en', { numeric: true, sensitivity: 'base' });
  return files.map((file) => {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), 'utf8'));
      const problem = checkGame(g);
      if (problem) return { file, error: problem };
      return { file, id: String(g.id || file.replace(/\.json$/, '')), title: gameTitle(g), subject: String(g.subject || ''), edition: String(g.edition || '') };
    } catch (e) {
      return { file, error: 'it is not valid JSON (' + String(e.message).split('\n')[0] + ')' };
    }
  }).sort((a, b) => byName(a.title || a.file, b.title || b.file) || byName(a.edition, b.edition) || byName(a.file, b.file));
}

// ---------- live connections (SSE) ----------
const clients = new Set(); // { res, role: 'tv' | 'phone', team }

function phoneCounts() {
  const counts = room.teams.map(() => 0);
  for (const c of clients) if (c.role === 'phone' && counts[c.team] !== undefined) counts[c.team]++;
  return counts;
}

function stateFor(client) {
  const base = {
    gameId: room.gameId,
    title: room.title,
    teams: room.teams.map((t) => t.name),
    scores: room.scores,
    phase: room.phase,
    winner: room.winner,
    lockedOut: room.lockedOut,
    seq: room.seq,
  };
  if (client.role === 'host') {
    return { ...base, code: room.code, view: room.hostView };
  }
  if (client.role === 'tv') {
    return { ...base, code: room.code, phones: phoneCounts(), dd: room.dd, final: room.final };
  }
  // A phone only sees its own Daily Double and its own Final Jeopardy entry.
  const mine = client.team;
  return {
    ...base,
    team: mine,
    dd: room.dd ? { team: room.dd.team, max: room.dd.team === mine ? room.dd.max : null, wager: room.dd.team === mine ? room.dd.wager : null } : null,
    final: {
      eligible: room.final.eligible.includes(mine),
      max: room.final.max[mine] || 0,
      mine: room.final.subs[mine] || null,
    },
  };
}

function send(client) {
  client.res.write(`data: ${JSON.stringify(stateFor(client))}\n\n`);
}

function broadcast() {
  room.seq++;
  scheduleSave();
  for (const c of clients) send(c);
}

// Phones from an old room get told to rejoin.
function kickPhones() {
  for (const c of clients) {
    if (c.role === 'phone') { c.res.write('event: kicked\ndata: {}\n\n'); c.res.end(); clients.delete(c); }
  }
}

// Comment lines keep proxies (and Xbox Edge) from closing a quiet stream.
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 20000);

// ---------- helpers ----------
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 10000) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) req.destroy(); // nobody needs to send more than this
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

const validTeam = (t) => Number.isInteger(t) && t >= 0 && t < room.teams.length;
const keyOk = (k) => typeof k === 'string' && k.length > 0 && k.length <= 64 &&
  crypto.timingSafeEqual(Buffer.from(k.padEnd(64)), Buffer.from(HOST_KEY.padEnd(64)));
const codeOk = (c) => room.gameId && typeof c === 'string' && c.toUpperCase() === room.code;
const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 30);

// ---------- host (TV) actions ----------
function hostAction(body) {
  // The TV's board state, for resuming. Stored and saved, never broadcast.
  if (body.action === 'snapshot') {
    if (body.snapshot !== null && (typeof body.snapshot !== 'object' || Array.isArray(body.snapshot))) return false;
    room.snapshot = body.snapshot;
    scheduleSave();
    return true;
  }
  if (Array.isArray(body.scores)) room.scores = room.teams.map((_, i) => Number(body.scores[i]) || 0);
  switch (body.action) {
    case 'new-room': // pick a game: fresh code, no teams yet, phones from before must rejoin
      kickPhones();
      room = freshRoom(String(body.gameId || 'game'), String(body.title || '').slice(0, 80));
      break;
    case 'restore': { // TV reloaded mid-game: put its teams and scores back, keep the room code
      if (!Array.isArray(body.teams) || body.teams.length < 1 || body.teams.length > MAX_TEAMS) return false;
      const names = body.teams.map(cleanName);
      const same = room.gameId === String(body.gameId) && names.join('|') === room.teams.map((t) => t.name).join('|');
      room.scores = names.map((_, i) => Number((body.scores || [])[i]) || 0);
      if (same) {
        // The server still has this game (it was saved to disk): keep the room code, the phones,
        // who's buzzed, wagers and Final answers. Only the scores are synced from the TV.
        broadcast();
        return { ok: true, kept: true };
      }
      if (!room.gameId) room.code = newCode();
      kickPhones();
      room.gameId = String(body.gameId || 'game');
      room.title = String(body.title || '').slice(0, 80);
      room.teams = names.map((name) => ({ name }));
      room.phase = 'idle'; room.winner = null; room.lockedOut = []; room.dd = null;
      room.final = { eligible: [], max: {}, subs: {} };
      broadcast();
      return { ok: true, kept: false };
    }
    case 'add-team': { // host types a team name on the TV (for a team without a phone)
      const name = cleanName(body.name);
      if (!name || room.teams.length >= MAX_TEAMS) return false;
      room.teams.push({ name }); room.scores.push(0);
      break;
    }
    case 'remove-team': {
      if (room.phase !== 'lobby' || !validTeam(body.team)) return false;
      room.teams.splice(body.team, 1); room.scores.splice(body.team, 1);
      kickPhones(); // team numbers shifted, so phones re-pick their team
      break;
    }
    case 'scores': break;
    case 'hostview': { // the TV tells the host page what's on screen, answer included
      const v = body.info && typeof body.info === 'object' ? body.info : null;
      const json = v ? JSON.stringify(v) : 'null';
      if (json.length > 4000) return false;
      room.hostView = JSON.parse(json);
      break;
    }
    case 'idle':
      room.phase = 'idle'; room.winner = null; room.dd = null; break;
    case 'reading': // clue on screen, host reading it aloud; buzzing now earns a penalty
      room.phase = 'reading'; room.winner = null; room.lockedOut = []; room.early = {}; room.dd = null;
      break;
    case 'open':
      room.phase = 'open'; room.winner = null;
      if (Array.isArray(body.lockedOut)) room.lockedOut = body.lockedOut.filter(validTeam);
      break;
    case 'dd-wager':
      if (!validTeam(body.team)) return false;
      room.phase = 'dd-wager';
      room.dd = { team: body.team, max: Math.max(0, Math.round(Number(body.max) || 0)), wager: null };
      break;
    case 'final-wager': {
      const eligible = (body.eligible || []).filter(validTeam);
      const max = {};
      for (const t of eligible) max[t] = Math.max(0, room.scores[t] || 0);
      room.phase = 'final-wager';
      room.final = { eligible, max, subs: {} };
      break;
    }
    case 'final-answer': room.phase = 'final-answer'; break;
    case 'final-closed': room.phase = 'final-closed'; break;
    default: return false;
  }
  broadcast();
  return true;
}

// ---------- phone actions ----------
function register(name) {
  name = cleanName(name);
  if (!name) return { error: 'Pick a team name first.' };
  if (room.phase !== 'lobby') return { error: 'The game has already started. Join one of the teams instead.' };
  if (room.teams.length >= MAX_TEAMS) return { error: `This game is full (${MAX_TEAMS} teams).` };
  if (room.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) return { error: 'That name is taken.' };
  room.teams.push({ name }); room.scores.push(0);
  broadcast();
  return { team: room.teams.length - 1 };
}

function buzz(team) {
  const now = Date.now();
  if (room.phase === 'reading') {
    room.early[team] = now + EARLY_PENALTY_MS;
    return 'early';
  }
  if (room.phase !== 'open') return room.phase === 'buzzed' ? 'late' : 'closed';
  if (room.lockedOut.includes(team)) return 'locked';
  if ((room.early[team] || 0) > now) return 'early';
  // First one through this line wins. Node handles requests one at a time,
  // so two buzzes can never both get here.
  room.phase = 'buzzed';
  room.winner = team;
  broadcast();
  return 'won';
}

function wager(team, amount) {
  const w = Math.round(Number(amount));
  if (!Number.isFinite(w) || w < 0) return 'bad-wager';
  if (room.phase === 'dd-wager' && room.dd && room.dd.team === team) {
    if (w > room.dd.max) return 'too-high';
    room.dd.wager = w;
  } else if (room.phase === 'final-wager' && room.final.eligible.includes(team)) {
    if (w > room.final.max[team]) return 'too-high';
    const sub = room.final.subs[team] || { wager: 0, answer: '', wagerIn: false, answerIn: false };
    sub.wager = w; sub.wagerIn = true;
    room.final.subs[team] = sub;
  } else {
    return 'closed';
  }
  broadcast();
  return 'ok';
}

function finalAnswer(team, answer) {
  if (room.phase !== 'final-answer' || !room.final.eligible.includes(team)) return 'closed';
  const sub = room.final.subs[team] || { wager: 0, answer: '', wagerIn: false, answerIn: false };
  sub.answer = String(answer || '').slice(0, 200);
  sub.answerIn = true;
  room.final.subs[team] = sub;
  broadcast();
  return 'ok';
}

// ---------- static files ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/buzz') pathname = '/buzz.html';
  if (pathname === '/host') pathname = '/host.html';
  let file;
  try { file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname))); } catch { return json(res, 400, { error: 'bad path' }); }
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/ping') return json(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/api/games') return json(res, 200, listGames());
  if (req.method === 'GET' && p === '/api/snapshot') {
    if (!keyOk(url.searchParams.get('key'))) return json(res, 403, { error: 'bad host key' });
    return json(res, 200, { code: room.code, gameId: room.gameId, snapshot: room.snapshot });
  }

  if (req.method === 'GET' && p === '/events') {
    const role = url.searchParams.get('role');
    const team = Number(url.searchParams.get('team'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tells nginx not to hold the stream back
    });
    res.write('retry: 2000\n\n');
    const allowed = role === 'tv' || role === 'host'
      ? keyOk(url.searchParams.get('key'))
      : role === 'phone' && codeOk(url.searchParams.get('code')) && validTeam(team);
    if (!allowed) {
      res.write('event: kicked\ndata: {}\n\n');
      return res.end();
    }
    const client = { res, role, team: role === 'phone' ? team : null };
    clients.add(client);
    req.on('close', () => { if (clients.delete(client)) broadcast(); });
    broadcast(); // the TV sees the new phone arrive
    return;
  }

  if (req.method === 'POST' && p.startsWith('/api/')) {
    const body = await readBody(req, p === '/api/host' ? 100000 : 10000);
    if (p === '/api/host') {
      if (!keyOk(body.key)) return json(res, 403, { error: 'bad host key' });
      const r = hostAction(body);
      return json(res, r ? 200 : 400, typeof r === 'object' ? r : { ok: !!r });
    }
    if (!codeOk(body.code)) return json(res, 403, { error: "That room code doesn't match the one on the TV." });
    if (p === '/api/join') return json(res, 200, { title: room.title, teams: room.teams.map((t) => t.name), lobby: room.phase === 'lobby' });
    if (p === '/api/register') { const r = register(body.name); return json(res, r.error ? 400 : 200, r); }
    if (!validTeam(body.team)) return json(res, 400, { error: 'bad team' });
    if (p === '/api/buzz') return json(res, 200, { result: buzz(body.team) });
    if (p === '/api/wager') return json(res, 200, { result: wager(body.team, body.wager) });
    if (p === '/api/answer') return json(res, 200, { result: finalAnswer(body.team, body.answer) });
    return json(res, 404, { error: 'not found' });
  }

  if (req.method === 'GET') return serveStatic(req, res, p);
  json(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, () => {
  console.log(`Jeopardy Night running on port ${PORT}`);
  console.log(`  Saved game: ${DATA_FILE}`);
  console.log(`  TV (host):  http://<your-server>:${PORT}/?key=${HOST_KEY}`);
  console.log(`  Phones:     http://<your-server>:${PORT}/buzz`);
  console.log(`  Host cards: http://<your-server>:${PORT}/host?key=${HOST_KEY}   (your phone only: it shows the answers)`);
  if (!process.env.HOST_KEY) console.log('  Tip: set HOST_KEY yourself so the TV link stays the same between restarts.');
});
