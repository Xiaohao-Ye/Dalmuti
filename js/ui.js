/* De Grote Dalmuti — view-laag (gedeeld door singleplayer en multiplayer)
   plus de singleplayer-controller.

   Alles rendert vanaf een "view"-snapshot:
     { mode, round, roundOver, meIdx, turn, trick, pile, order,
       finishedOrder, hasRoles, players:[{idx,name,face,handCount,score,
       finished,connected}], myHand:[{id,rank}] }
   Singleplayer bouwt die lokaal uit een Game-instantie; multiplayer
   krijgt hem van de server. */
'use strict';

const UI = (() => {
  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let view = null;
  let selected = new Set();
  let canAct = false;
  const bubbles = new Map();          // idx -> 'pas'
  let actions = { onPlay: null, onPass: null };

  /* ================= GELUID ================= */
  const sfx = (() => {
    let ctx = null;
    let on = true;
    function ac() {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      return ctx;
    }
    function tone(freq, dur, type = 'triangle', vol = 0.12, when = 0) {
      if (!on) return;
      try {
        const a = ac();
        const o = a.createOscillator();
        const g = a.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.setValueAtTime(0, a.currentTime + when);
        g.gain.linearRampToValueAtTime(vol, a.currentTime + when + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + when + dur);
        o.connect(g).connect(a.destination);
        o.start(a.currentTime + when);
        o.stop(a.currentTime + when + dur + 0.05);
      } catch (e) { /* audio niet beschikbaar */ }
    }
    return {
      toggle() { on = !on; return on; },
      select() { tone(520, 0.06, 'square', 0.05); },
      deselect() { tone(380, 0.06, 'square', 0.04); },
      play() { tone(220, 0.1, 'triangle', 0.14); tone(330, 0.12, 'triangle', 0.1, 0.05); },
      pass() { tone(180, 0.12, 'sine', 0.08); },
      bad() { tone(120, 0.2, 'sawtooth', 0.08); },
      win() { [392, 494, 587, 784].forEach((f, i) => tone(f, 0.14, 'triangle', 0.1, i * 0.07)); },
      out() { [523, 659, 784].forEach((f, i) => tone(f, 0.12, 'square', 0.07, i * 0.06)); },
      deal() { for (let i = 0; i < 6; i++) tone(300 + i * 60, 0.04, 'square', 0.04, i * 0.04); },
      revolution() { [196, 233, 196, 233, 311].forEach((f, i) => tone(f, 0.16, 'sawtooth', 0.09, i * 0.09)); },
    };
  })();

  /* ================= EFFECTEN ================= */

  /* Cijfers in lopende tekst renderen in het duidelijke cijferfont
     (Pixelify-cijfers 2/3/5/7 zijn slecht te onderscheiden). */
  const numWrap = s => String(s).replace(/\d+/g, '<span class="num">$&</span>');

  function popup(text, cls = '') {
    const p = el('div', 'popup ' + cls, numWrap(text));
    $('#popups').appendChild(p);
    setTimeout(() => p.remove(), 1600);
  }

  function shake(strong = false) {
    const t = $('#table');
    t.classList.remove('shake', 'shake-strong');
    void t.offsetWidth;
    t.classList.add(strong ? 'shake-strong' : 'shake');
  }

  function log(html) {
    const box = $('#log');
    box.prepend(el('div', 'log-line', numWrap(html)));
    while (box.children.length > 40) box.lastChild.remove();
  }

  function clearLog() { $('#log').innerHTML = ''; }

  /* ================= KAARTEN ================= */

  function makeCardEl(card, opts = {}) {
    const c = el('div', 'card' + (opts.small ? ' small' : '') + (opts.back ? ' back' : ''));
    if (opts.back) { c.innerHTML = '<div class="back-emblem">D</div>'; return c; }
    const info = RANK_INFO[card.rank];
    c.style.setProperty('--accent', RANK_COLORS[card.rank]);
    c.innerHTML = `
      <div class="corner tl">${card.rank}</div>
      <div class="card-art">${info.emoji}</div>
      <div class="card-name">${info.name}</div>
      <div class="corner br">${card.rank}</div>`;
    return c;
  }

  /* ================= RENDEREN ================= */

  const P = idx => view.players[idx];

  function roleOf(idx) {
    if (!view || !view.hasRoles) return null;
    const pos = view.order.indexOf(idx);
    return { pos, name: roleName(pos, view.players.length), emoji: roleEmoji(pos, view.players.length) };
  }

  function displayName(p) {
    return p.idx === view.meIdx && p.name !== 'Jij' ? p.name + ' (jij)' : p.name;
  }

  function render(v) {
    view = v;
    renderSidebar();
    renderOpponents();
    renderPile();
    renderHand();
    renderButtons();
  }

  function renderSidebar() {
    $('#round-label').textContent = 'RONDE ' + view.round + (view.code ? ' · ' + view.code : '');
    const info = $('#trick-info');
    if (!view.trick) {
      info.innerHTML = 'VRIJE SLAG<span class="sub">de leider mag alles spelen</span>';
      info.classList.add('free');
    } else {
      info.innerHTML = numWrap(
        `${view.trick.count}× lager dan <b>${view.trick.rank}</b>` +
        `<span class="sub">${RANK_INFO[view.trick.rank].emoji} ${RANK_INFO[view.trick.rank].name} ligt</span>`);
      info.classList.remove('free');
    }

    const ul = $('#standings');
    ul.innerHTML = '';
    for (const idx of view.order) {
      const p = P(idx);
      const role = roleOf(idx);
      const li = el('li', 'standing'
        + (view.turn === idx && !view.roundOver ? ' active' : '')
        + (p.finished ? ' done' : '')
        + (p.connected === false ? ' offline' : ''));
      li.innerHTML = `
        <span class="st-face">${p.face}</span>
        <span class="st-name">${displayName(p)}${p.connected === false ? ' ⚠' : ''}${role ? `<span class="st-role">${role.emoji} ${role.name}</span>` : ''}</span>
        <span class="st-cards">${p.finished ? '✔' : '🂠 ' + p.handCount}</span>
        <span class="st-score">${p.score}</span>`;
      ul.appendChild(li);
    }
  }

  function renderOpponents() {
    const box = $('#opponents');
    box.innerHTML = '';
    const mePos = view.order.indexOf(view.meIdx);
    for (let i = 1; i < view.order.length; i++) {
      const idx = view.order[(mePos + i) % view.order.length];
      if (idx === view.meIdx) continue;
      const p = P(idx);
      const role = roleOf(idx);
      const o = el('div', 'opponent'
        + (view.turn === idx && !view.roundOver ? ' active' : '')
        + (p.finished ? ' done' : '')
        + (p.connected === false ? ' offline' : ''));
      const backs = Math.min(p.handCount, 8);
      let fan = '';
      for (let b = 0; b < backs; b++) {
        fan += `<div class="mini-back" style="--i:${b};--n:${backs}"></div>`;
      }
      o.innerHTML = `
        <div class="opp-bubble ${bubbles.get(idx) ? '' : 'hidden'}">${bubbles.get(idx) || ''}</div>
        <div class="opp-avatar">${p.face}</div>
        <div class="opp-name">${p.name}${p.connected === false ? ' ⚠' : ''}</div>
        <div class="opp-role">${role ? role.emoji + ' ' + role.name : ''}</div>
        <div class="opp-fan">${p.finished ? '<span class="opp-done">KLAAR ✔</span>' : fan}</div>
        <div class="opp-count">${p.finished ? '' : numWrap(p.handCount) + ' kaarten'}</div>`;
      box.appendChild(o);
    }
  }

  function renderPile() {
    const pile = $('#pile');
    pile.innerHTML = '';
    const plays = view.pile.slice(-4);
    plays.forEach((play, pi) => {
      const isTop = pi === plays.length - 1;
      const group = el('div', 'pile-play' + (isTop ? ' top' : ''));
      group.style.setProperty('--depth', plays.length - 1 - pi);
      group.style.setProperty('--tilt', ((play.playerIdx * 7919) % 11 - 5) + 'deg');
      play.cards.forEach(card => group.appendChild(makeCardEl(card, { small: !isTop })));
      pile.appendChild(group);
    });
    const label = $('#pile-label');
    if (view.pile.length) {
      const last = view.pile[view.pile.length - 1];
      label.innerHTML = numWrap(`${last.count}× ${RANK_INFO[last.rank].name} — ${P(last.playerIdx).name}`);
    } else {
      label.textContent = view.roundOver ? '' : 'Nieuwe slag';
    }
  }

  function renderHand() {
    const hand = $('#hand');
    hand.innerHTML = '';
    const cards = view.myHand;
    const n = cards.length;
    cards.forEach((card, i) => {
      const c = makeCardEl(card);
      c.classList.add('in-hand');
      if (selected.has(card.id)) c.classList.add('selected');
      const mid = (n - 1) / 2;
      c.style.setProperty('--rot', ((i - mid) * Math.min(3, 40 / n)) + 'deg');
      c.style.setProperty('--lift', (Math.abs(i - mid) * Math.min(2.2, 30 / n)) + 'px');
      c.style.setProperty('--deal', i);
      c.addEventListener('click', () => {
        if (selected.has(card.id)) { selected.delete(card.id); sfx.deselect(); }
        else { selected.add(card.id); sfx.select(); }
        renderHand();
        renderButtons();
      });
      hand.appendChild(c);
    });
  }

  function selectedCards() {
    return view ? view.myHand.filter(c => selected.has(c.id)) : [];
  }

  function cardLabel(cards) {
    const sel = evalSelection(cards);
    return sel ? `${sel.count}× ${RANK_INFO[sel.rank].name}` : '?';
  }

  function renderButtons() {
    const play = $('#btn-play');
    const pass = $('#btn-pass');
    $('#turn-banner').classList.toggle('hidden', !canAct);
    const sel = selectedCards();
    const check = sel.length ? isValidPlay(sel, view && view.trick) : { ok: false };
    play.disabled = !canAct || !check.ok;
    pass.disabled = !canAct || !view || !view.trick; // leider moet spelen
    play.innerHTML = sel.length && check.ok ? numWrap(`SPEEL ${cardLabel(sel)}`) : 'SPEEL';
  }

  $('#btn-play').addEventListener('click', () => {
    if (!canAct) return;
    const sel = selectedCards();
    const check = isValidPlay(sel, view.trick);
    if (!check.ok) { sfx.bad(); popup(check.reason, 'warn'); shake(); return; }
    actions.onPlay && actions.onPlay(sel.map(c => c.id));
  });

  $('#btn-pass').addEventListener('click', () => {
    if (!canAct || !view.trick) return;
    actions.onPass && actions.onPass();
  });

  /* ================= GEDEELDE EVENT-EFFECTEN ================= */

  /* Verwerkt een actie-event (speler speelt/past/gaat uit/wint slag)
     met dezelfde pacing in single- en multiplayer. */
  async function handleActionEv(ev) {
    const actor = P(ev.actor);
    if (ev.passed) {
      bubbles.set(ev.actor, 'pas');
      if (ev.actor !== view.meIdx) sfx.pass();
      log(`${actor.face} ${actor.name} past.`);
    } else if (ev.count) {
      bubbles.delete(ev.actor);
      sfx.play();
      log(`${actor.face} <b>${actor.name}</b> speelt <b>${ev.count}× ${RANK_INFO[ev.rank].name}</b>`);
      if (ev.rank === 1) { popup('DE DALMUTI!', 'gold'); shake(); }
    }

    if (ev.finishedPos) {
      sfx.out();
      shake();
      const medal = ['🥇', '🥈', '🥉'][ev.finishedPos - 1] || '🏁';
      popup(`${medal} ${actor.name} is uit!`, ev.actor === view.meIdx ? 'gold' : '');
      log(`${medal} <b>${actor.name}</b> heeft geen kaarten meer! (${ev.finishedPos}e)`);
    }

    if (ev.trickWon !== undefined && ev.trickWon !== null) {
      await sleep(800);
      const winner = P(ev.trickWon);
      log(`✋ Iedereen past — slag voor <b>${winner.name}</b>.`);
      if (ev.leadPassedTo !== undefined && ev.leadPassedTo !== null) {
        log(`▶ <b>${P(ev.leadPassedTo).name}</b> neemt de leiding over.`);
      }
      bubbles.clear();
      popup('SLAG GEWONNEN', ev.trickWon === view.meIdx ? 'gold' : '');
      renderOpponents();
      await sleep(400);
    }
  }

  /* ================= OVERLAYS ================= */

  function showOverlay(html) {
    const panel = $('#overlay-panel');
    panel.innerHTML = html;
    $('#overlay').classList.remove('hidden');
    return panel;
  }
  function hideOverlay() { $('#overlay').classList.add('hidden'); }

  function askRevolution(isGroteSloeber) {
    return new Promise(resolve => {
      const panel = showOverlay(`
        <div class="panel-label">🃏🃏 BEIDE NARREN!</div>
        <p class="overlay-text">Je hebt beide narren in je hand.<br>Roep je de <b>revolutie</b> uit? Dan wordt er<br>deze ronde geen belasting geheven${isGroteSloeber ? ' —<br>en als Grote Sloeber draai je zelfs<br><b>alle rollen om</b>!' : '.'}</p>
        <div class="overlay-buttons">
          <button class="btn btn-red btn-big" id="ov-yes">REVOLUTIE!</button>
          <button class="btn btn-blue" id="ov-no">Nee, laat maar</button>
        </div>`);
      panel.querySelector('#ov-yes').onclick = () => { hideOverlay(); resolve(true); };
      panel.querySelector('#ov-no').onclick = () => { hideOverlay(); resolve(false); };
    });
  }

  function askGiveBack(k, receiverName, hand) {
    return new Promise(resolve => {
      const picked = new Set();
      const panel = showOverlay(`
        <div class="panel-label">💰 BELASTING</div>
        <p class="overlay-text">Kies <b class="num">${k}</b> kaart${k > 1 ? 'en' : ''} om terug te geven aan <b>${receiverName}</b>.</p>
        <div class="overlay-hand" id="ov-hand"></div>
        <div class="overlay-buttons">
          <button class="btn btn-orange btn-big" id="ov-give" disabled>GEEF ${k} KAART${k > 1 ? 'EN' : ''}</button>
        </div>`);
      const handBox = panel.querySelector('#ov-hand');
      const giveBtn = panel.querySelector('#ov-give');
      hand.forEach(card => {
        const c = makeCardEl(card, { small: true });
        c.classList.add('pickable');
        c.onclick = () => {
          if (picked.has(card.id)) { picked.delete(card.id); c.classList.remove('selected'); sfx.deselect(); }
          else if (picked.size < k) { picked.add(card.id); c.classList.add('selected'); sfx.select(); }
          giveBtn.disabled = picked.size !== k;
        };
        handBox.appendChild(c);
      });
      giveBtn.onclick = () => { hideOverlay(); resolve([...picked]); };
    });
  }

  /* rows: [{face,name,role,emoji,pts,score,me}]
     opts.canContinue: toon "volgende ronde"-knop (host of singleplayer).
     Resolves met 'next' of 'stop'. Bij een wachtende niet-host sluit de
     server de overlay via hideOverlay() zodra de ronde start. */
  function showRoundEnd(rows, headline, opts = {}) {
    return new Promise(resolve => {
      const rowHtml = rows.map(r => `
        <li class="result-row ${r.me ? 'me' : ''}">
          <span class="res-pos">${r.emoji}</span>
          <span class="res-name">${r.face} ${r.name}</span>
          <span class="res-role">${r.role}</span>
          <span class="res-pts">+${r.pts}</span>
          <span class="res-score">${r.score}</span>
        </li>`).join('');
      const buttons = opts.canContinue
        ? `<button class="btn btn-orange btn-big" id="ov-next">VOLGENDE RONDE</button>
           <button class="btn btn-red" id="ov-stop">STOPPEN</button>`
        : `<div class="lobby-hint">Wachten tot de host verder gaat…</div>
           <button class="btn btn-red" id="ov-stop">VERLATEN</button>`;
      const panel = showOverlay(`
        <div class="panel-label">${headline}</div>
        <ul class="results">
          <li class="result-head"><span class="res-pos"></span><span class="res-name">Speler</span><span class="res-role">Nieuwe rol</span><span class="res-pts">Punten</span><span class="res-score">Totaal</span></li>
          ${rowHtml}
        </ul>
        <div class="overlay-buttons">${buttons}</div>`);
      const next = panel.querySelector('#ov-next');
      if (next) next.onclick = () => { hideOverlay(); resolve('next'); };
      panel.querySelector('#ov-stop').onclick = () => { hideOverlay(); resolve('stop'); };
    });
  }

  /* ================= SCHERMEN & DIVERSEN ================= */

  function showScreen(name) {
    for (const s of ['start', 'lobby', 'game']) {
      $('#screen-' + s).classList.toggle('hidden', s !== name);
    }
  }

  function markDealing() {
    const handBox = $('#hand');
    handBox.classList.add('dealing');
    setTimeout(() => handBox.classList.remove('dealing'), 1800);
  }

  function headlineFor(mePos, n, round) {
    if (mePos === 0) return '👑 JIJ BENT DE GROTE DALMUTI!';
    if (mePos === n - 1) return '💩 JIJ BENT DE GROTE SLOEBER...';
    return 'RONDE ' + round + ' VOORBIJ';
  }

  $('#btn-sound').addEventListener('click', () => {
    $('#btn-sound').textContent = sfx.toggle() ? '🔊' : '🔇';
  });

  // Mobiel: spelers/logboek als uitklapbaar paneel
  $('#btn-panels').addEventListener('click', () => {
    const open = document.body.classList.toggle('panels-open');
    $('#btn-panels').textContent = open ? '✕' : '☰';
  });

  return {
    $, el, sleep, sfx, popup, shake, log, clearLog, makeCardEl,
    render, handleActionEv, headlineFor,
    setActions(a) { actions = a; },
    setCanAct(b) { canAct = b; renderButtons(); },
    clearSelection() { selected.clear(); },
    setBubble(idx, text) { text ? bubbles.set(idx, text) : bubbles.delete(idx); },
    clearBubbles() { bubbles.clear(); },
    getView() { return view; },
    showOverlay, hideOverlay, askRevolution, askGiveBack, showRoundEnd,
    showScreen, markDealing,
  };
})();

/* ================= SINGLEPLAYER-CONTROLLER ================= */

const Solo = (() => {
  const { sleep, popup, log } = UI;
  let game = null;
  let humanResolver = null;

  function buildView() {
    return {
      mode: 'single',
      round: game.round,
      roundOver: game.roundOver,
      meIdx: 0,
      turn: game.turn,
      trick: game.trick,
      pile: game.pile,
      order: game.order,
      finishedOrder: game.finishedOrder,
      hasRoles: game.round >= 2 || game.roundOver,
      players: game.players.map(p => ({
        idx: p.idx, name: p.name, face: p.face, handCount: p.hand.length,
        score: p.score, finished: p.finished, connected: true,
      })),
      myHand: game.players[0].hand,
    };
  }

  const R = () => UI.render(buildView());

  function start(numPlayers) {
    game = new Game(numPlayers);
    UI.setActions({
      onPlay(ids) {
        if (!humanResolver) return;
        const events = game.play(0, ids);
        if (!events.ok) { UI.sfx.bad(); popup(events.reason, 'warn'); UI.shake(); return; }
        events.actor = 0;
        finishHumanTurn(events);
      },
      onPass() {
        if (!humanResolver || !game.trick) return;
        const events = game.pass(0);
        events.actor = 0;
        finishHumanTurn(events);
      },
    });
    UI.clearLog();
    UI.showScreen('game');
    startRound();
  }

  function finishHumanTurn(events) {
    UI.clearSelection();
    UI.setCanAct(false);
    const resolve = humanResolver;
    humanResolver = null;
    resolve(events);
  }

  function humanTurn() {
    return new Promise(resolve => {
      humanResolver = resolve;
      UI.setCanAct(true);
    });
  }

  async function startRound() {
    UI.clearBubbles();
    UI.clearSelection();
    game.deal();
    UI.markDealing();
    R();
    UI.sfx.deal();
    popup('RONDE ' + game.round, 'big');
    log(`<b>— Ronde ${game.round} —</b>`);
    await sleep(900);

    // Revolutie?
    const holder = game.jokerHolder();
    if (holder) {
      let calls = false;
      if (holder.isHuman) calls = await UI.askRevolution(game.order.indexOf(0) === game.n - 1);
      else calls = game.botWantsRevolution(holder.idx);
      if (calls) {
        game.callRevolution(holder.idx);
        UI.sfx.revolution();
        UI.shake(true);
        if (game.revolution === 'groot') {
          popup('GROTE REVOLUTIE!', 'big red');
          log(`🃏🃏 <b>${holder.name}</b> roept de <b>GROTE REVOLUTIE</b> uit — alle rollen draaien om!`);
        } else {
          popup('REVOLUTIE!', 'big red');
          log(`🃏🃏 <b>${holder.name}</b> roept de revolutie uit — geen belasting deze ronde!`);
        }
        R();
        await sleep(1200);
      }
    }

    // Belasting
    const tax = game.taxation();
    if (tax) {
      for (const f of tax.flows) {
        const from = game.player(f.from), to = game.player(f.to);
        log(`💰 <b>${from.name}</b> geeft ${f.cards.map(c => RANK_INFO[c.rank].name).join(', ')} aan <b>${to.name}</b> (${f.dir})`);
      }
      R();
      for (const pend of tax.pendingHuman) {
        const recv = game.player(pend.receiver);
        const ids = await UI.askGiveBack(pend.k, recv.name, game.players[0].hand);
        const cards = game.giveBack(pend.giver, ids, pend.receiver);
        log(`💰 <b>Jij</b> geeft ${cards.map(c => RANK_INFO[c.rank].name).join(', ')} terug aan <b>${recv.name}</b>`);
        R();
      }
      popup('BELASTING GEHEVEN', '');
      await sleep(700);
    }

    log(`▶ <b>${game.player(game.turn).name}</b> mag beginnen.`);
    gameLoop();
  }

  async function gameLoop() {
    while (!game.roundOver) {
      R();
      const p = game.player(game.turn);
      let events;
      if (p.isHuman) {
        events = await humanTurn();
      } else {
        await sleep(600 + Math.random() * 500);
        const ids = game.botDecide(p.idx);
        events = ids ? game.play(p.idx, ids) : game.pass(p.idx);
        events.actor = p.idx;
      }
      R();
      await UI.handleActionEv(events);
    }
    R();
    await sleep(1000);
    UI.sfx.win();

    const rows = game.finishedOrder.map((idx, pos) => {
      const p = game.player(idx);
      return {
        face: p.face, name: p.name, me: p.isHuman,
        emoji: roleEmoji(pos, game.n), role: roleName(pos, game.n),
        pts: game.n - 1 - pos, score: p.score,
      };
    });
    const headline = UI.headlineFor(game.finishedOrder.indexOf(0), game.n, game.round);
    const choice = await UI.showRoundEnd(rows, headline, { canContinue: true });
    if (choice === 'next') startRound();
    else backToStart();
  }

  function backToStart() {
    humanResolver = null;
    game = null;
    UI.setCanAct(false);
    UI.showScreen('start');
  }

  return { start, backToStart, get active() { return game !== null; } };
})();

/* ================= STARTSCHERM ================= */

(() => {
  const $ = UI.$;
  let numPlayers = 5;

  document.querySelectorAll('.seg-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      numPlayers = parseInt(b.dataset.n, 10);
      UI.sfx.select();
    });
  });

  $('#btn-start').addEventListener('click', () => {
    UI.sfx.play();
    Solo.start(numPlayers);
  });

  $('#btn-newgame').addEventListener('click', () => {
    if (!confirm('Terug naar het hoofdmenu? De huidige stand gaat verloren.')) return;
    if (typeof Net !== 'undefined' && Net.active) Net.leave();
    else Solo.backToStart();
    UI.setCanAct(false);
    UI.showScreen('start');
  });

  // Titel: elke letter een eigen wiebel (Balatro-titel-effect)
  const t = $('#title');
  const text = t.textContent;
  t.innerHTML = '';
  [...text].forEach((ch, i) => {
    if (ch === ' ') { t.appendChild(document.createTextNode(' ')); return; }
    const s = UI.el('span', 'tletter', ch);
    s.style.animationDelay = (i * 0.09) + 's';
    t.appendChild(s);
  });
})();
