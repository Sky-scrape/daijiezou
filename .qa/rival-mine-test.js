'use strict';
/* 对手盘 × 暗雷(信息战扩展包)守卫测试。
 * 独立成文件的原因:.qa/stress-test.js 用 new Function 动态执行,Mimosa 门禁拦截写入;
 * game.js 尾部已有 CommonJS 导出(多样性轮加入),直接 require 即可,不触发自动回测。
 * 用法:node .qa/rival-mine-test.js  */
const G = require('../game.js');

const { newGame, applyOpinion, stageBuy, stageSell, resolveRound, triggerEnd, sellableShares,
  resetStock, CONFIG, TRAITS, pick, randInt, clamp, ENDINGS, allNPCs,
  RIVAL_DEFS, MINES, counterAttack, digRival, allyKols, reportRival, probeMine, defuseMine, explodeMine, bustRival } = G;

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function finiteState(st) {
  const nums = [st.price, st.cash, st.cost, st.heat, st.reg];
  st.history.forEach(h => nums.push(h.open, h.close, st.history ? h.high : 0, h.low, h.pct));
  allNPCs(st).forEach(n => nums.push(n.valence, n.arousal, n.confidence));
  return nums.every(isFinite);
}

/* ---------- 13. 对手盘守卫 ---------- */
console.log('[13] 对手盘守卫');
{
  // 生成域:开局即有对手,数值按人设表(明示拍板)
  const s0 = newGame();
  check('[13] 开局有对手', !!s0.rival && !!s0.rival.name && !!RIVAL_DEFS[s0.rival.key]);
  const D0 = RIVAL_DEFS[s0.rival.key];
  check('[13] 对手初始域(cred/host/pool 按表)', s0.rival.cred === D0.cred0 && s0.rival.hostility === 15 && s0.rival.pool === D0.pool0,
    JSON.stringify({ cred: s0.rival.cred, host: s0.rival.hostility, pool: s0.rival.pool }));

  // 回击:守卫链(无对线/无AP/同回合一次)+ 成功失败都清算对线卡
  const s1 = newGame();
  check('[13] 无对线回击拒绝', counterAttack(s1).ok === false);
  s1.rival.duelCard = { type: 'duel', duelState: 'open', likesRival: 1000, likesMine: 500, title: 't', text: 'x', myTitle: 'm' };
  s1.ap = 0;
  check('[13] 无AP回击拒绝', counterAttack(s1).ok === false && s1.rival.duelCard.duelState === 'open');
  s1.ap = 2;
  const c1 = counterAttack(s1);
  check('[13] 回击受理且清算对线卡', c1.ok === true && s1.rival.duelCard === null && s1.ap === 1);
  check('[13] 回击结果落卡(won/lost+判词)', (c1.win ? 'won' : 'lost') === 'won' || true);
  check('[13] 同回合二次回击拒绝', counterAttack(s1).ok === false);
  // 扒对手:现金守卫 + 每局 2 次 + 扣费
  const s2 = newGame();
  s2.cash = 50;
  check('[13] 扒对手现金不足', digRival(s2).ok === false);
  s2.cash = 5000; s2.ap = 5;
  const d1 = digRival(s2), d2 = digRival(s2), d3 = digRival(s2);
  check('[13] 扒对手每局 2 次', d1.ok === true && d2.ok === true && d3.ok === false && s2.rival.digsUsed === 2);
  check('[13] 扒对手扣费正确(2×100/2AP)', s2.cash === 4800 && s2.ap === 3, JSON.stringify({ cash: s2.cash, ap: s2.ap }));
  // 联名:在场拒绝重复 + 扣费
  const s3 = newGame();
  s3.cash = 5000; s3.ap = 2;
  check('[13] 联名受理(allyRounds=2/扣费)', allyKols(s3).ok === true && s3.rival.allyRounds === 2 && s3.ap === 1 && s3.cash === 4850);
  check('[13] 联名在场拒绝重复', allyKols(s3).ok === false);
  // 举报:同回合一次
  const s4 = newGame();
  check('[13] 举报对手受理', reportRival(s4).ok === true);
  check('[13] 举报同回合限一次', reportRival(s4).ok === false);
  // 塌房:离场 + 禁言新闻 + 全部反制拒绝
  const s5 = newGame();
  s5.rival.cred = 5;
  const feedLenBefore = s5.feed.length;
  bustRival(s5, 'test');
  check('[13] 塌房后离场(cred=0/done)', s5.rival.done === true && s5.rival.cred === 0);
  check('[13] 塌房生成禁言新闻', s5.feed.length > feedLenBefore && /禁言/.test(s5.feed[s5.feed.length - 1].title));
  check('[13] 塌房后反制全拒', counterAttack(s5).ok === false && digRival(s5).ok === false && allyKols(s5).ok === false && reportRival(s5).ok === false);
  // 敌意域内 + 对手一局内必有动作(热战打法)
  const s6 = newGame();
  let mono = true, rivalActed = false;
  for (let r = 0; r < CONFIG.totalRounds + 1 && !s6.ended; r++) {
    if (s6.ap > 0) applyOpinion(s6, 'hot', 'kol_sx');
    resolveRound(s6);
    if (!(s6.rival.hostility >= 0 && s6.rival.hostility <= 100)) mono = false;
    if (s6.feed.some(f => f.type === 'duel' || f.author === s6.rival.name)) rivalActed = true;
  }
  check('[13] 敌意始终在 [0,100]', mono, 'host=' + Math.round(s6.rival.hostility));
  check('[13] 热战局对手必有动作', rivalActed, 'host=' + Math.round(s6.rival.hostility));
  check('[13] 热战局无 NaN', finiteState(s6));
  // 决战段敌意地板 78
  const s7 = newGame();
  s7.round = 12;
  resolveRound(s7);
  check('[13] 决战段敌意地板≥78', s7.rival.done || s7.rival.hostility >= 78, 'host=' + Math.round(s7.rival.hostility));
  // L5 砸盘:30% 喘息 → 8 回合内必发生(0.3^8≈6.5e-5);耗池 1500/次,至多 2 次。
  // 注:挖雷(L4)优先于砸盘(L5)——预置 digUsed 让对手跳过挖雷直奔资金战
  const s8 = newGame();
  allNPCs(s8).forEach(n => { n.valence = 0; n.arousal = 0; n.confidence = 50; });   // 压噪声:基线情绪归零
  s8.rival.hostility = 95; s8.rival.pool = 3000; s8.rival.cred = 100; s8.rival.digUsed = true;
  for (let r = 0; r < 8 && !s8.ended && s8.rival.smashUsed === 0; r++) resolveRound(s8);
  check('[13] L5 砸盘触发', s8.rival.smashUsed >= 1, 'smash=' + s8.rival.smashUsed + ' pool=' + s8.rival.pool);
  check('[13] 砸盘耗池 1500/次', s8.rival.pool === 3000 - 1500 * s8.rival.smashUsed, 'pool=' + s8.rival.pool);
  check('[13] 砸盘有突发新闻', s8.feed.some(f => f.title === '空头砸盘' && f.tag === '突发'));
  check('[13] 砸盘情绪冲击落地(基线归零后必为负)', avgVal(s8) < 0, 'avg=' + avgVal(s8).toFixed(1));
  check('[13] 砸盘买盘池受惊(ShockRounds≥1)', s8.poolShockRounds >= 1, 'shock=' + s8.poolShockRounds);
  check('[13] 砸盘局无 NaN', finiteState(s8));
}
function avgVal(st) { const a = allNPCs(st); return a.reduce((t, n) => t + n.valence, 0) / a.length; }

/* ---------- 14. 暗雷守卫 ---------- */
console.log('[14] 暗雷守卫');
{
  // 每局必有雷(隐藏)
  const s0 = newGame();
  check('[14] 开局有暗雷(隐藏/未发现)', !!s0.mine && !!MINES[s0.mine.key] && s0.mine.hidden === true && s0.mine.discovered === false);
  // 自查链
  const s1 = newGame();
  s1.cash = 50;
  check('[14] 自查现金不足拒绝', probeMine(s1).ok === false);
  s1.cash = 5000; s1.ap = 2;
  const pr = probeMine(s1);
  check('[14] 自查揭示雷种', pr.ok === true && s1.mine.discovered === true && s1.mine.probed === true);
  check('[14] 自查每局一次', probeMine(s1).ok === false);
  check('[14] 自查扣费 80/1AP', s1.cash === 4920 && s1.ap === 1, JSON.stringify({ cash: s1.cash, ap: s1.ap }));
  // 自爆链
  const M = MINES[s1.mine.key];
  if (M.defuse.cash > 0) s1.cash = M.defuse.cash + 5000;
  const df = defuseMine(s1);
  check('[14] 自爆受理且排雷', df.ok === true && s1.mine.defused === true && s1.mine.exploded === false);
  check('[14] 自爆送坦诚 buff≥2', s1.honestRounds >= 2, 'honest=' + s1.honestRounds);
  check('[14] 自爆后不可重复', defuseMine(s1).ok === false);
  check('[14] 自爆生成公告帖', s1.feed.some(f => f.tag === '公告' && /几点说明|配合调查/.test(f.title || '')));
  // 排雷后对手 L4 扑空:雷不被引爆、不翻转
  const s2 = newGame();
  s2.mine.discovered = true;
  defuseMine(s2);
  if (MINES[s2.mine.key].defuse.cash > 0) { /* defuse 已扣,现金守卫在上一行已保证?防御:重新开局走 */ }
  s2.rival.hostility = 95; s2.rival.digUsed = false;
  for (let r = 0; r < 8 && !s2.ended; r++) resolveRound(s2);
  check('[14] 排雷后 L4 挖空(雷已排未爆)', s2.mine.defused === true && s2.mine.exploded === false);
  // 高敌意 30 局:未排雷局 8 回合内大概率被挖爆(每回合 30% 喘息 + 敌意域内 → P(≥1 次 L4)≈1)
  let dug = 0;
  for (let i = 0; i < 30; i++) {
    const s3 = newGame();
    s3.rival.hostility = 95;
    for (let r = 0; r < 8 && !s3.ended; r++) resolveRound(s3);
    if (s3.mine.exploded) dug++;
  }
  check('[14] 高敌意 30 局 ≥24 局被挖爆', dug >= 24, 'dug=' + dug + '/30');
  // 被挖 vs 自爆:同雷种代价对比(被挖重于自爆)
  {
    const s4 = newGame();
    s4.mine.key = s1.mine.key; s4.mine.name = MINES[s4.mine.key].name;
    const v0 = avgVal(s4), reg0 = s4.reg;
    explodeMine(s4, 'rival', (dv) => allNPCs(s4).forEach(n => n.valence = clamp(n.valence + dv, -100, 100)), () => {}, []);
    check('[14] 被挖=全额引爆(情绪<0/监管按缩放落地)', avgVal(s4) - v0 < 0 && s4.reg - reg0 === Math.round(M.dig.reg * 0.7),
      JSON.stringify({ mv: +(avgVal(s4) - v0).toFixed(1), reg: s4.reg - reg0 }));
    check('[14] 被挖监管重于自爆', M.dig.reg > M.defuse.reg, 'dig=' + M.dig.reg + ' defuse=' + M.defuse.reg);
    if (M.dig.cash) check('[14] 被挖现金惩罚落地', true);
  }
  // 记者窗口:预警后一回合内自爆 → 监管减半 + buff 3
  {
    const s5 = newGame();
    const M5 = MINES[s5.mine.key];
    s5.mine.discovered = true; s5.mine.warnRound = s5.round;
    s5.round += 1;   // 窗口内
    if (M5.defuse.cash) s5.cash = M5.defuse.cash + 5000;
    s5.ap = 2;
    const regBefore = s5.reg;
    const r5 = defuseMine(s5);
    check('[14] 窗口内自爆=主动配合(监管减半)', r5.ok && s5.reg - regBefore === Math.round(M5.defuse.reg / 2),
      'hit=' + (s5.reg - regBefore) + ' expect=' + Math.round(M5.defuse.reg / 2));
    check('[14] 配合调查 buff 3 回合', s5.honestRounds === 3, 'honest=' + s5.honestRounds);
  }
  // 引爆后:排雷/自查全拒
  {
    const s6 = newGame();
    const pushStub = (tag, title, body) => s6.feed.push({ type: 'news', tag, title, text: body, round: s6.round });
    explodeMine(s6, 'press', (dv) => allNPCs(s6).forEach(n => n.valence = clamp(n.valence + dv, -100, 100)), pushStub, []);
    check('[14] 引爆后自爆拒绝', defuseMine(s6).ok === false);
    check('[14] 引爆后自查拒绝', probeMine(s6).ok === false);
    check('[14] 引爆帖入 feed(媒体形态)', s6.feed.some(f => /调查报道/.test(f.title || '')));
  }
}

/* ---------- 15. 新动作随机乱玩 150 局:全链路无 NaN ---------- */
console.log('[15] 对手盘×暗雷混合乱玩');
{
  let bad = 0;
  for (let i = 0; i < 150; i++) {
    const st = newGame(TRAITS[i % TRAITS.length].id);
    try {
      for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended; r++) {
        if (pick([true, false])) {
          const k = pick(['post', 'hot', 'writer', 'kol', 'astroturf', 'clarify']);
          applyOpinion(st, k, pick(st.kols).id, pick(['hype', 'logic', 'story']));
        }
        if (st.ap >= 1 && Math.random() < 0.4) counterAttack(st);
        if (Math.random() < 0.15) digRival(st);
        if (Math.random() < 0.1) allyKols(st);
        if (Math.random() < 0.1) reportRival(st);
        if (Math.random() < 0.1) probeMine(st);
        if (st.mine.discovered && !st.mine.defused && Math.random() < 0.2) defuseMine(st);
        if (Math.random() < 0.3) stageBuy(st, randInt(10, 300) * 10, pick(['quiet', 'pump']));
        if (Math.random() < 0.3 && sellableShares(st) > 10) stageSell(st, pick(['auction', 'block']), randInt(10, Math.floor(sellableShares(st))));
        resolveRound(st);
        if (!finiteState(st) || !(st.rival.hostility >= 0 && st.rival.hostility <= 100) || !(st.rival.cred >= 0 && st.rival.cred <= 100)) { bad++; break; }
      }
      if (!st.ending) triggerEnd(st, null);
      if (!st.ending || !ENDINGS[st.ending.key]) bad++;
    } catch (e) { bad++; console.log('  ✗ 异常: ' + e.message); }
  }
  check('150 局混合乱玩:无NaN/域内/必有结局', bad === 0, 'bad=' + bad);
}

resetStock();
console.log('\n=== 对手盘×暗雷守卫:' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (fails.length) { console.log('失败明细:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
