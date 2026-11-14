/* 造梦橱窗 Service Worker
 * 策略：
 *  - 页面导航（HTML）：网络优先，失败回退缓存，再失败回退 /offline.html
 *  - JS / CSS：先用缓存立即返回、后台更新（stale-while-revalidate）。
 *    页面里的 app.js / style.css 都带 ?v=<mtime>，发版后 URL 必然变化 → 天然拿新代码，
 *    所以不必为了「及时生效」牺牲每次导航的 285K 流量（旧策略 networkFirst 就是这么亏的）。
 *  - 图标 / manifest 等静态资源：缓存优先
 *  - /uploads 图片、缩略图 /t/：缓存优先 + 运行时缓存上限 120 张
 *  - /api、/admin、跨域请求：完全不拦截
 * 发版时把 VERSION 常量 +1，旧缓存会在 activate 阶段自动清理。
 */
const VERSION = 'v89';   // v89: 注册后按 IP 自助认领弹窗（ipClaimModal + /api/claim/ip-*）
const SHELL_CACHE = `shell-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;
const IMG_CACHE = `img-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const IMG_CACHE_MAX = 120;
const STATIC_CACHE_MAX = 40;   // 带版本号的 js/css 每发一版都会留下一份，别让它无限涨

// 预缓存：只放「离线兜底 + 无版本号」的资源。
// 以前把 /app.js /style.css 也列在这里，但页面真正请求的是 /app.js?v=xxx，
// 缓存键不同 → 安装时白白多下 300K，还一份都用不上。
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 单个失败不影响整体安装
    await Promise.allSettled(PRECACHE_URLS.map(u => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => ![SHELL_CACHE, STATIC_CACHE, IMG_CACHE].includes(n))
      .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// 超出上限时按插入顺序淘汰最旧的
async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  await Promise.all(keys.slice(0, keys.length - max).map(k => cache.delete(k)));
}

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl) || await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    cache.put(request, fresh.clone());
    trimCache(cacheName, IMG_CACHE_MAX);
  }
  return fresh;
}

async function staleWhileRevalidate(request, cacheName, trimMax) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(res => {
    if (res && res.ok) {
      cache.put(request, res.clone());
      if (trimMax) trimCache(cacheName, trimMax);
    }
    return res;
  }).catch(() => undefined);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;          // 跨域不拦截
  if (url.pathname.startsWith('/api/')) return;             // 接口永远走网络
  if (url.pathname.startsWith('/admin')) return;            // 后台不缓存

  // 页面导航
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE, OFFLINE_URL));
    return;
  }

  // JS / CSS：缓存优先 + 后台更新。版本号在 URL 上，发版不会拿到旧代码
  if (/\.(js|css)(\?|$)/.test(url.pathname + url.search)) {
    event.respondWith(staleWhileRevalidate(request, STATIC_CACHE, STATIC_CACHE_MAX));
    return;
  }

  // 用户上传图片、缩略图：缓存优先（离线也能看到看过的作品图）
  if (url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/t/')) {
    event.respondWith(cacheFirst(request, IMG_CACHE));
    return;
  }

  // 图标、manifest 等本地静态资源：缓存优先
  if (/\.(png|svg|webp|ico|webmanifest|json|txt|xml)$/i.test(url.pathname) || url.pathname === '/favicon.svg') {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // 其余同源 GET：直接放行
});
