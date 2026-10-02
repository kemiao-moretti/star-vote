import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { createDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const HOST = 'example.com';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function makeClient(hosts = [HOST]) {
  const db = createDb(':memory:');
  const server = createServer({ db, hosts });
  const base = await listen(server);
  return { server, db, base, close: () => new Promise((r) => server.close(r)) };
}

async function req(base, path, { method = 'GET', referer = `http://${HOST}/` } = {}) {
  return fetch(base + path, {
    method,
    headers: referer ? { Referer: referer } : {},
  });
}

let ctx;
before(async () => { ctx = await makeClient(); });
after(async () => { await ctx.close(); });

test('GET /api/rating/info 合法 Referer → 200 空对象', async () => {
  const res = await req(ctx.base, '/api/rating/info?id=x');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { rating: {} });
});

test('无 Referer → 403 Forbidden Referer', async () => {
  const res = await req(ctx.base, '/api/rating/info?id=x', { referer: '' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'Forbidden Referer' });
});

test('Referer 不在白名单 → 403', async () => {
  const res = await req(ctx.base, '/api/rating/info?id=x', { referer: 'http://evil.com/' });
  assert.equal(res.status, 403);
});

test('缺少 id → 400 Missing id', async () => {
  const res = await req(ctx.base, '/api/rating/info');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Missing id' });
});

test('OPTIONS 预检 → 200 且带 CORS 头', async () => {
  const res = await req(ctx.base, '/api/rating/info', { method: 'OPTIONS', referer: '' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
});

test('POST rating/update 合法分数 → 200 且计数累加', async () => {
  const u = await req(ctx.base, '/api/rating/update?id=a&value=5', { method: 'POST' });
  assert.equal(u.status, 200);
  assert.deepEqual(await u.json(), { success: true });
  const info = await req(ctx.base, '/api/rating/info?id=a');
  assert.deepEqual((await info.json()).rating['5'], 1);
});

test('POST rating/update 超范围分数 → 400', async () => {
  const res = await req(ctx.base, '/api/rating/update?id=a&value=9', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid rating parameters' });
});

test('POST vote/update 非法类型 → 400', async () => {
  const res = await req(ctx.base, '/api/vote/update?id=a&value=bad', { method: 'POST' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid vote parameters' });
});

test('POST vote/update 合法 → 200 且计数正确', async () => {
  await req(ctx.base, '/api/vote/update?id=b&value=up', { method: 'POST' });
  await req(ctx.base, '/api/vote/update?id=b&value=down', { method: 'POST' });
  const info = await req(ctx.base, '/api/vote/info?id=b');
  const votes = (await info.json()).votes;
  assert.equal(votes.up, 1);
  assert.equal(votes.down, 1);
});

test('未知路由 → 404', async () => {
  const res = await req(ctx.base, '/api/unknown');
  assert.equal(res.status, 404);
});

test('HOSTS 为空时任意 Referer → 403', async () => {
  const empty = await makeClient([]);
  try {
    const res = await req(empty.base, '/api/rating/info?id=x');
    assert.equal(res.status, 403);
  } finally {
    await empty.close();
  }
});