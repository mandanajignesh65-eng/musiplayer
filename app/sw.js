// Service worker. It does two jobs:
// 1. Streams songs: the audio player asks for "stream/<Drive file id>", and this adds your Google sign-in
//    to the request and passes it to Drive. Browsers cannot add a sign-in to audio requests themselves.
// 2. Keeps a copy of the app's own files, so the app opens even with a weak connection.
import { getToken } from './auth.js';

const SHELL = 'shell-v1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'auth.js', 'drive.js', 'config.js', 'manifest.webmanifest', 'icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;
  const match = url.pathname.match(/\/stream\/([\w-]+)$/);
  if (match) {
    event.respondWith(stream(match[1], event.request.headers.get('range')));
    return;
  }
  // Newest version from the network first; the saved copy only when offline.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(event.request, copy)); }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});

async function stream(fileId, range) {
  let res;
  for (const force of [false, true]) {
    let token;
    try {
      token = await getToken({ force });
    } catch (err) {
      return new Response(err.message, { status: 401 });
    }
    const headers = { Authorization: `Bearer ${token}` };
    if (range) headers.Range = range;
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });
    if (res.status !== 401) break;
  }
  return res;
}
