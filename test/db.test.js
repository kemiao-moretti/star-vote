import { test } from 'node:test';
import assert from 'node:assert';
import { createDb, getRating, updateRating, getVote, updateVote } from '../src/db.js';

function newDb() {
  return createDb(':memory:');
}

test('getRating 无记录返回 {}', () => {
  const db = newDb();
  assert.deepEqual(getRating(db, 'missing'), {});
});

test('updateRating 后计数正确，同 id 累加', () => {
  const db = newDb();
  updateRating(db, 'x', 5);
  updateRating(db, 'x', 5);
  assert.equal(getRating(db, 'x')['5'], 2);
});

test('updateRating 不同分数分列计数', () => {
  const db = newDb();
  updateRating(db, 'x', 1);
  updateRating(db, 'x', 3);
  const r = getRating(db, 'x');
  assert.equal(r['1'], 1);
  assert.equal(r['3'], 1);
  assert.equal(r['5'], 0);
});

test('getVote 无记录返回 {}', () => {
  const db = newDb();
  assert.deepEqual(getVote(db, 'm'), {});
});

test('updateVote up/down 累加', () => {
  const db = newDb();
  updateVote(db, 'x', 'up');
  updateVote(db, 'x', 'up');
  updateVote(db, 'x', 'down');
  const v = getVote(db, 'x');
  assert.equal(v.up, 2);
  assert.equal(v.down, 1);
});

test('updateRating 非法分数抛错', () => {
  const db = newDb();
  assert.throws(() => updateRating(db, 'x', 0));
  assert.throws(() => updateRating(db, 'x', 6));
  assert.throws(() => updateRating(db, 'x', 2.5));
});

test('updateVote 非法类型抛错', () => {
  const db = newDb();
  assert.throws(() => updateVote(db, 'x', 'sideways'));
});
