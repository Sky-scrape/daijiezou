'use strict';
/* ============================================================
 * 《带节奏》本地/线上服务器(零依赖,Node >= 16)
 *   node server.js   (PORT 环境变量可选,默认 8788)
 *
 * 环境变量(全部可选,缺失时对应功能自动降级,游戏离线可玩):
 *   ZHIHU_ACCESS_SECRET    开放平台 Access Secret → 激活 热榜 / 直答 / OAuth用户数据
 *   ZHIHU_OAUTH_APP_ID     黑客松项目 App ID       → 激活 知乎登录
 *   ZHIHU_OAUTH_APP_KEY    黑客松项目 App Key      → OAuth 换 token(仅服务端)
 *   LLM_API_KEY            OpenAI 兼容接口密钥     → 激活 LLM 文本层(NPC 帖子文案)
 *   LLM_API_BASE           默认 https://open.bigmodel.cn/api/paas/v4(GLM,OpenAI 兼容)
 *   LLM_MODEL              默认 glm-4-flash
 *
 * 安全:所有凭证只存在于服务端环境变量;/api/config 只暴露布尔值与公开的 app_id。
 * ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 8788;
const ROOT = __dirname;
const SECRET = process.env.ZHIHU_ACCESS_SECRET || '';
const APP_ID = process.env.ZHIHU_OAUTH_APP_ID || '';
const APP_KEY = process.env.ZHIHU_OAUTH_APP_KEY || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_API_BASE = (process.env.LLM_API_BASE || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
const LLM_MODEL = process.env.LLM_MODEL || 'glm-4-flash';
const REDIRECT_PATH = '/zhihu/callback';

const STORY_API = 'https://api.zhihu.com/km-indep-home/hackathon/v2';
const OPEN_BASE = 'https://developer.zhihu.com';

/* ---------------- 内存缓存 ---------------- */
const cache = { corpus: null, corpusAt: 0, hot: null, hotAt: 0, zhida: new Map(), llm: new Map() };
const CORPUS_TTL = 6 * 3600e3, HOT_TTL = 30 * 60e3, ZHIDA_TTL = 24 * 3600e3, LLM_TTL = 3600e3;

function zhihuHeaders(oauthToken) {
  const h = { 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)) };
  if (SECRET) h.Authorization = 'Bearer ' + SECRET;
  if (oauthToken) h['X-OAuth-Token'] = oauthToken;
  return h;
}
async function fetchJSON(url, opts = {}, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
    return { status: res.status, json, text };
  } finally { clearTimeout(timer); }
}

/* ---------------- 知乎能力 ---------------- */
async function getCorpus() {   // 盐言故事:免鉴权。取标题套路 + 作者,生成写手"风格参照"卡
  if (cache.corpus && Date.now() - cache.corpusAt < CORPUS_TTL) return cache.corpus;
  const res = await fetchJSON(STORY_API + '/story/list', { headers: { Accept: 'application/json' } });
  const list = Array.isArray(res.json) ? res.json : (res.json && res.json.data) || [];
  const patterns = list.slice(0, 12).map(s => ({
    title: s.title || '', author: s.author_name || '', labels: s.labels || [], workId: s.work_id || '',
  }));
  if (!patterns.length) throw new Error('story list empty');
  cache.corpus = { patterns, fetchedAt: new Date().toISOString() };
  cache.corpusAt = Date.now();
  return cache.corpus;
}
async function getHotList() {  // 热榜:Bearer Access Secret,缓存 30 分钟
  if (cache.hot && Date.now() - cache.hotAt < HOT_TTL) return cache.hot;
  if (!SECRET) throw new Error('no secret');
  const res = await fetchJSON(OPEN_BASE + '/api/v1/content/hot_list?Limit=20', { headers: zhihuHeaders() });
  const data = (res.json && (res.json.Data || res.json.data)) || res.json || {};
  const items = (data.Items || data.items || []).map(i => ({
    title: i.Title || i.title || '',
    url: i.Url || i.url || (i.Target && (i.Target.Url || i.Target.url)) || '',
  })).filter(i => i.title);
  if (!items.length) throw new Error('hot list empty: ' + JSON.stringify(res.json).slice(0, 120));
  cache.hot = items; cache.hotAt = Date.now();
  return items;
}
async function askZhida(q) {   // 直答:Bearer Access Secret,问题级缓存
  const key = q.trim();
  const hit = cache.zhida.get(key);
  if (hit && Date.now() - hit.at < ZHIDA_TTL) return hit.answer;
  const res = await fetchJSON(OPEN_BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { ...zhihuHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'zhida-fast-1p5', stream: false,
      messages: [{ role: 'user', content: '你是股票游戏里的助手"看盘君"。用不超过三句话、面向新手回答下面的问题,不构成投资建议:' + key }],
    }),
  }, 15000);
  const answer = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message
    ? (res.json.choices[0].message.content || '') : '';
  if (!answer) throw new Error('zhida empty');
  cache.zhida.set(key, { answer, at: Date.now() });
  if (cache.zhida.size > 200) {  // 简单淘汰:删最早缓存的问题
    const oldest = cache.zhida.keys().next().value;
    cache.zhida.delete(oldest);
  }
  return answer;
}

/* ---------------- LLM 文本层(NPC 帖子文案,OpenAI 兼容接口) ----------------
 * 知乎直答实测只能问答、会拒绝角色扮演创作,故创作类文案走通用 chat/completions。
 * 未配置 LLM_API_KEY 时端点返回 fallback,前端毫秒级回退本地模板池。 */
function llmPostPrompt(kind, o) {
  const stock = o.stock || '星阑科技';
  const fiction = `这是全虚构股票模拟游戏《带节奏》的 NPC 文案,公司"${stock}"纯属虚构。只输出帖子正文本身:不要引号、不要前缀说明、不要话题标签、不要称呼读者为用户。`;
  if (kind === 'kol') return [
    `${fiction}${o.author}(${o.tag || '大V'})是社区里的大V,刚收了一笔"商务合作"费用。以${o.author}的口吻写一条坚定看好${stock}的帖子,80字以内,口吻自信、带点术语腔。`];
  if (kind === 'writer') return [
    `${fiction}以"离职员工自述体"写一篇看多${stock}的深度软文,180字以内:以自称前员工的视角透露一点无法查证的"内部信息",细节煽情,结尾暗示马上会涨。`];
  return [
    `${fiction}写一条营销号水军帖:无脑看多${stock},45字以内,语气浮夸,像批量复制的水军。`];
}
async function genLLMPost(kind, o) {
  const key = kind + '|' + o.stock + '|' + o.author;
  const hit = cache.llm.get(key);
  if (hit && Date.now() - hit.at < LLM_TTL) return hit;
  const res = await fetchJSON(LLM_API_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + LLM_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL, stream: false, temperature: 0.9, max_tokens: 300,
      messages: [
        { role: 'system', content: '你是股票模拟游戏的文案写手。输出为纯文本正文,无任何格式修饰。' },
        { role: 'user', content: llmPostPrompt(kind, o)[0] },
      ],
    }),
  }, 12000);
  let text = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message
    ? String(res.json.choices[0].message.content || '').trim() : '';
  text = text.replace(/^["'「『]+|["'」』]+$/g, '').replace(/^```[a-z]*\n?|```$/g, '').trim();
  if (!text) throw new Error('llm empty');
  const out = { text };
  cache.llm.set(key, { ...out, at: Date.now() });
  if (cache.llm.size > 100) cache.llm.delete(cache.llm.keys().next().value);
  return out;
}

/* ---------------- OAuth(知乎登录 → 个性化 NPC 数据) ---------------- */
const SESSION_TTL = 24 * 3600e3;
const sessions = new Map();    // zrs -> {oauthToken, at}(演示版存内存;生产请换会话存储)
function getSession(zrs) {
  const s = sessions.get(zrs);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_TTL) { sessions.delete(zrs); return null; }
  return s;
}
function oauthRedirectUri(req) {
  const host = req.headers.host || ('localhost:' + PORT);
  const proto = 'http'; // 本地/演示;若部署在 https 反代后,请改为 https
  return proto + '://' + host + REDIRECT_PATH;
}
/* "本人画像"演示模式只应在开发者本机开放:公网部署时,任何访客都能
   通过该接口读到 Access Secret 所属账号的知乎内容,故默认拒绝外部来源。
   判定方式:连接来源 IP 命中本机任意网卡地址(回环/局域网皆可)即算本机——
   与访问时用 localhost 还是局域网 IP 无关;不依赖 Host 头(可被伪造)。 */
const LOCAL_ADDRS = new Set(['127.0.0.1', '::1']);
for (const list of Object.values(os.networkInterfaces()))
  for (const ni of list || []) if (ni && ni.address) LOCAL_ADDRS.add(ni.address);
/* Render 等平台经内部代理转发请求,remoteAddress 可能表现为本机地址,
   导致 isLocalhost 误判 —— 实测 Render 线上 selfDemo 被置 true。
   故公网部署(RENDER_EXTERNAL_URL 由 Render 自动注入)一律强制关闭本人画像接口。 */
const ON_RENDER = !!process.env.RENDER_EXTERNAL_URL;
function isLocalhost(req) {
  if (ON_RENDER) return false;
  if (process.env.ALLOW_SELF_DEMO === '1') return true;
  const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return LOCAL_ADDRS.has(addr);
}
async function fetchUserDigest(oauthToken) {
  // oauthToken 为空 = "本人模式":只凭 Access Secret 读 Secret 所属账号(文档允许)
  const out = { contents: [], followees: [], favorites: [] };
  const opt = { headers: { ...zhihuHeaders(oauthToken), 'Content-Type': 'application/json' } };
  const [c, f, fv] = await Promise.all([
    fetchJSON(OPEN_BASE + '/api/v1/user/contents?limit=10&offset=0&ContentType=all', opt),
    fetchJSON(OPEN_BASE + '/api/v1/user/followees?limit=10&offset=0', opt),
    fetchJSON(OPEN_BASE + '/api/v1/user/favlists?limit=10&offset=0', opt),
  ]);
  const cl = (c.json && (c.json.Data || c.json.data)) || {};
  out.contents = ((cl.Items || cl.items || [])).slice(0, 10)
    .map(x => (x.Title || x.title || x.Excerpt || x.excerpt || '')).filter(Boolean);
  const fl = (f.json && (f.json.Data || f.json.data)) || {};
  out.followees = ((fl.Items || fl.items || [])).slice(0, 10)
    .map(x => (x.Fullname || x.fullname || x.Headline || x.headline || '')).filter(Boolean);
  const fvl = (fv.json && (fv.json.Data || fv.json.data)) || {};
  out.favorites = ((fvl.Items || fvl.items || [])).slice(0, 10)
    .map(x => (x.Title || x.title || '')).filter(Boolean);
  out.followeeCount = (fl.Paging && fl.Paging.Totals) || out.followees.length;
  return out;
}

/* ---------------- HTTP 工具 ---------------- */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };
function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* ---------------- API 路由 ---------------- */
async function handleAPI(req, res, url) {
  const p = url.pathname;
  if (p === '/api/config') {
    return sendJSON(res, 200, { corpus: true, oauth: !!APP_ID, hotlist: !!SECRET, zhida: !!SECRET, selfDemo: !!SECRET && isLocalhost(req), llm: !!LLM_API_KEY, appId: APP_ID || null });
  }
  if (p === '/api/llm/post' && req.method === 'POST') {
    if (!LLM_API_KEY) return sendJSON(res, 503, { error: 'LLM requires LLM_API_KEY', fallback: true });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const kind = ['post', 'writer', 'kol'].includes(body.kind) ? body.kind : 'post';
      const o = { stock: String(body.stock || '').slice(0, 20), author: String(body.author || '').slice(0, 30), tag: String(body.tag || '').slice(0, 30) };
      return sendJSON(res, 200, await genLLMPost(kind, o));
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true }); }
  }
  if (p === '/api/zhihu/corpus') {
    try { return sendJSON(res, 200, await getCorpus()); }
    catch (e) { return sendJSON(res, 502, { error: 'corpus unavailable', fallback: true }); }
  }
  if (p === '/api/zhihu/hot') {
    if (!SECRET) return sendJSON(res, 503, { error: 'hot list requires ZHIHU_ACCESS_SECRET', fallback: true });
    try { return sendJSON(res, 200, { items: await getHotList() }); }
    catch (e) { return sendJSON(res, 502, { error: 'hot list unavailable', fallback: true }); }
  }
  if (p === '/api/zhihu/zhida' && req.method === 'POST') {
    if (!SECRET) return sendJSON(res, 503, { error: 'zhida requires ZHIHU_ACCESS_SECRET', fallback: true });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const q = String(body.q || '').slice(0, 120);
      if (!q.trim()) return sendJSON(res, 400, { error: 'empty question' });
      return sendJSON(res, 200, { answer: await askZhida(q) });
    } catch (e) { return sendJSON(res, 502, { error: 'zhida unavailable', fallback: true }); }
  }
  if (p === '/api/zhihu/authorize-url') {
    if (!APP_ID) return sendJSON(res, 503, { error: 'OAuth not configured', fallback: true });
    const redirect = oauthRedirectUri(req);
    const u = 'https://openapi.zhihu.com/authorize?' + new URLSearchParams({ redirect_uri: redirect, app_id: APP_ID, response_type: 'code' });
    return sendJSON(res, 200, { url: u, redirectUri: redirect });
  }
  if (p === REDIRECT_PATH) {  // OAuth 回调:换 token → 拉取用户数据摘要 → 跳回游戏
    const code = url.searchParams.get('authorization_code') || url.searchParams.get('code') || '';
    if (!code || !APP_ID || !APP_KEY) { res.writeHead(302, { Location: '/?zr_oauth=fail' }); return res.end(); }
    try {
      const redirect = oauthRedirectUri(req);
      const form = new URLSearchParams({ app_id: APP_ID, app_key: APP_KEY, grant_type: 'authorization_code', redirect_uri: redirect, code });
      const tok = await fetchJSON('https://openapi.zhihu.com/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }, 10000);
      const oauthToken = tok.json && tok.json.access_token;
      if (!oauthToken) throw new Error('no access_token');
      const zrs = crypto.randomBytes(12).toString('hex');
      sessions.set(zrs, { oauthToken, at: Date.now() });
      if (sessions.size > 40) {  // opportunistic 清理过期会话
        for (const [k, v] of sessions) if (Date.now() - v.at > SESSION_TTL) sessions.delete(k);
      }
      res.writeHead(302, { Location: '/?zrs=' + zrs });
      return res.end();
    } catch (e) {
      res.writeHead(302, { Location: '/?zr_oauth=fail' });
      return res.end();
    }
  }
  if (p === '/api/zhihu/npc') {
    const zrs = url.searchParams.get('zrs') || '';
    const sess = getSession(zrs);
    if (!sess) return sendJSON(res, 404, { error: 'session not found', fallback: true });
    try {
      const digest = await fetchUserDigest(sess.oauthToken);
      return sendJSON(res, 200, digest);
    } catch (e) {
      // token 可能过期:丢弃会话,前端走降级
      sessions.delete(zrs);
      return sendJSON(res, 502, { error: 'user data unavailable', fallback: true });
    }
  }
  if (p === '/api/zhihu/npc-self') {
    // 本人数据模式:单凭 Access Secret 读 Secret 所属账号(演示/开发用,无需 OAuth)
    if (!SECRET) return sendJSON(res, 503, { error: 'requires ZHIHU_ACCESS_SECRET', fallback: true });
    if (!isLocalhost(req)) return sendJSON(res, 403, { error: 'self demo is only available on localhost', fallback: true });
    try {
      const digest = await fetchUserDigest('');
      digest.mode = 'self';
      return sendJSON(res, 200, digest);
    } catch (e) {
      return sendJSON(res, 502, { error: 'user data unavailable', fallback: true });
    }
  }
  return sendJSON(res, 404, { error: 'unknown api' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === REDIRECT_PATH) {
      return await handleAPI(req, res, url);
    }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch (e2) { /* 连接已断 */ } return; }
    return sendJSON(res, 500, { error: 'internal' });
  }
});
server.listen(PORT, () => {
  console.log('《带节奏》服务器已启动: http://localhost:' + PORT);
  console.log('  能力状态 → 写手语料: ✔(免鉴权) | 热榜: ' + (SECRET ? '✔' : '✘ 未配置 ZHIHU_ACCESS_SECRET')
    + ' | 直答: ' + (SECRET ? '✔' : '✘') + ' | 知乎登录: ' + (APP_ID ? '✔' : '✘ 未配置 ZHIHU_OAUTH_APP_ID/APP_KEY')
    + ' | LLM文案: ' + (LLM_API_KEY ? '✔ ' + LLM_MODEL : '✘ 未配置 LLM_API_KEY(前端自动用本地模板)'));
});
