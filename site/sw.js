/* 离线缓存：首次打开后把页面骨架、样式、脚本、数据和场景图存下来，
   之后断网也能翻已缓存的内容。改动本文件时把 CACHE 的版本号 +1，
   旧缓存会在 activate 阶段清掉。 */
var CACHE = 'live-archive-v1';
var SCOPE = self.registration.scope;

var PRECACHE = [
  SCOPE,
  SCOPE + 'index.html',
  SCOPE + 'assets/style.css',
  SCOPE + 'assets/app.js',
  SCOPE + 'assets/data.js',
  SCOPE + 'brand/scene-spring.webp',
  SCOPE + 'brand/home-night.webp',
  SCOPE + 'manifest.webmanifest'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 单个资源失败不拖累整体：比如本地预览时还没有 audio/ 目录
      return Promise.all(PRECACHE.map(function (u) {
        return c.add(u).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  // 页面导航：优先拿最新的 index.html，断网时回落到缓存的入口。
  // 站内是 hash 路由，点导航不会发请求，所以这里只管整页刷新。
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(SCOPE, copy); });
        return res;
      }).catch(function () {
        return caches.match(SCOPE).then(function (hit) {
          return hit || caches.match(SCOPE + 'index.html');
        });
      })
    );
    return;
  }

  // 其余同源资源：命中缓存先给旧值，后台再去拿新的（stale-while-revalidate）。
  // data.js 内容变了会由 index.html 上的 ?v= 换 URL，不会一直吃旧数据。
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
