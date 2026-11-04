const CACHE_NAME = 'bem-de-colo-family-sync-v2';
const SUPABASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const ASSETS = ['./','./index.html','./styles.css','./app.js','./supabase-config.js','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  if(event.request.method !== 'GET') return;
  // Mantém em cache somente o SDK público que o app usa para login/sincronização.
  if(event.request.url === SUPABASE_SDK_URL){
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      caches.open(CACHE_NAME).then(cache => cache.put(event.request,response.clone())).catch(()=>{});
      return response;
    })));
    return;
  }
  // Não intercepta Supabase, APIs externas ou outras respostas JSON.
  if(new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)).catch(()=>{});
    return response;
  }).catch(() => caches.match('./index.html'))));
});
