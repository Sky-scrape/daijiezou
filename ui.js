'use strict';
/* ui.js —— DOM 表现层。所有可玩性数值都在 game.js(数值层)。 */

let st = null;
let feedRendered = 0;
let fundSel = null; // {kind:'buy'|'sell', key, amt}
let kolTarget = null;

const $ = (id) => document.getElementById(id);

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  $('round-total').textContent = CONFIG.totalRounds;
  $('btn-start').addEventListener('click', openTraitPicker);
  $('btn-endturn').addEventListener('click', onEndTurn);
  document.querySelectorAll('.fund-btn[data-fund]').forEach(b => b.addEventListener('click', () => onFund(b.dataset.fund)));
  $('btn-fund-cancel').addEventListener('click', () => closeModal('fund-modal'));
  $('btn-fund-confirm').addEventListener('click', onFundConfirm);
  $('fund-slider').addEventListener('input', onFundSlider);
  $('btn-restart').addEventListener('click', () => location.reload());
  $('btn-copy-report').addEventListener('click', copyReport);
  $('btn-residents').addEventListener('click', openResidents);
  $('btn-res-close').addEventListener('click', () => closeModal('modal-residents'));
  document.querySelectorAll('.op-btn').forEach(b => b.addEventListener('click', () => onOpinion(b.dataset.op)));
  $('btn-kol-confirm').addEventListener('click', () => onOpinion('kol', true));
  bindOpPreview();
  window.addEventListener('resize', () => { if (st && !st.ended) renderMarket(); });
  // Esc 关闭可安全退出的弹窗(抉择事件必须二选一,不响应 Esc)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['fund-modal', 'modal-residents', 'modal-trait'].forEach(id => {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) {
        closeModal(id);
        if (id === 'fund-modal') fundSel = null;
      }
    });
  });
  // 自动演示:?autoplay=1 直接开局(无需再点「开始操盘」);加 &fast=1 倍速跑完
  if (location.search.includes('autoplay')) startGame(TRAITS[randInt(0, TRAITS.length - 1)].id);
});
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

/* ---------------- 开局天赋(三选一) ---------------- */
function openTraitPicker() {
  if (location.search.includes('autoplay')) { startGame(TRAITS[randInt(0, TRAITS.length - 1)].id); return; }
  const pool = TRAITS.slice().sort(() => Math.random() - 0.5).slice(0, 3);
  const box = $('trait-cards');
  box.innerHTML = '';
  pool.forEach(t => {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'trait-card';
    d.innerHTML = `<div class="tc-name">${t.name}</div><div class="tc-desc">${t.desc}</div>`;
    d.onclick = () => { closeModal('modal-trait'); startGame(t.id); };
    box.appendChild(d);
  });
  openModal('modal-trait');
}

function startGame(traitId) {
  st = newGame(traitId);
  feedRendered = 0;
  $('start-screen').classList.add('hidden');
  $('game').classList.remove('hidden');
  const sel = $('kol-target');
  sel.innerHTML = st.kols.map(k => `<option value="${k.id}">${k.name}(${k.tag}·${k.followers}关注)</option>`).join('');
  sel.addEventListener('change', () => { kolTarget = sel.value; });
  kolTarget = st.kols[0].id;
  st.feed.push({ type: 'q', title: `如何看待${STOCK.name}今日高开?有传闻称"有大资金进场"`, likes: 45, round: 0 });
  st.feed.push({ type: 'a', author: st.kols[3].name, tag: st.kols[3].tag + '·' + st.kols[3].followers + '关注', text: '开盘量能平静,所谓"大资金"暂无盘口证据。让子弹飞一会儿。', likes: 890, round: 0, kol: st.kols[3].id });
  st.feed.push({ type: 'a', author: '新开户小张', tag: '大学生新股民', text: '第一次关注这只,请问各位老师现在适合建仓吗?', likes: 12, round: 0 });
  const traitDef = TRAITS.find(t => t.id === traitId);
  if (traitDef) {
    const chip = $('trait-chip');
    chip.textContent = '天赋 · ' + traitDef.name;
    chip.title = traitDef.desc + '(本局生效)';
    chip.classList.remove('hidden');
  }
  st.tips.push('行动指南:先用「发帖/热搜」把热度做起来 → 看到买盘池变深 → 再挂一笔小卖单试试水深。顶栏监管条上的刻度,就是你的倒计时。');
  renderAll();
  toast('第 1 回合开始。' + (traitDef ? '【' + traitDef.name + '】已生效。' : '') + '吸筹要低调,市场还没有注意到你。');
  if (location.search.includes('autoplay')) autoDemo();
}

/* 自动演示模式(?autoplay=1):用内置策略自动跑完一局,直达结局复盘页 */
function autoDemo() {
  const timer = setInterval(() => {
    if (!st || st.ended) { clearInterval(timer); if (st && st.ended) showEnd(); return; }
    if (st.pendingDecision) {          // 自动演示:随机选择一个选项,下一拍再结算
      const card = st.pendingDecision;
      const msg = card.opts[randInt(0, card.opts.length - 1)].apply(st);
      st.pendingDecision = null;
      st.feed.push({ type: 'news', tag: '抉择', title: card.title, text: msg, likes: 0, round: st.round - 1 });
      renderAll();
      return;
    }
    const plan = autoPolicy(st);
    const preFeedLen = st.feed.length;
    for (const op of plan.acts) applyOpinion(st, op, 'kol_sx');
    // plan.buy 是 {mode, amt} 对象(资金操作重构后);旧代码 `plan.buy > 0` 恒为 false,
    // 导致自动演示从不买入 → 价格横盘 → 出货条件永不满足 → 永远"高位站岗"
    if (plan.buy && plan.buy.amt > 0) stageBuy(st, plan.buy.amt, plan.buy.mode);
    if (plan.sell && plan.sell.amt > 0) stageSell(st, plan.sell.channel, plan.sell.amt);
    resolveRound(st);
    llmEnhance(preFeedLen);
    renderAll();
    if (st.ended) { clearInterval(timer); showEnd(); }
  }, location.search.includes('fast') ? 170 : 380);
}

/* ---------------- LLM 文本层(可插拔) ----------------
 * 服务端配置 LLM_API_KEY 后,/api/llm/post 为模板生成的帖子换上 LLM 文案;
 * 未配置/超时/失败时前端静默保留模板文本,绝不阻断游戏(数值层不受影响)。
 * 知乎直答实测只能做问答、拒绝角色扮演创作,故创作走通用 OpenAI 兼容接口。 */
async function jpostJSON(url, obj) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}
function llmEnhance(fromIdx) {
  if (!window.ZR || !window.ZR.llm || !st) return;
  for (let i = Math.max(0, fromIdx); i < st.feed.length; i++) {
    const it = st.feed[i];
    if (!it.llm || it.llmBusy) continue;
    it.llmBusy = true;
    const idx = i;
    jpostJSON('/api/llm/post', {
      kind: it.llm,
      stock: STOCK.name,
      author: it.author || (st.kols.find(k => k.id === it.kol) || {}).name || '',
      tag: it.tag || '',
      title: it.title || '',
    }).then(r => {
      if (!r || !r.text || st.ended) return;
      it.text = r.text;
      const node = document.querySelector('#feed .feed-item[data-fidx="' + idx + '"] .fi-text');
      if (node) node.textContent = r.text;
    }).catch(() => { /* 回退:保留模板文本 */ });
  }
}

/* ---------------- 主渲染 ---------------- */
function renderAll() {
  renderTop();
  renderMarket();
  renderActions();
  renderFeed();
}

function renderTop() {
  $('round-now').textContent = Math.min(st.round, CONFIG.totalRounds);
  $('bar-heat').style.width = clamp(st.heat, 0, 100) + '%';
  $('val-heat').textContent = Math.round(st.heat);
  $('bar-reg').style.width = clamp(st.reg, 0, 100) + '%';
  $('val-reg').textContent = Math.round(st.reg);
  $('wallet-cash').textContent = fmtYi(st.cash);
  $('wallet-shares').textContent = fmtShares(totalShares(st));
  const pnl = (st.price - st.cost) / st.cost * 100;
  const p = $('wallet-pnl');
  p.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%';
  p.style.color = pnl >= 0 ? 'var(--up)' : 'var(--down)';
  const pips = $('ap-pips');
  pips.innerHTML = '';
  for (let i = 0; i < st.apPerTurn; i++) {
    const s = document.createElement('i');
    if (i >= st.ap) s.className = 'off';
    pips.appendChild(s);
  }
  $('ap-note').textContent = `行动点 ${st.ap}/${st.apPerTurn}`;
  // 知乎原型/示例分身加入后,社区人数徽章动态更新
  const cnt = $('feed-cnt');
  const personaDemo = window.ZR_PERSONA && window.ZR_PERSONA.tag === '虚构示例·分身';
  if (cnt) cnt.textContent = 'AI居民:' + st.kols.length + '位大V + ' + st.retails.length + '位散户' + (st.retails.some(n => n.isPersona) ? (personaDemo ? '(含虚构示例分身)' : '(含知乎原型·你)') : '');
}

function renderMarket() {
  const last = st.history[st.history.length - 1];
  const pct = last ? last.pct : 0;
  $('price').textContent = st.price.toFixed(2);
  const chg = $('price-chg');
  chg.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%';
  chg.className = 'price-chg ' + (pct >= 0 ? 'up' : 'down');
  $('price').style.color = pct >= 0 ? 'var(--red)' : 'var(--green)';
  const bb = $('board-badge');
  if (st.board >= 2) { bb.classList.remove('hidden'); bb.textContent = st.board + '连板'; } else bb.classList.add('hidden');
  const hb = $('halt-badge');
  if (st.halted) { hb.classList.remove('hidden'); hb.textContent = '盘中停牌 · 剩 ' + Math.max(st.haltLeft, 0) + ' 回合'; }
  else hb.classList.add('hidden');
  const { pool } = computePool(st);
  $('pool-fill').style.width = clamp(pool / 3500 * 100, 4, 100) + '%';
  $('pool-val').textContent = '≈ ' + fmtShares(pool);
  $('pos-shares').textContent = fmtShares(totalShares(st));
  $('pos-sellable').textContent = fmtShares(sellableShares(st));
  $('pos-cost').textContent = st.cost.toFixed(2) + ' 元';
  $('pos-realized').textContent = fmtYi(st.realized);
  drawKline();
  renderPending();
}

function renderPending() {
  const box = $('pending-box');
  const parts = [];
  if (st.pendingBuy && st.pendingBuy.amt > 0) parts.push(`买入挂单 <b>${BUY_MODES[st.pendingBuy.mode].name} ${fmtShares(st.pendingBuy.amt)}</b>`);
  if (st.pendingSell) parts.push(`卖出挂单 <b>${CHANNELS[st.pendingSell.channel].name} ${fmtShares(st.pendingSell.amt)}</b>`);
  if (st.halted && parts.length) parts.push('(停牌中,保留至复牌)');
  box.classList.remove('hidden');
  if (!parts.length) {
    box.className = 'pending-box empty';
    box.textContent = '暂无挂单 · 挂单在收盘结算时按买盘池撮合';
    return;
  }
  box.className = 'pending-box';
  box.innerHTML = '待结算:' + parts.join(' · ');
}

function renderActions() {
  const canTrade = !st.halted;
  // 资金面按钮:吸筹/拉抬/出货 + 两个大招
  document.querySelectorAll('.fund-btn[data-fund]').forEach(b => {
    const key = b.dataset.fund;
    if (key === 'wash') {
      b.disabled = !st.skills.wash || st.halted || st.cash < 800;
      b.title = !st.skills.wash ? '已使用(每局一次)' : '自买自卖制造放量假象:本回合买盘池 +35%,热度 +18,监管 +14,花费 800 万';
      b.querySelector('small').textContent = st.skills.wash ? '800万 · 一次' : '已使用';
    } else if (key === 'exit') {
      b.disabled = !st.skills.exit || st.halted || !!st.pendingSell;
      b.title = !st.skills.exit ? '已使用(每局一次)' : (st.pendingSell ? '已有挂单,先取消再使用' : '本回合挂出的卖单:价格冲击/折价/监管全部减半');
      b.querySelector('small').textContent = st.skills.exit ? '一次 · 出货减伤' : '已使用';
    } else if (BUY_MODES[key]) {
      b.disabled = !canTrade || st.cash < st.price * 10;
    } else {
      b.disabled = !canTrade || sellableShares(st) < 10;
    }
  });
  $('btn-endturn').disabled = false;
  document.querySelectorAll('.op-btn').forEach(b => {
    const key = b.dataset.op;
    const act = OPINION_ACTIONS[key];
    b.disabled = st.ap < act.ap || st.cash < act.cost;
  });
  const tip = currentTip();
  $('tip-body').textContent = tip;
}
const HINTS = [
  '买入分三档:悄悄吸筹不惊动任何人;想拉价就上拉抬——动静越大,热度与监管烧得越旺。',
  '连板越高,散户FOMO越强、买盘池越深——但监管关注度涨得越快。每一板,都是一次 push-your-luck 的押注。',
  '出货通道各有脾气:集中竞价稳、大宗快但折价还可能走漏风声、尾盘偷袭凶险。最后一波清仓,通道组合决定你的评分。',
  '问询函 → 临时停牌 → 龙虎榜曝光 → 立案调查。监管条到哪儿了,自己心里要有数。',
  '热度每回合自然衰减。想出货,先确认买盘池还有多少存货。',
  '自问自答安抚的是新人,写手稿打动的是从众者——不同的人设,吃不同的节奏。',
];
let hintIdx = 0, hintRound = -1;
function currentTip() {
  if (st.tips && st.tips.length) { hintRound = st.round; return st.tips[st.tips.length - 1]; }
  if (st.round !== hintRound) { hintIdx = (hintIdx + 1) % HINTS.length; hintRound = st.round; }
  return HINTS[hintIdx];
}

/* ---------------- K线 ---------------- */
function drawKline() {
  const cv = $('kline'), ctx = cv.getContext('2d');
  const cw = Math.round(cv.getBoundingClientRect().width) || 460;
  if (cv.width !== cw) cv.width = cw;
  cv.height = 150;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const data = st.history.slice(-15);
  if (!data.length) {
    ctx.fillStyle = '#9aa4b2'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('第一回合收盘后,这里会出现你的K线', W / 2, H / 2);
    return;
  }
  const lo = Math.min(...data.map(d => d.low)) * 0.995, hi = Math.max(...data.map(d => d.high)) * 1.005;
  const padL = 8, padR = 34, padY = 10;
  const y = p => padY + (hi - p) / (hi - lo) * (H - padY * 2);
  const bw = (W - padL - padR) / 15;
  ctx.strokeStyle = '#eef1f4';
  for (let i = 0; i <= 4; i++) {
    const yy = padY + i * (H - padY * 2) / 4;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
  }
  data.forEach((d, i) => {
    const x = padL + i * bw + bw / 2;
    const up = d.close >= d.open;
    ctx.strokeStyle = up ? '#e0342f' : '#0a9e58';
    ctx.fillStyle = up ? '#e0342f' : '#0a9e58';
    ctx.beginPath(); ctx.moveTo(x, y(d.high)); ctx.lineTo(x, y(d.low)); ctx.stroke();
    const t = Math.max(3, bw * 0.55);
    const yo = y(d.open), yc = y(d.close);
    ctx.fillRect(x - t / 2, Math.min(yo, yc), t, Math.max(2, Math.abs(yc - yo)));
    if (d.board >= 2) {
      ctx.fillStyle = '#e0342f'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(d.board + '板', x, y(d.high) - 3);
    }
  });
  const lastC = data[data.length - 1].close;
  ctx.fillStyle = '#333'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(lastC.toFixed(2), W - padR + 4, y(lastC) + 4);
}

/* ---------------- 舆论行动 ---------------- */
/* 悬停预览:把每个动作的数值效果明示出来(与 game.js 的 applyOpinion 一致) */
const OP_PREVIEW = {
  post:      '免费 · 1 AP · 热度 +4 · 全场情绪 +3~6、唤醒 +4 · 监管 +3',
  hot:       '¥80万 · 1 AP · 热度 +22 · 全场情绪 +2~5、唤醒 +12 · 监管 +6',
  writer:    '¥120万 · 1 AP · 热度 +12 · 从众/梭哈型情绪 +9~14 · 监管 +10 · 25% 被识破(再 +16)',
  kol:       '¥150万 · 1 AP · 指定大V看多两回合 · 全场情绪 +8 · 监管 +4',
  astroturf: '免费 · 1 AP · 新人/从众型置信 +8、情绪 +4 · 监管 +2',
  clarify:   '¥60万 · 1 AP · 监管 −10 · 热度 −15 · 全场降温 · 停牌中也可用',
};
const OP_PREVIEW_DEFAULT = '把鼠标放到动作上查看数值效果。热度与情绪喂养买盘池,监管是它们的代价。';
function bindOpPreview() {
  const box = $('op-preview');
  if (!box) return;
  box.textContent = OP_PREVIEW_DEFAULT;
  document.querySelectorAll('.op-btn').forEach(b => {
    const show = () => { box.textContent = OP_PREVIEW[b.dataset.op] || OP_PREVIEW_DEFAULT; };
    b.addEventListener('mouseenter', show);
    b.addEventListener('focus', show);
    b.addEventListener('click', show);
  });
}
function onOpinion(key, skipSelect) {
  if (!st || st.ended) return;
  if (key !== 'kol') $('kol-select').classList.add('hidden');
  if (key === 'kol' && !skipSelect) {
    const selRow = $('kol-select');
    if (selRow.classList.contains('hidden')) {
      selRow.classList.remove('hidden');
      return;
    }
  }
  const r = applyOpinion(st, key, kolTarget);
  if (!r.ok) { toast('行动点或资金不足。', 'bad'); return; }
  $('kol-select').classList.add('hidden');
  if (r.headline) toast(r.headline, key === 'kol' ? 'gold' : '');
  llmEnhance(st.feed.length - 3); // 本回合新产生的帖子尝试 LLM 换文案
  renderAll();
}

/* ---------------- 资金行动(买入三档 / 出货三通道,点击后设置金额) ---------------- */
const FUND_META = {
  quiet: { kind: 'buy' }, pump: { kind: 'buy' }, ignite: { kind: 'buy' },
  auction: { kind: 'sell' }, block: { kind: 'sell' }, tail: { kind: 'sell' },
};
const CH_ICON = { auction: '💰', block: '🤝', tail: '🌙' };
function onFund(key) {
  if (!st || st.ended) return;
  if (key === 'wash') { const r = useWash(st); toast(r.msg, r.ok ? 'gold' : 'bad'); renderAll(); return; }
  if (key === 'exit') { const r = useExit(st); toast(r.msg, r.ok ? 'gold' : 'bad'); renderAll(); return; }
  openFundModal(key);
}
function openFundModal(key) {
  const meta = FUND_META[key];
  if (!meta) return;
  const slider = $('fund-slider');
  fundSel = { kind: meta.kind, key, amt: 0 };
  if (meta.kind === 'buy') {
    const m = BUY_MODES[key];
    if (st.cash < st.price * 10) { toast('现金不足,买不起最小单位(10 万股)。', 'bad'); return; }
    $('fund-modal-title').textContent = m.icon + ' ' + m.name;
    $('fund-modal-desc').textContent = m.desc;
    slider.min = '10'; slider.max = String(m.max); slider.step = '10';
    fundSel.amt = Math.min(100, m.max);
  } else {
    const maxS = Math.floor(sellableShares(st));
    if (maxS < 10) return;
    const ch = CHANNELS[key];
    $('fund-modal-title').textContent = CH_ICON[key] + ' ' + ch.name + ' · 出货';
    $('fund-modal-desc').textContent = ch.desc + ` 监管关注度 +${ch.reg}${ch.discount ? ` · 折价 ${Math.round(ch.discount * 100)}%` : ''}${ch.leak ? ` · ${Math.round(ch.leak * 100)}% 概率走漏风声` : ''}。`;
    slider.min = '10'; slider.max = String(maxS); slider.step = '10';
    fundSel.amt = Math.min(400, maxS);
  }
  slider.value = String(fundSel.amt);
  $('fund-amt-val').textContent = fmtShares(fundSel.amt);
  updateFundEst();
  openModal('fund-modal');
}
function onFundSlider() {
  if (!fundSel) return;
  fundSel.amt = parseInt($('fund-slider').value, 10);
  $('fund-amt-val').textContent = fmtShares(fundSel.amt);
  updateFundEst();
}
function updateFundEst() {
  if (!fundSel) return;
  const { pool } = computePool(st);
  if (fundSel.kind === 'buy') {
    const m = BUY_MODES[fundSel.key];
    const impact = fundSel.amt / (pool + 400) * 2.4 * m.impactMul;
    const pay = fundSel.amt * st.price * (1 + impact * 0.5);
    $('fund-est').innerHTML = `预计花费 ≈ <b>${fmtYi(pay)}</b> · 拉动价格 ≈ <b>+${Math.round(impact * 100)}%</b>(结算时随买卖盘落地)` +
      (impact > 0.07 ? '<br>⚠ 拉抬过猛会直接顶到涨停——涨幅越大,监管越看得见。' : '<br>本笔动作隐蔽。');
  } else {
    const ch = CHANNELS[fundSel.key];
    const ex = st.exitNext ? 0.5 : 1;
    const impact = fundSel.amt / (pool + 350) * ch.impact * 1.2 * ex;
    const estPrice = st.price * (1 - Math.min(impact, 0.2) / 2) * (1 - ch.discount * ex);
    $('fund-est').innerHTML = `预计成交价 ≈ <b>${estPrice.toFixed(2)} 元</b> · 预计回笼 ≈ <b>${fmtYi(estPrice * fundSel.amt)}</b>(价格冲击 ${(impact * 100).toFixed(1)}%${ch.discount ? ` + 折价 ${Math.round(ch.discount * ex * 100)}%` : ''})<br>` +
      (impact > 0.09 ? '⚠ 卖得太猛会砸崩价格——考虑分回合匀速出货。' : '本笔出手节奏安全。') +
      (st.exitNext ? '<br>🕊 金蝉脱壳生效中:本单的冲击与折价已按减半预估。' : '');
  }
}
function onFundConfirm() {
  if (!fundSel) return;
  if (fundSel.kind === 'buy') {
    const amt = stageBuy(st, fundSel.amt, fundSel.key);
    toast(`已挂买单:${BUY_MODES[fundSel.key].name} ${fmtShares(amt)}(T+1,本回合买入下回合才能卖)。`);
  } else {
    const amt = stageSell(st, fundSel.key, fundSel.amt);
    toast(`已挂卖单:${CHANNELS[fundSel.key].name} ${fmtShares(amt)}。`);
  }
  fundSel = null;
  closeModal('fund-modal');
  renderAll();
}

/* ---------------- 全屏事件横幅(涨停/跌停/停牌/监管大事件) ---------------- */
const bannerQueue = [];
let bannerPlaying = false;
function flashBanner(title, sub, tone) {
  if (bannerQueue.length >= 3) return; // 防刷屏:最多排 3 条
  bannerQueue.push({ title, sub, tone: tone || 'info' });
  if (!bannerPlaying) playNextBanner();
}
function playNextBanner() {
  const item = bannerQueue.shift();
  if (!item) { bannerPlaying = false; return; }
  bannerPlaying = true;
  const d = document.createElement('div');
  d.className = 'big-banner tone-' + item.tone;
  d.innerHTML = `<b>${esc(item.title)}</b>${item.sub ? `<span>${esc(item.sub)}</span>` : ''}`;
  document.body.appendChild(d);
  setTimeout(() => {
    d.classList.add('out');
    setTimeout(() => { d.remove(); playNextBanner(); }, 350);
  }, 1500);
}

/* ---------------- 回合结算 ---------------- */
function onEndTurn() {
  if (st.ended) return;
  const preBoard = st.board;
  const preHalted = st.halted;
  const preFeedLen = st.feed.length;
  resolveRound(st);
  renderAll();
  if (st.ended) { showEnd(); return; }
  // 大事件横幅:让涨跌停/停牌/监管里程碑有视觉落点
  const last = st.history[st.history.length - 1];
  if (last.pct >= 9.9) flashBanner(st.board >= 2 ? st.board + ' 连板!' : '涨停 🎉', '散户正在狂欢,买盘池沸腾', 'up');
  else if (last.pct <= -9.9) flashBanner('跌停', '恐慌蔓延,接盘的人不见了', 'down');
  if (!preHalted && st.halted) flashBanner('盘中临时停牌', '波动异常,监管出手 · 舆论操作不受影响', 'warn');
  st.feed.slice(preFeedLen).forEach(it => {
    if (it.type !== 'news') return;
    if (it.title === '问询函') flashBanner('问询函', '监管要求书面说明 —— 计时器开始加速', 'warn');
    else if (it.title === '龙虎榜曝光') flashBanner('龙虎榜曝光', '你的席位被盯上了', 'warn');
    else if (it.tag === '监管' && it.title !== '盘中临时停牌' && it.title !== '问询函' && it.title !== '龙虎榜曝光') flashBanner(it.title, it.text.slice(0, 40), 'warn');
  });
  let msg = `第 ${last.round} 回合收盘 ${last.close.toFixed(2)} 元(${last.pct >= 0 ? '+' : ''}${last.pct}%)。`;
  if (st.board > preBoard) msg += ` 🎉${st.board}连板!散户正在狂欢,买盘池沸腾。`;
  if (st.halted) msg += ' ⚠ 临时停牌:下回合无法交易。';
  toast(msg);
  if (st.pendingDecision) openDecision(st.pendingDecision);
}

/* ---------------- 抉择事件卡 ---------------- */
function openDecision(card) {
  $('dc-title').textContent = '【抉择】' + card.title;
  $('dc-text').textContent = card.text;
  const box = $('dc-opts');
  box.innerHTML = '';
  card.opts.forEach(o => {
    const b = document.createElement('button');
    b.className = 'dc-opt';
    b.textContent = o.label;
    b.onclick = () => {
      const msg = o.apply(st);
      st.pendingDecision = null;
      closeModal('modal-decision');
      st.feed.push({ type: 'news', tag: '抉择', title: card.title, text: msg, likes: 0, round: st.round - 1 });
      toast(msg, 'gold');
      renderAll();
    };
    box.appendChild(b);
  });
  openModal('modal-decision');
}

/* ---------------- AI 居民面板 ---------------- */
function openResidents() {
  if (!st) return;
  const moodName = v => v > 25 ? '看多' : v < -25 ? '看空' : '观望';
  const moodCls = v => v > 25 ? 'bull' : v < -25 ? 'bear' : 'flat';
  const track = v => {
    const w = Math.min(Math.abs(v), 100) / 2;
    return `<span class="res-track"><i style="${v >= 0 ? `left:50%;width:${w}%;background:var(--up)` : `left:${50 - w}%;width:${w}%;background:var(--down)`}"></i></span>`;
  };
  const row = (n, extraCls, nameHtml) =>
    `<div class="res-row ${extraCls || ''}"><span class="res-name">${nameHtml || esc(n.name)}</span><span class="res-tag ${st.kolsBoost[n.id] ? 'boost' : ''}">${esc(n.tag)}${st.kolsBoost[n.id] ? ' ⚡被你充值' : ''}</span>${track(n.valence)}<span class="res-val ${moodCls(n.valence)}">${moodName(n.valence)} ${Math.round(n.valence)}</span><span class="res-num" title="情绪 × 唤醒 × 置信">情${Math.round(n.valence)} · 唤${Math.round(n.arousal)} · 信${Math.round(n.confidence)}</span></div>`;
  const kols = st.kols.map(k => row(k)).join('');
  const R = st.retails;
  const persona = R.find(n => n.isPersona);
  const bull = R.filter(n => n.valence > 25).length, bear = R.filter(n => n.valence < -25).length;
  const avgA = Math.round(R.reduce((t, n) => t + n.arousal, 0) / R.length);
  const avgC = Math.round(R.reduce((t, n) => t + n.confidence, 0) / R.length);
  const sorted = R.slice().sort((a, b) => b.valence - a.valence);
  const top = sorted.slice(0, 3).map(n => `${n.name}(${Math.round(n.valence)})`).join('、');
  const bottom = sorted.slice(-3).reverse().map(n => `${n.name}(${Math.round(n.valence)})`).join('、');
  const roster = R.slice().sort((a, b) => b.valence - a.valence)
    .map(n => row(n, n.isPersona ? 'res-persona' : '', n.isPersona ? '🌟 ' + esc(n.name) : null)).join('');
  $('res-body').innerHTML =
    `<div class="res-sec">意见领袖(大V × ${st.kols.length})</div>${kols}` +
    `<div class="res-sec">散户(${R.length}人) — 看多 ${bull} · 观望 ${R.length - bull - bear} · 看空 ${bear} · 平均情绪 ${Math.round(avgValence(st))} · 平均唤醒 ${avgA} · 平均置信 ${avgC}</div>` +
    `<div class="res-roster">${roster}</div>` +
    (persona ? `<div class="res-line">👆 ${window.ZR_PERSONA && window.ZR_PERSONA.tag === '虚构示例·分身' ? '带🌟的是虚构示例分身——正式版登录知乎后,TA 会换成你自己。' : '带🌟的居民以你的知乎画像生成——盯紧 TA,看 TA 什么时候被收割。'}</div>` : '') +
    `<div class="res-line">🔥 最狂热:${top}</div><div class="res-line">🧊 最恐慌:${bottom}</div>` +
    `<div class="res-hint">情绪 = 对${STOCK.name}的态度(红看多/绿看空) · 唤醒 = 激动程度 · 置信 = 对自己观点的确信。他们的情绪 = 你的买盘池,收盘结算后继续演化。</div>`;
  openModal('modal-residents');
}

/* ---------------- Feed ---------------- */
function renderFeed() {
  const box = $('feed');
  let lastRound = feedRendered > 0 ? st.feed[feedRendered - 1].round : -1;
  for (; feedRendered < st.feed.length; feedRendered++) {
    const it = st.feed[feedRendered];
    if (it.round !== lastRound) {
      const d = document.createElement('div');
      d.className = 'sys-line';
      d.textContent = it.round === 0 ? '—— 开盘前 ——' : `—— 第 ${it.round} 回合 ——`;
      box.appendChild(d);
      lastRound = it.round;
    }
    const node = buildFeedItem(it);
    node.dataset.fidx = feedRendered; // LLM 异步换文案时按此定位 DOM
    box.appendChild(node);
  }
  while (box.children.length > 120) box.removeChild(box.firstChild); // 长对局 DOM 上限
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 240;
  if (near) box.scrollTop = box.scrollHeight;
}
function buildFeedItem(it) {
  const d = document.createElement('div');
  if (it.type === 'q') {
    d.className = 'feed-item';
    d.innerHTML = `<div class="fi-q"><span class="q-mark">Q</span>${esc(it.title)}</div><div class="fi-meta">${it.likes} 关注 · 关注问题 · 写回答</div>`;
  } else if (it.type === 'a' || it.type === 'comment') {
    d.className = 'feed-item' + (it.type === 'comment' ? ' fi-comment' : '');
    const initial = it.author.slice(0, 1);
    const ac = it.kol ? '#b26a00' : avColor(it.author);
    d.innerHTML = `<div class="fi-author"><span class="fi-avatar ${it.kol ? 'kol' : ''}" style="background:${ac}">${esc(initial)}</span><span class="fi-name">${esc(it.author)}</span><span class="fi-tag ${it.kol ? 'kol' : ''}">${esc(it.tag)}</span></div><div class="fi-text">${esc(it.text)}</div><div class="fi-meta">👍 ${it.likes} · 评论 · 分享</div>`;
  } else if (it.type === 'writer') {
    d.className = 'feed-item';
    d.innerHTML = `<div class="fi-author"><span class="fi-avatar" style="background:${avColor(it.author)}">${esc(it.author.slice(0, 1))}</span><span class="fi-name">${esc(it.author)}</span><span class="fi-tag">${esc(it.tag)}</span></div><div class="fi-title">${esc(it.title)}</div><div class="fi-text">${esc(it.text)}</div>${it.attr ? `<div class="fi-attr">✍ ${esc(it.attr)}</div>` : ''}<div class="fi-meta">👍 ${it.likes} · 评论 · 分享</div>`;
  } else if (it.type === 'kolpost') {
    const kol = st.kols.find(k => k.id === it.kol);
    d.className = 'feed-item';
    d.innerHTML = `<div class="fi-author"><span class="fi-avatar kol">${esc(kol.name.slice(0, 1))}</span><span class="fi-name">${esc(kol.name)}</span><span class="fi-tag kol">${esc(kol.tag)}·${kol.followers}关注</span></div><div class="fi-title">${esc(it.title)}</div><div class="fi-text">${esc(it.text)}</div><div class="fi-meta">👍 ${it.likes} · 评论 · 分享</div>`;
  } else if (it.type === 'news') {
    const isReg = it.tag === '监管';
    d.className = 'feed-item';
    d.innerHTML = `<div class="fi-news ${isReg ? 'reg' : ''}"><span class="fi-tag ${isReg ? 'reg' : ''}">${esc(it.tag)}</span> <b style="margin-left:6px">${esc(it.title)}</b><div class="fi-text" style="margin-top:4px">${esc(it.text)}</div></div>`;
  }
  return d;
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
/* 头像配色:按名字哈希从固定色板取色,同一 NPC 每回合颜色稳定 */
var AV_COLORS = ['#2e6bd6', '#0f8a5f', '#7c5cd6', '#c2571f', '#8a6d3b', '#d63b5c', '#3a8a8a', '#b03a7a', '#1f6f8c', '#5a6b7a'];
function avColor(name) {
  var h = 0;
  for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

/* ---------------- 结局 ---------------- */
function showEnd() {
  const e = st.ending;
  const info = ENDINGS[e.key];
  const [color, label] = ENDING_TONE_STYLE[info.tone];
  $('end-card').style.background = `linear-gradient(155deg, ${color}, ${shade(color, -28)})`;
  $('end-kicker').textContent = info.tone === 'prison' ? '调查通报(虚构)' : '操盘战报(虚构)';
  $('end-title').textContent = info.title;
  $('end-sub').textContent = info.sub;
  $('end-body').textContent = info.body;
  const assets = st.cash + e.chipsLeft * e.finalPrice;
  $('end-stats').innerHTML = `
    <div><label>套现所得</label><b>${fmtYi(e.realized)}</b></div>
    <div><label>出货比例</label><b>${Math.round(e.soldRatio * 100)}%</b></div>
    <div><label>终局股价</label><b>${e.finalPrice.toFixed(2)} 元</b></div>
    <div><label>期末总资产</label><b>${fmtYi(assets)}</b></div>`;
  renderTransMap();
  renderVaccines();
  renderGallery(e.key);
  $('end-screen').classList.remove('hidden');
}
/* 结局图鉴:localStorage 记录见过的结局,给"再来一局"一个收集钩子 */
const GALLERY_KEY = 'djz_endings_v1';
function renderGallery(curKey) {
  const el = $('end-gallery');
  if (!el) return;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(GALLERY_KEY) || '[]'); } catch (e) {}
  if (!seen.includes(curKey)) { seen.push(curKey); try { localStorage.setItem(GALLERY_KEY, JSON.stringify(seen)); } catch (e) {} }
  el.innerHTML = `<label>结局图鉴 ${seen.length}/${Object.keys(ENDINGS).length}</label>` +
    Object.entries(ENDINGS).map(([k, v]) =>
      `<span class="gal-item ${seen.includes(k) ? 'got' : 'lock'} ${k === curKey ? 'cur' : ''}">${seen.includes(k) ? esc(v.title) : '???'}</span>`
    ).join('');
}
function renderTransMap() {
  const box = $('trans-map');
  box.innerHTML = '';
  const OP_ICON = { post: '📣', hot: '🔍', writer: '✍️', kol: '🤝', astroturf: '🎭', clarify: '🧯' };
  const byRound = {};
  st.manipLog.forEach(m => { (byRound[m.round] = byRound[m.round] || { ops: [] }).ops.push(m); });
  st.sellLog.forEach(s => { (byRound[s.round] = byRound[s.round] || { ops: [] }).sell = s; });
  const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);
  if (!rounds.length) { box.innerHTML = '<div class="tm-empty">这一局你没有动用舆论,也没有出货——一张白纸。</div>'; return; }
  rounds.forEach(r => {
    const g = byRound[r];
    const d = document.createElement('div');
    d.className = 'tm-group';
    let html = `<div class="tm-head">第 ${r} 回合</div><div class="tm-flow">`;
    g.ops.forEach((m, i) => {
      const cnt = m.affected.length;
      const avg = cnt ? Math.round(m.affected.reduce((t, a) => t + a.dv, 0) / cnt) : 0;
      if (i) html += '<span class="tm-arr"></span>';
      html += `<span class="tm-node op">${OP_ICON[m.type] || '📣'} ${esc(m.label)}${m.cost ? `<i>¥${m.cost}万</i>` : ''}</span><span class="tm-arr"></span>` +
        `<span class="tm-node infect">感染 <b>${cnt}</b> 位居民 · 情绪均值 <b>${avg >= 0 ? '+' : ''}${avg}</b></span>`;
    });
    html += '<span class="tm-arr"></span><span class="tm-node pool">汇入买盘池</span>';
    if (g.sell) {
      html += `<span class="tm-arr"></span><span class="tm-node sell">你的出货:${g.sell.channel} <b>${fmtShares(g.sell.amt)}</b> @ ${g.sell.fillPrice.toFixed(2)} 元 → 回笼 <b>${fmtYi(g.sell.proceeds)}</b></span>`;
    }
    html += '</div>';
    d.innerHTML = html;
    box.appendChild(d);
  });
}
function renderVaccines() {
  const box = $('vaccines');
  const used = Object.keys(st.usedTactics);
  box.innerHTML = used.map(k => {
    const v = VACCINES.find(x => x.key === k);
    if (!v) return '';
    return `<div class="vac-item"><b>${esc(v.name)}</b><span class="vac-real">${esc(v.real)}</span><span class="vac-tip">识别要点:${esc(v.tip)}</span></div>`;
  }).join('') || '<div class="tm-empty">本局未使用舆论手段——你是个"价投"庄家。</div>';
}
function copyReport() {
  const e = st.ending, info = ENDINGS[e.key];
  const lines = [];
  const playedRounds = Math.min(st.round, CONFIG.totalRounds);
  lines.push(`【带节奏·战报】${info.title} —— ${info.sub}`);
  lines.push(`星阑科技(888217·虚构) · 历时 ${playedRounds} 回合 · 监管关注度 ${Math.round(e.reg)}/100`);
  lines.push(`套现 ${fmtYi(e.realized)} · 出货 ${Math.round(e.soldRatio * 100)}% · 终价 ${e.finalPrice.toFixed(2)} 元`);
  const ops = st.manipLog.length;
  lines.push(`舆论动作 ${ops} 次,感染 AI 居民 ${st.manipLog.reduce((t, m) => t + m.affected.length, 0)} 人次`);
  lines.push('玩完这局,愿你以后刷到"离职员工自述帖"时,多一秒警惕。(本游戏纯属虚构,不构成投资建议)');
  const text = lines.join('\n');
  const done = () => toast('战报已复制,去粘贴给朋友吧。');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toast('复制失败,请手动截图。'); }
  document.body.removeChild(ta);
}
function shade(hex, pct) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => clamp(Math.round(v * (100 + pct) / 100), 0, 255);
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return `rgb(${r},${g},${b})`;
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = type ? 'toast-' + type : '';
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3400);
}
