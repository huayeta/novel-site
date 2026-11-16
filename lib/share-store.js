// lib/share-store.js
// 书架分享码的持久化层：一个分享码对应一个 JSON 文件，内容为 { books, candidates }。
// 与 sync-store 同一套安全模式：码不过校验不落盘、sha256 做文件名、原子写、按码串行化。
// 分享是「单写多读」（分享者 PUT 快照，任何人 GET 预览导入），无需乐观锁。
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHARE_DIR = path.join(__dirname, '..', 'data', 'share');
const MAX_BYTES = 512 * 1024; // 单个分享数据上限（几百本书绰绰有余）

// 与同步码同一套字母表/格式（XXXX-XXXX-XXXX，去易混淆字符），但存储目录独立，互不可见
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
  return path.join(SHARE_DIR, crypto.createHash('sha256').update(code).digest('hex') + '.json');
}

function ensureDir() {
  fs.mkdirSync(SHARE_DIR, { recursive: true });
}

function readFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object' || !Array.isArray(o.books)) return null;
    return o;
  } catch (e) {
    return null; // 不存在 / 损坏：当作未初始化
  }
}

// 同一分享码的写入串行化
const queues = new Map();
function serialize(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}

export function read(code) {
  if (!isValidCode(code)) return null;
  return readFile(fileFor(code));
}

export function write(code, { books, candidates }) {
  if (!isValidCode(code)) return { ok: false, error: 'invalid code' };
  const payload = JSON.stringify({ books, candidates, updatedAt: Date.now() });
  if (Buffer.byteLength(payload) > MAX_BYTES) return { ok: false, error: 'payload too large' };
  ensureDir();
  const file = fileFor(code);
  return serialize(code, () => {
    const tmp = file + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      return { ok: false, error: 'write failed' };
    }
    return { ok: true };
  });
}
