/* De Grote Dalmuti — spellogica en bot-AI (geen DOM). */
'use strict';

const JOKER = 13;

const RANK_INFO = {
  1:  { name: 'Dalmuti',       emoji: '👑' },
  2:  { name: 'Aartsbisschop', emoji: '⚜️' },
  3:  { name: 'Opperrechter',  emoji: '⚖️' },
  4:  { name: 'Barones',       emoji: '💍' },
  5:  { name: 'Abdis',         emoji: '📿' },
  6:  { name: 'Ridder',        emoji: '⚔️' },
  7:  { name: 'Naaister',      emoji: '🪡' },
  8:  { name: 'Metselaar',     emoji: '🧱' },
  9:  { name: 'Kok',           emoji: '🍲' },
  10: { name: 'Schaapherder',  emoji: '🐑' },
  11: { name: 'Steenhouwer',   emoji: '⛏️' },
  12: { name: 'Boer',          emoji: '🌾' },
  13: { name: 'Nar',           emoji: '🃏' },
};

// Kaartkleuren per rang (accentkleur op de kaart)
const RANK_COLORS = {
  1:  '#c9920e', 2: '#8e44ad', 3: '#7d3c98', 4: '#c0392b',
  5:  '#a93226', 6: '#2471a3', 7: '#2e86c1', 8: '#1e8449',
  9:  '#239b56', 10: '#8a6d3b', 11: '#6e6e6e', 12: '#7b5e3b',
  13: '#e0245e',
};

const BOT_NAMES = ['Jimbo', 'Baron', 'Mime', 'Fibonacci', 'Canio', 'Yorick'];
const BOT_FACES = ['🤡', '🎩', '🎭', '🐰', '🦁', '💀'];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck() {
  const deck = [];
  let id = 0;
  for (let rank = 1; rank <= 12; rank++) {
    for (let k = 0; k < rank; k++) deck.push({ id: id++, rank });
  }
  deck.push({ id: id++, rank: JOKER });
  deck.push({ id: id++, rank: JOKER });
  return deck;
}

function sortHand(hand) {
  hand.sort((a, b) => a.rank - b.rank || a.id - b.id);
}

/* Bepaal (rang, aantal) van een selectie. Narren zijn wild:
   - alleen narren  -> rang 13
   - narren + kaarten van rang r -> alles telt als rang r
   Retourneert null bij een ongeldige mix. */
function evalSelection(cards) {
  if (!cards.length) return null;
  const normal = cards.filter(c => c.rank !== JOKER);
  const jokers = cards.length - normal.length;
  if (normal.length === 0) return { rank: JOKER, count: jokers, jokers };
  const rank = normal[0].rank;
  if (normal.some(c => c.rank !== rank)) return null;
  return { rank, count: cards.length, jokers };
}

/* Mag deze selectie gespeeld worden op de huidige slag? */
function isValidPlay(cards, trick) {
  const sel = evalSelection(cards);
  if (!sel) return { ok: false, reason: 'Kies kaarten van één rang (narren zijn wild).' };
  if (!trick) return { ok: true, sel }; // vrije slag: alles mag
  if (sel.count !== trick.count)
    return { ok: false, reason: `Je moet precies ${trick.count} kaart${trick.count > 1 ? 'en' : ''} spelen.` };
  if (sel.rank >= trick.rank)
    return { ok: false, reason: `Alleen een lagere rang dan ${trick.rank} (${RANK_INFO[trick.rank].name}) mag.` };
  return { ok: true, sel };
}

function roleName(pos, n) {
  if (pos === 0) return 'Grote Dalmuti';
  if (pos === 1) return 'Kleine Dalmuti';
  if (pos === n - 1) return 'Grote Sloeber';
  if (pos === n - 2) return 'Kleine Sloeber';
  return 'Handelaar';
}

function roleEmoji(pos, n) {
  if (pos === 0) return '👑';
  if (pos === 1) return '🎖️';
  if (pos === n - 1) return '💩';
  if (pos === n - 2) return '🥾';
  return '⚖️';
}

class Game {
  /* spec: aantal spelers (singleplayer: mens + bots) of een array
     van {name, face, isHuman} (multiplayer: door de server bepaald). */
  constructor(spec) {
    let specs;
    if (typeof spec === 'number') {
      specs = [{ name: 'Jij', face: '🙂', isHuman: true }];
      const names = shuffle(BOT_NAMES.map((nm, i) => ({ nm, face: BOT_FACES[i] }))).slice(0, spec - 1);
      for (let i = 1; i < spec; i++) {
        specs.push({ name: names[i - 1].nm, face: names[i - 1].face, isHuman: false });
      }
    } else {
      specs = spec;
    }
    this.n = specs.length;
    this.players = specs.map((s, i) => ({
      idx: i, name: s.name, face: s.face, isHuman: !!s.isHuman,
      hand: [], score: 0, finished: false,
    }));
    this.round = 0;
    this.order = shuffle(this.players.map(p => p.idx)); // stoelvolgorde (rangorde vanaf ronde 2)
    this.roles = null;          // idx -> positie (0 = Grote Dalmuti), null in ronde 1
    this.finishedOrder = [];
    this.trick = null;          // { rank, count, lastPlayer }
    this.pile = [];             // gespeelde setjes deze slag [{playerIdx, cards, rank, count}]
    this.turn = null;           // speler-idx aan de beurt
    this.passes = 0;
    this.revolution = null;     // null | 'gewoon' | 'groot'
    this.roundOver = false;
  }

  player(idx) { return this.players[idx]; }
  activePlayers() { return this.players.filter(p => !p.finished); }

  /* ---------- ronde-opbouw ---------- */

  deal() {
    this.round++;
    this.finishedOrder = [];
    this.trick = null;
    this.pile = [];
    this.passes = 0;
    this.revolution = null;
    this.roundOver = false;
    this.players.forEach(p => { p.hand = []; p.finished = false; });

    const deck = shuffle(buildDeck());
    // Delen vanaf de Grote Dalmuti (order[0]) — ongelijke handen horen erbij
    let seat = 0;
    for (const card of deck) {
      this.player(this.order[seat % this.n]).hand.push(card);
      seat++;
    }
    this.players.forEach(p => sortHand(p.hand));
    this.turn = this.order[0];
  }

  /* Wie heeft beide narren? (voor revolutie, alleen relevant vanaf ronde 2) */
  jokerHolder() {
    if (this.round < 2) return null;
    for (const p of this.players) {
      if (p.hand.filter(c => c.rank === JOKER).length === 2) return p;
    }
    return null;
  }

  callRevolution(playerIdx) {
    const pos = this.order.indexOf(playerIdx);
    if (pos === this.n - 1) {
      // Grote Sloeber: GROTE revolutie — alle rollen draaien om
      this.order = [...this.order].reverse();
      this.turn = this.order[0];
      this.revolution = 'groot';
    } else {
      this.revolution = 'gewoon';
    }
  }

  /* Belasting: sloebers dragen automatisch hun beste kaarten af.
     Retourneert info zodat de UI kan tonen wat er gebeurde en welke
     teruggave nog een menselijke keuze vereist. */
  taxation() {
    if (this.round < 2 || this.revolution) return null;
    const gd = this.player(this.order[0]);
    const kd = this.player(this.order[1]);
    const gs = this.player(this.order[this.n - 1]);
    const ks = this.player(this.order[this.n - 2]);

    const takeBest = (p, k) => {
      sortHand(p.hand);
      return p.hand.splice(0, k); // laagste nummers = beste kaarten (nar=13 telt nooit mee)
    };

    const result = { flows: [], pendingHuman: [] };

    const collect = (from, to, k) => {
      const cards = takeBest(from, k);
      to.hand.push(...cards);
      sortHand(to.hand);
      result.flows.push({ from: from.idx, to: to.idx, cards, dir: 'belasting' });
      // teruggave
      if (to.isHuman) {
        result.pendingHuman.push({ giver: to.idx, receiver: from.idx, k });
      } else {
        const back = this.botGiveBack(to, k);
        from.hand.push(...back);
        sortHand(from.hand);
        result.flows.push({ from: to.idx, to: from.idx, cards: back, dir: 'teruggave' });
      }
    };

    collect(gs, gd, 2);
    collect(ks, kd, 1);
    return result;
  }

  /* Dalmuti (bot) geeft zijn slechtste niet-nar-kaarten terug */
  botGiveBack(p, k) {
    sortHand(p.hand);
    const nonJokers = p.hand.filter(c => c.rank !== JOKER);
    const chosen = nonJokers.slice(-k);
    const ids = new Set(chosen.map(c => c.id));
    p.hand = p.hand.filter(c => !ids.has(c.id));
    return chosen;
  }

  giveBack(giverIdx, cardIds, receiverIdx) {
    const giver = this.player(giverIdx);
    const ids = new Set(cardIds);
    const cards = giver.hand.filter(c => ids.has(c.id));
    giver.hand = giver.hand.filter(c => !ids.has(c.id));
    const recv = this.player(receiverIdx);
    recv.hand.push(...cards);
    sortHand(recv.hand);
    return cards;
  }

  /* ---------- spelen ---------- */

  nextActiveAfter(idx) {
    const pos = this.order.indexOf(idx);
    for (let i = 1; i <= this.n; i++) {
      const p = this.player(this.order[(pos + i) % this.n]);
      if (!p.finished) return p.idx;
    }
    return null;
  }

  /* Speel kaarten. Retourneert events voor de UI. */
  play(playerIdx, cardIds) {
    const p = this.player(playerIdx);
    const ids = new Set(cardIds);
    const cards = p.hand.filter(c => ids.has(c.id));
    const check = isValidPlay(cards, this.trick);
    if (!check.ok) return { ok: false, reason: check.reason };

    p.hand = p.hand.filter(c => !ids.has(c.id));
    this.trick = { rank: check.sel.rank, count: check.sel.count, lastPlayer: playerIdx };
    this.pile.push({ playerIdx, cards, rank: check.sel.rank, count: check.sel.count });
    this.passes = 0;

    const events = { ok: true, cards, rank: check.sel.rank, count: check.sel.count };

    if (p.hand.length === 0) {
      p.finished = true;
      this.finishedOrder.push(playerIdx);
      events.finishedPos = this.finishedOrder.length;
      if (this.activePlayers().length === 1) {
        const last = this.activePlayers()[0];
        last.finished = true;
        this.finishedOrder.push(last.idx);
        this.endRound();
        events.roundOver = true;
        return events;
      }
    }

    this.turn = this.nextActiveAfter(playerIdx);
    this.checkTrickEnd(events);
    return events;
  }

  pass(playerIdx) {
    this.passes++;
    const events = { ok: true, passed: true };
    this.turn = this.nextActiveAfter(playerIdx);
    this.checkTrickEnd(events);
    return events;
  }

  /* Slag voorbij? Iedereen gepast sinds de laatste speelbeurt. */
  checkTrickEnd(events) {
    if (!this.trick) return;
    const lastP = this.player(this.trick.lastPlayer);
    if (!lastP.finished) {
      if (this.turn === this.trick.lastPlayer) {
        events.trickWon = this.trick.lastPlayer;
        this.clearTrick();
      }
    } else {
      // Winnaar is al uit: als alle actieve spelers gepast hebben, gaat
      // de leiding naar de eerstvolgende actieve speler na de winnaar.
      if (this.passes >= this.activePlayers().length) {
        const heir = this.nextActiveAfter(this.trick.lastPlayer);
        events.trickWon = this.trick.lastPlayer;
        events.leadPassedTo = heir;
        this.clearTrick();
        this.turn = heir;
      }
    }
  }

  clearTrick() {
    this.trick = null;
    this.pile = [];
    this.passes = 0;
  }

  endRound() {
    this.roundOver = true;
    // Nieuwe rangorde = volgorde van uitkomen
    this.order = [...this.finishedOrder];
    this.roles = {};
    this.finishedOrder.forEach((idx, pos) => {
      this.roles[idx] = pos;
      this.player(idx).score += (this.n - 1 - pos);
    });
  }

  /* ---------- bot-AI ---------- */

  /* Alle speelbare setjes voor een hand, gegeven de huidige slag. */
  candidateSets(hand, trick) {
    const groups = new Map();
    const jokers = hand.filter(c => c.rank === JOKER);
    for (const c of hand) {
      if (c.rank === JOKER) continue;
      if (!groups.has(c.rank)) groups.set(c.rank, []);
      groups.get(c.rank).push(c);
    }
    const out = [];
    if (!trick) {
      // Vrije slag: per rang de volledige groep (evt. één variant met narren erbij)
      for (const [rank, cards] of groups) {
        out.push({ rank, cards: [...cards], jokersUsed: 0, groupSize: cards.length });
      }
      if (jokers.length) out.push({ rank: JOKER, cards: [...jokers], jokersUsed: jokers.length, groupSize: jokers.length });
    } else {
      const k = trick.count;
      for (const [rank, cards] of groups) {
        if (rank >= trick.rank) continue;
        if (cards.length >= k) {
          out.push({ rank, cards: cards.slice(0, k), jokersUsed: 0, groupSize: cards.length });
        } else if (cards.length + jokers.length >= k) {
          out.push({
            rank,
            cards: [...cards, ...jokers.slice(0, k - cards.length)],
            jokersUsed: k - cards.length,
            groupSize: cards.length,
          });
        }
      }
      if (JOKER < trick.rank && jokers.length >= k) {
        // kan niet: JOKER=13 is nooit lager, maar voor de volledigheid
        out.push({ rank: JOKER, cards: jokers.slice(0, k), jokersUsed: k, groupSize: jokers.length });
      }
    }
    return out;
  }

  /* Kies een zet voor de bot. Retourneert cardIds of null (=passen). */
  botDecide(playerIdx) {
    const p = this.player(playerIdx);
    const options = this.candidateSets(p.hand, this.trick);
    if (!options.length) return null;

    if (!this.trick) {
      // Leiden: dump de grootste groep met de hoogste (slechtste) rang.
      // Laat lage kaarten (goud) zitten voor later.
      let best = null, bestScore = -Infinity;
      for (const o of options) {
        if (o.rank === JOKER && p.hand.length > o.cards.length) continue; // narren bewaren
        const score = o.cards.length * 20 + o.rank;
        if (score > bestScore) { bestScore = score; best = o; }
      }
      if (!best) best = options[0];
      return best.cards.map(c => c.id);
    }

    // Volgen: kies de hoogste rang die nog wint (spaar goede kaarten),
    // vermijd narren en het breken van grote groepen.
    let best = null, bestScore = -Infinity;
    for (const o of options) {
      let score = o.rank * 10;
      score -= o.jokersUsed * 45;
      if (o.groupSize > this.trick.count) score -= (o.groupSize - this.trick.count) * 12; // groep breken
      if (o.cards.length === p.hand.length) score += 200; // hand leegspelen: altijd doen!
      if (score > bestScore) { bestScore = score; best = o; }
    }

    // Strategisch passen: hele goede kaarten (1-3) niet te vroeg weggeven
    if (best && best.rank <= 3 && p.hand.length > 6 && best.cards.length < p.hand.length) {
      if (Math.random() < 0.5) return null;
    }
    return best ? best.cards.map(c => c.id) : null;
  }

  /* Roept de bot revolutie uit? Alleen zinvol voor lage rangen. */
  botWantsRevolution(playerIdx) {
    const pos = this.order.indexOf(playerIdx);
    return pos >= Math.ceil(this.n / 2);
  }
}

/* Export voor Node (de server draait dezelfde spellogica) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Game, JOKER, RANK_INFO, RANK_COLORS, BOT_NAMES, BOT_FACES,
    buildDeck, shuffle, sortHand, evalSelection, isValidPlay,
    roleName, roleEmoji,
  };
}
