# 搜索功能说明

青简目前只有一套搜索：**本地索引搜索**（快、稳、零外部依赖，适合免费云部署）。

## 本地索引（唯一搜索方式）
- 实现：`lib/source.js` 的 `search()`。服务启动时 `warmIndex()` 预热：抓取首页 + 7 个分类 + 10 个排行榜 + 全本页，建立内存索引（书名/作者/简介），10 分钟过期后按需重建。
- 优点：快、稳、纯 HTTP（cheerio + 原生 fetch），不依赖浏览器 / 源站实时接口，非常适合 300~512MB 的免费托管。
- 局限：只覆盖上述列表页上的书（源站分页失效，翻页与第 1 页相同，无法再扩量）。

> 原「原站搜索(live)」需 Playwright 无头 Chromium（约 600MB、吃内存、且被源站反爬拦截），已移除。

## 接口
`GET /api/search?q=关键词` → `{ q, results: [...] }`

## 部署提示
- 仅需 `express` + `cheerio` 两个依赖，`npm install && npm start` 即可。
- 端口读 `process.env.PORT`，可直接上 Render / Koyeb / Waifly 等免费 Node 托管。
- 无数据库、无持久磁盘要求（内存缓存即可）。
