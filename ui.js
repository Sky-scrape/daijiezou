'use strict';
/* ui.js —— DOM 表现层。所有可玩性数值都在 game.js(数值层)。 */

let st = null;
let feedRendered = 0;
let debtToastShown = false;   // 负现金提醒:跌破触发一次,回正后重置
let fundSel = null; // {kind:'buy'|'sell', key, amt}
let kolTarget = null;

const $ = (id) => document.getElementById(id);

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  $('round-total').textContent = CONFIG.totalRounds;
  $('btn-start').addEventListener('click', onBtnStart);
  initCustomStockUI();
  initApiCfgUI();
  $('btn-endturn').addEventListener('click', onEndTurn);
  document.querySelectorAll('.fund-btn[data-fund]').forEach(b => b.addEventListener('click', () => onFund(b.dataset.fund)));
  $('btn-fund-cancel').addEventListener('click', () => closeModal('fund-modal'));
  $('btn-fund-confirm').addEventListener('click', onFundConfirm);
  $('fund-slider').addEventListener('input', onFundSlider);
  $('btn-restart').addEventListener('click', () => {
    // 两段式确认:重开即丢失本局复盘,误触代价太高
    const b = $('btn-restart');
    if (b.dataset.armed) { location.reload(); return; }
    b.dataset.armed = '1';
    b.textContent = '确定重开?再点一次';
    b.classList.add('armed');
    setTimeout(() => { if (!b.dataset.armed) return; delete b.dataset.armed; b.textContent = '再来一局'; b.classList.remove('armed'); }, 3000);
  });
  // 信息流(最新在顶部):点悬浮按钮回到顶部看最新;玩家手动滚回顶部时清除未读计数
  const feedNewBtn = $('feed-new');
  if (feedNewBtn) feedNewBtn.addEventListener('click', () => {
    const box = $('feed');
    box.scrollTop = 0;
    feedNewBtn.classList.add('hidden');
    feedNewCount = 0;
  });
  const feedBox = $('feed');
  if (feedBox) feedBox.addEventListener('scroll', () => {
    if (feedBox.scrollTop < 60) {
      feedNewCount = 0;
      const b = $('feed-new');
      if (b) b.classList.add('hidden');
    }
  });
  $('btn-copy-report').addEventListener('click', copyReport);
  $('btn-residents').addEventListener('click', () => setFeedTab('residents'));
  document.querySelectorAll('.feed-tab').forEach(b => b.addEventListener('click', () => setFeedTab(b.dataset.ftab)));
  $('btn-zhida').addEventListener('click', onAdvisor);
  $('zhida-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') onAdvisor(); });
  document.querySelectorAll('.op-btn').forEach(b => b.addEventListener('click', () => onOpinion(b.dataset.op)));
  $('btn-kol-confirm').addEventListener('click', () => onOpinion('kol', true));
  // 发帖角度面板:三项 = game.js POST_ANGLES
  const postBox = $('post-angles');
  if (postBox) {
    Object.entries(POST_ANGLES).forEach(([id, a]) => {
      const b = document.createElement('button');
      b.className = 'dc-opt';
      b.innerHTML = `<span class="dc-label">📣 ${esc(a.name)}</span><span class="dc-hint">${esc(a.hint)}</span>`;
      b.onclick = () => { closeModal('modal-post'); onOpinion('post', true, id); };
      postBox.appendChild(b);
    });
    $('btn-post-cancel').addEventListener('click', () => closeModal('modal-post'));
  }
  bindOpPreview();
  window.addEventListener('resize', () => { if (st && !st.ended) renderMarket(); });
  // Esc 关闭可安全退出的弹窗(抉择事件必须二选一,不响应 Esc)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['fund-modal', 'modal-trait', 'modal-api', 'modal-post'].forEach(id => {
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

/* ---------------- 自定义本局标的(开始页) ----------------
 * 只影响文案层(公司名/代码/题材/简介),数值层零改动;
 * localStorage 记住上次设定,「再来一局」(刷新)不丢。 */
const CS_KEY = 'djz_custom_stock_v1';
let csAiBusy = false;
function csFields() {
  return { name: $('cs-name').value, code: $('cs-code').value, topic: $('cs-topic').value, blurb: $('cs-blurb').value };
}
function csSetFields(c) {
  $('cs-name').value = c.name || DEFAULT_STOCK.name;
  $('cs-code').value = c.code || DEFAULT_STOCK.code;
  $('cs-topic').value = c.topic || DEFAULT_STOCK.topic;
  $('cs-blurb').value = c.blurb || DEFAULT_STOCK.blurb;
}
function csMsg(text, ok) {
  const el = $('cs-msg');
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}
function csUpdateHint() {
  const custom = STOCK.name !== DEFAULT_STOCK.name || STOCK.code !== DEFAULT_STOCK.code;
  $('cs-cur').textContent = (custom ? '自定义剧本 · ' : '默认剧本 · ') + STOCK.name + '(' + STOCK.code + ')';
  $('rules-stock-li').innerHTML = '你是<b>' + esc(STOCK.name) + '(' + esc(STOCK.code) + ')</b>的暗盘主力:持仓 <b>3000 万股</b>(30% 流通盘),成本 3.10 元,账上现金 <b>5000 万</b>。';
}
function initCustomStockUI() {
  csSetFields(DEFAULT_STOCK);
  csUpdateHint();
  // 恢复上次自定义(自动演示模式除外,保持演示脚本用默认剧本)
  if (!location.search.includes('autoplay')) {
    try {
      const saved = JSON.parse(localStorage.getItem(CS_KEY) || 'null');
      if (saved && saved.name) {
        const r = applyCustomStock(saved);
        if (r.ok) { csSetFields(saved); csUpdateHint(); }
      }
    } catch (e) { /* 忽略坏数据 */ }
  }
  $('btn-cs-toggle').addEventListener('click', () => {
    $('cs-panel').classList.toggle('hidden');
    if (!$('cs-panel').classList.contains('hidden')) $('cs-name').focus();
  });
  $('btn-cs-random').addEventListener('click', () => {
    csSetFields(randomCustomStock());
    csMsg('🎲 已生成一套随机虚构标的,可直接开局,也可以继续手改。', true);
  });
  $('btn-cs-reset').addEventListener('click', () => {
    csSetFields(DEFAULT_STOCK);
    resetStock();
    try { localStorage.removeItem(CS_KEY); } catch (e) {}
    csMsg('↺ 已恢复默认剧本:星阑科技(888217)。', true);
    csUpdateHint();
  });
  $('btn-cs-ai').addEventListener('click', onCsAi);
}
function onBtnStart() {
  const r = applyCustomStock(csFields());
  if (!r.ok) {
    csMsg('⚠ ' + r.error);
    $('cs-panel').classList.remove('hidden');
    return;
  }
  try { localStorage.setItem(CS_KEY, JSON.stringify(csFields())); } catch (e) {}
  csUpdateHint();
  openTraitPicker();
}
/* ---------------- 接入自己的 AI Key(BYOK,开始页登录区入口) ----------------
 * Key 只存玩家浏览器 localStorage;调用时经 X-LLM-* 请求头随请求转发给上游,
 * 服务端不存储、不记录,随时可清除。未配置时自动回退服务端 Key/内置模板。 */
const LLM_CFG_KEY = 'djz_llm_cfg_v1';
function loadLLMCfg() {
  try { const c = JSON.parse(localStorage.getItem(LLM_CFG_KEY) || 'null'); if (c && c.key) return c; } catch (e) {}
  return null;
}
function hasByok() { return !!loadLLMCfg(); }
function llmHeaders() {
  const c = loadLLMCfg();
  return c ? { 'X-LLM-Key': cleanKeyVal(c.key), 'X-LLM-Base': cleanKeyVal(c.base), 'X-LLM-Model': cleanKeyVal(c.model) } : {};
}
function saveLLMCfg(c) {
  try {
    if (c && c.key) localStorage.setItem(LLM_CFG_KEY, JSON.stringify(c));
    else localStorage.removeItem(LLM_CFG_KEY);
  } catch (e) { /* 隐私模式等:忽略 */ }
  updateApiBtn();
}
function updateApiBtn() {
  const btn = $('btn-api-cfg');
  if (btn) btn.textContent = hasByok() ? '🔑 已接入自己的 AI Key(点此管理)' : '🔑 进阶:接入自己的 AI Key(可选)';
}
function initApiCfgUI() {
  updateApiBtn();
  $('btn-api-cfg').addEventListener('click', () => {
    const c = loadLLMCfg() || {};
    $('api-key').value = c.key || '';
    $('api-base').value = c.base || '';
    $('api-model').value = c.model || '';
    apiMsg('');
    openModal('modal-api');
    closeModelMenu();
    if (c.key) fetchApiModels(true);   // 已存过 Key:静默预取模型列表
  });
  $('btn-api-models').addEventListener('click', () => fetchApiModels(false));
  $('api-key').addEventListener('blur', () => { if ($('api-key').value.trim()) fetchApiModels(true); });
  $('api-base').addEventListener('blur', () => { if ($('api-key').value.trim()) fetchApiModels(true); });
  $('api-model').addEventListener('focus', () => { if (apiModelsCache.length) renderModelMenu(apiModelsCache); });
  $('api-model').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('api-model-menu').classList.contains('hidden')) {
      e.stopPropagation();   // 先只关下拉,不关整个弹窗
      closeModelMenu();
    }
  });
  $('api-model-menu').addEventListener('mousedown', (e) => {
    if (e.target.closest('.api-model-item')) e.preventDefault();  // 防止 label 转移焦点导致菜单重开
  });
  $('api-model-menu').addEventListener('click', (e) => {
    const it = e.target.closest('.api-model-item');
    if (!it) return;
    $('api-model').value = it.dataset.v;
    closeModelMenu();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.api-model-row')) closeModelMenu();
  });
  $('btn-api-close').addEventListener('click', () => { closeModelMenu(); closeModal('modal-api'); });
  $('btn-api-save').addEventListener('click', () => {
    const key = cleanKeyVal($('api-key').value);
    if (key && key.length < 8) { apiMsg('⚠ 这个 Key 看起来太短,请检查是否粘贴完整'); return; }
    saveLLMCfg(key ? { key, base: cleanKeyVal($('api-base').value), model: cleanKeyVal($('api-model').value) } : null);
    closeModal('modal-api');
    toast(key ? '🔑 AI Key 已保存(仅存于本浏览器),即刻生效。' : '已清除 AI Key,回到内置模板模式。');
  });
  $('btn-api-clear').addEventListener('click', () => {
    saveLLMCfg(null);
    $('api-key').value = ''; $('api-base').value = ''; $('api-model').value = '';
    apiModelsCache = [];
    closeModelMenu();
    apiMsg('');
  });
}
function apiMsg(text, ok) {
  const el = $('api-msg');
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}
/* 清洗粘贴内容:去掉空格/换行/零宽字符等,避免浏览器因非法请求头字符直接拒绝发送 */
function cleanKeyVal(s) { return String(s || '').replace(/[\s\u200B-\u200D\uFEFF\u3000]/g, ''); }
let apiModelsQ = '';   // 已成功拉取过的 Key指纹+地址,避免重复请求
let apiModelsCache = [];  // 当前已拉取的模型列表(自定义下拉数据源)
function renderModelMenu(models) {
  apiModelsCache = models || apiModelsCache;
  const cur = $('api-model').value.trim();
  $('api-model-menu').innerHTML = apiModelsCache.map(m =>
    '<div class="api-model-item' + (m === cur ? ' cur' : '') + '" data-v="' + esc(m) + '">' + esc(m) + '</div>'
  ).join('');
  $('api-model-menu').classList.remove('hidden');
}
function closeModelMenu() {
  const menu = $('api-model-menu');
  if (menu) menu.classList.add('hidden');
}
async function fetchApiModels(silent) {
  const key = cleanKeyVal($('api-key').value), base = cleanKeyVal($('api-base').value);
  if (!key) { if (!silent) apiMsg('⚠ 先填 API Key,再获取模型列表'); return; }
  const q = key.slice(-6) + '|' + base;
  if (q === apiModelsQ) return;
  if (!silent) apiMsg('正在获取模型列表…');
  try {
    const r = await fetch('/api/llm/models', { headers: { 'X-LLM-Key': key, 'X-LLM-Base': base } });
    let data = null;
    try { data = await r.json(); } catch (e2) {
      throw Object.assign(new Error('non-json'), { raw: true, status: r.status });
    }
    if (!r.ok || !data || !data.models || !data.models.length) {
      throw Object.assign(new Error('no models'), { up: (data && data.upstream) || r.status });
    }
    apiModelsQ = q;
    renderModelMenu(data.models);
    if (!$('api-model').value.trim()) $('api-model').value = data.models[0];
    apiMsg('✓ 已获取 ' + data.models.length + ' 个模型:点击「模型名」输入框即可下拉选择。', true);
  } catch (e) {
    if (!silent) {
      let reason;
      if (e && e.up) {
        reason = e.up === 401 || e.up === 403 ? 'Key 无效或无权限(' + e.up + ')'
          : e.up === 404 ? '该接口地址下没有 /models 列表接口(404),请手动输入模型名'
          : '上游返回 ' + e.up;
      } else if (e && e.raw) {
        reason = '服务器返回了非 JSON 响应(HTTP ' + e.status + ')';
      } else {
        reason = '网络请求未发出:' + (e && e.message ? e.message : '未知') + '(若是直接双击打开的 HTML 文件,请改用 http://localhost:8788 访问)';
      }
      apiMsg('获取模型列表失败:' + reason + '。也可手动输入模型名,留空用默认。');
    }
  }
}
function aiFallbackMsg(e) {
  const up = e && e.up;
  if (!hasByok()) return 'AI 助写暂不可用(未接入 Key 且服务端未配置),已用本地模板生成,游戏照常可玩。';
  if (up === 401 || up === 403) return '上游返回 ' + up + ':Key 无效或无权限,请点下方「接入自己的 AI Key」检查。已先用本地模板生成。';
  if (up === 429) return '上游限流(429),稍后再试。已先用本地模板生成。';
  if (up === 200) return '该模型返回了空内容(常见于推理型模型思考耗尽)。建议在 🔑 Key 设置里换个模型,或直接重试。已先用本地模板生成。';
  if (up === 502 || up === 504) return '上游模型超时或无响应——推理型大模型容易这样。建议在 🔑 Key 设置里换成 flash / mini 级快速模型。已先用本地模板生成。';
  if (e && e.name === 'AbortError') return 'AI 响应超时,已用本地模板生成。';
  return 'AI 助写暂不可用,已用本地模板生成(离线可玩)。';
}
async function onCsAi() {
  if (csAiBusy) return;
  const check = validateCustomStock(csFields());
  if (check.error) { csMsg('⚠ 先把公司名/代码/题材填对,再让 AI 助写:' + check.error); return; }
  csAiBusy = true;
  const btn = $('btn-cs-ai');
  const old = btn.textContent;
  btn.textContent = '✍️ 生成中…';
  btn.disabled = true;
  csMsg('AI 正在为「' + check.value.name + '」撰写官方简介…');
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    const data = await jpostJSON('/api/llm/company', {
      name: check.value.name, code: check.value.code, topic: check.value.topic, hint: $('cs-blurb').value.slice(0, 80),
    }, { signal: ctl.signal });
    clearTimeout(timer);
    if (!data || !data.text) throw new Error('no text');
    $('cs-blurb').value = String(data.text).slice(0, 100);
    csMsg('✨ AI 已生成公司介绍,可以自由修改。', true);
  } catch (e) {
    $('cs-blurb').value = genLocalBlurb(check.value.name, check.value.topic).slice(0, 100);
    csMsg(aiFallbackMsg(e), true);
  } finally {
    csAiBusy = false;
    btn.textContent = old;
    btn.disabled = false;
  }
}

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
  $('stock-chip').textContent = STOCK.name + ' ' + STOCK.code;
  renderCompanyCard();
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

/* 公司资料卡(盘面):展示玩家自定义/AI 生成的虚构公司简介 */
function renderCompanyCard() {
  const fold = $('company-fold');
  if (!fold) return;
  $('company-fold-name').textContent = STOCK.name + ' ' + STOCK.code;
  const blurb = STOCK.blurb || genLocalBlurb(STOCK.name, STOCK.topic);
  $('company-body').innerHTML =
    '<div class="cb-line"><b>' + esc(STOCK.name) + '</b>（' + esc(STOCK.code) + '·虚构）· ' + esc(STOCK.exchange) + '</div>' +
    '<div class="cb-line">主营:' + esc(STOCK.topic) + '</div>' +
    '<p class="cb-blurb">' + esc(blurb) + '</p>' +
    '<div class="cb-note">以上资料由玩家设定或 AI 生成,纯属虚构,不构成投资建议。</div>';
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
async function jpostJSON(url, obj, opts = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...llmHeaders() },
    body: JSON.stringify(obj),
    ...opts,
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (!r.ok) throw Object.assign(new Error('http ' + r.status), { up: (data && data.upstream) || r.status });
  return data;
}
function llmEnhance(fromIdx) {
  if (!window.ZR || !st) return;
  if (!window.ZR.llm && !hasByok()) return;  // 服务端未配 Key 且玩家未接入自己的 Key → 用本地模板
  for (let i = Math.max(0, fromIdx); i < st.feed.length; i++) {
    const it = st.feed[i];
    if (!it.llm || it.llmBusy) continue;
    it.llmBusy = true;
    const idx = i;
    jpostJSON('/api/llm/post', {
      kind: it.llm,
      stock: STOCK.name,
      topic: STOCK.topic,
      author: it.author || (st.kols.find(k => k.id === it.kol) || {}).name || '',
      tag: it.tag || '',
      mood: it.mood || '',
      summary: it.llm === 'regulation' ? manipSummary() : '',
      title: it.title || '',
    }).then(r => {
      // 不以 st.ended 拦截:fast=1 自动演示数秒内终局,LLM 响应晚到也照常落地
      // (结局页是覆盖层,文案/徽章落在底层 feed;再来一局走整页 reload,无脏状态)
      if (!r || !r.text) return;
      it.text = r.text;
      const node = document.querySelector('#feed .feed-item[data-fidx="' + idx + '"] .fi-text');
      if (node) node.textContent = r.text;
      // AI 徽章只在 LLM 文案真正落地时挂出:评委/玩家能一眼分辨哪些帖子是 AI 实时写的
      const holder = document.querySelector('#feed .feed-item[data-fidx="' + idx + '"] .fi-meta')
        || document.querySelector('#feed .feed-item[data-fidx="' + idx + '"] .fi-news');
      if (holder && !holder.querySelector('.ai-badge')) {
        const tag = document.createElement('span');
        tag.className = 'ai-badge';
        tag.title = '这段文案由 AI 结合当前盘面/人设实时生成;数值后果仍由确定性引擎执行';
        tag.textContent = '🤖 AI 生成';
        holder.insertBefore(tag, holder.firstChild);
      }
    }).catch(() => { /* 回退:保留模板文本 */ });
  }
}

/* ---------------- AI 军师(看盘君) + 状态摘要 ----------------
 * 三级降级:BYOK/服务端 LLM → 知乎直答 → 本地规则军师;永不阻断。 */
function manipSummary() {
  if (!st) return '';
  const c = {};
  st.manipLog.forEach(m => { c[m.label] = (c[m.label] || 0) + 1; });
  return Object.entries(c).map(([k, v]) => k + '×' + v).join('、') || '无';
}
function stateDigest() {
  if (!st) return '';
  const npcs = allNPCs(st).slice().sort((a, b) => b.valence - a.valence);
  const bull = npcs[0], bear = npcs[npcs.length - 1];
  const ops = {};
  st.manipLog.forEach(m => { ops[m.label] = (ops[m.label] || 0) + 1; });
  const opStr = Object.entries(ops).map(([k, v]) => k + '×' + v).join('、') || '暂无';
  const last = st.history[st.history.length - 1];
  const pool = computePool(st).pool;
  return '股票:' + STOCK.name + '(' + STOCK.code + ',全虚构)'
    + ';回合:' + st.round + '/' + CONFIG.totalRounds
    + ';股价:' + st.price.toFixed(2) + '元(你的成本' + st.cost.toFixed(2) + '),本回合涨跌' + (last ? last.pct.toFixed(1) : '0') + '%'
    + ';现金:' + fmtYi(st.cash) + ',持仓:' + fmtShares(totalShares(st)) + ',可卖(T+1):' + fmtShares(sellableShares(st)) + ',已套现:' + fmtYi(st.realized)
    + ';热度:' + Math.round(st.heat) + '/100,监管:' + Math.round(st.reg) + '/100' + (st.halted ? '(停牌中,剩' + st.haltLeft + '回合)' : '')
    + ',买盘池≈' + fmtShares(pool)
    + ';最看多:' + (bull ? bull.name + '(' + bull.tag + ',情绪' + Math.round(bull.valence) + ')' : '无')
    + ',最看空:' + (bear ? bear.name + '(' + bear.tag + ',情绪' + Math.round(bear.valence) + ')' : '无')
    + ';本局舆论手段:' + opStr
    + (st.pendingBuy ? ';有买入挂单' : '') + (st.pendingSell ? ';有卖出挂单' : '');
}
function localAdvisor(q) {
  const reg = Math.round(st.reg), heat = Math.round(st.heat);
  const pool = computePool(st).pool;
  const profit = (st.price / st.cost - 1) * 100;
  if (/t\s*\+?\s*1/i.test(q)) return 'T+1:今天买的筹码,收盘结算后下回合才能卖。想出货,就要提前把买入沉淀成「可卖」。';
  if (/买盘池|池子|深度|接盘/.test(q)) return '当前买盘池≈' + fmtShares(pool) + '。池子越深,你的卖单砸价越轻;池子见底还硬卖就是砸穿自己。基本节奏:造热度→池变深→分批出货。';
  if (/监管|问询|停牌|立案|风险/.test(q)) {
    if (st.halted) return '已停牌(剩' + st.haltLeft + '回合)。停牌期间舆论操作照常,「🧯 澄清」是唯一能降温的动作(监管-10),复牌前把火压下去。';
    if (reg >= 60) return '监管' + reg + '/100,已过停牌线(60),85会被标记。建议:激进动作停一回合,用「澄清」降温,宁可少赚,别进去。';
    if (reg >= 35) return '监管' + reg + '/100,已过问询线(35)。每次大动作都在喂它,出货尽量走「集中竞价」这类低监管通道。';
    return '监管' + reg + '/100,还算安全。记住三道坎:35问询、60停牌、100立案——造势的每一脚都在踩油门。';
  }
  if (/卖|出货|套现|跑|落袋/.test(q)) return '现价' + st.price.toFixed(2) + ' vs 成本' + st.cost.toFixed(2) + '(浮盈' + profit.toFixed(0) + '%),可卖' + fmtShares(sellableShares(st)) + ',买盘池≈' + fmtShares(pool) + '。池深且热度高时分批卖,一笔巨单会砸穿价格——别贪最后一段。';
  if (/热度|拉|造势|宣传|帖|热搜/.test(q)) return heat < 40 ? '热度只有' + heat + ',买盘池的燃料不足。优先「发帖/热搜」造势,等池子变深再动真格。' : '热度' + heat + ',势能不错,趁热出货效率最高;但过热也招监管,别火上浇油。';
  if (/买|吸|加仓/.test(q)) return '吸筹用「悄悄吸筹」不惊动监管;想顺手拉价用「拉抬」,单笔越大监管越重。你账上现金' + fmtYi(st.cash) + '。';
  return '看盘君(本地模式):热度' + heat + '/监管' + reg + '/买盘池≈' + fmtShares(pool) + '。基本节奏:低吸→造势→等池深→分批出货;监管是倒计时。(虚构游戏,不构成投资建议)';
}
let advisorBusy = false;
async function onAdvisor() {
  if (advisorBusy || !st) return;
  const input = $('zhida-q'), out = $('zhida-a'), btn = $('btn-zhida');
  const q = (input.value || '').trim();
  if (!q) return;
  advisorBusy = true;
  btn.disabled = true; btn.textContent = '思考中…';
  out.textContent = '看盘君思考中…';
  out.classList.remove('hidden');
  try {
    if (hasByok() || (window.ZR && window.ZR.llm)) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      const r = await jpostJSON('/api/llm/advisor', { q, state: stateDigest() }, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r || !r.text) throw new Error('no text');
      out.textContent = '看盘君:' + r.text;
    } else throw new Error('no-llm');
  } catch (e) {
    if (window.ZR && window.ZR.zhida) {
      try {
        const r2 = await jpostJSON('/api/zhihu/zhida', { q });
        out.textContent = '看盘君(知乎直答):' + r2.answer;
      } catch (e2) { out.textContent = '看盘君:' + localAdvisor(q); }
    } else {
      out.textContent = '看盘君:' + localAdvisor(q);
    }
  }
  advisorBusy = false;
  btn.disabled = false; btn.textContent = '问看盘君';
}

/* ---------------- AI 生态(嵌入社区卡「AI 生态」标签页,评委/玩家一眼看懂本局的 AI 在做什么) ---------------- */
function renderAiecoInline() {
  const llmOn = hasByok() || (window.ZR && window.ZR.llm);
  const stat = (on, onText, offText) => `<span class="aieco-status ${on ? 'on' : 'off'}">${on ? onText : offText}</span>`;
  const aiStat = stat(llmOn, 'LLM 在线', '模板池降级');
  const row = (name, desc, status) => `<div class="aieco-row"><b>${name}</b><span>${desc}</span>${status}</div>`;
  const aiDesc = (onDesc, offDesc) => (llmOn ? onDesc : offDesc);
  $('aieco-inline').innerHTML =
    `<div class="aieco-head">🤖 本局的 AI 在做什么 <small>AI 是生态的演员,不是裁判</small></div>` +
    `<div class="aieco-sec">AI 演出层(人→Agent / Agent→人 / Agent→Agent)</div>` +
    row('🧠 AI 军师', aiDesc('实时读取盘面/热度/监管/居民情绪 Top2,给战术分析(看盘君输入框)', '本地规则军师 + 知乎直答降级链,照样能答'), aiStat) +
    row('🎲 AI 抉择事件', aiDesc('结合本局局势定制叙事,从确定性效果目录选 2 个选项(每局≤2 次)', '本地事件池(数值后果完全一致)'), aiStat) +
    row('💬 居民人设帖', aiDesc('每回合情绪最极端的居民,AI 按 TA 的人设与三维情绪值发帖', '本地人设文案库(24 种散户人设)'), aiStat) +
    row('📜 监管文书', aiDesc('问询函/监察通报注入你本局的真实操纵摘要', '固定文书模板'), aiStat) +
    row('🪦 AI 结案陈词', aiDesc('结局按你的操作记录生成个性化复盘', '无(仅结局文案)'), aiStat) +
    row('✨ AI 助写', aiDesc('自定义标的公司简介 AI 代笔', '本地拼装模板'), aiStat) +
    `<div class="aieco-sec">知乎数据接入点(社区即游戏世界)</div>` +
    row('🔥 热榜 API', '真实知乎热榜滚动在社区顶部,充当游戏世界的背景板', stat(window.ZR && window.ZR.hotlist, '已接入', '离线')) +
    row('💬 知乎直答', 'AI 军师降级链第二级:专业问答', stat(window.ZR && window.ZR.zhida, '已接入', '离线')) +
    row('📖 盐言故事语料', '为「雇写手」提供风格参照与作者归属', stat(window.ZR && window.ZR.corpus, '已接入', '离线')) +
    row('👤 用户画像 API', '以你的知乎画像生成「以你为原型」的韭菜 NPC(正式版走 OAuth)', stat(window.ZR && (window.ZR.oauth || window.ZR_PERSONA), window.ZR && window.ZR.oauth ? 'OAuth' : '演示', '未登录')) +
    `<div class="aieco-note"><b>设计原则:</b>LLM 只生成「人话」文本并从确定性效果目录中选择动作 id;价格、买盘池、28 位居民的情绪向量等所有数值后果,全部由本地确定性引擎执行。LLM 不可用时全链路静默降级,游戏永远可玩、数值层零影响。</div>`;
}

/* ---------------- 主渲染 ---------------- */
function renderAll() {
  renderTop();
  renderMarket();
  renderActions();
  renderFeed();
  if (feedTab === 'residents') $('res-inline').innerHTML = renderResidentsHTML(); // 情绪每回合演化,面板保持实时
  else if (feedTab === 'aieco') renderAiecoInline(); // 画像NPC等状态可能中途变化,保持实时
}

/* ---------------- 社区卡标签页:动态 / 居民生态 ---------------- */
let feedTab = 'feed';
function setFeedTab(t) {
  if (!st) return;
  feedTab = t;
  document.querySelectorAll('.feed-tab').forEach(b => b.classList.toggle('active', b.dataset.ftab === t));
  const isRes = t === 'residents', isEco = t === 'aieco';
  $('feed').classList.toggle('hidden', isRes || isEco);
  $('res-inline').classList.toggle('hidden', !isRes);
  $('aieco-inline').classList.toggle('hidden', !isEco);
  const nb = $('feed-new');
  if (nb && (isRes || isEco)) nb.classList.add('hidden');
  if (isRes) $('res-inline').innerHTML = renderResidentsHTML();
  if (isEco) renderAiecoInline();
}

function renderTop() {
  $('round-now').textContent = Math.min(st.round, CONFIG.totalRounds);
  $('bar-heat').style.width = clamp(st.heat, 0, 100) + '%';
  $('val-heat').textContent = Math.round(clamp(st.heat, 0, 100));  // 回合中段可短暂超100,显示按满格截断
  $('bar-reg').style.width = clamp(st.reg, 0, 100) + '%';
  $('val-reg').textContent = Math.round(st.reg);
  $('wallet-cash').textContent = fmtYi(st.cash);
  $('wallet-shares').textContent = fmtShares(totalShares(st));
  const pnl = (st.price - st.cost) / st.cost * 100;
  const p = $('wallet-pnl');
  p.textContent = (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%';
  p.style.color = pnl >= 0 ? 'var(--up)' : 'var(--down)';
  p.title = `底仓浮盈:建仓成本 ${st.cost.toFixed(2)} 元 vs 现价——这是庄家的起点优势,不是已经落袋的钱(落袋看「已变现」)。`;
  // 负现金:只在跌破/回到正区间的瞬间提醒一次,不刷屏
  const cashEl = $('wallet-cash');
  if (st.cash < 0) cashEl.title = '现金为负:花钱的动作已锁定,先「集中竞价出货」回笼现金。';
  else cashEl.title = '';
  if (st.cash < 0 && !debtToastShown) { debtToastShown = true; toast('⚠ 资金链紧张:现金为负!花钱的动作已锁定,先「集中竞价出货」回笼现金(免费发帖仍可用)。', 'bad'); }
  if (st.cash >= 0) debtToastShown = false;
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
    // 免费动作(发帖/自答)不受现金限制——负现金时它们是玩家仅剩的自救声量
    b.disabled = st.ap < act.ap || (act.cost > 0 && st.cash < act.cost);
    if (b.disabled && st.ap >= act.ap && act.cost > 0 && st.cash < act.cost) {
      b.title = `现金不足:该动作需 ¥${act.cost} 万,先「集中竞价出货」回笼现金。`;
    } else if (key !== 'clarify' && st.tacticUses && (st.tacticUses[key] || 0) > 0) {
      const u = st.tacticUses[key];
      b.title = `社区免疫:该话术已连用 ${u} 次,本笔效果 ×${Math.max(0.55, 1 - u * 0.15).toFixed(2)}——换一招可恢复。`;
    } else b.title = '';
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
  // K线高度跟随 CSS 实际渲染高度(#kline 为弹性收缩,矮屏自动变矮)
  const ch = Math.round(cv.getBoundingClientRect().height) || 104;
  if (cv.height !== ch) cv.height = ch;
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
    const show = () => {
      let txt = OP_PREVIEW[b.dataset.op] || OP_PREVIEW_DEFAULT;
      if (st && b.dataset.op !== 'clarify' && st.tacticUses) {
        const u = st.tacticUses[b.dataset.op] || 0;
        if (u > 0) txt += ` ⚠ 社区免疫:已连用 ${u} 次,本笔效果 ×${Math.max(0.55, 1 - u * 0.15).toFixed(2)}(换招可恢复)`;
      }
      box.textContent = txt;
    };
    b.addEventListener('mouseenter', show);
    b.addEventListener('focus', show);
    b.addEventListener('click', show);
  });
}
function onOpinion(key, skipSelect, angle) {
  if (!st || st.ended) return;
  if (key !== 'kol') $('kol-select').classList.add('hidden');
  if (key === 'kol' && !skipSelect) {
    const selRow = $('kol-select');
    if (selRow.classList.contains('hidden')) {
      selRow.classList.remove('hidden');
      return;
    }
  }
  // 发帖先选角度(参与感);autoplay/headless 直接调 applyOpinion,不经过这里
  if (key === 'post' && angle === undefined && !skipSelect) {
    openModal('modal-post');
    return;
  }
  const r = applyOpinion(st, key, kolTarget, angle);
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
/* 按当前现金能买起的最大万股(与 updateFundEst 同一支付公式;pay 随 amt 单调递增,线性扫即可) */
function maxBuyShares(st, m) {
  const { pool } = computePool(st);
  const pay = amt => { const impact = amt / (pool + 400) * 2.4 * m.impactMul; return amt * st.price * (1 + impact * 0.5); };
  let best = 0;
  for (let a = 10; a <= m.max; a += 10) { if (pay(a) <= st.cash) best = a; else break; }
  return best;
}
function openFundModal(key) {
  const meta = FUND_META[key];
  if (!meta) return;
  const slider = $('fund-slider');
  fundSel = { kind: meta.kind, key, amt: 0 };
  if (meta.kind === 'buy') {
    const m = BUY_MODES[key];
    const afford = maxBuyShares(st, m);
    if (afford < 10) { toast('现金不足,买不起最小单位(10 万股)。', 'bad'); return; }
    let desc = m.desc + (m.max > afford ? ' 受现金所限,本笔最多 ' + afford + ' 万股。' : '');
    if (st.pendingBuy && st.pendingBuy.amt > 0)
      desc += ` ⚠ 已有买入挂单(${BUY_MODES[st.pendingBuy.mode].name} ${fmtShares(st.pendingBuy.amt)}),本次确认将替换它。`;
    $('fund-modal-title').textContent = m.icon + ' ' + m.name;
    $('fund-modal-desc').textContent = desc;
    slider.min = '10'; slider.max = String(Math.min(m.max, afford)); slider.step = '10';
    fundSel.amt = Math.min(100, parseInt(slider.max, 10));
  } else {
    const maxS = Math.floor(sellableShares(st));
    if (maxS < 10) return;
    const ch = CHANNELS[key];
    let desc = ch.desc + ` 监管关注度 +${ch.reg}${ch.discount ? ` · 折价 ${Math.round(ch.discount * 100)}%` : ''}${ch.leak ? ` · ${Math.round(ch.leak * 100)}% 概率走漏风声` : ''}。`;
    if (st.pendingSell && st.pendingSell.amt > 0)
      desc += ` ⚠ 已有卖出挂单(${CHANNELS[st.pendingSell.channel].name} ${fmtShares(st.pendingSell.amt)}),本次确认将替换它。`;
    $('fund-modal-title').textContent = CH_ICON[key] + ' ' + ch.name + ' · 出货';
    $('fund-modal-desc').textContent = desc;
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
    // 监管预估与游戏规则一致:quiet 0;pump 单笔 >150 万股 +5;ignite 固定 +5(另热度+10)
    const regEst = fundSel.key === 'quiet' ? 0 : fundSel.key === 'pump' ? (fundSel.amt > 150 ? 5 : 0) : 5;
    const heatNote = fundSel.key === 'ignite' ? ' · 热度 +10' : '';
    $('fund-est').innerHTML = `预计花费 ≈ <b>${fmtYi(pay)}</b> · 拉动价格 ≈ <b>+${Math.round(impact * 100)}%</b> · 预计监管 <b>+${regEst}</b>${heatNote}(结算时随买卖盘落地)` +
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
    const want = fundSel.amt;
    const amt = stageBuy(st, fundSel.amt, fundSel.key);
    if (amt <= 0) { toast('现金不足以买入最小单位。', 'bad'); return; }
    toast(`已挂买单:${BUY_MODES[fundSel.key].name} ${fmtShares(amt)}(T+1,本回合买入下回合才能卖)。` + (amt < want ? '(已按可用资金调减)' : ''));
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
  // 军师新手引导:第一回合结算后高亮看盘君卡一次,把"AI 军师"这个最强 AI 入口在前期推到玩家眼前
  if (st.round === 2) {
    let hinted = false;
    try { hinted = !!localStorage.getItem('djz_advisor_hint_v1'); localStorage.setItem('djz_advisor_hint_v1', '1'); } catch (e) { hinted = false; }
    if (!hinted) {
      const card = $('tip-card');
      if (card) {
        card.classList.remove('hint-pulse'); void card.offsetWidth;
        card.classList.add('hint-pulse');
        setTimeout(() => card.classList.remove('hint-pulse'), 3200);
      }
      if (!st.tips.length) {   // 有监管/停牌提示时不抢占 tip 位
        st.tips.push('💡 试试问看盘君一个具体问题(如「现在该出货吗」)——AI 军师会读取你的实时盘面作答。');
        $('tip-body').textContent = st.tips[st.tips.length - 1];
      }
    }
  }
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
  if (st.pendingDecision) maybeAiDecision();
}

/* ---------------- 抉择事件卡 ---------------- */
function openDecision(card, generating) {
  if (generating) {   // AI 专属事件生成中:占位态,不展示本地内容避免闪换
    $('dc-title').textContent = '【抉择】定制事件生成中';
    $('dc-text').textContent = '看盘君正在结合本局局势,为你生成一个专属抉择事件…(约需几秒)';
    $('dc-opts').innerHTML = '<div class="dc-generating"><i>●</i><i>●</i><i>●</i></div>';
    openModal('modal-decision');
    return;
  }
  $('dc-title').innerHTML = '【抉择】' + esc(card.title) +
    (card.ai ? ' <span class="ai-badge" title="本事件由 AI 结合你的实时盘面生成;两个选项的效果由确定性引擎执行">🤖 AI 定制</span>' : '');
  $('dc-text').textContent = card.text;
  const box = $('dc-opts');
  box.innerHTML = '';
  card.opts.forEach(o => {
    const b = document.createElement('button');
    b.className = 'dc-opt';
    b.innerHTML = `<span class="dc-label">${esc(o.label)}</span>` + (o.hint ? `<span class="dc-hint">${esc(o.hint)}</span>` : '');
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

/* AI 实时抉择事件:把本地事件替换为结合本局局势的 AI 定制版(LLM 只写叙事+选效果 id,数值由引擎执行)。
 * 每局限 2 次;失败/超时/无 Key 静默回退本地事件池。自动演示模式不启用(保持演示脚本快而稳)。 */
async function maybeAiDecision() {
  const local = st.pendingDecision;
  const llmOn = hasByok() || (window.ZR && window.ZR.llm);
  if (location.search.includes('autoplay') || !llmOn || st.aiEvents >= 2) { openDecision(local); return; }
  openDecision(local, true);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    const data = await jpostJSON('/api/llm/event', {
      state: stateDigest(),
      effects: Object.entries(AI_EVENT_EFFECTS).map(([id, e]) => id + '=' + e.desc).join(' ; '),
      ids: Object.keys(AI_EVENT_EFFECTS),
    }, { signal: ctl.signal });
    clearTimeout(timer);
    if (!data || !data.title || !Array.isArray(data.opts)) throw new Error('bad event');
    const fxs = data.opts.map(o => (o && AI_EVENT_EFFECTS[o.effect]) || null);
    if (fxs.length !== 2 || !fxs[0] || !fxs[1] || fxs[0] === fxs[1]) throw new Error('bad effects');
    st.aiEvents++;
    st.pendingDecision = {
      id: 'ai_' + Date.now(),
      title: String(data.title).slice(0, 16),
      text: String(data.text).slice(0, 160),
      ai: true,
      opts: data.opts.map((o, i) => ({ label: String(o.label || '行动').slice(0, 14), hint: fxs[i] ? fxs[i].desc : '', apply: fxs[i].apply })),
    };
    openDecision(st.pendingDecision);
  } catch (e) {
    if (st.pendingDecision === local) openDecision(local);   // AI 失败:回退本地事件池
  }
}

/* ---------------- AI 居民生态(嵌入社区卡「居民生态」标签页) ---------------- */
function renderResidentsHTML() {
  if (!st) return '';
  const moodName = v => v > 25 ? '看多' : v < -25 ? '看空' : '观望';
  const moodCls = v => v > 25 ? 'bull' : v < -25 ? 'bear' : 'flat';
  // 情绪条按全场最大 |情绪| 归一(保底 40),否则 20~30 的情绪值条形几乎不可见
  const maxV = Math.max(40, ...allNPCs(st).map(n => Math.abs(n.valence)));
  const track = v => {
    const w = Math.min(Math.abs(v), 100) / maxV * 50;
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
  return (
    `<div class="res-sec">意见领袖(大V × ${st.kols.length})</div>${kols}` +
    `<div class="res-sec">散户(${R.length}人) — 看多 ${bull} · 观望 ${R.length - bull - bear} · 看空 ${bear} · 平均情绪 ${Math.round(avgValence(st))} · 平均唤醒 ${avgA} · 平均置信 ${avgC}</div>` +
    `<div class="res-roster">${roster}</div>` +
    (persona ? `<div class="res-line">👆 ${window.ZR_PERSONA && window.ZR_PERSONA.tag === '虚构示例·分身' ? '带🌟的是虚构示例分身——正式版登录知乎后,TA 会换成你自己。' : '带🌟的居民以你的知乎画像生成——盯紧 TA,看 TA 什么时候被收割。'}</div>` : '') +
    `<div class="res-line">🔥 最狂热:${top}</div><div class="res-line">🧊 最恐慌:${bottom}</div>` +
    `<div class="res-hint">情绪 = 对${STOCK.name}的态度(红看多/绿看空) · 唤醒 = 激动程度 · 置信 = 对自己观点的确信。他们的情绪 = 你的买盘池,收盘结算后继续演化。⚠ 同一话术连用会被「脱敏」(效果递减);过热时冷嘲/价值型居民会发帖质疑,压低全场信心。</div>`);
}

/* ---------------- Feed(最新在最上方) ---------------- */
let feedNewCount = 0;   // 未读新帖数:玩家下翻看历史时,悬浮按钮提示有新动态
function renderFeed() {
  const box = $('feed');
  const before = feedRendered;
  // 倒序渲染:新帖插到顶部;处理顺序仍是旧→新,逐条 insertBefore(firstChild)
  for (; feedRendered < st.feed.length; feedRendered++) {
    const it = st.feed[feedRendered];
    const node = buildFeedItem(it);
    node.dataset.fidx = feedRendered; // LLM 异步换文案时按此定位 DOM
    box.insertBefore(node, box.firstChild);
    // 回合分隔线:倒序布局里"越往下越旧",线放在该回合组末尾(组内最旧一条的下方),
    // 语义 = "以下进入更早的回合";此刻该条恰是已渲染内容中本组最旧的一条
    if (feedRendered === 0 || st.feed[feedRendered - 1].round !== it.round) {
      const d = document.createElement('div');
      d.className = 'sys-line';
      d.textContent = it.round === 0 ? '—— 开盘前 ——' : `—— 第 ${it.round} 回合 ——`;
      box.insertBefore(d, node.nextSibling);
    }
  }
  while (box.children.length > 120) box.removeChild(box.lastChild); // 长对局 DOM 上限(删最旧的底部)
  // 最新在顶部:玩家在顶部=追最新;下翻看历史时,顶部悬浮按钮提示新动态
  const nearTop = box.scrollTop < 240;
  if (nearTop) {
    box.scrollTop = 0;
  } else {
    const added = feedRendered - before;
    if (added > 0) {
      feedNewCount += added;
      const b = $('feed-new');
      if (b) { b.textContent = '↑ ' + feedNewCount + ' 条新动态'; b.classList.remove('hidden'); }
    }
  }
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
  $('end-body').textContent = fillStock(info.body);
  const assets = st.cash + e.chipsLeft * e.finalPrice;
  $('end-stats').innerHTML = `
    <div><label>套现所得</label><b>${fmtYi(e.realized)}</b></div>
    <div><label>出货比例</label><b>${Math.round(e.soldRatio * 100)}%</b><i class="est-note">口径:累计卖出 / 累计买入${e.chipsLeft > 0.01 ? ' · 剩余 ' + fmtShares(e.chipsLeft) + ' 已按终价折算' : ''}</i></div>
    <div><label>终局股价</label><b>${e.finalPrice.toFixed(2)} 元</b></div>
    <div><label>期末总资产</label><b>${fmtYi(assets)}</b></div>`;
  renderTransMap();
  renderVaccines();
  renderGallery(e.key);
  aiEpitaph(info, e);
  $('end-screen').classList.remove('hidden');
}
/* P2:AI 结案陈词——读本局操作记录生成个性化复盘,失败静默保留原结局文案 */
function aiEpitaph(info, e) {
  if (!(hasByok() || (window.ZR && window.ZR.llm))) return;
  const box = $('end-ai');
  if (!box) return;
  jpostJSON('/api/llm/epitaph', {
    ending: info.title + '——' + info.sub,
    summary: manipSummary(),
    stats: '历时' + Math.min(st.round, CONFIG.totalRounds) + '回合,套现' + fmtYi(e.realized) + ',出货' + Math.round(e.soldRatio * 100) + '%,终价' + e.finalPrice.toFixed(2) + '元,监管关注度' + Math.round(e.reg),
  }).then(r => {
    if (!r || !r.text || !st || !st.ended) return;
    box.innerHTML = '<span class="ea-tag">AI 结案陈词 · 虚构</span>' + esc(r.text);
    box.classList.remove('hidden');
  }).catch(() => { /* 静默降级 */ });
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
  lines.push(`${STOCK.name}(${STOCK.code}·虚构) · 历时 ${playedRounds} 回合 · 监管关注度 ${Math.round(e.reg)}/100`);
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
