/* De Grote Dalmuti — multiplayer-server.
   Eén Node-proces: serveert de statische bestanden én draait de
   spellogica (dezelfde js/game.js als de browser) per kamer.

   Starten:  node server/server.js   (of: npm start)
   Spelen:   http://localhost:8321 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require(path.join(__dirname, '..', 'js', 'game.js'));

const PORT = process.env.PORT || 8321;
const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HUMAN_FACES = ['🙂', '😎', '🧐', '🤠', '🥸', '😼', '🦊', '👽'];

/* ================= STATISCHE BESTANDEN ================= */

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ================= KAMERS ================= */

const rooms = new Map();

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function makeRoom() {
  const room = { code: genCode(), seats: [], phase: 'lobby', game: null, pending: new Map(), cleanupTimer: null };
  rooms.set(room.code, room);
  return room;
}

const seatIdx = (room, seat) => room.seats.indexOf(seat);
const isConnected = seat => !seat.isBot && seat.ws && seat.ws.readyState === 1;
const humanSeats = room => room.seats.filter(s => !s.isBot);

function sendLobby(room) {
  for (const seat of room.seats) {
    if (!isConnected(seat)) continue;
    send(seat.ws, {
      t: 'lobby',
      code: room.code,
      you: seatIdx(room, seat),
      players: room.seats.map(s => ({
        name: s.name, face: s.face, isBot: s.isBot, isHost: s.isHost,
        connected: Boolean(s.isBot || isConnected(s)),
      })),
      canStart: room.seats.length >= 4 && room.seats.length <= 7,
    });
  }
}

/* Persoonlijke snapshot: eigen hand volledig, van anderen alleen aantallen. */
function viewFor(room, seat) {
  const g = room.game;
  const me = seatIdx(room, seat);
  return {
    mode: 'multi',
    code: room.code,
    round: g.round,
    roundOver: g.roundOver,
    meIdx: me,
    turn: g.turn,
    trick: g.trick,
    pile: g.pile,
    order: g.order,
    finishedOrder: g.finishedOrder,
    hasRoles: g.round >= 2 || g.roundOver,
    players: g.players.map((p, i) => ({
      idx: p.idx, name: p.name, face: p.face, handCount: p.hand.length,
      score: p.score, finished: p.finished,
      connected: Boolean(room.seats[i].isBot || isConnected(room.seats[i])),
    })),
    myHand: g.players[me].hand,
  };
}

function sendStates(room) {
  for (const seat of room.seats) {
    if (isConnected(seat)) send(seat.ws, { t: 'state', view: viewFor(room, seat) });
  }
}

function broadcastEv(room, ev) {
  for (const seat of room.seats) {
    if (isConnected(seat)) send(seat.ws, { t: 'ev', ev });
  }
}

/* Vraag een menselijke speler iets; bij timeout of disconnect de default. */
function ask(room, seat, payload, timeoutMs, dflt) {
  return new Promise(resolve => {
    if (!isConnected(seat)) return resolve(dflt);
    const entry = {
      what: payload.what,
      payload,
      dflt,
      resolve(v) { clearTimeout(entry.timer); room.pending.delete(seat); resolve(v); },
    };
    entry.timer = setTimeout(() => entry.resolve(dflt), timeoutMs);
    room.pending.set(seat, entry);
    send(seat.ws, { t: 'ask', ...payload });
  });
}

function resolvePending(room, seat, what, value) {
  const entry = room.pending.get(seat);
  if (entry && entry.what === what) entry.resolve(value);
}

function destroyRoom(room, notify = true) {
  room.phase = 'dead';
  clearTimeout(room.cleanupTimer);
  for (const [, entry] of room.pending) entry.resolve(entry.dflt);
  if (notify) broadcastEv(room, { ev: 'roomClosed' });
  rooms.delete(room.code);
}

/* Kamer opruimen als er 10 minuten geen mens meer verbonden is. */
function scheduleCleanup(room) {
  if (humanSeats(room).some(isConnected)) return;
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (room.phase !== 'dead' && !humanSeats(room).some(isConnected)) destroyRoom(room, false);
  }, 10 * 60 * 1000);
}

function reassignHost(room) {
  const eligible = s => !s.isBot && s.token !== null;
  const current = room.seats.find(s => s.isHost);
  if (current && eligible(current)) return;
  if (current) current.isHost = false;
  const next = room.seats.find(s => eligible(s) && isConnected(s)) || room.seats.find(eligible);
  if (next) next.isHost = true;
}

/* ================= SPELVERLOOP ================= */

async function runGame(room) {
  const specs = room.seats.map(s => ({ name: s.name, face: s.face, isHuman: !s.isBot }));
  room.game = new G.Game(specs);

  while (room.phase === 'playing') {
    await runRound(room);
    if (room.phase !== 'playing') return;

    const g = room.game;
    const results = g.finishedOrder.map((idx, pos) => ({
      idx, pos, pts: g.n - 1 - pos, score: g.player(idx).score,
    }));

    // "Handelende host": de host als die er is, anders de eerste verbonden mens
    const actingHost = room.seats.find(s => s.isHost && isConnected(s))
      || room.seats.find(s => isConnected(s));
    for (const seat of room.seats) {
      if (isConnected(seat)) {
        send(seat.ws, { t: 'ev', ev: { ev: 'roundEnd', results, youAreHost: seat === actingHost } });
      }
    }
    if (actingHost) await ask(room, actingHost, { what: 'nextround' }, 300000, true);
    else await sleep(8000);
  }
}

async function runRound(room) {
  const g = room.game;
  g.deal();
  broadcastEv(room, { ev: 'roundStart', round: g.round });
  sendStates(room);
  await sleep(1000);

  // Revolutie?
  const holder = g.jokerHolder();
  if (holder && room.phase === 'playing') {
    const seat = room.seats[holder.idx];
    let calls;
    if (isConnected(seat)) {
      calls = await ask(room, seat, {
        what: 'revolution',
        isGroteSloeber: g.order.indexOf(holder.idx) === g.n - 1,
      }, 45000, false);
    } else {
      calls = g.botWantsRevolution(holder.idx);
    }
    if (calls && room.phase === 'playing') {
      g.callRevolution(holder.idx);
      broadcastEv(room, { ev: 'revolution', kind: g.revolution, idx: holder.idx });
      sendStates(room);
      await sleep(1400);
    }
  }

  // Belasting (kaart-identiteiten blijven privé; alleen aantallen broadcasten)
  const tax = g.taxation();
  if (tax && room.phase === 'playing') {
    for (const f of tax.flows) {
      broadcastEv(room, { ev: 'tax', from: f.from, to: f.to, count: f.cards.length, dir: f.dir });
    }
    sendStates(room);
    for (const pend of tax.pendingHuman) {
      if (room.phase !== 'playing') return;
      const seat = room.seats[pend.giver];
      const recvName = g.player(pend.receiver).name;
      const ids = await ask(room, seat, { what: 'giveback', k: pend.k, receiverName: recvName }, 60000, null);
      const hand = g.player(pend.giver).hand;
      const valid = Array.isArray(ids) && ids.length === pend.k
        && ids.every(id => hand.some(c => c.id === id));
      if (valid) {
        g.giveBack(pend.giver, ids, pend.receiver);
      } else {
        // timeout/ongeldig: geef automatisch de slechtste kaarten terug
        const back = g.botGiveBack(g.player(pend.giver), pend.k);
        g.player(pend.receiver).hand.push(...back);
        G.sortHand(g.player(pend.receiver).hand);
      }
      broadcastEv(room, { ev: 'tax', from: pend.giver, to: pend.receiver, count: pend.k, dir: 'teruggave' });
      sendStates(room);
    }
  }

  broadcastEv(room, { ev: 'leader', idx: g.turn });

  // Beurten
  while (!g.roundOver && room.phase === 'playing') {
    sendStates(room);
    const p = g.player(g.turn);
    const seat = room.seats[p.idx];
    let events;

    if (isConnected(seat)) {
      const act = await ask(room, seat, { what: 'turn' }, 90000, null);
      if (room.phase !== 'playing') return;
      if (act && act.play) {
        events = g.play(p.idx, act.play);
        if (!events.ok) { send(seat.ws, { t: 'toast', msg: events.reason }); continue; }
      } else if (act && act.pass && g.trick) {
        events = g.pass(p.idx);
      } else {
        // timeout of ongeldige pas: de bot-strategie neemt deze beurt over
        const ids = g.botDecide(p.idx);
        events = ids ? g.play(p.idx, ids) : g.pass(p.idx);
      }
    } else {
      await sleep(650 + Math.random() * 450);
      if (room.phase !== 'playing') return;
      const ids = g.botDecide(p.idx);
      events = ids ? g.play(p.idx, ids) : g.pass(p.idx);
    }

    events.actor = p.idx;
    delete events.cards; // de pile zit al in de state-snapshot
    broadcastEv(room, { ev: 'action', ...events });
    if (events.trickWon !== undefined && events.trickWon !== null) {
      sendStates(room);
      await sleep(1100);
    }
  }
  sendStates(room);
  await sleep(900);
}

/* ================= BERICHTEN ================= */

function clean(name) { return String(name || '').trim().slice(0, 14); }

function addHuman(room, ws, name, isHost) {
  const usedFaces = new Set(room.seats.map(s => s.face));
  const face = HUMAN_FACES.find(f => !usedFaces.has(f)) || '🙂';
  // crypto.randomUUID bestaat pas sinds Node 14.17; randomBytes werkt overal
  const seat = { name, face, isBot: false, isHost, token: crypto.randomBytes(16).toString('hex'), ws };
  room.seats.push(seat);
  ws.ref = { room, seat };
  clearTimeout(room.cleanupTimer);
  send(ws, { t: 'joined', code: room.code, token: seat.token, name });
  sendLobby(room);
}

function route(ws, m) {
  if (m.t === 'create') {
    const name = clean(m.name);
    if (!name) return send(ws, { t: 'error', msg: 'Ongeldige naam.' });
    const room = makeRoom();
    addHuman(room, ws, name, true);
    return;
  }

  if (m.t === 'join') {
    const room = rooms.get(String(m.code || '').toUpperCase());
    if (!room) return send(ws, { t: 'error', msg: 'Kamer niet gevonden.' });

    // Reconnect met token: stoel en hand terugkrijgen
    const existing = m.token && room.seats.find(s => s.token && s.token === m.token);
    if (existing) {
      if (existing.ws && existing.ws !== ws) { try { existing.ws.close(); } catch (e) {} }
      existing.ws = ws;
      ws.ref = { room, seat: existing };
      clearTimeout(room.cleanupTimer);
      send(ws, { t: 'joined', code: room.code, token: existing.token, name: existing.name });
      if (room.phase === 'playing') {
        sendStates(room); // iedereen ziet de reconnect, rejoiner krijgt zijn hand
        const pend = room.pending.get(existing);
        if (pend) send(ws, { t: 'ask', ...pend.payload });
      } else {
        sendLobby(room);
      }
      return;
    }

    if (room.phase !== 'lobby') return send(ws, { t: 'error', msg: 'Dit spel is al bezig.' });
    if (room.seats.length >= 7) return send(ws, { t: 'error', msg: 'De kamer is vol (max 7 spelers).' });
    const name = clean(m.name);
    if (!name) return send(ws, { t: 'error', msg: 'Ongeldige naam.' });
    addHuman(room, ws, name, false);
    return;
  }

  const ref = ws.ref;
  if (!ref || !rooms.has(ref.room.code)) return;
  const { room, seat } = ref;

  switch (m.t) {
    case 'addBot':
      if (room.phase === 'lobby' && seat.isHost && room.seats.length < 7) {
        const used = new Set(room.seats.map(s => s.name));
        const i = G.BOT_NAMES.findIndex(n => !used.has(n));
        if (i >= 0) {
          room.seats.push({ name: G.BOT_NAMES[i], face: G.BOT_FACES[i], isBot: true, isHost: false, token: null, ws: null });
        }
        sendLobby(room);
      }
      break;
    case 'removeBot':
      if (room.phase === 'lobby' && seat.isHost) {
        for (let i = room.seats.length - 1; i >= 0; i--) {
          if (room.seats[i].isBot) { room.seats.splice(i, 1); break; }
        }
        sendLobby(room);
      }
      break;
    case 'start':
      if (room.phase === 'lobby' && seat.isHost && room.seats.length >= 4 && room.seats.length <= 7) {
        room.phase = 'playing';
        runGame(room).catch(e => {
          console.error('spel crashte in kamer ' + room.code + ':', e);
          destroyRoom(room);
        });
      }
      break;
    case 'play': resolvePending(room, seat, 'turn', { play: m.cardIds }); break;
    case 'pass': resolvePending(room, seat, 'turn', { pass: true }); break;
    case 'revolution': resolvePending(room, seat, 'revolution', !!m.call); break;
    case 'giveback': resolvePending(room, seat, 'giveback', m.cardIds); break;
    case 'nextround': resolvePending(room, seat, 'nextround', true); break;
    case 'leave': leaveSeat(room, seat); break;
  }
}

/* Vrijwillig vertrek: stoel komt niet meer terug. */
function leaveSeat(room, seat) {
  const idx = seatIdx(room, seat);
  if (seat.ws) { seat.ws.ref = null; seat.ws = null; }
  const entry = room.pending.get(seat);
  if (entry) entry.resolve(entry.dflt);

  if (room.phase === 'lobby') {
    room.seats.splice(idx, 1);
    if (!humanSeats(room).length) { destroyRoom(room, false); return; }
    reassignHost(room);
    sendLobby(room);
  } else {
    seat.token = null; // rejoin onmogelijk; bot speelt de hand uit
    if (!room.seats.some(s => !s.isBot && s.token)) { destroyRoom(room, false); return; }
    reassignHost(room);
    broadcastEv(room, { ev: 'playerLeft', idx });
    sendStates(room);
    scheduleCleanup(room);
  }
}

/* Verbroken verbinding: stoel blijft gereserveerd (token blijft geldig). */
function detach(ws) {
  const ref = ws.ref;
  if (!ref || !rooms.has(ref.room.code)) return;
  const { room, seat } = ref;
  if (seat.ws !== ws) return; // al vervangen door een reconnect
  seat.ws = null;
  const entry = room.pending.get(seat);
  if (entry) entry.resolve(entry.dflt);

  if (room.phase === 'lobby') {
    room.seats.splice(seatIdx(room, seat), 1);
    if (!humanSeats(room).length) { destroyRoom(room, false); return; }
    reassignHost(room);
    sendLobby(room);
  } else {
    sendStates(room);
    scheduleCleanup(room);
  }
}

/* ================= WEBSOCKET ================= */

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    try { route(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => detach(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`De Grote Dalmuti draait op http://localhost:${PORT}`);
});
