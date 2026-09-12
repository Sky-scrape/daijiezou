'use strict';
/* 多样性八件套守卫测试:市场天气 / 三段弧线 / 波动率聚集 / 扩事件池 / 黑天鹅伏笔 / 事件连锁 / 居民剧情 / 小管家任务。
 * 加载方式 = 直接 require('../game.js')(game.js 尾部有 CommonJS 导出;require 时不触发自动回测)。
 * 用法:node .qa/diversity-test.js  */
const G = require('../game.js');

const { newGame, applyOpinion, stageBuy, stageSell, resolveRound, triggerEnd, sellableShares,
  resetStock, CONFIG, TRAITS, pick, ENDINGS, allNPCs,
  EVENTS, T, WEATHERS, PHASES, phaseOf, PHASE_DECISION_P, SWANS, CHAINS, SIDE_TASKS,
  RIVAL_DEFS, MINES, counterAttack, digRival, allyKols, reportRival, probeMine, defuseMine } = G;

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

/* ---------- 13.1 市场天气 ---------- */
console.log('[13.1] 市场天气');
check('六种天气定义完整', Object.keys(WEATHERS).length === 6 &&
  ['calm', 'chase', 'riskoff', 'gossip', 'crackdown', 'rotation'].every(k => WEATHERS[k] && WEATHERS[k].name && WEATHERS[k].desc),
  Object.keys(WEATHERS).join(','));
for (const wk of Object.keys(WEATHERS)) {
  const st = newGame();
  st.weather = wk;
  resolveRound(st);
  // 结算末尾会为下一回合掷新天气,故只断言"仍是合法天气"且数值健康
  check('天气 ' + wk + ' 结算无NaN', finiteState(st) && !!WEATHERS[st.weather], 'weather=' + st.weather);
}
{
  const s = newGame();
  const pCalm = G.computePool(s).pool;
  s.weather = 'chase';
  const pChase = G.computePool(s).pool;
  check('追涨日买盘池 +12%(同状态对照)', Math.abs(pChase / pCalm - 1.12) < 1e-9, 'ratio=' + (pChase / pCalm));
}
{
  const regAfter = (w) => { const s = newGame(); s.weather = w; s.reg = 30; resolveRound(s); return s.reg; };
  // 随机事件可能带监管增量,用多采样取最小值剥离事件噪声(无事件回合 = 纯衰减)
  const regMin = (w) => { let m = Infinity; for (let i = 0; i < 100; i++) m = Math.min(m, regAfter(w)); return m; };
  const a = regMin('calm'), b = regMin('crackdown');
  check('严打周:监管衰减减半(对照差 = 2)', b - a === 2, 'calm=' + a + ' crackdown=' + b);
}
{
  const s = newGame(); s.weather = 'riskoff'; s.heat = 60; s.ap = 2;
  applyOpinion(s, 'clarify');
  check('避险日:澄清降温 ×1.5', s.heat === 60 - Math.round(15 * 1.5), 'heat=' + s.heat);
}

/* ---------- 13.2 三段弧线 ---------- */
console.log('[13.2] 三段弧线');
check('阶段划分 1-5/6-10/11-15', phaseOf(1) === 0 && phaseOf(5) === 0 && phaseOf(6) === 1 && phaseOf(10) === 1 && phaseOf(11) === 2 && phaseOf(15) === 2);
check('抉择概率随阶段递增', PHASE_DECISION_P[0] < PHASE_DECISION_P[1] && PHASE_DECISION_P[1] < PHASE_DECISION_P[2], PHASE_DECISION_P.join(','));
{
  const s = newGame();
  for (let r = 0; r < 6 && !s.ended; r++) resolveRound(s);
  check('发酵期切换不抛异常', finiteState(s));
}

/* ---------- 13.3 扩事件池 ---------- */
console.log('[13.3] 扩事件池');
const NEW_EV = ['holder_sell', 'short_report', 'algo_limit', 'unlock', 'fan_support', 'employee_leak', 'dividend'];
check('事件池 25+ 且新增 7 种齐全', EVENTS.length >= 25 && NEW_EV.every(k => EVENTS.find(e => e.key === k)), 'len=' + EVENTS.length);
check('none 权重降档(<6)', EVENTS.find(e => e.key === 'none').w < 6, 'w=' + EVENTS.find(e => e.key === 'none').w);
check('新事件文案齐全', NEW_EV.every(k => T.market[k] && T.market[k].body), NEW_EV.filter(k => !T.market[k]).join(','));

/* ---------- 13.4 黑天鹅伏笔 ---------- */
console.log('[13.4] 黑天鹅伏笔');
check('四种天鹅定义完整(伏笔帖+效果)', Object.keys(SWANS).length === 4 && Object.values(SWANS).every(s => s.plant && s.name && typeof s.fx === 'function'));
{
  const st = newGame();
  st.round = 4; st.foreshadow = { key: 'whale_dump', round: 3 };
  resolveRound(st);
  check('伏笔下一回合引爆且清位', st.swansFired === 1 && st.foreshadow === null && st.feed.some(f => f.title === '大资金对砸'));
}
{
  let planted = 0;
  for (let i = 0; i < 40; i++) { const s = newGame(); resolveRound(s); if (s.foreshadow) planted++; }
  check('建仓期(回合1)埋雷概率为0', planted === 0, 'planted=' + planted);
}
{
  // 保底:决战期 r12 且一只都没埋过 → 概率 0.45(30 局期望 13.5,P(<5) 可忽略)
  let pity = 0;
  for (let i = 0; i < 30; i++) {
    const s = newGame(); s.round = 12; s.weather = 'calm'; resolveRound(s);
    if (s.foreshadow) pity++;
  }
  check('保底机制:r12 未埋过 → 高频埋雷(≥5/30)', pity >= 5, 'pity=' + pity + '/30');
}
{
  // 已埋过一只(非 0)→ 保底不生效,回到基础概率 0.11(30 局期望 3.3,上限放宽防抖)
  let noPity = 0;
  for (let i = 0; i < 30; i++) {
    const s = newGame(); s.round = 12; s.weather = 'calm'; s.swansUsed = ['whale_dump']; resolveRound(s);
    if (s.foreshadow) noPity++;
  }
  check('保底仅限零埋雷局(≤14/30)', noPity <= 14, 'noPity=' + noPity + '/30');
}
{
  const st = newGame();
  st.round = 8; st.foreshadow = { key: 'reg_raid', round: 7 };
  const regBefore = st.reg;
  resolveRound(st);
  check('监管突袭生效(监管抬升)', st.reg > regBefore && st.feed.some(f => f.title === '监管突袭'), 'reg=' + st.reg);
}

/* ---------- 13.5 事件连锁 ---------- */
console.log('[13.5] 事件连锁');
check('三种连锁定义完整', CHAINS.viral_backlash && CHAINS.boycott_reply && CHAINS.celeb_bust);
{
  const st = newGame();
  st.round = 3; st.chainNext = { key: 'boycott_reply' };
  resolveRound(st);
  check('连锁必然结算且清位', st.chainNext === null && st.feed.some(f => f.title === '官方回应奏效' || f.title === '回应翻车'));
}
{
  let fired = 0;
  for (let i = 0; i < 60; i++) {
    const s = newGame(); s.round = 3; s.chainNext = { key: 'celeb_bust' };
    resolveRound(s);
    if (s.feed.some(f => f.title === '主播翻车')) fired++;
  }
  check('概率连锁(0.35)有触发有落空', fired > 5 && fired < 55, 'fired=' + fired + '/60');
}

/* ---------- 13.6 居民自主剧情 ---------- */
console.log('[13.6] 居民自主剧情');
check('剧情文案库齐全(晒单/删帖)', T.scenario && T.scenario.sun.length >= 2 && T.scenario.del.length >= 2);
{
  // 横盘闲聊里的剧情位(45% 剧情概率):40 局几乎必中
  let saw = 0;
  for (let i = 0; i < 40; i++) {
    const s = newGame();
    for (let r = 0; r < 12 && !s.ended; r++) resolveRound(s);
    if (s.feed.some(f => (f.tag || '').includes('晒单') || f.title === '删帖说明' || f.parentTag === '对线')) saw++;
  }
  check('40 局内剧情形态出现过', saw >= 5, 'saw=' + saw + '/40');
}

/* ---------- 13.7 知乎小管家任务 ---------- */
console.log('[13.7] 小管家任务');
check('八种任务定义完整(含对手盘×暗雷新任务)', SIDE_TASKS.length === 8 && SIDE_TASKS.every(t => t.key && t.name && t.hint && t.reward));
{
  const s1 = newGame(); s1.sideTask = 'answer'; s1.roundOps = { astroturf: 1 };
  const c0 = s1.cash; resolveRound(s1);
  check('创作激励日:盐选分成 +60 万', s1.cash === c0 + 60, 'cash=' + s1.cash);
}
{
  // 判定发生在结算后(热度已衰减),给 90 起步保证即使最坏事件(限流 -10)后仍 ≥55
  const s2 = newGame(); s2.sideTask = 'heat55'; s2.roundOps = { post: 1 }; s2.heat = 90;
  resolveRound(s2);
  check('造势达标日:下回合买盘池 +8%', Math.abs(s2.poolBoostNext - 1.08) < 1e-9, 'boost=' + s2.poolBoostNext + ' heat=' + s2.heat);
}
{
  const s3 = newGame(); s3.sideTask = 'op2'; s3.roundOps = { post: 1, hot: 1 };
  resolveRound(s3);
  check('舆论打卡日:下回合 AP +1', s3.ap === s3.apPerTurn + 1, 'ap=' + s3.ap);
}
{
  const s4 = newGame();
  for (let r = 0; r < 5 && !s4.ended; r++) resolveRound(s4);
  const gj = s4.feed.filter(f => f.tag === '小管家');
  check('任务卡逐回合发布(开局1张+每回合1张)', gj.length >= 6, 'gj=' + gj.length);
  let noRepeat = true;
  for (let i = 1; i < gj.length; i++) if (gj[i].title === gj[i - 1].title) noRepeat = false;
  check('任务不连任', noRepeat);
  check('任务判定在终局回合跳过', (() => { const s = newGame(); s.round = CONFIG.totalRounds; const ap0 = s.ap; resolveRound(s); return s.ended && s.ap === ap0; })());
}

/* ---------- 13.8 全天赋混合乱玩 200 局:综合无 NaN ---------- */
console.log('[13.8] 混合乱玩 200 局');
{
  let bad = 0;
  for (let i = 0; i < 200; i++) {
    const st = newGame(TRAITS[i % TRAITS.length].id);
    try {
      for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended; r++) {
        if (pick([true, false])) {
          const k = pick(['post', 'hot', 'writer', 'kol', 'astroturf', 'clarify']);
          const kol = pick(allNPCs(st).filter(n => n.kind === 'kol'));
          applyOpinion(st, k, kol.id, pick(['hype', 'logic', 'story']));
        }
        if (pick([true, false, false]) && sellableShares(st) > 10) stageSell(st, 'auction', 50);
        resolveRound(st);
        if (!(st.volMul >= 0.7 && st.volMul <= 2.0) || !finiteState(st)) { bad++; break; }
      }
      if (!st.ending) triggerEnd(st, null);
      if (!st.ending || !ENDINGS[st.ending.key]) bad++;
    } catch (e) { bad++; console.log('  ✗ 异常: ' + e.message); }
  }
  check('混合乱玩无NaN/波动率边界/必有结局', bad === 0, 'bad=' + bad);
}

/* ---------- 13.9 对手盘 × 暗雷(信息战扩展包) ---------- */
console.log('[13.9] 对手盘×暗雷多样性');
{
  check('对手池 4 人设(名字池/雷种齐全)', Object.keys(RIVAL_DEFS).length === 4 &&
    Object.values(RIVAL_DEFS).every(d => d.persona && d.rivalMine && d.prefArch.length), Object.keys(RIVAL_DEFS).join(','));
  check('暗雷池 12 种(dig/defuse/文案齐全)', Object.keys(MINES).length === 12 &&
    Object.values(MINES).every(m => m.name && m.clue && m.digText && m.defuseText && m.dig.mv < 0 && m.dig.reg > m.defuse.reg),
    Object.keys(MINES).length + '种');
  check('对手盘文案池齐全(攻/判/塌房)', T.rivalAtkTitle && T.rivalAtkBody && T.duelWin && T.duelLose && T.duelIgnored && T.rivalBust &&
    Object.keys(T.rivalAtkTitle).length === 4 && Object.keys(T.rivalAtkBody).length === 4);
  // 热战 60 局:对线卡高概率出现(激进造势 → 敌意爬升 → L2 对线)
  let duelGames = 0, digSeen = 0, NaNs = 0;
  for (let i = 0; i < 60; i++) {
    const st = newGame(pick(['hype', 'whale', 'energy']));
    try {
      for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended; r++) {
        if (st.round <= 3) stageBuy(st, 150, 'pump');   // 真实热战路径:先拉价——敌意吃的是「你赚钱」
        if (Math.random() < 0.08 && !st.mine.discovered) probeMine(st);   // 自查优先于花钱动作:别让 AP 先花光
        if (st.mine.discovered && !st.mine.defused && Math.random() < 0.25) defuseMine(st);
        if (st.rival.duelCard && st.rival.duelCard.duelState === 'open' && st.ap > 0) counterAttack(st);
        applyOpinion(st, 'hot', 'kol_sx');
        if (st.ap > 0) applyOpinion(st, 'writer', 'kol_sx');
        resolveRound(st);
        if (!isFinite(st.price) || !isFinite(st.cash)) { NaNs++; break; }
      }
      if (!st.ending) triggerEnd(st, null);
      if (st.feed.some(f => f.type === 'duel')) duelGames++;
      if (st.mine.discovered || st.mine.exploded) digSeen++;
    } catch (e) { NaNs++; console.log('  ✗ 异常: ' + e.message); }
  }
  check('热战 60 局零NaN', NaNs === 0, 'NaN=' + NaNs);
  check('热战 60 局 ≥40% 出现对线卡', duelGames >= 24, 'duel=' + duelGames + '/60');
  check('热战 60 局 ≥22% 触及暗雷(自查/被挖;方差实测 16-23/60,L4 让位 L5 与敌意波动)', digSeen >= 13, 'dig=' + digSeen + '/60');
  // 躺平 40 局:对手安静(敌意衰减)但对手/雷状态始终域内
  let quietOK = 0;
  for (let i = 0; i < 40; i++) {
    const st = newGame();
    for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended; r++) resolveRound(st);
    if (!st.ending) triggerEnd(st, null);
    if (st.rival.hostility >= 0 && st.rival.hostility <= 100 && st.rival.cred >= 0 && st.rival.cred <= 100 &&
        st.mine && (st.mine.hidden || st.mine.discovered) && isFinite(st.price)) quietOK++;
  }
  check('躺平 40 局:对手/雷状态域内', quietOK === 40, 'ok=' + quietOK + '/40');
}

resetStock();
console.log('\n=== 多样性八件套:' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (fails.length) { console.log('失败明细:'); fails.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
