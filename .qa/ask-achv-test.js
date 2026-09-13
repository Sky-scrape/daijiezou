'use strict';
/* 知友提问·回答即押注 + 成就徽章 守卫测试(走 require,动机见 rival-mine-test.js 头注)。
 * 运行方式与其他 .qa 用例相同(终端里跑该文件);随机源用确定性 LCG,便于复现。 */
const G = require('../game.js');

const { newGame, applyOpinion, resolveRound, triggerEnd, answerAsk, spawnAsk,
  evaluateAchievements, ACHIEVEMENTS, CONFIG, pick, clamp, allNPCs } = G;

let seed = 20260913;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function coin(p) { return rnd() < p; }

let pass = 0, fail = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; fails.push(name + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}

/* ---------- [A] 开局:第 1 回合固定一张提问卡 ---------- */
console.log('[A] 开局提问卡');
{
  const st = newGame();
  const cards = st.feed.filter(f => f.type === 'askq');
  check('开局恰 1 张提问卡', cards.length === 1, 'n=' + cards.length);
  const q = cards[0];
  check('卡挂到 askPending', st.askPending === q);
  check('状态 open / 回合 1', q.state === 'open' && q.round === 1, q.state + '/' + q.round);
  check('提问人来自居民', st.retails.some(n => n.name === q.asker), q.asker);
  check('askStats 归零', JSON.stringify(st.askStats) === JSON.stringify({ win: 0, lose: 0, joke: 0, flat: 0, streak: 0, bestStreak: 0 }), JSON.stringify(st.askStats));
  check('峰值基线=初始值', st.cashPeak === st.cash && st.heatPeak === st.heat);
}

/* ---------- [B] 回答守卫 ---------- */
console.log('[B] 回答守卫');
{
  const st = newGame();
  check('无效选项拒绝', answerAsk(st, 'allin').ok === false);
  st.ap = 0;
  const rb = answerAsk(st, 'long');
  check('押注免费:0 AP 也能押且不扣', rb.ok === true && st.ap === 0 && st.askPending.state === 'bet' && st.askPending.choice === 'long');
  check('重复回答拒绝', answerAsk(st, 'short').ok === false && answerAsk(st, 'joke').ok === false);
  st.askPending = null;
  const q2 = spawnAsk(st, 1);
  const vBefore = {};
  allNPCs(st).forEach(n => { vBefore[n.name] = n.valence; });
  const heat0 = st.heat;
  const rj = answerAsk(st, 'joke');
  const crowdOk = allNPCs(st).every(n => n.valence === clamp(n.name === q2.asker ? vBefore[n.name] - 6 : vBefore[n.name] - 2, -100, 100));
  check('抖机灵不耗 AP', rj.ok === true && st.ap === 0);
  check('抖机灵立即落判', q2.state === 'done' && q2.result === 'joke' && !!q2.verdict && st.askStats.joke === 1);
  check('抖机灵热度 +3', st.heat === clamp(heat0 + 3, 0, 100), 'heat=' + st.heat + '/基线' + heat0);
  check('抖机灵情绪代价:全场-2,提问者-6', crowdOk);
  check('提问者当场吐槽入 feed', st.feed.some(f => f.type === 'comment' && f.author === q2.asker && /就这\?/.test(f.text)));
  check('无卡可答拒绝', answerAsk(st, 'long').ok === false);
  const q3 = spawnAsk(st, 1);
  st.ended = true;
  check('终局拒绝回答', answerAsk(st, 'long').ok === false && answerAsk(st, 'joke').ok === false);
  st.ended = false;
  st.askPending = q3; q3.state = 'open';
}

/* ---------- [C] 结算不变式:押注方向 × 收盘 pct(60 回合扫描) ---------- */
console.log('[C] 押注结算不变式');
{
  let checked = 0, sawWin = 0, sawLose = 0;
  for (let i = 0; i < 60; i++) {
    const st = newGame();
    st.ap = 9;
    const choice = coin(0.5) ? 'long' : 'short';
    answerAsk(st, choice);
    resolveRound(st);
    const q = st.feed.find(f => f.type === 'askq');
    const h = st.history[st.history.length - 1];
    const pct = h.pct, dir = st.halted ? 0 : Math.sign(pct);
    const expect = dir === 0 ? 'flat' : ((choice === 'long') === (dir > 0) ? 'win' : 'lose');
    check('判定与方向一致(#' + i + ')', q.result === expect, 'choice=' + choice + ' pct=' + pct + ' got=' + q.result);
    check('旧卡已清算,askPending 指向新回合卡(#' + i + ')',
      st.askPending === null || (st.askPending !== q && st.askPending.round === st.round && st.askPending.state === 'open'),
      st.askPending ? 'round=' + st.askPending.round + '/' + st.round : 'null');
    const a = st.askStats;
    check('统计守恒(#' + i + ')', a.win + a.lose + a.flat + a.joke === 1, JSON.stringify(a));
    if (expect === 'win') sawWin++; else if (expect === 'lose') sawLose++;
    resolveRound(st);
    const open = st.feed.filter(f => f.type === 'askq' && f.state === 'open').length;
    check('至多 1 张悬置卡(#' + i + ')', open <= 1, 'open=' + open);
    checked++;
  }
  check('60 回合扫描完成', checked === 60);
  check('胜负两态都出现过', sawWin > 0 && sawLose > 0, 'win=' + sawWin + ' lose=' + sawLose);
}

/* ---------- [D] 沉帖 / 停牌平局 ---------- */
console.log('[D] 沉帖与平局');
{
  const st = newGame();
  resolveRound(st);
  const q = st.feed.find(f => f.type === 'askq');
  check('未回答=沉帖落判', q.state === 'done' && q.result === null && /沉了|收藏/.test(q.verdict), q.verdict);
  check('沉帖不计入统计', st.askStats.win + st.askStats.lose + st.askStats.joke === 0);
  const st2 = newGame();
  st2.ap = 2; st2.halted = true; st2.haltLeft = 2;
  answerAsk(st2, 'long');
  resolveRound(st2);
  const q2 = st2.feed.find(f => f.type === 'askq');
  check('停牌=平局退还', q2.result === 'flat' && /停牌/.test(q2.verdict) && st2.askStats.flat === 1, q2.verdict);
  check('平局不动胜负连击', st2.askStats.streak === 0 && st2.askStats.win === 0 && st2.askStats.lose === 0);
}

/* ---------- [E] 押中路径定向验证(全场亢奋抬升生态) ---------- */
console.log('[E] 预言家路径');
{
  const st = newGame();
  st.ap = 9; st.heat = 60;
  allNPCs(st).forEach(n => { n.valence = 60; n.arousal = 60; n.confidence = 60; });
  answerAsk(st, 'long');
  resolveRound(st);
  const q = st.feed.find(f => f.type === 'askq');
  const h = st.history[st.history.length - 1];
  if (h.pct > 0) {
    check('上行回合押中=win', q.result === 'win' && st.askStats.win === 1 && st.askStats.streak === 1, 'pct=' + h.pct);
    check('押中给预言家提示', st.tips.some(t => t.includes('押中')), st.tips.join('¦').slice(0, 60));
    check('押中卡面带判词', /神了|截图|量化|预言/.test(q.verdict), q.verdict);
  } else {
    check('下行回合押涨=lose(判定诚实)', q.result === 'lose' && st.askStats.lose === 1, 'pct=' + h.pct);
  }
}

/* ---------- [F] 成就判定真值 ---------- */
console.log('[F] 成就判定');
{
  const mk = () => newGame();
  const has = (ids, id) => ids.includes(id);
  const e0 = { key: 'partial' };
  const a0 = evaluateAchievements(mk(), e0);
  check('新局只有白嫖大师', a0.length === 1 && has(a0, 'free'), a0.join(','));
  const t1 = mk(); t1.askStats.bestStreak = 2;
  check('预言家=连中2', has(evaluateAchievements(t1, e0), 'oracle'));
  const t2 = mk(); t2.askStats.joke = 3;
  check('抖机灵宗师=3次', has(evaluateAchievements(t2, e0), 'joker'));
  const t3 = mk(); t3.rival.done = true;
  check('反杀对手盘', has(evaluateAchievements(t3, e0), 'slayer'));
  const t4 = mk(); t4.mine.defused = true;
  check('拆弹专家', has(evaluateAchievements(t4, e0), 'defuser'));
  const t5 = mk(); t5.supportCount = 2;
  check('护盘真君=2次', has(evaluateAchievements(t5, e0), 'shield'));
  const t6 = mk(); t6.cashPeak = 26000;
  check('账面首富=2.5亿', has(evaluateAchievements(t6, e0), 'whale'));
  const t7 = mk(); t7.heatPeak = 91;
  check('节奏大师=热度90', has(evaluateAchievements(t7, e0), 'fire'));
  const t8 = mk(); t8.counterWins = 2;
  check('对线之王=2胜', has(evaluateAchievements(t8, e0), 'duelist'));
  const t9 = mk(); t9.manipLog = Array.from({ length: 10 }, () => ({ round: 1, type: 'post', label: 'x', headline: '', cost: 0, affected: [] }));
  check('高产答主=10次', has(evaluateAchievements(t9, e0), 'prolif'));
  const ep = { key: 'prison' };
  const tp = mk(); tp.usedTactics = {};
  const ap = evaluateAchievements(tp, ep);
  check('入狱英才+入狱不发白嫖', has(ap, 'prison') && !has(ap, 'free'), ap.join(','));
  const ec = { key: 'clean' };
  check('全身而退结局徽章', has(evaluateAchievements(mk(), ec), 'clean'));
  const es = { key: 'stuck' };
  check('十年老韭菜结局徽章', has(evaluateAchievements(mk(), es), 'leek'));
  const tw = mk(); tw.usedTactics = { hot: true, writer: true };
  check('花过钱不发白嫖', !has(evaluateAchievements(tw, e0), 'free'));
  check('成就目录共13', ACHIEVEMENTS.length === 13, String(ACHIEVEMENTS.length));
}

/* ---------- [G] 终局集成:整局跑完必有成就字段,提问卡全部落终态 ---------- */
console.log('[G] 终局集成');
{
  for (let i = 0; i < 30; i++) {
    const st = newGame(i % 2 ? 'hype' : null);
    for (let r = 0; r < CONFIG.totalRounds + 1 && !st.ended; r++) {
      if (st.askPending && st.askPending.state === 'open') answerAsk(st, coin(0.6) ? 'joke' : (coin(0.5) ? 'long' : 'short'));
      if (st.ap > 0) applyOpinion(st, 'post', null, 'hype');
      resolveRound(st);
    }
    if (!st.ending) triggerEnd(st, null);
    check('终局必有成就字段(#' + i + ')', Array.isArray(st.achievements) && st.achievements.every(id => ACHIEVEMENTS.some(a => a.id === id)), String(st.achievements));
    const bad = st.feed.filter(f => f.type === 'askq' && f.state !== 'done');
    check('提问卡全部落终态(#' + i + ')', bad.length === 0, 'open=' + bad.length);
    const stats = st.askStats;
    check('统计与卡面守恒(#' + i + ')', stats.win + stats.lose + stats.flat + stats.joke === st.feed.filter(f => f.type === 'askq' && f.state === 'done' && f.result).length, JSON.stringify(stats));
  }
}

console.log('\n=== 结果:' + pass + ' 通过 / ' + fail + ' 失败 ===');
if (fails.length) { console.log('失败明细:'); fails.slice(0, 30).forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
