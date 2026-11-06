// lib/sync-store.js
// 同步码云同步的持久化层：一个同步码对应一个 JSON 文件，内容为统一状态对象。
// 不加密（单人私有部署），但同步码绝不直接当文件名：用 sha256 做文件名，
// 既防目录穿越，也不在磁盘上暴露原始码。
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYNC_DIR = path.join(__dirname, '..', 'data', 'sync');
const MAX_BYTES = 512 * 1024; // 单个同步数据上限，防止滥用

// 去掉易混淆的 I/O/0/1
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export function isValidCode(code) {
  return typeof code === 'string' && CODE_RE.test(code);
}

export function generateCode() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) {
    if (i && i % 4 === 0) s += '-';
    s += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return s;
}

function fileFor(code) {
  // 码已通过格式校验；再 hash 一层，杜绝任何路径注入
  return path.join(SYNC_DIR, crypto.createHash('sha256').update(code).digest('hex') + '.json');
}

function ensureDir() {
  fs.mkdirSync(SYNC_DIR, { recursive: true });
}

function readFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || typeof o.rev !== 'number') return null;
    return o;
  } catch (e) {
    return null; // 文件不存在 / 损坏：当作未初始化
  }
}

// 同一同步码的写入串行化，避免两个并发 PUT 互相覆盖
const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn); // 前一个失败也不阻塞后一个
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

export function read(code) {
  if (!isValidCode(code)) return null;
  return readFile(fileFor(code));
}

export function write(code, { baseRev, data }) {
  if (!isValidCode(code)) return { ok: false, error: 'invalid code' };
  const payload = JSON.stringify({ rev: 0, updatedAt: Date.now(), data });
  if (Buffer.byteLength(payload) > MAX_BYTES) return { ok: false, error: 'payload too large' };
  ensureDir();
  const file = fileFor(code);

  return serialize(code, () => {
    const cur = readFile(file);
    const curRev = cur ? cur.rev : 0;
    // 乐观锁：提交必须基于服务端当前版本，否则返回 409 让客户端合并重试
    if (Number(baseRev) !== curRev) {
      return { ok: false, conflict: true, rev: curRev, data: cur ? cur.data : null };
    }
    const rev = curRev + 1;
    const body = JSON.stringify({ rev, updatedAt: Date.now(), data });
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file); // 原子替换，避免写一半损坏
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, error: 'write failed' };
    }
    return { ok: true, rev };
  });
}
