// lib/sources/aiku.js
// 数据源：www.aikushuge.com（站名「大帝小说库」，PC 版，静态 HTML，UTF-8）。
// 与 ddxsku.com / m.aikushuge.com 是同一套站的不同域名/端；本域名搜索不跳转、字段最全。
// 已实测：纯 fetch 可达、无 CF、无 JS 渲染、无字体加密、搜索无限流。
//
// URL 规律：
//   搜索   GET/POST /search/?searchkey=<UTF-8>  → <table> 100 条/页（6 列）
//   书籍   /xiaoshuo/<id>.html                  → 书籍信息（#at 表格 + 简介）
//   目录   /files/article/html/<dir>/<id>/index.html → 全量章节（如 1614 章）
//   正文   /files/article/html/<dir>/<id>/<cid>.html → #contents，<br> 分段，无分页
//   分类   /list/<n>_1.html
//   排行   /top/<key>_1.html
//   全本   /full.html
//
// 注意：搜索结果的书链直接指向目录页 /files/.../index.html，书籍信息页是 /xiaoshuo/<id>.html；
// 正文容器是 #contents（<dd id="contents">），不是常见的 #content / #nr。

import * as cheerio from 'cheerio';
import { makeFetcher, withTimeout } from './_common.js';

const BASE = 'http://www.aikushuge.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;

// ---------- 工具 ----------
const dirOf = (id) => Math.floor(Number(id) / 1000);
const coverOf = (id) => `/files/article/image/${dirOf(id)}/${id}/${id}s.jpg`;
const bookUrl = (id) => `${BASE}/xiaoshuo/${id}.html`;
const catalogUrl = (id) => `${BASE}/files/article/html/${dirOf(id)}/${id}/index.html`;
const chapterUrl = (id, cid) => `${BASE}/files/article/html/${dirOf(id)}/${id}/${cid}.html`;
const idFrom = (h) => {
  const s = String(h || '');
  return (s.match(/\/xiaoshuo\/(\d+)\.html/) || [])[1] ||
    (s.match(/\/files\/article\/html\/\d+\/(\d+)\//) || [])[1] || '';
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
  { key: 'xuanhuan', name: '玄幻魔法', n: 1 },
  { key: 'wuxia', name: '武侠修真', n: 2 },
  { key: 'dushi', name: '都市言情', n: 3 },
  { key: 'lishi', name: '历史军事', n: 4 },
  { key: 'wangyou', name: '网游竞技', n: 5 },
  { key: 'kehuan', name: '科幻小说', n: 6 },
  { key: 'kongbu', name: '恐怖灵异', n: 7 },
  { key: 'nvsheng', name: '女生小说', n: 8 },
  { key: 'qita', name: '其他小说', n: 9 },
];

// postdate 是前端 homePage 硬编码的 key，必须存在；未知 key 回退首个榜单。
const RANKS = [
  { key: 'postdate', name: '最新入库', file: 'postdate' },
  { key: 'lastupdate', name: '最近更新', file: 'lastupdate' },
  { key: 'allvote', name: '总推荐榜', file: 'allvote' },
  { key: 'allvisit', name: '总排行榜', file: 'allvisit' },
  { key: 'goodnum', name: '总收藏榜', file: 'goodnum' },
];

// ---------- 通用书籍列表解析（分类 / 排行 / 全本 / 首页 共用）----------
function parseList(text) {
  const $ = cheerio.load(text);
  const out = [];
  const seen = new Set();
  $('a[href*="/xiaoshuo/"]').each((_, el) => {
    const $a = $(el);
    const id = idFrom($a.attr('href'));
    if (!id || seen.has(id)) return;
    const title =
      ($a.attr('title') || $a.find('img').attr('alt') || $a.text().trim() || '')
        .replace(/(最新章节列表|全文阅读|无弹窗)$/g, '')
        .trim();
    if (!title) return;
    seen.add(id);
    out.push({ id, title, author: '', cover: coverOf(id) });
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
  const $ = cheerio.load(await html(bookUrl(id)));
  const title = $('h1').first().text().trim().replace(/\s*全文阅读$/, '');
  const kv = {};
  $('#at tr').each((_, tr) => {
    const ths = $(tr).find('th');
    const tds = $(tr).find('td');
    ths.each((i, th) => {
      const k = $(th).text().replace(/\s/g, '');
      const v = tds.eq(i).text().trim();
      if (k) kv[k] = v;
    });
  });
  const author = kv['小说作者'] || '';
  const status = kv['小说状态'] || '';
  const update = kv['最后更新'] || '';
  const catName = kv['小说类别'] || '';
  // 简介：含「内容简介：」的 dd 里，跳过标签段与隐藏/空段，取第一段实质文本
  let intro = '';
  $('dd').each((_, dd) => {
    const $dd = $(dd);
    if (!/内容简介/.test($dd.text())) return;
    $dd.find('p').each((__, p) => {
      const $p = $(p);
      if ($p.css && $p.css('display') === 'none') return;
      const t = $p.text().replace(/\s+/g, ' ').trim();
      if (!t || /^内容简介[：:]?$/.test(t) || /^关键字[：:]/.test(t) || /^最近章节[：:]/.test(t) || /^分享书籍/.test(t)) return;
      intro = t;
      return false;
    });
    return false;
  });
  // 封面：书籍页图片（nocover 占位则按 id 拼标准路径）
  let cover = coverOf(id);
  const img = $('.bdsub img, #content img').first().attr('src') || '';
  if (img && !/nocover/i.test(img)) {
    try { cover = new URL(img, BASE).pathname; } catch (e) { /* 保留拼接值 */ }
  }
  const meta = CATEGORIES.find((c) => c.name === catName);
  const category = meta ? { name: meta.name, url: `/${meta.key}_wap/` } : null;
  return { id, title, author, cover, category, status, update, intro, latest: null };
}

// ---------- 章节目录（全量，一次返回）----------
async function getChapters(id) {
  const $ = cheerio.load(await html(catalogUrl(id)));
  const map = new Map();
  $('dl a[href$=".html"]').each((_, el) => {
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
  const root = $('#contents');
  if (!root.length) return { paragraphs: [] };
  root.find('script, style').remove();
  const paras = (root.html() || '')
    .split(/<br\s*\/?>/i)
    .map(stripTags)
    .filter(
      (t) =>
        t &&
        !/最新网址|大帝小说库|手机阅读|本章未完|加入书签|请收藏|记住网址|txt下载|推荐票/i.test(t)
    );
  if (paras.length && /^第.{0,15}[章节回集]\s*[:：]?\s*$/.test(paras[0])) paras.shift();
  return { paragraphs: paras };
}

// ---------- 搜索 ----------
async function search(q) {
  q = (q || '').trim();
  if (!q) return [];
  const url = `${BASE}/search/?searchkey=${encodeURIComponent(q)}`;
  const $ = cheerio.load(await html(url, 5 * 60 * 1000));
  const out = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 6) return; // 表头是 <th>
    const a0 = tds.eq(0).find('a').first();
    const id = idFrom(a0.attr('href'));
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

async function getRank(rankKey) {
  const meta = RANKS.find((r) => r.key === rankKey) || RANKS[0];
  const text = await html(`${BASE}/top/${meta.file}_1.html`);
  return { name: meta.name, books: parseList(text) };
}

async function getQuanben() {
  const text = await html(`${BASE}/full.html`);
  return { name: '全本小说', books: parseList(text) };
}

function categoryList() {
  return CATEGORIES.map(({ key, name }) => ({ key, name }));
}
function rankList() {
  return RANKS.map(({ key, name }) => ({ key, name }));
}

export default {
  id: 'aiku',
  name: '大帝小说库',
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
