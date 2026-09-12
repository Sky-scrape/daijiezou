'use strict';
/* 知乎内容接入守卫测试:烘焙快照形状 + 「题材撞车」事件(离线/在线两态)。
 * 与 rival-mine-test.js 同理:require 挂载引擎,不做任何动态求值(静态扫描门禁要求)。
 * 用法:node .qa/zhihu-live-test.js  */
const G = require('../game.js');
const BAKED = require('../js/zhihu-baked.js');

const { newGame, resolveRound, CONFIG, T, allNPCs } = G;

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function finiteState(st) {
  const nums = [st.price, st.cash, st.cost, st.heat, st.reg];
  st.history.forEach(h => nums.push(h.open, h.close, h.high, h.low, h.pct));
  allNPCs(st).forEach(n => nums.push(n.valence, n.arousal, n.confidence));
  return nums.every(isFinite);
}

/* ---------- [Z1] 烘焙快照形状(三层降级的最底层,坏了就全线开天窗) ---------- */
console.log('[Z1] 烘焙快照形状');
{
  check('[Z1] hot ≥ 20 条', Array.isArray(BAKED.hot) && BAKED.hot.length >= 20, String(BAKED.hot && BAKED.hot.length));
  check('[Z1] stories ≥ 10 条', Array.isArray(BAKED.stories) && BAKED.stories.length >= 10, String(BAKED.stories && BAKED.stories.length));
  check('[Z1] knowledge ≥ 5 条', Array.isArray(BAKED.knowledge) && BAKED.knowledge.length >= 5, String(BAKED.knowledge && BAKED.knowledge.length));
  check('[Z1] bakedAt 是 ISO 时间', BAKED.bakedAt && !isNaN(Date.parse(BAKED.bakedAt)), BAKED.bakedAt);
  const hotOk = BAKED.hot.every(h => h && typeof h.title === 'string' && h.title.length <= 80 && (!h.url || /^https:\/\//.test(h.url)));
  check('[Z1] hot 条目形状(标题≤80/url https)', hotOk);
  const cOk = (list, kind) => list.every(c => c && typeof c.title === 'string' && c.title.length >= 2 && c.title.length <= 60
    && c.kind === kind && Array.isArray(c.labels) && c.labels.length <= 4);
  check('[Z1] stories 条目形状', cOk(BAKED.stories, 'story'));
  check('[Z1] knowledge 条目形状', cOk(BAKED.knowledge, 'knowledge'));
  const raw = JSON.stringify(BAKED);
  check('[Z1] 无 undefined 残留', !/undefined/.test(raw));
  check('[Z1] 无 40 位 hex(防密钥/哈希混入快照)', !/[0-9a-f]{40}/.test(raw));
  check('[Z1] 无 Authorization 字样', !/authorization/i.test(raw));
  const dup = new Set(BAKED.hot.map(h => h.title));
  check('[Z1] hot 标题无重复', dup.size === BAKED.hot.length);
}

/* ---------- [Z2] 事件文案池 ---------- */
console.log('[Z2] 题材撞车文案');
{
  check('[Z2] ip_hype_good 存在且带 {t}/{stock} 占位', !!T.market.ip_hype_good && /\{t\}/.test(T.market.ip_hype_good.body) && /\{stock\}/.test(T.market.ip_hype_good.body));
  check('[Z2] ip_hype_bad 存在且带 {t}/{stock} 占位', !!T.market.ip_hype_bad && /\{t\}/.test(T.market.ip_hype_bad.body) && /\{stock\}/.test(T.market.ip_hype_bad.body));
  check('[Z2] 文案带来源归属与虚构声明', T.market.ip_hype_good.body.indexOf('知乎站内内容') > 0 && T.market.ip_hype_bad.body.indexOf('联动纯属虚构') > 0);
}

/* ---------- [Z3] 离线态:无 window → 题材撞车永不入池(基线零漂移) ---------- */
console.log('[Z3] 离线态基线不变');
{
  const hadWindow = typeof globalThis.window !== 'undefined' ? globalThis.window : undefined;
  delete globalThis.window;   // 与 headless 回测/浏览器缺池同态
  let hits = 0, threw = 0;
  for (let i = 0; i < 40 && !hits; i++) {
    try {
      const st = newGame();
      for (let r = 0; r < CONFIG.totalRounds && !st.ended; r++) {
        resolveRound(st);
        hits += st.feed.filter(x => x.tag === '盐选').length;
        if (hits) break;
      }
    } catch (e) { threw++; }
  }
  check('[Z3] 40 局零触发、零异常', hits === 0 && threw === 0, 'hits=' + hits + ' threw=' + threw);
  if (hadWindow) globalThis.window = hadWindow;
}

/* ---------- [Z4] 在线态:注入内容池 → 事件可触发、结构安全、数值有限 ---------- */
console.log('[Z4] 在线态事件触发');
{
  const titles = BAKED.stories.concat(BAKED.knowledge).map(c => ({ title: c.title, kind: c.kind, labels: c.labels, author: '' }));
  globalThis.window = { ZR_CONTENT: titles };
  let hits = [], threw = 0, games = 0;
  for (let i = 0; i < 80 && hits.length < 5; i++) {
    try {
      games++;
      const st = newGame(i % 2 ? 'custom' : undefined);
      for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended && hits.length < 5; r++) {
        resolveRound(st);
        for (const x of st.feed) if (x.tag === '盐选' && x.title === '题材撞车' && !hits.includes(x)) hits.push(x);
      }
    } catch (e) { threw++; console.log('  ✗ 异常:', e && e.message); }
  }
  delete globalThis.window;
  check('[Z4] 事件确实触发(80 局内)', hits.length >= 1, 'hits=' + hits.length + ' games=' + games);
  check('[Z4] 全程零异常', threw === 0, 'threw=' + threw);
  check('[Z4] 文案替换完整(无 {t} 残留)', hits.every(x => x.text.indexOf('{t}') < 0));
  check('[Z4] 标题注入成对书名号', hits.every(x => x.text.indexOf('《') >= 0));
  check('[Z4] 归属声明在帖内', hits.every(x => x.text.indexOf('知乎站内内容') > 0 && x.text.indexOf('联动纯属虚构') > 0));
  check('[Z4] 长标题被截到 40 字内注入', hits.every(x => {
    const m = x.text.match(/《([^》]{1,})》/);
    return m && m[1].length <= 40;
  }));
  check('[Z4] 点赞数为有限正整数', hits.every(x => Number.isFinite(x.likes) && x.likes > 0));
}

console.log(fail ? '\n❌ ' + fail + ' 项失败 / ' + (pass + fail) : '\n✅ 全部通过:' + pass + ' 项');
process.exit(fail ? 1 : 0);
