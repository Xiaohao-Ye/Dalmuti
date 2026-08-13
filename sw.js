/* De Grote Dalmuti — service worker.
   App-shell: stale-while-revalidate (direct laden, op de achtergrond verversen).
   Fonts: cache-first. Singleplayer werkt hierdoor volledig offline. */
'use strict';

const CACHE = 'dalmuti-v2';
const CORE = [
  './',
  'style.css',
  'icon.svg',
  'manifest.webmanifest',
  'js/bg.js',
  'js/music.js',
  'js/game.js',
  'js/ui.js',
  'js/net.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Google Fonts: cache-first (veranderen nooit)
  if (url.hostname.endsWith('googleapis.com') || url.hostname.endsWith('gstatic.com')) {
    e.respondWith(
      caches.open(CACHE).then(async c => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // Eigen bestanden: uit cache serveren, op de achtergrond verversen
  e.respondWith(
    caches.open(CACHE).then(async c => {
      const hit = await c.match(e.request);
      const refresh = fetch(e.request)
        .then(res => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || refresh;
    })
  );
});
