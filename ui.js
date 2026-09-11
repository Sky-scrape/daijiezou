'use strict';
/* ui.js —— DOM 表现层。所有可玩性数值都在 game.js(数值层)。 */

let st = null;
let feedRendered = 0;
let debtToastShown = false;   // 负现金提醒:跌破触发一次,回正后重置
let fundSel = null; // {kind:'buy'|'sell', key, amt}
let kolTarget = null;

const $ = (id) => document.getElementById(id);

/* 数值变化高亮:值变了的数字闪一次底色,让"哪个数动了"一眼可见。
 * CSS 侧 .val-bump/.warn 已预埋(style.css);同值不闪,强制重排保证连闪可重放。 */
function bump(el, txt, warn) {
  if (!el) return;
  const t = String(txt);
  if (el.textContent === t) return;
  el.textContent = t;
  el.classList.remove('val-bump', 'warn');
  void el.offsetWidth;
  el.classList.add('val-bump');
  if (warn) el.classList.add('warn');
}

/* ---------------- 启动 ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  $('round-total').textContent = CONFIG.totalRounds;
  $('btn-start').addEventListener('click', onBtnStart);
  initCustomStockUI();
  initCsTraitPreview();
  initApiCfgUI();
  $('btn-endturn').addEventListener('click', onEndTurn);
  // 像素居民:点击弹出定向动作面板(安抚/情报/跳转居民生态)
  const pxc = $('px-col');
  if (pxc) pxc.addEventListener('click', (e) => { if (e.target.closest('.px-av')) openPxAct(); });
  $('btn-px-pacify').addEventListener('click', () => {
    const r = pacifyResident(st, pxActId);
    toast(r.msg, r.ok ? 'gold' : 'bad');
    if (r.ok) { closeModal('px-act'); renderAll(); }
  });
  $('btn-px-intel').addEventListener('click', () => {
    const r = intelResident(st, pxActId);
    if (r.ok && r.intel) {
      const i = r.intel;
      $('pxa-intel').textContent = `🔍 情报:情绪 ${i.v} · 唤醒 ${i.a} · 置信 ${i.c} · 手现金约 ${fmtYi(i.cash)} —— 下回合预计买入约 ${i.estBuy} 万股(未计大V恰饭加成)。`;
      $('pxa-intel').classList.remove('hidden');
      renderAll();
    } else toast(r.msg, 'bad');
  });
  $('btn-px-residents').addEventListener('click', () => { closeModal('px-act'); setFeedTab('residents'); const row = document.querySelector('.res-followee, .res-persona'); if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  $('btn-px-close').addEventListener('click', () => closeModal('px-act'));
  document.querySelectorAll('.fund-btn[data-fund]').forEach(b => b.addEventListener('click', () => onFund(b.dataset.fund)));
  $('btn-fund-cancel').addEventListener('click', () => closeModal('fund-modal'));
  $('btn-fund-confirm').addEventListener('click', onFundConfirm);
  $('fund-slider').addEventListener('input', onFundSlider);
  $('btn-fund-adv').addEventListener('click', onFundAdvisor);
  // 通道对比行点击切换(事件委托:行随 estimate 重渲染)
  $('fund-channels').addEventListener('click', (e) => {
    const row = e.target.closest('.fund-ch-row');
    if (row) switchChannel(row.dataset.ch);
  });
  // 撤销挂单:回执上的 ✕(事件委托,renderPending 反复重建节点)
  $('pending-box').addEventListener('click', (e) => {
    const b = e.target.closest('.pd-cancel');
    if (!b || !st || st.ended) return;
    if (b.dataset.pc === 'buy') st.pendingBuy = null; else st.pendingSell = null;
    toast('已撤销' + (b.dataset.pc === 'buy' ? '买入' : '卖出') + '挂单(尚未结算,无损失)。');
    renderAll();
  });
  // 点遮罩关闭弹窗:仅限"可安全退出"的白名单;抉择/天赋必须做出选择,结局页是复盘不可误关
  document.addEventListener('mousedown', (e) => {
    const ov = e.target.classList && e.target.classList.contains('overlay') ? e.target : null;
    if (!ov || ov.classList.contains('hidden')) return;
    if (!(ov.id in OVERLAY_CLICK_CLOSE)) return;
    closeModal(ov.id);
    const after = OVERLAY_CLICK_CLOSE[ov.id];
    if (after) after();
  });
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
  $('btn-share-download').addEventListener('click', shareCardPNG);
  $('btn-share-copy').addEventListener('click', () => {
    const text = buildFlexText();
    const done = () => toast('炫耀文案已复制,配上晒单图发群里。', 'gold');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    else fallbackCopy(text, done);
  });
  // 开始页规则折叠:展开时按左栏剩余高度现算滚动上限(闭合态由 details 原生隐藏,JS 不碰显示类型)
  const rf = document.getElementById('rules-fold');
  if (rf) rf.addEventListener('toggle', () => {
    const rs = rf.querySelector('.rules-scroll');
    if (!rs) return;
    // 窄档(手机)卡片是自然高度、整页可滚,规则区不限高(限了反而只剩 140px 小窗)
    if (!rf.open || window.matchMedia('(max-width: 680px)').matches) { rs.style.maxHeight = ''; return; }
    const brief = rf.closest('.sc-brief');
    const summary = rf.querySelector('summary');
    const gap = parseFloat(getComputedStyle(brief).rowGap || getComputedStyle(brief).gap) || 0;
    const used = [...brief.children].filter(el => el !== rf).reduce((t, el) => t + el.offsetHeight, 0);
    const avail = brief.clientHeight - used - gap * (brief.children.length - 1) - summary.offsetHeight - 8;
    rs.style.maxHeight = Math.max(140, Math.floor(avail)) + 'px';
  });
  $('btn-residents').addEventListener('click', () => setFeedTab('residents'));
  document.querySelectorAll('.feed-tab').forEach(b => b.addEventListener('click', () => setFeedTab(b.dataset.ftab)));
  $('btn-zhida').addEventListener('click', onAdvisor);
  $('zhida-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') onAdvisor(); });
  document.querySelectorAll('.op-btn').forEach(b => b.addEventListener('click', () => onOpinion(b.dataset.op)));
  // 公司资料展开时市场卡按内容撑高(CSS :has 为主,此处兜底不支持 :has 的旧浏览器)
  const cf = $('company-fold');
  if (cf) cf.addEventListener('toggle', () => { const card = cf.closest('.market-card'); if (card) card.classList.toggle('grow-open', cf.open); });
  $('btn-kol-confirm').addEventListener('click', () => onOpinion('kol', true));
  // 发帖角度面板:三项 = game.js POST_ANGLES;记住上次角度,下次「发帖」一键直发
  const postBox = $('post-angles');
  if (postBox) {
    Object.entries(POST_ANGLES).forEach(([id, a]) => {
      const b = document.createElement('button');
      b.className = 'dc-opt';
      b.innerHTML = `<span class="dc-label">📣 ${esc(a.name)}</span><span class="dc-hint">${esc(a.hint)}</span>`;
      b.onclick = () => { rememberAngle(id); closeModal('modal-post'); onOpinion('post', true, id); };
      postBox.appendChild(b);
    });
    $('btn-post-cancel').addEventListener('click', () => closeModal('modal-post'));
  }
  bindOpPreview();
  window.addEventListener('resize', () => { if (st && !st.ended) renderMarket(); });
  // Esc 关闭可安全退出的弹窗(抉择事件必须二选一,不响应 Esc)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    ['fund-modal', 'modal-trait', 'modal-api', 'modal-post', 'px-act', 'modal-preset'].forEach(id => {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) {
        closeModal(id);
        if (id === 'fund-modal') fundSel = null;
      }
    });
  });
  // 手机长按释义:触摸设备上 title 悬停不可达(玩家实测反馈),长按 0.5s 把释义打进 toast;
  // 已触发释义的触摸在 touchend 阶段拦截合成 click,避免"想看说明却误发帖"
  if (matchMedia('(hover: none)').matches) {
    let lpTimer = null, lpFired = false;
    const LP_SEL = '.op-btn, .fund-btn, .meter, .btn-res, .pool-row label, .pos-line span, #btn-zhida, .feed-note';
    document.addEventListener('touchstart', (e) => {
      const el = e.target.closest(LP_SEL);
      if (!el) return;
      lpFired = false;
      lpTimer = setTimeout(() => {
        const t = el.getAttribute('title');
        if (!t) return;
        lpFired = true;
        if (navigator.vibrate) navigator.vibrate(30);
        toast(t);
      }, 500);
    }, { passive: true });
    document.addEventListener('touchend', (e) => {
      clearTimeout(lpTimer);
      if (lpFired) { e.preventDefault(); lpFired = false; }   // 拦掉长按后的误点击
    }, { passive: false });
    ['touchmove', 'touchcancel'].forEach(ev =>
      document.addEventListener(ev, () => clearTimeout(lpTimer), { passive: true }));
  }
  // 自动演示:?autoplay=1 直接开局(无需再点「开始操盘」);加 &fast=1 倍速跑完
  if (location.search.includes('autoplay')) startGame(TRAITS[randInt(0, TRAITS.length - 1)].id);
});
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
/* 点遮罩可安全关闭的弹窗白名单(值为关闭后的清理动作):
 * 抉择/天赋必须做出选择,开始页/结局页是整屏覆盖层 —— 均不响应点遮罩。 */
const OVERLAY_CLICK_CLOSE = {
  'fund-modal': () => { fundSel = null; },
  'modal-api': () => closeModelMenu(),
  'modal-post': null,
  'px-act': null,
  'modal-preset': null,
};

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
  // 程序化赋值(随机灵感/AI助写/恢复存档)也要触发 input:基因图谱预览只听 input 事件,
  // 不派发的话换公司后图谱纹丝不动(实测踩过)
  ['cs-name', 'cs-code', 'cs-topic', 'cs-blurb'].forEach(id => {
    const el = $(id);
    if (el) el.dispatchEvent(new Event('input', { bubbles: true }));
  });
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
  $('btn-cs-preset').addEventListener('click', openPresetPicker);
  $('btn-preset-cancel').addEventListener('click', () => closeModal('modal-preset'));
}

/* ---------------- 梗味公司预设(开局第一分钟的体验) ----------------
 * 纯展示层文案包:走与「随机灵感」完全相同的 csSetFields 管道,
 * 基因图谱由 input 事件自动重推;预设文案已按基因关键词表定向命中,
 * 20 条踩满全部 18 个共振基因(另有 2 条无共振的普通组合;genes 字段是展示用预判,实际以引擎推导为准)。 */
const MEME_PRESETS = [
  { name: '雪糕刺客', code: '886664', topic: '网红雪糕 零售冰柜刺客', genes: '民生消费 × 饥饿营销',
    quip: '冰柜里的价格恐怖片',
    blurb: '潜伏在便利店与零售冰柜最深处的国货之光,常年缺货,黄牛代排队。我们从不主动标价——敢把定价权交给心跳的人,才配叫刺客。今夏限量发售,先到先尝,尝完再说。' },
  { name: '直播间的心动', code: '888203', topic: '直播电商 心动讨债现场', genes: '泛娱乐文旅 × 资本故事 → 流量赌场',
    quip: '钱包的心动过速专科门诊',
    blurb: '3、2、1,上链接!一场直播让三千万人心动、让钱包心律不齐。成立一年完成三轮融资,估值 30 亿,爱豆推荐全网首发,不买就是错过一个亿。' },
  { name: 'AI概念贩子', code: '888001', topic: '把一切生意用 AI 重讲一遍', genes: '硬科技 × 资本故事 → 泡沫制造机',
    quip: '万物皆可 AI,包括本条',
    blurb: '主营业务:把一切传统生意用 AI 重新讲一遍,包括这门生意本身。已完成 B 轮融资,估值 20 亿,计划三年上市。核心资产:四十页 PPT,和一个会画大模型架构图的实习生。' },
  { name: '联名狂魔', code: '888336', topic: '盲盒国潮 万物皆可联名', genes: '新消费潮牌 × 饥饿营销',
    quip: '一年联名 108 次,厂牌都怕我',
    blurb: '今年联名 108 次:雪糕配烤肠,奶茶配老陈醋,老字号配盲盒。每一次都限量首发,每一次三秒售罄,排队的黄牛比粉丝还多。国潮的尽头是联名,联名的尽头是断货。' },
  { name: '县城咖啡之光', code: '887779', topic: '9块9现磨 咖啡平权运动', genes: '民生消费 × 亲民叙事 → 国民品牌',
    quip: '小镇青年的咖啡平权运动',
    blurb: '把 9 块 9 的现磨咖啡开进一千个县城,让小镇青年实现咖啡自由。我们相信好咖啡不该有门槛,每个人都喝得起的生活,才是真正美好的生活。' },
  { name: '熬夜救星', code: '885120', topic: '临床级毛囊焕活疗法', genes: '生物医药 × 技术立司 → 论文战线',
    quip: '秃头程序员的最后一根稻草',
    blurb: '献给每一个用头发换方案的人。自研毛囊焕活配方,首席科学家带队,实验室数据已整理成论文,二期临床筹备中。秃,是这个时代最后的顽疾;而我们,是最后的答案。' },
  { name: '挖掘机之光', code: '884206', topic: '工程机械 训练营顺便上市', genes: '重资产制造 × 资本故事 → 白手套',
    quip: '工程机械界的扫地僧',
    blurb: '别人教挖掘机,我们造挖掘机,顺便完成了 C 轮融资。工程机械行业训练营,学员遍布东南亚工地。本轮融资估值 15 亿,对赌三年后开工率翻番——工地的,不是餐厅的。' },
  { name: '颜值管理局', code: '883568', topic: '医美连锁 变美像充话费', genes: '医美健康 × 资本故事 → 颜值期货',
    quip: '让变美像充话费一样简单',
    blurb: '没有丑生意,只有懒生意。医美连锁、轻医美、会员制三线并进,让变美像充话费一样简单。已完成 B 轮融资,估值 25 亿,下一步把标准化的美开进每座写字楼的负一层。' },
  { name: '硅基良心', code: '889120', topic: '开源芯片 指令集自研', genes: '硬科技 × 技术立司 → 技术信仰',
    quip: '把芯片卖成白菜,是我们的行为艺术',
    blurb: '首席架构师带队,自研指令集专利一百多项,实验室的灯永远为开源社区亮着。我们相信,把底层技术写给所有人,才是这个时代该有的浪漫。' },
  { name: '回春堂生物', code: '882460', topic: '抗衰老特效药 口服焕活', genes: '生物医药 × 资本故事 → 神药神话',
    quip: '青春不能重来,但可以按瓶复购',
    blurb: '完成 D 轮融资,估值 80 亿,经销商打款排到后年。抗衰老的故事是这个时代最硬的硬通货——我们的故事,比配方还值钱。' },
  { name: '打投家族', code: '886789', topic: '养成系偶像综艺 全民制作人', genes: '泛娱乐文旅 × 亲民叙事 → 全民偶像',
    quip: '一票一票,把哥哥投上青云',
    blurb: '我们相信每一次打投都是陪伴,把美好还给每一个平凡人的青春。家族连开十场巡演,只为你挥一下灯牌。' },
  { name: '慢充电', code: '881208', topic: '固态电池 量产装备交付', genes: '重资产制造 × 技术立司 → 工匠门槛',
    quip: '别人三年上市,我们二十年磨一条产线',
    blurb: '二十年只研发一种电解质配方,实验室里跑着三万次充放循环的老电池。工程师说,慢就是快,稳就是远。' },
  { name: '铁幕重工', code: '884010', topic: '军工外贸 相控阵雷达', genes: '军工防务 × 资本故事 → 军贸故事',
    quip: '行情越神秘,故事越值钱',
    blurb: 'B 轮融资到账,估值 60 亿,海外订单排到 2030 年。能讲的都在招股书里,不能讲的,签了保密协议。' },
  { name: '铸剑车间', code: '883016', topic: '国防装备 特种焊接材料', genes: '军工防务 × 技术立司 → 国之重器',
    quip: '焊缝即国境,公差即尊严',
    blurb: '首席焊接工程师带队,三百项工艺专利锁在保险柜里。大国重器不赶工期,慢工出的都是细活。' },
  { name: '迷彩行囊', code: '887712', topic: '军品户外 背包民用版', genes: '军工防务 × 亲民叙事 → 军民鱼水',
    quip: '翻过山的人,都认这个标',
    blurb: '把军用品质装进每个人的周末,陪伴每一次翻山越岭。背上它,家里人都放心——这是最高的验收标准。' },
  { name: '喵顶流', code: '889901', topic: '宠物国潮 猫抓板盲盒', genes: '新消费潮牌 × 资本故事 → 网红经济',
    quip: '流量在猫这边,预算在你这边',
    blurb: 'A 轮融资 5 亿,估值 30 亿。全网两亿粉丝的猫,身价超过一线明星——主子营业,铲屎官买单。' },
  { name: '吃谷自由', code: '888520', topic: '谷子店 二次元周边集合', genes: '新消费潮牌 × 亲民叙事 → 粉圈经济',
    quip: '痛包越痛,人生越满',
    blurb: '为每个热爱收集的灵魂留一盏灯,让热爱被认真对待。吧唧、立牌、小卡,陪伴你把热爱过成日常。' },
  { name: '售罄社', code: '886001', topic: '手办厂牌 预售即售罄', genes: '新消费潮牌 × 低调神秘 → 刻意断货',
    quip: '库存是商业机密,补货是都市传说',
    blurb: '不补货,爱要不要。' },
  { name: '深巷面霜', code: '882030', topic: '护肤私域 贵妇面霜', genes: '医美健康 × 低调神秘 → 私域口碑',
    quip: '地址保密,只留给懂的人',
    blurb: '熟客专享,不外售。' },
  { name: '成分警察', code: '887340', topic: '功效护肤 全成分公开', genes: '医美健康 × 技术立司 → 医研共创',
    quip: '全成分表,敢印在瓶身上',
    blurb: '首席配方师出自三甲皮肤科,每款产品附人体功效报告,实验室数据公开到批号——成分党看了都说硬。' },
];
function openPresetPicker() {
  const box = $('preset-cards');
  box.innerHTML = MEME_PRESETS.map((p, i) =>
    `<button class="preset-card" data-pi="${i}" type="button">` +
    `<b class="pc-name">${esc(p.name)} <small>${esc(p.code)}</small></b>` +
    `<span class="pc-topic">${esc(p.topic)}</span>` +
    `<span class="pc-genes">🧬 ${esc(p.genes)}</span>` +
    `<span class="pc-quip">「${esc(p.quip)}」</span>` +
    `<span class="pc-use">用这家开局 →</span></button>`).join('');
  box.querySelectorAll('.preset-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = MEME_PRESETS[Number(btn.dataset.pi)];
      csSetFields(p);
      closeModal('modal-preset');
      csMsg('🧬 已填入预设「' + p.name + '」——基因图谱已按题材与简介重推,可继续手改或直接开局。', true);
      $('cs-panel').classList.remove('hidden');
    });
  });
  openModal('modal-preset');
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
    $('cs-blurb').value = String(data.text).slice(0, 300);
    csMsg('✨ AI 已生成公司介绍,可以自由修改。', true);
  } catch (e) {
    $('cs-blurb').value = genLocalBlurb(check.value.name, check.value.topic).slice(0, 300);
    csMsg(aiFallbackMsg(e), true);
  } finally {
    csAiBusy = false;
    btn.textContent = old;
    btn.disabled = false;
  }
}

/* ---------------- 公司基因(名字/题材/简介 → 确定性数值特质) ----------------
 * 开始页实时预览 + 资料卡全程可见:写什么简介,就是选什么开局 buff。 */
function geneChipsHTML(g) {
  const a = ARCHETYPES[g.arch];
  const t = toneDefOf(g);
  let html = '';
  if (g.arch !== 'diversified') html += `<span class="gene-chip" data-gtip="${esc(a.name)}" data-gtip-type="赛道基因" data-gtip-desc="${esc(a.desc)}">🧬 ${esc(a.name)}</span>`;
  if (t) html += `<span class="gene-chip gene-tone" data-gtip="${esc(t.name)}" data-gtip-type="叙事基因" data-gtip-desc="${esc(t.desc)}">📜 ${esc(t.name)}</span>`;
  const combo = GENE_COMBOS.find(c => c.arch === g.arch && c.tone === g.tone);
  if (combo) html += `<span class="gene-chip gene-combo" data-gtip="${esc(combo.name)}" data-gtip-type="共振基因" data-gtip-desc="${esc(combo.desc)}">✦ ${esc(combo.name)}</span>`;
  return html;
}
/* 基因芯片悬停简介(body 级浮层):开始页基因实验室与游戏内资料卡共用一份委托,
 * 不受任何 overflow 祖先裁切;芯片由 innerHTML 重建也不受影响(监听挂 document)。 */
const GTIP_TYPE_CLS = { '赛道基因': 'gt-arch', '叙事基因': 'gt-tone', '共振基因': 'gt-combo' };
(function () {
  let tipEl = null;
  function hide() { if (tipEl) { tipEl.remove(); tipEl = null; } }
  function show(el) {
    const name = el.dataset.gtip, type = el.dataset.gtipType, desc = el.dataset.gtipDesc;
    if (!name || !desc) return;
    hide();
    tipEl = document.createElement('div');
    tipEl.className = 'gene-tip';
    const cls = GTIP_TYPE_CLS[type] || '';
    tipEl.innerHTML = '<b>' + esc(name) + '</b><i class="' + cls + '">' + esc(type || '') + '</i>' + esc(desc);
    document.body.appendChild(tipEl);
    const r = el.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
    let y = r.top - t.height - 8;
    if (y < 8) y = r.bottom + 8;   // 顶上放不下就翻到芯片下方
    tipEl.style.left = x + 'px';
    tipEl.style.top = y + 'px';
  }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-gtip]');
    if (el) show(el); else hide();
  });
  window.addEventListener('scroll', hide, true);
})();
function renderCsTraits() {
  const box = $('cs-traits');
  if (!box) return;
  const g = deriveCompanyTraits($('cs-name').value.trim(), $('cs-topic').value.trim(), $('cs-blurb').value.trim());
  box.innerHTML = geneChipsHTML(g) || '<span class="cs-traits-hint">试试改改题材或简介——不同的写法会解锁不同的「公司基因」加成</span>';
}
function initCsTraitPreview() {
  ['cs-name', 'cs-topic', 'cs-blurb'].forEach(id => { const el = $(id); if (el) el.addEventListener('input', renderCsTraits); });
  renderCsTraits();
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
  hotPromo = null; hotPeak = null;   // 热榜战绩只属于本局
  $('start-screen').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('stock-chip').textContent = STOCK.name + ' ' + STOCK.code;
  renderCompanyCard();
  const chips = $('kol-chips');
  kolTarget = st.kols[0].id;   // 先定默认目标,再渲染候选卡:首局就有一枚高亮,而不是空选
  chips.innerHTML = st.kols.map(k => `<button type="button" class="kol-chip${k.id === kolTarget ? ' sel' : ''}" data-id="${k.id}"><img src="assets/px/${k.id}.png" alt="${esc(k.name)}"><span><b>${esc(k.name)}</b><small>${k.tag} · ${k.followers}关注</small></span></button>`).join('');
  chips.querySelectorAll('.kol-chip').forEach(b => b.addEventListener('click', () => {
    kolTarget = b.dataset.id;
    chips.querySelectorAll('.kol-chip').forEach(x => x.classList.toggle('sel', x === b));
  }));
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
  // 聊天记录随新局重置,刘看山·看盘版开场打个招呼(面板藏在「AI 生态」标签里,给它一个被发现的机会)
  const zpLog = $('zp-log');
  if (zpLog) {
    zpLog.innerHTML = '<div class="zp-empty"><img class="zp-empty-ava" src="assets/liukanshan/greet.gif?v=20260910g" alt="" width="76" height="76">和刘看山·看盘版聊聊盘面:问「现在该出货吗」「什么是T+1」……</div>';
    zpAdd('ai', '第 1 回合开盘。你的底仓成本 3.10,现价 ' + st.price.toFixed(2) + '。想问什么尽管问——比如「现在该出货吗」。');
  }
  renderAll();
  toast('第 1 回合开始。' + (traitDef ? '【' + traitDef.name + '】已生效。' : '') + '吸筹要低调,市场还没有注意到你。行动指南:先造热度,等买盘池变深,再分批出货;监管条是倒计时。');
  if (location.search.includes('autoplay')) autoDemo();
}

/* 公司资料卡(盘面):展示玩家自定义/AI 生成的虚构公司简介 + 公司基因 */
function renderCompanyCard() {
  const fold = $('company-fold');
  if (!fold) return;
  $('company-fold-name').textContent = STOCK.name + ' ' + STOCK.code;
  const blurb = STOCK.blurb || genLocalBlurb(STOCK.name, STOCK.topic);
  const g = STOCK.traits || deriveCompanyTraits(STOCK.name, STOCK.topic, STOCK.blurb);
  const chips = geneChipsHTML(g);
  $('company-body').innerHTML =
    '<div class="cb-line"><b>' + esc(STOCK.name) + '</b>（' + esc(STOCK.code) + '·虚构）· ' + esc(STOCK.exchange) + '</div>' +
    '<div class="cb-line">主营:' + esc(STOCK.topic) + '</div>' +
    (chips ? '<div class="cb-traits">' + chips + '</div>' : '') +
    '<p class="cb-blurb">' + esc(blurb) + '</p>' +
    '<div class="cb-note">以上资料由玩家设定或 AI 生成,纯属虚构,不构成投资建议。基因特质实时生效:悬停查看效果。</div>';
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

/* ---------------- AI 军师(刘看山·看盘版) + 状态摘要 ----------------
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
  // 公司基因注入:AI 军师/AI 事件据此贴合玩家自己设定的公司与赛道
  const A = ARCHETYPES[ctrait().arch];
  const td = toneDefOf(ctrait());
  return '股票:' + STOCK.name + '(' + STOCK.code + ',全虚构)'
    + ';主营:' + STOCK.topic
    + ';赛道:' + A.name + '(' + A.desc + ')'
    + (td ? ';公司叙事:' + td.name : '')
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
  return '刘看山·看盘版(本地模式):热度' + heat + '/监管' + reg + '/买盘池≈' + fmtShares(pool) + '。基本节奏:低吸→造势→等池深→分批出货;监管是倒计时。(虚构游戏,不构成投资建议)';
}
let advisorBusy = false;
let advisorTurn = 0;   // 问答序号:后台补答只允许覆盖"自己这一问"的气泡,避免迟到的答案盖掉新提问
/* 聊天式记录:一条问答 = 一对气泡(你=右蓝,刘看山=左纸),按时间堆叠在输入框上方 */
function zpAdd(kind, text) {
  const log = $('zp-log');
  const empty = log.querySelector('.zp-empty');
  if (empty) empty.remove();
  const d = document.createElement('div');
  d.className = 'zp-msg ' + kind;
  d.innerHTML = '<span class="zp-who">' + (kind === 'ai' ? '<img class="zp-mini" src="assets/liukanshan/idle.gif?v=20260910g" alt="" width="14" height="14">刘看山·看盘版' : '你') + '</span><div class="zp-text"></div>';
  const body = d.querySelector('.zp-text');
  body.textContent = text;
  log.appendChild(d);
  while (log.children.length > 60) log.removeChild(log.firstChild);   // 聊天记录上限
  log.scrollTop = log.scrollHeight;
  return body;
}
function zpScroll() { const log = $('zp-log'); log.scrollTop = log.scrollHeight; }
async function onAdvisor() {
  if (advisorBusy || !st) return;
  const input = $('zhida-q'), btn = $('btn-zhida');
  const q = (input.value || '').trim();
  if (!q) return;
  input.value = '';
  advisorBusy = true;
  const myTurn = ++advisorTurn;
  btn.disabled = true; btn.textContent = '思考中…';
  zpAdd('me', q);
  const aiText = zpAdd('ai', '思考中…');
  try {
    if (hasByok() || (window.ZR && window.ZR.llm)) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);   // 网关抖动时宁可早降级,不让玩家盯着"思考中"干等
      const r = await jpostJSON('/api/llm/advisor', { q, state: stateDigest() }, { signal: ctl.signal });
      clearTimeout(timer);
      if (!r || !r.text) throw new Error('no text');
      if (advisorTurn === myTurn) { aiText.textContent = r.text; zpScroll(); }
    } else throw new Error('no-llm');
  } catch (e) {
    // 立即本地兜底,玩家零等待;直答在后台补,回来再替换气泡内容(仅当还是同一问且未被新答案占用)
    if (advisorTurn === myTurn) { aiText.textContent = localAdvisor(q) + '(本地速答)'; zpScroll(); }
    if (window.ZR && window.ZR.zhida) {
      const ctl2 = new AbortController();
      const t2 = setTimeout(() => ctl2.abort(), 8000);
      jpostJSON('/api/zhihu/zhida', { q }, { signal: ctl2.signal })
        .then(r2 => { clearTimeout(t2); if (r2 && r2.answer && advisorTurn === myTurn) { aiText.textContent = r2.answer + '(知乎直答)'; zpScroll(); } })
        .catch(() => clearTimeout(t2));
    }
  }
  advisorBusy = false;
  btn.disabled = false; btn.textContent = '问刘看山·看盘版';
}

/* ---------------- 主渲染 ---------------- */
function renderAll() {
  renderTop();
  renderMarket();
  renderActions();
  renderFeed();
  renderPxStrip();
  renderHotstrip();
  renderLikeBridge();
  if (feedTab === 'residents') $('res-inline').innerHTML = renderResidentsHTML(); // 情绪每回合演化,面板保持实时
}

/* 赞同→买盘桥(显示层):把「赞同会变成钱」这个本作核心命题,用累计赞同数明示出来。
 * 只读 st.feed 点赞数做聚合叙事,不碰引擎;放 feed 头部说明行,零高度成本。 */
function renderLikeBridge() {
  let likeSum = 0;
  for (const it of st.feed) likeSum += (it.likes || 0);
  const fn = $('feed-cnt');
  if (fn) {
    fn.textContent = 'AI居民:' + st.kols.length + '位大V + ' + st.retails.length + '位散户 · 累计 ' + fmtN(likeSum) + ' 赞同化作买盘';
    fn.title = '赞同是舆论的记分牌:社区每一点赞,都沿着「情绪 → 买盘池」变成真金白银。';
  }
}

/* ---------------- 热搜榜联动(真实知乎热榜 × 盘面衍生话题) ----------------
 * 真实热榜条目(zhihu.js 缓存到 ZR_HOT)做底,玩家公司的舆论按盘面状态混排进榜:
 * 位次随热度浮动(造势=爬榜,压过真实热点),买热搜=「推广」位顶榜并随回合衰减,
 * 榜上话题可点击锚定 feed 原帖。只读 st.heat/board/halted/rumorPending/feed,纯展示层。 */
let hotPromo = null;   // 买热搜:{title, until} —— until = 最后在场的回合号,钱一停就沉底
let hotPeak = null;    // 本局最好成绩:{rank, title, round}(只统计自然话题,推广位不算战绩)
const PROMO_TOPICS = [
  '神秘资金异动,{s}在酝酿什么?',
  '{s}凭什么这么强?谁在买,谁在接?',
  '深度研判:重估{s}的三个理由',
  '十个基金经理,九个在聊{s}',
  '{s}冲上同城热搜,营业部排起长队',
];
function hotGameEntries() {
  const name = STOCK.name, arr = [];
  const add = (title, cls, score, fidx) => arr.push({ title, cls, score, fidx: fidx == null ? -1 : fidx });
  const fresh = it => st.round - (it.round || 0) <= 1;   // 本回合与上一回合产生的帖子才够新
  if (hotPromo && st.round <= hotPromo.until) add(hotPromo.title, 'hs-promo', 1e9, -1);
  else hotPromo = null;
  if (st.halted) add(name + '无故临停,股吧炸锅', 'hs-rumor', st.heat + 6, -1);
  else if (st.board >= 2) add(name + ' ' + cnNum(st.board) + '连板,谁在卖谁在买?', 'hs-hot', st.heat + 10, -1);
  if (st.rumorPending) add('曝' + name + '遭神秘资金盯上,真假待核实', 'hs-rumor', st.heat + 15, -1);
  for (const it of st.feed) {
    if (!fresh(it)) continue;
    const fidx = st.feed.indexOf(it);
    if (it.title === '传闻证实') add(name + '传闻坐实,信的人赢麻了', 'hs-hot', st.heat + 12, fidx);
    else if (it.title === '官方辟谣') add(name + '官方辟谣,谣言是怎么飞起来的', 'hs-rumor', st.heat + 5, fidx);
    else if (it.tag === '龙虎榜') add(name + '登上龙虎榜,席位现形', '', st.heat + 8, fidx);
    else if (it.tag === '财报') add(name + '业绩出炉,卖方连夜改目标价', '', st.heat + 6, fidx);
    else if (it.type === 'writer' && (it.likes || 0) >= 1200) add(name + '的小作文刷屏了', '', st.heat + 4, fidx);
  }
  if (!st.halted && st.heat >= 45) add('为什么所有人都在聊' + name + '?', '', st.heat, -1);
  return arr;
}
function renderHotstrip() {
  const strip = $('hotstrip');
  if (!strip || !st || st.ended) return;
  const real = (window.ZR_HOT || []).slice(0, 8);
  const games = hotGameEntries().sort((a, b) => b.score - a.score);
  if (!real.length && !games.length) { strip.classList.remove('on'); return; }
  // 混排:真实条目按固定衰减分(100,96,92…)插位——公司话题分=热度加成,热度够高直接登顶
  const merged = real.map((t, i) => ({ title: t, cls: '', fidx: -1, score: 100 - i * 4 }))
    .concat(games).sort((a, b) => b.score - a.score).slice(0, 13);
  let html = '<span class="hs-badge">知乎热榜</span>';
  merged.forEach((m, i) => {
    const rank = i + 1;
    if (m.cls && m.cls !== 'hs-promo' && (!hotPeak || rank < hotPeak.rank)) hotPeak = { rank, title: m.title, round: st.round };
    html += '<span class="hs-item' + (m.cls ? ' ' + m.cls : '') + (rank <= 3 ? ' hs-top' : '') + '"' +
      (m.fidx >= 0 ? ' data-hf="' + m.fidx + '"' : '') + (m.cls === 'hs-promo' ? ' data-promo="1"' : '') +
      '><i class="hs-rank">' + rank + '</i>' + esc(m.title) +
      (m.cls === 'hs-promo' ? '<i class="hs-ptag">推广</i>' : '') + '</span>';
  });
  strip.innerHTML = html;
  strip.classList.add('on');
  if (!strip.dataset.wired) {
    strip.dataset.wired = '1';
    strip.addEventListener('click', e => {
      const it = e.target.closest('.hs-item');
      if (!it || !st || st.ended) return;
      if (it.dataset.promo) { toast('📌 这是花钱买的「推广」位——真热榜同款生态,钱一停就沉。'); return; }
      const f = it.dataset.hf;
      if (f == null) { toast('这条话题散在舆论场里,还没有可以被围观的原帖。'); return; }
      if (feedTab !== 'feed') setFeedTab('feed');
      const node = document.querySelector('#feed .feed-item[data-fidx="' + f + '"]');
      if (!node) { toast('热度还在,但那条帖已经沉底了。'); return; }
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      node.classList.remove('hs-flash');
      void node.offsetWidth;
      node.classList.add('hs-flash');
      setTimeout(() => node.classList.remove('hs-flash'), 1600);
    });
  }
}

/* ---------------- 像素居民(动态标签右侧,每回合点亮一位) ----------------
 * 长相由名字 hash 决定(同名同像),衣服颜色 = 人设类型,底部心情线 = 红看多/绿看空;
 * 选中规则在 game.js resolveRound:本回合个人买入最多的居民(无人买入则情绪最极端)。 */
const PX_CLOTH = { value: '#1a6fe8', boarder: '#7c4dff', suoha: '#e0342f', herd: '#0a9e58', student: '#d99a2b', sarcasm: '#6b7280', anxious: '#e07b2f', quant: '#0aa0c8' };
function pxAvatarSVG(p) {
  const h = strHash(p.name || '?');
  const skin = ['#ffe8d6', '#f6d4bd', '#e8c0a0'][h % 3];
  const [hairC, hairLite] = [['#3a3542', '#575066'], ['#5a3b22', '#7d5636'], ['#8a5a2f', '#ab7743'], ['#d9a441', '#eec46e'], ['#d9679f', '#f191bf'], ['#6b5a7e', '#8d7ba0']][(h >> 3) % 6];
  const [irisC, irisLite] = [['#ffb545', '#ffd98a'], ['#ff6fa5', '#ffa8c9'], ['#57b3ff', '#9dd2ff'], ['#3ecf8e', '#8ce8bd'], ['#a97fff', '#cbb2ff'], ['#ff7a5c', '#ffb09c']][(h >> 5) % 6];
  const accent = ['#ff6fa5', '#57b3ff', '#3ecf8e', '#ffb545', '#a97fff'][(h >> 7) % 5];
  const cloth = PX_CLOTH[p.persona] || '#1a6fe8';
  const mood = p.v > 20 ? '#e0342f' : p.v < -20 ? '#0a9e58' : '#c3cad6';
  const L = '#2a2430', W = '#ffffff', B = '#ff9eb0', m = '#c4574f', T = '#7fd4ff';
  // 20×20 大头特写(参考像素少女风):呆毛挑染+锯齿刘海+长侧发包脸+4×4多层大眼(睫毛/虹膜/下层浅色/眼中高光)+腮红+小嘴;情绪=表情(笑口/泪滴)
  const rows = [
    '.......AA...AA......',
    '.....HHHHHHHHHH.....',
    '...HHHHHHHHHHHHHH...',
    '..HHHHHHHHHHHHHHHH..',
    '..HHHHHHHHHHHHHHHH..',
    '..HHHHHAAHHHHHHHHH..',
    '..HHHHHHHHHHHHHHHH..',
    '..HHSSSSSSSSSSSSHH..',
    '..HS' + 'LLLL' + 'SSSS' + 'LLLL' + 'SH..',
    '..HS' + 'EEWE' + 'SSSS' + 'EEWE' + 'SH..',
    '..HS' + 'FFWF' + 'SSSS' + 'FFWF' + 'SH..',
    '..HS' + 'FFFF' + 'SSSS' + 'FFFF' + 'SH..',
    '..HSBBSSSSSSSSBBSH..',
    '..HSSSSSSSmmSSSSSH..',
    '...HSSSSSSSSSSSSH...',
    '..HHSSSSSSSSSSSSHH..',
    '...CCCCCCCCCCCCC....',
    '..CCCCCCCCCCCCCCCC..',
    '..CCCCCCCCCCCCCCCC..',
    'MMMMMMMMMMMMMMMMMMMM',
  ];
  const set = (r, c, ch) => { rows[r] = rows[r].slice(0, c) + ch + rows[r].slice(c + 1); };
  if (p.v > 20) {                              // 看多:咧嘴笑(嘴张开)
    set(13, 9, 'm'); set(13, 12, 'm'); set(14, 10, 'm'); set(14, 11, 'm');
  } else if (p.v < -20) {                      // 看空:左眼下一滴泪
    set(12, 8, 'T');
  }
  const col = { S: skin, H: hairC, G: hairLite, A: accent, L, E: irisC, F: irisLite, W, B, m, T, C: cloth, M: mood };
  let rects = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < 20) {                      // 同色游程合并成一个 rect(逐段扫描,不丢像素)
      const ch = row[x];
      if (ch === '.') { x++; continue; }
      let x2 = x + 1;
      while (x2 < 20 && row[x2] === ch) x2++;
      rects += `<rect x="${x}" y="${y}" width="${x2 - x}" height="1" fill="${col[ch]}"/>`;
      x = x2;
    }
  });
  return `<svg viewBox="0 0 20 20" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}
let pxLastPop = '';   // 只在"结算出新人"的那次渲染弹跳,同回合内反复重渲染不重播
let pxSayUntil = 0;   // 台词气泡的消失时刻
let pxInflight = null; // 正在生成形象的居民名(换人后旧响应作废)
const PXAI_KEY = 'djz_pxai_v1';
// GLM-Image 预生成的八大原型头像(assets/px/):基础居民直接用,零延迟零成本
const PX_STATIC = { value: 1, boarder: 1, suoha: 1, herd: 1, student: 1, sarcasm: 1, anxious: 1, quant: 1 };
const PX_LINES = {   // 登场台词:按人设的短句,气泡里说一句
  value: ['别人恐惧我贪婪。', '价值只会迟到,不会缺席。', '基本面没变,慌什么。'],
  boarder: ['这波风口不追是傻子!', 'All in 最新赛道!', '技术变革 Announcement 要来了。'],
  suoha: ['梭哈!明天就翻倍!', '要干就干大的!', '仓位就是态度!'],
  herd: ['大家买啥我买啥……', '都在喊多,那我也……', '跟着大部队总没错吧?'],
  student: ['第一次炒股,好紧张。', '生活费还剩三个月……', '老师说的都对。'],
  sarcasm: ['又是熟悉的配方。', '评论区整齐划一,危险。', '我见过太多次这种"行情"。'],
  anxious: ['睡不着了,真的。', '再跌我就要卸载软件了。', '手心全是汗。'],
  quant: ['信号灯刚亮,数据不会说谎。', '波动率有点不对劲。', '模型建议观望。'],
};
// GLM-Image 预生成的八大原型头像(assets/px/):基础居民直接用,零延迟零成本
const PX_PROMPT = {
  value: 'chibi anime elderly man portrait, gray hair, round glasses, calm confident smile, wearing dark suit and tie, head turned to the left side, three-quarter view facing left, looking toward the left',
  boarder: 'chibi anime young man portrait, trendy blue-dyed hair, headphones around neck, excited grin, wearing hoodie, facing the camera directly, frontal symmetrical view, looking at the viewer',
  suoha: 'chibi anime man portrait, slicked-back hair, ecstatic shouting expression, wearing bright red shirt, head turned to the left side, three-quarter view facing left, looking toward the left',
  herd: 'chibi anime girl portrait, ordinary brown ponytail, curious worried expression, wearing plain t-shirt, facing the camera directly, frontal symmetrical view, looking at the viewer',
  student: 'chibi anime college student portrait, messy short black hair, innocent wide sparkling eyes, wearing casual hoodie, head turned to the left side, three-quarter view facing left, looking toward the left',
  sarcasm: 'chibi anime middle-aged man portrait, stubble chin, sly half-closed eyes, smirking, wearing old jacket, facing the camera directly, frontal symmetrical view, looking at the viewer',
  anxious: 'chibi anime woman portrait, messy hair bun, sweating and worried expression, biting lip, head turned to the left side, three-quarter view facing left, looking toward the left',
  quant: 'chibi anime geek portrait, black-rim glasses reflecting light, focused expression, wearing green hoodie, facing the camera directly, frontal symmetrical view, looking at the viewer',
};
function pxAICache() { try { return JSON.parse(localStorage.getItem(PXAI_KEY) || '{}'); } catch (e) { return {}; } }
function pxImgFail(name) {   // 生成图挂了(链接过期等):清缓存回退
  try { const c = pxAICache(); delete c[name]; localStorage.setItem(PXAI_KEY, JSON.stringify(c)); } catch (e) {}
  pxInflight = null;
  renderPxStrip();
}
function pxMaybeGenerate(p) {   // GLM-Image 为个性化居民(知乎分身/知友分身等)实时生成专属头像
  if (!(window.ZR && (window.ZR.llm || hasByok()))) return;
  if (pxInflight === p.name) return;
  pxInflight = p.name;
  const gender = strHash(p.name) % 2 ? 'girl' : 'boy';
  const expr = p.v > 20 ? 'happy cheering expression' : p.v < -20 ? 'sad teary expression' : 'calm expression';
  const desc = PX_PROMPT[p.persona] || 'ordinary retail investor';
  const prompt = desc + ', ' + gender + ', ' + expr + ', 16-bit retro pixel art style, head and shoulders bust portrait, pure white background, clean crisp pixels, no text';
  jpostJSON('/api/llm/image', { prompt }).then(out => {
    const src = out && (out.url || out.dataUrl);
    // 先归档再判断展示位:生成要 70s+,期间右下角换人是常态;结果按名缓存永远有价值。
    // 旧逻辑在换人后直接 return,把整次生成(连缓存写入)一起丢掉,下次展示还得重跑 70s。
    if (src) {
      const cache = pxAICache(); cache[p.name] = { src, at: Date.now() };
      try { localStorage.setItem(PXAI_KEY, JSON.stringify(cache)); } catch (e) {}   // 超配额就只留内存
    }
    if (pxInflight !== p.name) return;
    pxInflight = null;
    if (!src) return;
    renderPxStrip();
  }).catch(() => { if (pxInflight === p.name) pxInflight = null; });
}
function renderPxStrip() {
  const el = $('px-col');
  if (!el) return;
  el.classList.toggle('hidden', feedTab !== 'feed');
  const p = (st.pxLog || [])[st.pxLog.length - 1];   // 只显示最新一位:右下角一个固定小人,每回合切换形象
  if (!p) { el.innerHTML = ''; return; }
  const key = p.r + ':' + p.id;
  const fresh = key !== pxLastPop ? (pxLastPop = key, true) : false;
  const pose = p.v > 20 ? ' hype' : p.v < -20 ? ' glum' : '';
  const cached = pxAICache()[p.name];
  const personalized = p.isPersona || p.isFollowee;   // 知乎分身/知友分身:专属脸走运行时生成,不吃静态原型图
  const staticHit = !cached && !personalized && PX_STATIC[p.persona] && 'assets/px/' + p.persona + '.png';
  if (fresh) pxSayUntil = Date.now() + 4200;          // 新居民登场:头顶冒一句台词
  const title = `回合 ${p.r} · ${esc(p.name)}(${esc(p.tag || '')}) 情绪 ${p.v > 0 ? '+' : ''}${p.v} — ${p.v > 20 ? '看多欢呼中' : p.v < -20 ? '看空哆嗦中' : '观望中'};点击有动作`;
  let face, hasImg = false;
  if (cached && cached.src) {                     // 运行时 GLM-Image 专属形象(知乎分身等)
    face = `<img class="px-img" data-n="${esc(p.name)}" alt="${esc(p.name)}" src="${esc(cached.src)}" onerror="pxImgFail(this.dataset.n)"><i class="px-dot${pose}"></i>`;
    hasImg = true;
  } else if (staticHit) {                         // 八大原型:GLM-Image 预生成设计稿
    face = `<img class="px-img" alt="${esc(p.name)}" src="${staticHit}"><i class="px-dot${pose}"></i>`;
    hasImg = true;
  } else {
    face = pxAvatarSVG(p);                        // 手绘兜底(理论上走不到:原型全覆盖)
  }
  const say = Date.now() < pxSayUntil ? `<div class="px-say">${esc(pick(PX_LINES[p.persona] || ['……']))}</div>` : '';
  el.innerHTML = say + `<button type="button" class="px-av${hasImg ? ' has-img' : ''}${fresh ? ' pop' : ''}${pose}" title="${title}">${face}</button>`;
  if (!cached && !staticHit) pxMaybeGenerate(p);   // 无原型覆盖的个性化居民 → 运行时生成
}
/* 像素居民动作面板:安抚 / 情报 */
let pxActId = null;
function openPxAct() {
  const p = (st.pxLog || [])[st.pxLog.length - 1];
  if (!p) return;
  const n = st.retails.find(x => x.id === p.id);
  if (!n) return;
  pxActId = n.id;
  const face = $('pxa-face');
  face.onerror = () => {   // 缓存的签名 URL 过期/失效:回落静态原型图,面板不留破图
    face.onerror = null;
    face.src = 'assets/px/' + (PX_STATIC[n.persona] ? n.persona + '.png' : 'icon.svg');
  };
  face.src = document.querySelector('.px-av img.px-img') ? document.querySelector('.px-av img.px-img').src : 'assets/px/' + (PX_STATIC[n.persona] ? n.persona + '.png' : 'icon.svg');
  $('pxa-name').textContent = n.name;
  $('pxa-tag').textContent = (n.tag || '') + ' · 情绪 ' + Math.round(n.valence) + ' · 唤醒 ' + Math.round(n.arousal) + ' · 置信 ' + Math.round(n.confidence);
  $('pxa-intel').classList.add('hidden');
  $('pxa-note').textContent = '对 TA 使用定向手段——只影响这一位居民,不动全局。';
  openModal('px-act');
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
  const zp = $('zhida-panel');   // 问刘看山·看盘版:此标签页的唯一内容
  if (zp) zp.classList.toggle('hidden', !isEco);
  const nb = $('feed-new');
  if (nb && (isRes || isEco)) nb.classList.add('hidden');
  const pc = $('px-col');   // 像素居民列只在「动态」标签显示
  if (pc) pc.classList.toggle('hidden', t !== 'feed');
  if (isRes) $('res-inline').innerHTML = renderResidentsHTML();
}

let prevReg = null;   // 监管走高时数值闪红(warn 档)
function renderTop() {
  $('round-now').textContent = Math.min(st.round, CONFIG.totalRounds);
  $('bar-heat').style.width = clamp(st.heat, 0, 100) + '%';
  bump($('val-heat'), Math.round(clamp(st.heat, 0, 100)));  // 回合中段可短暂超100,显示按满格截断
  $('bar-reg').style.width = clamp(st.reg, 0, 100) + '%';
  bump($('val-reg'), Math.round(clamp(st.reg, 0, 100)), prevReg !== null && st.reg > prevReg);  // 与热度同:状态值可溢出(入狱判定需要),显示按满格截断
  prevReg = st.reg;
  bump($('wallet-cash'), fmtYi(st.cash));
  bump($('wallet-shares'), fmtShares(totalShares(st)));
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
  const fCnt = st.retails.filter(n => n.isFollowee).length;
  if (cnt) cnt.textContent = 'AI居民:' + st.kols.length + '位大V + ' + st.retails.length + '位散户' + (st.retails.some(n => n.isPersona) ? (personaDemo ? '(含虚构示例分身)' : '(含知乎原型·你)') : '') + (fCnt ? '(含' + fCnt + '位知友分身)' : '');
  // 财报日角标(第 5/10/15 回合收盘公布业绩,造势强度影响「超预期」概率)
  const ec = $('earn-chip');
  if (ec) ec.classList.toggle('hidden', !(st.round === 5 || st.round === 10 || st.round === 15));
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
  bump($('pool-val'), '≈ ' + fmtShares(pool));
  $('pos-sellable').textContent = fmtShares(sellableShares(st));
  $('pos-cost').textContent = st.cost.toFixed(2) + ' 元';
  bump($('pos-realized'), fmtYi(st.realized));
  drawKline();
  renderPending();
}

function renderPending() {
  const box = $('pending-box');
  const parts = [];
  if (st.pendingBuy && st.pendingBuy.amt > 0) parts.push(`买入挂单 <b>${BUY_MODES[st.pendingBuy.mode].name} ${fmtShares(st.pendingBuy.amt)}</b><button type="button" class="pd-cancel" data-pc="buy" title="撤销买入挂单(尚未结算,不花钱)">✕</button>`);
  if (st.pendingSell) parts.push(`卖出挂单 <b>${CHANNELS[st.pendingSell.channel].name} ${fmtShares(st.pendingSell.amt)}</b><button type="button" class="pd-cancel" data-pc="sell" title="撤销卖出挂单(尚未结算,无损失)">✕</button>`);
  if (st.supportNext) parts.push('🛡 护盘托单在场:下回合结算时若下跌,跌幅减半');
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
  // 资金操作按钮:吸筹/拉抬/出货 + 两个大招
  document.querySelectorAll('.fund-btn[data-fund]').forEach(b => {
    const key = b.dataset.fund;
    if (key === 'wash') {
      const used = !st.skills.wash;
      b.disabled = used || st.halted || st.cash < 800;
      b.classList.toggle('used', used);
      b.title = used ? '已消耗(每局一次)' : '自买自卖制造放量假象:本回合买盘池 +35%,热度 +18,监管 +14,花费 800 万';
      b.querySelector('small').textContent = used ? '已消耗' : '800万';
    } else if (key === 'exit') {
      const used = !st.skills.exit;
      b.disabled = used || st.halted || !!st.pendingSell;
      b.classList.toggle('used', used);
      b.title = used ? '已消耗(每局一次)' : (st.pendingSell ? '已有挂单,先取消再使用' : '本回合挂出的卖单:价格冲击/折价/监管全部减半');
      b.querySelector('small').textContent = used ? '已消耗' : '出货减伤';
    } else if (key === 'support') {
      const on = !!st.supportNext;
      b.disabled = on || st.halted || st.cash < 400;
      b.classList.toggle('used', on);
      b.title = on ? '托单已挂进场:下回合结算时若下跌,跌幅减半(不可叠加)' : '护盘托底:挂大单托住卖一档,下回合结算时若下跌,跌幅减半、免于跌停。花费 400 万,监管关注度 +3(可重复,一次护一回合)';
      b.querySelector('small').textContent = on ? '已托住下回合' : '¥400万';
    } else if (BUY_MODES[key]) {
      b.disabled = !canTrade || st.cash < st.price * 10;
    } else {
      b.disabled = !canTrade || sellableShares(st) < 10;
    }
  });
  const endBtn = $('btn-endturn');
  endBtn.classList.toggle('ap-ready', st.ap === 0);   // 行动点花完 = 该收工结算了,按钮转金色提醒
  if (endBtn.dataset.armed && st.ap < st.apPerTurn) { delete endBtn.dataset.armed; endBtn.textContent = '结束回合 ▶'; }
  endBtn.disabled = false;
  document.querySelectorAll('.op-btn').forEach(b => {
    const key = b.dataset.op;
    const act = OPINION_ACTIONS[key];
    const freeClarify = key === 'clarify' && st.clarifyFree;   // 国民品牌:每局首次澄清免费
    // 免费动作(发帖/自答)不受现金限制——负现金时它们是玩家仅剩的自救声量
    b.disabled = (st.ap < act.ap && !freeClarify) || (act.cost > 0 && !freeClarify && st.cash < act.cost);
    if (freeClarify) {
      b.title = '❖ 国民品牌:本次澄清免 AP、免费(每局一次)。';
    } else if (b.disabled && st.ap >= act.ap && act.cost > 0 && st.cash < act.cost) {
      b.title = `现金不足:该动作需 ¥${act.cost} 万,先「集中竞价出货」回笼现金。`;
    } else if (key !== 'clarify' && st.tacticUses && (st.tacticUses[key] || 0) > 0) {
      const u = st.tacticUses[key];
      b.title = `社区免疫:该话术已连用 ${u} 次,本笔效果 ×${Math.max(0.55, 1 - u * 0.15).toFixed(2)}——换一招可恢复。`;
    } else b.title = '';
  });
}

/* ---------------- K线 ---------------- */
/* 取 CSS 变量作画笔色:纸墨主题的色板只写在 :root 一处,canvas 跟着读,
 * 避免这里再硬编码一套「知乎蓝×白底」的旧色(改主题时必然漏改的地方)。 */
function inkColor(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function drawKline() {
  const cv = $('kline'), ctx = cv.getContext('2d');
  const cw = Math.round(cv.getBoundingClientRect().width) || 460;
  if (cv.width !== cw) cv.width = cw;
  // K线高度跟随 CSS 实际渲染高度(#kline 为弹性收缩,矮屏自动变矮)
  const ch = Math.round(cv.getBoundingClientRect().height) || 104;
  if (cv.height !== ch) cv.height = ch;
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  const cUp = inkColor('--up', '#c2261d'), cDown = inkColor('--down', '#0f6b3a');
  const cGrid = inkColor('--line', '#d8cdb0'), cDim = inkColor('--dim', '#6a6252');
  const cText = inkColor('--text', '#1d1a16');
  const data = st.history.slice(-15);
  if (!data.length) {
    ctx.fillStyle = cDim; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('第一回合收盘后,这里会出现你的K线', W / 2, H / 2);
    return;
  }
  const lo = Math.min(...data.map(d => d.low)) * 0.995, hi = Math.max(...data.map(d => d.high)) * 1.005;
  const padL = 8, padR = 34, padY = 10;
  const y = p => padY + (hi - p) / (hi - lo) * (H - padY * 2);
  const bw = (W - padL - padR) / 15;
  ctx.strokeStyle = cGrid;
  for (let i = 0; i <= 4; i++) {
    const yy = padY + i * (H - padY * 2) / 4;
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
  }
  data.forEach((d, i) => {
    const x = padL + i * bw + bw / 2;
    const up = d.close >= d.open;
    ctx.strokeStyle = up ? cUp : cDown;
    ctx.fillStyle = up ? cUp : cDown;
    ctx.beginPath(); ctx.moveTo(x, y(d.high)); ctx.lineTo(x, y(d.low)); ctx.stroke();
    const t = Math.max(3, bw * 0.55);
    const yo = y(d.open), yc = y(d.close);
    ctx.fillRect(x - t / 2, Math.min(yo, yc), t, Math.max(2, Math.abs(yc - yo)));
    if (d.board >= 2) {
      ctx.fillStyle = cUp; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(d.board + '板', x, y(d.high) - 3);
    }
  });
  const lastC = data[data.length - 1].close;
  ctx.fillStyle = cText; ctx.font = '11px sans-serif'; ctx.textAlign = 'left';
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
const OP_PREVIEW_TOUCH = '点击任意动作查看数值效果。热度与情绪喂养买盘池,监管是它们的代价。';
const OP_PREVIEW_DEFAULT = matchMedia('(hover: none)').matches ? OP_PREVIEW_TOUCH   // 触摸设备无悬停,文案同步换说法
  : '把鼠标放到动作上查看数值效果。热度与情绪喂养买盘池,监管是它们的代价。';
let pvOp = null;   // 预览条当前展示的动作:发帖时预览条可点击换角度
function bindOpPreview() {
  const box = $('op-preview');
  if (!box) return;
  box.textContent = OP_PREVIEW_DEFAULT;
  document.querySelectorAll('.op-btn').forEach(b => {
    const show = () => {
      pvOp = b.dataset.op;
      let txt = OP_PREVIEW[b.dataset.op] || OP_PREVIEW_DEFAULT;
      if (st && b.dataset.op !== 'clarify' && st.tacticUses) {
        const u = st.tacticUses[b.dataset.op] || 0;
        if (u > 0) txt += ` ⚠ 社区免疫:已连用 ${u} 次,本笔效果 ×${Math.max(0.55, 1 - u * 0.15).toFixed(2)}(换招可恢复)`;
      }
      if (b.dataset.op === 'post') txt = (lastPostAngle ? '当前角度:『' + angleShort(lastPostAngle) + '』 · ' : '') + txt + (lastPostAngle ? ' —— 点击这里可更换角度' : '');
      box.textContent = txt;
      box.style.cursor = b.dataset.op === 'post' && lastPostAngle ? 'pointer' : '';
    };
    b.addEventListener('mouseenter', show);
    b.addEventListener('focus', show);
    b.addEventListener('click', show);
  });
  box.addEventListener('click', () => {   // 悬停「发帖」时点击预览条 = 换角度
    if (pvOp === 'post' && st && !st.ended) openModal('modal-post');
  });
}
/* 上次使用的发帖角度(localStorage):重复发帖不再每次弹选择窗。
 * 想换角度:悬停「发帖」后按预览条的提示点击,或等弹窗(首次)三选一。 */
let lastPostAngle = null;
try { lastPostAngle = localStorage.getItem('djz_post_angle_v1') || null; } catch (e) {}
function rememberAngle(id) {
  if (!POST_ANGLES[id]) return;
  lastPostAngle = id;
  try { localStorage.setItem('djz_post_angle_v1', id); } catch (e) {}
}
function angleShort(id) { return (POST_ANGLES[id] && POST_ANGLES[id].name.split(' · ')[0]) || id; }

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
  // 发帖先选角度(参与感);记住了上次角度则一键直发;autoplay/headless 不经过这里
  if (key === 'post' && angle === undefined && !skipSelect) {
    if (lastPostAngle && POST_ANGLES[lastPostAngle]) { onOpinion('post', true, lastPostAngle); return; }
    openModal('modal-post');
    return;
  }
  const r = applyOpinion(st, key, kolTarget, angle);
  if (!r.ok) { toast('行动点或资金不足。', 'bad'); return; }
  $('kol-select').classList.add('hidden');
  if (key === 'hot') {   // 买热搜的可见后果:花钱的话题以「推广」位顶上热榜,两回合后自然沉底
    const t = PROMO_TOPICS[(st.round + strHash(STOCK.name)) % PROMO_TOPICS.length].replace(/\{s\}/g, STOCK.name);
    hotPromo = { title: '#' + t + '#', until: st.round + 2 };
  }
  if (r.headline) toast(r.headline + (key === 'post' && angle ? '(『' + angleShort(angle) + '』视角)' : ''), key === 'kol' ? 'gold' : '');
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
  if (key === 'support') { const r = useSupport(st); toast(r.msg, r.ok ? 'gold' : 'bad'); renderAll(); return; }
  openFundModal(key);
}
/* 按当前现金能买起的最大万股(与 updateFundEst 同一支付公式;pay 随 amt 单调递增,线性扫即可) */
function maxBuyShares(st, m, cap) {
  const { pool } = computePool(st);
  const pay = amt => { const impact = amt / (pool + 400) * 2.4 * m.impactMul; return amt * st.price * (1 + impact * 0.5); };
  let best = 0;
  const top = cap || m.max;
  for (let a = 10; a <= top; a += 10) { if (pay(a) <= st.cash) best = a; else break; }
  return best;
}
function openFundModal(key) {
  const meta = FUND_META[key];
  if (!meta) return;
  const slider = $('fund-slider');
  fundSel = { kind: meta.kind, key, amt: 0 };
  if (meta.kind === 'buy') {
    const m = BUY_MODES[key];
    // 工匠门槛共振:悄悄吸筹上限 300 → 500
    const cap = (key === 'quiet' && hasCombo('nengyuan')) ? 500 : m.max;
    const afford = maxBuyShares(st, m, cap);
    if (afford < 10) { toast('现金不足,买不起最小单位(10 万股)。', 'bad'); return; }
    let desc = m.desc + (cap > afford ? ' 受现金所限,本笔最多 ' + afford + ' 万股。' : '');
    if (cap !== m.max) desc += ' ❖ 工匠门槛基因:上限已提升至 ' + cap + ' 万股。';
    if (st.pendingBuy && st.pendingBuy.amt > 0)
      desc += ` ⚠ 已有买入挂单(${BUY_MODES[st.pendingBuy.mode].name} ${fmtShares(st.pendingBuy.amt)}),本次确认将替换它。`;
    $('fund-modal-title').textContent = m.icon + ' ' + m.name;
    $('fund-modal-desc').textContent = desc;
    slider.min = '10'; slider.max = String(Math.min(cap, afford)); slider.step = '10';
    if (parseInt(slider.max, 10) <= 10) slider.min = '0';   // 退化态兜底:min==max 的滑条是死条
    fundSel.amt = Math.min(100, parseInt(slider.max, 10));
  } else {
    const maxS = Math.floor(sellableShares(st));
    if (maxS < 10) return;
    applySellMeta(key);
    slider.min = '10'; slider.max = String(maxS); slider.step = '10';
    if (parseInt(slider.max, 10) <= 10) slider.min = '0';   // 同上
    fundSel.amt = Math.min(400, maxS);
  }
  slider.value = String(fundSel.amt);
  $('fund-amt-val').textContent = fmtShares(fundSel.amt);
  paintSlider();   // 打开时按初始值着色已选填充
  resetFundAdvisor();
  updateFundEst();
  openModal('fund-modal');
}
/* 卖出通道的标题+说明(openFundModal 与通道对比切换共用,文案单一来源) */
function applySellMeta(key) {
  const ch = CHANNELS[key];
  let desc = ch.desc + ` 监管关注度 +${ch.reg}${ch.discount ? ` · 折价 ${Math.round(ch.discount * 100)}%` : ''}${ch.leak ? ` · ${Math.round(ch.leak * 100)}% 概率走漏风声` : ''}。`;
  if (st.pendingSell && st.pendingSell.amt > 0)
    desc += ` ⚠ 已有卖出挂单(${CHANNELS[st.pendingSell.channel].name} ${fmtShares(st.pendingSell.amt)}),本次确认将替换它。`;
  $('fund-modal-title').textContent = CH_ICON[key] + ' ' + ch.name + ' · 出货';
  $('fund-modal-desc').textContent = desc;
}
/* 通道对比器:点击对比行切换通道(保留滑条位置,只换通道重估) */
function switchChannel(key) {
  if (!fundSel || fundSel.kind !== 'sell' || fundSel.key === key || !CHANNELS[key]) return;
  fundSel.key = key;
  applySellMeta(key);
  updateFundEst();
}
function onFundSlider() {
  if (!fundSel) return;
  fundSel.amt = parseInt($('fund-slider').value, 10);
  $('fund-amt-val').textContent = fmtShares(fundSel.amt);
  paintSlider();
  updateFundEst();
}
/* 滑条已选填充:把当前值百分比写进 CSS 变量 --fill,轨道的渐变据此着色 */
function paintSlider() {
  const s = $('fund-slider');
  if (!s) return;
  const span = Math.max(1, parseFloat(s.max) - parseFloat(s.min));
  const p = clamp((parseFloat(s.value) - parseFloat(s.min)) / span * 100, 0, 100);
  s.style.setProperty('--fill', p.toFixed(1) + '%');
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
    $('fund-channels').classList.add('hidden');
    $('fund-pool-who').classList.add('hidden');
  } else {
    const ch = CHANNELS[fundSel.key];
    const ex = st.exitNext ? 0.5 : 1;
    const impact = fundSel.amt / (pool + 350) * ch.impact * 1.2 * ex;
    const estPrice = st.price * (1 - Math.min(impact, 0.2) / 2) * (1 - ch.discount * ex);
    // 占用买盘池 = 本笔 ÷ 当前池子:"池深才接得住大单"从文字变成一眼可见的比值
    const use = pool > 0 ? fundSel.amt / pool : 1;
    const usePct = Math.min(999, Math.round(use * 100));
    const useCls = use > 0.6 ? 'bad' : use > 0.3 ? 'warn' : 'ok';
    const useTxt = use > 0.6 ? '本笔要吞掉六成以上买盘,大概率砸穿——减量,或点下方通道对比换温和路线分批走。'
      : use > 0.3 ? '本笔吃掉三成以上池子,砸价可感知,注意分回合匀速。'
      : '池子接得住,本笔出手节奏安全。';
    $('fund-est').innerHTML = `预计成交价 ≈ <b>${estPrice.toFixed(2)} 元</b> · 预计回笼 ≈ <b>${fmtYi(estPrice * fundSel.amt)}</b>(价格冲击 ${(impact * 100).toFixed(1)}%${ch.discount ? ` + 折价 ${Math.round(ch.discount * ex * 100)}%` : ''})` +
      `<div class="pool-stress"><span>占用买盘池</span><i class="${useCls}"><b style="width:${Math.min(100, usePct)}%"></b></i><em class="${useCls}">${usePct}%</em></div>` +
      `<div class="pool-stress-txt ${useCls}">${useTxt}</div>` +
      (estPrice < st.cost ? `<div class="fund-loss-warn">⚠ 预计成交价已跌破你的成本 ${st.cost.toFixed(2)} 元:这一笔是亏损出货。宁可少卖一股,别砸穿自己的均价。</div>` : '') +
      (impact > 0.09 ? '<div class="pool-stress-txt warn">⚠ 卖得太猛会砸崩价格——考虑分回合匀速出货。</div>' : '') +
      (st.exitNext ? '<div class="pool-stress-txt ok">🕊 金蝉脱壳生效中:本单的冲击与折价已按减半预估。</div>' : '');
    renderFundChannels();
    renderPoolWho();
  }
}
/* 三通道对比:同一笔货在竞价/大宗/尾盘下的回笼/冲击/监管/泄露并排,点击行即切换通道(数值与结算公式同源,纯展示) */
function renderFundChannels() {
  const box = $('fund-channels');
  if (!fundSel || fundSel.kind !== 'sell') { box.classList.add('hidden'); return; }
  const { pool } = computePool(st);
  const ex = st.exitNext ? 0.5 : 1;
  const rows = Object.keys(CHANNELS).map(k => {
    const ch = CHANNELS[k];
    const impact = fundSel.amt / (pool + 350) * ch.impact * 1.2 * ex;
    const estPrice = st.price * (1 - Math.min(impact, 0.2) / 2) * (1 - ch.discount * ex);
    return `<button type="button" class="fund-ch-row${k === fundSel.key ? ' cur' : ''}" data-ch="${k}">` +
      `<b>${CH_ICON[k]} ${ch.name}</b>` +
      `<span>回笼 ≈${fmtYi(estPrice * fundSel.amt)}</span>` +
      `<span>冲击 ${(impact * 100).toFixed(1)}%</span>` +
      `<span class="${ch.reg >= 15 ? 'bad' : ch.reg >= 8 ? 'warn' : 'ok'}">监管+${Math.round(ch.reg * ex)}</span>` +
      `<span>${ch.leak ? `${Math.round(ch.leak * ex * 100)}%走漏` : '隐蔽'}</span></button>`;
  }).join('');
  box.innerHTML = '<div class="fund-ch-head">同一笔货,三条通道(点击切换)</div>' + rows;
  box.classList.remove('hidden');
}
/* 买盘池人化:接盘的都有谁——背景流动性 + 按 eag 公式逐个估出的居民买盘(与 resolveRound 同源,纯展示不动引擎) */
function renderPoolWho() {
  const box = $('fund-pool-who');
  if (!fundSel || fundSel.kind !== 'sell') { box.classList.add('hidden'); return; }
  const base = computePool(st).pool;
  const hasBoostKol = Object.keys(st.kolsBoost).length > 0;
  const bids = st.retails.map(n => {
    const eag = Math.max(0, n.valence) / 100 * (0.4 + n.arousal / 150) * (0.5 + n.confidence / 200);
    // 恰饭效应与结算同源:被充值大V在场时,从众/梭哈/打板买盘 ×1.5
    const fan = hasBoostKol && ['suoha', 'boarder', 'herd'].includes(n.persona) ? 1.5 : 1;
    return { n, buy: n.cash * 0.35 * eag / st.price * fan };
  }).sort((a, b) => b.buy - a.buy);
  const sum = bids.reduce((s, x) => s + x.buy, 0);
  const eff = Math.max(120, base + sum);
  if (sum < 1) {
    box.innerHTML = '<div class="pw-head">接盘的都有谁</div><div class="pw-empty">买盘近乎枯竭:几乎没有人愿意在这个价位接货——现在出货就是砸穿自己。先造势,把人喊回来。</div>';
    box.classList.remove('hidden');
    return;
  }
  const top = bids.filter(x => x.buy >= 1).slice(0, 10);
  let chips = `<span class="pw-chip base">基础买盘 ${fmtShares(Math.round(base))}</span>` +
    top.map(x => `<span class="pw-chip">${esc(x.n.name)}<b>${fmtShares(Math.round(x.buy))}</b></span>`).join('');
  const rest = bids.length - top.length;
  if (rest > 0) chips += `<span class="pw-chip dim">+${rest} 位小散</span>`;
  const top1 = top.length ? top[0].buy / sum : 0;
  const conc = top.length > 1 && top1 > 0.45 ? `<div class="pw-warn">⚠ 接盘高度集中在 ${esc(top[0].n.name)} 一人(占散户买盘 ${Math.round(top1 * 100)}%)——TA 一改主意,池子就塌。</div>` : '';
  box.innerHTML = `<div class="pw-head">接盘的都有谁 · 池子 ≈${fmtShares(Math.round(eff))}</div><div class="pw-chips">${chips}</div>${conc}`;
  box.classList.remove('hidden');
}
/* 交易台军师:把滑条里这笔单直接拿去问刘看山(复用 /api/llm/advisor,与聊天面板的 advisorBusy 互不占用) */
let fundAdvBusy = false;
async function onFundAdvisor() {
  if (!fundSel || fundAdvBusy || !st) return;
  const btn = $('btn-fund-adv'), ans = $('fund-adv-ans');
  const { pool } = computePool(st);
  const q = fundSel.kind === 'buy'
    ? `我打算用「${BUY_MODES[fundSel.key].name}」买入${fmtShares(fundSel.amt)},现在这笔怎么打?`
    : `我打算走「${CHANNELS[fundSel.key].name}」卖出${fmtShares(fundSel.amt)},当前买盘池约${fmtShares(Math.round(pool))},这笔怎么出?`;
  fundAdvBusy = true;
  btn.disabled = true; btn.textContent = '刘看山思考中…';
  ans.classList.remove('hidden');
  ans.textContent = '思考中…';
  let text;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);   // 与聊天军师同款:8s 早降级
    const r = await jpostJSON('/api/llm/advisor', { q, state: stateDigest() }, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r || !r.text) throw new Error('no text');
    text = r.text;
  } catch (e) {
    text = localAdvisor(q) + '(本地速答)';
  }
  ans.textContent = text;
  fundAdvBusy = false;
  btn.disabled = false; btn.textContent = '⚖ 问刘看山:这笔怎么打?';
}
function resetFundAdvisor() {
  const btn = $('btn-fund-adv'), ans = $('fund-adv-ans');
  if (btn) { btn.disabled = false; btn.textContent = '⚖ 问刘看山:这笔怎么打?'; }
  if (ans) { ans.classList.add('hidden'); ans.textContent = ''; }
  fundAdvBusy = false;
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
let endTurnLock = false;   // 连点防护:15 回合是稀缺资源,误触双击吞掉一整回合且无提示,代价太高。
                           // 不能用 btn.disabled 做锁:renderActions 每次渲染都会把它重置为可用。
function onEndTurn() {
  if (st.ended || endTurnLock) return;
  const endBtn = $('btn-endturn');
  // 误触保护:一点行动点都没用就点结束,先确认一次(回合数是稀缺资源,手滑代价太高)
  if (st.ap >= st.apPerTurn && !endBtn.dataset.armed) {
    endBtn.dataset.armed = '1';
    endBtn.textContent = '本回合尚未行动 · 再点一次确认结束';
    endBtn.classList.add('armed-pulse');   // 视觉+触觉强反馈:手机上纯文字提示太弱,玩家实测会当成"没反应"
    if (navigator.vibrate) navigator.vibrate(60);
    setTimeout(() => { endBtn.classList.remove('armed-pulse'); }, 400);
    setTimeout(() => {
      if (!endBtn.dataset.armed) return;
      delete endBtn.dataset.armed;
      endBtn.textContent = '结束回合 ▶';
    }, 2600);
    return;
  }
  delete endBtn.dataset.armed;
  endBtn.textContent = '结束回合 ▶';
  endTurnLock = true;
  setTimeout(() => { endTurnLock = false; }, 450);
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
  // 关键提示(问询/停牌/负现金自救等)随结算 toast 一并送达;更重的信号另有横幅与 feed 新闻
  if (st.tips.length) msg += '  ❕' + st.tips[st.tips.length - 1];
  toast(msg);
  if (st.pendingDecision) maybeAiDecision();
}

/* ---------------- 抉择事件卡 ---------------- */
function openDecision(card, generating) {
  if (st.ended) return;   // 已终局:任何晚到的抉择(AI 回包/回退)都不再覆盖结局页
  if (generating) {   // AI 专属事件生成中:占位态,不展示本地内容避免闪换
    $('dc-title').textContent = '【抉择】定制事件生成中';
    $('dc-text').textContent = '刘看山·看盘版正在结合本局局势,为你生成一个专属抉择事件…(约需几秒)';
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
  if (st.ended) return;   // 兜底:终局后不再弹抉择(引擎已不在终局回合掷抉择,这里防 AI 回包晚到)
  const local = st.pendingDecision;
  const llmOn = hasByok() || (window.ZR && window.ZR.llm);
  if (location.search.includes('autoplay') || !llmOn || st.aiEvents >= 2 || st.aiEventSkip) { openDecision(local); return; }
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
    st.aiEventSkip = true;   // 失败一次的代价是弹窗空转十几秒:本局不再尝试 AI 定制
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
  const kols = st.kols.map(k => row(k, '', `<img class="res-face" src="assets/px/${k.id}.png" alt="" loading="lazy">${esc(k.name)}`)).join('');
  const R = st.retails;
  const persona = R.find(n => n.isPersona);
  const bull = R.filter(n => n.valence > 25).length, bear = R.filter(n => n.valence < -25).length;
  const avgA = Math.round(R.reduce((t, n) => t + n.arousal, 0) / R.length);
  const avgC = Math.round(R.reduce((t, n) => t + n.confidence, 0) / R.length);
  const sorted = R.slice().sort((a, b) => b.valence - a.valence);
  const top = sorted.slice(0, 3).map(n => `${esc(n.name)}(${Math.round(n.valence)})`).join('、');
  const bottom = sorted.slice(-3).reverse().map(n => `${esc(n.name)}(${Math.round(n.valence)})`).join('、');
  const roster = R.slice().sort((a, b) => b.valence - a.valence)
    .map(n => row(n, n.isPersona ? 'res-persona' : (n.isFollowee ? 'res-followee' : ''), n.isPersona ? '🌟 ' + esc(n.name) : (n.isFollowee ? '🔗 ' + esc(n.name) : null))).join('');
  return (
    `<div class="res-sec">意见领袖(大V × ${st.kols.length})</div>${kols}` +
    `<div class="res-sec">散户(${R.length}人) — 看多 ${bull} · 观望 ${R.length - bull - bear} · 看空 ${bear} · 平均情绪 ${Math.round(avgValence(st))} · 平均唤醒 ${avgA} · 平均置信 ${avgC}</div>` +
    `<div class="res-roster">${roster}</div>` +
    (persona ? `<div class="res-line">👆 ${window.ZR_PERSONA && window.ZR_PERSONA.tag === '虚构示例·分身' ? '带🌟的是虚构示例分身——正式版登录知乎后,TA 会换成你自己。' : '带🌟的居民以你的知乎画像生成——盯紧 TA,看 TA 什么时候被收割。'}</div>` : '') +
    (R.some(n => n.isFollowee) ? `<div class="res-line">🔗 ${R.find(n => n.isFollowee).tag.slice(0, 2) === '虚构' ? '带🔗的是虚构示例知友分身——登录知乎后,会换成你真实关注的知友。' : '带🔗的是「你关注的知友」的 AI 分身——他们和其他居民一样读帖、被带节奏、下单。'}</div>` : '') +
    `<div class="res-line">🔥 最狂热:${top}</div><div class="res-line">🧊 最恐慌:${bottom}</div>` +
    `<div class="res-hint">情绪 = 对${STOCK.name}的态度(红看多/绿看空) · 唤醒 = 激动程度 · 置信 = 对自己观点的确信。他们的情绪 = 你的买盘池,收盘结算后继续演化。⚠ 同一话术连用会被「脱敏」(效果递减);过热时冷嘲/价值型居民会发帖质疑,压低全场信心。🚩 居民帖子右下角可「举报」:折叠该帖并压制 TA 的声量,但监管关注度 +3,每回合限一次。</div>`);
}

/* ---------------- Feed(最新在最上方) ---------------- */
let feedNewCount = 0;   // 未读新帖数:玩家下翻看历史时,悬浮按钮提示有新动态
let reportUsedRound = -1;   // 举报每回合限一次(展示层计数,与引擎回合号对齐)

/* 知乎形态层:LV 与热度值均为展示层确定性换算(同一帖子每次渲染结果一致),
 * 只改"长相"不回写引擎数值——引擎读到的仍是 game.js 生成的原始 likes */
function zhihuLv(name) { return 2 + (strHash(name) % 7); }
function fmtN(n) { return n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n); }
function fmtHeat(likes) { const w = likes * 13 + 66; return w >= 10000 ? (w / 10000).toFixed(1) + ' 亿热度' : w + ' 万热度'; }

function actionBar(it, canReport) {   // 知乎回答卡行动栏:赞同(可点)· 评论 · 分享 · 举报
  return `<span class="fi-vote" role="button" title="赞同:互动反馈,不改变引擎数值">▲ 赞同 <b>${fmtN(it.likes || 0)}</b></span>` +
    `<span>评论</span><span>分享</span>` +
    (canReport ? `<span class="fi-report" role="button" title="举报:折叠该帖并压制作者声量;代价是监管关注度 +3,每回合限一次">举报</span>` : '');
}
function onVote(btn, it) {
  if (btn.dataset.voted) return;
  btn.dataset.voted = '1';
  btn.classList.add('voted');
  const b = btn.querySelector('b');
  if (b) b.textContent = fmtN((it.likes || 0) + 1);
}
function onReport(node, it) {
  if (!st || st.ended) return;
  if (reportUsedRound === st.round) { toast('本回合已举报过一次:连续举报会被监管视为恶意刷屏。', 'bad'); return; }
  if (it.kol && st.kolsBoost[it.kol]) { toast('这是你刚充值的自己人,举报 TA 图什么?', 'bad'); return; }
  reportUsedRound = st.round;
  st.reg += 3;   // 与引擎同语义:不设上限,收盘结算时判 ≥100 立案
  const npc = st.retails.find(x => x.name === it.author);
  let msg;
  if (npc) {
    npc.valence = clamp(npc.valence * 0.6, -100, 100);   // 声量压制:情绪向中立收敛
    npc.arousal = clamp(npc.arousal - 6, 0, 100);
    msg = '已转交知乎小管家:' + npc.name + ' 的帖子被折叠,TA 的声量被压制。监管关注度 +3。';
  } else {
    msg = '知乎小管家已将该内容折叠。' + (it.tag === '传闻' ? '不过谣言传播砸出的坑,举报可填不回来。' : '') + '监管关注度 +3。';
  }
  node.classList.add('fi-folded');
  const meta = node.querySelector('.fi-meta');
  if (meta) meta.innerHTML = '<span class="fi-fold-note">该内容因被举报而折叠 · 监管关注度 +3</span>';
  else {   // 新闻卡无行动栏:头部行尾追折叠标(保留 ai-badge 与原结构)
    const head = node.querySelector('.fi-news');
    if (head) { const s = document.createElement('span'); s.className = 'fi-fold-note'; s.textContent = ' · 已折叠'; head.insertBefore(s, head.querySelector('.fi-text')); }
  }
  toast(msg, 'gold');
  renderAll();
}
function renderFeed() {
  const box = $('feed');
  const before = feedRendered;
  /* 分组版式(论坛小节式):
   * 回合组自上而下 = 新回合在上(第3回合 → 第2回合 → …)
   * 组内自上而下 = 按发生时序(先发生的帖子在上)
   * 分隔线是组标题,压在组首;评论挂原帖下方(组内紧跟原帖) */
  for (; feedRendered < st.feed.length; feedRendered++) {
    const it = st.feed[feedRendered];
    const node = buildFeedItem(it);
    node.dataset.fidx = feedRendered; // LLM 异步换文案时按此定位 DOM
    let placed = false;
    if (it.type === 'comment') {
      // 找原帖:优先 parentTag 指定的新闻(如"传闻"),否则最近一条非评论帖
      let pj = -1;
      for (let j = feedRendered - 1; j >= 0; j--) {
        const cand = st.feed[j];
        if (it.parentTag) {
          if (cand.type === 'news' && cand.tag === it.parentTag) { pj = j; break; }
        } else if (cand.type !== 'comment') { pj = j; break; }
      }
      const parentNode = pj >= 0 ? box.querySelector(`[data-fidx="${pj}"]`) : null;
      if (parentNode) {
        let hop = parentNode;   // 插到该原帖评论组的末尾 → 同帖多条评论自上而下按时序
        while (hop.nextElementSibling && hop.nextElementSibling.dataset.commentOf === String(pj)) hop = hop.nextElementSibling;
        node.dataset.commentOf = String(pj);
        hop.insertAdjacentElement('afterend', node);
        placed = true;
      }
      // 原帖节点已被 DOM 上限裁掉时,回退为普通组内追加
    }
    if (!placed) {
      const newGroup = feedRendered === 0 || st.feed[feedRendered - 1].round !== it.round;
      if (newGroup) {
        // 新回合组:整组放到最顶,分隔线作组标题压在组首
        box.insertBefore(node, box.firstChild);
        const d = document.createElement('div');
        d.className = 'sys-line';
        d.dataset.round = it.round;
        d.textContent = it.round === 0 ? '—— 开盘前 ——' : `—— 第 ${it.round} 回合 ——`;
        box.insertBefore(d, node);
      } else {
        // 同回合追加:插到本组末尾(本组之后的第一条分隔线之前,或列表底)
        const sep = box.querySelector(`.sys-line[data-round="${it.round}"]`);
        if (sep) {
          let tail = sep.nextElementSibling;
          while (tail && !tail.classList.contains('sys-line')) tail = tail.nextElementSibling;
          box.insertBefore(node, tail);
        } else box.insertBefore(node, box.firstChild);
      }
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
  const faceImg = (author, kolId, persona) => {   // 像素脸:大V用专属像,居民按原型/运行时缓存;无脸回退首字母圆牌
    const src = kolId ? 'assets/px/' + kolId + '.png'
      : (() => { const n = st.retails.find(x => x.name === author); if (!n) return null; const c = pxAICache()[n.name]; return (c && c.src) || (PX_STATIC[n.persona] ? 'assets/px/' + n.persona + '.png' : null); })();
    return src ? `<img class="fi-face" src="${src}" alt="" loading="lazy">` : null;
  };
  if (it.type === 'q') {
    d.className = 'feed-item';
    d.innerHTML = `<div class="fi-q"><span class="q-mark">Q</span>${esc(it.title)}</div><div class="fi-meta">${fmtHeat(it.likes)} · ${it.likes} 关注 · 写回答</div>`;
  } else if (it.type === 'a' || it.type === 'comment') {
    d.className = 'feed-item' + (it.type === 'comment' ? ' fi-comment' : '');
    // 知乎分身/原型帖:左侧紫/金标记条,与「居民生态」面板的身份色一致
    const npc = st.retails.find(x => x.name === it.author);
    if (npc && npc.isFollowee) d.classList.add('fi-followee');
    else if (npc && npc.isPersona) d.classList.add('fi-persona');
    const initial = it.author.slice(0, 1);
    const ac = it.kol ? '#b26a00' : avColor(it.author);
    const face = faceImg(it.author, it.kol);
    const avatar = face || `<span class="fi-avatar ${it.kol ? 'kol' : ''}" style="background:${ac}">${esc(initial)}</span>`;
    // 大V签名已带「·N关注」不再叠等级;散户/评论者补知乎式 LV(按名字哈希稳定)
    const tagHtml = it.kol ? esc(it.tag) : esc(it.tag) + ' · Lv.' + zhihuLv(it.author);
    d.innerHTML = `<div class="fi-author">${avatar}<span class="fi-name">${esc(it.author)}</span><span class="fi-tag ${it.kol ? 'kol' : ''}">${tagHtml}</span></div><div class="fi-text">${esc(it.text)}</div><div class="fi-meta">${actionBar(it, true)}</div>`;
  } else if (it.type === 'writer') {
    d.className = 'feed-item';
    d.innerHTML = `<div class="fi-author"><span class="fi-avatar" style="background:${avColor(it.author)}">${esc(it.author.slice(0, 1))}</span><span class="fi-name">${esc(it.author)}</span><span class="fi-tag">${esc(it.tag)}</span></div><div class="fi-title">${esc(it.title)}</div><div class="fi-text">${esc(it.text)}</div>${it.attr ? `<div class="fi-attr">✍ ${esc(it.attr)}</div>` : ''}<div class="fi-meta">${actionBar(it, false)}</div>`;
  } else if (it.type === 'kolpost') {
    const kol = st.kols.find(k => k.id === it.kol);
    d.className = 'feed-item';
    d.innerHTML = `<div class="fi-author"><img class="fi-face" src="assets/px/${it.kol}.png" alt=""><span class="fi-name">${esc(kol.name)}</span><span class="fi-tag kol">${esc(kol.tag)}·${kol.followers}关注</span></div><div class="fi-title">${esc(it.title)}</div><div class="fi-text">${esc(it.text)}</div><div class="fi-meta">${actionBar(it, false)}</div>`;
  } else if (it.type === 'news') {
    /* 新闻流三形态(纯展示层映射,不改引擎数据):
     * 传闻 → 知乎「匿名想法」;财报/监管 → 机构号蓝V官方发布;其余事件 → 话题页(# 标题 + 热度) */
    const isReg = it.tag === '监管';
    const isRumor = it.tag === '传闻';
    const isEarning = it.tag === '财报';
    d.className = 'feed-item';
    let head;
    if (isRumor) {
      head = `<span class="fi-tag ${it.tagCls || ''}">匿名想法</span> <b style="margin-left:6px">${esc(it.title)}</b><span class="fi-anon">匿名用户 · 盘中发布</span><span class="fi-report" role="button" title="举报:折叠该内容;监管关注度 +3,每回合限一次">举报</span>`;
    } else if (isEarning || isReg) {
      head = `<span class="fi-vbadge${isReg ? ' reg' : ''}" title="知乎机构号">☑</span><span class="fi-org${isReg ? ' reg' : ''}">${esc(isReg ? STOCK.regulator : STOCK.name + ' 官方账号')}</span> <span class="fi-tag ${isReg ? 'reg ' : ''}${it.tagCls || ''}">${esc(it.tag)}</span> <b style="margin-left:6px">${esc(it.title)}</b>`;
    } else {
      head = `<span class="fi-tag ${it.tagCls || ''}">${esc(it.tag)}</span> <b style="margin-left:6px"><span class="fi-topic">#</span>${esc(it.title)}</b><span class="fi-anon">${fmtHeat(it.likes)}</span>`;
    }
    d.innerHTML = `<div class="fi-news ${isReg ? 'reg' : ''}">${head}<div class="fi-text" style="margin-top:4px">${esc(it.text)}</div></div>`;
  }
  const voteEl = d.querySelector('.fi-vote');
  if (voteEl) voteEl.addEventListener('click', () => onVote(voteEl, it));
  const repEl = d.querySelector('.fi-report');
  if (repEl) repEl.addEventListener('click', () => onReport(d, it));
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
  closeModal('modal-decision');   // 残留抉择弹窗(如 AI 回包晚到)不得压在结局页上
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
  const hotEl = $('end-hot');   // 热榜定格:本局公司话题在「知乎热榜」上的最好名次
  if (hotEl) {
    hotEl.textContent = hotPeak
      ? '🔥 本局最高冲上「知乎热榜」第 ' + hotPeak.rank + ' 位:' + hotPeak.title + '(第 ' + hotPeak.round + ' 回合)'
      : '本局的话题自始至终没能冲上热榜——不带节奏的股票,没有热搜。';
    hotEl.classList.remove('hidden');
  }
  renderTransMap();
  renderVaccines();
  renderGallery(e.key);
  renderEndWall();
  aiEpitaph(info, e);
  renderShareCard();
  $('end-screen').classList.remove('hidden');
}

/* ---------------- 结局晒单卡(裂变物料) ----------------
 * 纯 Canvas 本地绘制:总资产/称号/本局名台词/二维码 → 一张可直接保存进群转发图的 PNG。
 * 二维码点阵来自 js/qr-data.js(链接固定,构建期离线生成),零远程请求、零 canvas taint。 */
const SHARE_URL = 'https://sheepsky.com';
function famousQuote() {   // 本局名台词:点赞最高的居民/大V帖(社区自己长出来的梗,最值得晒)
  let best = null;
  (st.feed || []).forEach(it => {
    if (it.type !== 'a' && it.type !== 'comment' && it.type !== 'kolpost') return;
    if (!best || (it.likes || 0) > (best.likes || 0)) best = it;
  });
  if (!best) return null;
  const text = String(best.text || '').replace(/\s+/g, ' ');
  return { text: text.length > 52 ? text.slice(0, 51) + '…' : text, author: best.author || '', likes: best.likes || 0 };
}
function wrapCn(ctx, text, maxW) {   // 中文按字断行
  const lines = [];
  let line = '';
  for (const ch of String(text)) {
    if (ctx.measureText(line + ch).width > maxW && line) { lines.push(line); line = ch; }
    else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}
function drawShareQR(ctx, x, y, cellPx) {   // 白底 + 墨点阵,自带 4 模块静区
  const q = window.QR_SHEEPSKY;
  const n = q.length, pad = 4 * cellPx, w = n * cellPx + pad * 2;
  ctx.fillStyle = '#fbf5e6';
  ctx.fillRect(x, y, w, w);
  ctx.fillStyle = '#1d1a16';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
    if (q[r][c] === '1') ctx.fillRect(x + pad + c * cellPx, y + pad + r * cellPx, cellPx, cellPx);
  return w;
}
function renderShareCard() {
  const canvas = $('share-card-canvas');
  if (!canvas || !st || !st.ending) return;
  const e = st.ending, info = ENDINGS[e.key];
  const W = 750, H = 1050;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const PAPER = '#f4ecd8', INK = '#1d1a16', BLUE = '#1257c4', RED = '#c2261d', DIM = '#6a6252', GREEN = '#0f6b3a';
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = INK; ctx.lineWidth = 4; ctx.strokeRect(18, 18, W - 36, H - 36);
  ctx.lineWidth = 1.5; ctx.strokeRect(28, 28, W - 56, H - 56);
  const center = (txt, y, font, color) => { ctx.font = font; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.fillText(txt, W / 2, y); };
  // 报头
  center('带节奏 · 操盘成绩单(全虚构)', 76, '700 26px system-ui, sans-serif', BLUE);
  center(STOCK.name + '  ' + STOCK.code, 138, '900 42px system-ui, sans-serif', INK);
  // 称号:斜盖红章(章体加高到 108,副标题基线 +44,与下缘 +54 留出间距不再压线)
  ctx.save();
  ctx.translate(W / 2, 236); ctx.rotate(-0.09);
  ctx.strokeStyle = RED; ctx.lineWidth = 5; ctx.strokeRect(-206, -54, 412, 108);
  ctx.fillStyle = RED; ctx.textAlign = 'center';
  ctx.font = '900 52px system-ui, sans-serif'; ctx.fillText(info.title, 0, 12);
  ctx.font = '600 19px system-ui, sans-serif'; ctx.fillText(info.tone === 'prison' ? '法网恢恢' : (ENDING_TONE_STYLE[info.tone] || ['', ''])[1], 0, 44);
  ctx.restore();
  // 主数字:净利(正红负绿)+ 数据行
  const profitTxt = '净利 ' + (e.netProfit >= 0 ? '+' : '−') + fmtYi(Math.abs(e.netProfit));
  center(profitTxt, 372, '900 58px system-ui, sans-serif', e.netProfit >= 0 ? RED : GREEN);
  const assets = st.cash + e.chipsLeft * e.finalPrice;
  center('总资产 ' + fmtYi(assets) + ' · 出货 ' + Math.round(e.soldRatio * 100) + '% · 终价 ' + e.finalPrice.toFixed(2) + ' 元', 418, '600 23px system-ui, sans-serif', DIM);
  // 分隔线
  ctx.strokeStyle = '#c0b394'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(70, 452); ctx.lineTo(W - 70, 452); ctx.stroke();
  // 本局名台词(社区高赞帖)
  center('—— 本局名台词 ——', 500, '700 21px system-ui, sans-serif', BLUE);
  const q = famousQuote();
  ctx.textAlign = 'left';
  ctx.font = '600 24px system-ui, sans-serif'; ctx.fillStyle = INK;
  const lines = wrapCn(ctx, '“' + (q ? q.text : info.sub) + '”', W - 190);
  let ty = 546;
  lines.slice(0, 3).forEach(l => { ctx.fillText(l, 92, ty); ty += 40; });
  if (q && q.author) {
    ctx.font = '600 20px system-ui, sans-serif'; ctx.fillStyle = DIM; ctx.textAlign = 'right';
    ctx.fillText('—— ' + q.author + ' · 赞 ' + fmtN(q.likes), W - 92, ty - 8);
  }
  // 热榜定格:本局公司话题在「知乎热榜」的最好名次(名台词区与二维码之间的空档,不动既有版位)
  if (hotPeak) {
    center('🔥 本局最高冲上知乎热榜 第 ' + hotPeak.rank + ' 位(第 ' + hotPeak.round + ' 回合)', 702, '700 22px system-ui, sans-serif', BLUE);
    center(hotPeak.title, 732, '500 18px system-ui, sans-serif', DIM);
  } else {
    center('本局话题未能冲上热榜 · 下次带得更狠一点', 718, '500 19px system-ui, sans-serif', DIM);
  }
  // 底部:二维码 + 号召 + 落款
  ctx.textAlign = 'left';
  const qrCell = 6, qrW = drawShareQR(ctx, 96, H - 96 - 25 * qrCell - 48, qrCell);
  ctx.font = '700 24px system-ui, sans-serif'; ctx.fillStyle = INK;
  ctx.fillText('扫码来带一波节奏', 96 + qrW + 28, H - 210);
  ctx.font = '600 20px system-ui, sans-serif'; ctx.fillStyle = BLUE;
  ctx.fillText(SHARE_URL, 96 + qrW + 28, H - 178);
  ctx.font = '500 17px system-ui, sans-serif'; ctx.fillStyle = DIM;
  ctx.fillText('15 回合 · 把舆论做成资金 · 全虚构模拟', 96 + qrW + 28, H - 148);
  ctx.textAlign = 'right'; ctx.fillStyle = DIM;
  ctx.fillText('知乎黑客松 2026 · 校园新锐季', W - 66, H - 66);
}
function buildFlexText() {   // 群聊直贴的炫耀文案
  const e = st.ending, info = ENDINGS[e.key];
  const q = famousQuote();
  const playedRounds = Math.min(st.round, CONFIG.totalRounds);
  const lines = [
    '【带节奏·晒单】' + STOCK.name + '(' + STOCK.code + '·虚构)',
    '结局「' + info.title + '」 · 净利 ' + (e.netProfit >= 0 ? '+' : '−') + fmtYi(Math.abs(e.netProfit)) + ' · 出货 ' + Math.round(e.soldRatio * 100) + '% · 历时 ' + playedRounds + ' 回合',
  ];
  if (q && q.text) lines.push('本局名台词:"' + q.text + '"' + (q.author ? ' ——' + q.author : ''));
  if (hotPeak) lines.push('最高冲上「知乎热榜」第 ' + hotPeak.rank + ' 位:' + hotPeak.title);
  lines.push('你也来带一波节奏 → ' + SHARE_URL);
  lines.push('(全虚构,不构成投资建议)');
  return lines.join('\n');
}
function shareCardPNG() {   // 晒单卡下载(纯本地绘制,无 taint 风险)
  const canvas = $('share-card-canvas');
  if (!canvas) return;
  const a = document.createElement('a');
  a.download = '带节奏-成绩单-' + STOCK.name + '.png';
  a.href = canvas.toDataURL('image/png');
  a.click();
  toast('晒单卡已保存,发群里让他们也来站岗。', 'gold');
}
/* 结局头像墙:本局每一回合登场的居民逐枚谢幕(含回合号) */
function renderEndWall() {
  const box = $('end-wall');
  if (!box) return;
  box.innerHTML = (st.pxLog || []).map(p => {
    const cached = pxAICache()[p.name];
    const src = (cached && cached.src) || (PX_STATIC[p.persona] ? 'assets/px/' + p.persona + '.png' : null);
    const mood = p.v > 20 ? '看多' : p.v < -20 ? '看空' : '观望';
    const moodCls = p.v > 20 ? 'bull' : p.v < -20 ? 'bear' : 'flat';
    const face = src ? `<img src="${esc(src)}" alt="" loading="lazy">` : `<span class="ew-init">${esc(p.name.slice(0, 1))}</span>`;
    return `<div class="ew-chip" title="${esc(p.name)}(${esc(p.tag || '')}) — 回合 ${p.r} 被带得最狠"><span class="ew-round">R${p.r}</span>${face}<span class="ew-name">${esc(p.name)}</span><span class="ew-mood ${moodCls}">${mood} ${p.v > 0 ? '+' : ''}${p.v}</span></div>`;
  }).join('') || '<span class="ew-empty">本局没有居民登场记录。</span>';
  box.querySelectorAll('img').forEach(im => {
    im.addEventListener('error', () => {   // 缓存签名 URL 过期:换成首字母块,与无图分支一致
      const chip = im.closest('.ew-chip');
      const nm = chip && chip.querySelector('.ew-name');
      const sp = document.createElement('span');
      sp.className = 'ew-init';
      sp.textContent = nm ? nm.textContent.slice(0, 1) : '?';
      if (im.parentNode) im.replaceWith(sp);
    }, { once: true });
  });
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
