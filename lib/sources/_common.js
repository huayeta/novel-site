// lib/sources/_common.js
// 多数据源共享：cheerio、内存缓存、带独立 cookie jar 的抓取器工厂。

import * as cheerio from 'cheerio';

export { cheerio };

// ---------- 简单内存缓存（带 TTL） ----------
export function newCache() {
  const m = new Map();
  return {
    get(key) {
      const e = m.get(key);
      if (e && e.exp > Date.now()) return e.val;
      if (e) m.delete(key);
      return null;
    },
    set(key, val, ttlMs) {
      m.set(key, { val, exp: Date.now() + ttlMs });
    },
  };
}

// ---------- 抓取器工厂 ----------
// 每个数据源独立：自己的缓存 + 自己的 cookie jar（避免跨源串味）。
// opts: { base, ua, referer, encoding }
//   encoding 默认 'utf-8'；GBK 站点（如 mu8）传 'gbk'，用 TextDecoder 正确解码。
export function makeFetcher({ base, ua, referer, encoding = 'utf-8' }) {
  const cache = newCache();
  let cookie = '';

  // 仅网络层错误才重试（源站偶发连接重置/限频）；HTTP 4xx（除 429）直接抛，避免无谓重试。
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const NET_ERR =
    /fetch failed|ECONNRESET|socket hung up|timed out|aborted|ETIMEDOUT|ECONNREFUSED|UND_ERR/i;

  async function rawFetch(
    url,
    { json = false, redirect = 'follow', method = 'GET', body = null, extraHeaders = {} } = {}
  ) {
    const headers = {
      'User-Agent': ua,
      'Referer': referer || base + '/',
      ...extraHeaders,
    };
    if (cookie) headers['Cookie'] = cookie;
    if (json) headers['X-Requested-With'] = 'XMLHttpRequest';

    let lastErr;
    const tries = 5;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const res = await fetch(url, { method, body, headers, redirect });
        const setC = res.headers.getSetCookie
          ? res.headers.getSetCookie()
          : [res.headers.get('set-cookie')].filter(Boolean);
        if (setC && setC.length) cookie = setC.map((c) => c.split(';')[0]).join('; ');

        if (redirect === 'manual' && res.status >= 300 && res.status < 400) return '';
        if (!res.ok) {
          // 5xx / 429 可重试；其余 4xx 直接抛
          if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
            lastErr = new Error(`fetch ${url} -> HTTP ${res.status}`);
            await sleep(500 * (attempt + 1));
            continue;
          }
          throw new Error(`fetch ${url} -> HTTP ${res.status}`);
        }
        // 用 arrayBuffer + TextDecoder 解码，支持 GBK 等非 UTF-8 编码（encoding 缺省 utf-8）。
        const buf = await res.arrayBuffer();
        const text = new TextDecoder(encoding).decode(buf);
        return json ? JSON.parse(text) : text;
      } catch (e) {
        lastErr = e;
        if (!NET_ERR.test(e.message || '')) throw e; // 非网络错误（JSON 解析 / HTTP 4xx）不重试
        await sleep(500 * Math.pow(2, attempt)); // 指数退避：500/1000/2000/4000ms
      }
    }
    throw lastErr || new Error(`fetch ${url} failed after ${tries} retries`);
  }

  return {
    cache,
    // 注意：下面的 ttl 参数仅为兼容各源已有的调用写法，rawFetch 并不做网络层缓存。
    // 缓存统一集中在 server.js 的 /api 路由层（见 lib/cache.js），因为书籍详情与
    // 章节目录必须实时；若在此层按 ttl 缓存，会冻结目录导致书架看不到新章节。
    // HTML 页面
    html: (u, ttl = 10 * 60 * 1000) => rawFetch(u, { ttlMs: ttl }),
    // JSON 接口
    json: (u, ttl = 60 * 60 * 1000) => rawFetch(u, { json: true, ttlMs: ttl }),
    // PC 页面：不跟随重定向（被 302 回移动站则视为拿不到，返回空）
    pcHtml: (u, ttl = 10 * 60 * 1000) => rawFetch(u, { ttlMs: ttl, redirect: 'manual' }),
    // 透传请求（POST 搜索等），返回按 encoding 解码后的文本
    req: (u, opts = {}) => rawFetch(u, opts),
  };
}

// 带超时的 Promise：超时 / 失败都返回 fallback（不抛）。
export function withTimeout(promise, ms, fallback = []) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(t);
        resolve(v == null ? fallback : v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      }
    );
  });
}
