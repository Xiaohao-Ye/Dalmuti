# De Grote Dalmuti

Webversie van het kaartspel De Grote Dalmuti in de grafische stijl van Balatro.
Singleplayer tegen bots én online multiplayer met vrienden.

## Singleplayer

Geen installatie nodig: open `index.html` in een browser en kies "Tegen bots".

## Multiplayer (zelf hosten)

```
npm install
npm start
```

Open daarna `http://localhost:8321`, vul je naam in en maak een kamer.
Deel de 4-letterige code met je vrienden. De host kan bots toevoegen om
lege stoelen te vullen (minimaal 4, maximaal 7 spelers).

De server is autoritair: clients sturen alleen intenties, de server valideert
elke zet en stuurt per speler een persoonlijke snapshot (alleen je eigen hand,
van anderen enkel aantallen).

### Reconnect

Elke speler krijgt een geheim token (in `localStorage`). Valt je verbinding
weg, dan probeert de client automatisch opnieuw te verbinden en krijg je je
stoel en hand terug. Zolang je weg bent speelt de bot-strategie je beurten.
Wie bewust op "Verlaten" klikt is definitief weg; een bot maakt de hand af.

### Publiek bereikbaar maken

Zet een reverse proxy met TLS voor de Node-poort, bijvoorbeeld met Caddy:

```
speel.example.nl {
    reverse_proxy localhost:8321
}
```

WebSockets worden automatisch mee geproxied. Draai het proces onder systemd
of Docker met auto-restart. Er is geen database: kamers leven in het geheugen
en verdwijnen 10 minuten nadat de laatste speler de verbinding verbrak.

## Bestanden

| Bestand | Rol |
|---|---|
| `js/game.js` | Spelregels, validatie en bot-AI — draait in de browser (singleplayer) én in Node (multiplayer) |
| `js/ui.js` | View-laag (rendert snapshots) + singleplayer-controller |
| `js/net.js` | Multiplayer-client: WebSocket, lobby, reconnect |
| `js/bg.js` | Balatro-swirl achtergrond (WebGL-shader) |
| `server/server.js` | Statische bestanden + WebSocket-server met kamers |

## Spelregels in het kort

- 80 kaarten: rang 1 (Dalmuti, 1×) t/m 12 (Boer, 12×) plus twee Narren (wild).
- Lagere nummers zijn beter. De leider speelt een setje gelijke kaarten;
  volgende spelers moeten hetzelfde áántal in een lagere rang spelen of passen.
- Wie het eerst zijn hand leeg speelt wordt de Grote Dalmuti; de laatste de
  Grote Sloeber. Sloebers betalen aan het begin van elke ronde belasting
  (hun beste kaarten) aan de Dalmuti's.
- Wie beide Narren krijgt mag revolutie uitroepen: geen belasting. Doet de
  Grote Sloeber dat, dan draaien zelfs alle rollen om.
