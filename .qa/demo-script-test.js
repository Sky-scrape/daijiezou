/* 演示编排回归:镜像 ui.js autoDemo 的编排式脚本(守卫顺序一致),跑 300 局
 * 验证 ① 结局分布不被展示位拖垮(无 NaN/入狱,好结局占比达标) ② 各玩法触发覆盖率。
 * ui.js 是浏览器代码无法在 Node require,脚本表在此复制一份;两边同改,本表防跑偏。
 * autoPolicy 未导出,同样按 game.js 原文内联。 */
'use strict';
const G = require('../game.js');

let seed = 20260915 + 7;                    // LCG:仅测试自身决策用;引擎内部随机不可种子化,断言留足余量
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pickA = a => a[Math.floor(rnd() * a.length)];

/* ---- game.js autoPolicy 原文内联(勿改语义) ---- */
function autoPolicy(st) {
  const acts = [];
  const sellable = G.sellableShares(st);
  const s = sellable > 0 ? sellable : 0;
  if (st.halted) return { acts: [], buy: null, sell: null };
  if (st.round <= 3) return { acts: [], buy: { mode: 'pump', amt: Math.min(150, Math.floor(st.cash / st.price) - 1) }, sell: null };
  if (st.round <= 8) {
    if (st.reg > 52) return { acts: [], buy: { mode: 'pump', amt: Math.min(100, Math.floor(st.cash / st.price) - 1) }, sell: null };
    const ops = st.round % 2 === 0 ? ['hot', 'post'] : ['writer'];
    return { acts: ops, buy: { mode: 'pump', amt: Math.min(100, Math.floor(st.cash / st.price) - 1) }, sell: null };
  }
  if (st.round <= 13) {
    const ops = st.heat < 55 ? ['hot'] : (st.round % 3 === 0 ? ['writer'] : []);
    const amt = Math.min(430, s);
    return { acts: ops, buy: null, sell: amt > 50 && st.price > 6.5 ? { channel: 'auction', amt } : null };
  }
  const amt = s;
  return { acts: [], buy: null, sell: amt > 0 ? { channel: st.reg > 45 ? 'block' : 'tail', amt } : null };
}

/* ---- ui.js autoDemo 编排表的镜像(每回合至多一个展示位) ---- */
function scriptOp(st, r) {
  switch (r) {
    case 1: return G.applyOpinion(st, 'astroturf', 'kol_sx');
    case 2: return G.applyOpinion(st, 'post', 'kol_sx', 'story');
    case 3: return G.applyOpinion(st, 'kol', 'kol_sx');
    case 4: return G.probeMine(st);
    case 5: return (st.rival && !st.rival.done) ? G.digRival(st) : { ok: false };
    case 6: return G.useWash(st);
    case 8: return G.applyOpinion(st, 'clarify', 'kol_sx');
    case 9: return G.useExit(st);
    case 10: return G.useSupport(st);
    default: return null;
  }
}

function runOne() {
  const st = G.newGame(G.TRAITS[Math.floor(rnd() * G.TRAITS.length)].id);
  const fired = {};
  for (let r = 1; r <= G.CONFIG.totalRounds + 1 && !st.ended; r++) {
    if (st.pendingDecision) {                       // ① 抉择:随机选项
      const card = st.pendingDecision;
      card.opts[Math.floor(rnd() * card.opts.length)].apply(st);
      st.pendingDecision = null;
      fired.decision = true;
    }
    if (st.rival && !st.rival.done && st.rival.duelCard && st.rival.duelCard.duelState === 'open' && st.ap >= 1) {
      G.counterAttack(st); fired.duel = true;       // ② 对线回击
    }
    if (st.askPending && st.askPending.state === 'open') {
      G.answerAsk(st, pickA(['long', 'short', 'long', 'joke'])); fired.ask = true;   // ③ 知友提问
    }
    if (st.mine && st.mine.discovered && !st.mine.defused && !st.mine.exploded && st.round <= 8) {
      if (G.defuseMine(st).ok) fired.defuse = true; // ④ 自爆洗白
    }
    const r = scriptOp(st, st.round);               // ⑤ 展示位(独占一拍=常规策略照常随后)
    if (r && r.ok !== false) fired['s' + st.round] = true;
    const plan = autoPolicy(st);                    // ⑥ 常规策略 + 结算
    if (st.reg >= 50) plan.acts = plan.acts.filter(op => op !== 'writer');   // 镜像 ui.js:高监管不碰写手
    if (st.round >= 5 && st.round <= 6 && st.price > 6.0) {   // 镜像 ui.js:边拉边出回笼现金
      const amt = Math.min(200, G.sellableShares(st));
      if (amt > 50) G.stageSell(st, 'auction', amt);
    }
    for (const op of plan.acts) G.applyOpinion(st, op, 'kol_sx');
    if (plan.buy && plan.buy.amt > 0) G.stageBuy(st, plan.buy.amt, plan.buy.mode);
    if (plan.sell && plan.sell.amt > 0) G.stageSell(st, plan.sell.channel, plan.sell.amt);
    G.resolveRound(st);
    if (!isFinite(st.price) || !isFinite(st.cash)) return { st, fired, nan: true };
  }
  if (!st.ended) G.triggerEnd(st, null);
  return { st, fired, nan: false };
}

const RUNS = 300;
const tally = {};
let NaNs = 0;
const cov = {};
const keys = ['s1', 's2', 's3', 's4', 's5', 's6', 's8', 's9', 's10', 'decision', 'duel', 'ask', 'defuse'];
for (let i = 0; i < RUNS; i++) {
  const { st, fired, nan } = runOne();
  if (nan) { NaNs++; continue; }
  const k = st.ending.key;
  tally[k] = (tally[k] || 0) + 1;
  for (const x of keys) if (fired[x]) cov[x] = (cov[x] || 0) + 1;
}

const pct = n => Math.round(n / RUNS * 100);
console.log('=== 演示编排 ' + RUNS + ' 局 ===');
console.log('结局分布: ' + Object.entries(tally).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => G.ENDINGS[k].title + ' ' + pct(v) + '%').join(' + '));
console.log('玩法覆盖率: ' + keys.map(x => x + ' ' + pct(cov[x] || 0) + '%').join(' | '));
console.log('NaN局数: ' + NaNs);

const good = (tally.clean || 0) + (tally.safe || 0);
const bad = [];
if (NaNs > 0) bad.push('有 ' + NaNs + ' 局 NaN');
if ((tally.prison || 0) > 1) bad.push('入狱 ' + pct(tally.prison) + '%(演示局阈值 ≤1/300)');
if (good < RUNS * 0.60) bad.push('好结局仅 ' + pct(good) + '%(阈值 60%)');
for (const [x, min] of [['s1', 90], ['s2', 90], ['s3', 90], ['s4', 90], ['s5', 90], ['s6', 65], ['s8', 85], ['s9', 62], ['s10', 40], ['defuse', 75], ['ask', 60], ['decision', 60]]) {
  if ((cov[x] || 0) < RUNS * min / 100) bad.push('展示位 ' + x + ' 覆盖率仅 ' + pct(cov[x] || 0) + '%(阈值 ' + min + '%)');
}
if (bad.length) { console.log('FAIL: ' + bad.join(' ; ')); process.exit(1); }
console.log('PASS: 结局质量与玩法覆盖全部达标');
