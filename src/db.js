import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// 打开（必要时创建）数据库，初始化两张计数表。
// dbPath 支持 ':memory:'（测试用）与磁盘路径（默认 /data/starvote.db）。
export function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS rating_counts (
      id TEXT PRIMARY KEY,
      s1 INTEGER NOT NULL DEFAULT 0,
      s2 INTEGER NOT NULL DEFAULT 0,
      s3 INTEGER NOT NULL DEFAULT 0,
      s4 INTEGER NOT NULL DEFAULT 0,
      s5 INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS vote_counts (
      id TEXT PRIMARY KEY,
      up   INTEGER NOT NULL DEFAULT 0,
      down INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

// 查询评分计数，映射 s1..s5 -> '1'..'5'；无记录返回 {}。
export function getRating(db, id) {
  const row = db.prepare('SELECT * FROM rating_counts WHERE id = ?').get(id);
  if (!row) return {};
  return { id: row.id, '1': row.s1, '2': row.s2, '3': row.s3, '4': row.s4, '5': row.s5 };
}

// 原子自增指定分数（1..5）的计数，INSERT ... ON CONFLICT 避免并发丢计数。
export function updateRating(db, id, score) {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error(`Invalid score: ${score}`);
  }
  db.prepare(`INSERT INTO rating_counts (id, s${score}) VALUES (?, 1)
    ON CONFLICT(id) DO UPDATE SET s${score} = s${score} + 1`).run(id);
}

// 查询投票计数；无记录返回 {}。
export function getVote(db, id) {
  const row = db.prepare('SELECT * FROM vote_counts WHERE id = ?').get(id);
  if (!row) return {};
  return { id: row.id, up: row.up, down: row.down };
}

// 原子自增投票计数（type 为 'up' 或 'down'）。
export function updateVote(db, id, type) {
  if (type !== 'up' && type !== 'down') {
    throw new Error(`Invalid vote type: ${type}`);
  }
  db.prepare(`INSERT INTO vote_counts (id, ${type}) VALUES (?, 1)
    ON CONFLICT(id) DO UPDATE SET ${type} = ${type} + 1`).run(id);
}
