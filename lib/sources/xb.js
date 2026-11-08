// lib/sources/xb.js
// 数据源：www.xbiquwk.com（站名「笔尖中文」，静态 XHTML，UTF-8）。
// 即早期 biquge.info 页面所写「最新网址」的主域名；同站不同域。
// 已实测：纯 fetch 可达、无 CF、无 JS 渲染、无字体加密。
//
// URL 规律：
//   搜索   GET/POST /modules/article/search.php?searchkey=<UTF-8>  → <table> 50 条/页（6 列）
//   书籍   /<dir>_<id>/   → 书籍信息 + 全部章节目录（同一页！#list 里 1614 章）
//   正文   /<dir>_<id>/<cid>.html → #content，<br> 分段，无分页
//   分类   /list/<n>_1.html
//   排行   /paihangbang_allvisit/1.html
//   全本   /wanjiexiaoshuo/
//   封面   /files/article/image/<dir>/<id>/<id>s.jpg（部分书用 nocover.jpg 占位）
//
// 注意：书链用下划线 dir_id（不是 /dir/id/），章节链接是相对 <cid>.html。

import * as cheerio from 'cheerio';
import { makeFetcher, withTimeout } from './_common.js';

const BASE = 'http://www.xbiquwk.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;

// ---------- 工具 ----------
const dirOf = (id) => Math.floor(Number(id) / 1000);
const coverOf = (id) => `/files/article/image/${dirOf(id)}/${id}/${id}s.jpg`;
const bookUrl = (id) => `${BASE}/${dirOf(id)}_${id}/`;
const chapterUrl = (id, cid) => `${BASE}/${dirOf(id)}_${id}/${cid}.html`;
const idFromBook = (h) => (String(h || '').match(/\/(\d+)_(\d+)\/?$/) || [])[2] || '';
const cidFrom = (h) => (String(h || '').match(/(\d+)\.html$/) || [])[1] || '';

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
  { key: 'xuanhuan', name: '玄幻小说', n: 1 },
  { key: 'xiuzhen', name: '修真小说', n: 2 },
  { key: 'dushi', name: '都市小说', n: 3 },
  { key: 'chuanyue', name: '穿越小说', n: 4 },
  { key: 'wangyou', name: '网游小说', n: 5 },
  { key: 'kehuan', name: '科幻小说', n: 6 },
];

// 站点已验证的排行榜页只有 /paihangbang_allvisit/1.html，所有 key 共用；
// postdate 是前端 homePage 硬编码的 key，必须存在，否则首页「最新收录」栏 404。
const RANKS = [
  { key: 'postdate', name: '最新收录' },
  { key: 'allvisit', name: '总排行榜' },
  { key: 'allvote', name: '总推荐榜' },
  { key: 'goodnum', name: '总收藏榜' },
  { key: 'size', name: '字数榜' },
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

// ---------- 通用书籍列表解析（分类 / 排行 / 全本 / 首页 共用）----------
// 书链 /<dir>_<id>/，多半是图片链接（img[alt]=书名）。
function parseList(text) {
  const $ = cheerio.load(text);
  const out = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const id = idFromBook($a.attr('href'));
    if (!id || seen.has(id)) return;
    const title =
      ($a.find('img').attr('alt') || $a.attr('title') || $a.text().trim() || '')
        .replace(/(最新章节|全文阅读|无弹窗)$/g, '')
        .trim();
    if (!title) return;
    seen.add(id);
    const blk = $a.closest('.item, li, tr, .box, div');
    const am = (blk.text() || '').match(/作\s*者[:：]\s*([^\s，,]+)/);
    out.push({ id, title, author: am ? am[1] : '', cover: coverOf(id) });
  });
  return out;
}

// ---------- 首页 ----------
async function getHome() {
  const text = await html(BASE + '/');
  const featured = parseList(text).slice(0, 12).map((b) => ({ ...b, intro: '' }));
  const settled = await Promise.allSettled(
    CATEGORIES.map(async (c) => {
      const t = await withTimeout(html(`${BASE}/list/${c.n}_1.html`), 6000, '');
      return { key: c.key, name: c.name, books: t ? parseList(t).slice(0, 8) : [] };
    })
  );
  const categories = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  return { featured, categories };
}

// ---------- 书籍详情 ----------
async function getBook(id) {
  const $ = cheerio.load(await bookHtml(id));
  const info = $('#info').text().replace(/\s+/g, ' ');
  const main = $('#maininfo').text().replace(/\s+/g, ' ');
  const title = $('h1').first().text().trim();
  const author = (info.match(/作\s*者[:：]\s*([^\s，,]+)/) || [])[1] || '';
  const update = (info.match(/最后更新\s*[:：]\s*([\d-]+\s[\d:]+)/) || [])[1] || '';
  const catName = (info.match(/类\s*别[:：]\s*([^\s，,]+)/) || [])[1] || '';
  const status = /完结|完本/.test(info) ? '已完结' : '连载中';
  // 简介在「直达底部」之后、「本站提示」之前
  const im = main.match(/直达底部\s+([\s\S]*?)(?:\s*本站提示|\s*推荐阅读|$)/);
  const intro = im ? im[1].trim() : '';
  const meta = CATEGORIES.find((c) => c.name === catName);
  const category = meta ? { name: meta.name, url: `/${meta.key}_wap/` } : null;
  return { id, title, author, cover: coverOf(id), category, status, update, intro, latest: null };
}

// ---------- 章节目录（就在书籍页里，全量）----------
async function getChapters(id) {
  const $ = cheerio.load(await bookHtml(id));
  const map = new Map();
  $('#list a[href$=".html"]').each((_, el) => {
    const $a = $(el);
    const cid = cidFrom($a.attr('href'));
    const title = $a.text().trim();
    if (!cid || !title) return;
    if (!/第.{0,12}[章节回]|序章|楔子|番外|后记|感言|完本|大结局|尾声|结卷/.test(title)) return;
    const prev = map.get(cid);
    if (!prev || title.length < prev.title.length) map.set(cid, { cid, title });
  });
  return [...map.values()].sort((a, b) => Number(a.cid) - Number(b.cid));
}

// ---------- 章节正文 ----------
async function getChapter(cid, bid) {
  const text = await html(chapterUrl(bid, cid), 24 * 60 * 60 * 1000);
  const $ = cheerio.load(text);
  const root = $('#content');
  if (!root.length) return { paragraphs: [] };
  root.find('script, style').remove();
  const paras = (root.html() || '')
    .split(/<br\s*\/?>/i)
    .map(stripTags)
    .filter(
      (t) =>
        t &&
        !/最新网址|笔尖中文|手机阅读|本章未完|加入书签|请收藏|记住网址|txt下载|推荐票/i.test(t)
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
    if (tds.length < 6) return; // 表头是 <th>
    const a0 = tds.eq(0).find('a').first();
    const id = idFromBook(a0.attr('href'));
    const title = a0.text().trim();
    if (!id || !title) return;
    const a1 = tds.eq(1).find('a').first();
    const latestCid = cidFrom(a1.attr('href'));
    out.push({
      id,
      title,
      author: tds.eq(2).text().trim(),
      cover: coverOf(id),
      wordCount: tds.eq(3).text().trim(),
      update: tds.eq(4).text().trim(),
      status: tds.eq(5).text().trim(),
      latest: latestCid ? { name: a1.text().trim(), cid: latestCid } : null,
    });
  });
  return out;
}

// ---------- 分类 / 排行 / 全本 ----------
async function getCategory(catKey) {
  const meta = CATEGORIES.find((c) => c.key === catKey) || CATEGORIES[0];
  const text = await html(`${BASE}/list/${meta.n}_1.html`);
  return { name: meta.name, books: parseList(text) };
}

async function getRank() {
  // 站点已验证的排行榜页只有一个，所有榜单共用
  const text = await html(`${BASE}/paihangbang_allvisit/1.html`);
  return { name: '排行榜单', books: parseList(text) };
}

async function getQuanben() {
  const text = await html(`${BASE}/wanjiexiaoshuo/`);
  return { name: '全本小说', books: parseList(text) };
}

function categoryList() {
  return CATEGORIES.map(({ key, name }) => ({ key, name }));
}
function rankList() {
  return RANKS.map(({ key, name }) => ({ key, name }));
}

export default {
  id: 'xb',
  name: '笔尖中文',
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
