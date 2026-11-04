// lib/sources/ibiquw.js
// 数据源：www.ibiquw.org（必去小说网，标准 笔趣阁 克隆站，服务端渲染，可直接抓取）。
// 结构（已用 cheerio 实测）：
//   搜索 GET /modules/article/search.php?searchkey=关键字
//       结果行：<p class="s1"><a href="/book/{id}/">书名</a></p>
//              <p class="s2"><a href="/book/{id}/{cid}.html">最新章节</a></p>
//              <p class="s3">作者</p> <p class="s5">状态</p> ...
//   目录 /book/{id}/  →  .book_list > ul > li > a href="{cid}.html"（相对路径，按文档顺序即为章节顺序）
//   章节 /book/{id}/{cid}.html → #htmlContent（段落以 <br> 分隔，无 <p>）

import * as cheerio from 'cheerio';
import { makeFetcher } from './_common.js';

const BASE = 'http://www.ibiquw.org';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/' });
const html = f.html;

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

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 搜索 ----------
async function search(q) {
  q = (q || '').trim();
  if (!q) return [];
  const url = `${BASE}/modules/article/search.php?searchkey=${encodeURIComponent(q)}`;
  const $ = cheerio.load(await html(url, 5 * 60 * 1000));
  const out = [];
  $('p.s1').each((_, el) => {
    const $s1 = $(el);
    const titleLink = $s1.find('a').first();
    const bookHref = titleLink.attr('href') || '';
    const id = (bookHref.match(/\/book\/(\d+)\/?/) || [])[1] || '';
    const title = titleLink.text().trim();
    if (!id || !title) return; // 跳过表头行（无 id）
    const $row = $(el).parent();
    const author = stripTags($row.find('p.s3').first().text());
    const status = stripTags($row.find('p.s5').first().text());
    const wordCount = stripTags($row.find('p.s4').first().text());
    const update = stripTags($row.find('p.s6').first().text());
    const latestLink = $row.find('p.s2 a').first();
    const latestName = latestLink.text().trim();
    const latestCid = (latestLink.attr('href') || '').match(/(\d+)\.html$/)?.[1] || '';
    // 笔趣阁搜索结果页不含封面/简介，封面按站点规律拼出（/files/article/image/{千位前缀}/{id}/{id}s.jpg）
    const cover = `/files/article/image/${Math.floor(Number(id) / 1000)}/${id}/${id}s.jpg`;
    out.push({
      id,
      title,
      author,
      status,
      cover,
      wordCount,
      update,
      latest: latestCid ? { name: latestName, cid: latestCid } : null,
    });
  });
  return out;
}

// ---------- 书籍详情 ----------
async function getBook(id) {
  const $ = cheerio.load(await html(`${BASE}/book/${id}/`, 30 * 60 * 1000));
  const title = $('#info h1').first().text().trim();
  const items = $('#info .item');
  const author = items.eq(0).text().trim();
  const cover = $('.book_info .pic img').first().attr('src') || '';
  const whole = $('.book_info').text();
  // 状态/更新优先取 <meta property="og:novel:status|update_time">（搜索页已验证站点用此暴露，
  // 直接读 .book_info 文本常常抓不到），抓取不到再回退到文本正则
  const status =
    $('meta[property="og:novel:status"]').attr('content') ||
    (whole.match(/(连载中|已完结|完结)/) || [])[1] ||
    '';
  const upMeta = $('meta[property="og:novel:update_time"]').attr('content') || '';
  const update = upMeta ? upMeta.split(' ')[0] : items.eq(1).text().trim();
  // 简介：站点把简介嵌在一段宣传文案里，形同 “《书名》简介：……您要是觉得……”
  let intro = '';
  const m = $.html().match(/简介[：:]\s*([\s\S]*?)您要是觉得/);
  if (m) intro = stripTags(m[1].replace(/《[^》]*》/g, '')).replace(/\s+/g, ' ').trim();
  return { id, title, author, cover, update, status, intro, latest: null };
}

// ---------- 章节目录（保持页面自然顺序）----------
async function getChapters(id) {
  const $ = cheerio.load(await html(`${BASE}/book/${id}/`, 30 * 60 * 1000));
  const out = [];
  $('.book_list a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const cid = (href.match(/(\d+)\.html$/) || [])[1] || '';
    const title = $(el).text().trim();
    if (cid) out.push({ cid, title });
  });
  return out;
}

// ---------- 章节正文 ----------
async function getChapter(cid, bid) {
  const url = `${BASE}/book/${bid}/${cid}.html`;
  const $ = cheerio.load(await html(url, 24 * 60 * 60 * 1000));
  const root = $('#htmlContent');
  if (!root.length) return { paragraphs: [] };
  const htmlc = root.html() || '';
  const paras = htmlc
    .split(/<br\s*\/?>/i)
    .map((seg) => stripTags(seg))
    .filter(
      (t) =>
        t &&
        !/必去小说|手机阅读|本章未完|笔趣阁|加入书架|TXT下载|最新章节|请收藏|新书推荐/.test(t)
    );
  return { paragraphs: paras };
}

// ---------- 首页 / 分类 / 排行 / 全本（本站以默认源 keca 为主，以下为兜底实现）----------
async function getHome() {
  return { featured: [], categories: [] };
}
async function getCategory() {
  return { name: '', books: [] };
}
async function getRank() {
  return { name: '', books: [] };
}
async function getQuanben() {
  return { name: '全本小说', books: [] };
}
function categoryList() {
  return CATEGORIES;
}
function rankList() {
  return RANKS;
}

export default {
  id: 'ibq',
  name: '必去小说网',
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
