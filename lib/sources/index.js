// lib/sources/index.js
// 数据源注册表：维护所有源及其顺序、默认源、对外查询入口。
// 新增源：在 lib/sources/ 下新增一个模块（默认导出符合契约的对象），在此 IMPORTS 注册即可。

import keca from './keca.js';
import ibiquw from './ibiquw.js';
import mu8 from './mu8.js';
import d95 from './d95.js';
import bf from './bf.js';
import xq from './xq.js';
import ibqg from './ibqg.js';
import xb from './xb.js';
import aiku from './aiku.js';
import biqusa from './biqusa.js';

// 全部已接入的源（顺序即展示顺序）
const ALL = [keca, ibiquw, mu8, d95, bf, xq, ibqg, xb, aiku, biqusa];
const byId = Object.fromEntries(ALL.map((s) => [s.id, s]));

// 启用的源：可用环境变量 SOURCES=keca,ibq 覆盖顺序与范围；缺省全部启用。
const order = (process.env.SOURCES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const enabledList = (order.length ? order : ALL.map((s) => s.id))
  .map((id) => byId[id])
  .filter(Boolean);

export const defaultSource = enabledList[0]?.id || 'keca';

export function getSource(id) {
  const s = byId[id];
  if (!s) throw new Error('未知数据源: ' + id);
  return s;
}

export function listSources() {
  return enabledList.map((s) => ({ id: s.id, name: s.name }));
}

export function enabledSources() {
  return enabledList;
}

// 跨源合并搜索：各源独立超时（默认 8s），任一失败/超时不影响其它源。
export async function searchAll(q, { timeoutMs = 8000 } = {}) {
  const srcs = enabledSources();
  const tasks = srcs.map((s) =>
    withTimeout(
      Promise.resolve(s.search(q)).then((r) =>
        (r || []).map((b) => ({ ...b, src: s.id, srcName: s.name }))
      ),
      timeoutMs,
      []
    )
  );
  const settled = await Promise.allSettled(tasks);
  const merged = [];
  for (const r of settled) if (r.status === 'fulfilled') merged.push(...r.value);
  return merged;
}

// 从 _common 复用带超时的 Promise（失败时返回 fallback）
import { withTimeout } from './_common.js';
