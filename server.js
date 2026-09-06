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
/* 本地密钥文件 .env(每行 KEY=VALUE,已被 .gitignore 的 .env* 排除,不会入库):
 * 密钥不再只活在进程环境里,重启服务器自动加载;真实环境变量优先(Render 上配的环境变量不受影响)。 */
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (val && !(m[1] in process.env)) process.env[m[1]] = val;
  }
} catch (e) { /* 没有 .env 文件:全部走真实环境变量,游戏离线可玩 */ }
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
 * 密钥来源优先级:玩家 BYOK(X-LLM-Key 请求头,存于其浏览器,服务端不落盘)> 服务端 LLM_API_KEY。
 * 两者都没有时端点返回 fallback,前端毫秒级回退本地模板池。
 * BYOK 防滥用:仅接受 https 接口地址,且拒绝回环/内网主机,避免公网 demo 被当开放代理。 */
function resolveLLMCfg(req) {
  const h = req.headers;
  const ukey = String(h['x-llm-key'] || '').trim().slice(0, 200);
  const umodel = String(h['x-llm-model'] || '').trim().slice(0, 60);
  const cfg = { key: ukey || LLM_API_KEY, base: LLM_API_BASE, model: umodel || LLM_MODEL, fromUser: !!ukey };
  let ubase = String(h['x-llm-base'] || '').trim().slice(0, 200);
  if (ubase) {
    ubase = ubase.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
    try {
      const u = new URL(ubase);
      const privateHost = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1?\])/.test(u.hostname);
      if (u.protocol === 'https:' && !privateHost) cfg.base = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
    } catch (e) { /* 非法地址:忽略,用默认 */ }
  }
  return cfg;
}
function llmPostPrompt(kind, o) {
  const stock = o.stock || '星阑科技';
  const biz = o.topic ? `(主营业务:${o.topic})` : '';
  const fiction = `这是全虚构股票模拟游戏《带节奏》的 NPC 文案,公司"${stock}"${biz}纯属虚构。只输出帖子正文本身:不要引号、不要前缀说明、不要话题标签、不要称呼读者为用户。`;
  if (kind === 'kol') return [
    `${fiction}${o.author}(${o.tag || '大V'})是社区里的大V,刚收了一笔"商务合作"费用。以${o.author}的口吻写一条坚定看好${stock}的帖子,80字以内,口吻自信、带点术语腔。`];
  if (kind === 'writer') return [
    `${fiction}以"离职员工自述体"写一篇看多${stock}的深度软文,180字以内:以自称前员工的视角透露一点无法查证的"内部信息",细节煽情,结尾暗示马上会涨。`];
  if (kind === 'retail') return [
    `${fiction}${o.author}(${o.tag || '普通散户'};${o.mood || '情绪平稳'})是社区里的普通居民,此刻自发冒泡发言。以TA的口吻写一条帖子,50字以内,口语化,像真人在评论区说话,可提到股价或自己的持仓操作,不要说教。`];
  if (kind === 'regulation') return [
    `${fiction}你现在是游戏里的"监管机构"。根据以下已掌握的线索,写一份简短的监管通报正文(80字内,公文腔,冷静克制,不引用真实法条,不出现真实人物/机构/地名):已掌握线索——${o.summary || '账户异常交易、多地关联账户联动'}。只输出通报正文。`];
  return [
    `${fiction}写一条营销号水军帖:无脑看多${stock},45字以内,语气浮夸,像批量复制的水军。`];
}
async function genLLMPost(kind, o, cfg) {
  const kf = cfg.fromUser ? 'u' + crypto.createHash('sha1').update(cfg.key).digest('hex').slice(0, 6) : 'env';
  const key = kind + '|' + o.stock + '|' + o.author + '|' + kf;
  const hit = cache.llm.get(key);
  if (hit && Date.now() - hit.at < LLM_TTL) return hit;
  const text = await callLLM(cfg, {
    system: '你是股票模拟游戏的文案写手。输出为纯文本正文,无任何格式修饰。',
    user: llmPostPrompt(kind, o)[0],
    maxTokens: 700, temperature: 0.9, timeoutMs: 15000,
  });
  const out = { text };
  cache.llm.set(key, { ...out, at: Date.now() });
  if (cache.llm.size > 100) cache.llm.delete(cache.llm.keys().next().value);
  return out;
}

/* 玩家自定义公司的"官方简介"(开始页 AI 助写按钮)。用户每次点击实时生成,不缓存,
 * 保证重复点击能得到不同版本;硬约束全虚构 + 不得含投资建议。 */
function llmCompanyPrompt(o) {
  return `为全虚构股票模拟游戏《带节奏》里的一家纯虚构公司写一段"关于我们"式官方简介,60~90 字,纯文本输出:不要引号、不要标题、不要 markdown、不要分点。
公司名"${o.name}",股票代码"${o.code}"(挂牌于虚构的云端证券交易所),主营业务"${o.topic || '未公开'}"。${o.hint ? '玩家补充的想法(可融入,不必照抄):' + o.hint : ''}
硬性规则:① 全部内容纯属虚构,不得出现任何真实存在的公司、人物、品牌、产品、地名机构名;② 只做公司背景描写(成立时间/规模/产品/融资/传闻皆可),不得出现买入卖出建议、涨跌预测、收益承诺;③ 语气像公司官网,自信得略带一丝可疑。`;
}
async function genLLMCompany(o, cfg) {
  const text = await callLLM(cfg, {
    system: '你是股票模拟游戏的文案写手。输出为纯文本正文,无任何格式修饰。',
    user: llmCompanyPrompt(o),
    maxTokens: 700, temperature: 1.0, timeoutMs: 20000,
  });
  return text.slice(0, 160);
}

/* 通用 LLM 调用(advisor/event/epitach/post/company 共用):返回清洗后的纯文本。
 * 对推理型模型(glm-5/deepseek-R系等)做三层兼容:
 *   ① content 可能带 <think> 思考段 → 清洗;② content 可能是分片数组 → 拼接;
 *   ③ token 预算被思考耗尽导致 content 为空 → 自动放大 4 倍预算重试一次。 */
function llmExtractText(res) {
  try {
    const msg = res.json && res.json.choices && res.json.choices[0] && res.json.choices[0].message;
    if (!msg) return '';
    const c = msg.content;
    let t = Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : String(c || '');
    return t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  } catch (e) { return ''; }
}
async function callLLM(cfg, { system, user, maxTokens = 300, temperature = 0.9, timeoutMs = 15000 }) {
  const ask = (tokens) => fetchJSON(cfg.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, stream: false, temperature, max_tokens: tokens,
      messages: [ { role: 'system', content: system }, { role: 'user', content: user } ],
    }),
  }, timeoutMs);
  let res = await ask(maxTokens);
  let text = llmExtractText(res);
  if (!text) {
    res = await ask(maxTokens * 4);   // 空内容(思考耗尽预算等):放大预算重试一次
    text = llmExtractText(res);
  }
  if (!text) { const err = new Error('llm empty, upstream ' + res.status); err.upstream = res.status; throw err; }
  return text.replace(/^["'「『]+|["'」』]+$/g, '').replace(/^```[a-z]*\n?|```$/g, '').replace(/```$/, '').trim();
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
/* 静态文件白名单:只服务前端真正引用的资源类型。项目目录里还有 .env(密钥)、
 * server.log、package.json、.bat 等——默认全放行会把它们直接吐给任何访客
 * (实测 GET /.env 返回 200)。前端不加载任何静态 .json,故白名单不含 .json。 */
const STATIC_EXT = new Set(['.html', '.css', '.js', '.png', '.svg', '.md']);
function serveStatic(req, res, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0]); }  // 畸形百分号编码(如非UTF-8字节)不抛500,落到下方白名单404
  catch (e) { p = urlPath.split('?')[0]; }
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (!STATIC_EXT.has(path.extname(file).toLowerCase())) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return;
  }
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
  console.log('[api]', req.method, p, new Date().toLocaleTimeString());  // 访问日志:便于排查"请求是否到达服务器"
  if (p === '/api/config') {
    return sendJSON(res, 200, { corpus: true, oauth: !!APP_ID, hotlist: !!SECRET, zhida: !!SECRET, selfDemo: !!SECRET && isLocalhost(req), llm: !!LLM_API_KEY, appId: APP_ID || null });
  }
  if (p === '/api/llm/post' && req.method === 'POST') {
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'LLM requires LLM_API_KEY or BYOK header', fallback: true });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const kind = ['post', 'writer', 'kol', 'retail', 'regulation'].includes(body.kind) ? body.kind : 'post';
      const o = { stock: String(body.stock || '').slice(0, 20), topic: String(body.topic || '').slice(0, 30), author: String(body.author || '').slice(0, 30), tag: String(body.tag || '').slice(0, 30), mood: String(body.mood || '').slice(0, 50), summary: String(body.summary || '').slice(0, 300) };
      return sendJSON(res, 200, await genLLMPost(kind, o, llmCfg));
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/advisor' && req.method === 'POST') {
    // AI 军师:结合本局实时状态回答战术问题(人→Agent)
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'requires key', fallback: true });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const q = String(body.q || '').trim().slice(0, 120);
      const state = String(body.state || '').slice(0, 700);
      if (!q) return sendJSON(res, 400, { error: 'empty question', fallback: true });
      const text = await callLLM(llmCfg, {
        system: '你是股票模拟游戏《带节奏》里的操盘助手「看盘君」。口吻老练、带点江湖气,句子短。用词必须准确规范,不生造词、不错别字。游戏中一切公司、股票、人物均纯属虚构。',
        user: `本局实时状态(虚构游戏数据):${state}\n玩家的问题:${q}\n要求:①结合状态给战术分析(围绕游戏机制:热度/监管/买盘池/居民情绪;若状态含「赛道/公司叙事」,可结合赛道特点);②若是新手名词就通俗解释;③不超过3句话;④结尾带一句"(虚构游戏,不构成投资建议)"。只输出回答本身。`,
        maxTokens: 500, temperature: 0.8,
      });
      return sendJSON(res, 200, { text: text.slice(0, 320) });
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/event' && req.method === 'POST') {
    // AI 实时抉择事件:LLM 只写叙事并从效果目录选 id,数值后果由引擎执行( Agent→人 )
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'requires key', fallback: true });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const state = String(body.state || '').slice(0, 700);
      const effects = String(body.effects || '').slice(0, 600);
      const ids = Array.isArray(body.ids) ? body.ids.filter(x => /^[a-z_]{2,20}$/.test(String(x))) : [];
      if (!state || !effects || ids.length < 2) return sendJSON(res, 400, { error: 'bad payload', fallback: true });
      const text = await callLLM(llmCfg, {
        system: '你是股票模拟游戏《带节奏》的肉鸽事件设计师。只输出一个 JSON 对象,不输出任何其他文字、解释或代码块标记。',
        user: `为庄家玩家设计一个本局专属的"抉择事件"(突发麻烦或机会,必须与状态里的具体数值处境挂钩——如监管高压/停牌中/刚连板/筹码未出完,有戏剧性和两难感)。
本局状态:${state}
事件题材必须紧扣这家公司的主营业务与赛道特质(见状态中的「主营/赛道/公司叙事」字段),让玩家一眼认出"这就是我的公司会遇到的事"。
效果目录(两个选项各绑定一个不同的 id):${effects}
只输出 JSON:{"title":"事件标题(≤12字)","text":"事件描述(≤90字,第二人称,写清处境与利害)","opts":[{"label":"选项标签(≤10字)","effect":"效果id"},{"label":"选项标签(≤10字)","effect":"效果id"}]}
全虚构,不出现真实公司/人物/政策/地名。`,
        maxTokens: 900, temperature: 1.0,
      });
      const s = text.indexOf('{'), e2 = text.lastIndexOf('}');
      let j = null;
      if (s >= 0 && e2 > s) { try { j = JSON.parse(text.slice(s, e2 + 1)); } catch (err) { /* JSON 解析失败走 fallback */ } }
      const okShape = j && typeof j.title === 'string' && typeof j.text === 'string' && Array.isArray(j.opts)
        && j.opts.length === 2 && j.opts.every(o => o && typeof o.label === 'string' && ids.includes(o.effect))
        && j.opts[0].effect !== j.opts[1].effect;
      if (!okShape) throw new Error('bad event json');
      return sendJSON(res, 200, { title: j.title.slice(0, 20), text: j.text.slice(0, 200), opts: j.opts.map(o => ({ label: o.label.slice(0, 16), effect: o.effect })) });
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/epitaph' && req.method === 'POST') {
    // AI 结案陈词:结局页个性化复盘
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'requires key', fallback: true });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ending = String(body.ending || '').slice(0, 80);
      const summary = String(body.summary || '').slice(0, 400);
      const stats = String(body.stats || '').slice(0, 200);
      if (!ending) return sendJSON(res, 400, { error: 'bad payload', fallback: true });
      const text = await callLLM(llmCfg, {
        system: '你是《带节奏》(全虚构股票操纵模拟游戏)的复盘旁白,冷静、克制、带一点黑色幽默。',
        user: `玩家刚结束一局,结局:「${ending}」。本局舆论手段:${summary || '无'}。战报:${stats}。\n写一段"结案陈词"式复盘(80字内,第二人称):点出他的手法链条,最后给一句"下次刷到类似新闻时"的媒介素养提醒。不出现真实公司/人物。只输出正文。`,
        maxTokens: 600, temperature: 0.9,
      });
      return sendJSON(res, 200, { text: text.slice(0, 320) });
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/models') {
    // BYOK 模型列表:代理 GET {base}/models(浏览器直连第三方有 CORS 限制,故走服务端转发)
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'requires API key', fallback: true });
    try {
      const r = await fetchJSON(llmCfg.base + '/models', { headers: { 'Authorization': 'Bearer ' + llmCfg.key } }, 10000);
      const j = r.json || {};
      // 兼容各家返回结构:{data:[{id}]}/{models:[{name|model}]}/裸数组/{data:{list:[...]}}
      const raw = [j, j.data, j.models, j.data && j.data.list, j.data && j.data.models].find(Array.isArray) || [];
      const ids = raw.map(x => (typeof x === 'string' ? x : (x && (x.id || x.name || x.model)) || '')).filter(Boolean);
      if (!ids.length) { const err = new Error('no models, upstream ' + r.status); err.upstream = r.status; throw err; }
      return sendJSON(res, 200, { models: [...new Set(ids)].sort() });
    } catch (e) { return sendJSON(res, 502, { error: 'models unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/company' && req.method === 'POST') {
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'LLM requires LLM_API_KEY or BYOK header', fallback: true });
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const o = {
        name: String(body.name || '').trim().slice(0, 12),
        code: String(body.code || '').trim().slice(0, 8),
        topic: String(body.topic || '').trim().slice(0, 30),
        hint: String(body.hint || '').trim().slice(0, 80),
      };
      if (!o.name || !/^88\d{4}$/.test(o.code)) return sendJSON(res, 400, { error: 'invalid name/code', fallback: true });
      return sendJSON(res, 200, { text: await genLLMCompany(o, llmCfg) });
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
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
