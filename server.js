// server.js
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { getSource, listSources, defaultSource, searchAll } from './lib/sources/index.js';
import { createCache } from './lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const PORT = process.env.PORT || 3100;

const app = express();
// 关闭 Express 默认 ETag：避免 /api 走 304 条件复用，缓存策略完全由下面显式控制
app.set('etag', false);

// ---------- BASE_PATH：整站挂到子路径下 ----------
// 例如 BASE_PATH=/xiaoshuo 时，页面在 /xiaoshuo/、接口在 /xiaoshuo/api/... 下，
// nginx 用「不剥离前缀」的方式反代（proxy_pass 不带尾斜杠）即可访问。
// 为空（默认）保持原来的根路径行为；nginx 用「剥离前缀」方式反代时也无需设置。
const BASE_PATH = (() => {
  const raw = String(process.env.BASE_PATH || '').trim();
  if (!raw || raw === '/') return '';
  return '/' + raw.replace(/^\/+/, '').replace(/\/+$/, '');
})();
// 接口与静态资源统一挂在这个 router 上，挂载前缀就是 BASE_PATH
const api = express.Router();

// ---------- 缓存策略（集中配置，单位 ms）----------
// 目录/最新章节/总章数不缓存（实时）；静态元数据按「目录指纹」校验缓存，见 /api/book。
// 浏览器层对书籍详情与章节目录一律 no-store。
const TTL = {
  staticList: 24 * 60 * 60 * 1000, // 数据源/分类/排行清单：静态配置，24 小时
  list: 10 * 60 * 1000,            // 首页 / 分类 / 排行 / 全本列表：10 分钟
  search: 5 * 60 * 1000,           // 搜索结果：5 分钟
  chapter: 24 * 60 * 60 * 1000,    // 章节正文：发布后不再变化，24 小时
  cover: 24 * 60 * 60 * 1000,      // 封面图片：24 小时
  bookMeta: 24 * 60 * 60 * 1000,   // 书籍静态元数据：24 小时（目录/latest 不在此列）
  catalogPage: 24 * 60 * 60 * 1000,// 章节目录「非末页」：24 小时（末页实时）
};
const apiCache = createCache({ max: 500 });

// 书架「章节更新」检测 + book 页「章节目录」都依赖这两个接口的实时数据：
// 浏览器 / 代理层一律 no-store（每次都来问服务端）；服务端只缓存「不会变的部分」
// （书籍静态元数据、章节目录的非末页），目录末页与最新章节始终实时回源。
// 注意只匹配复数 book|chapters，单数 /api/chapter/*（正文）不受影响。
api.use((req, res, next) => {
  if (/^\/api\/(book|chapters)\//.test(req.path)) res.set('Cache-Control', 'no-store');
  next();
});

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[api error]', e.message);
    // 失败响应一律不缓存，避免源站抖动时坏结果被浏览器/CDN 留存
    res.set('Cache-Control', 'no-store');
    res.status(502).json({ error: e.message || '源站请求失败' });
  });

// 带缓存的 JSON 接口：key 用完整 URL（含全部 query，天然按 src/page/sort/q 隔离）。
// 成功且「有有效数据」才写缓存；失败/空结果不入缓存（响应头也在成功后才设置）。
// M4：Cache-Control 用缓存条目「剩余寿命」，前端据此把本地 TTL 夹到不超过剩余，
// 避免前端 10min + 服务端剩余 10min 叠成 20min 的陈旧窗口。
const withCache = (ttlMs, producer) =>
  wrap(async (req, res) => {
    const hitBefore = apiCache.peek(req.originalUrl);
    res.set('X-Cache', hitBefore ? 'HIT' : 'MISS');
    const data = await apiCache.get(req.originalUrl, ttlMs, () => producer(req));
    const leftMs = apiCache.remaining(req.originalUrl);
    if (leftMs > 0) {
      // 命中/新写入：浏览器缓存不超过服务端缓存的剩余寿命（M4 防叠加）
      const maxAge = Math.max(1, Math.floor(leftMs / 1000));
      res.set('Cache-Control', `public, max-age=${maxAge}`);
      res.set('X-Cache-Remaining', String(maxAge));
    } else {
      // 空结果/不可缓存：一层都不留，避免空列表被冻结
      res.set('Cache-Control', 'no-store');
      res.set('X-Cache-Remaining', '0');
    }
    res.json(data);
  });

// 取请求里的源 id（缺省用默认源）
const srcOf = (req) => req.query.src || defaultSource;

// 列表/发现类接口按 TTL 缓存；/api/book/* 与 /api/chapters/* 对浏览器一律 no-store，
// 服务端只缓存静态元数据（带目录指纹）与章节目录的非末页。

// 已启用数据源清单（搜索页筛选 chips 用）
api.get('/api/sources', withCache(TTL.staticList, () => listSources()));

api.get('/api/home', withCache(TTL.list, (req) => getSource(srcOf(req)).getHome()));

api.get('/api/categories', withCache(TTL.staticList, () => getSource(defaultSource).categoryList()));

api.get('/api/ranks', withCache(TTL.staticList, () => getSource(defaultSource).rankList()));

// 书籍详情：目录 / 分页 / 最新章节 / 总章数每次实时回源；静态元数据按「目录指纹」缓存。
// 指纹由本次实时抓到的目录算得，一旦有新章，指纹必变 → 立即回源刷新 status/update，
// 无需等 24h TTL，也不增加额外请求（目录本来就得抓）。浏览器侧一律 no-store。
api.get(
  '/api/book/:src/:id',
  wrap(async (req, res) => {
    const src = req.params.src;
    const source = getSource(src);
    const id = req.params.id;
    const refresh = req.query.refresh === '1';

    // ---- 1) 实时目录 / 分页 / 最新章节 / 真实总章数（绝不缓存）----
    let chapters = [];
    let pager = null;
    let latest = null;
    let totalChapters = 0;
    if (source.paginated && source.getChaptersPage) {
      // 分页源（如木偶小说）：只抓第 1 页目录 + 末页（取最新章节），不批量抓取
      const pg = await source.getChaptersPage(id, 1);
      chapters = pg.items || [];
      pager = {
        page: pg.page,
        pageSize: pg.pageSize,
        totalPages: pg.totalPages,
        hasNext: pg.hasNext,
        hasPrev: pg.hasPrev,
        paginated: true,
      };
      // M9：源站分页有时误报 totalPages（末页抓到空页）。向前回退最多 2 页找
      // 真正有内容的末页，避免「最新：xxx」消失，也避免把空页错当末页缓存。
      let lastItems = null;
      let effLastPage = pg.totalPages;
      if (pg.totalPages <= 1) lastItems = pg.items;
      else {
        for (let p = pg.totalPages; p >= Math.max(1, pg.totalPages - 2); p--) {
          try {
            const last = await source.getChaptersPage(id, p);
            if (last.items && last.items.length) {
              lastItems = last.items;
              effLastPage = p;
              break;
            }
          } catch (e) { /* 该页失败则继续向前回退 */ }
        }
      }
      // 找到有效末页后修正分页信息，前端翻页器不会指向空页
      if (effLastPage !== pg.totalPages) {
        pager.totalPages = effLastPage;
        pager.hasNext = false;
      }
      if (lastItems && lastItems.length) {
        const l = lastItems[lastItems.length - 1];
        latest = { name: l.title, cid: l.cid };
      }
      const perPage = pg.pageSize || 20;
      totalChapters =
        effLastPage > 1
          ? (effLastPage - 1) * perPage + (lastItems ? lastItems.length : perPage)
          : chapters.length;
    } else {
      chapters = await source.getChapters(id);
      totalChapters = chapters.length;
      if (chapters.length) {
        const l = chapters[chapters.length - 1];
        latest = { name: l.title, cid: l.cid };
      }
    }

    // ---- 2) 目录指纹：只取本次实时抓到的稳定信号 ----
    // 非分页源：新章 → 最新 cid 与章节数都变；分页源：新章 → 末页最新 cid 变，新增页 → totalPages 变
    const fp = [
      latest && latest.cid ? latest.cid : '',
      chapters.length,
      pager ? pager.totalPages : 0,
    ].join('|');

    // ---- 3) 静态元数据：指纹一致才复用缓存；指纹变化立即回源（status/update 0 延迟）----
    const metaKey = 'meta|' + src + '|' + id;
    const validate = (v) => !!(v && v.__fp === fp);
    res.set('X-Meta-Cache', !refresh && apiCache.peek(metaKey, validate) ? 'HIT' : 'MISS');
    const meta = await apiCache.get(
      metaKey,
      TTL.bookMeta,
      async () => {
        const b = await source.getBook(id);
        const { latest: _ignored, ...staticMeta } = b;
        return { ...staticMeta, __fp: fp };
      },
      (v) => !!(v && (v.title || v.intro || v.author)), // 空壳元数据不缓存
      { bypass: refresh, validate }
    );
    const { __fp, ...staticMeta } = meta;
    const book = { ...staticMeta, latest }; // latest 始终来自实时目录

    const out = { src, srcName: source.name, book, chapters, totalChapters };
    if (pager) out.pager = pager;
    res.json(out);
  })
);

// 单页章节目录：浏览器一律 no-store；服务端按「章节追加式」特性缓存。
// 新章只追加在末尾 ⇒ 非末页内容永不变（缓存 24h），末页（最新章节所在）每次实时回源。
// 因此 book 页目录 / 阅读页跳章 / 书架更新检测都能第一时间看到新章节。
api.get(
  '/api/chapters/:src/:id',
  wrap(async (req, res) => {
    const source = getSource(req.params.src);
    const id = req.params.id;
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const refresh = req.query.refresh === '1';
    // key 规范化：不含 refresh，避免刷新参数本身生成另一个缓存条目
    const key = `/api/chapters/${req.params.src}/${id}|page=${page}`;
    res.set('X-Cache', !refresh && apiCache.peek(key) ? 'HIT' : 'MISS');
    const data = await apiCache.get(
      key,
      TTL.catalogPage,
      async () => {
        if (source.paginated && source.getChaptersPage) {
          const pg = await source.getChaptersPage(id, page);
          return {
            src: req.params.src,
            srcName: source.name,
            page: pg.page,
            pageSize: pg.pageSize,
            totalPages: pg.totalPages,
            hasNext: pg.hasNext,
            hasPrev: pg.hasPrev,
            items: pg.items,
          };
        }
        // L3：非分页源（keca/ibq）前端从不调用本接口（目录直接来自 /api/book 的全量
        // chapters）。此分支仅保留为通用 API / 未来接入分页时用，切片本身仍是追加式安全的。
        const all = await source.getChapters(id);
        const pageSize = 200;
        const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
        const start = (page - 1) * pageSize;
        return {
          src: req.params.src,
          srcName: source.name,
          page,
          pageSize,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
          items: all.slice(start, start + pageSize),
        };
      },
      // 只有「非末页且非空」才入缓存；末页/越界页/空页一律实时
      (r) => r && r.items && r.items.length > 0 && r.page < r.totalPages,
      { bypass: refresh }
    );
    res.json(data);
  })
);

// 章节正文：发布后内容不再变化，长缓存；空正文不缓存（源站异常时下次仍会重试）。
api.get(
  '/api/chapter/:src/:bid/:cid',
  withCache(TTL.chapter, (req) =>
    getSource(req.params.src).getChapter(req.params.cid, req.params.bid)
  )
);

api.get(
  '/api/category/:src/:cat',
  withCache(TTL.list, (req) => getSource(req.params.src).getCategory(req.params.cat))
);

api.get(
  '/api/rank/:src/:type',
  withCache(TTL.list, (req) => getSource(req.params.src).getRank(req.params.type))
);

api.get(
  '/api/quanben',
  withCache(TTL.list, (req) => getSource(srcOf(req)).getQuanben(req.query.sort))
);

// 合并搜索：跨所有已启用数据源，各自独立超时，结果统一带 src / srcName。
// 缓存 5 分钟；结果为「有效数据」才写入（避免源站故障时空结果被缓存）。
api.get(
  '/api/search',
  withCache(TTL.search, async (req) => {
    const q = req.query.q || '';
    const results = await searchAll(q, { timeoutMs: 8000 });
    return { q, results };
  })
);

// 封面代理：避免直接外链被防盗链拦截（按 src 选择对应源站 base）。
// 图片内容不可变，服务端按 Buffer 缓存 24h + 浏览器 24h；失败不缓存。
api.get(
  '/api/cover',
  wrap(async (req, res) => {
    const src = req.query.src || defaultSource;
    const p = (req.query.p || '').toString();
    const source = getSource(src);
    if (!/^\/(img|images|files)\//.test(p)) return res.status(400).end('bad path');
    // 封面可能托管在与内容不同的主机（如 mu8 封面在 www，内容在 m），用 coverBase 兜底。
    const base = source.coverBase || source.base;
    const url = base + p;
    const key = 'cover|' + src + '|' + p;
    const cached = apiCache.peek(key);
    res.set('X-Cache', cached ? 'HIT' : 'MISS');
    const hit = await apiCache.get(
      key,
      TTL.cover,
      async () => {
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: base + '/' },
        });
        if (!r.ok) throw new Error('fetch failed');
        return {
          ct: r.headers.get('content-type') || 'image/jpeg',
          buf: Buffer.from(await r.arrayBuffer()),
        };
      },
      (v) => v && v.buf && v.buf.length > 0
    );
    res.set('Content-Type', hit.ct);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(hit.buf);
  })
);

// ---------- 挂载：静态页面与接口统一挂在 BASE_PATH 下（默认 '' 即根路径）---------
const mount = BASE_PATH || '/';
if (BASE_PATH) {
  // 不带尾斜杠的前缀入口补一个跳转，保证页面里的相对链接（assets/xxx）解析正确。
  // 注意 Express 默认非严格路由，「/xiaoshuo/」也会匹配这条路由，所以必须按 req.path 精确判断，
  // 否则会自己 301 到自己（重定向循环）。
  app.get(BASE_PATH, (req, res, next) => {
    if (req.path !== BASE_PATH) return next();
    res.redirect(301, BASE_PATH + '/');
  });
}
// ---------- 前端资源版本化（cache busting）----------
// 版本号 = package.json 的 version + public/assets/ 下所有文件的内容 hash。
// 任一 JS/CSS 改动（或手动升 version）都会让 HTML 里的 ?v= 变化，浏览器自动请求新 URL；
// HTML 本身一律 no-cache（带 ETag 协商，几乎零流量），保证用户普通刷新就能拿到新页面，
// 不会出现「旧 HTML 里没有新脚本引用」导致新功能永远看不到的情况。
function readAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '0';
  } catch { return '0'; }
}
function computeAssetVersion() {
  const h = crypto.createHash('sha256');
  let names = [];
  try { names = fs.readdirSync(ASSETS_DIR).sort(); } catch { /* 目录不存在时用空 hash */ }
  for (const n of names) {
    try {
      const f = path.join(ASSETS_DIR, n);
      if (!fs.statSync(f).isFile()) continue;
      h.update(n);                       // 文件名变化（新增/删除资源）也要让版本变
      h.update(fs.readFileSync(f));      // 内容变化也要让版本变
    } catch { /* 单个文件读失败不影响启动 */ }
  }
  return readAppVersion() + '-' + h.digest('hex').slice(0, 10);
}
const ASSET_V = computeAssetVersion();

// 只接受 /xxx.html 与 /，避免目录穿越；其它路径交给 express.static / api 处理
const HTML_NAME_RE = /^\/([A-Za-z0-9_-]+)\.html$/;
function htmlNameFor(reqPath) {
  if (reqPath === '/') return 'index.html';
  const m = HTML_NAME_RE.exec(reqPath);
  return m ? m[1] + '.html' : null;
}

// HTML：替换占位符 + 强制协商缓存（自己算 ETag，不依赖被关闭的 app etag）
app.use(mount, (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const name = htmlNameFor(req.path);
  if (!name) return next();
  let html;
  try { html = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8'); }
  catch { return next(); }
  html = html.replace(/__ASSET_V__/g, ASSET_V);
  const etag = '"' + crypto.createHash('sha1').update(html).digest('base64').slice(0, 16) + '"';
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.set('ETag', etag);
  res.type('html');
  if (req.headers['if-none-match'] === etag) return res.status(304).end();
  return res.send(html);
});

// 静态资源：带 ?v= 的版本化 URL 可以放心长缓存；不带版本号的旧 URL 只做协商缓存
app.use(mount, express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    const rel = path.relative(PUBLIC_DIR, filePath).replace(/\\/g, '/');
    const url = (res.req && res.req.originalUrl) || '';
    if (rel.startsWith('assets/')) {
      res.setHeader('Cache-Control', /[?&]v=/.test(url)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache');
    } else if (rel.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));
app.use(mount, api);

app.listen(PORT, () => {
  console.log(`小说站运行中: http://localhost:${PORT}${BASE_PATH || '/'}`);
  // 预热默认源的本地搜索索引（best-effort）
  try {
    getSource(defaultSource).warmIndex?.();
  } catch (e) {}
});
