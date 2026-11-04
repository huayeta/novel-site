// lib/sources/keca.js
// 数据源：m.keca.cc（笔趣阁移动站）+ www.keca.cc（PC 站取完整简介）。
// 策略：HTML 页面用 cheerio 解析；章节列表 / 正文走站点自带接口或 HTML 章节页。
// 搜索：本地索引 —— 抓取首页/分类/排行/全本列表页建 书名/作者/简介 索引，快且稳。

import * as cheerio from 'cheerio';
import { makeFetcher } from './_common.js';

const BASE = 'https://m.keca.cc';
const PC_BASE = 'https://www.keca.cc';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;
const jsonApi = f.json;
const pcHtml = f.pcHtml;

// ---------- 工具 ----------
const abs = (p) => (p && p.startsWith('/') ? BASE + p : p);
const bookId = (href) => {
  const m = (href || '').match(/\/xs_wap\/(\d+)\//);
  return m ? m[1] : '';
};
const cidOf = (url) => {
  const m = (url || '').match(/\/(\d+)\.html$/);
  return m ? m[1] : '';
};
// 封面 URL 规律：/img/{Math.floor(书号/1000)}/{书号}.jpg
const coverFromId = (id) => {
  id = String(id);
  if (!/^\d+$/.test(id)) return '';
  return `/img/${Math.floor(Number(id) / 1000)}/${id}.jpg`;
};
const catKeyFromUrl = (url) => {
  const m = (url || '').match(/\/(\w+?)_wap\//);
  return m ? m[1] : '';
};

const CATEGORIES = [
  { key: 'xuanhuanxiaoshuo', name: '玄幻小说' },
  { key: 'xiuzhenxiaoshuo', name: '修真小说' },
  { key: 'dushixiaoshuo', name: '都市小说' },
  { key: 'chuanyuexiaoshuo', name: '穿越小说' },
  { key: 'wangyouxiaoshuo', name: '网游小说' },
  { key: 'kehuanxiaoshuo', name: '科幻小说' },
  { key: 'yanqingxiaoshuo', name: '言情小说' },
];

const RANKS = [
  { key: 'weekvisit', name: '周点击' },
  { key: 'monthvisit', name: '月点击' },
  { key: 'allvisit', name: '总点击' },
  { key: 'dayvote', name: '日推荐' },
  { key: 'weekvote', name: '周推荐' },
  { key: 'monthvote', name: '月推荐' },
  { key: 'allvote', name: '总推荐' },
  { key: 'goodnum', name: '总收藏' },
  { key: 'size', name: '字数' },
  { key: 'postdate', name: '新书' },
];

// ---------- 解析器 ----------
function parseHome(text) {
  const $ = cheerio.load(text);
  const featured = [];
  const categories = [];

  $('#main > article').each((_, el) => {
    const $el = $(el);
    if ($el.find('.image').length) {
      const a = $el.find('.image a');
      const href = a.attr('href');
      featured.push({
        id: bookId(href),
        title: $el.find('.info h2.title').text().trim(),
        author: $el.find('.info p').first().text().replace('作者：', '').trim(),
        cover: a.find('img').attr('src') || '',
        intro: $el.find('.info p.intro').text().trim(),
      });
    } else if ($el.find('ul').length) {
      const name = $el.find('.name a').text().trim();
      const catUrl = $el.find('.name a').attr('href') || '';
      const books = [];
      $el.find('ul li a').each((_, li) => {
        const h = $(li).attr('href');
        const id = bookId(h);
        books.push({ id, title: $(li).find('h2.title').text().trim(), cover: coverFromId(id) });
      });
      categories.push({ key: catKeyFromUrl(catUrl), name, books });
    }
  });
  return { featured, categories };
}

function parseBook(text, id) {
  const $ = cheerio.load(text);
  const info = $('#main .info');
  let author = '';
  let category = null;
  let status = '';
  let update = '';
  info.find('p').each((_, p) => {
    const $p = $(p);
    const t = $p.text().trim();
    if (t.startsWith('作者：')) author = t.replace('作者：', '').trim();
    else if ($p.find('a').length && t.includes('类别'))
      category = { name: $p.find('a').text().trim(), url: $p.find('a').attr('href') || '' };
    else if (t.startsWith('状态：')) status = t.replace('状态：', '').trim();
    else if (t.startsWith('更新：')) update = t.replace('更新：', '').trim();
  });
  const newest = info.find('p.newest a');
  const latest = newest.length
    ? { name: newest.find('em').text().trim(), cid: cidOf(newest.attr('href') || '') }
    : null;
  return {
    id,
    title: info.find('h2.title').text().trim() || $('h1.title').text().trim(),
    author,
    cover: coverFromId(id),
    category,
    status,
    update,
    latest,
    intro: $('#main .introbar').text().trim(),
  };
}

// 通用书籍列表解析（分类/排行/全本 共用 #list > article 结构）
function parseBookList(text) {
  const $ = cheerio.load(text);
  const books = [];
  $('#list > article').each((_, el) => {
    const $el = $(el);
    const a = $el.find('.image a');
    const href = a.attr('href');
    const id = bookId(href);
    if (!id) return;
    books.push({
      id,
      title: $el.find('.info h2.title').text().trim(),
      author: $el.find('.info p').first().text().replace('作者：', '').trim(),
      cover: coverFromId(id),
      intro: $el.find('.info p.intro').text().trim(),
    });
  });
  return books;
}

// ---------- 对外接口 ----------
async function getHome() {
  const text = await html(BASE + '/');
  const { featured, categories } = parseHome(text);
  return {
    featured,
    categories: CATEGORIES.map((c) => ({
      ...c,
      books: (categories.find((x) => x.key === c.key) || {}).books || [],
    })),
  };
}

async function getBook(id) {
  const [text, pcText] = await Promise.all([
    html(abs(`/xs_wap/${id}/`)),
    pcHtml(`${PC_BASE}/xs/${id}/`).catch(() => ''),
  ]);
  const book = parseBook(text, id);
  const fullIntro = pcText ? pcIntroFrom(pcText) : '';
  if (fullIntro && fullIntro.length > (book.intro || '').length) book.intro = fullIntro;
  return book;
}

// 从 PC 详情页 .intro 提取完整简介（去掉站点宣传尾巴）
function pcIntroFrom(text) {
  const $ = cheerio.load(text);
  const box = $('.intro');
  if (!box.length) return '';
  const parts = [];
  box.find('p').each((_, p) => {
    let t = $(p).text().replace(/\s+/g, ' ').trim();
    t = t.replace(/本站提示[\s\S]*$/, '').replace(/各位书友要是觉得[\s\S]*$/, '').trim();
    if (t) parts.push(t);
  });
  return parts.join('\n').trim();
}

async function getChapters(id) {
  const j = await jsonApi(`${BASE}/api/list?bid=${id}&page_num=1`);
  if (j.code !== 0 || !j.data || !j.data.chapter_list) return [];
  return j.data.chapter_list
    .map((c) => ({
      title: c.chapter_name,
      cid: cidOf(c.chapter_url),
    }))
    // 按章节号（cid 数值）升序，得到稳定的“从第一章到最新”阅读顺序，
    // 避免个别源站返回顺序异常导致目录错乱。
    .sort((a, b) => Number(a.cid || 0) - Number(b.cid || 0));
}

async function getChapter(cid, bid) {
  // 注意：源站 /api/content 接口返回的内容被注入广告、且会丢失真实开篇段落，
  // 因此改用 HTML 章节页（#text p）解析，内容完整、准确。
  const text = await html(abs(`/xs_wap/${bid}/${cid}.html`), 24 * 60 * 60 * 1000);
  const $ = cheerio.load(text);
  const paras = [];
  $('#text p').each((_, el) => {
    const t = $(el).text().trim();
    // 仅过滤明确的站点广告语，避免误删正文（部分小说正文本身含“手游”等词）
    if (t && !/笔趣阁|本章未完|一秒记住|手机阅读/.test(t)) paras.push(t);
  });
  if (paras.length) return { paragraphs: paras };
  // 兜底：接口内容虽可能含广告/不全，但至少可用
  try {
    const j = await jsonApi(`${BASE}/api/content?cid=${cid}`);
    if (j.code === 0 && j.data && j.data.contents) {
      const c = j.data.contents;
      return {
        paragraphs: (Array.isArray(c) ? c : [c])
          .map((p) => String(p).trim())
          .filter((p) => p && !/笔趣阁|本章未完|一秒记住|手机阅读/.test(p)),
      };
    }
  } catch (e) {}
  return { paragraphs: [] };
}

async function getCategory(catKey) {
  const meta = CATEGORIES.find((c) => c.key === catKey);
  if (!meta) throw new Error('未知分类: ' + catKey);
  const text = await html(abs(`/${catKey}_wap/`));
  return { name: meta.name, books: parseBookList(text) };
}

async function getRank(rankKey) {
  const meta = RANKS.find((r) => r.key === rankKey);
  if (!meta) throw new Error('未知排行: ' + rankKey);
  const text = await html(abs(`/paihang_wap/${rankKey}/1.html`));
  return { name: meta.name, books: parseBookList(text) };
}

const QUANBEN_SORTS = [
  'allvisit', 'weekvisit', 'monthvisit', 'dayvote', 'weekvote',
  'monthvote', 'allvote', 'goodnum', 'size', 'postdate',
];

async function getQuanben(sort = 'allvisit') {
  if (!QUANBEN_SORTS.includes(sort)) sort = 'allvisit';
  const text = await html(abs(`/quanben_wap/${sort}/1.html`));
  return { name: '全本小说', books: parseBookList(text) };
}

function categoryList() {
  return CATEGORIES;
}
function rankList() {
  return RANKS;
}

// ---------- 搜索：本地索引（带 TTL，避免每次搜索都重抓 19 个列表页）----------
let indexCache = { at: 0, books: [] };
let lastBuildTry = 0;
const INDEX_TTL = 5 * 60 * 1000; // 索引有效期 5 分钟
const INDEX_RETRY = 60 * 1000; // 构建失败后 1 分钟内不重复重试，避免源站异常时反复回源

async function buildIndex() {
  const tasks = [
    html(BASE + '/'),
    ...CATEGORIES.map((c) => html(abs(`/${c.key}_wap/`))),
    ...RANKS.map((r) => html(abs(`/paihang_wap/${r.key}/1.html`))),
    html(abs('/quanben_wap/allvisit/1.html')),
  ];
  const pages = await Promise.allSettled(tasks);
  const books = [];
  const seen = new Set();
  for (const p of pages) {
    if (p.status !== 'fulfilled') continue;
    const parsed = parseBookList(p.value);
    for (const b of parsed) {
      if (!b.id || seen.has(b.id)) continue;
      seen.add(b.id);
      books.push(b);
    }
  }
  indexCache = { at: Date.now(), books };
  return books;
}

async function search(q) {
  q = (q || '').trim();
  if (!q) return [];
  // 索引未过期直接复用；过期才重建（失败时回退到上次成功的索引，且 1 分钟内不重试）。
  // 服务端 /api/search 另有 5 分钟缓存，两层叠加后新书最长约 10 分钟可见。
  const now = Date.now();
  const fresh = indexCache.books.length > 0 && now - indexCache.at < INDEX_TTL;
  if (!fresh && (!indexCache.books.length || now - lastBuildTry >= INDEX_RETRY)) {
    lastBuildTry = now;
    try {
      await buildIndex();
    } catch (e) {
      /* 索引构建失败则使用上次成功的索引（若有） */
    }
  }
  const idx = indexCache.books;
  const lower = q.toLowerCase();
  return idx.filter(
    (b) =>
      (b.title && b.title.toLowerCase().includes(lower)) ||
      (b.author && b.author.toLowerCase().includes(lower)) ||
      (b.intro && b.intro.toLowerCase().includes(lower))
  );
}

// 服务启动时预热索引（best-effort）
function warmIndex() {
  buildIndex().catch(() => {});
}

export default {
  id: 'keca',
  name: '笔趣阁',
  base: BASE,
  searchable: true,
  getHome,
  getBook,
  getChapters,
  getChapter,
  getCategory,
  getRank,
  getQuanben,
  categoryList,
  rankList,
  search,
  warmIndex,
};
