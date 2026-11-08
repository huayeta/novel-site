// lib/sources/xq.js
// 数据源：www.xianqihaotianmi.org（站名「言情小说阁」，杰奇 CMS 风格，静态 HTML，UTF-8）。
// 已实测：纯 fetch 可达、无 CF、无 JS 渲染、无字体加密。
//
// URL 规律：
//   搜索   /modules/article/search.php?searchkey=<UTF-8>  → <table> 100 条/页
//   书籍   /book/<id>.html   → 书籍信息 + 全部章节目录（同一页！）
//   正文   /read/<id>_<cid>.html → .content-body，<br> 分段，无分页
//   分类   /list/<n>-1.html
//   排行   /book/<key>-1.html
//   封面   /files/article/image/<floor(id/1000)>/<id>/<id>s.jpg
//
// 注意：书籍页把「最新章」置顶了一份（.info3 里），章节列表 .list-group 是完整正序；
// 统一按 cid 去重 + 数值升序还原阅读顺序。

import * as cheerio from 'cheerio';
import { makeFetcher, withTimeout } from './_common.js';

const BASE = 'http://www.xianqihaotianmi.org';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;

// ---------- 工具 ----------
const dirOf = (id) => Math.floor(Number(id) / 1000);
const coverOf = (id) => `/files/article/image/${dirOf(id)}/${id}/${id}s.jpg`;
const bookUrl = (id) => `${BASE}/book/${id}.html`;
const chapterUrl = (id, cid) => `${BASE}/read/${id}_${cid}.html`;
const idFromBook = (h) => (String(h || '').match(/\/book\/(\d+)\.html/) || [])[1] || '';
const cidFromRead = (h) => (String(h || '').match(/\/read\/\d+_(\d+)\.html/) || [])[1] || '';

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const CATEGORIES = [
  { key: 'xuanhuan', name: '玄幻', n: 1 },
  { key: 'xianxia', name: '仙侠', n: 2 },
  { key: 'yanqing', name: '言情', n: 3 },
  { key: 'lishi', name: '历史', n: 4 },
  { key: 'wangyou', name: '网游', n: 5 },
  { key: 'kehuan', name: '科幻', n: 6 },
  { key: 'kongbu', name: '恐怖', n: 7 },
  { key: 'qita', name: '其他', n: 8 },
];

// 前端 homePage 硬编码请求 /api/rank/<src>/postdate，故必须含 postdate；
// 未知 key 回退首个榜单，避免 404 导致栏目空白。
const RANKS = [
  { key: 'postdate', name: '最新入库', file: 'postdate' },
  { key: 'allvisit', name: '总排行榜', file: 'allvisit' },
  { key: 'weekvisit', name: '本周排行榜', file: 'weekvisit' },
  { key: 'monthvisit', name: '当月排行榜', file: 'monthvisit' },
  { key: 'allvote', name: '总推荐榜', file: 'allvote' },
  { key: 'weekvote', name: '本周推荐榜', file: 'weekvote' },
  { key: 'monthvote', name: '当月推荐榜', file: 'monthvote' },
];

// ---------- 书籍页短缓存：/api/book 会分别调 getChapters 与 getBook，避免同一页回源两次 ----------
let bookCache = { id: '', at: 0, text: '' };
const BOOK_TTL = 60 * 1000;
async function bookHtml(id) {
  if (bookCache.id === String(id) && Date.now() - bookCache.at < BOOK_TTL) return bookCache.text;
  const text = await html(bookUrl(id));
  bookCache = { id: String(id), at: Date.now(), text };
  return text;
}

// ---------- 通用书籍列表解析（分类 / 排行 / 首页 共用）----------
// 书链形如 /book/<id>.html，文字或 title 属性为书名；作者不一定在同一块内，取不到留空。
function parseList(text) {
  const $ = cheerio.load(text);
  const out = [];
  const seen = new Set();
  $('a[href*="/book/"]').each((_, el) => {
    const $a = $(el);
    const id = idFromBook($a.attr('href'));
    if (!id || seen.has(id)) return;
    let title = ($a.attr('title') || $a.text().trim() || $a.find('img').attr('title') || '')
      .replace(/(全文阅读|最新章节|无弹窗)$/g, '')
      .trim();
    if (!title) return;
    seen.add(id);
    const blk = $a.closest('.media, .list-group-item, li, div');
    const am = (blk.text() || '').match(/作者[:：]\s*([^\s，,()]+)/);
    const pm = (blk.text() || '').match(/\(([^)]{2,12})\)/);
    out.push({ id, title, author: am ? am[1] : pm ? pm[1] : '', cover: coverOf(id) });
  });
  return out;
}

// ---------- 首页 ----------
async function getHome() {
  const text = await html(BASE + '/');
  const featured = parseList(text).slice(0, 12).map((b) => ({ ...b, intro: '' }));
  const settled = await Promise.allSettled(
    CATEGORIES.map(async (c) => {
      const t = await withTimeout(html(`${BASE}/list/${c.n}-1.html`), 6000, '');
      return { key: c.key, name: c.name, books: t ? parseList(t).slice(0, 8) : [] };
    })
  );
  const categories = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  return { featured, categories };
}

// ---------- 书籍详情 ----------
async function getBook(id) {
  const $ = cheerio.load(await bookHtml(id));
  const body = $('body').text().replace(/\s+/g, ' ');
  const title = $('h1').first().text().trim();
  const author = ($('.info h3').first().text().match(/作者[:：]\s*([^\s，,]+)/) || [])[1] || '';
  const status = (body.match(/写作状态[：:]\s*([^\s\/]+)/) || [])[1] || '';
  const update = (body.match(/最后更新[：:]\s*([\d-]+\s[\d:]+|\d{4}-\d{2}-\d{2})/) || [])[1] || '';
  const catName = (body.match(/小说类别[：:]\s*([^\s\/]+)/) || [])[1] || '';
  // 简介在 .info 里，「作者:xxx」之后直到块尾（「小说类别」在另一个 panel 里，不能用它截断）
  const info = $('.info').text().replace(/\s+/g, ' ');
  const im = info.match(/作者[:：]\S+\s+([\s\S]+)$/);
  const intro = im ? im[1].trim() : '';
  // 书籍页写「玄幻魔法」，分类导航写「玄幻」，用包含匹配兼容两种写法
  const meta = CATEGORIES.find(
    (c) => c.name === catName || catName.includes(c.name) || c.name.includes(catName)
  );
  const category = meta ? { name: meta.name, url: `/${meta.key}_wap/` } : null;
  return { id, title, author, cover: coverOf(id), category, status, update, intro, latest: null };
}

// ---------- 章节目录（就在书籍页里，全量）----------
async function getChapters(id) {
  const $ = cheerio.load(await bookHtml(id));
  const map = new Map();
  $('a[href^="/read/"]').each((_, el) => {
    const $a = $(el);
    const cid = cidFromRead($a.attr('href'));
    const title = $a.text().trim();
    if (!cid || !title) return;
    if (!/第.{0,12}[章节回]|序章|楔子|番外|后记|感言|完本|大结局|尾声|结卷/.test(title)) return;
    // 置顶的「最新章」标题带卷名前缀（如「第一卷：默认 第196章」），目录里的更干净，取更短的那个
    const prev = map.get(cid);
    if (!prev || title.length < prev.title.length) map.set(cid, { cid, title });
  });
  return [...map.values()].sort((a, b) => Number(a.cid) - Number(b.cid));
}

// ---------- 章节正文 ----------
async function getChapter(cid, bid) {
  const text = await html(chapterUrl(bid, cid), 24 * 60 * 60 * 1000);
  const $ = cheerio.load(text);
  const root = $('.content-body').length ? $('.content-body').first() : $('.panel-body').first();
  if (!root.length) return { paragraphs: [] };
  root.find('script, style, .pager, .alert').remove();
  const paras = (root.html() || '')
    .split(/<br\s*\/?>/i)
    .map(stripTags)
    .filter(
      (t) =>
        t &&
        !/最新网址|言情小说阁|手机阅读|本章未完|加入书签|请收藏|记住网址|txt下载|上一篇|下一篇/i.test(t)
    );
  if (paras.length && /^第.{0,15}[章节回集]\s*[:：]?\s*$/.test(paras[0])) paras.shift();
  return { paragraphs: paras };
}

// ---------- 搜索 ----------
async function search(q) {
  q = (q || '').trim();
  if (!q) return [];
  const url = `${BASE}/modules/article/search.php?searchkey=${encodeURIComponent(q)}`;
  const $ = cheerio.load(await html(url, 5 * 60 * 1000));
  const out = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 5) return; // 表头是 <th>
    const a = tds.eq(1).find('a').first();
    const id = idFromBook(a.attr('href'));
    const title = a.text().trim();
    if (!id || !title) return;
    out.push({
      id,
      title,
      author: tds.eq(2).text().trim(),
      cover: coverOf(id),
      update: tds.eq(3).text().trim(),
      status: tds.eq(4).text().trim(),
      latest: null, // 搜索结果表不含最新章节列
    });
  });
  return out;
}

// ---------- 分类 / 排行 / 全本 ----------
async function getCategory(catKey) {
  const meta = CATEGORIES.find((c) => c.key === catKey) || CATEGORIES[0];
  const text = await html(`${BASE}/list/${meta.n}-1.html`);
  return { name: meta.name, books: parseList(text) };
}

async function getRank(rankKey) {
  const meta = RANKS.find((r) => r.key === rankKey) || RANKS[0];
  const text = await html(`${BASE}/book/${meta.file}-1.html`);
  return { name: meta.name, books: parseList(text) };
}

async function getQuanben() {
  // 站点无独立全本页，用总排行榜兜底（前端 sort 参数忽略）
  const text = await html(`${BASE}/book/allvisit-1.html`);
  return { name: '全本小说', books: parseList(text) };
}

function categoryList() {
  return CATEGORIES.map(({ key, name }) => ({ key, name }));
}
function rankList() {
  return RANKS.map(({ key, name }) => ({ key, name }));
}

export default {
  id: 'xq',
  name: '言情小说阁',
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
  // 有站内搜索接口，无需本地索引
  warmIndex() {},
};
