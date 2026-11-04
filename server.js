// server.js
import express from 'express';
import { fileURLToPath } from 'url';
import path from 'path';
import { getSource, listSources, defaultSource, searchAll } from './lib/sources/index.js';
import { createCache } from './lib/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
// 关闭 Express 默认 ETag：避免 /api 走 304 条件复用，缓存策略完全由下面显式控制
app.set('etag', false);

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
app.use((req, res, next) => {
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
const withCache = (ttlMs, producer) =>
  wrap(async (req, res) => {
    res.set('X-Cache', apiCache.peek(req.originalUrl) ? 'HIT' : 'MISS');
    const data = await apiCache.get(req.originalUrl, ttlMs, () => producer(req));
    res.set('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}`);
    res.json(data);
  });

// 取请求里的源 id（缺省用默认源）
const srcOf = (req) => req.query.src || defaultSource;

app.use(express.static(path.join(__dirname, 'public')));

// 列表/发现类接口按 TTL 缓存；/api/book/* 与 /api/chapters/* 对浏览器一律 no-store，
// 服务端只缓存静态元数据（带目录指纹）与章节目录的非末页。

// 已启用数据源清单（搜索页筛选 chips 用）
app.get('/api/sources', withCache(TTL.staticList, () => listSources()));

app.get('/api/home', withCache(TTL.list, (req) => getSource(srcOf(req)).getHome()));

app.get('/api/categories', withCache(TTL.staticList, () => getSource(defaultSource).categoryList()));

app.get('/api/ranks', withCache(TTL.staticList, () => getSource(defaultSource).rankList()));

// 书籍详情：目录 / 分页 / 最新章节 / 总章数每次实时回源；静态元数据按「目录指纹」缓存。
// 指纹由本次实时抓到的目录算得，一旦有新章，指纹必变 → 立即回源刷新 status/update，
// 无需等 24h TTL，也不增加额外请求（目录本来就得抓）。浏览器侧一律 no-store。
app.get(
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
      let lastItems = null;
      if (pg.totalPages <= 1) lastItems = pg.items;
      else {
        try {
          const last = await source.getChaptersPage(id, pg.totalPages);
          if (last.items && last.items.length) lastItems = last.items;
        } catch (e) {} // 末页失败则不臆造最新章节
      }
      if (lastItems && lastItems.length) {
        const l = lastItems[lastItems.length - 1];
        latest = { name: l.title, cid: l.cid };
      }
      const perPage = pg.pageSize || 20;
      totalChapters =
        pg.totalPages > 1
          ? (pg.totalPages - 1) * perPage + (lastItems ? lastItems.length : perPage)
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
app.get(
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
app.get(
  '/api/chapter/:src/:bid/:cid',
  withCache(TTL.chapter, (req) =>
    getSource(req.params.src).getChapter(req.params.cid, req.params.bid)
  )
);

app.get(
  '/api/category/:src/:cat',
  withCache(TTL.list, (req) => getSource(req.params.src).getCategory(req.params.cat))
);

app.get(
  '/api/rank/:src/:type',
  withCache(TTL.list, (req) => getSource(req.params.src).getRank(req.params.type))
);

app.get(
  '/api/quanben',
  withCache(TTL.list, (req) => getSource(srcOf(req)).getQuanben(req.query.sort))
);

// 合并搜索：跨所有已启用数据源，各自独立超时，结果统一带 src / srcName。
// 缓存 5 分钟；结果为「有效数据」才写入（避免源站故障时空结果被缓存）。
app.get(
  '/api/search',
  withCache(TTL.search, async (req) => {
    const q = req.query.q || '';
    const results = await searchAll(q, { timeoutMs: 8000 });
    return { q, results };
  })
);

// 封面代理：避免直接外链被防盗链拦截（按 src 选择对应源站 base）。
// 图片内容不可变，服务端按 Buffer 缓存 24h + 浏览器 24h；失败不缓存。
app.get(
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

app.listen(PORT, () => {
  console.log(`小说站运行中: http://localhost:${PORT}`);
  // 预热默认源的本地搜索索引（best-effort）
  try {
    getSource(defaultSource).warmIndex?.();
  } catch (e) {}
});
