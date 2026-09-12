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
/* 版本戳:每次改动 server.js 后手动 +1。启动日志与 /api/config.v 都带它,
 * 用于识别"端口被占用就沿用旧实例"场景下的陈旧进程(实测踩过:进程 13:18 启动,
 * 17:40 的安全修复没生效,PUT / 仍返回 200)。 */
const SERVER_VER = '20260912-r1';
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
/* 图片生成(GLM-Image / CogView 系)独立配置:不同网关对图片模型支持不同,
 * 常见组合=智谱开放平台直连(LLM_IMAGE_KEY=智谱 Key)。未配置时回退文本网关。 */
const LLM_IMAGE_KEY = process.env.LLM_IMAGE_KEY || '';
const LLM_IMAGE_BASE = (process.env.LLM_IMAGE_BASE || '').replace(/\/+$/, '');
const LLM_IMAGE_MODEL = process.env.LLM_IMAGE_MODEL || 'glm-image';
const REDIRECT_PATH = '/zhihu/callback';

const STORY_API = 'https://api.zhihu.com/km-indep-home/hackathon/v2';
const OPEN_BASE = 'https://developer.zhihu.com';

/* 烘焙快照(js/zhihu-baked.js,UMD 可直接 require):官方接口拉取的真实数据快照。
 * 三层降级的最底层——上游失败且内存里连 stale 都没有时(冷启动/未配 Secret/额度耗尽),
 * 把它顶上去,热搜背景板与题材事件在任何环境都不开天窗。 */
let BAKED = null;
try { BAKED = require('./js/zhihu-baked.js'); } catch (e) { /* 缺文件:降级链上层兜底,游戏照常可玩 */ }

/* ---------------- 内存缓存 ---------------- */
const cache = { corpus: null, corpusAt: 0, corpusLast: null, hot: null, hotAt: 0, hotLast: null, zhida: new Map(), llm: new Map() };
const CORPUS_TTL = 6 * 3600e3, HOT_TTL = 30 * 60e3, ZHIDA_TTL = 24 * 3600e3, LLM_TTL = 3600e3;

function zhihuHeaders(oauthToken) {
  const h = { 'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)) };
  if (SECRET) h.Authorization = 'Bearer ' + SECRET;
  if (oauthToken) h['X-OAuth-Token'] = oauthToken;
  return h;
}
async function fetchJSON(url, opts = {}, timeoutMs = 8000, extSignal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onExt = () => ctl.abort();
  if (extSignal) { if (extSignal.aborted) ctl.abort(); else extSignal.addEventListener('abort', onExt); }
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
    return { status: res.status, json, text };
  } finally { clearTimeout(timer); if (extSignal) extSignal.removeEventListener('abort', onExt); }
}

/* 出站上游统一闸门:一切服务端外呼必须走 https 公网地址——私网/回环/链路本地/非加密上游一律拒绝。
 * BYOK 的 X-LLM-Base 在 resolveLLMCfg 已筛过一遍;出口(fetchUpstream)再验一遍做纵深防御,
 * 同时防未来新增调用点绕过 resolveLLMCfg 直接拼 base。env 配置的上游同样受此约束(配错了端点会
 * 降级为模板池,不影响游戏可玩)。固定常量上游(STORY_API/OPEN_BASE 等)也统一走此闸门便于审计。 */
function isPrivateHost(hostname) {
  return /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1?\])/.test(hostname);
}
function assertPublicHttps(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { throw new Error('bad upstream url'); }
  if (u.protocol !== 'https:') throw new Error('upstream must be https');
  if (isPrivateHost(u.hostname)) throw new Error('upstream must be public host');
  return u;
}
function fetchUpstream(base, path, opts, timeoutMs, extSignal) {
  assertPublicHttps(base + path);
  return fetchJSON(base + path, opts, timeoutMs, extSignal);
}

/* 客户端提前断开(关页/前端超时放弃)时,同步掐掉上游请求:
 * 否则服务端会把 15s(文本)/120s(图片)的上游调用跑完,白耗配额与连接。
 * 用 res 的 close + writableFinished 判定:正常写完响应不算断开。 */
function clientGoneSignal(res) {
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  return ac.signal;
}

/* ---------------- 知乎能力 ---------------- */
function contentOf(list, kind, cap) {   // 内容池条目:标题/标签/作者,全部限长——站内内容按不可信输入处理
  const out = [];
  for (const s of list) {
    const title = String(s.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!title) continue;
    out.push({
      title, kind,
      author: String(s.author_name || '').slice(0, 20),
      labels: (Array.isArray(s.labels) ? s.labels : []).slice(0, 4).map(x => String(x).slice(0, 10)).filter(Boolean),
      workId: String(s.work_id || '').slice(0, 32),
    });
    if (out.length >= cap) break;
  }
  return out;
}
async function getCorpus() {   // 盐言故事+盐选知识:均免鉴权。故事标题给写手当"风格参照",全量内容池喂题材撞车事件
  if (cache.corpus && Date.now() - cache.corpusAt < CORPUS_TTL) return cache.corpus;
  const opt = { headers: { Accept: 'application/json' } };
  const [rs, rk] = await Promise.all([
    fetchUpstream(STORY_API, '/story/list', opt),
    fetchUpstream(STORY_API, '/knowledge/list', opt).catch(() => null),   // 知识列表可选:失败不拖垮故事语料
  ]);
  const listOf = (r) => (r && Array.isArray(r.json) ? r.json : (r && r.json && r.json.data) || []);
  const patterns = listOf(rs).slice(0, 12).map(s => ({
    title: s.title || '', author: s.author_name || '', labels: s.labels || [], workId: s.work_id || '',
  }));
  const content = contentOf(listOf(rs), 'story', 20).concat(contentOf(listOf(rk), 'knowledge', 10));
  if (!patterns.length && !content.length) throw new Error('story list empty');
  cache.corpus = { patterns, content, fetchedAt: new Date().toISOString() };
  cache.corpusAt = Date.now();
  cache.corpusLast = cache.corpus;
  return cache.corpus;
}
function staleOrBakedCorpus() {   // 上游失败:先回 stale(接口可能在抖),冷启动回烘焙快照,都没有才让端点 502
  if (cache.corpusLast) return { ...cache.corpusLast, stale: true };
  if (BAKED) return {
    patterns: [],
    content: contentOf(BAKED.stories || [], 'story', 20).concat(contentOf(BAKED.knowledge || [], 'knowledge', 10)),
    fetchedAt: BAKED.bakedAt || '', baked: true,
  };
  throw new Error('corpus unavailable');
}
async function getHotList() {  // 热榜:Bearer Access Secret,缓存 30 分钟
  if (cache.hot && Date.now() - cache.hotAt < HOT_TTL) return cache.hot;
  if (!SECRET) throw new Error('no secret');
  const res = await fetchUpstream(OPEN_BASE, '/api/v1/content/hot_list?Limit=20', { headers: zhihuHeaders() });
  const data = (res.json && (res.json.Data || res.json.data)) || res.json || {};
  const items = (data.Items || data.items || []).map(i => ({
    title: i.Title || i.title || '',
    url: i.Url || i.url || (i.Target && (i.Target.Url || i.Target.url)) || '',
  })).filter(i => i.title);
  if (!items.length) throw new Error('hot list empty: ' + JSON.stringify(res.json).slice(0, 120));
  cache.hot = items; cache.hotAt = Date.now();
  cache.hotLast = items;
  return items;
}
function staleOrBakedHot() {
  if (cache.hotLast && cache.hotLast.length) return cache.hotLast;
  if (BAKED && Array.isArray(BAKED.hot) && BAKED.hot.length) return BAKED.hot.filter(h => h && h.title).map(h => ({ title: h.title, url: h.url || '' }));
  throw new Error('no hot fallback');
}
async function askZhida(q) {   // 直答:Bearer Access Secret,问题级缓存
  const key = q.trim();
  const hit = cache.zhida.get(key);
  if (hit && Date.now() - hit.at < ZHIDA_TTL) return hit.answer;
  const res = await fetchUpstream(OPEN_BASE, '/v1/chat/completions', {
    method: 'POST',
    headers: { ...zhihuHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'zhida-fast-1p5', stream: false,
      messages: [{ role: 'user', content: '你是股票游戏里的助手"刘看山·看盘版"(知乎吉祥物刘看山的看盘形态)。用不超过三句话、面向新手回答下面的问题,不构成投资建议:' + key }],
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
      if (u.protocol === 'https:' && !isPrivateHost(u.hostname)) cfg.base = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, ''));
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
async function genLLMPost(kind, o, cfg, signal) {
  const kf = cfg.fromUser ? 'u' + crypto.createHash('sha256').update(cfg.key).digest('hex').slice(0, 6) : 'env';
  const key = kind + '|' + o.stock + '|' + o.author + '|' + kf;
  const hit = cache.llm.get(key);
  if (hit && Date.now() - hit.at < LLM_TTL) return hit;
  const text = await callLLM(cfg, {
    system: '你是股票模拟游戏的文案写手。输出为纯文本正文,无任何格式修饰。',
    user: llmPostPrompt(kind, o)[0],
    maxTokens: 700, temperature: 0.9, timeoutMs: 15000, signal,
  });
  const out = { text };
  cache.llm.set(key, { ...out, at: Date.now() });
  if (cache.llm.size > 100) cache.llm.delete(cache.llm.keys().next().value);
  return out;
}

/* 玩家自定义公司的"官方简介"(开始页 AI 助写按钮)。用户每次点击实时生成,不缓存,
 * 保证重复点击能得到不同版本;硬约束全虚构 + 不得含投资建议。 */
function llmCompanyPrompt(o) {
  return `为全虚构股票模拟游戏《带节奏》里的一家纯虚构公司写一段"关于我们"式官方简介,100~180 字,纯文本输出:不要引号、不要标题、不要 markdown、不要分点。
公司名"${o.name}",股票代码"${o.code}"(挂牌于虚构的云端证券交易所),主营业务"${o.topic || '未公开'}"。${o.hint ? '玩家补充的想法(可融入,不必照抄):' + o.hint : ''}
硬性规则:① 全部内容纯属虚构,不得出现任何真实存在的公司、人物、品牌、产品、地名机构名;② 只做公司背景描写(成立时间/规模/产品/融资/传闻皆可),不得出现买入卖出建议、涨跌预测、收益承诺;③ 语气像公司官网,自信得略带一丝可疑。`;
}
async function genLLMCompany(o, cfg, signal) {
  const text = await callLLM(cfg, {
    system: '你是股票模拟游戏的文案写手。输出为纯文本正文,无任何格式修饰。',
    user: llmCompanyPrompt(o),
    maxTokens: 700, temperature: 1.0, timeoutMs: 20000, signal,
  });
  return text.slice(0, 300);
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
async function callLLM(cfg, { system, user, maxTokens = 300, temperature = 0.9, timeoutMs = 15000, signal }) {
  const ask = (tokens) => fetchUpstream(cfg.base, '/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model, stream: false, temperature, max_tokens: tokens,
      messages: [ { role: 'system', content: system }, { role: 'user', content: user } ],
    }),
  }, timeoutMs, signal);
  let res = await ask(maxTokens);
  let text = llmExtractText(res);
  if (!text) {
    res = await ask(maxTokens * 4);   // 空内容(思考耗尽预算等):放大预算重试一次
    text = llmExtractText(res);
  }
  if (!text) { const err = new Error('llm empty, upstream ' + res.status); err.upstream = res.status; throw err; }
  return text.replace(/^["'「『]+|["'」』]+$/g, '').replace(/^```[a-z]*\n?|```$/g, '').replace(/```$/, '').trim();
}

/* ---------------- 图片生成(GLM-Image / CogView 系,像素小人头像) ----------------
 * OpenAI 兼容 images.generations 协议;密钥优先:LLM_IMAGE_KEY(如智谱直连)>
 * 玩家 BYOK(X-LLM-Key)> 文本 LLM 网关(部分中转同时代理图片模型)。 */
async function genImage(cfg, { prompt, size = '1024x1024', timeoutMs = 120000, signal }) {   // glm-image 生成常超 60s,别用文本默认值
  const res = await fetchUpstream(cfg.base, '/images/generations', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, prompt, size }),
  }, timeoutMs, signal);
  const d = ((res.json && (res.json.Data || res.json.data)) || [])[0] || {};
  if (d.url) return { url: d.url };
  if (d.b64_json) return { dataUrl: 'data:image/png;base64,' + d.b64_json };
  throw new Error('no image in response, upstream ' + res.status);
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
  // 协议:显式环境变量 > 反代透传 x-forwarded-proto > Render 等 https 平台默认 https > 本地 http。
  // 硬编码 http 会让公网 https 部署生成的 redirect_uri 与活动页登记的 https 回调不一致,OAuth 直接失败。
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = process.env.OAUTH_PROTO || fwd || (ON_RENDER ? 'https' : 'http');
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
    fetchUpstream(OPEN_BASE, '/api/v1/user/contents?limit=10&offset=0&ContentType=all', opt),
    fetchUpstream(OPEN_BASE, '/api/v1/user/followees?limit=10&offset=0', opt),
    fetchUpstream(OPEN_BASE, '/api/v1/user/favlists?limit=10&offset=0', opt),
  ]);
  const cl = (c.json && (c.json.Data || c.json.data)) || {};
  out.contents = ((cl.Items || cl.items || [])).slice(0, 10)
    .map(x => (x.Title || x.title || x.Excerpt || x.excerpt || '')).filter(Boolean);
  const fl = (f.json && (f.json.Data || f.json.data)) || {};
  out.followees = ((fl.Items || fl.items || [])).slice(0, 10)
    .map(x => (x.Fullname || x.fullname || x.Headline || x.headline || '')).filter(Boolean);
  // 完整字段版:给「知友分身」批量 NPC 用(人名/一句话介绍/性别/粉丝数)
  out.followeesFull = ((fl.Items || fl.items || [])).slice(0, 10)
    .map(x => ({
      name: String(x.Fullname || x.fullname || '').slice(0, 20),
      headline: String(x.Headline || x.headline || '').slice(0, 60),
      gender: x.Gender | 0,
      followers: x.FollowerCount || x.followerCount || 0,
    }))
    .filter(x => x.name);
  const fvl = (fv.json && (fv.json.Data || fv.json.data)) || {};
  out.favorites = ((fvl.Items || fvl.items || [])).slice(0, 10)
    .map(x => (x.Title || x.title || '')).filter(Boolean);
  out.followeeCount = (fl.Paging && fl.Paging.Totals) || out.followees.length;
  return out;
}

/* ---------------- HTTP 工具 ---------------- */
function sendJSON(res, code, obj) {
  if (res.writableEnded || res.destroyed) return;   // 客户端已断开:不再写,避免在已销毁的流上抛错
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
/* 静态文件白名单:显式枚举前端加载物,而非按扩展名放行——扩展名白名单会把
 * 目录里所有同扩展名文件一并吐给访客(实测 GET /server.js 本地与线上均 200,
 * .qa/ 测试产物同理)。现只服务:页面、三份脚本、样式表、assets/ 下图片;
 * 其余(server.js、.env、日志、文档、测试产物)一律 404。 */
const STATIC_FILES = new Set(['/index.html', '/game.js', '/ui.js', '/style.css', '/js/zhihu.js', '/js/zhihu-baked.js', '/js/qr-data.js']);
const ASSET_EXT = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp', '.gif']);
/* 缓存策略(2026-09-10):原先一律 no-cache 且不带 ETag/Last-Modified —— 没有校验器就没有
 * 304 可言,浏览器每次进站都得把 CSS/JS/图片全量重下一遍(实测开局页 3.05MB,其中图片 2.9MB,
 * 手机端 5~14 秒)。现分三级:
 *   · index.html:no-cache —— 页面本身永远拿最新,它引用的资源都带 ?v= 版本号
 *   · 带 ?v= 的资源:一年 immutable —— 改内容必须同步 bump 版本号(本项目既有约定)
 *   · 其余 assets(无版本参数):1 小时 —— 兼顾"换了图能较快生效" */
function cacheControl(urlPath, norm) {
  if (norm === '/index.html') return 'no-cache';
  if (/[?&]v=/.test(urlPath)) return 'public, max-age=31536000, immutable';
  return 'public, max-age=3600';
}
function serveStatic(req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {   // 静态资源只读:其余方法明确拒绝,避免 PUT/DELETE/TRACE 也返回 200 带 body
    res.writeHead(405, { 'Allow': 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }
  let p;
  try { p = decodeURIComponent(urlPath.split('?')[0]); }  // 畸形百分号编码(如非UTF-8字节)不抛500,落到下方白名单404
  catch (e) { p = urlPath.split('?')[0]; }
  if (p === '/' || p === '') p = '/index.html';
  // 归一化(吃掉内嵌 ../)并统一斜杠后再判白名单,防 /assets/..%2F 绕过扩展名检查
  const norm = path.normalize(p).replace(/^(\.\.[\/\\])+/, '').replace(/\\/g, '/');
  const file = path.join(ROOT, norm);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  const allowed = STATIC_FILES.has(norm)
    || (norm.startsWith('/assets/') && ASSET_EXT.has(path.extname(norm).toLowerCase()));
  if (!allowed) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return;
  }
  const cache = cacheControl(urlPath, norm);
  fs.stat(file, (err0, st) => {
    if (err0) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
    // 弱校验器:size+mtime,以秒级 mtime 避免部署瞬间的同秒抖动
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs / 1000).toString(16) + '"';
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some(t => t.trim() === etag || t.trim() === '*')) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
      res.end(); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': cache, 'ETag': etag, 'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    });
  });
}
function readBody(req, res, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) {
        // 先回一个明确的 413 再断开:旧实现直接 destroy,调用方只能看到连接被重置,无从排查
        const err = new Error('body too large'); err.tooLarge = true;
        if (res && !res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', 'Connection': 'close' });
          res.end(JSON.stringify({ error: 'payload too large' }));
        }
        req.destroy();
        reject(err);
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/* ---------------- API 路由 ---------------- */
/* 方法门禁:每个端点声明唯一合法方法,其余一律 405。
 * 顺带消除两类旧问题:只读端点接受 DELETE/PUT(实测 DELETE /api/config 返回 200),
 * 以及 GET 打到 POST 端点时落到 404「unknown api」的误导性报错。 */
const API_METHODS = {
  '/api/config': 'GET', '/api/llm/models': 'GET',
  '/api/zhihu/corpus': 'GET', '/api/zhihu/hot': 'GET', '/api/zhihu/authorize-url': 'GET',
  '/api/zhihu/npc': 'GET', '/api/zhihu/npc-self': 'GET', '/zhihu/callback': 'GET',
  '/api/llm/post': 'POST', '/api/llm/advisor': 'POST', '/api/llm/event': 'POST',
  '/api/llm/epitaph': 'POST', '/api/llm/company': 'POST', '/api/llm/image': 'POST', '/api/zhihu/zhida': 'POST',
};
async function handleAPI(req, res, url) {
  const p = url.pathname;
  console.log('[api]', req.method, p, new Date().toLocaleTimeString());  // 访问日志:便于排查"请求是否到达服务器"
  const want = API_METHODS[p];
  if (want && req.method !== want && !(want === 'GET' && req.method === 'HEAD')) {
    res.writeHead(405, { 'Allow': want, 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('405 Method Not Allowed');
  }
  if (p === '/api/config') {
    return sendJSON(res, 200, { v: SERVER_VER, corpus: true, oauth: !!APP_ID, hotlist: !!SECRET, zhida: !!SECRET, selfDemo: !!SECRET && isLocalhost(req), llm: !!LLM_API_KEY, appId: APP_ID || null });
  }
  if (p === '/api/llm/post' && req.method === 'POST') {
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'LLM requires LLM_API_KEY or BYOK header', fallback: true });
    try {
      const body = JSON.parse(await readBody(req, res) || '{}');
      const kind = ['post', 'writer', 'kol', 'retail', 'regulation'].includes(body.kind) ? body.kind : 'post';
      const o = { stock: String(body.stock || '').slice(0, 20), topic: String(body.topic || '').slice(0, 30), author: String(body.author || '').slice(0, 30), tag: String(body.tag || '').slice(0, 30), mood: String(body.mood || '').slice(0, 50), summary: String(body.summary || '').slice(0, 300) };
      return sendJSON(res, 200, await genLLMPost(kind, o, llmCfg, clientGoneSignal(res)));
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/advisor' && req.method === 'POST') {
    // AI 军师:结合本局实时状态回答战术问题(人→Agent)
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'requires key', fallback: true });
    try {
      const body = JSON.parse(await readBody(req, res) || '{}');
      const q = String(body.q || '').trim().slice(0, 120);
      const state = String(body.state || '').slice(0, 700);
      if (!q) return sendJSON(res, 400, { error: 'empty question', fallback: true });
      const text = await callLLM(llmCfg, {
        system: '你是股票模拟游戏《带节奏》里的操盘助手「刘看山·看盘版」——知乎吉祥物刘看山(一只北极狐)的看盘形态。口吻老练、带点江湖气,句子短。用词必须准确规范,不生造词、不错别字。游戏中一切公司、股票、人物均纯属虚构。',
        user: `本局实时状态(虚构游戏数据):${state}\n玩家的问题:${q}\n要求:①结合状态给战术分析(围绕游戏机制:热度/监管/买盘池/居民情绪;若状态含「赛道/公司叙事」,可结合赛道特点);②若是新手名词就通俗解释;③不超过3句话;④结尾带一句"(虚构游戏,不构成投资建议)"。只输出回答本身。`,
        maxTokens: 500, temperature: 0.8, signal: clientGoneSignal(res),
      });
      return sendJSON(res, 200, { text: text.slice(0, 320) });
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/event' && req.method === 'POST') {
    // AI 实时抉择事件:LLM 只写叙事并从效果目录选 id,数值后果由引擎执行( Agent→人 )
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'requires key', fallback: true });
    try {
      const body = JSON.parse(await readBody(req, res) || '{}');
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
        maxTokens: 900, temperature: 1.0, signal: clientGoneSignal(res),
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
      const body = JSON.parse(await readBody(req, res) || '{}');
      const ending = String(body.ending || '').slice(0, 80);
      const summary = String(body.summary || '').slice(0, 400);
      const stats = String(body.stats || '').slice(0, 200);
      if (!ending) return sendJSON(res, 400, { error: 'bad payload', fallback: true });
      const text = await callLLM(llmCfg, {
        system: '你是《带节奏》(全虚构股票操纵模拟游戏)的复盘旁白,冷静、克制、带一点黑色幽默。',
        user: `玩家刚结束一局,结局:「${ending}」。本局舆论手段:${summary || '无'}。战报:${stats}。\n写一段"结案陈词"式复盘(80字内,第二人称):点出他的手法链条,最后给一句"下次刷到类似新闻时"的媒介素养提醒。不出现真实公司/人物。只输出正文。`,
        maxTokens: 600, temperature: 0.9, signal: clientGoneSignal(res),
      });
      return sendJSON(res, 200, { text: text.slice(0, 320) });
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/models') {
    // BYOK 模型列表:代理 GET {base}/models(浏览器直连第三方有 CORS 限制,故走服务端转发)
    const llmCfg = resolveLLMCfg(req);
    if (!llmCfg.key) return sendJSON(res, 503, { error: 'requires API key', fallback: true });
    try {
      const r = await fetchUpstream(llmCfg.base, '/models', { headers: { 'Authorization': 'Bearer ' + llmCfg.key } }, 10000);
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
      const body = JSON.parse(await readBody(req, res) || '{}');
      const o = {
        name: String(body.name || '').trim().slice(0, 12),
        code: String(body.code || '').trim().slice(0, 8),
        topic: String(body.topic || '').trim().slice(0, 30),
        hint: String(body.hint || '').trim().slice(0, 80),
      };
      if (!o.name || !/^88\d{4}$/.test(o.code)) return sendJSON(res, 400, { error: 'invalid name/code', fallback: true });
      return sendJSON(res, 200, { text: await genLLMCompany(o, llmCfg, clientGoneSignal(res)) });
    } catch (e) { return sendJSON(res, 502, { error: 'llm unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/llm/image' && req.method === 'POST') {
    const llmCfg = resolveLLMCfg(req);
    const key = LLM_IMAGE_KEY || llmCfg.key;
    // 配了专用图片 Key 但没配 base:该 Key 视为智谱直连,不能落回文本网关(网关不认这个 Key)
    const base = LLM_IMAGE_BASE || (LLM_IMAGE_KEY ? 'https://open.bigmodel.cn/api/paas/v4' : llmCfg.base);
    if (!key) return sendJSON(res, 503, { error: 'image gen requires LLM_IMAGE_KEY or BYOK header', fallback: true });
    try {
      const body = JSON.parse(await readBody(req, res) || '{}');
      const prompt = String(body.prompt || '').trim().slice(0, 600);
      if (!prompt) return sendJSON(res, 400, { error: 'prompt required', fallback: true });
      const model = LLM_IMAGE_MODEL !== 'glm-image' ? LLM_IMAGE_MODEL : (String(body.model || '').trim().slice(0, 60) || LLM_IMAGE_MODEL);
      const out = await genImage({ key, base, model }, { prompt, signal: clientGoneSignal(res) });
      return sendJSON(res, 200, out);
    } catch (e) { console.error('[llm/image] fail:', e && e.message || e); return sendJSON(res, 502, { error: 'image gen unavailable', fallback: true, upstream: e.upstream || null }); }
  }
  if (p === '/api/zhihu/corpus') {
    try { return sendJSON(res, 200, await getCorpus()); }
    catch (e) {
      try { return sendJSON(res, 200, staleOrBakedCorpus()); }   // 降级也回 200+数据:前端拿真实条目,游戏不开天窗
      catch (e2) { return sendJSON(res, 502, { error: 'corpus unavailable', fallback: true }); }
    }
  }
  if (p === '/api/zhihu/hot') {
    try { return sendJSON(res, 200, { items: await getHotList() }); }
    catch (e) {
      // 未配 Secret / 上游失败 / 额度耗尽:一律回烘焙或 stale 真实条目(stale/baked 标记仅供观测)
      try { return sendJSON(res, 200, { items: staleOrBakedHot(), stale: !!cache.hotLast, baked: !cache.hotLast }); }
      catch (e2) { return sendJSON(res, 502, { error: 'hot list unavailable', fallback: true }); }
    }
  }
  if (p === '/api/zhihu/zhida' && req.method === 'POST') {
    if (!SECRET) return sendJSON(res, 503, { error: 'zhida requires ZHIHU_ACCESS_SECRET', fallback: true });
    try {
      const body = JSON.parse(await readBody(req, res) || '{}');
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
      const tok = await fetchUpstream('https://openapi.zhihu.com', '/access_token', {
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
    return serveStatic(req, res, url.pathname + (url.search || ''));
  } catch (e) {
    console.error('[500]', e && e.stack || e);
    if (res.headersSent) { try { res.end(); } catch (e2) { /* 连接已断 */ } return; }
    return sendJSON(res, 500, { error: 'internal' });
  }
});
server.listen(PORT, () => {
  console.log('《带节奏》服务器已启动: http://localhost:' + PORT);
  console.log('  版本 ' + SERVER_VER + ' · 启动于 ' + new Date().toLocaleString() + '(若与最新代码不符,说明这是陈旧实例,请重启)');
  console.log('  能力状态 → 写手语料: ✔(免鉴权) | 热榜: ' + (SECRET ? '✔' : '✘ 未配置 ZHIHU_ACCESS_SECRET(回烘焙快照)')
    + ' | 直答: ' + (SECRET ? '✔' : '✘') + ' | 知乎登录: ' + (APP_ID ? '✔' : '✘ 未配置 ZHIHU_OAUTH_APP_ID/APP_KEY')
    + ' | LLM文案: ' + (LLM_API_KEY ? '✔ ' + LLM_MODEL : '✘ 未配置 LLM_API_KEY(前端自动用本地模板)')
    + ' | 烘焙兜底: ' + (BAKED ? '✔ ' + (BAKED.hot || []).length + '热榜/' + ((BAKED.stories || []).length + (BAKED.knowledge || []).length) + '内容' : '✘ 缺 js/zhihu-baked.js'));
});
