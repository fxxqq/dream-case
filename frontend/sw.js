/* 造梦橱窗 Service Worker
 * 策略：
 *  - 页面导航（HTML）：网络优先，失败回退缓存，再失败回退 /offline.html
 *  - JS / CSS：网络优先（配合服务端 no-cache，保证发版后尽快拿到新代码），失败回退缓存
 *  - 图标 / manifest 等静态资源：缓存优先
 *  - /uploads 图片：缓存优先 + 运行时缓存上限 120 张
 *  - /api、/admin、跨域请求：完全不拦截
 * 发版时把 VERSION 常量 +1，旧缓存会在 activate 阶段自动清理。
 */
const VERSION = 'v36';
const SHELL_CACHE = `shell-${VERSION}`;
const STATIC_CACHE = `static-${VERSION}`;
const IMG_CACHE = `img-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const IMG_CACHE_MAX = 120;

// 预缓存：离线兜底所需的最小集合（'/' 仅作离线兜底，线上仍以网络为准）
const PRECACHE_URLS = [
  OFFLINE_URL,
  '/style.css',
  '/app.js',
  '/icons.js',
  '/vendor/qrcode.js',
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

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request).then(res => {
    if (res && res.ok) cache.put(request, res.clone());
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

  // JS / CSS：网络优先，保证代码更新及时生效
  if (/\.(js|css)(\?|$)/.test(url.pathname + url.search)) {
    event.respondWith(networkFirst(request, STATIC_CACHE));
    return;
  }

  // 用户上传图片：缓存优先（离线也能看到看过的作品图）
  if (url.pathname.startsWith('/uploads/')) {
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
