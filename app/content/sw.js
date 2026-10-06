/* Service worker: makes the app installable and lets the shell open offline.
 *
 * Data is never cached - /api requests always go to the network, so the list
 * you see is either live or an explicit "you are offline" message.
 */
const CACHE = 'shopping-list-v29';
// custom.css / script.js are versioned (?v=N) and cached on demand by the fetch
// handler, so they are deliberately not precached here under bare paths.
const SHELL = [
    '/icon.svg',
    '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(SHELL))
            .then(() => self.skipWaiting())
            .catch(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/') || url.pathname === '/login' || url.pathname === '/logout') return;

    // Pages: network first, fall back to the last good copy when offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(CACHE).then((cache) => cache.put('/', copy));
                    return response;
                })
                .catch(() => caches.match('/').then((cached) => cached || Response.error()))
        );
        return;
    }

    // Static assets: serve from cache, refresh in the background.
    //
    // The query string (?v=N) is part of the cache key on purpose: a version
    // bump becomes a fresh URL, so a new build is fetched instead of the old
    // copy being served forever. (Matching with ignoreSearch was the bug that
    // kept serving a stale script.js and custom.css after an update.)
    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request)
                .then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached);

            return cached || network;
        })
    );
});
