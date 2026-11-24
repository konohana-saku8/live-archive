/* 离线缓存：首次打开后把页面骨架、样式、脚本、数据和场景图存下来，
   之后断网也能翻已缓存的内容。改动本文件时把 CACHE 的版本号 +1，
   旧缓存会在 activate 阶段清掉。 */
var CACHE = 'live-archive-v3';
var SCOPE = self.registration.scope;

// 固定路径的静态资源；assets/ 下的三个文件 URL 上带 ?v=<hash>，构建后才知道，
// 所以下面从 index.html 里现读，避免和无版本号的那份各下一遍。
var PRECACHE = [
  SCOPE,
  SCOPE + 'index.html',
  SCOPE + 'brand/scene-girls.webp',
  SCOPE + 'brand/home-night.webp',
  SCOPE + 'manifest.webmanifest'
];

/** 从 index.html 里取出 assets/*?v=… 的实际地址，和页面请求保持同一个 key。 */
function collect() {
  var urls = PRECACHE.slice();
  return fetch(SCOPE + 'index.html', { cache: 'no-store' })
    .then(function (res) {
      if (!res.ok) return '';
      return res.text();
    })
    .then(function (html) {
      var re = /(?:src|href)="(assets\/[^"]+)"/g, m;
      while ((m = re.exec(html))) {
        var u = SCOPE + m[1];
        if (urls.indexOf(u) < 0) urls.push(u);
      }
      return urls;
    })
    .catch(function () { return urls; });
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    collect().then(function (urls) {
      return caches.open(CACHE).then(function (c) {
        // 单个资源失败不拖累整体：本地预览时也可能暂时缺图
        return Promise.all(urls.map(function (u) {
          return c.add(u).catch(function () {});
        }));
      });
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
  // assets/ 的 URL 带 ?v=，内容变了地址就变，不会一直吃旧数据。
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
