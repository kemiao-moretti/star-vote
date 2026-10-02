import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createDb, getRating, updateRating, getVote, updateVote } from './db.js';

const DEFAULT_PORT = 5556;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// 解析 HOSTS 白名单（逗号分隔）；options.hosts 优先用于测试注入。
function resolveHosts(options) {
  if (Array.isArray(options.hosts)) return options.hosts;
  return (process.env.HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function createServer(options = {}) {
  const db = options.db || createDb(process.env.DB_PATH || '/data/starvote.db');
  const hosts = resolveHosts(options);

  // Referer 白名单校验；HOSTS 为空拒绝一切，避免配置疏漏放行。
  const checkReferer = (req) => {
    if (hosts.length === 0) throw new Error('Forbidden Referer');
    const referer = req.headers.referer || '';
    if (!referer) throw new Error('Missing Referer');
    const refererHost = new URL(referer).hostname;
    if (!hosts.includes(refererHost)) throw new Error('Forbidden Referer');
  };

  const server = http.createServer((req, res) => {
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

    const { searchParams, pathname } = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const route = routes[`${req.method} ${pathname}`];
    if (!route) return sendJson(res, 404, { error: 'Not Found' });

    try {
      checkReferer(req);
    } catch {
      return sendJson(res, 403, { error: 'Forbidden Referer' });
    }

    try {
      route(req, res, searchParams);
    } catch (e) {
      console.error('[server] ERROR:', e.response?.data || e.message);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  });

  const ratingInfo = (_req, res, p) => {
    const id = p.get('id');
    if (!id) return sendJson(res, 400, { error: 'Missing id' });
    const rating = getRating(db, id);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ rating }));
  };

  const ratingUpdate = async (_req, res, p) => {
    const { id, value } = Object.fromEntries(p.entries());
    const score = Number.parseInt(value, 10);
    if (!id || !Number.isInteger(score) || score < 1 || score > 5) {
      return sendJson(res, 400, { error: 'Invalid rating parameters' });
    }
    updateRating(db, id, score);
    sendJson(res, 200, { success: true });
  };

  const voteInfo = (req, res, p) => {
    const id = p.get('id');
    if (!id) return sendJson(res, 400, { error: 'Missing id' });
    const votes = getVote(db, id);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ votes }));
  };

  const voteUpdate = (_req, res, p) => {
    const { id, value } = Object.fromEntries(p.entries());
    if (!id || (value !== 'up' && value !== 'down')) {
      return sendJson(res, 400, { error: 'Invalid vote parameters' });
    }
    updateVote(db, id, value);
    sendJson(res, 200, { success: true });
  };

  const routes = {
    'GET /api/rating/info': ratingInfo,
    'POST /api/rating/update': ratingUpdate,
    'GET /api/vote/info': voteInfo,
    'POST /api/vote/update': voteUpdate,
  };

  return server;
}

// 作为主模块运行时监听端口。
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createServer();
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  server.listen(port, () => {
    console.log(`StarVote listening on http://0.0.0.0:${port}`);
  });
}