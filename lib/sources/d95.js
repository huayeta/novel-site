// lib/sources/d95.js
// 数据源：www.95dushu.info（九五小说网，杰奇 CMS，静态 XHTML，UTF-8）。
// 已实测：纯 fetch 可达、无 CF、无 JS 渲染、无字体加密、无限流。
//
// URL 规律：
//   搜索   /modules/article/search.php?searchkey=<UTF-8 关键词>  → <table> 100 条/页
//   书籍   /bookbook/<id>.html
//   目录   /<floor(id/1000)>/<id>/        → 一次返回全量章节（无分页）
//   正文   /<floor(id/1000)>/<id>/<cid>.html → #content，<br> 分段，无分页
//   分类   /mulu/<n>-1.html
//   排行   /top/<name>.html
//   全本   /quanben/  或 /modules/article/articlelist.php?fullflag=1&page=N
//   封面   /files/article/image/<floor(id/1000)>/<id>/<id>s.jpg
//
// 注意：目录页把「最新章」置顶了一份，末尾又重复一次；按 cid 去重 + 数值升序还原阅读顺序。

import * as cheerio from 'cheerio';
import { makeFetcher, withTimeout } from './_common.js';

const BASE = 'http://www.95dushu.info';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;

// ---------- 工具 ----------
const dirOf = (id) => Math.floor(Number(id) / 1000);
const coverOf = (id) => `/files/article/image/${dirOf(id)}/${id}/${id}s.jpg`;
const bookUrl = (id) => `${BASE}/bookbook/${id}.html`;
const catalogUrl = (id) => `${BASE}/${dirOf(id)}/${id}/`;
const chapterUrl = (id, cid) => `${BASE}/${dirOf(id)}/${id}/${cid}.html`;
const bookIdFrom = (href) => (String(href || '').match(/\/bookbook\/(\d+)\.html/) || [])[1] || '';
const cidFrom = (href) => (String(href || '').match(/\/(\d+)\.html$/) || [])[1] || '';

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

// 分类 key 用拼音（与前端 category.html?cat=<key> 配套）；n 为站点 /mulu/ 的分类编号。
const CATEGORIES = [
  { key: 'xuanhuan', name: '玄幻魔法', n: 1 },
  { key: 'xiuzhen', name: '武侠修真', n: 2 },
  { key: 'dushi', name: '都市言情', n: 3 },
  { key: 'lishi', name: '历史军事', n: 4 },
  { key: 'zhentan', name: '侦探推理', n: 5 },
  { key: 'wangyou', name: '网游动漫', n: 6 },
  { key: 'kehuan', name: '科幻小说', n: 7 },
  { key: 'kongbu', name: '恐怖灵异', n: 8 },
  { key: 'chuanyue', name: '穿越小说', n: 9 },
  { key: 'qita', name: '其他类型', n: 10 },
];

// 前端 homePage 硬编码请求 /api/rank/<src>/postdate（最新收录栏），故必须含 postdate；
// 未知 key 一律回退到首个榜单，避免 404 导致栏目空白。
const RANKS = [
  { key: 'postdate', name: '最新收录', file: 'lastupdate' },
  { key: 'allvisit', name: '总点击', file: 'allvisit' },
  { key: 'toptime', name: '点击榜', file: 'toptime' },
  { key: 'allvote', name: '推荐榜', file: 'allvote' },
  { key: 'goodnum', name: '收藏榜', file: 'goodnum' },
];

// ---------- 通用列表解析（分类 / 排行 / 全本 / 首页推荐 共用）----------
// 分类/全本页：<h2><a href=".../bookbook/<id>.html">《书名》</a></h2> <span>作者：<a>作者</a></span>
// 排行页：<span class="l2">《<a>书名</a>》</span><span class="l3"><a>作者</a></span>
function parseList(text) {
  const $ = cheerio.load(text);
  const out = [];
  const seen = new Set();
  $('a[href*="bookbook"]').each((_, el) => {
    const $a = $(el);
    const id = bookIdFrom($a.attr('href'));
    if (!id || seen.has(id)) return;
    let title = $a.text().trim();
    if (!title) return; // 跳过纯封面图链接
    title = title.replace(/^《/, '').replace(/》$/, '')
      .replace(/(最新章节列表|全文阅读|txt下载)$/i, '').trim();
    if (!title) return;
    seen.add(id);

    // 作者：优先从同一条目块里找「作者：」，排行页则从兄弟 .l3 取
    const $blk = $a.closest('.title, .l2, li, tr, div');
    let author = '';
    const am = ($blk.text() || '').match(/作者[：:]\s*([^\s，,。]+)/);
    if (am) author = am[1].trim();
    if (!author) {
      const l3 = $blk.parent().find('.l3 a').first().text().trim();
      if (l3) author = l3;
    }
    out.push({ id, title, author, cover: coverOf(id) });
  });
  return out;
}

// ---------- 首页 ----------
async function getHome() {
  const text = await html(BASE + '/');
  const $ = cheerio.load(text);
  const featured = [];
  const seen = new Set();
  $('.top_commend a[href*="bookbook"]').each((_, el) => {
    if (featured.length >= 12) return false;
    const $a = $(el);
    const id = bookIdFrom($a.attr('href'));
    const title = $a.text().trim();
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    featured.push({ id, title, author: '', cover: coverOf(id), intro: '' });
  });
  // 首页本身不按分类列书，并发抓各分类第一页填充；单页超时不拖垮整个首页。
  const settled = await Promise.allSettled(
    CATEGORIES.map(async (c) => {
      const t = await withTimeout(html(`${BASE}/mulu/${c.n}-1.html`), 6000, '');
      return { key: c.key, name: c.name, books: t ? parseList(t).slice(0, 8) : [] };
    })
  );
  const categories = settled
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
  return { featured, categories };
}

// ---------- 书籍详情 ----------
async function getBook(id) {
  const text = await html(bookUrl(id));
  const $ = cheerio.load(text);
  const body = $('body').text().replace(/\s+/g, ' ');
  const title = $('h1').first().text().trim();
  const author = (body.match(/作者：([^\s，,。]+)/) || [])[1] || '';
  const status = ($.html().match(/fullflag\(["']([^"']+)["']\)/) || [])[1] || '';
  const update = (body.match(/最新章节\(([^)]+)\)/) || [])[1] || '';
  // 简介夹在「作者：xxx」与「开始阅读」之间
  const im = body.match(/作者：[^\s]+\s+([\s\S]*?)\s+开始阅读/);
  const intro = im ? im[1].trim() : '';
  // 分类名从面包屑「您的位置：九五小说网 > 都市言情 > …」取；
  // url 构造成 <key>_wap 形式，使前端 catKeyFromUrl() 能解析出本源的分类 key。
  const catName = (body.match(/您的位置：九五小说网\s*>\s*([^>\s]+)\s*>/) || [])[1] || '';
  const meta = CATEGORIES.find((c) => c.name === catName);
  const category = meta ? { name: meta.name, url: `/${meta.key}_wap/` } : null;
  return { id, title, author, cover: coverOf(id), category, status, update, intro, latest: null };
}

// ---------- 章节目录（全量，一次返回）----------
async function getChapters(id) {
  const text = await html(catalogUrl(id));
  const $ = cheerio.load(text);
  const map = new Map();
  $('.quanwen a[href$=".html"], .read_page a[href$=".html"]').each((_, el) => {
    const $a = $(el);
    const cid = cidFrom($a.attr('href'));
    const title = $a.text().trim();
    if (!cid || !title) return;
    // 只要章节链接：标题形如「第N章」，或常见卷首/番外/后感
    if (!/第.{0,12}[章节回]|序章|楔子|番外|后记|感言|完本|大结局|尾声/.test(title)) return;
    if (!map.has(cid)) map.set(cid, { cid, title });
  });
  // 站点把最新章置顶又重复一次，按 cid 去重后按数值升序即还原阅读顺序
  return [...map.values()].sort((a, b) => Number(a.cid) - Number(b.cid));
}

// ---------- 章节正文 ----------
async function getChapter(cid, bid) {
  const text = await html(chapterUrl(bid, cid), 24 * 60 * 60 * 1000);
  const $ = cheerio.load(text);
  const root = $('#content');
  if (!root.length) return { paragraphs: [] };
  root.find('#center_tip, script, style, div[style*="display:none"]').remove();
  const paras = (root.html() || '')
    .split(/<br\s*\/?>/i)
    .map(stripTags)
    .filter(
      (t) =>
        t &&
        !/最新网址|九五小说网|手机阅读|本章未完|加入书签|举报本章节|txt下载|请收藏|记住网址/i.test(t)
    );
  // 正文首段常是重复的章节标题（页面标题已显示），仅当它完全是标题格式时去掉
  if (paras.length && /^第.{0,15}[章节回集]\s*[:：]?\s*$/.test(paras[0])) paras.shift();
  return { paragraphs: paras };
}

// ---------- 搜索（站内接口，无限流）----------
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
    const id = bookIdFrom(a0.attr('href'));
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
  const text = await html(`${BASE}/mulu/${meta.n}-1.html`);
  return { name: meta.name, books: parseList(text) };
}

async function getRank(rankKey) {
  const meta = RANKS.find((r) => r.key === rankKey) || RANKS[0];
  const text = await html(`${BASE}/top/${meta.file}.html`);
  return { name: meta.name, books: parseList(text) };
}

async function getQuanben() {
  // 站点全本列表按 page 分页，没有 sort 参数；统一取第一页（60 本）
  const text = await html(`${BASE}/quanben/`);
  return { name: '全本小说', books: parseList(text) };
}

function categoryList() {
  return CATEGORIES.map(({ key, name }) => ({ key, name }));
}
function rankList() {
  return RANKS.map(({ key, name }) => ({ key, name }));
}

export default {
  id: 'd95',
  name: '九五小说网',
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
