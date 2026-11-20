// オフライン対応：ネットワーク優先、つながらない時はキャッシュを使う
// アプリ本体を更新したら CACHE の番号を上げてください（単語データだけの更新なら不要）
const CACHE = 'rf-v14';
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'data/words.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    // 単語の音声ファイルもオフライン用に保存（ない単語は無視）
    try {
      const words = await (await cache.match('data/words.json')).json();
      await Promise.allSettled(words.flatMap((w) => [
        cache.add(`audio/${encodeURIComponent(w.id)}.mp3`),
        cache.add(`audio/ex/${encodeURIComponent(w.id)}.mp3`),
      ]));
    } catch (err) { /* 音声なしでも動く */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // 電波が弱い時に待たされすぎないよう4秒でキャッシュに切り替え
      const res = await Promise.race([
        fetch(req, { cache: 'no-cache' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      if (res.status === 200) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return cache.match('index.html');
      throw err;
    }
  })());
});
