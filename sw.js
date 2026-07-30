// GestoPro Service Worker
const CACHE = 'gestopro-v5';
const ASSETS = ['/app/', '/app/index.html'];
self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(cache){
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); }));
    })
  );
  self.clients.claim();
});
self.addEventListener('fetch', function(e){
  if(e.request.method!=='GET') return;
  e.respondWith(
    fetch(e.request).catch(function(){
      return caches.match(e.request).then(function(r){
        return r || caches.match('/app/');
      });
    })
  );
});
