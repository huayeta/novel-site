// lib/sources/bf.js
// 数据源：www.bingfengxs.com（站名「爱奇电子书」，杰奇 CMS，静态 HTML，UTF-8）。
// 已实测：纯 fetch 可达、无 CF、无 JS 渲染、无字体加密。
//
// URL 规律：
//   搜索   /modules/article/search.php?searchkey=<UTF-8>  → .list_l li 卡片，带分页
//   书籍   /book/<id>/           → 书籍信息（目录不在此页）
//   目录   /<floor(id/1000)>/<id>/   （= reader.php?aid=<id> 的 302 目标）→ 一次全量章节
//   正文   /<floor(id/1000)>/<id>/<cid>.html → .yd_text2，<br> 分段，无分页
//   分类   /list_<n>_1.html
//   排行   /top/<name>_1.html
//   书库   /shuku/
//   封面   /files/article/image/<floor(id/1000)>/<id>/<id>s.jpg
//
// 通用卡片（搜索/分类/排行/书库）：
//   .list_l li > a[href*="/book/"] (title 属性=书名) + .title h3 a + .author
//   + .status（状态 / 最新章节，cid 在 reader.php?...&cid= 里） + .data（类型/点击/更新）

import * as cheerio from 'cheerio';
import { makeFetcher, withTimeout } from './_common.js';

const BASE = 'http://www.bingfengxs.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;

// ---------- 工具 ----------
const dirOf = (id) => Math.floor(Number(id) / 1000);
const coverOf = (id) => `/files/article/image/${dirOf(id)}/${id}/${id}s.jpg`;
const bookUrl = (id) => `${BASE}/book/${id}/`;
const catalogUrl = (id) => `${BASE}/${dirOf(id)}/${id}/`;
const chapterUrl = (id, cid) => `${BASE}/${dirOf(id)}/${id}/${cid}.html`;
const idFromBook = (h) => (String(h || '').match(/\/book\/(\d+)\//) || [])[1] || '';
const cidFromReader = (h) => (String(h || '').match(/[?&]cid=(\d+)/) || [])[1] || '';
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

// 分类 key 用拼音（与前端 category.html?cat=<key> 配套）；n 为站点 /list_<n>_1.html 编号。
const CATEGORIES = [
  { key: 'xuanhuan', name: '玄幻魔法', n: 1 },
  { key: 'xiuzhen', name: '武侠修真', n: 2 },
  { key: 'dushi', name: '都市言情', n: 3 },
  { key: 'lishi', name: '历史军事', n: 4 },
  { key: 'kongbu', name: '恐怖悬疑', n: 5 },
  { key: 'youxi', name: '游戏竞技', n: 6 },
  { key: 'kehuan', name: '科幻未来', n: 7 },
  { key: 'danmei', name: '耽美同人', n: 8 },
  { key: 'qita', name: '综合类型', n: 9 },
];

// 前端 homePage 硬编码请求 /api/rank/<src>/postdate，故必须含 postdate；
// 未知 key 回退首个榜单，避免 404 导致栏目空白。
const RANKS = [
  { key: 'postdate', name: '新书入库', file: 'postdate' },
  { key: 'allvisit', name: '总点击榜', file: 'allvisit' },
  { key: 'monthvisit', name: '月点击榜', file: 'monthvisit' },
  { key: 'weekvisit', name: '周点击榜', file: 'weekvisit' },
  { key: 'goodnum', name: '总收藏榜', file: 'goodnum' },
  { key: 'allvote', name: '总推荐榜', file: 'allvote' },
  { key: 'monthvote', name: '月推荐榜', file: 'monthvote' },
  { key: 'weekvote', name: '周推荐榜', file: 'weekvote' },
];

// ---------- .list_l 卡片列表（搜索 / 分类 / 排行 / 书库 共用）----------
function parseCards(text) {
  const $ = cheerio.load(text);
  const out = [];
  const seen = new Set();
  $('.list_l li').each((_, li) => {
    const $li = $(li);
    const a = $li.find('a[href*="/book/"]').first();
    const id = idFromBook(a.attr('href'));
    if (!id || seen.has(id)) return;
    const title =
      a.attr('title') ||
      a.find('img').attr('alt') ||
      $li.find('.title h3 a').first().text().trim().replace(/^《|》$/g, '');
    if (!title) return;
    seen.add(id);

    const author = $li.find('.author').first().text().replace(/作者[：:]/, '').trim();
    const status = $li.find('.status').first().text().replace(/\s+/g, ' ').split('最新章节')[0].trim();
    const latestA = $li.find('.status a[href*="cid="]').first();
    const latestCid = cidFromReader(latestA.attr('href'));
    const data = $li.find('.data').text().replace(/\s+/g, ' ');
    const wordCount = (data.match(/字数[：:]\s*([^\s]+)/) || [])[1] || '';
    const update = (data.match(/更新[：:]\s*([^\s]+)/) || [])[1] || '';
    out.push({
      id,
      title,
      author,
      cover: coverOf(id),
      status,
      wordCount,
      update,
      latest: latestCid ? { name: latestA.text().trim(), cid: latestCid } : null,
    });
  });
  return out;
}

// 首页没有 .list_l，书链直接带 title 属性或文字
function parseHomeBooks(text, limit = 12) {
  const $ = cheerio.load(text);
  const out = [];
  const seen = new Set();
  $('a[href*="/book/"]').each((_, el) => {
    if (out.length >= limit) return false;
    const $a = $(el);
    const id = idFromBook($a.attr('href'));
    const title = $a.attr('title') || $a.text().trim();
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    out.push({ id, title, author: '', cover: coverOf(id), intro: '' });
  });
  return out;
}

// ---------- 首页 ----------
async function getHome() {
  const text = await html(BASE + '/');
  const featured = parseHomeBooks(text);
  const settled = await Promise.allSettled(
    CATEGORIES.map(async (c) => {
      const t = await withTimeout(html(`${BASE}/list_${c.n}_1.html`), 6000, '');
      return { key: c.key, name: c.name, books: t ? parseCards(t).slice(0, 8) : [] };
    })
  );
  const categories = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  return { featured, categories };
}

// ---------- 书籍详情 ----------
async function getBook(id) {
  const text = await html(bookUrl(id));
  const $ = cheerio.load(text);
  const title = $('h1').first().text().trim();
  const infoT = $('.info_t').text().replace(/\s+/g, ' ');
  const infoM = $('.info_m').text().replace(/\s+/g, ' ');
  const infoC = $('.info_c').text().replace(/\s+/g, ' ');
  const author = (infoT.match(/作者[：:]\s*([^\s]+)/) || [])[1] || '';
  const status = (infoT.match(/作品状态[：:]\s*([^\s]+)/) || [])[1] || '';
  const update = (infoM.match(/更新[：:]\s*([^|\s]+)/) || [])[1] || '';
  const catName = (infoM.match(/类别[：:]\s*([^|\s]+)/) || [])[1] || '';
  // 简介夹在「作品状态：xxx」与「……展开全部」之间
  const im = infoC.match(/作品状态[：:]\S+\s+([\s\S]*?)(?:\.{3,}展开全部|最新更新章节)/);
  const intro = im
    ? im[1].replace(/^作品详情|\[单张下载\]|\[管理\]/g, '').replace(/\.{3,}$/, '').trim()
    : '';
  const meta = CATEGORIES.find((c) => c.name === catName);
  const category = meta ? { name: meta.name, url: `/${meta.key}_wap/` } : null;
  return { id, title, author, cover: coverOf(id), category, status, update, intro, latest: null };
}

// ---------- 章节目录（全量，一次返回）----------
async function getChapters(id) {
  const text = await html(catalogUrl(id));
  const $ = cheerio.load(text);
  const map = new Map();
  $('.ml_main a[href$=".html"], a[href$=".html"]').each((_, el) => {
    const $a = $(el);
    const cid = cidFrom($a.attr('href'));
    const title = $a.text().trim();
    if (!cid || !title) return;
    if (!/第.{0,12}[章节回]|序章|楔子|番外|后记|感言|完本|大结局|尾声|结卷/.test(title)) return;
    if (!map.has(cid)) map.set(cid, { cid, title });
  });
  return [...map.values()].sort((a, b) => Number(a.cid) - Number(b.cid));
}

// ---------- 章节正文 ----------
async function getChapter(cid, bid) {
  const text = await html(chapterUrl(bid, cid), 24 * 60 * 60 * 1000);
  const $ = cheerio.load(text);
  const root = $('.yd_text2');
  if (!root.length) return { paragraphs: [] };
  root.find('#center_tip, script, style').remove();
  const paras = (root.html() || '')
    .split(/<br\s*\/?>/i)
    .map(stripTags)
    .filter(
      (t) =>
        t &&
        !/最新网址|爱奇电子书|bingfengxs|手机阅读|本章未完|加入书签|请收藏|记住网址|txt下载/i.test(t)
    );
  if (paras.length && /^第.{0,15}[章节回集]\s*[:：]?\s*$/.test(paras[0])) paras.shift();
  return { paragraphs: paras };
}

// ---------- 搜索 ----------
async function search(q) {
  q = (q || '').trim();
  if (!q) return [];
  const url = `${BASE}/modules/article/search.php?searchkey=${encodeURIComponent(q)}`;
  return parseCards(await html(url, 5 * 60 * 1000));
}

// ---------- 分类 / 排行 / 全本 ----------
async function getCategory(catKey) {
  const meta = CATEGORIES.find((c) => c.key === catKey) || CATEGORIES[0];
  const text = await html(`${BASE}/list_${meta.n}_1.html`);
  return { name: meta.name, books: parseCards(text) };
}

async function getRank(rankKey) {
  const meta = RANKS.find((r) => r.key === rankKey) || RANKS[0];
  const text = await html(`${BASE}/top/${meta.file}_1.html`);
  return { name: meta.name, books: parseCards(text) };
}

async function getQuanben() {
  const text = await html(`${BASE}/shuku/`);
  return { name: '全本书库', books: parseCards(text) };
}

function categoryList() {
  return CATEGORIES.map(({ key, name }) => ({ key, name }));
}
function rankList() {
  return RANKS.map(({ key, name }) => ({ key, name }));
}

export default {
  id: 'bf',
  name: '爱奇电子书',
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
