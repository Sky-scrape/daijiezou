'use strict';
/* 临时边界压力测试(不入库):加载 game.js 引擎后直击标准回测覆盖不到的路径。
 * 用法:node .qa/stress-test.js  */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
const G = new Function(src + `; return {
  newGame, applyOpinion, stageBuy, stageSell, resolveRound, triggerEnd,
  computePool, sellableShares, totalShares, useWash, useExit, useSupport,
  pacifyResident, intelResident, validateCustomStock, applyCustomStock, resetStock,
  deriveCompanyTraits, DECISIONS, AI_EVENT_EFFECTS, CONFIG, STOCK, TRAITS,
  pick, randInt, clamp, ENDINGS, allNPCs, BUY_MODES, CHANNELS, OPINION_ACTIONS, ARCHETYPES,
};`)();

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
const { newGame, applyOpinion, stageBuy, stageSell, resolveRound, triggerEnd, computePool,
  sellableShares, totalShares, useWash, useExit, pacifyResident, intelResident,
  validateCustomStock, applyCustomStock, resetStock, deriveCompanyTraits, STOCK,
  DECISIONS, AI_EVENT_EFFECTS, CONFIG, TRAITS, pick, randInt, clamp, ENDINGS, allNPCs, ARCHETYPES, useSupport } = G;

/* ---------- 1. 全天赋 × 随机乱玩 500 局:不抛异常 / 无 NaN / 必有结局 ---------- */
console.log('[1] 全天赋随机乱玩 500 局');
for (let i = 0; i < 500; i++) {
  const trait = TRAITS[i % TRAITS.length].id;
  const st = newGame(trait);
  try {
    for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended; r++) {
      // 随机舆论动作(带现金约束,与 renderActions 同口径)
      const ops = ['post', 'hot', 'writer', 'kol', 'astroturf', 'clarify'];
      for (let a = 0; a < 2; a++) {
        const k = pick(ops);
        const act = { post: 0, hot: 80, writer: 120, kol: 150, astroturf: 0, clarify: 60 }[k];
        if (st.ap >= 1 && st.cash >= act) applyOpinion(st, k, pick(st.kols).id, pick(['hype', 'logic', 'story']));
      }
      // 随机资金动作
      if (Math.random() < 0.4) stageBuy(st, randInt(10, 800) * 10, pick(['quiet', 'pump', 'ignite']));
      if (Math.random() < 0.4 && sellableShares(st) > 10) stageSell(st, pick(['auction', 'block', 'tail']), randInt(10, Math.floor(sellableShares(st))) );
      if (Math.random() < 0.1 && st.skills.wash) useWash(st);
      if (Math.random() < 0.1 && st.skills.exit && !st.pendingSell) useExit(st);
      if (Math.random() < 0.1 && !st.supportNext) useSupport(st);
      // 随机定向微操
      if (Math.random() < 0.2 && st.retails.length) { if (Math.random() < 0.5) pacifyResident(st, pick(st.retails).id); else intelResident(st, pick(st.retails).id); }
      // 随机决策事件选项(绕过概率直接压入)
      if (Math.random() < 0.3 && !st.pendingDecision) {
        st.pendingDecision = pick(DECISIONS);
        const opt = pick(st.pendingDecision.opts);
        opt.apply(st);
        st.pendingDecision = null;
      }
      resolveRound(st);
      if (!finiteState(st)) { check('乱玩无NaN', false, 'trait=' + trait + ' round=' + st.round); break; }
    }
    if (!st.ending) triggerEnd(st, null);
    check('乱玩必有结局(trait=' + trait + ')', !!st.ending && !!ENDINGS[st.ending.key]);
    check('乱玩无NaN(trait=' + trait + ')', finiteState(st));
  } catch (e) {
    check('乱玩不抛异常', false, 'trait=' + trait + ': ' + e.message);
  }
}

/* ---------- 2. 负现金:免费动作可用 / 付费动作拒绝 / stageBuy 夹紧 ---------- */
console.log('[2] 负现金行为');
{
  const st = newGame();
  st.cash = -500; st.ap = 2;
  check('负现金发帖可用', applyOpinion(st, 'post', null, 'hype').ok === true);
  check('负现金自答可用', applyOpinion(st, 'astroturf').ok === true);
  check('负现金热搜拒绝', applyOpinion(st, 'hot').ok === false);
  check('负现金写手拒绝', applyOpinion(st, 'writer').ok === false);
  check('负现金充值拒绝', applyOpinion(st, 'kol', st.kols[0].id).ok === false);
  check('负现金澄清拒绝', applyOpinion(st, 'clarify').ok === false);
  const got = stageBuy(st, 100, 'quiet');
  check('负现金 stageBuy 夹到 0', got === 0 && st.pendingBuy.amt === 0);
  const r2 = pacifyResident(st, st.retails[0].id);
  check('负现金安抚拒绝', r2.ok === false);
  const r3 = intelResident(st, st.retails[0].id);
  check('负现金情报拒绝', r3.ok === false);
}

/* ---------- 3. 对倒放量:监管溢出保留 + 现金不足拒绝 + 停牌拒绝 ---------- */
console.log('[3] 对倒/脱壳大招');
{
  const st = newGame();
  st.cash = 100; const ok = useWash(st);
  check('现金<800 对倒拒绝', ok.ok === false && st.skills.wash === true);
  const st2 = newGame();
  st2.reg = 95; st2.halted = false;
  useWash(st2);
  check('对倒后 reg 溢出不缩水', st2.reg >= 109, 'reg=' + st2.reg);
  resolveRound(st2);
  check('reg≥100 结算入狱', st2.ended && st2.ending.key === 'prison', st2.ending && st2.ending.key);
  const st3 = newGame();
  st3.pendingSell = { channel: 'auction', amt: 100 };
  const r = useExit(st3);
  check('有卖出挂单时脱壳拒绝', r.ok === false);
}

/* ---------- 4. 挂单:替换语义 + T+1 冻结 + 停牌保留 ---------- */
console.log('[4] 挂单/T+1/停牌');
{
  const st = newGame();
  stageBuy(st, 100, 'quiet');
  const first = st.pendingBuy;
  stageBuy(st, 200, 'ignite');
  check('买入挂单被替换', st.pendingBuy.amt === 200 && st.pendingBuy.mode === 'ignite' && st.pendingBuy !== first);
  stageSell(st, 'auction', 100);
  stageSell(st, 'tail', 50);
  check('卖出挂单被替换', st.pendingSell.channel === 'tail' && st.pendingSell.amt === 50);
  // T+1:同回合买入的 lot 被冻结(st.round 口径)
  const st2 = newGame();
  st2.lots.push({ round: st2.round, shares: 500 });
  check('同回合买入 T+1 冻结', sellableShares(st2) === 3000, 'sellable=' + sellableShares(st2));
  check('持仓含冻结股', totalShares(st2) === 3500, 'total=' + totalShares(st2));
  // quiet 档上限 300:挂 500 只成交 300;下一回合(结算后 round 推进)冻结解除
  st2.cash = 100000;
  stageBuy(st2, 500, 'quiet');
  resolveRound(st2);
  check('买入受档位上限约束', totalShares(st2) === 3800, 'total=' + totalShares(st2));
  check('次回合冻结解除(正确 T+1)', sellableShares(st2) === 3800, 'sellable=' + sellableShares(st2));
  // 停牌:挂单保留不成交
  const st3 = newGame();
  st3.halted = true; st3.haltLeft = 2;
  stageBuy(st3, 100, 'quiet'); stageSell(st3, 'auction', 100);
  resolveRound(st3);
  check('停牌期间挂单不成交', st3.history[0].close === CONFIG.startPrice, 'close=' + st3.history[0].close);
  check('停牌期间挂单保留', !!st3.pendingBuy && !!st3.pendingSell);
  check('停牌结算无 NaN', finiteState(st3));
  // 复牌后自动成交
  const cashBefore = st3.cash;
  resolveRound(st3); // haltLeft 2→1
  resolveRound(st3); // haltLeft 1→0 → 复牌,挂单执行
  check('复牌后挂单自动执行', st3.pendingBuy === null || st3.pendingSell === null || st3.halted, '');
  check('复牌结算无 NaN', finiteState(st3));
}

/* ---------- 5. 全部本地决策事件选项 ×100:不抛异常 / 无 NaN ---------- */
console.log('[5] 决策事件全选项');
for (let i = 0; i < 100; i++) {
  const st = newGame();
  const d = pick(DECISIONS);
  try {
    const opt = pick(d.opts);
    const msg = opt.apply(st);
    check('决策返回文案(' + d.id + ')', typeof msg === 'string' && msg.length > 0, d.id + '/' + opt.label);
    resolveRound(st);
    check('决策后结算无 NaN(' + d.id + ')', finiteState(st));
  } catch (e) { check('决策不抛异常(' + d.id + ')', false, e.message); }
}

/* ---------- 6. AI 事件效果池全应用 ×50 ---------- */
console.log('[6] AI 事件效果池');
{
  const ids = Object.keys(AI_EVENT_EFFECTS);
  check('效果目录≥2', ids.length >= 2);
  for (let i = 0; i < 50; i++) {
    const st = newGame();
    ids.forEach(id => AI_EVENT_EFFECTS[id].apply(st));
    resolveRound(st);
    check('全效果叠加无 NaN', finiteState(st));
    if (!finiteState(st)) break;
  }
}

/* ---------- 7. 自定义标的:校验规则 + 基因推导 ---------- */
console.log('[7] 自定义标的/公司基因');
{
  check('公司名过短', !!validateCustomStock({ name: 'A', code: '880001' }).error);
  check('公司名含禁词', !!validateCustomStock({ name: '某某银行', code: '880001' }).error);
  check('代码非88段', !!validateCustomStock({ name: '白泽智能', code: '600519' }).error);
  check('代码含字母', !!validateCustomStock({ name: '白泽智能', code: '88abcd' }).error);
  check('敏感词拦截', !!validateCustomStock({ name: '白泽智能', code: '880001', topic: '内幕交易工具' }).error);
  check('题材超长', !!validateCustomStock({ name: '白泽智能', code: '880001', topic: 'x'.repeat(21) }).error);
  const vok = validateCustomStock({ name: '白泽智能', code: '880099', topic: '量子加密奶茶', blurb: '融资四轮,估值百亿。' });
  check('合法自定义通过', !vok.error && vok.value && vok.value.code === '880099', JSON.stringify(vok).slice(0, 80));
  // 基因推导:赛道关键词
  check('硬科技基因', deriveCompanyTraits('某某芯片', 'AI 芯片', '').arch === 'hardtech');
  check('生物医药基因', deriveCompanyTraits('某某医药', '基因疗法', '').arch === 'biotech');
  check('民生消费基因', deriveCompanyTraits('某某奶茶', '平价奶茶连锁', '').arch === 'livelihood');
  check('重资产基因', deriveCompanyTraits('某某重工', '工程机械制造', '').arch === 'industrial');
  check('泛娱乐基因', deriveCompanyTraits('某某互娱', '直播电竞平台', '').arch === 'entertain');
  check('综合兜底', deriveCompanyTraits('某某控股', '多元投资', '').arch === 'diversified');
  check('资本故事tone', deriveCompanyTraits('某', '某', '完成三轮融资,估值极高').tone === 'capital');
  check('技术立司tone', deriveCompanyTraits('某', '某', '拥有47项专利,首席科学家带队').tone === 'tech');
  check('超长简介=过度包装', deriveCompanyTraits('某', '某', 'x'.repeat(250)).tone === 'overwrap');
  check('空简介=低调神秘', deriveCompanyTraits('某', '某', '嗯').tone === 'mystery');
  // 应用后引擎实际吃到基因
  const r = applyCustomStock({ name: '测试医药', code: '880001', topic: '基因疗法', blurb: '专利研发' });
  check('applyCustomStock ok', r.ok === true);
  const st = newGame();
  check('STOCK.traits 已生效', STOCK.traits.arch === 'biotech');
  resetStock();
  check('resetStock 恢复默认', STOCK.name === '星阑科技' && STOCK.traits.arch === 'hardtech');
}

/* ---------- 8. 全基因 × 全叙事开局跑完整局 ---------- */
console.log('[8] 基因×叙事 12 组合');
{
  const combos = [
    ['AI 芯片', '融资四轮,估值百亿,独角兽故事'],
    ['AI 芯片', '拥有47项专利,首席博士带队研发'],
    ['平价奶茶连锁', '让每个人喝上美好的奶茶'],
    ['工程机械', 'x'.repeat(260)],
    ['基因疗法', '神秘低调'],
    ['直播电竞', '热闹的赛事与娱乐内容'],
    ['多元投资', ''],
  ];
  for (const [topic, blurb] of combos) {
    applyCustomStock({ name: '测测' + topic.slice(0, 2), code: '880123', topic, blurb });
    const st = newGame('hype');
    for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended; r++) {
      applyOpinion(st, 'hot'); if (st.ap > 0) applyOpinion(st, 'writer');
      if (r >= 8 && sellableShares(st) > 100) stageSell(st, 'auction', sellableShares(st));
      resolveRound(st);
      if (Math.random() < 0.3 && !st.pendingDecision) { st.pendingDecision = pick(DECISIONS); pick(st.pendingDecision.opts).apply(st); st.pendingDecision = null; }
    }
    if (!st.ending) triggerEnd(st, null);
    check('基因组合跑通(' + topic + ')', !!st.ending && finiteState(st), st.ending && st.ending.key);
  }
  resetStock();
}

/* ---------- 9. 极端结算:全部清仓 / 一股不卖 / 停牌到终局 ---------- */
console.log('[9] 极端结局路径');
{
  // 清仓走高价
  let cleanCount = 0, stuckCount = 0, prisonCount = 0;
  for (let i = 0; i < 100; i++) {
    const st = newGame('whale');
    for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended; r++) {
      if (r < 6) { applyOpinion(st, 'hot'); stageBuy(st, 800, 'pump'); }
      else if (st.reg < 50 && r < 10) { applyOpinion(st, 'post'); }
      else if (sellableShares(st) > 0) stageSell(st, 'auction', sellableShares(st));
      resolveRound(st);
    }
    if (!st.ending) triggerEnd(st, null);
    if (st.ending.key === 'clean' || st.ending.key === 'safe') cleanCount++;
    if (st.ending.key === 'stuck' || st.ending.key === 'deep') stuckCount++;
    if (st.ending.key === 'prison') prisonCount++;
    check('whale 局无 NaN', finiteState(st));
  }
  console.log('  whale 抢跑100局 → 干净落袋 ' + cleanCount + ' / 站岗深套 ' + stuckCount + ' / 入狱 ' + prisonCount);
  check('whale 多数能落袋(平衡性参考)', cleanCount >= 40, 'clean=' + cleanCount);
  // 一股不卖
  const st2 = newGame();
  for (let r = 0; r < CONFIG.totalRounds && !st2.ended; r++) resolveRound(st2);
  if (!st2.ending) triggerEnd(st2, null);
  check('躺平=站岗/深套', st2.ending.key === 'stuck' || st2.ending.key === 'deep', st2.ending.key);
  check('躺平无 NaN', finiteState(st2));
}

/* ---------- 10. 停牌期间舆论可用、免费澄清链路 ---------- */
console.log('[10] 停牌中的操作面');
{
  const st = newGame();
  st.halted = true; st.haltLeft = 2; st.reg = 62; st.heat = 40; st.cash = 500;
  const c = applyOpinion(st, 'clarify');
  check('停牌中可澄清', c.ok === true, c.ok ? '' : 'clarify rejected');
  check('澄清给监管降温', st.reg <= 62 - 10 + 4, 'reg=' + st.reg); // -10 + regMul(硬科技1.1→-11? act.reg=-10*1.1=-11)
}

/* ---------- 11. 医美/定制管线回归守卫(20260910 E 项调查结论)----------
 * 变体对照实验结论:医美站岗与赛道数值无关(硬科技克隆/纯中性同站岗)、与 roundCash 无关、
 * 定制管线本身干净(星阑克隆=1% 站岗);真正因子 = 「资本故事」regCool(监管每回合少降1)叠加
 * 无强热基因赛道 → 监管滚得快 → 停牌挤掉出货窗口。数值修复方案待定稿,本节先固化两条守卫:
 * ①定制管线回归(星阑克隆必须与默认局同健康);②医美×叙事历史带(防止未来改动把站岗推得更差)。 */
console.log('[11] 医美/定制管线回归守卫(200 局/组)');
{
  const RUNS = 200;
  const autoPol = (st) => {   // 稳健:吸筹→造势→匀速出货(game.js autoPolicy 同款)
    const s = sellableShares(st);
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
  };
  const runRuns = (runs) => {
    const tally = {};
    let NaNs = 0;
    for (let i = 0; i < runs; i++) {
      const st = newGame();
      for (let rr = 1; rr <= CONFIG.totalRounds + 1 && !st.ended; rr++) {
        const plan = autoPol(st);
        for (const op of plan.acts) applyOpinion(st, op, 'kol_sx');
        if (plan.buy) stageBuy(st, plan.buy.amt, plan.buy.mode);
        if (plan.sell) stageSell(st, plan.sell.channel, plan.sell.amt);
        resolveRound(st);
        if (!isFinite(st.price) || !isFinite(st.cash)) { NaNs++; break; }
      }
      if (!st.ending) triggerEnd(st, null);
      tally[st.ending.key] = (tally[st.ending.key] || 0) + 1;
    }
    return { tally, NaNs };
  };
  const pctOf = (t, k, runs) => Math.round((t[k] || 0) / runs * 100);
  // ① 默认局锚点
  resetStock();
  const rk = runRuns(RUNS);
  check('[11] 默认局 零NaN', rk.NaNs === 0, 'NaN=' + rk.NaNs);
  // 20260913a 重校:对手盘×暗雷层落地后,稳健策略不吃新系统红利(不回击/不排雷),
  // 好结局新基线 83-84%(78-85 目标带内,用户拍板);20260913b 多局方差实测 78-84(200 局组 ±3pp),
  // 80 阈值间歇误报 → 校到 78(留噪声余量,仍拦"掉出目标带"的真回归)
  check('[11] 默认局 稳健好结局≥78%(20260913b 方差重校)', pctOf(rk.tally, 'clean', RUNS) + pctOf(rk.tally, 'safe', RUNS) >= 78, 'good=' + (pctOf(rk.tally, 'clean', RUNS) + pctOf(rk.tally, 'safe', RUNS)) + '%');
  // ② 定制管线守卫:默认星阑基因走 applyCustomStock,结果必须与默认局同健康
  const rl = (() => { const r = applyCustomStock({ name: '星阑科技', code: '888217', topic: 'AI伴侣与情感计算产品', blurb: '成立三年,融资四轮,估值翻倍,创始人技术出身。' }); return r.error ? null : runRuns(RUNS); })();
  check('[11] 星阑克隆(定制管线)零NaN', rl && rl.NaNs === 0, 'NaN=' + (rl && rl.NaNs));
  // 站岗:对手盘层把星阑 stuck 基线从 5-8 抬到 8-11(20260913b 方差实测),8 阈值间歇误报 → 12
  check('[11] 星阑克隆 站岗≤12%(20260913b 方差重校)', pctOf(rl.tally, 'stuck', RUNS) <= 12, 'stuck=' + pctOf(rl.tally, 'stuck', RUNS) + '%');
  // good 新基线 78-84(20260913a 落对手盘层 + 20260913b 方差实测),原 88
  check('[11] 星阑克隆 好结局≥78%(20260913b 方差重校)', pctOf(rl.tally, 'clean', RUNS) + pctOf(rl.tally, 'safe', RUNS) >= 78, 'good=' + (pctOf(rl.tally, 'clean', RUNS) + pctOf(rl.tally, 'safe', RUNS)) + '%');
  // ③ 医美×神秘 历史带(9/8 记录 20% 站档 → 天气/黑天鹅层 46% → 20260913a 对手盘×暗雷复合抬升,
  //    实测均值 ~51-56%:最弱赛道×信息战双压力层的已知最差组合,带宽校到 62% 继续拦"更差"的回归)
  applyCustomStock({ name: '某某医美', code: '881234', topic: '医美连锁与抗衰护肤', blurb: '公司核心技术路线一直低调神秘,极少接受采访。' });
  const rb = runRuns(RUNS);
  check('[11] 医美×神秘 零NaN', rb.NaNs === 0, 'NaN=' + rb.NaNs);
  check('[11] 医美×神秘 站岗≤62%(20260913a/b 对手盘层重校:由 46 上调)', pctOf(rb.tally, 'stuck', RUNS) <= 62, 'stuck=' + pctOf(rb.tally, 'stuck', RUNS) + '%');
  resetStock();
}

/* [12] 护盘托底守卫:资金侧唯一防守动作——边界拦截 + 减半/免跌停语义 + 状态位回收 */
{
  console.log('[12] 护盘托底守卫(边界 + 对局结算)');
  const s1 = newGame(); s1.cash = 1000; s1.reg = 10;
  const r1 = useSupport(s1);
  check('[12] 挂单成功:现金-400/状态位/监管+3', r1.ok && s1.supportNext === true && s1.cash === 600 && s1.reg === 13, JSON.stringify({ cash: s1.cash, reg: s1.reg }));
  const r2 = useSupport(s1);
  check('[12] 不可叠加拦截', !r2.ok && s1.supportNext === true && s1.cash === 600, r2.msg);
  const r3 = useSupport(Object.assign(newGame(), { halted: true, cash: 1000 }));
  check('[12] 停牌拦截', !r3.ok, r3.msg);
  const r4 = useSupport(Object.assign(newGame(), { cash: 100 }));
  check('[12] 现金不足拦截', !r4.ok, r4.msg);
  // 减半语义:居民全部归零(消除随机卖压),同参数大卖单对局——有托单局必须免于跌停且跌幅不高于控制局一半+封底
  const mk = (support) => {
    const s = newGame();
    s.price = 5.00; s.heat = 50; s.cash = 2000; s.ap = 3; s.round = 1;
    allNPCs(s).forEach(n => { n.valence = 0; n.arousal = 0; n.confidence = 50; });
    stageSell(s, 'auction', 2500);
    if (support) useSupport(s);
    resolveRound(s);
    return s;
  };
  const ctl = mk(false), sup = mk(true);
  const pctC = (ctl.history.at(-1).pct), pctS = (sup.history.at(-1).pct);
  check('[12] 控制局 大卖单触发跌停(pct=-10)', pctC === -10, 'pct=' + pctC);
  check('[12] 托单局 免于跌停(-7<pct≤-5)', pctS > -7 && pctS <= -5, 'pct=' + pctS);
  check('[12] 托单局 价格高于控制局', sup.price > ctl.price, 'sup=' + sup.price.toFixed(2) + ' ctl=' + ctl.price.toFixed(2));
  check('[12] 结算后状态位回收', sup.supportNext === false && ctl.supportNext === false, 'sup=' + sup.supportNext);
  resetStock();
}

console.log('\\n=== 结果:' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (fails.length) { console.log('失败明细:'); fails.slice(0, 30).forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
