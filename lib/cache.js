// lib/cache.js
// 服务端进程内缓存（重启即清空），供 server.js 的 /api 路由按接口粒度使用。
//
// 设计要点：
//  - TTL：到期自动失效，下次请求重新回源。
//  - 内容校验 validate：命中后再比对「指纹」，不一致即视为失效回源
//    （用于书籍元数据：目录一有新章就立即刷新 status/update，无需等 TTL）。
//  - 并发合并：同一 key 的并发请求只回源一次（in-flight 共享 Promise）。
//  - 失败不入缓存：producer 抛错 / 超时不会留下坏数据，下次仍会重试。
//  - 空结果不入缓存：shouldCache 判定为「无有效数据」时跳过写入（避免把源站
//    异常时的空目录 / 空正文缓存一整天）。
//  - 容量上限：超过 max 淘汰最早写入的条目，避免长期运行内存无界增长。

export function createCache({ max = 500 } = {}) {
  const store = new Map(); // key -> { val, exp, ts }
  const inflight = new Map(); // key -> Promise
  const latest = new Map(); // key -> 最新一次回源 task，防止旧请求覆盖新结果

  function trim() {
    if (store.size <= max) return;
    const entries = [...store.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of entries.slice(0, store.size - max)) store.delete(k);
  }

  // 判定响应是否值得缓存：含常见列表字段时要求至少一个非空；纯数组要求非空。
  function useful(d) {
    if (d == null) return false;
    if (Array.isArray(d)) return d.length > 0;
    const keys = ['paragraphs', 'books', 'results', 'featured', 'categories'];
    const found = keys.filter((k) => Array.isArray(d[k]));
    if (found.length) return found.some((k) => d[k].length > 0);
    return true;
  }

  // 命中条目的剩余寿命（ms），供响应头告知下游真实有效期，避免双层缓存叠加
  function remaining(key) {
    const e = store.get(key);
    return e && e.exp > Date.now() ? e.exp - Date.now() : 0;
  }

  // peek(key, validate?)：仅判断是否命中（可选再跑内容校验），用于设置 X-* 头
  function peek(key, validate) {
    const e = store.get(key);
    if (e && e.exp > Date.now()) {
      if (!validate || validate(e.val)) return true;
    }
    return false;
  }

  // get(key, ttlMs, producer, shouldCache?, opts?)
  //   producer: async () => 数据；抛错则不缓存并向上传递（由 wrap 统一转 502）
  //   shouldCache(val): 返回 false 表示「不值得缓存」（如末页目录、空结果）
  //   opts.validate(val): 命中缓存后二次校验，false 则视为失效并回源（内容指纹）
  //   opts.bypass: 忽略已有缓存强制回源，并用新结果覆盖缓存（供 ?refresh=1 手动刷新）
  async function get(key, ttlMs, producer, shouldCache = useful, opts = {}) {
    let backup = null;
    if (opts.bypass) {
      // 强制刷新：先备份旧值（失败时回滚），并作废 in-flight 旧请求
      const old = store.get(key);
      if (old && old.exp > Date.now()) backup = old;
      store.delete(key);
      inflight.delete(key);
    } else {
      const hit = store.get(key);
      if (hit && hit.exp > Date.now()) {
        if (!opts.validate || opts.validate(hit.val)) return hit.val; // 命中且指纹一致
        store.delete(key); // 指纹变了：作废，下面回源刷新
      } else if (hit) store.delete(key);
      if (inflight.has(key)) return inflight.get(key);
    }

    const token = {};
    latest.set(key, token);
    const task = (async () => {
      let val;
      try {
        val = await producer();
      } catch (e) {
        // M8：回源失败时把唯一的好缓存放回去，避免源站抖动导致缓存丢失
        if (backup && !store.has(key)) store.set(key, backup);
        if (latest.get(key) === token) latest.delete(key);
        throw e;
      }
      // 仅当本 task 仍是该 key 的最新回源时才写入，杜绝旧结果覆盖刷新结果
      if (latest.get(key) === token) {
        if (ttlMs > 0 && shouldCache(val)) {
          store.set(key, { val, exp: Date.now() + ttlMs, ts: Date.now() });
          trim();
        }
        latest.delete(key);
      }
      return val;
    })();
    // bypass 时不登记 in-flight：避免覆盖同 key 正在进行的普通请求
    if (!opts.bypass) {
      inflight.set(key, task);
      // 双分支消化拒绝，避免 unhandledRejection；只清理自己的标记
      task.then(
        () => { if (inflight.get(key) === task) inflight.delete(key); },
        () => { if (inflight.get(key) === task) inflight.delete(key); }
      );
    }
    return task;
  }

  return {
    get,
    peek,
    remaining,
    size: () => store.size,
    inflight: () => inflight.size,
    clear: () => {
      store.clear();
      inflight.clear();
    },
  };
}
