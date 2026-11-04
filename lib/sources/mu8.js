// lib/sources/mu8.js
// 数据源：m.mu8net.cc（木偶/笔趣阁手机站，GBK 编码，服务端渲染，可直接抓取）。
// 站点结构（已用 curl + iconv 实测）：
//   书籍详情   /wapbook/{id}/
//   章节目录   /wapbook{id}/            （全本，分页 20/页；下一页 -> /wapbook{id}_{N}/）
//   章节正文   /wapbook/{id}/{cid}/     （长章分页 /wapbook/{id}/{cid}/2/、/3/ …）
//   搜索       POST /s.php  body: s=<GBK 编码关键字>&type=articlename|author
//   封面       http://www.mu8net.cc/files/article/image/{floor(id/1000)}/{id}/{id}s.jpg
// 注意：源站为 GBK 编码，抓取时必须用 GBK 解码（见 makeFetcher 的 encoding）。

import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { makeFetcher } from './_common.js';

const BASE = 'http://m.mu8net.cc';
// 封面托管在 www 主机，且需要 Referer 防盗链；与内容主机 m 不同。
const COVER_BASE = 'http://www.mu8net.cc';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

// GBK 解码抓取：源站是 gbk 编码
const f = makeFetcher({ base: BASE, ua: UA, referer: BASE + '/', encoding: 'gbk' });
const html = f.html;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CATEGORIES = [
  { key: 'xuanhuan', name: '玄幻奇幻' },
  { key: 'xiuzhen', name: '武侠仙侠' },
  { key: 'dushi', name: '都市生活' },
  { key: 'chuanyue', name: '历史军事' },
  { key: 'wangyou', name: '网游竞技' },
  { key: 'kehuan', name: '科幻灵异' },
  { key: 'yanqing', name: '女生频道' },
];

const RANKS = [
  { key: 'visit', name: '点击榜' },
  { key: 'vote', name: '推荐榜' },
  { key: 'postdate', name: '新书榜' },
  { key: 'goodnum', name: '收藏榜' },
  { key: 'size', name: '字数榜' },
];

function strip(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const bookId = (href = '') => (href.match(/\/wapbook\/(\d+)\/?/) || [])[1] || '';
const cidOf = (href = '') => (href.match(/\/wapbook\/\d+\/(\d+)\//) || [])[1] || '';

function coverFromId(id) {
  id = Number(id) || 0;
  return `/files/article/image/${Math.floor(id / 1000)}/${id}/${id}s.jpg`;
}

// ---------- 搜索（POST /s.php，关键字需 GBK 编码） ----------
// 源站只认 GBK 编码的查询串：把关键字按 GBK 编码后逐字节做 %XX 转义；
// 但 's='、'&'、'type=' 必须保持原样（含字面 '='），否则 PHP 无法拆分 name=value，查询会变空。
// 注意：Node 的 Buffer 不支持 'gbk' 编码，需用 iconv-lite 编码为 GBK 字节。
async function postSearch(q) {
  const gbk = iconv.encode(q, 'gbk');
  const percentQuery = Array.from(gbk, (b) => '%' + b.toString(16).padStart(2, '0')).join('');
  const body = 's=' + percentQuery + '&type=articlename';
  // 走统一抓取器：自带重试 + 关闭 keep-alive，规避偶发连接重置
  return f.req(`${BASE}/s.php`, {
    method: 'POST',
    body,
    extraHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
}

async function search(q) {
  q = (q || '').trim();
  if (!q) return [];
  const $ = cheerio.load(await postSearch(q));
  const out = [];
  $('a.blue[target="_blank"]').each((_, el) => {
    const $a = $(el);
    const id = bookId($a.attr('href') || '');
    const title = $a.text().trim();
    if (!id || !title) return;
    // 结果条目形如：<a ...>书名</a>/作者</p>
    const parentText = $a.parent().text() || '';
    let author = strip(parentText.replace(title, '')).replace(/^\/+/, '');
    if (author.includes('/')) author = author.split('/').pop().trim();
    out.push({ id, title, author, cover: coverFromId(id) });
  });
  return out;
}

// ---------- 书籍详情 ----------
async function getBook(id) {
  const $ = cheerio.load(await html(`${BASE}/wapbook/${id}/`, 30 * 60 * 1000));
  const title = $('#_52mb_h1').text().trim();
  const author = $('p')
    .filter((_, el) => $(el).text().includes('作者：'))
    .first()
    .text()
    .replace('作者：', '')
    .trim();
  const catP = $('p')
    .filter((_, el) => $(el).text().includes('分类：'))
    .first();
  const category =
    catP.find('a').text().trim() || strip(catP.text().replace('分类：', ''));
  const status = $('p')
    .filter((_, el) => $(el).text().includes('状态：'))
    .first()
    .text()
    .replace('状态：', '')
    .trim();
  const update = $('p')
    .filter((_, el) => $(el).text().includes('更新：'))
    .first()
    .text()
    .replace('更新：', '')
    .trim();
  const intro = $('.intro_info').text().trim();
  return {
    id,
    title,
    author,
    cover: coverFromId(id),
    category,
    update,
    status,
    intro,
    latest: null,
  };
}

// ---------- 章节目录（按源站真实分页，单页抓取，避免一次性抓取全部触发连接重置） ----------
// 抓取单页目录：page<=1 取首页（/wapbook{id}/），其余取 /wapbook{id}_{page}/。
// 返回该页章节 + 分页信息（totalPages / hasNext / hasPrev），供前端分页展示。
async function fetchCatalogPage(id, page) {
  const url = page <= 1 ? `${BASE}/wapbook${id}/` : `${BASE}/wapbook${id}_${page}/`;
  const $ = cheerio.load(await html(url, 30 * 60 * 1000));
  const items = [];
  const seen = new Set();
  $('ul.chapter li a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const cid = cidOf(href);
    const title = $(el).text().replace(/全部章节/g, '').trim();
    if (cid && title && title !== '全部章节' && !seen.has(cid)) {
      seen.add(cid);
      items.push({ cid, title });
    }
  });
  // 解析分页信息：优先「共 N 页」「尾页」链接，其次页码数字最大者
  let totalPages = page;
  let hasNext = false;
  let hasPrev = false;
  $('div.page').each((_, pg) => {
    const txt = $(pg).text();
    const m = txt.match(/共\s*(\d+)\s*页/);
    if (m) totalPages = Math.max(totalPages, +m[1]);
    $(pg)
      .find('a')
      .each((_, el) => {
        const t = $(el).text().trim();
        const href = $(el).attr('href') || '';
        if (t.includes('下一页')) hasNext = true;
        else if (t.includes('上一页')) hasPrev = true;
        else if (t.includes('尾页')) {
          const mm = href.match(/_(\d+)\//);
          if (mm) totalPages = Math.max(totalPages, +mm[1]);
        } else {
          const n = parseInt(t, 10);
          if (!isNaN(n) && n > totalPages) totalPages = n;
        }
      });
  });
  return { page, pageSize: items.length || 20, totalPages, hasNext, hasPrev, items };
}

// 单页目录：分页展示用，一次只抓一页，不再一次性抓全部。
async function getChaptersPage(id, page = 1) {
  return fetchCatalogPage(id, page);
}

// 全量目录（兜底）：逐页抓取并合并；单页持续失败（连接重置/限频）则停止并返回已收集部分。
async function getChapters(id) {
  const out = [];
  const seen = new Set();
  let page = 1;
  for (let i = 0; i < 500; i++) {
    let pg;
    try {
      pg = await fetchCatalogPage(id, page);
    } catch (e) {
      console.error(`[mu8] getChapters ${id} 第 ${page} 页失败: ${e.message}`);
      break;
    }
    let added = 0;
    for (const it of pg.items) {
      if (!seen.has(it.cid)) {
        seen.add(it.cid);
        out.push(it);
        added++;
      }
    }
    if (!pg.hasNext || added === 0) break;
    page++;
    await sleep(350); // 分页之间稍作间隔，降低被限频/连接重置概率
  }
  return out;
}

// ---------- 章节正文 ----------
function parseNr($) {
  const root = $('#nr');
  if (!root.length) return [];
  const htmlc = root.html() || '';
  return htmlc
    .split(/<br\s*\/?>/i)
    .map((seg) => strip(seg))
    .filter(
      (t) =>
        t &&
        !/请收藏|笔趣阁|手机阅读|本章未完|最新章节|继续阅读|下一页|上一页|回目录|报错|加入书架/.test(
          t
        )
    );
}

async function getChapter(cid, bid) {
  const $ = cheerio.load(
    await html(`${BASE}/wapbook/${bid}/${cid}/`, 24 * 60 * 60 * 1000)
  );
  let paras = parseNr($);
  // 长章分页：/wapbook/{bid}/{cid}/2/、/3/ …（从正文页的分页链接里收集）
  const sub = [];
  $(`a[href*="/wapbook/${bid}/${cid}/"]`).each((_, el) => {
    const m = ($(el).attr('href') || '').match(
      new RegExp(`/wapbook/${bid}/${cid}/(\\d+)/`)
    );
    if (m) sub.push(Number(m[1]));
  });
  for (const n of [...new Set(sub)].sort((a, b) => a - b)) {
    if (n < 2) continue; // 主页面无尾缀数字，分页从 2 起
    try {
      const $s = cheerio.load(
        await html(`${BASE}/wapbook/${bid}/${cid}/${n}/`, 24 * 60 * 60 * 1000)
      );
      paras = paras.concat(parseNr($s));
    } catch (e) {
      console.error(`[mu8] getChapter ${bid}/${cid} 第 ${n} 分页失败: ${e.message}`);
    }
  }
  return { paragraphs: paras };
}

// ---------- 首页 / 分类 / 排行 / 全本（本站以默认源 keca 为主，以下为兜底实现） ----------
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
  id: 'mu8',
  name: '木偶小说(笔趣阁)',
  base: BASE,
  coverBase: COVER_BASE,
  searchable: true,
  paginated: true, // 章节目录为源站真实分页：改用 getChaptersPage 分页抓取，避免一次性抓全部
  getHome,
  getBook,
  getChapters,
  getChaptersPage,
  getChapter,
  getCategory,
  getRank,
  getQuanben,
  categoryList,
  rankList,
  search,
  warmIndex() {},
};
