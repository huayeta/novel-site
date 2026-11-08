// lib/sources/ibqg.js
// 数据源：www.ibiqugu.net（站名「香书小说」，静态 XHTML，UTF-8）。
// 已实测：纯 fetch 可达、无 CF、无 JS 渲染、无字体加密。
//
// URL 规律：
//   搜索   POST /modules/article/waps.php  表单 searchkey=<关键词>（GET /search.php 已废弃）
//          → .grid <table> 50 条/页，含 文章名称/最新章节(带 cid)/作者/更新
//   书籍   /<dir>/<id>/   → 书籍信息 + 全部章节目录（同一页！#list 里 890 章）
//   正文   /<dir>/<id>/<cid>.html → #content，<br> 分段，无分页
//   分类   /<xuanhuan|xiuzhen|dushi|chuanyue|wangyou|kehuan>xiaoshuo/
//   排行   /paihangbang/
//   封面   /files/article/image/<dir>/<id>/<id>s.jpg
//
// 按需求：搜索直接用 POST 接口，不建本地索引、不使用 /xiaoshuodaquan/ 书库页。
// 注意：书籍页在 #info 里置顶了一份「最新章节」链接，#list 是完整正序目录；
// 统一按 cid 去重 + 数值升序还原阅读顺序。

import * as cheerio from 'cheerio';
import { makeFetcher, withTimeout } from './_common.js';

const BASE = 'http://www.ibiqugu.net';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;

// ---------- 工具 ----------
const dirOf = (id) => Math.floor(Number(id) / 1000);
const coverOf = (id) => `/files/article/image/${dirOf(id)}/${id}/${id}s.jpg`;
const bookUrl = (id) => `${BASE}/${dirOf(id)}/${id}/`;
const chapterUrl = (id, cid) => `${BASE}/${dirOf(id)}/${id}/${cid}.html`;
const idFromBook = (h) => (String(h || '').match(/\/(\d+)\/(\d+)\/?$/) || [])[2] || '';
const dirFromBook = (h) => (String(h || '').match(/\/(\d+)\/(\d+)\/?$/) || [])[1] || '';
const cidFrom = (h) => (String(h || '').match(/\/(\d+)\.html$/) || [])[1] || '';

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

// key 同时用作站点分类路径名；前端 category.html?cat=<key> 与 catKeyFromUrl 配套。
const CATEGORIES = [
  { key: 'xuanhuanxiaoshuo', name: '玄幻小说' },
  { key: 'xiuzhenxiaoshuo', name: '修真小说' },
  { key: 'dushixiaoshuo', name: '都市小说' },
  { key: 'chuanyuexiaoshuo', name: '穿越小说' },
  { key: 'wangyouxiaoshuo', name: '网游小说' },
  { key: 'kehuanxiaoshuo', name: '科幻小说' },
];

// 站点只有一个 /paihangbang/ 聚合页（内含 8 个分块榜单），所有 key 都指向它；
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

// ---------- 通用书籍列表解析（分类 / 排行 / 首页 共用）----------
// 书链 /<dir>/<id>/，多半是图片链接（img[alt]=书名），作者不一定在同一块内。
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
    const am = (blk.text() || '').match(/作\s*者[：:]\s*([^\s，,]+)/);
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
      const t = await withTimeout(html(`${BASE}/${c.key}/`), 6000, '');
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
  const author = (info.match(/作\s*者[：:]\s*([^\s，,]+)/) || [])[1] || '';
  const update = (info.match(/最后更新[：:]\s*([\d-]+\s[\d:]+)/) || [])[1] || '';
  const status = /完结|完本/.test(info) ? '已完结' : '连载中';
  // 简介在「手机阅读《书名》…」提示语之后
  const im = main.match(/无弹窗纯文字全文免费阅读\s+([\s\S]*?)(?:\s*推荐阅读|$)/);
  const intro = im ? im[1].trim() : '';
  const catName = ($('.con_top').text().match(/>\s*([^>\s]+小说)\s*>/) || [])[1] || '';
  const meta = CATEGORIES.find((c) => c.name === catName);
  const category = meta ? { name: meta.name, url: `/${meta.key}_wap/` } : null;
  return { id, title, author, cover: coverOf(id), category, status, update, intro, latest: null };
}

// ---------- 章节目录（就在书籍页里，全量）----------
async function getChapters(id) {
  const $ = cheerio.load(await bookHtml(id));
  const map = new Map();
  $('#list a[href$=".html"], #info a[href$=".html"]').each((_, el) => {
    const $a = $(el);
    const cid = cidFrom($a.attr('href'));
    const title = $a.text().trim();
    if (!cid || !title) return;
    if (!/第.{0,12}[章节回]|序章|楔子|番外|后记|感言|完本|大结局|尾声|结卷/.test(title)) return;
    // 置顶「最新章节」标题可能带卷名前缀，目录里的更干净，取更短的那个
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
  root.find('#content_tip, script, style').remove();
  const paras = (root.html() || '')
    .split(/<br\s*\/?>/i)
    .map(stripTags)
    .filter(
      (t) =>
        t &&
        // 站点会在正文末尾追加推广段（如「手机站全新改版升级地址：http://wap.ibiqugu.net…」），
        // 以及「给个好评呗」等链接文案；这些都不是小说正文，统一过滤掉。
        !/最新网址|香书小说|手机阅读|本章未完|加入书签|请收藏|记住网址|txt下载|推荐票|手机站|wap\.ibiqugu|全新改版|无广告清新|给个好评|点击进去|分数越高/i.test(t)
    );
  if (paras.length && /^第.{0,15}[章节回集]\s*[:：]?\s*$/.test(paras[0])) paras.shift();
  return { paragraphs: paras };
}

// ---------- 搜索：POST /modules/article/waps.php ----------
async function search(q) {
  q = (q || '').trim();
  if (!q) return [];
  const text = await f.req(`${BASE}/modules/article/waps.php`, {
    method: 'POST',
    body: 'searchkey=' + encodeURIComponent(q),
    extraHeaders: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: BASE + '/modules/article/waps.php',
    },
  });
  const $ = cheerio.load(text);
  const out = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 4) return; // 表头是 <th>
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
      update: tds.eq(3).text().trim(),
      latest: latestCid ? { name: a1.text().trim(), cid: latestCid } : null,
    });
  });
  return out;
}

// ---------- 分类 / 排行 / 全本 ----------
async function getCategory(catKey) {
  const meta = CATEGORIES.find((c) => c.key === catKey) || CATEGORIES[0];
  const text = await html(`${BASE}/${meta.key}/`);
  return { name: meta.name, books: parseList(text) };
}

async function getRank() {
  // 站点只有一个聚合排行榜页（内含 8 个分块），所有榜单共用
  const text = await html(`${BASE}/paihangbang/`);
  return { name: '排行榜单', books: parseList(text).slice(0, 60) };
}

async function getQuanben() {
  // 按需求不使用 /xiaoshuodaquan/ 书库页，用排行榜页兜底
  const text = await html(`${BASE}/paihangbang/`);
  return { name: '全本小说', books: parseList(text).slice(0, 60) };
}

function categoryList() {
  return CATEGORIES.map(({ key, name }) => ({ key, name }));
}
function rankList() {
  return RANKS.map(({ key, name }) => ({ key, name }));
}

export default {
  id: 'ibqg',
  name: '香书小说',
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
  // 搜索走 POST 接口，无需本地索引；按需求不使用书库页
  warmIndex() {},
};
