// lib/sources/biqusa.js
// 数据源：www.biqusa.com（站名「爱曲小说」，静态 HTML，UTF-8）。
// 已实测：纯 fetch 可达、无 CF、无 JS 渲染、无字体加密、搜索无限流。
//
// URL 规律：
//   搜索   GET /search.html?name=<UTF-8>  → .novelslist2 > ul > li（首 li 表头）
//   书籍   /<dir>_<id>/                   （dir = floor(id/1000)，下划线）
//   目录   同书籍页，章节 /<dir>_<id>/<cid>.html
//   正文   /<dir>_<id>/<cid>.html         → #content，<br> 分段，无分页
//   分类   /<x>xiaoshuo/                  （7 类：玄幻/修真/都市/穿越/网游/科幻/其它）
//   排行   /paihangbang/
//   全本   /wanben/1_1
//   封面   /files/article/image/<dir>/<id>/<id>s.jpg（meta[og:image]）
//   简介   meta[og:description]
//
// 注意：搜索参数必须是 name（searchkey/q 无效）；书链为 <dir>_<id> 下划线格式（同 xb）；
// 正文首段为站点广告「天才一秒记住本站地址…」，需过滤；正文容器是标准 #content。

import * as cheerio from 'cheerio';
import { makeFetcher, withTimeout } from './_common.js';

const BASE = 'https://www.biqusa.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;

// ---------- 工具 ----------
const dirOf = (id) => Math.floor(Number(id) / 1000);
const coverOf = (id) => `/files/article/image/${dirOf(id)}/${id}/${id}s.jpg`;
const bookDir = (id) => `/${dirOf(id)}_${id}/`;
const bookUrl = (id) => `${BASE}${bookDir(id)}`;
const chapterUrl = (id, cid) => `${BASE}${bookDir(id)}${cid}.html`;

const idFrom = (h) => {
  const m = String(h || '').match(/\/(\d+)_(\d+)\//);
  return m ? m[2] : '';
};
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

const CATEGORIES = [
  { key: 'xuanhuan', name: '玄幻小说', slug: 'xuanhuanxiaoshuo' },
  { key: 'xiuzhen', name: '修真小说', slug: 'xiuzhenxiaoshuo' },
  { key: 'dushi', name: '都市小说', slug: 'dushixiaoshuo' },
  { key: 'chuanyue', name: '穿越小说', slug: 'chuanyuexiaoshuo' },
  { key: 'wangyou', name: '网游小说', slug: 'wangyouxiaoshuo' },
  { key: 'kehuan', name: '科幻小说', slug: 'kehuanxiaoshuo' },
  { key: 'qita', name: '其它小说', slug: 'qitaxiaoshuo' },
];

// 仅一个总排行榜单
const RANKS = [{ key: 'all', name: '排行榜单' }];

const CHAPTER_RE = /第.{0,12}[章节回]|序章|楔子|番外|后记|感言|完本|大结局|尾声|结卷|终章|正文|引子/;

// ---------- 通用书籍列表解析（分类 / 排行 / 全本 / 首页 共用）----------
function parseList(text) {
  const $ = cheerio.load(text);
  const out = [];
  const seen = new Set();
  $('a[href*="/"]').each((_, el) => {
    const $a = $(el);
    const h = $a.attr('href') || '';
    if (!/^\/\d+_\d+\/$/.test(h)) return; // 仅书籍页 /<dir>_<id>/
    const id = idFrom(h);
    if (!id || seen.has(id)) return;
    const title =
      ($a.attr('title') || $a.find('img').attr('alt') || $a.text().trim() || '')
        .replace(/(最新章节列表|最新章节目录|全文阅读|无弹窗)$/g, '')
        .trim();
    if (!title) return;
    seen.add(id);
    out.push({ id, title, author: '', cover: coverOf(id) });
  });
  return out;
}

// ---------- 目录提取（getBook / getChapters 共用）----------
function extractChapters($) {
  const map = new Map();
  $('a[href$=".html"]').each((_, el) => {
    const $a = $(el);
    const h = $a.attr('href') || '';
    if (!/^\/\d+_\d+\/\d+\.html$/.test(h)) return;
    const cid = cidFrom(h);
    const title = $a.text().trim();
    if (!cid || !title) return;
    if (!CHAPTER_RE.test(title)) return;
    const prev = map.get(cid);
    if (!prev || title.length < prev.title.length) map.set(cid, { cid, title });
  });
  return [...map.values()].sort((a, b) => Number(a.cid) - Number(b.cid));
}

// ---------- 首页 ----------
async function getHome() {
  const text = await html(BASE + '/');
  const featured = parseList(text).slice(0, 12).map((b) => ({ ...b, intro: '' }));
  const settled = await Promise.allSettled(
    CATEGORIES.map(async (c) => {
      const t = await withTimeout(html(`${BASE}/${c.slug}/`), 6000, '');
      return { key: c.key, name: c.name, books: t ? parseList(t).slice(0, 8) : [] };
    })
  );
  const categories = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  return { featured, categories };
}

// ---------- 书籍详情 ----------
async function getBook(id) {
  const $ = cheerio.load(await html(bookUrl(id)));
  const title = ($('meta[property="og:title"]').attr('content') || $('h1').first().text() || '').trim();
  const author = ($('meta[property="og:novel:author"]').attr('content') || '').trim();
  const catName = ($('meta[property="og:novel:category"]').attr('content') || '').trim();
  const intro = ($('meta[property="og:description"]').attr('content') || '').replace(/<br\s*\/?>/gi, '\n').trim();
  const coverRaw = $('meta[property="og:image"]').attr('content') || '';
  let cover = coverOf(id);
  if (coverRaw && !/nocover/i.test(coverRaw)) {
    try { cover = new URL(coverRaw, BASE).pathname; } catch (e) { /* 保留拼接值 */ }
  }
  const up = ($('body').text().match(/最后更新：([\d-]+ [\d:]+)/) || [])[1] || '';
  const ch = extractChapters($);
  const status =
    ch.length && /完本|大结局|全书完|结卷|终章|完结|全文完/.test(ch[ch.length - 1].title) ? '完本' : '连载中';
  const meta = CATEGORIES.find((c) => c.name === catName);
  const category = meta ? { name: meta.name, url: `/${meta.key}_wap/` } : catName ? { name: catName, url: '' } : null;
  const latest = ch.length ? { name: ch[ch.length - 1].title, cid: ch[ch.length - 1].cid } : null;
  return { id, title, author, cover, category, status, update: up, intro, latest };
}

// ---------- 章节目录 ----------
async function getChapters(id) {
  return extractChapters(cheerio.load(await html(bookUrl(id))));
}

// ---------- 章节正文 ----------
async function getChapter(cid, bid) {
  const text = await html(chapterUrl(bid, cid), 24 * 60 * 60 * 1000);
  const $ = cheerio.load(text);
  const root = $('#content');
  if (!root.length) return { paragraphs: [] };
  root.find('script, style, #conter_tip').remove();
  const AD =
    /天才一秒记住|本站地址|爱曲小说|biqusa|最快更新|无广告|最新网址|加入书架|请收藏|记住网址|txt下载|手机阅读|本章未完|推荐票|点击下载|分页阅读/i;
  const paras = (root.html() || '')
    .split(/<br\s*\/?>/i)
    .map(stripTags)
    .filter((t) => t && !AD.test(t));
  if (paras.length && /^第.{0,15}[章节回集]\s*[:：]?\s*$/.test(paras[0])) paras.shift();
  return { paragraphs: paras };
}

// ---------- 搜索 ----------
async function search(q) {
  q = (q || '').trim();
  if (!q) return [];
  const url = `${BASE}/search.html?name=${encodeURIComponent(q)}`;
  const $ = cheerio.load(await html(url, 5 * 60 * 1000));
  const out = [];
  $('.novelslist2 > ul > li').each((_, li) => {
    const $li = $(li);
    if ($li.find('b').length) return; // 表头
    const aBook = $li.find('.s2 a').first();
    const id = idFrom(aBook.attr('href'));
    const title = aBook.text().trim();
    if (!id || !title) return;
    const aAuthor = $li.find('.s4 a').first();
    const aLatest = $li.find('.s3 a').first();
    const latestCid = cidFrom(aLatest.attr('href'));
    out.push({
      id,
      title,
      author: aAuthor.text().trim(),
      cover: coverOf(id),
      update: $li.find('.s6').first().text().trim(),
      status: '',
      latest: latestCid ? { name: aLatest.attr('title') || aLatest.text().trim(), cid: latestCid } : null,
    });
  });
  return out;
}

// ---------- 分类 / 排行 / 全本 ----------
async function getCategory(catKey) {
  const meta = CATEGORIES.find((c) => c.key === catKey) || CATEGORIES[0];
  const text = await html(`${BASE}/${meta.slug}/`);
  return { name: meta.name, books: parseList(text) };
}

async function getRank(rankKey) {
  const meta = RANKS.find((r) => r.key === rankKey) || RANKS[0];
  const text = await html(`${BASE}/paihangbang/`);
  return { name: meta.name, books: parseList(text) };
}

async function getQuanben() {
  const text = await html(`${BASE}/wanben/1_1`);
  return { name: '完本小说', books: parseList(text) };
}

function categoryList() {
  return CATEGORIES.map(({ key, name }) => ({ key, name }));
}
function rankList() {
  return RANKS.map(({ key, name }) => ({ key, name }));
}

export default {
  id: 'biqusa',
  name: '爱曲小说',
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
  warmIndex() {},
};
