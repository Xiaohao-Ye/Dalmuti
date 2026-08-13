/* De Grote Dalmuti — multiplayer-client.
   Praat met server/server.js via WebSocket. De server is de scheidsrechter:
   wij sturen intenties ({t:'play'}), hij stuurt persoonlijke snapshots
   ({t:'state'}) en events ({t:'ev'}) terug. */
'use strict';

const Net = (() => {
  const $ = UI.$;

  let ws = null;
  let session = null;        // { code, token, name }
  let lobby = null;          // laatste lobby-bericht
  let inGame = false;
  let evQueue = Promise.resolve();   // events op volgorde afspelen
  let reconnectTimer = null;
  let reconnectTries = 0;
  let intentionalClose = false;

  const wsUrl = () =>
    (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;

  const canConnect = () => location.protocol !== 'file:';

  function status(msg) { $('#mp-status').textContent = msg || ''; }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  function tokenKey(code) { return 'dalmuti.token.' + code; }

  /* ---------- verbinden ---------- */

  function connect(onOpen) {
    if (!canConnect()) {
      status('Multiplayer vereist de server: npm start, open dan http://localhost:8321');
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) { onOpen(); return; }
    ws = new WebSocket(wsUrl());
    ws.onopen = () => { reconnectTries = 0; onOpen && onOpen(); };
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      ws = null;
      if (intentionalClose) { intentionalClose = false; return; }
      if (session) tryReconnect();
    };
    ws.onerror = () => { status('Kan geen verbinding maken met de server.'); };
  }

  function tryReconnect() {
    if (reconnectTries === 0) UI.popup('VERBINDING VERBROKEN…', 'warn');
    if (reconnectTries >= 15) {
      UI.popup('Verbinding definitief verloren', 'warn');
      leaveLocal();
      return;
    }
    reconnectTries++;
    reconnectTimer = setTimeout(() => {
      connect(() => {
        send({ t: 'join', code: session.code, name: session.name, token: session.token });
      });
    }, 2500);
  }

  /* ---------- publieke acties ---------- */

  function playerName() {
    const name = $('#mp-name').value.trim().slice(0, 14);
    if (!name) { status('Vul eerst je naam in.'); return null; }
    localStorage.setItem('dalmuti.name', name);
    return name;
  }

  function create() {
    const name = playerName();
    if (!name) return;
    status('Verbinden…');
    connect(() => send({ t: 'create', name }));
  }

  function join() {
    const name = playerName();
    if (!name) return;
    const code = $('#mp-code').value.trim().toUpperCase();
    if (code.length !== 4) { status('Vul een kamercode van 4 letters in.'); return; }
    status('Verbinden…');
    const token = localStorage.getItem(tokenKey(code)) || undefined;
    connect(() => send({ t: 'join', code, name, token }));
  }

  function leave() {
    send({ t: 'leave' });
    leaveLocal();
  }

  function leaveLocal() {
    clearTimeout(reconnectTimer);
    session = null;
    lobby = null;
    inGame = false;
    UI.setCanAct(false);
    UI.hideOverlay();
    if (ws) { intentionalClose = true; ws.close(); }
    UI.showScreen('start');
  }

  /* ---------- berichten van de server ---------- */

  function handle(m) {
    switch (m.t) {
      case 'joined': {
        session = { code: m.code, token: m.token, name: m.name };
        localStorage.setItem(tokenKey(m.code), m.token);
        status('');
        Music.start();
        break;
      }
      case 'lobby': {
        lobby = m;
        inGame = false;
        renderLobby();
        UI.showScreen('lobby');
        break;
      }
      case 'state': {
        if (!inGame) {
          // spel is (weer) bezig: naar het speelscherm
          inGame = true;
          UI.clearLog();
          UI.showScreen('game');
          registerActions();
        }
        UI.render(m.view);
        break;
      }
      case 'ev': queueEv(m.ev); break;
      case 'ask': handleAsk(m); break;
      case 'toast': UI.sfx.bad(); UI.popup(m.msg, 'warn'); break;
      case 'error': status(m.msg); UI.popup(m.msg, 'warn'); break;
    }
  }

  function registerActions() {
    UI.setActions({
      onPlay(ids) {
        UI.setCanAct(false);
        UI.clearSelection();
        send({ t: 'play', cardIds: ids });
      },
      onPass() {
        UI.setCanAct(false);
        UI.clearSelection();
        send({ t: 'pass' });
      },
    });
  }

  /* ---------- vragen van de server ---------- */

  async function handleAsk(m) {
    switch (m.what) {
      case 'turn':
        UI.setCanAct(true);
        break;
      case 'revolution': {
        const yes = await UI.askRevolution(m.isGroteSloeber);
        send({ t: 'revolution', call: yes });
        break;
      }
      case 'giveback': {
        const view = UI.getView();
        const ids = await UI.askGiveBack(m.k, m.receiverName, view ? view.myHand : [], m.received || []);
        send({ t: 'giveback', cardIds: ids });
        break;
      }
      // 'nextround' hoeft de client niets mee: de host-knop in de
      // uitslag-overlay stuurt het antwoord al.
    }
  }

  /* ---------- events ---------- */

  function queueEv(ev) {
    evQueue = evQueue.then(() => applyEv(ev)).catch(() => {});
  }

  async function applyEv(ev) {
    const view = UI.getView();
    const nameOf = idx => (view ? view.players[idx].name : '?');
    switch (ev.ev) {
      case 'roundStart':
        UI.hideOverlay();
        UI.clearBubbles();
        UI.clearSelection();
        UI.markDealing();
        UI.sfx.deal();
        UI.popup('RONDE ' + ev.round, 'big');
        UI.log(`<b>— Ronde ${ev.round} —</b>`);
        break;
      case 'revolution':
        UI.sfx.revolution();
        Music.excite(1);
        UI.shake(true);
        if (ev.kind === 'groot') {
          UI.popup('GROTE REVOLUTIE!', 'big red');
          UI.log(`🃏🃏 <b>${nameOf(ev.idx)}</b> roept de <b>GROTE REVOLUTIE</b> uit — alle rollen draaien om!`);
        } else {
          UI.popup('REVOLUTIE!', 'big red');
          UI.log(`🃏🃏 <b>${nameOf(ev.idx)}</b> roept de revolutie uit — geen belasting deze ronde!`);
        }
        break;
      case 'tax':
        UI.log(`💰 <b>${nameOf(ev.from)}</b> geeft ${ev.count} kaart${ev.count > 1 ? 'en' : ''} aan <b>${nameOf(ev.to)}</b> (${ev.dir})`);
        break;
      case 'leader':
        UI.log(`▶ <b>${nameOf(ev.idx)}</b> mag beginnen.`);
        break;
      case 'action':
        await UI.handleActionEv(ev);
        break;
      case 'roundEnd': {
        await UI.sleep(800);
        UI.sfx.win();
        const v = UI.getView();
        const n = ev.results.length;
        const rows = ev.results.map(r => ({
          face: v.players[r.idx].face,
          name: v.players[r.idx].name,
          me: r.idx === v.meIdx,
          emoji: roleEmoji(r.pos, n),
          role: roleName(r.pos, n),
          pts: r.pts,
          score: r.score,
        }));
        const mePos = ev.results.findIndex(r => r.idx === v.meIdx);
        const headline = UI.headlineFor(mePos, n, v.round);
        // NIET awaiten: een niet-host heeft alleen een verlaat-knop, en zolang
        // die niet geklikt wordt zou de event-wachtrij blokkeren — het
        // roundStart-event dat deze overlay sluit zou er dan achter blijven staan.
        UI.showRoundEnd(rows, headline, { canContinue: ev.youAreHost }).then(choice => {
          if (choice === 'next') send({ t: 'nextround' });
          else if (choice === 'stop') leave();
        });
        break;
      }
      case 'playerLeft':
        UI.log(`🚪 <b>${nameOf(ev.idx)}</b> heeft het spel verlaten — een bot neemt het over.`);
        break;
      case 'roomClosed':
        UI.popup('De kamer is gesloten', 'warn');
        leaveLocal();
        break;
    }
  }

  /* ---------- lobby-weergave ---------- */

  function renderLobby() {
    $('#lobby-code').textContent = lobby.code;
    const ul = $('#lobby-players');
    ul.innerHTML = '';
    lobby.players.forEach((p, i) => {
      const li = UI.el('li', 'lobby-player' + (p.connected ? '' : ' offline'));
      li.innerHTML = `
        <span class="st-face">${p.face}</span>
        <span class="lp-name">${p.name}${i === lobby.you ? ' (jij)' : ''}${p.connected ? '' : ' ⚠'}</span>
        <span class="lp-tags">${p.isHost ? '⭐ host' : ''}${p.isBot ? '🤖 bot' : ''}</span>`;
      ul.appendChild(li);
    });
    const isHost = lobby.players[lobby.you] && lobby.players[lobby.you].isHost;
    $('#btn-addbot').classList.toggle('hidden', !isHost);
    $('#btn-removebot').classList.toggle('hidden', !isHost);
    $('#btn-lobby-start').classList.toggle('hidden', !isHost);
    $('#btn-lobby-start').disabled = !lobby.canStart;
    $('#lobby-status').textContent = isHost
      ? (lobby.canStart ? 'Iedereen erbij? Start het spel!' : `Nog minstens ${4 - lobby.players.length} speler(s) of bot(s) nodig.`)
      : 'Wachten tot de host start…';
  }

  /* ---------- knoppen ---------- */

  $('#btn-create').addEventListener('click', create);
  $('#btn-join').addEventListener('click', join);
  $('#mp-code').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  $('#btn-addbot').addEventListener('click', () => send({ t: 'addBot' }));
  $('#btn-removebot').addEventListener('click', () => send({ t: 'removeBot' }));
  $('#btn-lobby-start').addEventListener('click', () => send({ t: 'start' }));
  $('#btn-lobby-leave').addEventListener('click', leave);

  // Deelbare uitnodigingslink: op mobiel via het deel-menu, anders naar het klembord
  $('#btn-share').addEventListener('click', async () => {
    if (!lobby) return;
    const url = location.origin + location.pathname + '?kamer=' + lobby.code;
    if (navigator.share) {
      try { await navigator.share({ title: 'De Grote Dalmuti', text: 'Speel een potje Dalmuti mee!', url }); return; }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      UI.popup('Link gekopieerd! 🔗', '');
    } catch (e) {
      window.prompt('Kopieer de uitnodigingslink:', url);
    }
  });

  const savedName = localStorage.getItem('dalmuti.name');
  if (savedName) $('#mp-name').value = savedName;

  // Geopend via een uitnodigingslink? Vul de code alvast in.
  const invited = new URLSearchParams(location.search).get('kamer');
  if (invited && canConnect()) {
    const code = invited.toUpperCase().slice(0, 4);
    $('#mp-code').value = code;
    status(`Uitnodiging voor kamer ${code} — vul je naam in en klik DOE MEE.`);
    history.replaceState(null, '', location.pathname);
    $('#mp-name').focus();
  }

  return { leave, get active() { return session !== null; } };
})();
