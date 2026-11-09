// public/assets/app.js —— 前端逻辑（原生 JS，按 body[data-page] 分发）

// ---- BASE_PATH 支持 ----
// 站点可挂在任意子路径下（例如 nginx 把 /xiaoshuo/ 反代到本服务）。
// 前缀由当前页面路径自动推导：'/xiaoshuo/read.html' -> '/xiaoshuo'，根路径时为 ''。
// 需要显式指定时（例如后端 BASE_PATH 与访问路径不一致），可在页面里注入 window.__BASE_PATH__。
const BASE = (() => {
  if (typeof window !== 'undefined' && typeof window.__BASE_PATH__ === 'string') {
    return window.__BASE_PATH__.replace(/\/+$/, '');
  }
  const p = (typeof location !== 'undefined' && location.pathname) || '/';
  return p.replace(/\/[^/]*$/, '');
})();
// 给根路径绝对地址补上站点前缀
const U = (u) => (typeof u === 'string' && u.charAt(0) === '/' ? BASE + u : u);

// L8：默认源不再硬编码，启动后由 /api/sources（后端按 SOURCES 环境变量算出的启用列表）
// 的第一个动态覆盖；'keca' 仅作为接口失败时的兜底。
let DEFAULT_SRC = 'keca';
// 当前页面所处数据源（书籍/阅读/搜索等页通过 ?src= 传入；缺省默认源）
const URL_SRC = (() => {
  try { return new URLSearchParams(location.search).get('src') || ''; }
  catch (e) { return ''; }
})();
let curSrc = URL_SRC || DEFAULT_SRC;

const COVER = (p, src) =>
  p ? U('/api/cover?src=') + encodeURIComponent(src || DEFAULT_SRC) + '&p=' + encodeURIComponent(p) : '';

async function apiRaw(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error('网络错误 ' + r.status);
  return r;
}
async function api(path) {
  return (await apiRaw(path)).json();
}

// 页面分发前解析真实默认源，避免以 ibq/mu8 为默认源时首页空白、来源混用
async function resolveDefaultSource() {
  try {
    const list = await api(U('/api/sources'));
    if (Array.isArray(list) && list.length && list[0].id) {
      DEFAULT_SRC = list[0].id;
      if (!URL_SRC) curSrc = DEFAULT_SRC;
    }
  } catch (e) { /* 失败时保留 'keca' 兜底 */ }
}

function qs() {
  return Object.fromEntries(new URLSearchParams(location.search));
}

// ============ 用户数据：单一状态对象（为云同步设计）============
// 所有用户数据收敛到一个 key，内部按 "src:id" 做 Map，每条带 ts / 墓碑。
// 云端同步时 GET 响应可直接 apply、PUT body 直接就是本对象，零格式转换；
// 所有写入都经 saveState()，同步 hook / 变更通知只需挂一处。
// 注意：qj_cache_* 是纯本地缓存（TTL/LRU/剩余寿命对齐），不在此对象内、也不同步。
const STATE_KEY = 'qingjian_userdata';
const STATE_VERSION = 2;
const HIST_MAX = 80;
const READER_DEFAULT = { fs: 19, lh: 1.8, theme: 'day' };
const LH_OPTIONS = [1.6, 1.8, 2.0];

function entityKey(src, id) { return (src || DEFAULT_SRC) + ':' + String(id); }

function defaultState() {
  return {
    v: STATE_VERSION,
    updatedAt: 0,
    books: {},      // Map<"src:id", {src,id,title,author,cover,addedAt,ts,deleted}>
    progress: {},   // Map<"src:id", {cid,title,page?,ts}>
    seen: {},       // Map<"src:id", {cid,ts,deleted}>
    history: [],    // 数组，条目自带 ts，天然按时间归并
    reader: { ...READER_DEFAULT },
  };
}

let _state = null;
function loadState() {
  if (_state) return _state;
  let s = null;
  try { s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch (e) {}
  if (!s || typeof s !== 'object' || s.v !== STATE_VERSION) s = defaultState();
  // 防御性补齐，避免半写入 / 手工改坏导致白屏
  if (!s.books || typeof s.books !== 'object' || Array.isArray(s.books)) s.books = {};
  if (!s.progress || typeof s.progress !== 'object' || Array.isArray(s.progress)) s.progress = {};
  if (!s.seen || typeof s.seen !== 'object' || Array.isArray(s.seen)) s.seen = {};
  if (!Array.isArray(s.history)) s.history = [];
  if (!s.reader || typeof s.reader !== 'object') s.reader = { ...READER_DEFAULT };
  _state = s;
  return s;
}
// silent=true：仅持久化，不触发同步 hook（云同步把远端数据写回本地时用，避免同步循环）
function saveState(silent) {
  const s = loadState();
  s.updatedAt = Date.now();
  try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) {}
  if (!silent && _stateChangeHook) { try { _stateChangeHook(); } catch (e) {} }
}
let _stateChangeHook = null;
function setStateChangeHook(fn) { _stateChangeHook = typeof fn === 'function' ? fn : null; }

// 多标签页：另一个标签页改了状态就作废内存缓存，下次读取重新解析
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (e) => { if (!e.key || e.key === STATE_KEY) _state = null; });
}

function coverEl(b) {
  const src = b.src || curSrc;
  if (b.cover) {
    const ch = esc((b.title || '?').trim().charAt(0));
    // 万一某张封面 404，退化成首字占位卡，绝不裂图
    return `<img class="cover" loading="lazy" src="${COVER(b.cover, src)}" alt="" data-ch="${ch}" onerror="this.onerror=null;const d=document.createElement('div');d.className='cover placeholder';d.textContent=this.dataset.ch;this.replaceWith(d);">`;
  }
  const ch = (b.title || '?').trim().charAt(0);
  return `<div class="cover placeholder" aria-hidden="true">${esc(ch)}</div>`;
}

function bookCard(b, opts = {}) {
  const src = b.src || curSrc;
  const url = `${BASE}/book.html?src=${encodeURIComponent(src)}&id=${b.id}`;
  if (opts.row) {
    const badge = b.srcName ? `<span class="src-badge">${esc(b.srcName)}</span>` : '';
    const metaBits = [b.status, b.wordCount, b.update].filter(Boolean).map(esc);
    const metaLine = metaBits.join(' · ');
    const latestLine = b.latest && b.latest.name ? '最新：' + esc(b.latest.name) : '';
    // 有简介（如笔趣阁）优先显示简介，避免卡片太空；必去小说网无简介则显示信息行 + 最新章节
    const introHTML = b.intro ? esc(b.intro) : '';
    return `<a class="book-row" href="${url}">
      ${coverEl(b)}
      <div class="info">
        <div class="title">${esc(b.title)} ${badge}</div>
        <div class="author">${esc(b.author || '')}</div>
        ${introHTML ? `<div class="intro">${introHTML}</div>` : ''}
        ${metaLine ? `<div class="meta-line">${metaLine}</div>` : ''}
        ${latestLine ? `<div class="latest-line">${latestLine}</div>` : ''}
      </div></a>`;
  }
  return `<a class="book-card" href="${url}">
    ${coverEl(b)}
    <div class="t">${esc(b.title)}</div>
    <div class="a">${esc(b.author || '')}</div></a>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// 完结/连载 状态 → 彩色标签
function statusBadge(s) {
  const t = (s || '').trim();
  let cls = 'neutral';
  if (/完/.test(t)) cls = 'done';
  else if (/连载/.test(t)) cls = 'ongoing';
  return `<span class="badge ${cls}">${esc(t || '未知')}</span>`;
}

function setProgress(src, bid, cid, title, page) {
  const s = loadState();
  const k = entityKey(src, bid);
  const o = { cid, title: title || '', ts: Date.now() };
  if (page) o.page = page; // 分页源：记录当前所在页，便于「继续阅读」直接定位
  const old = s.progress[k];
  // 内容没变就不刷 ts，避免同步时无谓地把另一台设备的新进度判为旧数据
  if (old && old.cid === o.cid && old.title === o.title && old.page === o.page) return;
  s.progress[k] = o;
  saveState();
}
function getProgress(src, bid) {
  const o = loadState().progress[entityKey(src, bid)];
  return o && o.cid ? o : null;
}

// 从分类链接里安全取出分类 key（避免源站链接异常导致详情页白屏）
function catKeyFromUrl(url) {
  const m = (url || '').match(/\/(\w+?)_wap/);
  return m ? m[1] : '';
}

// 检测源站章节数据是否疑似错乱（同名/编号重复、总数与最大章节号严重不符）。
// L1：分页源只拿到单页，不能拿单页数量当分母（会恒不触发/误报），直接跳过；
// 用循环求最大值，避免 Math.max(...nums) 在千章级目录上展开爆栈。
function chapterHealth(chapters, isPartial) {
  if (isPartial) return '';
  const nums = [];
  let max = 0;
  for (const c of chapters) {
    const m = (c.title || '').match(/第(\d+)章/);
    if (m) { const n = +m[1]; nums.push(n); if (n > max) max = n; }
  }
  if (!nums.length) return '';
  const distinct = new Set(nums).size;
  if (distinct < nums.length * 0.6 || max < chapters.length * 0.5) {
    return '源站章节数据疑似错乱（编号重复/疑似混入他书章节），目录可能不准确，建议以底部「最新章节」为准。';
  }
  return '';
}

// ============ 阅读器设置（统一状态对象）============
function getReaderSettings() {
  return { ...READER_DEFAULT, ...loadState().reader };
}
function saveReaderSettings(s) {
  // 带 ts：云同步按「最后修改的设备为准」合并阅读器设置
  loadState().reader = { ...s, ts: Date.now() };
  saveState();
}
function applyReaderSettings(s) {
  const root = document.documentElement;
  root.style.setProperty('--reader-fs', s.fs + 'px');
  root.style.setProperty('--reader-lh', String(s.lh));
  root.setAttribute('data-theme', s.theme);
}

// ============ 本地书架（统一状态对象）============
// 对外仍返回/接收数组，保持所有调用方签名不变；saveBookmarks 做差异合并，
// 「数组里消失的书」自动转成墓碑 deleted:true —— 同步时删除才不会在另一台设备复活。
function getBookmarks() {
  return Object.values(loadState().books)
    .filter((b) => b && !b.deleted)
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .map((b) => ({ src: b.src, id: b.id, title: b.title, author: b.author, cover: b.cover, addedAt: b.addedAt }));
}
function saveBookmarks(list) {
  const s = loadState();
  const now = Date.now();
  const keep = new Set();
  (list || []).forEach((b, i) => {
    const src = b.src || DEFAULT_SRC;
    const k = entityKey(src, b.id);
    keep.add(k);
    const old = s.books[k];
    const base = old && !old.deleted ? old : null;
    const title = b.title || '', author = b.author || '', cover = b.cover || '';
    // 只有字段真的变了才刷 ts；重新收藏一本已删的书视为新增
    const changed = !base || base.title !== title || base.author !== author || base.cover !== cover;
    s.books[k] = {
      src, id: b.id, title, author, cover,
      addedAt: base ? base.addedAt : (b.addedAt || now - i), // 新收藏靠前
      ts: changed ? now : (base ? base.ts : now),
      deleted: false,
    };
  });
  Object.keys(s.books).forEach((k) => {
    if (!keep.has(k) && !s.books[k].deleted) { s.books[k].deleted = true; s.books[k].ts = now; }
  });
  saveState();
}
function isBookmarked(src, id) {
  const b = loadState().books[entityKey(src, id)];
  return !!(b && !b.deleted);
}
function toggleBookmark(b) {
  const src = b.src || DEFAULT_SRC;
  const list = getBookmarks();
  const i = list.findIndex(
    (x) => (x.src || DEFAULT_SRC) === src && String(x.id) === String(b.id)
  );
  if (i >= 0) list.splice(i, 1);
  else list.unshift({ src, id: b.id, title: b.title, author: b.author, cover: b.cover });
  saveBookmarks(list);
  return i < 0; // true=已收藏
}
function removeBookmark(src, id) {
  const list = getBookmarks();
  const i = list.findIndex(
    (x) => (x.src || DEFAULT_SRC) === (src || DEFAULT_SRC) && String(x.id) === String(id)
  );
  if (i >= 0) {
    list.splice(i, 1);
    saveBookmarks(list);
    clearSeenLatest(src || DEFAULT_SRC, id); // 移出书架清掉基线，重新收藏后从「首次看见」开始
  }
}

// ============ 阅读历史（统一状态对象）============
function getHistory() {
  return loadState().history.slice();
}
function saveHistory(list) {
  loadState().history = (list || []).slice(0, HIST_MAX);
  saveState();
}
// 记录/更新一本书的阅读历史（置顶，按 源+书 去重）
function addHistory(b) {
  if (!b || !b.id) return;
  const src = b.src || DEFAULT_SRC;
  const list = getHistory().filter(
    (x) => (x.src || DEFAULT_SRC) !== src || String(x.id) !== String(b.id)
  );
  list.unshift({
    src,
    id: b.id,
    title: b.title || '',
    author: b.author || '',
    cover: b.cover || '',
    cid: b.cid || '',
    ctitle: b.ctitle || '',
    page: b.page || undefined, // 分页源：记录当前所在页
    ts: Date.now(),
  });
  saveHistory(list);
}
function removeHistory(src, id) {
  saveHistory(
    getHistory().filter(
      (x) => (x.src || DEFAULT_SRC) !== (src || DEFAULT_SRC) || String(x.id) !== String(id)
    )
  );
}
function clearHistory() {
  saveHistory([]);
}

// 相对时间：1 分钟内=刚刚，之后按 分钟/小时/天
function timeAgo(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60 * 1000) return '刚刚';
  const min = Math.floor(d / 60000);
  if (min < 60) return min + '分钟前';
  const h = Math.floor(min / 60);
  if (h < 24) return h + '小时前';
  const day = Math.floor(h / 24);
  if (day < 30) return day + '天前';
  const mon = Math.floor(day / 30);
  if (mon < 12) return mon + '个月前';
  return Math.floor(mon / 12) + '年前';
}

// 书籍元数据：短 TTL + in-flight 合并。
// 书架页会因「初始化 + 云同步回调」在极短时间内渲染两次；原先每次都回源，
// 导致每本书的 /api/book 发两次（服务端目录部分不缓存，等于源站被抓两次）。
// 按 src:id 合并并发请求并缓存 30 秒；下拉刷新传 force 强制实时。
const BOOK_META_TTL = 30 * 1000;
const bookMetaCache = new Map(); // key -> { at, value?, promise? }
function pruneBookMetaCache() {
  const now = Date.now();
  for (const [k, v] of bookMetaCache) {
    if (v.value && now - v.at > BOOK_META_TTL) bookMetaCache.delete(k);
  }
}
async function getBookMeta(id, src, opts) {
  src = src || DEFAULT_SRC;
  const force = !!(opts && opts.force);
  const key = entityKey(src, id);
  if (!force) {
    const hit = bookMetaCache.get(key);
    if (hit) {
      if (hit.value) {
        if (Date.now() - hit.at < BOOK_META_TTL) return hit.value;
      } else if (hit.promise) {
        return hit.promise; // 首次请求还没回来：复用同一个 Promise，不重复发请求
      }
    }
  }
  const task = (async () => {
    try {
      const data = await getBookData(src, id);
      const book = data.book || {};
      const chapters = data.chapters || [];
      const l = book.latest || {};
      const value = {
        // 分页源 /api/book 只带第 1 页目录，必须用服务端算出的真实总章数
        total: Number(data.totalChapters) || chapters.length,
        cids: chapters.map((c) => c.cid),
        firstCid: chapters.length ? chapters[0].cid : '',
        latestCid: l.cid || '',
        latestName: l.name || '',
        paginated: !!(data.pager && data.pager.paginated),
        totalPages: data.pager ? data.pager.totalPages : 0,
        pageSize: data.pager ? data.pager.pageSize : 0,
        status: book.status || '',
        update: book.update || '',
        title: book.title || '',
        author: book.author || '',
        cover: book.cover || '',
      };
      bookMetaCache.set(key, { at: Date.now(), value });
      return value;
    } catch (e) {
      // 明确区分「获取失败」，不要伪装成「未开始/无更新」；失败不缓存，下次仍会重试
      bookMetaCache.delete(key);
      return { error: true };
    }
  })();
  bookMetaCache.set(key, { at: Date.now(), promise: task });
  if (bookMetaCache.size > 200) pruneBookMetaCache();
  return task;
}

// ============ 新章「已读基线」（统一状态对象）============
// 记录用户上次点进本书时看到的最新章节 cid。书架据此判断「源站是否出了新章」。
// 关键约束：基线只在「点进书籍页/阅读页」时刷新；书架页绝不能主动刷新，
// 否则每次打开书架都会把基线拉到当前最新章，「更新」永远不亮。
function readSeenMap() { return loadState().seen; }
function getSeenLatest(src, id) {
  const e = readSeenMap()[entityKey(src, id)];
  return e && !e.deleted && e.cid ? e.cid : '';
}
function markSeenLatest(src, id, cid) {
  if (!cid) return;
  const s = loadState();
  const k = entityKey(src, id);
  const old = s.seen[k];
  // 相同则完全不动（保留原 ts），避免无谓写入把同步基线判成"刚改过"
  if (old && !old.deleted && old.cid === cid) return;
  s.seen[k] = { cid, ts: Date.now(), deleted: false };
  saveState();
}
function clearSeenLatest(src, id) {
  const s = loadState();
  const k = entityKey(src, id);
  if (!s.seen[k]) return;
  // 墓碑而非物理删除：移出书架后基线清空，同步时另一台设备不会把旧基线推回来
  s.seen[k] = { cid: '', ts: Date.now(), deleted: true };
  saveState();
}
// 冷启动兜底：老用户升级 / 刚收藏的书没有基线。首次在书架看到它时，
// 静默用「当前最新章节」建立基线（本次不亮），此后才进入正常的「出新章→亮」循环。
// 没有这个兜底，基线永远为空，徽标永远不会亮 —— 正是上一版的问题。
function ensureBaseline(src, id, latestCid) {
  if (!latestCid || getSeenLatest(src, id)) return;
  markSeenLatest(src, id, latestCid);
}

// ============ 首页 ============
async function homePage() {
  const data = await cachedApi(U('/api/home'), listCache);
  const featured = document.getElementById('featured');
  featured.innerHTML =
    data.featured.map((b) => bookCard(b)).join('') || '<div class="empty">暂无强推</div>';

  const cats = document.getElementById('catList');
  cats.innerHTML = data.categories
    .map(
      (c) =>
        `<a class="chip" href="${BASE}/category.html?cat=${c.key}&name=${encodeURIComponent(c.name)}">${esc(c.name)}</a>`
    )
    .join('');

  const root = document.getElementById('catSections');
  root.innerHTML = data.categories
    .map((c) => {
      const books = (c.books || []).slice(0, 6).map((b) => bookCard(b)).join('');
      return `<div class="section-title">${esc(c.name)}
        <a class="more" href="${BASE}/category.html?cat=${c.key}&name=${encodeURIComponent(c.name)}">更多 ›</a></div>
        <div class="book-grid">${books || '<div class="empty">暂无</div>'}</div>`;
    })
    .join('');

  // 排行链接
  const ranks = await api(U('/api/ranks'));
  document.getElementById('rankList').innerHTML = ranks
    .map(
      (r) =>
        `<a class="chip" href="${BASE}/rank.html?type=${r.key}&name=${encodeURIComponent(r.name)}">${esc(r.name)}</a>`
    )
    .join('');

  // 首页「我的书架」预览
  const sp = document.getElementById('shelfPreview');
  if (sp) {
    const bm = getBookmarks();
    sp.innerHTML = bm.length
      ? bm.slice(0, 6).map((b) => bookCard(b)).join('')
      : '<div class="empty">还没有收藏，去书籍页点「收藏」吧</div>';
  }

  // 首页「最新收录」信息流（新书榜）
  const nb = document.getElementById('newList');
  if (nb) {
    try {
      // 需带 src（后端路由为 /api/rank/:src/:type），否则 404 导致本栏一直为空
      const nd = await cachedApi(U('/api/rank/') + curSrc + '/postdate', listCache);
      nb.innerHTML = nd.books.length
        ? nd.books.slice(0, 9).map((b) => bookCard(b)).join('')
        : '<div class="empty">暂无</div>';
    } catch (e) {
      nb.innerHTML = '';
    }
  }
}

// ============ 搜索 ============
function initSearch() {
  const box = document.querySelector('.topbar .search');
  if (!box) return;
  const input = box.querySelector('input');
  const btn = box.querySelector('button');
  const go = async () => {
    const q = input.value.trim();
    if (!q) return;
    location.href = U('/search.html?q=') + encodeURIComponent(q);
  };
  btn.addEventListener('click', go);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
}

// ============ 搜索结果页 ============
function searchScore(b, q) {
  const t = (b.title || '').toLowerCase();
  const a = (b.author || '').toLowerCase();
  const i = (b.intro || '').toLowerCase();
  let s = 0;
  if (t.startsWith(q)) s += 3;
  if (t.includes(q)) s += 1;
  if (a.includes(q)) s += 1;
  if (i.includes(q)) s += 0.4;
  return s;
}
async function searchPage() {
  const { q } = qs();
  const query = (q || '').trim();

  document.getElementById('q').textContent = query || '';

  const box = document.getElementById('results');
  const chipsEl = document.getElementById('srcChips');
  let allResults = [];
  let activeSrc = 'all';

  // 来源筛选 chips（全部 + 每个已启用源）
  try {
    const sources = await api(U('/api/sources'));
    if (chipsEl) {
      const chips = ['<button class="chip active" data-src="all" type="button">全部</button>'].concat(
        sources.map(
          (s) => `<button class="chip" data-src="${esc(s.id)}" type="button">${esc(s.name)}</button>`
        )
      );
      chipsEl.innerHTML = chips.join('');
      chipsEl.querySelectorAll('button').forEach((btn) =>
        btn.addEventListener('click', () => {
          chipsEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          activeSrc = btn.dataset.src;
          renderResults();
        })
      );
    }
  } catch (e) {}

  function renderResults() {
    const list =
      activeSrc === 'all' ? allResults : allResults.filter((b) => b.src === activeSrc);
    if (!list.length) {
      box.innerHTML =
        '<div class="empty">未找到相关书籍（列表索引以笔趣阁为主；必去小说网支持直搜书名 / 作者）</div>';
      return;
    }
    const ql = query.toLowerCase();
    if (ql) list.sort((a, b) => searchScore(b, ql) - searchScore(a, ql));
    box.innerHTML = list.map((b) => bookCard(b, { row: true })).join('');
  }

  async function doSearch() {
    box.innerHTML = '<div class="loading">搜索中…</div>';
    try {
      const res = await cachedApi(U('/api/search?q=') + encodeURIComponent(query), searchCache);
      allResults = (res.results || []).slice();
      renderResults();
    } catch (e) {
      box.innerHTML = '<div class="empty">搜索失败：' + esc(e.message) + '</div>';
    }
  }

  if (query) doSearch();

  const hot = document.getElementById('hot');
  if (hot) {
    const cats = [
      ['xuanhuanxiaoshuo', '玄幻'], ['xiuzhenxiaoshuo', '修真'],
      ['dushixiaoshuo', '都市'], ['chuanyuexiaoshuo', '穿越'],
      ['wangyouxiaoshuo', '网游'], ['kehuanxiaoshuo', '科幻'],
      ['yanqingxiaoshuo', '言情'],
    ];
    hot.innerHTML = '<div class="section-title">分类直达</div><div class="chips">' +
      cats.map(([k, n]) => `<a class="chip" href="${BASE}/category.html?cat=${k}&name=${encodeURIComponent(n)}">${n}</a>`).join('') + '</div>';
  }
}

// ============ 分类页 ============
async function categoryPage() {
  const { cat, name } = qs();
  document.getElementById('catName').textContent = name || cat;
  document.title = (name || cat) + ' - 青简';
  const data = await cachedApi(U('/api/category/') + curSrc + '/' + cat, listCache);
  const box = document.getElementById('books');
  box.innerHTML = data.books.length
    ? data.books.map((b) => bookCard(b, { row: true })).join('')
    : '<div class="empty">暂无书籍</div>';
}

// ============ 排行榜页 ============
async function rankPage() {
  const { type, name } = qs();
  document.getElementById('rankName').textContent = name || type;
  document.title = (name || type) + ' - 青简';
  const data = await cachedApi(U('/api/rank/') + curSrc + '/' + type, listCache);
  const box = document.getElementById('books');
  box.innerHTML = data.books.length
    ? data.books.map((b) => bookCard(b, { row: true })).join('')
    : '<div class="empty">暂无书籍</div>';
}

// ============ 完本书库 ============
const QUANBEN_SORTS = [
  ['allvisit', '总点击'], ['weekvisit', '周点击'], ['monthvisit', '月点击'],
  ['dayvote', '日推荐'], ['weekvote', '周推荐'], ['monthvote', '月推荐'], ['allvote', '总推荐'],
  ['goodnum', '总收藏'], ['size', '字数'], ['postdate', '最新入库'],
];
async function quanbenPage() {
  const { sort = 'allvisit', name } = qs();

  // 排序切换
  const sc = document.getElementById('qbSorts');
  if (sc) {
    sc.innerHTML = QUANBEN_SORTS.map(
      ([k, n]) =>
        `<a class="chip${k === sort ? ' on' : ''}" href="${BASE}/quanben.html?sort=${k}&name=${encodeURIComponent(n)}">${n}</a>`
    ).join('');
  }

  const data = await cachedApi(U('/api/quanben?src=') + curSrc + '&sort=' + encodeURIComponent(sort), listCache);
  const title = name || data.name || '完本小说';
  document.getElementById('qbName').textContent = title;
  document.title = title + ' - 青简';
  const box = document.getElementById('books');
  box.innerHTML = data.books.length
    ? data.books.map((b) => bookCard(b, { row: true })).join('')
    : '<div class="empty">暂无书籍</div>';
}

// ============ 书籍详情页 ============
async function bookPage() {
  const { id, src: pageSrc } = qs();
  const src = pageSrc || DEFAULT_SRC;
  let data = await getBookData(src, id);
  const srcName = data.srcName || src;
  const pager = data.pager || null; // 分页源（如木偶小说）返回 pager；keca/ibq 为 null
  const bidEnc = encodeURIComponent(id);
  let b = data.book;
  if (b) { b.src = src; b.srcName = srcName; }
  // 点进书籍页 = 已阅，刷新基线使「更新」熄灭，直到源站再出新章。
  // 注意：下拉刷新不调 markSeenLatest —— 刷新 ≠ 点进书，基线语义保持不变。
  if (b && b.latest && b.latest.cid) markSeenLatest(src, id, b.latest.cid);

  const headEl = document.getElementById('head');
  const introEl = document.getElementById('intro');
  const ch = document.getElementById('chapters');
  const chDir = document.getElementById('chapterDirTitle');
  const pagerEl = document.getElementById('chapterPager');
  const orderSeg = document.getElementById('orderSeg');
  const warnBox = document.getElementById('chapterWarn');
  let curPage = 1;
  let desc = true; // 章节目录默认倒序（最新章节在前）

  // 头部 / 简介抽成可重复调用的函数：下拉刷新时原地更新，不重建整页状态。
  function bindBmBtn() {
    const bmBtn = document.getElementById('bmBtn');
    if (!bmBtn) return;
    bmBtn.classList.toggle('on', isBookmarked(src, id));
    bmBtn.addEventListener('click', () => {
      const fav = toggleBookmark({ src, id, title: b.title, author: b.author, cover: b.cover });
      bmBtn.textContent = fav ? '★ 已收藏' : '☆ 收藏';
      bmBtn.classList.toggle('on', fav);
    });
  }
  function renderHead() {
    document.title = b.title + ' - 青简';
    const firstCid = data.chapters.length ? data.chapters[0].cid : ''; // 分页源下 data.chapters 为第 1 页
    const prog = getProgress(src, id);
    let pctLabel = '';
    if (prog && prog.cid && !pager) {
      const pi = data.chapters.findIndex((c) => c.cid === prog.cid);
      if (pi >= 0) pctLabel = `（${Math.round(((pi + 1) / data.chapters.length) * 100)}%）`;
    }
    const contBtn = prog
      ? `<a class="btn" href="${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bidEnc}&cid=${encodeURIComponent(prog.cid)}${pager && prog.page ? '&page=' + encodeURIComponent(prog.page) : ''}">继续阅读${prog.title ? '：' + esc(prog.title) : ''}${pctLabel}</a>`
      : `<a class="btn" href="${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bidEnc}&cid=${encodeURIComponent(firstCid)}${pager ? '&page=1' : ''}">开始阅读</a>`;

    // 顶部返回链接固定回书架（href 已写在 book.html，不覆盖、不做 history.back）。
    headEl.innerHTML = `
      <img class="cover" src="${COVER(b.cover, src)}" alt="">
      <div class="meta">
        <h1>${esc(b.title)}</h1>
        <div class="line">作者：${esc(b.author)}</div>
        ${b.category ? `<div class="line">分类：<a href="${BASE}/category.html?cat=${catKeyFromUrl(b.category.url)}&name=${encodeURIComponent(b.category.name)}">${esc(b.category.name)}</a></div>` : ''}
        <div class="line">状态：${statusBadge(b.status)}</div>
        <div class="line">来源：<span class="src-badge">${esc(srcName)}</span></div>
        <div class="line">更新：${esc(b.update || '未知')}</div>
        ${contBtn}
        <button class="btn ghost" id="bmBtn" type="button">${isBookmarked(src, id) ? '★ 已收藏' : '☆ 收藏'}</button>
      </div>`;
    bindBmBtn();
  }
  function renderIntro() {
    introEl.innerHTML =
      `<div class="section-title">简介</div><div class="book-row" style="display:block">${esc(b.intro || '暂无简介')}</div>`;
  }
  renderHead();
  renderIntro();

  const render = (list, page) => {
    const pageParam = pager ? `&page=${page}` : '';
    ch.innerHTML = list
      .map((c) => `<a href="${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bidEnc}&cid=${encodeURIComponent(c.cid)}${pageParam}">${esc(c.title)}</a>`)
      .join('');
  };
  // L4：千章级目录一次性塞 DOM 会卡顿。CSS 用 content-visibility 让屏外条目跳过渲染，
  // 这里再对超大目录分批插入，避免单次 innerHTML 长任务阻塞主线程。
  let _renderSeq = 0; // 代际保护：快速切排序/翻页时丢弃旧批次
  const renderChunked = (list, page) => {
    const seq = ++_renderSeq;
    if (list.length <= 400) { render(list, page); return; }
    const pageParam = pager ? `&page=${page}` : '';
    const html = (c) => `<a href="${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bidEnc}&cid=${encodeURIComponent(c.cid)}${pageParam}">${esc(c.title)}</a>`;
    ch.innerHTML = list.slice(0, 400).map(html).join('');
    let i = 400;
    const step = () => {
      if (seq !== _renderSeq || i >= list.length) return; // 已被新渲染取代
      ch.insertAdjacentHTML('beforeend', list.slice(i, i + 400).map(html).join(''));
      i += 400;
      setTimeout(step, 0);
    };
    setTimeout(step, 0);
  };
  const applyOrder = () => {
    const list = desc ? data.chapters.slice().reverse() : data.chapters;
    renderChunked(list, curPage);
    if (orderSeg) {
      orderSeg.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('on', (btn.dataset.order === 'desc') === desc);
      });
    }
  };

  // M5：pager 是进入页面时的快照。用户操作分页器/重试时重新取一次 /api/book，
  // 让源站在页面打开期间新增的目录页也能被翻到（不用整页刷新）。
  let lastGoodPage = 1;
  async function refreshPager() {
    if (!pager) return;
    try {
      const d = await api(U('/api/book/') + encodeURIComponent(src) + '/' + encodeURIComponent(id));
      if (d && d.pager && d.pager.totalPages > pager.totalPages) {
        pager.totalPages = d.pager.totalPages;
        if (d.totalChapters) data.totalChapters = d.totalChapters;
      }
    } catch (e) { /* 刷新失败沿用已有快照 */ }
  }

  // 分页源：按需抓取某一页，避免一次性抓取全部触发源站连接重置
  // 只在「翻到当前末页/重试」时刷新 pager 快照（M5），普通翻页不额外请求
  async function loadChapterPage(p, opts = {}) {
    const atBoundary = p >= pager.totalPages;
    if ((atBoundary || opts.force) && !opts.skipRefresh) await refreshPager();
    p = Math.max(1, Math.min(pager.totalPages, p | 0));
    const prevPage = curPage;
    try {
      const pg = await api(U('/api/chapters/') + encodeURIComponent(src) + '/' + encodeURIComponent(id) + '?page=' + p);
      if (!pg.items || !pg.items.length) throw new Error('空目录页');
      if (pg.totalPages > pager.totalPages) pager.totalPages = pg.totalPages;
      data.chapters = pg.items || [];
      curPage = pg.page || p;
      lastGoodPage = curPage;
      if (chDir) chDir.innerHTML = `章节目录 <span class="more">第 <span id="curPageNum">${curPage}</span> / ${pager.totalPages} 页</span>`;
      applyOrder();
      if (pagerEl) {
        pagerEl.innerHTML = `
          <button type="button" data-pg="1" ${curPage <= 1 ? 'disabled' : ''}>首页</button>
          <button type="button" data-pg="${curPage - 1}" ${curPage <= 1 ? 'disabled' : ''}>上一页</button>
          <span class="pg-ind">第 ${curPage} / ${pager.totalPages} 页</span>
          <button type="button" data-pg="${curPage + 1}" ${curPage >= pager.totalPages ? 'disabled' : ''}>下一页</button>
          <button type="button" data-pg="${pager.totalPages}" ${curPage >= pager.totalPages ? 'disabled' : ''}>末页</button>`;
      }
    } catch (e) {
      // L10：失败时把页码/标题/分页器回滚到上一个有效页，不再出现「目录是上一页但页码显示失败页」
      curPage = lastGoodPage || prevPage;
      if (chDir) chDir.innerHTML = `章节目录 <span class="more">第 <span id="curPageNum">${curPage}</span> / ${pager.totalPages} 页</span>`;
      if (pagerEl) pagerEl.innerHTML = `<span class="warn">第 ${p} 页加载失败（仍在第 ${curPage} 页），<a href="#" id="pgRetry">点击重试</a></span>`;
      const rt = document.getElementById('pgRetry');
      if (rt) rt.addEventListener('click', (ev) => { ev.preventDefault(); loadChapterPage(p, { force: true }); });
    }
  }

  if (pager) {
    if (chDir) chDir.innerHTML = `章节目录 <span class="more">第 <span id="curPageNum">${pager.page}</span> / ${pager.totalPages} 页</span>`;
    if (pagerEl) {
      pagerEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-pg]');
        if (!btn || btn.disabled) return;
        loadChapterPage(Number(btn.dataset.pg));
      });
    }
    await loadChapterPage(pager.totalPages, { skipRefresh: true }); // 默认展示最新页，快照刚拿到无需再刷
  } else {
    if (chDir) chDir.innerHTML = `章节目录 <span class="more">共 <span id="chapterCount">${data.chapters.length}</span> 章</span>`;
    applyOrder();
  }

  if (orderSeg) {
    orderSeg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-order]');
      if (!btn) return;
      desc = btn.dataset.order === 'desc';
      applyOrder();
    });
  }

  // 下拉刷新：重新拉实时 /api/book，就地更新元信息与章节目录。
  // 不重建页面状态（保留当前页码 / 正倒序 / 收藏按钮），不写 seen 基线。
  async function refreshBook() {
    const fresh = await getBookData(src, id);
    const wasAtLast = pager ? curPage >= pager.totalPages : true;
    data = fresh;
    b = fresh.book || b;
    if (b) { b.src = src; b.srcName = fresh.srcName || srcName; }
    renderHead();
    renderIntro();
    if (pager) {
      // 分页源：/api/book 只带第 1 页目录，当前目录交给 loadChapterPage 重拉（末页实时）。
      if (fresh.pager && fresh.pager.totalPages > pager.totalPages) pager.totalPages = fresh.pager.totalPages;
      // 原本就在末页 → 跟到新的末页（能立刻看到新增章节）；否则留在用户当前页。
      await loadChapterPage(wasAtLast ? pager.totalPages : curPage, { skipRefresh: true });
    } else {
      data.chapters = fresh.chapters;
      if (chDir) chDir.innerHTML = `章节目录 <span class="more">共 <span id="chapterCount">${data.chapters.length}</span> 章</span>`;
      applyOrder();
      if (warnBox) warnBox.textContent = chapterHealth(data.chapters, false);
    }
  }

  if (globalThis.PullToRefresh) {
    PullToRefresh.mount({
      content: document.querySelector('.wrap'),
      anchor: document.querySelector('.topbar'),
      onRefresh: refreshBook,
    });
  }

  if (warnBox) warnBox.textContent = chapterHealth(data.chapters, !!pager);
}

// ============ 缓存层（localStorage，TTL 自动过期 + LRU 上限）============
// 通用 localStorage 缓存：命名空间隔离 + TTL + 超限按最旧时间淘汰 + 配额溢出兜底。
// 失效策略：到期自动重抓；超过上限或配额溢出时按时间淘汰最旧条目，绝不阻塞阅读。
function makeLCache(name, { ttl = 30 * 60 * 1000, max = 300 } = {}) {
  const KEY = 'qj_cache_' + name;
  let store = null;
  const load = () => {
    if (store) return store;
    try { store = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { store = {}; }
    return store;
  };
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(store)); return true; }
    catch (e) { return false; }
  };
  const evict = (o) => {
    let ks = Object.keys(o);
    if (ks.length <= max) return;
    ks.sort((a, b) => (o[a].ts || 0) - (o[b].ts || 0));
    for (const k of ks.slice(0, ks.length - max)) delete o[k];
  };
  return {
    get(k) {
      const o = load();
      const e = o[k];
      if (!e) return undefined;
      // 每条可带自己的 ttl（M4：夹到服务端缓存剩余寿命），否则用实例默认 ttl
      if (Date.now() - e.ts > (e.ttl || ttl)) { delete o[k]; persist(); return undefined; }
      return e.v;
    },
    set(k, v, ttlMs) {
      const o = load();
      const e = { ts: Date.now(), v };
      if (ttlMs && ttlMs > 0) e.ttl = ttlMs;
      o[k] = e;
      evict(o);
      if (!persist()) {
        // 配额溢出：再淘汰一半最旧的，避免 QuotaExceededError 影响阅读
        const ks = Object.keys(o).sort((a, b) => (o[a].ts || 0) - (o[b].ts || 0));
        ks.slice(0, Math.ceil(ks.length / 2)).forEach((kk) => delete o[kk]);
        persist();
      }
    },
    del(k) { const o = load(); if (k in o) { delete o[k]; persist(); } },
  };
}

// 各业务缓存实例（key 维度）。书籍详情/目录故意不设缓存：见 getBookData。
const chCache = makeLCache('chapter', { ttl: 24 * 60 * 60 * 1000, max: 250 });   // 章节正文（P1）
const listCache = makeLCache('list', { ttl: 10 * 60 * 1000, max: 60 });          // 首页/分类/排行/全本（P3）
const searchCache = makeLCache('search', { ttl: 5 * 60 * 1000, max: 50 });      // 搜索结果（P3）

// 列表/搜索类接口走 localStorage 缓存；TTL 到期自动重抓。
// 书籍详情/目录不走此函数（getBookData 直接请求后端），保证数据实时。
// 空结果不缓存：避免源站抖动时的空列表被冻结 5~10 分钟，期间新书/新结果不可见。
function hasListData(v) {
  if (!v) return false;
  const keys = ['books', 'results', 'featured', 'categories'];
  const found = keys.filter((k) => Array.isArray(v[k]));
  if (found.length) return found.some((k) => v[k].length > 0);
  return true;
}
async function cachedApi(path, cache) {
  const hit = cache.get(path);
  if (hit !== undefined) return hit;
  // M4：读服务端缓存的剩余寿命，把本地 TTL 夹到不超过它，
  // 避免「前端 10min + 服务端剩余 10min」叠加成 20min 的陈旧窗口。
  const r = await apiRaw(path);
  const v = await r.json();
  const leftSec = Number(r.headers.get('X-Cache-Remaining')) || 0;
  if (hasListData(v)) {
    const ttlMs = leftSec > 0 ? leftSec * 1000 : undefined;
    cache.set(path, v, ttlMs);
  }
  return v;
}
// 书籍详情 + 章节目录：绝对不缓存。
// 书架页「更新」徽标（章节总数 / 最新章节）与 book 页章节目录都依赖它的实时响应，
// 后端对应接口也标记了 no-store；这里保持每次都真实请求。
function getBookData(src, id) {
  return api(U('/api/book/') + encodeURIComponent(src) + '/' + encodeURIComponent(id));
}

// ============ 章节内容缓存 + 预加载 ============
// 章节正文发布后不再变化，可安全缓存：localStorage TTL 24h + LRU 250。
// 后端 /api/chapter/* 另有 24h 服务端缓存；空正文不写入（源站异常时下次仍会重试）。
// 解析规则变化（如过滤掉源站正文末尾的推广段）时递增 CHAPTER_CACHE_V，
// 旧缓存 key 随之失效，用户无需手动清 localStorage。
const CHAPTER_CACHE_V = 2;
function ccGet(k) { return chCache.get(CHAPTER_CACHE_V + '|' + k); }
function ccSet(k, v) { if (v && v.paragraphs && v.paragraphs.length) chCache.set(CHAPTER_CACHE_V + '|' + k, v); }
async function fetchChapter(src, bid, cid) {
  const k = src + '/' + bid + '/' + cid;
  const hit = ccGet(k);
  if (hit !== undefined) return hit;
  const v = await api(U('/api/chapter/') + src + '/' + bid + '/' + cid);
  ccSet(k, v);
  return v;
}
// 预取下一章：未缓存时后台拉取并写入，翻到该章即可秒开。
// 与 fetchChapter 并发命中同一 URL 时由服务端 in-flight 合并，不会重复回源。
function prefetchChapter(src, bid, cid) {
  if (!cid) return;
  const k = src + '/' + bid + '/' + cid;
  if (ccGet(k) !== undefined) return;
  api(U('/api/chapter/') + src + '/' + bid + '/' + cid).then((v) => ccSet(k, v)).catch(() => {});
}

// ============ 阅读页（SPA：翻章不刷新整页） ============
async function readPage() {
  const { bid, cid: startCid, src: pageSrc } = qs();
  const data = await getBookData(pageSrc || DEFAULT_SRC, bid);
  const src = data.src || pageSrc || DEFAULT_SRC;
  if (data.book) data.book.src = src;
  // 直接进入阅读页同样算已阅，刷新基线（避免从历史/深链进入时不灭）
  if (data.book && data.book.latest && data.book.latest.cid) markSeenLatest(src, bid, data.book.latest.cid);

  // 顶部返回：回到本书详情页
  const readBack = document.getElementById('readBack');
  if (readBack) {
    readBack.href = `${BASE}/book.html?src=${encodeURIComponent(src)}&id=${encodeURIComponent(bid)}`;
    readBack.textContent = '‹ 目录';
  }

  // 持久 DOM 引用（SPA 期间不重建）
  const contentEl = document.getElementById('content');
  const titleEl = document.getElementById('chapterTitle');
  const metaEl = document.getElementById('readerMeta');
  const nav = document.getElementById('readerNav');
  const tocOverlay = document.getElementById('tocOverlay');
  const tocList = document.getElementById('tocList');
  const tocCount = document.getElementById('tocCount');
  const tocFilter = document.getElementById('tocFilter');
  const tocPager = document.getElementById('tocPager');
  const pager = data.pager || null;
  // H4：用服务端给出的真实总章数，别用 totalPages*pageSize 高估（末页通常不满）
  let total = Number(data.totalChapters) || (pager ? pager.totalPages * pager.pageSize : data.chapters.length);

  // 分页源（如木偶小说）：章节目录按需逐页加载并累加到 data.chapters，
  // 不一次性抓取全部，避免触发源站连续请求被重置。每页章节带 _page 标记。
  const loadedPages = new Map();
  // L2：/api/book 已带回第 1 页目录，直接复用，避免进入阅读页再重复抓一次
  if (pager && data.chapters && data.chapters.length) {
    loadedPages.set(1, data.chapters.map((it) => ({ ...it, _page: 1 })));
  }
  function rebuildChapters() {
    const ks = [...loadedPages.keys()].sort((a, b) => a - b);
    data.chapters = [].concat(...ks.map((k) => loadedPages.get(k)));
  }
  // M5：pager 快照在页面长开期间可能过期。打开目录浮层 / 翻到边界时刷新一次，
  // 让源站新增的目录页可达（total 同步更新，进度百分比才不会偏低）。
  async function refreshPager() {
    if (!pager) return;
    try {
      const d = await api(U('/api/book/') + encodeURIComponent(src) + '/' + encodeURIComponent(bid));
      if (d && d.pager && d.pager.totalPages > pager.totalPages) {
        pager.totalPages = d.pager.totalPages;
        if (d.totalChapters) total = Number(d.totalChapters) || total;
      }
    } catch (e) { /* 刷新失败沿用已有快照 */ }
  }

  async function ensurePage(p) {
    if (!pager) return data.chapters;
    p = Math.max(1, Math.min(pager.totalPages, p | 0));
    if (loadedPages.has(p)) return loadedPages.get(p);
    const pg = await api(U('/api/chapters/') + encodeURIComponent(src) + '/' + encodeURIComponent(bid) + '?page=' + p);
    if (pg.totalPages > pager.totalPages) {
      pager.totalPages = pg.totalPages;
      if (pg.totalChapters) total = Number(pg.totalChapters) || total;
    }
    loadedPages.set(p, (pg.items || []).map((it) => ({ ...it, _page: p })));
    rebuildChapters();
    return loadedPages.get(p);
  }
  // 外部深链（无 page 参数）时，逐页查找目标章节所在页（罕见，仅一次）
  async function locateCid(targetCid) {
    if (!pager) return false;
    for (let p = 1; p <= pager.totalPages; p++) {
      const items = await ensurePage(p);
      if (items && items.some((c) => c.cid === targetCid)) return true;
    }
    return false;
  }
  let curPage = 1;

  // 可变阅读状态（翻章时由 syncChrome 更新）
  let cid = null;
  let idx = -1;
  let title = '';
  let prev = null;
  let next = null;

  // 更新导航/标题/进度/目录高亮/地址栏（不含正文，正文由 goToChapter 负责）
  function syncChrome(newCid, push = true) {
    cid = newCid;
    idx = data.chapters.findIndex((c) => c.cid === newCid);
    title = idx >= 0 ? data.chapters[idx].title : '';
    const myPage = (idx >= 0 && data.chapters[idx]._page) || 1;
    // 上一章 / 下一章：同页取相邻项；跨页边界（相邻项属于其它页或已到数组首尾）则标记为分页哨兵，交由导航加载相邻页
    if (idx > 0) {
      const pp = data.chapters[idx - 1];
      if (pager && pp._page !== myPage) prev = { __page: myPage - 1, __edge: 'last' };
      else prev = pp;
    } else if (pager && myPage > 1) prev = { __page: myPage - 1, __edge: 'last' };
    else prev = null;
    if (idx >= 0 && idx < data.chapters.length - 1) {
      const nn = data.chapters[idx + 1];
      if (pager && nn._page !== myPage) next = { __page: myPage + 1, __edge: 'first' };
      else next = nn;
    } else if (pager && myPage < pager.totalPages) next = { __page: myPage + 1, __edge: 'first' };
    else next = null;
    // 进度（估算）：当前页已加载章节在该页内的序号 + 之前整页章节数；非分页源直接用全局序号
    let startIdx = idx;
    while (startIdx > 0 && data.chapters[startIdx - 1] && data.chapters[startIdx - 1]._page === myPage) startIdx--;
    const cur = idx >= 0 ? (pager ? (myPage - 1) * pager.pageSize + (idx - startIdx + 1) : idx + 1) : 0;
    const pct = total ? Math.round((cur / total) * 100) : 0;
    if (metaEl) metaEl.textContent = total ? `第 ${cur} 章 · 已读 ${pct}%` : '';
    document.title = title + ' - 青简';
    if (titleEl) titleEl.textContent = title || '章节';
    // 导航按钮：保留 href 以便新标签页打开；点击走 SPA 翻章
    const prevHref = prev ? (prev.cid ? `${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bid}&cid=${prev.cid}` : '#') : '#';
    const nextHref = next ? (next.cid ? `${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bid}&cid=${next.cid}` : '#') : '#';
    nav.innerHTML = `
      <a href="${prevHref}" class="nav-prev ${prev ? '' : 'disabled'}"${prev && prev.__page ? ` data-edge="prev" data-page="${prev.__page}"` : ''}>上一章</a>
      <a href="#" class="toc-trigger">目录</a>
      <a href="${nextHref}" class="nav-next ${next ? '' : 'disabled'}"${next && next.__page ? ` data-edge="next" data-page="${next.__page}"` : ''}>下一章</a>`;
    // 目录高亮
    if (tocList) tocList.querySelectorAll('.toc-item').forEach((a) => a.classList.toggle('on', a.dataset.cid === cid));
    curPage = myPage; // 同步当前所在页（用于地址栏 / 浮层分页器）
    // 更新地址栏（不刷新），方便刷新/分享/前进后退
    if (push) history.pushState({ cid }, '', `${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bid}&cid=${cid}` + (pager ? `&page=${curPage}` : ''));
  }

  // 翻章（SPA）：取正文（前端缓存优先）→ 渲染 → 预取下一章
  let navigating = false;
  async function goToChapter(newCid, { push = true } = {}) {
    if (!newCid || newCid === cid || navigating) return;
    if (data.chapters.findIndex((c) => c.cid === newCid) < 0) {
      // 分页源：当前已加载页中找不到，尝试逐页定位（深链 / 前进后退跨页场景）
      if (pager) {
        await locateCid(newCid);
        const it = data.chapters.find((c) => c.cid === newCid);
        if (!it) return;
        curPage = it._page || curPage;
      } else return;
    }
    navigating = true;
    try {
      const chap = await fetchChapter(src, bid, newCid);
      syncChrome(newCid, push);
      if (contentEl) {
        contentEl.innerHTML = (chap.paragraphs && chap.paragraphs.length ? chap.paragraphs : ['（本章暂无内容）'])
          .map((p) => `<p>${esc(p)}</p>`)
          .join('');
      }
      setProgress(src, bid, cid, title, pager ? curPage : undefined);
      if (data.book) {
        addHistory({ src, id: bid, title: data.book.title, author: data.book.author, cover: data.book.cover, cid, ctitle: title, page: pager ? curPage : undefined });
      }
      // 只预取下一章；已读章节不主动删除，由 chCache 的 TTL + LRU 统一淘汰
      prefetchChapter(src, bid, next && next.cid);
      window.scrollTo(0, 0);
    } catch (e) {
      if (contentEl) contentEl.innerHTML = `<p class="warn">章节加载失败：${esc(e.message || e)}</p>`;
    } finally {
      navigating = false;
    }
  }

  // 初始渲染（不 push，避免多一条历史记录）
  curPage = Number(new URLSearchParams(location.search).get('page')) || 1;
  if (pager) await ensurePage(curPage);
  goToChapter(startCid, { push: false });

  // 内联目录（跳章浮层）
  const buildToc = (filter = '') => {
    if (!tocList) return;
    const q = (filter || '').trim();
    // 分页源：目录浮层一次只展示「当前页」，由分页器翻页，避免一次性加载全部章节触发源站重置
    const pageItems = pager ? (loadedPages.get(curPage) || []) : data.chapters;
    let items = q ? pageItems.filter((c) => c.title.includes(q)) : pageItems;
    items = items.slice().reverse(); // 目录固定倒序：最新章节在前
    tocList.innerHTML = items.length
      ? items.map((c) => `<a class="toc-item${c.cid === cid ? ' on' : ''}" data-cid="${esc(c.cid)}" data-page="${c._page || 1}" href="${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bid}&cid=${esc(c.cid)}${pager ? '&page=' + (c._page || 1) : ''}">${esc(c.title)}</a>`).join('')
      : '<div class="empty">无匹配章节</div>';
    const on = tocList.querySelector('.toc-item.on');
    if (on) on.scrollIntoView({ block: 'center' });
  };
  // 渲染目录分页器（分页源翻页浏览；非分页源清空）
  const renderTocPager = () => {
    if (!tocPager) return;
    if (!pager) { tocPager.innerHTML = ''; return; }
    tocPager.innerHTML = `
      <button type="button" data-pg="1" ${curPage <= 1 ? 'disabled' : ''}>首页</button>
      <button type="button" data-pg="${curPage - 1}" ${curPage <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="pg-ind">第 ${curPage} / ${pager.totalPages} 页</span>
      <button type="button" data-pg="${curPage + 1}" ${curPage >= pager.totalPages ? 'disabled' : ''}>下一页</button>
      <button type="button" data-pg="${pager.totalPages}" ${curPage >= pager.totalPages ? 'disabled' : ''}>末页</button>`;
  };
  const openToc = () => {
    buildToc(tocFilter ? tocFilter.value : '');
    if (tocCount) tocCount.textContent = pager
      ? `第 ${curPage} / ${pager.totalPages} 页 · 本页 ${loadedPages.get(curPage) ? loadedPages.get(curPage).length : 0} 章`
      : `共 ${data.chapters.length} 章`;
    renderTocPager();
    if (tocOverlay) tocOverlay.hidden = false;
    if (tocFilter) tocFilter.focus();
    // M5：打开目录时后台刷新 pager 快照，源站新增的目录页随后即可翻到
    if (pager) refreshPager().then(() => { if (tocOverlay && !tocOverlay.hidden) renderTocPager(); }).catch(() => {});
  };
  const closeToc = () => { if (tocOverlay) tocOverlay.hidden = true; };

  // 事件绑定（SPA 期间只绑一次，靠委托避免重复 / 适配 nav 内元素重建）
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.toc-trigger');
    if (t) { e.preventDefault(); openToc(); }
  });
  if (tocList) tocList.addEventListener('click', (e) => {
    const a = e.target.closest('.toc-item');
    if (!a) return;
    e.preventDefault();
    closeToc();
    goToChapter(a.dataset.cid);
  });
  // 跨页翻章：上一章/下一章落在相邻页时，先按需加载该页再跳转。
  // H2：闭包里必须快照 target（prev/next 会被 syncChrome 重新赋值），并加防抖，
  // 否则跨页边界快速连点会跳错页 / 导航被静默丢弃。
  let crossNavigating = false;
  async function crossPage(target) {
    if (!target || crossNavigating) return;
    if (!target.__page) return goToChapter(target.cid);
    const page = target.__page;
    const edge = target.__edge;
    crossNavigating = true;
    try {
      if (pager && page >= pager.totalPages) await refreshPager(); // M5：边界翻页时先刷新快照
      const arr = await ensurePage(page);
      if (arr && arr.length) {
        await goToChapter(edge === 'last' ? arr[arr.length - 1].cid : arr[0].cid);
      }
    } catch (e) {
      console.error('跨页翻章失败', e);
    } finally {
      crossNavigating = false;
    }
  }
  const goPrev = () => crossPage(prev);
  const goNext = () => crossPage(next);
  if (nav) nav.addEventListener('click', (e) => {
    if (e.target.closest('.nav-prev')) { e.preventDefault(); goPrev(); }
    else if (e.target.closest('.nav-next')) { e.preventDefault(); goNext(); }
  });
  const tocClose = document.getElementById('tocClose');
  if (tocClose) tocClose.addEventListener('click', closeToc);
  if (tocOverlay) tocOverlay.addEventListener('click', (e) => { if (e.target === tocOverlay) closeToc(); });
  if (tocFilter) tocFilter.addEventListener('input', () => buildToc(tocFilter.value));
  if (tocPager) tocPager.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-pg]');
    if (!b || b.disabled) return;
    const p = Number(b.dataset.pg);
    await ensurePage(p);
    curPage = p;
    buildToc(tocFilter ? tocFilter.value : '');
    if (tocCount) tocCount.textContent = `第 ${curPage} / ${pager.totalPages} 页 · 本页 ${loadedPages.get(curPage) ? loadedPages.get(curPage).length : 0} 章`;
    renderTocPager();
  });

  // 阅读器设置
  const rs = getReaderSettings();
  applyReaderSettings(rs);
  const markTheme = () => ['Day', 'Night', 'Eye'].forEach((t) => {
    const el = document.getElementById('theme' + t);
    if (el) el.classList.toggle('active', rs.theme === t.toLowerCase());
  });
  markTheme();
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  bind('fsMinus', () => { rs.fs = Math.max(15, rs.fs - 1); saveReaderSettings(rs); applyReaderSettings(rs); });
  bind('fsPlus', () => { rs.fs = Math.min(28, rs.fs + 1); saveReaderSettings(rs); applyReaderSettings(rs); });
  bind('lhBtn', () => { rs.lh = LH_OPTIONS[(LH_OPTIONS.indexOf(rs.lh) + 1) % LH_OPTIONS.length]; saveReaderSettings(rs); applyReaderSettings(rs); });
  const setTheme = (t) => () => { rs.theme = t; saveReaderSettings(rs); applyReaderSettings(rs); markTheme(); };
  bind('themeDay', setTheme('day'));
  bind('themeNight', setTheme('night'));
  bind('themeEye', setTheme('eye'));

  // 键盘翻页
  window.addEventListener('keydown', (e) => {
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) {
      if (e.key === 'Escape' && tocFilter) { tocFilter.value = ''; buildToc(''); }
      return;
    }
    if (e.key === 'Escape') { if (tocOverlay && !tocOverlay.hidden) closeToc(); return; }
    if (e.key === 'ArrowRight' && next) goNext();
    else if (e.key === 'ArrowLeft' && prev) goPrev();
  });

  // 浏览器前进 / 后退
  window.addEventListener('popstate', () => {
    const p = new URLSearchParams(location.search);
    const bc = p.get('cid');
    const bp = Number(p.get('page')) || curPage;
    if (bc && bc !== cid) {
      curPage = bp;
      if (pager) ensurePage(bp).then(() => goToChapter(bc, { push: false }));
      else goToChapter(bc, { push: false });
    }
  });
}

// ============ 书架 / 历史 ============
function firstChapterCidOf(meta) {
  return (meta && meta.firstCid) || '';
}
function continueTarget(b, meta, prog) {
  const src = b.src || curSrc;
  const cid = (prog && prog.cid) || firstChapterCidOf(meta);
  // L7：id / cid / page 统一编码，避免属性与 URL 注入
  const bid = encodeURIComponent(b.id);
  return cid
    ? `${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${bid}&cid=${encodeURIComponent(cid)}${prog && prog.page ? '&page=' + encodeURIComponent(prog.page) : ''}`
    : `${BASE}/book.html?src=${encodeURIComponent(src)}&id=${bid}`;
}

// 书架一行（富信息：封面 / 标题 / 更新徽标 / 章节进度 / 最新章节）
// skeleton=true 表示骨架态（meta 尚未返回），此时不渲染 ⋮ 菜单，避免「继续」落到错误链接
function shelfRow(b, meta, prog, skeleton) {
  const src = b.src || curSrc;
  const err = !!(meta && meta.error);
  const total = err || !meta ? 0 : meta.total;
  const cids = (meta && meta.cids) || [];
  const latestCid = (meta && meta.latestCid) || '';
  let readNo = 0;
  if (prog && prog.cid) {
    const i = cids.indexOf(prog.cid);
    readNo = i >= 0 ? i + 1 : 0;
  }
  const atLatest =
    (!!(prog && prog.cid && latestCid && prog.cid === latestCid)) ||
    (total > 0 && readNo >= total);

  // 「更新」= 源站最新章节 ≠ 上次点进本书时看到的最新章节（真正的新章检测）。
  // 点进书籍页/阅读页会刷新基线使徽标熄灭，直到源站再出新章才重新亮起。
  const seen = getSeenLatest(src, b.id);
  const showUpdate = !!(!err && latestCid && seen && seen !== latestCid && !atLatest);

  let progressLine;
  if (err) progressLine = '暂时无法获取，点开重试';
  else if (!prog || !prog.cid) progressLine = total ? `共 ${total} 章 · 未开始` : '未开始';
  else if (atLatest) progressLine = '已读至最新章节';
  else if (meta && meta.paginated && meta.totalPages && prog.page)
    progressLine = `已读至第 ${prog.page}/${meta.totalPages} 页 · 共 ${total} 章`;
  else progressLine = total ? `${readNo}章/${total}章` : `已读 ${readNo} 章`;

  const updateLine = meta && meta.update ? esc(meta.update) : '';
  const latestLine = meta && meta.latestName ? '最新：' + esc(meta.latestName) : '';
  const contHref = continueTarget(b, meta, prog);

  return `<div class="shelf-item" data-id="${esc(b.id)}" data-src="${esc(src)}">
    <a class="cover-link" href="${BASE}/book.html?src=${encodeURIComponent(src)}&id=${encodeURIComponent(b.id)}">${coverEl(b)}</a>
    <div class="shelf-main">
      <div class="shelf-top">
        <a class="shelf-title" href="${BASE}/book.html?src=${encodeURIComponent(src)}&id=${encodeURIComponent(b.id)}">${esc(b.title)}</a>
        ${showUpdate ? '<span class="upd-badge">更新</span>' : ''}
      </div>
      <div class="shelf-progress${atLatest ? ' latest' : ''}">${esc(progressLine)}</div>
      ${updateLine ? `<div class="shelf-update">${updateLine}</div>` : ''}
      ${latestLine ? `<div class="shelf-latest">${latestLine}</div>` : ''}
    </div>
    ${skeleton ? '' : `<button class="shelf-more" data-id="${esc(b.id)}" data-src="${esc(src)}" data-href="${esc(contHref)}" type="button" aria-label="更多" title="更多">⋮</button>`}
  </div>`;
}

// 历史一行
function historyRow(h) {
  const src = h.src || curSrc;
  const t = timeAgo(h.ts);
  const hid = encodeURIComponent(h.id);
  return `<div class="shelf-item" data-id="${esc(h.id)}" data-src="${esc(src)}">
    <a class="cover-link" href="${BASE}/book.html?src=${encodeURIComponent(src)}&id=${hid}">${coverEl(h)}</a>
    <div class="shelf-main">
      <a class="shelf-title" href="${BASE}/book.html?src=${encodeURIComponent(src)}&id=${hid}">${esc(h.title)}</a>
      <div class="shelf-progress">读到：${esc(h.ctitle || '未知章节')}</div>
      <div class="shelf-update">${t ? t + ' · ' : ''}${esc(h.author || '')}</div>
    </div>
    <a class="shelf-cont-link" href="${BASE}/read.html?src=${encodeURIComponent(src)}&bid=${hid}&cid=${encodeURIComponent(h.cid || '')}${h.page ? '&page=' + encodeURIComponent(h.page) : ''}">继续</a>
  </div>`;
}

// 行内 ⋮ 菜单（继续阅读 / 详情 / 移出书架）
let _rowMenu = null;
function closeRowMenu() {
  if (_rowMenu) { _rowMenu.remove(); _rowMenu = null; }
}
function openRowMenu(anchor, { id, src, href }) {
  closeRowMenu();
  const menu = document.createElement('div');
  menu.className = 'row-menu';
  menu.dataset.rid = String(id);
  menu.dataset.rsrc = String(src);
  menu.innerHTML = `
    <a href="${esc(href)}">继续阅读</a>
    <a href="${BASE}/book.html?src=${encodeURIComponent(src)}&id=${encodeURIComponent(id)}">查看详情</a>
    <button type="button" data-act="remove">移出书架</button>`;
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = r.bottom + window.scrollY + 6 + 'px';
  menu.style.left = Math.max(8, r.right + window.scrollX - 140) + 'px';
  _rowMenu = menu;
}

// L6：限制并发，避免大书架一次性发出 N 个 /api/book（分页源每本 2 次回源）触发限频
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

let _shelfRenderSeq = 0;
async function renderShelf(opts = {}) {
  const box = document.getElementById('shelf');
  if (!box) return;
  const seq = ++_shelfRenderSeq; // 每次重渲染作废旧结果，避免删除后又被旧 Promise.all 覆盖
  const list = getBookmarks();
  const count = document.getElementById('bmCount');
  if (count) count.textContent = list.length ? `共 ${list.length} 本` : '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">书架还是空的，去书籍详情页点「收藏」吧～</div>';
    return;
  }
  const isFresh = () => seq === _shelfRenderSeq;
  // L5：骨架态还没有 meta，先不渲染 ⋮ 菜单，避免「继续」落到错误链接。
  // 下拉刷新传 keepOld：保留现有行直到实时数据回来，避免刷新时整页闪一下骨架。
  if (!opts.keepOld) box.innerHTML = list.map((b) => shelfRow(b, null, getProgress(b.src || curSrc, b.id), true)).join('');
  const metas = await mapLimit(list, 4, (b) => getBookMeta(b.id, b.src || curSrc, { force: !!opts.force }));
  if (!isFresh()) return;
  // 冷启动：为没有基线的书建立起点（本次不亮），之后只在点进书时刷新基线。
  // 必须在渲染前执行，且只在基线为空时写入，绝不覆盖已有基线。
  list.forEach((b, i) => {
    const m = metas[i];
    if (m && !m.error && m.latestCid) ensureBaseline(b.src || curSrc, b.id, m.latestCid);
  });
  box.innerHTML = list.map((b, i) => shelfRow(b, metas[i], getProgress(b.src || curSrc, b.id))).join('');
}

function renderHistory() {
  const box = document.getElementById('history');
  if (!box) return;
  const list = getHistory();
  const c = document.getElementById('histCount');
  if (c) c.textContent = list.length ? `共 ${list.length} 本` : '';
  box.innerHTML = list.length
    ? list.map(historyRow).join('')
    : '<div class="empty">还没有阅读历史，去随便读几章吧～</div>';
}

async function shelfPage() {
  // 标签切换
  const tabs = document.getElementById('shelfTabs');
  const paneShelf = document.getElementById('shelfPane');
  const paneHist = document.getElementById('historyPane');
  const switchTab = (name) => {
    if (tabs) tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    if (paneShelf) paneShelf.hidden = name !== 'shelf';
    if (paneHist) paneHist.hidden = name !== 'history';
    if (name === 'history') renderHistory();
  };
  if (tabs) tabs.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  renderShelf().catch(() => {});
  // 云同步（同步码）：仅当同步确实带来远端变更时才重渲染书架。
  // 无变化的同步（绝大多数）不重渲染，避免紧挨着初始化再来一轮全量 /api/book；
  // 即使真有变更，getBookMeta 的短 TTL / in-flight 合并也会挡住重复回源。
  if (globalThis.QJSync) {
    QJSync.mount({ onSynced: (info) => {
      if (info && info.changed === false) return;
      renderShelf({ keepOld: true });
    } });
  }
  // 下拉刷新（公共模块）：先同步再重渲染，顺带把另一台设备的改动拉过来。
  // 同步失败静默降级，不能让转圈卡住；onSynced:false 避免重复触发一次渲染。
  // force:true 绕过元数据短缓存，保证用户主动刷新时拿到实时数据。
  if (globalThis.PullToRefresh) {
    PullToRefresh.mount({
      content: document.querySelector('.wrap'),
      anchor: document.querySelector('.topbar'),
      canRefresh: () => !!paneShelf && !paneShelf.hidden,
      onRefresh: async () => {
        if (globalThis.QJSync) await QJSync.syncNow({ timeout: 5000, onSynced: false }).catch(() => {});
        await renderShelf({ keepOld: true, force: true });
      },
    });
  }
  // 支持从顶部导航「历史」直接进到历史标签
  if (qs().tab === 'history') switchTab('history');

  // 全局点击委托：⋮ 打开菜单 / 菜单内「移出书架」/ 点击别处关闭菜单
  document.addEventListener('click', (e) => {
    const more = e.target.closest('.shelf-more');
    if (more) {
      e.preventDefault();
      const id = more.dataset.id;
      const src = more.dataset.src || curSrc;
      openRowMenu(more, {
        id,
        src,
        href: more.dataset.href || `${BASE}/book.html?src=${encodeURIComponent(src)}&id=${encodeURIComponent(id)}`,
      });
      return;
    }
    const rm = e.target.closest('.row-menu button[data-act="remove"]');
    if (rm) {
      const menu = rm.closest('.row-menu');
      removeBookmark(menu.dataset.rsrc, menu.dataset.rid);
      closeRowMenu();
      renderShelf();
      return;
    }
    if (_rowMenu && !e.target.closest('.row-menu')) closeRowMenu();
  });

  // 清空历史
  const clearBtn = document.getElementById('clearHist');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      if (!getHistory().length) return;
      if (confirm('确定清空全部阅读历史？')) {
        clearHistory();
        renderHistory();
      }
    });
  }
}

// 分发：解析真实默认源后再启动各页面，保证 ?src= 缺省时用后端同一默认源
document.addEventListener('DOMContentLoaded', async () => {
  await resolveDefaultSource();
  const page = document.body.dataset.page;
  const map = {
    home: homePage,
    search: searchPage,
    category: categoryPage,
    rank: rankPage,
    quanben: quanbenPage,
    book: bookPage,
    read: readPage,
    shelf: shelfPage,
  };
  initSearch();
  // 顶部导航：logo 可点回首页 + 全局「书架」入口
  const logo = document.querySelector('.logo');
  if (logo && logo.tagName === 'SPAN') logo.outerHTML = '<a class="logo" href="' + BASE + '/">' + logo.textContent + '</a>';
  const tb = document.querySelector('.topbar');
  if (tb && !tb.querySelector('.navlink')) {
    const sf = tb.querySelector('.search');
    const hist = document.createElement('a');
    hist.className = 'navlink';
    hist.href = U('/shelf.html');
    hist.textContent = '历史';
    hist.addEventListener('click', (e) => {
      // 跳到书架页并直接切到「历史」标签
      e.preventDefault();
      location.href = U('/shelf.html?tab=history');
    });
    const a = document.createElement('a');
    a.className = 'navlink';
    a.href = U('/shelf.html');
    a.textContent = '书架';
    tb.insertBefore(hist, sf);
    tb.insertBefore(a, sf);
  }
  if (map[page]) map[page]().catch((e) => {
    const box = document.getElementById('error');
    if (box) {
      const m = (e && e.message) || '';
      box.textContent = /502|源站/.test(m) ? '源站暂时访问不畅，请稍后重试～' : '加载失败：' + m;
    }
    console.error(e);
  });

  // favicon（统一内联，无需改每个页面）
  if (!document.querySelector('link[rel="icon"]')) {
    const link = document.createElement('link');
    link.rel = 'icon';
    link.href = U('/favicon.svg');
    document.head.appendChild(link);
  }
});
