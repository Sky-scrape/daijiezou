'use strict';
/* ============================================================
 * 《带节奏》—— 可被操纵的 AI 舆论生态模拟器(单局 Demo)
 * 数值模拟层(本文件)与表现层(ui.js)严格分离:
 * LLM 生成帖子文本,但买盘池/价格/情绪向量一律由确定性数值层驱动。
 * 本文件不依赖 DOM;node game.js 可跑 headless 平衡性自测。
 * ============================================================ */

/* ---------------- 工具 ---------------- */
function rand(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(rand(a, b + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickWeighted(arr) { // [{w, v}]
  let s = arr.reduce((t, x) => t + x.w, 0), r = Math.random() * s;
  for (const x of arr) { r -= x.w; if (r <= 0) return x.v; }
  return arr[arr.length - 1].v;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function strHash(s) { // 字符串种子:知友 NPC 的初始情绪按名字稳定,同名同像
  let h = 0; const t = String(s || '');
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function fmtYi(w) { // 万元 → 可读
  if (Math.abs(w) >= 10000) return (w / 10000).toFixed(2) + ' 亿';
  return Math.round(w).toLocaleString() + ' 万';
}
function fmtShares(ws) { return Math.round(ws).toLocaleString() + ' 万股'; }

/* ---------------- 静态配置 ---------------- */
const CONFIG = {
  totalRounds: 15,
  floatW: 10000,          // 流通盘(万股)
  startPrice: 5.20,       // 开局股价(元)
  playerShares0: 3000,    // 玩家初始持仓(万股),占流通盘30%
  playerCost: 3.10,       // 玩家建仓成本
  playerCash0: 5000,      // 初始现金(万元)
  basePool: 750,          // 基础买盘池(万股/回合)
  heatDecay: 12,
  regDecay: 4,
  apPerRound: 2,          // 每回合舆论行动点
};
let STOCK = { name: '星阑科技', code: '888217', topic: 'AI 烹饪机器人', blurb: '星阑科技主打「AI 烹饪机器人」,宣称要让每个人都吃上大厨水准的饭。成立三年,融资四轮,员工从 20 人扩张到 800 人,上周刚把总部搬进云端大厦顶层。', exchange: '云端证券交易所', regulator: '交易所监察部' };
const DEFAULT_STOCK = Object.assign({}, STOCK);

/* ---------------- 自定义标的(玩家在开始页设定,只影响文案层,数值层不读这里) ----------------
 * 合规设计:① 代码强制虚构码段 88xxxx(云端证券交易所),与真实市场证券代码天然隔离;
 * ② 名称禁用金融牌照词汇,防冒充持牌机构;③ 简介长度受限 + 敏感词过滤;
 * ④ AI 助写 prompt(服务端)另行硬约束"全虚构、不构成投资建议"。 */
const STOCK_RULES = {
  nameRe: /^[\u4e00-\u9fa5A-Za-z0-9]+$/,
  codeRe: /^88\d{4}$/,
  topicRe: /^[\u4e00-\u9fa5A-Za-z0-9 ]*$/,
  nameForbidden: ['银行', '证券', '保险', '基金', '信托', '期货', '交易所', '证监会', '央行', '国务院', '财政部'],
  textForbidden: ['习近平', '毛泽东', '邓小平', '江泽民', '胡锦涛', '李克强', '温家宝', '达赖', '法轮', '六四', '普京', '特朗普', '拜登', '色情', '赌博', '博彩', '毒品', '枪支', '内幕交易', '老鼠仓'],
};
function validateCustomStock(c) {
  const name = String(c && c.name || '').trim();
  const code = String(c && c.code || '').trim();
  const topic = String(c && c.topic || '').trim();
  const blurb = String(c && c.blurb || '').trim();
  if (name.length < 2 || name.length > 10) return { error: '公司名需要 2~10 个字符' };
  if (!STOCK_RULES.nameRe.test(name)) return { error: '公司名只能包含中文、英文和数字' };
  if (STOCK_RULES.nameForbidden.some(w => name.includes(w))) return { error: '公司名不能含有金融牌照相关词汇(银行/证券/基金等)' };
  if (!STOCK_RULES.codeRe.test(code)) return { error: '股票代码须为虚构码段 88xxxx(6 位数字、88 开头)' };
  if (topic.length > 20) return { error: '一句话题材不能超过 20 字' };
  if (topic && !STOCK_RULES.topicRe.test(topic)) return { error: '题材只能包含中文、英文、数字和空格' };
  if (blurb.length > 300) return { error: '公司介绍不能超过 300 字' };
  const bad = STOCK_RULES.textForbidden.find(w => (name + topic + blurb).includes(w));
  if (bad) return { error: '内容包含不适合出现的词:「' + bad + '」,请修改后再试' };
  return { value: { name, code, topic: topic || '未公开主营业务', blurb } };
}
function applyCustomStock(c) {
  const v = validateCustomStock(c);
  if (v.error) return v;
  STOCK.name = v.value.name;
  STOCK.code = v.value.code;
  STOCK.topic = v.value.topic;
  STOCK.blurb = v.value.blurb || genLocalBlurb(v.value.name, v.value.topic);
  // 基因按玩家原文判定(简介留白 = 低调神秘),与开始页实时预览完全一致
  STOCK.traits = deriveCompanyTraits(v.value.name, v.value.topic, v.value.blurb);
  return { ok: true };
}
function resetStock() {
  Object.assign(STOCK, DEFAULT_STOCK);
  STOCK.traits = deriveCompanyTraits(STOCK.name, STOCK.topic, STOCK.blurb);
}
/* 占位符填充:{stock}/{code}/{topic}。加载期求值的文案模板统一写占位符,使用时再填充,
 * 这样自定义标的在开局前生效即可全篇生效。 */
function fillStock(s) {
  return String(s).replace(/\{stock\}/g, STOCK.name).replace(/\{code\}/g, STOCK.code).replace(/\{topic\}/g, STOCK.topic);
}
/* 本地降级文案池:AI 助写不可用时(离线/未配 key)即时拼装公司简介,保证可玩 */
const CS_NAME_A = ['白泽', '澜舟', '鲲梦', '赤兔', '灵犀', '混沌', '麦芒', '山海', '扶摇', '零一', '听涛', '雾隐', '鹿鸣', '青梧'];
const CS_NAME_B = ['智能', '生物', '动力', '科技', '影业', '医疗', '农业', '机器人', '新能源', '半导体', '航天', '厨电'];
const CS_TOPICS = ['AI 烹饪机器人', '脑机接口翻译项圈', '太空旅游民宿', '可控核聚变充电宝', 'AI 相亲匹配', '深海采矿', '抗衰老基因疗法', '无人驾驶收割机', '量子加密奶茶', '情绪识别止损软件', '克隆和牛', '云端元宇宙殡葬'];
function randomCustomStock() {
  const name = pick(CS_NAME_A) + pick(CS_NAME_B);
  const code = '88' + String(randInt(0, 9999)).padStart(4, '0');
  const topic = pick(CS_TOPICS);
  return { name, code, topic, blurb: genLocalBlurb(name, topic) };
}
function genLocalBlurb(name, topic) {
  const t = topic || STOCK.topic;
  return pick([
    `${name}是一家主打${t}的初创公司,成立三年,融资四轮,具体金额未披露。创始人履历神秘,员工规模却从 20 人扩张到 800 人,上周刚把总部搬进云端大厦顶层。`,
    `走进${name}的展厅,迎面是一句标语:「让${t}进入每个家庭」。公司宣称手握 47 项专利,两座工厂 24 小时运转,第二批产品下月发售,官网目前无法访问。`,
    `${name}成立于三年前,靠${t}起家。宣传材料显示其营收连续三年翻番,但三家核心供应商均拒绝置评。公司回应:商业机密,无可奉告。`,
  ]);
}

/* ---------------- 公司基因(自定义标的不再是纯文案) ----------------
 * 同一套名字/题材/简介 → 确定性推导出同一组特质:开始页实时预览、资料卡全程可见。
 * 数值影响全部落在确定性引擎(热度获取/监管代价/澄清力度/初始居民情绪),headless 可回归。 */
const ARCHETYPES = {
  hardtech:   { name: '硬科技赛道', kw: ['ai', '智能', '机器人', '芯片', '量子', '脑机', '半导体', '航天', '核聚', '算法', '大模型', '无人', '卫星', '软件', '数据', '云端', '数字'], heatMul: 1.30, regMul: 1.25, desc: '激进打法:舆论热度获取 +30%;风口瞩目:舆论监管代价 +25%——烧得快,盯得也紧' },
  beauty:     { name: '医美健康', kw: ['医美', '整容', '护肤', '口腔', '眼科', '植发'], roundCash: 150, poolBonus: 0.95, desc: '现金奶牛:每回合净流入 150 万(会员充值躺赚);客群偏窄:基础买盘池 -5%' },
  livelihood: { name: '民生消费', kw: ['食品', '餐饮', '农业', '医疗', '养老', '教育', '母婴', '健身', '奶茶', '超市', '外卖', '咖啡', '酒', '服装', '零售', '家电', '日化'], clarifyBonus: 10, negMul: 1.50, desc: '防御反击:「澄清」额外多降 10 点热度;口碑敏感:负面事件的情绪冲击 ×1.5——护得住,摔得也疼' },
  entertain:  { name: '泛娱乐文旅', kw: ['游戏', '娱乐', '影视', '文旅', '旅游', '社交', '直播', '潮玩', '音乐', '电竞', '综艺', '剧本', '演出', '追星'], arousalMul: 1.40, heatDecayAdd: 4, desc: '速攻打法:舆论唤醒效果 +40%,情绪一点就爆;但热度每回合额外衰减 4——必须连着造势,不能停' },
  newretail:  { name: '新消费潮牌', kw: ['潮牌', '国潮', '美妆', '香氛', '宠物', '手办', '盲盒', '谷子'], hotMul: 1.30, negMul: 1.30, desc: '社媒爆发力:「买热搜」效果 +30%,话题天生抓眼;用户善变:负面事件的情绪冲击 ×1.3' },
  military:   { name: '军工防务', kw: ['军工', '防务', '导弹', '军品', '军贸', '国防'], rumorBias: 0.8, inquiryMod: -5, desc: '信息黑箱:传闻八成是利好(订单是真的);敏感资质:问询阈值 -5,监管更早敲门' },
  industrial: { name: '重资产制造', kw: ['电池', '材料', '钢铁', '能源', '汽车', '化工', '装备', '光伏', '工程机械', '机械', '造船', '冶炼', '纺织'], poolBonus: 1.15, heatMul: 0.80, desc: '憋大招打法:基础买盘池 +15%,出货永远有人接;题材保守:舆论热度获取 -20%,起势慢' },
  biotech:    { name: '生物医药', kw: ['基因', '生物', '医药', '疫苗', '疗法', '临床', '制药', '细胞', '诊断', '药'], writerSafe: true, mediaFragile: true, desc: '赌叙事:写手稿识破率 25%→10%,故事随便编;经不起质疑:媒体质疑的信心杀伤翻倍——故事就是命' },
  diversified:{ name: '综合业务', kw: [], desc: '业务多元,无明显赛道倾向,数值中庸稳定' },
};
const BLURB_TONES = [
  { id: 'capital', kw: ['融资', '轮', '估值', '独角兽', '上市', '券商', '路演', '对赌'], name: '资本故事', heatMulTone: 1.15, regCool: 1, desc: '故事越响火越大:所有舆论动作热度获取 +15%;但风声收得慢——监管每回合少降 1' },
  { id: 'tech',    kw: ['专利', '技术', '研发', '实验室', '博士', '论文', '首席', '工程'], name: '技术立司', doubtSoft: true, writerMul: 1.10, desc: '专业背书:质疑帖对买盘池的打击减半;写手稿感染 +10%' },
  { id: 'warm',    kw: ['用户', '家庭', '生活', '普惠', '平价', '每个人', '美好', '陪伴'], name: '亲民叙事', eventAmp: 1.25, desc: '天然好感:市场/行业事件的情绪冲击 ×1.25——好消息更涨,坏消息更伤' },
  { id: 'hunger',  kw: ['限量', '首发', '预约', '秒罄', '缺货', '配售', '排队'], name: '饥饿营销', poolMulTone: 1.08, heatMulTone: 0.92, desc: '越买不到越想要:基础买盘池 +8%;但话题吊着不点破——舆论热度获取 -8%' },
  { id: 'nostalgia', kw: ['情怀', '初心', '梦想', '热爱', '坚持', '民族', '国人'], name: '情怀叙事', panicSoft: 0.85, desc: '粉丝不离场:居民恐慌抛售 ×0.85——情怀是最后一道护城河' },
];
const TONE_SPECIAL = {
  mystery:  { name: '低调神秘', mediaHalf: true, heat0: -3, desc: '没料可扒:媒体质疑事件概率减半;开局热度 -3——低调也是一种保护色' },
  overwrap: { name: '过度包装', heat0: 4, conf0: -3, heatMulTone: 1.10, heatDecayAddTone: 2, desc: '话说太满:舆论热度获取 +10%,但每回合热度额外衰减 2(存在感透支);开局热度 +4、全场置信 -3' },
};
/* 共振基因:特定「赛道 × 叙事」组合解锁的隐藏称号与专属特效(重玩价值的钩子) */
const GENE_COMBOS = [
  { id: 'foam',      arch: 'hardtech',   tone: 'capital', name: '泡沫制造机', desc: '风口+故事=完美的泡沫配方:连板时热度额外 +6,居民情绪额外 +6' },
  { id: 'techfaith', arch: 'hardtech',   tone: 'tech',    name: '技术信仰',   desc: '数据撑腰:媒体质疑的信心杀伤减半' },
  { id: 'guoming',   arch: 'livelihood', tone: 'warm',    name: '国民品牌',   desc: '每局第一次「澄清」免 AP 且免费——国民品牌的公信力就是底气' },
  { id: 'lunwen',    arch: 'biotech',    tone: 'tech',    name: '论文战线',   desc: '每局一次:媒体质疑事件被权威论文背书直接化解' },
  { id: 'shenyao',   arch: 'biotech',    tone: 'capital', name: '神药神话',   desc: '神药的故事最迷人:写手感染 +25%;但被识破时额外监管 +10' },
  { id: 'liuliang',  arch: 'entertain',  tone: 'capital', name: '流量赌场',   desc: '对倒放量效果更强:买盘池虚增 35%→50%、热度 +18→+24' },
  { id: 'fensi',     arch: 'entertain',  tone: 'warm',    name: '全民偶像',   desc: '粉丝护盘:居民的恐慌抛售压力减半' },
  { id: 'baishoutao',arch: 'industrial', tone: 'capital', name: '白手套',     desc: '产业资金名正言顺:大额买入(>150 万股)不引监管注意' },
  { id: 'nengyuan',  arch: 'industrial', tone: 'tech',    name: '工匠门槛',   desc: '产业底盘:「悄悄吸筹」上限 300 → 500 万股' },
  { id: 'junmao',    arch: 'military',   tone: 'capital', name: '军贸故事',   desc: '保密体系:大宗/尾盘出货走漏风声的概率减半' },
  { id: 'zhongqi',   arch: 'military',   tone: 'tech',    name: '国之重器',   desc: '监管敬三分:监管关注度每回合额外多降 1' },
  { id: 'junmin',    arch: 'military',   tone: 'warm',    name: '军民鱼水',   desc: '公信力加成:「澄清」额外多降 5 点热度' },
  { id: 'wanghong',  arch: 'newretail',  tone: 'capital', name: '网红经济',   desc: '买热搜热度 +30%,充值大V的情绪感染 +25%' },
  { id: 'fenquan',   arch: 'newretail',  tone: 'warm',    name: '粉圈经济',   desc: '种草文化:写手稿感染 +20%' },
  { id: 'duanhuo',   arch: 'newretail',  tone: 'mystery', name: '刻意断货',   desc: '饥饿人设拉满:媒体质疑概率再减半,基础买盘池 +10%' },
  { id: 'yanzhi',    arch: 'beauty',     tone: 'capital', name: '颜值期货',   desc: '消费升级叙事:正面市场事件的情绪冲击 +30%' },
  { id: 'sili',      arch: 'beauty',     tone: 'mystery', name: '私域口碑',   desc: '复购盘:基础买盘池 +10%' },
  { id: 'gongchuang',arch: 'beauty',     tone: 'tech',    name: '医研共创',   desc: '临床背书:媒体质疑的信心杀伤减半' },
];
function geneCombo() {
  const g = ctrait();
  return g && GENE_COMBOS.find(c => c.arch === g.arch && c.tone === g.tone) || null;
}
function hasCombo(id) {
  const c = geneCombo();
  return !!c && c.id === id;
}
function deriveCompanyTraits(name, topic, blurb) {
  // 赛道判定:一句话题材优先(它才是业务),公司名兜底——"XX航天做细胞治疗"应判生物医药
  let archKw = null;
  const findArch = (hay) => {
    for (const id of Object.keys(ARCHETYPES)) {
      if (id === 'diversified') continue;
      for (const k of ARCHETYPES[id].kw) {
        if (hay.includes(k)) { archKw = k; return id; }
      }
    }
    return null;
  };
  const arch = findArch(String(topic || '').toLowerCase()) || findArch(String(name || '').toLowerCase()) || 'diversified';
  const b = String(blurb || '').trim();
  let toneKw = null;
  const kwTone = BLURB_TONES.find(t => t.kw.some(k => { const hit = b.includes(k); if (hit && !toneKw) toneKw = k; return hit; }));
  const tone = kwTone ? kwTone.id : (b.length >= 250 ? 'overwrap' : (b.length > 0 && b.length < 20 ? 'mystery' : null));
  return { arch, tone };
}
function ctrait() {
  // 惰性推导:默认剧本(星阑科技/AI烹饪机器人 → 硬科技+资本故事)同样有基因;加载期调用安全
  if (typeof STOCK !== 'undefined' && !STOCK.traits) STOCK.traits = deriveCompanyTraits(STOCK.name, STOCK.topic, STOCK.blurb);
  return (typeof STOCK !== 'undefined' && STOCK.traits) || { arch: 'diversified', tone: null };
}
function toneDefOf(g) { return g.tone ? (BLURB_TONES.find(t => t.id === g.tone) || TONE_SPECIAL[g.tone]) : null; }

const CHANNELS = {
  auction: { name: '集中竞价', impact: 0.35, discount: 0.00, reg: 4,  leak: 0.00, desc: '慢而稳,逐笔出货几乎不砸价,但战线长。' },
  block:   { name: '大宗交易', impact: 0.12, discount: 0.09, reg: 8,  leak: 0.35, desc: '一笔走掉大量筹码,折价 9%,可能走漏风声。' },
  tail:    { name: '尾盘偷袭', impact: 0.55, discount: 0.02, reg: 15, leak: 0.15, desc: '收益高、出手快,监管风险也最高。' },
};

/* 买入三档:同样的金额,不同的姿态。pump 档完全保留旧买入公式(平衡性已配平) */
const BUY_MODES = {
  quiet:  { id: 'quiet',  name: '悄悄吸筹',     icon: '🤫', max: 300,  impactMul: 0.35, regRule: 'none',   reg: 0, heat: 0,  desc: '小口慢吃,几乎不推动价格,也不惊动监管。上限 300 万股。' },
  pump:   { id: 'pump',   name: '拉抬·小试',    icon: '🔥', max: 800,  impactMul: 1.0,  regRule: 'big150', reg: 0, heat: 0,  desc: '适度扫货推高股价。单笔超过 150 万股会引来监管注意(+5)。' },
  ignite: { id: 'ignite', name: '拉抬·重仓点火', icon: '🚀', max: 2000, impactMul: 1.45, regRule: 'flat',   reg: 5, heat: 10, desc: '重仓点火,拉升最猛:价格冲击 +45%,热度 +10、监管 +5。' },
};

const SOCK_PUPPETS = ['盘中直击', '风口观察员', '价值嗅觉实验室', '老王聊股'];

const OPINION_ACTIONS = {
  post:    { name: '发帖带节奏', cost: 0,   ap: 1, reg: 3,  desc: '亲自下场发帖。成本低,声量也小。' },
  hot:     { name: '买热搜',     cost: 80,  ap: 1, reg: 6,  desc: '话题冲上热榜,全场情绪被点燃。' },
  writer:  { name: '雇写手软文', cost: 120, ap: 1, reg: 10, desc: '「离职员工自述体」深度稿,最容易被举报。' },
  kol:     { name: '充值大V',    cost: 150, ap: 1, reg: 4,  desc: '指定一位大V连发两回合看多内容。' },
  astroturf: { name: '自问自答', cost: 0,   ap: 1, reg: 2,  desc: '马甲提问+马甲回答,给新人"定心"。' },
  clarify: { name: '澄清公告',   cost: 60,  ap: 1, reg: -10, desc: '公告说明+投资者热线:给监管降温,代价是热度。' },
};

/* 手段免疫:同一话术连用,社区会脱敏。每次 -15%,下限 ×0.55;clarify 是降温动作不递减。
 * 监管代价不递减——重复刷同一招照样喂监管计时器。 */
const IMM_STEP = 0.15, IMM_FLOOR = 0.55;
function tacticImm(st, key) {
  if (key === 'clarify') return 1;
  const uses = (st.tacticUses && st.tacticUses[key]) || 0;
  return Math.max(IMM_FLOOR, 1 - uses * IMM_STEP);
}

/* 发帖三角度:核心动作的参与感。缺省(不传 angle)= hype,数值与历史版本完全一致。 */
const POST_ANGLES = {
  hype:  { name: '情绪党 · 喊单造梦', hint: '情绪影响最大 · 唤醒高 · 热度+4', dv: [3, 6], arousal: 4, conf: 0, heat: 4, title: () => '说说为什么我看好' + STOCK.name },
  logic: { name: '逻辑党 · 摆数据',   hint: '抬全场信心 · 声量稍小 · 热度+3',  dv: [2, 5], arousal: 2, conf: 6, heat: 3, title: () => '用数据拆解' + STOCK.name + ':三个被低估的锚点' },
  story: { name: '故事党 · 讲经历',   hint: '共情强 · 更让人确信 · 热度+4',    dv: [3, 6], arousal: 2, conf: 4, heat: 4, title: () => '一段真实经历,让我重新认识了' + STOCK.name },
};

/* ---------------- 人设与文案库(本地生成 = 设计中的"离线降级"模式) ---------------- */
const KOL_DEFS = [
  { id: 'kol_cat',  name: '老猫财经',     followers: '21万', tag: '价值投资型', style: 'calm',  desc: '冷静毒舌,只认数据。' },
  { id: 'kol_sx',   name: '满仓大师兄',   followers: '18万', tag: '梭哈喊单型', style: 'bull',  desc: '格局打开,永远看多。' },
  { id: 'kol_tg',   name: '退堂鼓演奏家', followers: '7万',  tag: '满仓踏空型', style: 'fomo',  desc: '一跌就慌,一涨就追。' },
  { id: 'kol_qh',   name: '量化小散布',   followers: '13万', tag: '数据流',     style: 'quant', desc: '擅长从盘口看出猫腻。' },
];
const RETAIL_NAMES = ['今天也在回本','韭菜盒子不要韭菜','梭哈是一种智慧','定投青年','隔壁老王满仓了','不慌是技术性调整','基金亏麻了','一万块管理员','股海浮萍','明天涨停吧','抄底抄在半山腰','装死老韭菜','新开户小张','工资到账就加仓','跌了就当存钱','情绪稳定的散户','翻本就收手','白酒医药新能源','凌晨看盘的人','别劝了我全仓了','浮盈三个点跑路','大冤种本种','等风来的猪','优雅补仓中'];
const RETAIL_MIX = [ // 24个散户的人设配比
  ['herd',6],['suoha',4],['student',4],['sarcasm',3],['anxious',3],['boarder',2],['value',2],
];
const PERSONA_META = {
  herd:    { tag: '从众型',       suggestible: true },
  suoha:   { tag: '梭哈型',       suggestible: true },
  student: { tag: '大学生新股民', suggestible: true },
  sarcasm: { tag: '冷嘲老股民',   suggestible: false },
  anxious: { tag: '满仓踏空型',   suggestible: true },
  boarder: { tag: '短线打板型',   suggestible: true },
  value:   { tag: '价值投资型',   suggestible: false },
};

function cnNum(n) {  // 支持两位数:11 → 「十一」(旧版 11+ 连板会误显示成「十」)
  const d = '一二三四五六七八九';
  if (n <= 9) return d[n - 1];
  if (n === 10) return '十';
  if (n < 20) return '十' + d[n - 11];
  return String(n);
}
const Q_TITLES = {
  board: (n) => pick([
    `如何看待${STOCK.name}(${STOCK.code})${cnNum(n)}连板?`,
    `${cnNum(n)}连板!${STOCK.name}是起点还是终局?`,
    `${STOCK.name}${cnNum(n)}连板,谁在卖,谁在买?`,
  ]),
  up: (p) => pick([
    `如何看待${STOCK.name}今日大涨${p}%?是价值发现还是击鼓传花?`,
    `${STOCK.name}单日拉升${p}%,现在上车还来得及吗?`,
    `${STOCK.name}大涨${p}%背后:是谁的资金在进场?`,
  ]),
  down: (p) => pick([
    `${STOCK.name}今日大跌${p}%,抄底的机会来了吗?`,
    `${STOCK.name}大跌${p}%,是黄金坑还是无底洞?`,
    `如何看待${STOCK.name}放量下跌${p}%?`,
  ]),
  flat: () => pick([
    `${STOCK.name}连续横盘,庄家在憋什么大招?`,
    `${STOCK.name}横盘多日,还有持有的必要吗?`,
    `为什么${STOCK.name}的分时图像一条直线?`,
    `${STOCK.name}不温不火,是机会还是陷阱?`,
  ]),
};

const T = {
  retail: {
    herd: {
      bull: ['跟着大V买了,求带!','大家都说好,那我也加点。','评论区一片看多,我先跟一半。','这波行情我看见了,跟不跟?跟!','大V都翻多了,这波稳了,我全跟。','群里都在晒收益,我坐不住了。','连我姨都问起{stock}了,我跟一点。'],
      bear: ['大佬们都跑了?我先撤……','怎么评论区突然安静了,慌。','跌了跌了,谁带带我。','群里都开始晒亏损截图了,我先跑为敬。','风向变了,大V删帖了,我也删仓。'],
      flat: ['继续观望,让子弹飞一会儿。','横盘第N天,麻了。','大V没发话,我不动。'],
    },
    suoha: {
      bull: ['满仓!干就完了!','这票我梭了,财务自由就看这周!','格局打开,别跟我谈止损。','all in!错过等十年!','融资余额又创新高?那我加杠杆!','这波不到目标价,我名字倒过来写!','别人恐惧我贪婪,别人贪婪我加仓!'],
      bear: ['跌了?加仓!越跌越买!','慌什么,我是来格局的。','跌出来的都是黄金坑,满仓接!'],
      flat: ['不涨不跌?庄家你看不起谁?','我弹药已上膛,就等一声令下。','横着也是蓄力,我等。'],
    },
    student: {
      bull: ['刚开户,请问现在上车还来得及吗?','学长们说这票能翻倍,真的吗?','第一次炒股,小仓位跟一下~','课上老师说不要追高,但…好心动。','把生活费的一半投进去了,这次认真的。','凌晨三点还在看K线,这正常吗?'],
      bear: ['呜呜第一次炒股就挨打。','我是不是该割了?在线等,挺急的。','生活费亏了三成了,不敢跟家里说。','原来跌停不是最低点,第二天还能跌。'],
      flat: ['横盘是什么意思?求科普。','原来股票不涨也不跌,跟高数课一样催眠。'],
    },
    sarcasm: {
      bull: ['又给你们表演一次"价值发现"?','涨停了?恭喜接盘的各位。','K线画得挺好看,故事讲得更好。','股价和剧情一起涨,编剧辛苦了。','粉丝经济都炒到股市里了,服。'],
      bear: ['早说了吧?嗯,我说过。','潮水退了,穿没穿自己知道。','当年喊十倍的人,现在喊"长期主义"了。','我认识的"股神"们,今天都很安静。'],
      flat: ['横盘?庄家也要吃饭的,急什么。','不发言,保命。'],
    },
    anxious: {
      bull: ['这次我真的不敢再踏空了……','上次没敢上,眼睁睁看它飞。这次我上!','满仓踏空的痛,我不想再体验第二次。','这次全仓干了,命运!给我一个答案!','别人劝我冷静,可我等这一天等了半年。'],
      bear: ['完了完了,又套在里面了。','我就知道!我就这命!','心跳比分时图还刺激,受不了了。','又亏掉一辆车,虽然我本来也没有车。'],
      flat: ['横着也难受,怕它突然跳水。','不涨不跌,我的心脏还能撑几天?'],
    },
    boarder: {
      bull: ['打板!下一板见。','量价齐升,情绪周期主线,锁仓。','龙头气质已现,明天竞价见。','换手充分,龙头身位确立。','情绪冰点后的第一根大阳线,意义非凡。'],
      bear: ['断板了,撤!','情绪退潮,空仓过节。','亏钱效应扩散,管住手。'],
      flat: ['分歧位,看明天量能。','多空分歧,半仓过夜。'],
    },
    value: {
      bull: ['基本面有支撑,这个价位不算贵。','按估值算还有空间,拿住。','现金流开始兑现的话,现在只是起点。','把波动当噪音,把逻辑当锚。'],
      bear: ['情绪溢价太高了,我减一点。','价格开始偏离价值了,各位。','讲故事的人很多,给出现金流的人很少。','当估值需要想象力那天,我就该走了。'],
      flat: ['好公司也需要好价格,继续等。','耐心是散户唯一免费的护城河。'],
    },
  },
  kol: {
    calm: {
      bull: ['说两句:热度不代表价值,但流动性代表机会。仓位自己控制。',
             '连续放量,不像是散户行为。各位留意龙虎榜,但不必恐慌。',
             '基本面我没看懂,但盘面给了我答案:有人锁仓。小仓位,可以。',
             '换手充分,浮筹清洗得差不多了。短线结构健康。'],
      bear: ['我翻遍了公告,找不到支撑这个价格的业绩。热度退了之后,一地鸡毛。',
             '提醒过风险了。第{n}回合我就说,这个位置不对称。',
             '建议大家把"故事"和"业绩"分开算账。现在这个价,全靠故事撑着。',
             '位置越高,我越保守。落袋的人不会告诉你他落袋了。'],
      flat: ['缩量横盘,多空都在等信号。我的建议:看不懂就不做。',
             '今天不点评。没有增量的上涨,和没有增量的下跌一样危险。'],
      boost: ['认真研究之后,我上调{stock}评级至"买入"。(本条含商业推广,不构成投资建议)',
              '结论前置:我错了,它真的在兑现。上调预期,仓位自负。'],
    },
    bull: {
      bull: ['格局!!!这叫主力洗盘!下车的人明天拍大腿!',
             '主线明确,情绪到位,{stock}就是这波旗舰!听我的,别怂!',
             '有人问我怕不怕高?兄弟,牛市里最高的山峰叫起点。',
             '有人恐慌有人贪,我的仓位说明一切!',
             '回调就是上车机会,这句话我说到它十倍为止!'],
      bear: ['洗盘而已!吓出的都是带血筹码,我全接!',
             '慌什么?基本面没变,变的只是人心。越跌越买!',
             '跌?这是主力在给我送筹码,笑纳了!'],
      flat: ['横盘蓄力,下一波主升浪在路上了。囤好弹药。',
             '横有多长,竖有多高。懂的自然懂。'],
      boost: ['今天必须再喊一次:{stock},就是时代留给普通人的船票!',
              '私信问我的人太多了,统一回复:满仓,勿念。'],
    },
    fomo: {
      bull: ['这次我真的不敢再踏空了……上次就是没敢上,眼睁睁看它飞。',
             '账户刚转入最后一笔工资,这次跟定了。',
             '这次满仓进去了,睡前来看看还有多少人没上车。',
             '昨天又梦见它涨停了。这种感觉,上次赚钱的时候也有过。'],
      bear: ['为什么我一买就跌一卖就涨???我是主力克星吗?',
             '手抖点了割肉……又割在地板上了。',
             '睡不着了。第一次觉得,钱不是好东西。'],
      flat: ['横盘比跌还折磨人,谁来救救我的心态。',
             '它的每一次呼吸都牵动我的心,横盘也不安生。'],
      boost: ['这次我听劝,全部身家跟了。{stock},要么财务自由要么天台见。',
              '刚又补了一笔,这是我今年最后悔没早点买的票。'],
    },
    quant: {
      bull: ['量价结构健康,但换手率开始异常。短线可以,重仓慎重。',
             '分时里有大单托底,不像是自然交易。谨慎乐观。',
             '资金流入结构还行,但提醒一句:这些数据也可以被"做"出来。'],
      bear: ['盘口出现规律性压单,节奏太整齐了,像教科书级的"温柔出货"。各位,潮水可能要退。',
             '我可以直说吗:这个走势,人工痕迹很重。注意风险。',
             '换手率、集中度、挂单密度,三项全部异常。这不是情绪,这是手笔。'],
      flat: ['波动率收敛到历史低位,变盘临近。备好双向预案。',
             '多空信号混杂,建议观望。我的空仓也是仓位。'],
      boost: ['模型跑完了:多因子共振,目标价上修 40%。数据不会说谎。(模型参数已商业化,详见主页)',
              '量价、资金、情绪三重确认,这次是右侧信号。'],
    },
  },
  writer: [
    { title: `我在{stock}这三年`, body: `3 年前我入职{stock},参与过{topic}项目的落地。公司内部远比外界想象的激进——下个季度的产品发布会,会讲一个"改变行业"的故事。离开是我自己的选择,但有些价值,市场还没有看懂。利益相关:已不持有该公司股票(真的吗?)。` },
    { title: `从{stock}离职后,我想说几句实话`, body: `看到最近的行情,忍不住说两句。内部人士都知道,公司手上有牌,只是还没到打出来的时间。那些喊着"庄股"的人,并不了解这家公司的执行力。以上。` },
    { title: `深度体验过{topic}后,我理解了{stock}的野心`, body: `朋友送了我一台内测机。用了一周,我退还了某大厂的 offer——方向和执行力,差距是肉眼可见的。资本市场短期是投票机,长期是称重机,而它的重量,还没被称出来。` },
    { title: `楼下大爷都在聊{stock},我有点慌`, body: `（故事体）我在小区门口修了二十年自行车。这个月,问我{stock}的人比问我车胎的多十倍。上一次这么热闹的时候,是另一家公司的顶点。` },
    { title: `供应商眼里的{stock}`, body: `（深度体）我们给它供应核心部件三年,回款从来不拖。坊间都说它资金链紧张——可我们财务说,这季度订单加了一半。信谁,你自己判断。` },
    { title: `一个普通人的{stock}观察日记`, body: `（日记体）第 1 天,留意到它。第 9 天,同事全在讨论。第 15 天,我妈问我要不要买。今天我把这些写下来,留给三个月后的自己。` },
    { title: `谢邀,谈谈{stock}`, body: `谢邀。人在外地,刚下高铁。利益相关:持仓不动。只说一个我能验证的事实——我认识的三个业内人,最近都在悄悄研究{topic}。看懂的自然懂;看不懂的,收藏这篇,三个月后再看。点赞藏,关注不迷路。` },
    { title: `为什么没人敢做空{stock}?`, body: `先问是不是,再问为什么。空头的逻辑我逐条看过:估值、筹码、节奏——全都输给了一个词:共识。数据放这里,不服的拿数据说话。下个关键节点,我再来更新。` },
  ],
  astroturfQ: [`{stock}现在还能上车吗?`,`如何评价新手第一次买{stock}?`,`{stock}的长期逻辑是什么?`,`新手第一只票选{stock}合适吗?`,`{stock}拿到年底能翻倍吗?`,`定投{stock}靠谱吗?`],
  astroturfA: ['刚入不久,说说体验:节奏很稳,拿得住。','长线逻辑清晰,短线有资金关照,这种票不多见。','别问,问就是格局。','已经拿到不少了,无惧波动。','这票我拿了一年,越来越有底。','别人恐惧我贪婪,仅供参考。','谢邀。人在营业部,刚办完户。说说体验:节奏很稳,拿得住。'],
  /* 独立短评库(区别于回答的长文案) */
  comments: {
    bull: ['冲!','上桌了,这波吃肉。','加仓加仓加仓。','空仓的痛苦我懂。','已上车,系好安全带。','叫不叫?叫我就跟。','今天账户红得发光。','问就是满仓。'],
    bear: ['跑了跑了,落袋为安。','这走势我看不懂,先撤。','别接了,真的别接了。','脚踝斩预警。','我割了你随意。','危险危险,重要的事说三遍。','留得青山在。'],
    flat: ['看看再说。','让我静静。','装的,继续装。','不动如山。','今天不操作,围观吃瓜。','搬个小板凳。','佛系持有。'],
  },
  /* 涨停/跌停现场反应({n}=连板数,仅在≥2板时选用含{n}的条目) */
  boardReact: ['{n}板了!今晚不睡,盯着夜市排单!','涨停!我就说我的直觉不会错!','封单那么大,明天大概率继续,躺赢!','赶紧让全家开户,一起上!','{n}板成妖,现在卖就是历史的罪人!'],
  crashReact: ['跌停!谁在砸盘?!我账户绿得发光!','挂了几万手卖单出不去,谁能救救我!','完了完了,明天会不会继续……','天台的风好大,让我先冷静一下。','说好的护盘呢?护盘的人呢?!'],
  /* 满仓叙事(②社区反馈可视化):本回合真实掏钱最多的散户,把买入写成帖子,{v}=万股 */
  buyActions: ['这次是真的梭了,全部积蓄都砸进去了,不看了。','跟上了!年终奖全押了,老师别骗我。','下个月的房租也投了,吃泡面也要拿住。','已经全仓上车,坐稳了,谁劝我跟谁急。','这波我信,工资卡都绑定了,当个原始股东。','借钱也要上,就当赌一把明天。'],
  /* 质疑帖(③社区反抗):不可被说服的居民在全网过热时发难 */
  skepticPosts: ['都在喊多,谁在买单?挂单簿不会说谎。','涨成这样,基本面跟得上吗?话我放这儿了。','这种走势我见过太多次——最后接棒的人,已经在排队了。','提醒一句:热度不等于价值。等潮水退了再看。','评论区整齐划一的时候,恰恰最危险。独立思考,勿谓言之不预。','先问是不是,再问为什么——这波上涨的「是不是」,到现在还没人回答。','利益相关:持仓。但今天只想说句公道话:天下没有不散的宴席,只有不认账的剧本。'],
  /* 横盘闲聊(随机事件"chat":没有大动作的回合,生态也有心跳) */
  idleChat: ['横好几天了,庄家是在等我先下车?','这量能,主力还在吗?在线等,挺急的。','每日打卡:今天依然没动静。','薛定谔的主力——你不看盘它就横,你一割它就拉。','横久必涨还是横久必跌?评论区吵了三百楼。','挂单价一分没动,我的心态先动了。','这票现在是真正意义上的"风景线"。','蹲一个后续。有瓜一起吃,没瓜就继续横。'],
  /* 大V互怼 */
  rebuttal: ['@{name} 你知不知道你这句话害了多少人?','@{name} 又是你,上次喊单的帖子删得倒是快。','@{name} 立场可以变,麻烦把持仓截图放出来再喊。','@{name} 看空可以,先标注一下你的仓位再说。'],
  /* 居民自主剧情(横盘闲聊的升级形态):晒单 / 大V删帖 */
  scenario: {
    sun: ['晒个单:这波{stock}已经 +18% 了,感谢当初拿住不卖的自己。[图片:收益截图]','账户新高纪念。别问逻辑,问就是格局。[图片:浮动盈利]','上周割肉的朋友现在后悔了吧?我不是股神,我只是拿得住。'],
    del: ['删掉了之前所有关于{stock}的帖子。不是怂,是最近风声有点紧,各位自己体会。','统一回复:之前的帖子发错了,已删除。评论区不用等更新了。','账户之前被朋友拿去操作过一段时间,相关帖子已清理。以上。'],
  },
  /* 马甲小号帖(发帖动作,{stock}占位) */
  sockpost: [
    { title: '说说为什么我看好{stock}', text: '不吹不黑,这家公司的业务正在兑现的前夜。市场给它定价的是"故事",而不是"事实"。懂的自然懂。' },
    { title: '{stock}:被严重低估的隐形冠军', text: '翻开同行数据对比一下:估值折价,筹码集中。这种结构,稍微一点火就着。' },
    { title: '关于{stock},说几句大实话', text: '很多人问我还拿不拿。我的答案很简单:筹码结构决定一切,而现在,浮动的筹码越来越少了。' },
    { title: '纳闷,为什么还有人看空{stock}?', text: '利空是拿来吓散户的,逻辑是留给明白人的。三个月后回来给这条帖子点赞。' },
    { title: '{stock}的市值,配得上它的野心吗?', text: '对标同行市值至少还有一倍空间。别问我空间怎么算的,问就是产业链调研。' },
  ],
  /* 热搜词条(买热搜动作,{stock}/{x}阅读量/{i}名次/{h}小时占位) */
  hotwords: [
    '词条:#{stock} 隐藏利好# 冲上第 {i} 位,阅读 {x} 万。评论区已控评,只留了三条「理性讨论」。',
    '词条:#{stock} 神秘股东# 阅读量 {x} 万。词条下的长文分析,已经被顶到第一。',
    '词条:#{stock} 二波启动# 热搜第 {i} 名,在榜持续 {h} 小时。',
    '词条:#谁在买{stock}# 阅读量 {x} 万。这个讨论方向,正是我们想让大家讨论的方向。',
  ],
  news: {
    sector_up: { title: '行业利好', body: '虚拟世界博览会开幕,「{topic}」概念全线走强,{stock}所在的云端交易所板块资金流入明显。' },
    market_drop: { title: '大盘跳水', body: '云端综指午后跳水,题材股集体回落,恐慌情绪蔓延,多股翻绿。' },
    media_q: { title: '媒体质疑', body: '《云上财经》发文质疑{stock}「营收成谜:爆款故事背后,订单在哪里?」,评论区吵翻了天。' },
    fight: { title: '股吧对线', body: '{stock}吧爆发大规模对线:看多派与唱空派互相举报,管理员连夜加精 37 个帖子。' },
    lhb: { title: '龙虎榜', body: '{stock}登上龙虎榜:某"知名游资席位"出现在卖方前列,卖出金额引发热议。' },
    kol_joint: { title: '答主联名', body: '一百二十七位职业答主联名发布《我们为什么重新审视{stock}》:订单、现金流、产业链三线论证看多。高赞第一的评论问:「这次是真的价值发现,还是新一轮带节奏?」' },
    roundtable: { title: '圆桌收录', body: '「财富密码 2026」圆桌收录了关于{stock}的讨论,话题页一夜涌入百万围观。主持人置顶「理性讨论,注意风险」,随即被三百条「已上车」淹没。' },
    doxxed: { title: '马甲现形', body: '连日发布「独立分析」坚定看多{stock}的匿名用户被网友开盒:实名信息指向{stock}市场部员工。评论区炸锅——「原来『独立思考』也是可以批量生产的。」' },
  },
  market: {
    policy_tight: { body: '六部门联合印发《关于规范虚拟题材营销行为的若干规定》,点名「{topic}」类概念炒作,解读文章铺天盖地。' },
    policy_ease: { body: '「云端新质发展基金」公布首批补贴清单,{stock}所在的{topic}方向在列,卖方连夜开电话会。' },
    rate_ease: { body: '云端央行宣布降准 0.5 个百分点,市场解读为「水来了」,题材股集体异动。' },
    rate_tight: { body: '公开市场操作连续净回笼,隔夜利率走高,多家券商提醒「题材股估值承压」。' },
    rival_launch: { body: '老对手「衡宇科技」召开发布会,推出直接对标{stock}的新品,参数对比打在大屏上,弹幕一片唏嘘。' },
    rival_fail: { body: '同赛道明星公司「宏图智造」被曝大规模召回,投资者开始寻找「下一个替代标的」。' },
    supply: { body: '多家机构调研纪要显示,{topic}核心部件上游报价上行,毛利率担忧升温。' },
    viral: { body: '一条「沉浸式体验{topic}」的短视频冲上热门,评论区从质疑到真香的转折只用了三个小时。' },
    boycott: { body: '有用户发起「{stock}是不是智商税」的万人投票,负面词条短暂冲上同城热榜。' },
    celebrity: { body: '头部主播「仓鼠哥」在直播间连麦体验{topic},当晚相关讨论量翻了两番。' },
    rumor_good: { body: '几经发酵,关于{stock}的传闻被多方信源坐实,买盘闻风而动。' },
    rumor_bad: { body: '关于{stock}的传闻被官方辟谣:原帖已删,造谣账号被封禁。先信的人,已经先亏了。' },
    earn_good: { body: '盘后公告:{stock}季度营收超市场一致预期,管理层上调全年指引,卖方连夜修改目标价。' },
    earn_bad: { body: '盘后公告:{stock}营收不及预期,管理层在电话会上把原因归结为「行业周期」。评论区没几个信的。' },
    /* 多样性扩池:股东/空头/平台/解禁/粉丝/爆料/分红 */
    holder_sell: { body: '公告:持股 8.4% 的早期股东「青崖创投」拟清仓减持。评论区第一高赞:「他们比谁都清楚这公司值多少钱。」' },
    short_report: { body: '海外做空机构「灰狼资本」发布报告,称{stock}「叙事与现金流严重脱节」,并暗示背后有操纵之手。多空双方在评论区短兵相接。' },
    algo_limit: { body: '多位用户反映{stock}相关内容的曝光量断崖式下跌,「疑似被平台限流」。讨论少了,买盘池的燃料也少了。' },
    unlock: { body: '今日解禁:{stock}一批限售股到期流通,抛压预期升温。卖方在晨会纪要里只写了四个字:「注意节奏」。' },
    fan_support: { body: '{topic}的粉丝社群发起「万人应援」:晒单、控评、二创齐上阵,相关话题阅读量一夜翻倍。' },
    employee_leak: { body: '一位匿名认证用户发布长文,自述为{stock}前员工,爆料多个内部细节。真伪未定,但评论区已经开始「逐条核实」。' },
    dividend: { body: '公告:{stock}拟每十股派发现金红利,上市以来首次。稳健派松了口气:「至少现金流是真的。」' },
    /* 事件连锁(上一回合事件的后劲) */
    chain_viral: { body: '出圈的代价来了:有人把{stock}三年前的质检投诉翻了出来,一夜之间顶上热榜。之前喊着「真香」的评论,开始成批消失。' },
    chain_boycott_good: { body: '{stock}发布正式回应:公布检测报告、开放工厂直播、承诺「不满意全款退」。万人投票的风向,一夜之间掉了个头。' },
    chain_boycott_bad: { body: '{stock}的回应声明被网友逐句拆解,又被扒出配图有 P 图痕迹。「回应了,但更糟了」冲上热搜。' },
    chain_celeb: { body: '头部主播「仓鼠哥」被扒出多次带货翻车史,当晚掉粉三十万。他连麦体验过的{stock},评论区整齐地刷起了「快跑」。' },
    /* 黑天鹅(伏笔的兑现) */
    swan_dump: { body: '开盘即是闷杀:某个神秘账户不计成本地向下砸盘,买一价位被瞬间击穿。有人在跑,而且跑得毫不掩饰。' },
    swan_raid: { body: `${STOCK.regulator}突击检查{stock}办公地:电脑、聊天记录、交易终端全部封存。公关部电话被打爆,官方口径只有一句「配合调查」。` },
    swan_buy: { body: '尾盘突然出现一位「扫地僧」:连续大单把抛压全部吃下,股价 V 型拉起。龙虎榜要明天才见分晓,但所有人都开始重新估值。' },
    swan_dig: { body: '凌晨一点,那篇「明天见」的长文准时发出:供应链合同、会议纪要、转账截图,一条比一条扎实。知友的考据精神,有时候比监管还可怕。' },
  },
  rumors: [
    { text: '有媒体爆料,{stock}正与产业巨头「云梯资本」接触,传闻将获战略入股。', good: true },
    { text: '论坛流出疑似{stock}中标海外大单的截图,金额被传「数倍于去年营收」。', good: true },
    { text: '坊间传闻监管组已收到针对{stock}的举报材料,称其{topic}数据造假。', good: false },
    { text: '有小作文称{stock}核心团队将在融资到期前集体离职,配图聊天记录真假难辨。', good: false },
  ],
  reg: {
    inquiry: { title: '问询函', body: `${STOCK.regulator}:近期{stock}({code})股价波动异常,现要求公司就"是否存在应披露未披露重大事项"作出书面说明。` },
    halt: { title: '盘中临时停牌', body: `{stock}盘中波动异常,${STOCK.regulator}决定实施临时停牌,两个回合后方可恢复交易。` },
    exposure: { title: '监察动态', body: `${STOCK.regulator}内部通报:已对{code}账户异动启动重点监控,多个关联账户被标记。` },
    case: { title: '立案调查', body: `${STOCK.regulator}公告:对{stock}股票异常交易立案调查,相关账户被限制交易。` },
  },
};

/* 对手盘 × 暗雷:文案池(挂到 T 上随既有导出走) */
Object.assign(T, {
  rivalAtkTitle: {
    org: ['先问是不是:{stock}的营收,到底是不是真的?', '三份合同,五个疑点:{stock}的现金流去哪了?', '我们把{stock}的公告翻了三遍,发现了这些'],
    hotmoney: ['盘口说话:{stock}的每一根阳线,都是画出来的', '今天{stock}的分时图,教科书级别的「温柔出货」', '别追{stock}了,听我一句劝'],
    emotion: ['{stock}的粉丝急了,急了就对了', '吃瓜前线:{stock}的评论区已经吵到需要小管家出场了', '一个冷知识:越是天天发长文解释的,越是心虚'],
    anon: ['关于{stock},说一点内部的情况(匿名保命)', '我离开{stock}半年了,有些话憋着难受', '只说一个细节,懂{stock}的自然懂'],
  },
  rivalAtkBody: {
    org: ['先问是不是,再问为什么。{stock}的故事很动听,但我们核对了近三个季度的数据:应收账款增速是营收的两倍,经营现金流连续为负。故事讲得再好,也要有人真金白银买单。数据来源已附,欢迎逐条反驳。',
          '我们不做空梦想,只核对数字。{stock}宣称的「颠覆式创新」,同类公司至少三家做过,活下来那家的估值只有它的三分之一。这中间的差价,叫叙事溢价。',
          '声明:本账号与任何机构无关,利益相关:无。以下所有数据均来自公开资料——看完之后,你再决定要不要在评论区喊「格局」。'],
    hotmoney: ['看盘二十年,这种走势我见多了:早上拉、下午砸、尾盘偷袭,量价背离得离谱。主力在出,散户在接。话放在这,周五见分晓。不信的,收藏这条帖子。',
          '有人问我为什么看空{stock}?我不看空,我只是不装睡。龙虎榜天天见,散户天天追——这个游戏里谁是台面、谁是筹码,还不清楚吗?',
          '量在价先。{stock}的量能结构已经散了,现在每一根阳线都是逃命的机会。爱听不听,钱是你自己的。'],
    emotion: ['本来不想说,但评论区实在太好笑了。看多的说「格局」,看空的说「报应」,中间派在问「能不能回本」。都别吵了——你们赚钱了吗?没有?那就都消停会儿。',
          '一个冷知识:越是天天发长文解释的,越是心虚。{stock}这几天的帖子浓度,堪比流量明星的控评现场。瓜已就位,坐等后续。',
          '友情提醒:热度是会退的,潮水也是。到时候记得回来看看,今天喊「格局」的人和今天喊「快跑」的人,是不是同一批。'],
    anon: ['利益相关:前员工,匿了。就说一件事:内部对「数据口径」的说法,和对外的说法,不是同一套。别问细节,问就是不知道,我只是个做表的。信不信随你们。',
          '只说一个细节,懂的自然懂:上个月核心团队有人闷声减持了。对外的说法是「个人资金需求」。嗯,个人资金需求。',
          '不想多说什么,就说一句:{stock}内部真正了解情况的人,没有一个在加仓。这个信息免费,值多少钱你们自己定。'],
  },
  rivalJab: ['就这?也配这么多关注?', '不是我唱空,是K线在唱空。', '评论区整齐得像彩排过的。', '提醒一句:热度退得比潮水快。', '静观其变,让子弹再飞一会儿。'],
  rivalGloat: ['我说什么来着?数据不会说谎,但发帖的人会。', '深扒不易,点个关注不迷路——接下来还有续集。', '不是我要做空谁,是真相自己会做空。', '键盘敲下去的时候,我就知道会走到今天。'],
  rivalDefect: ['看了这么多天,我收回之前的话——这家公司确实有问题。', '之前是我被带节奏了,抱歉。现在我只说我自己查到的。', '友军们,冷静一点,有些数据经不起细看。'],
  duelWin: ['评论区风向逆转:高赞开始逐条反驳做空帖,「利益相关:满仓」的玩梗盖过了质疑。', '这一波回击条理清晰、数据扎实,连中立的观察者都开始转发你的回应。'],
  duelLose: ['回击避重就轻,高赞评论区留下了那句:「答非所问,是不是默认了?」', '反驳没挡住质疑,反而把话题送上了更大的热度。'],
  duelIgnored: ['对线帖挂了一整回合无人应战,「默认属实」的猜测开始发酵。', '沉默被解读成了心虚——空白的评论区,全是别人的声音。'],
  rivalBust: ['平台公告:该账号因「发布不实信息、涉嫌有组织操纵舆论」被禁言处置。其历史内容正在被逐条复核,评论区已变成大型「早看它不对劲」现场。',
    '实锤发酵:这个「独立账号」被扒出与多方存在未披露的利益往来。它曾高举的「理性」大旗,成了最讽刺的注脚。'],
  minePressWarn: '有个财经记者在群里打听咱们公司两年前的一笔旧账,说是在「做选题」。不知道能不能发出来。',
});

/* 随机市场事件池:政策面/宏观面/同行面/消费面 + 传闻两段式 + 股东/空头/平台/解禁/粉丝/爆料/分红。文本见 T.market */
const EVENTS = [
  { key: 'sector_up', w: 3 },
  { key: 'market_drop', w: 3 },
  { key: 'media_q', w: 2 },
  { key: 'fight', w: 3 },
  { key: 'policy_tight', w: 1.5 },
  { key: 'policy_ease', w: 1.5 },
  { key: 'rate_ease', w: 1 },
  { key: 'rate_tight', w: 1 },
  { key: 'rival_launch', w: 1.5 },
  { key: 'rival_fail', w: 1.5 },
  { key: 'supply', w: 1.5 },
  { key: 'viral', w: 2 },
  { key: 'boycott', w: 1.5 },
  { key: 'celebrity', w: 1 },
  { key: 'kol_joint', w: 1.5 },
  { key: 'roundtable', w: 1.5 },
  { key: 'doxxed', w: 1.2 },
  { key: 'holder_sell', w: 1.5 },
  { key: 'short_report', w: 1 },
  { key: 'algo_limit', w: 1.2 },
  { key: 'unlock', w: 1.2 },
  { key: 'fan_support', w: 1.5 },
  { key: 'employee_leak', w: 1.2 },
  { key: 'dividend', w: 1 },
  { key: 'rumor', w: 2 },
  { key: 'none', w: 3.5 },
];

/* ---------------- 市场天气(回合情境层) ----------------
 * 每回合掷一个全局状态:玩家先看天气再定打法,和基因/事件自动共振。
 * 第 1 回合固定无风(教学动线稳定);同一天气不连任。 */
const WEATHERS = {
  calm:      { icon: '🌤', name: '无风',     desc: '今天没有风也没有雨,盘面按常理走。' },
  chase:     { icon: '🔥', name: '追涨日',   poolBoost: 1.12, negSoft: 0.8, desc: '风险偏好拉满:负面事件的情绪冲击 ×0.8,买盘池 +12%——今天适合点火。' },
  riskoff:   { icon: '🛡', name: '避险日',   negAmp: 1.25, clarifyAmp: 1.5, desc: '资金躲进防御板块:负面事件的情绪冲击 ×1.25,「澄清」降温效果 +50%——今天别硬拉。' },
  gossip:    { icon: '🍉', name: '吃瓜日',   heatDrift: 3, heatAmp: 1.25, desc: '全平台都在吃瓜:舆论动作热度获取 +25%,收盘热度自然 +3——流量便宜的日子。' },
  crackdown: { icon: '👮', name: '严打周',   regAmp: 1.35, regHalf: true, desc: '风声最紧:连板/出货/大招的监管代价 ×1.35,监管关注度衰减减半——今天动作要轻。' },
  rotation:  { icon: '🔄', name: '题材轮动', volAdd: 1.25, evAmp: 2, desc: '资金在题材之间搬家:行业/同行/消费面事件权重 ×2,盘面波动 +25%——今天消息面很吵。' },
};
const WEATHER_DRAW = [['calm', 3], ['chase', 1], ['riskoff', 1], ['gossip', 1], ['crackdown', 0.7], ['rotation', 1]];
function wdef(st) { return WEATHERS[st.weather] || WEATHERS.calm; }
function rollWeather(st) {
  st.weather = pickWeighted(WEATHER_DRAW.filter(x => x[0] !== st.weather).map(([k, w]) => ({ w, v: k })));
  return st.weather;
}
function wReg(st, x) { const w = wdef(st); return x > 0 && w.regAmp ? x * w.regAmp : x; }   // 严打周:只放大正监管代价,不放大减免

/* ---------------- 三段弧线(建仓 1-5 / 发酵 6-10 / 决战 11-15) ----------------
 * 各阶段一套事件权重乘数 + 抉择概率:解决「第 3 回合和第 13 回合手感一样」。 */
const PHASES = [
  { name: '建仓期', tip: '前五回合风平浪静:负面事件少而轻,是悄悄建仓的窗口。' },
  { name: '发酵期', tip: '中盘五回合:传闻、热点、竞品轮番上桌,抉择也开始敲门。' },
  { name: '决战期', tip: '最后五回合:监管收紧、空头出没,无事的回合几乎绝迹。' },
];
function phaseOf(r) { return r <= 5 ? 0 : r <= 10 ? 1 : 2; }
const PHASE_EV_MODS = [
  { none: 1.6, market_drop: 0.7, boycott: 0.7, media_q: 0.8, doxxed: 0.8, supply: 0.8, rival_launch: 0.8 },
  { none: 0.8, rumor: 1.6, viral: 1.3, celebrity: 1.3, kol_joint: 1.3, roundtable: 1.3, fight: 1.2 },
  { none: 0.5, policy_tight: 1.6, rate_tight: 1.6, media_q: 1.4, market_drop: 1.4, holder_sell: 1.4, short_report: 1.4, employee_leak: 1.3, unlock: 1.3 },
];
const PHASE_DECISION_P = [0.14, 0.18, 0.25];
/* 题材轮动日:这些"消息面"事件的权重 ×3 */
const ROT_EV_KEYS = { sector_up: 1, rival_launch: 1, rival_fail: 1, supply: 1, viral: 1, boycott: 1, celebrity: 1, fan_support: 1 };

/* ---------------- 黑天鹅(伏笔两段式) ----------------
 * 发酵期/决战期小概率埋一条不起眼的伏笔帖,下一回合的事件位被它引爆;
 * 每局至多 2 只,不重复。有预告,所以公平;稀有,所以记得住。 */
const SWANS = {
  whale_dump: { name: '大资金对砸', plant: '盘口总有一笔不小的大单反复挂了又撤,像是在试探池子深浅——这不像是散户的手笔。',
    fx(st, mv, push) { push('突发', '大资金对砸', T.market.swan_dump.body, 't-dn', randInt(2000, 9000));
      mv(-10); allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 7, 0, 100); n.arousal = clamp(n.arousal + 10, 0, 100); }); st.poolShockRounds = Math.max(st.poolShockRounds, 2);
      return '伏笔应验——大资金对砸:情绪 -10、信心 -7、唤醒 +10,买盘池受惊 2 回合。'; } },
  reg_raid: { name: '监管突袭', plant: '有知友说在监察部楼下看到好几家财经媒体的车。没人知道在查什么,都在猜。',
    fx(st, mv, push) { push('监管', '监管突袭', T.market.swan_raid.body, '', randInt(1500, 6000));
      st.reg += 10; st.heat = clamp(st.heat + 6, 0, 100); allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 6, 0, 100));
      return '伏笔应验——监管突袭:监管 +10、信心 -6。今晚没人睡得着。'; } },
  mystery_buy: { name: '神秘大佬护盘', plant: '尾盘出现连续的整数手买单,不急不慢,吃相很稳。有人在悄悄收筹码。',
    fx(st, mv, push) { push('突发', '神秘大佬护盘', T.market.swan_buy.body, 't-up', randInt(2000, 9000));
      mv(10); st.heat = clamp(st.heat + 8, 0, 100); st.poolBoostNext = Math.max(st.poolBoostNext || 1, 1.15);
      return '伏笔应验——神秘大佬护盘:情绪 +10、热度 +8,下回合买盘池 +15%。'; } },
  deep_dig: { name: '知友深扒长文', plant: '有位知友放话:挖到了一份关键的供应链合同,长文正在写,「明天见」。',
    fx(st, mv, push) { push('突发', '知友深扒长文', T.market.swan_dig.body, 't-dn', randInt(2000, 9000));
      mv(-6); allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 12, 0, 100)); st.reg += 8; st.heat = clamp(st.heat + 10, 0, 100);
      return '伏笔应验——知友深扒:信心 -12、情绪 -6、监管 +8、热度 +10。'; } },
};

/* ---------------- 事件连锁(事件的后劲) ----------------
 * viral/boycott/celebrity 在下一回合的事件位结算连锁结果,只连锁一层。 */
const CHAINS = {
  viral_backlash: { p: 0.5,
    fx(st, mv, push) { push('消费', '出圈反噬', T.market.chain_viral.body, 't-dn', randInt(600, 3000));
      mv(-5); allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 10, 0, 100)); st.heat = clamp(st.heat + 8, 0, 100); st.reg += 4;
      return '出圈反噬:信心 -10、情绪 -5、热度 +8、监管 +4。'; } },
  boycott_reply: { p: 1,
    fx(st, mv, push) {
      if (Math.random() < 0.6) { push('公告', '官方回应奏效', T.market.chain_boycott_good.body, 't-up', randInt(400, 2000));
        mv(5); st.reg = Math.max(0, st.reg - 3); st.heat = Math.max(0, st.heat - 4);
        return '官方回应奏效:情绪 +5、监管 -3、热度 -4。'; }
      push('公告', '回应翻车', T.market.chain_boycott_bad.body, 't-dn', randInt(600, 2600));
      mv(-4); st.heat = clamp(st.heat + 6, 0, 100); st.reg += 5;
      return '回应翻车:情绪 -4、热度 +6、监管 +5。'; } },
  celeb_bust: { p: 0.35,
    fx(st, mv, push) { push('消费', '主播翻车', T.market.chain_celeb.body, 't-dn', randInt(800, 3200));
      mv(-5); allNPCs(st).forEach(n => n.arousal = clamp(n.arousal + 6, 0, 100)); st.heat = clamp(st.heat + 8, 0, 100);
      return '主播翻车:情绪 -5、唤醒 +6、热度 +8。'; } },
};

/* ---------------- 知乎小管家支线(每回合一个可选小目标,结算时判定) ---------------- */
const SIDE_TASKS = [
  { key: 'op2',     name: '舆论打卡日', hint: '完成 ≥2 次任意舆论操作', reward: '下回合行动点 +1' },
  { key: 'silent',  name: '静默观察日', hint: '不使用任何付费舆论操作(免费的发帖/自答不受限)', reward: '监管关注度 -3' },
  { key: 'heat55',  name: '造势达标日', hint: '使用「发帖」,且收盘时热度 ≥ 55', reward: '下回合买盘池 +8%' },
  { key: 'answer',  name: '创作激励日', hint: '使用一次「自问自答」', reward: '盐选分成 +60 万' },
  { key: 'nosell',  name: '耐心资本日', hint: '不挂任何卖出挂单', reward: '下回合买盘池 +5%' },
  { key: 'clarify', name: '危机公关日', hint: '使用一次「澄清公告」', reward: '收盘时监管额外 -3' },
  { key: 'counter', name: '多空对决日', hint: '在 feed 对线卡上成功「回击」一次对手', reward: '监管关注度 -3' },
  { key: 'minedef', name: '排雷日', hint: '完成一次「内部自查」或「处理暗雷」', reward: '下回合买盘池 +6%' },
];
function taskOf(st) { return SIDE_TASKS.find(t => t.key === st.sideTask) || null; }
function assignTask(st) {
  const t = pick(SIDE_TASKS.filter(x => x.key !== st.sideTask));
  st.sideTask = t.key;
  return t;
}

const VACCINES = [
  { key: 'writer', name: '离职员工自述体', real: '「前员工爆料帖」:身份无法验证,发布时间恰与行情共振,细节煽情但不可查证。', tip: '看到"内部人士"爆料,先查账号历史与发帖时机。' },
  { key: 'hot', name: '买热搜', real: '热搜榜是可以被购买的。突然爆榜、无信源、评论区整齐划一,都是信号。', tip: '热搜 ≠ 真实关注度,先找原始信源。' },
  { key: 'kol', name: '充值大V喊单', real: '「恰饭喊单」:大V立场可以与收益挂钩,且不必向你披露。', tip: '关注大V是否披露利益关系,历史立场是否反复横跳。' },
  { key: 'astroturf', name: '自问自答造势', real: '马甲账号提问+马甲回答,制造"大家都在买"的氛围。', tip: '看回答账号的注册时间与提问-回答时间差。' },
  { key: 'post', name: '亲自带节奏', real: '情绪化短帖是成本最低的引导工具,常成批出现。', tip: '同一话术反复出现时,警惕有组织的引导。' },
  { key: 'wash', name: '对倒放量', real: '「虚假放量」:自买自卖制造成交活跃的假象,让盘面看起来"有资金进场"。', tip: '放量要看真实性:只有量能异动、却找不到对应消息与成交分布的"活跃",多半是演的。' },
];

/* ============================================================
 * 对手盘 × 暗雷(信息战扩展包)
 * 对手盘:一位有名字/人设/资金池的舆论对手,敌意随你赚钱升高,五级阶梯升级手段;
 * 暗雷:每局公司藏一颗雷,记者/对手/自查三条引线,自爆洗白代价远小于被挖。
 * 对手的帖子走同一条舆论→价格管道:杀伤 = 基础值 × 人设杀伤 × (0.4 + cred/100×0.8)。
 * ============================================================ */
const RIVAL_DEFS = {
  org:      { persona: '空头机构号', cred0: 80, pool0: 5000, grow: 0.8, dmg: 1.2, prefArch: ['hardtech', 'biotech'], rivalMine: '利益相关持仓' },
  hotmoney: { persona: '游资大V',     cred0: 55, pool0: 4000, grow: 1.2, dmg: 1.0, prefArch: ['newretail', 'entertain', 'livelihood'], rivalMine: '老鼠仓' },
  emotion:  { persona: '情绪贩子',   cred0: 45, pool0: 3000, grow: 1.0, dmg: 0.9, prefArch: ['beauty', 'newretail'], rivalMine: '收钱发帖' },
  anon:     { persona: '匿名巨佬',   cred0: 70, pool0: 3500, grow: 0.9, dmg: 1.1, prefArch: ['military', 'industrial'], rivalMine: '马甲身份' },
};
const RIVAL_NAMES = {
  org: ['格雾财经观察', '云端洞见 Research', '灰狼资本分号', '明镜做空研究'],
  hotmoney: ['热钱猎手', '涨停敢死队长', '北向之后', '游资老周'],
  emotion: ['财经瓜主', '拆台bot', '老韭菜观察', '评论区纪委'],
  anon: ['一位前高管', '知情人士', '不愿透露姓名的监事'],
};
/* 暗雷池:dig = 被挖全额引爆;defuse = 自爆洗白(代价 ≈ 被挖的四成 + 现金)。
 * archs = 偏好赛道(命中后进入抽取池),null = 通用。 */
const MINES = {
  rev_probe:     { name: '财务修饰·提前确认营收', archs: null,
    dig: { mv: -18, reg: 20, conf: -15, heat: 12, cash: 0 }, defuse: { mv: -8, reg: 8, cash: 1000 },
    clue: '有四个季度的营收确认时点「提前」了——审计师口头提醒过,书面记录被归档为「暂缓披露」。',
    digText: '调查实锤:{stock}连续数季提前确认营收,审计底稿与对外口径存在系统性差异。财报发出当天,董秘电话被打爆。',
    defuseText: '公司发布《关于收入确认会计处理的说明》,主动更正前期口径并追溯调整报表,审计机构同步出具专项意见。评论区分裂成「坦诚加分」与「果然有事」两派。' },
  data_forg:     { name: '临床/数据造假', archs: ['hardtech', 'biotech'],
    dig: { mv: -16, reg: 18, conf: -18, heat: 14, cash: 0 }, defuse: { mv: -6, reg: 10, cash: 1200 },
    clue: '核心数据有一版「好看一点的」备份——原始版本还在某台没联网的旧机器里。',
    digText: '匿名爆料:{stock}的对外数据与原始记录不一致,「好看的那一版」截图已在多个群流传,专家号连夜逐帧对比。',
    defuseText: '公司宣布启动第三方全量复测并公开原始数据,首轮复测结果两周内披露。市场对「敢公开」给了有限的宽容。' },
  founder_bg:    { name: '创始人履历注水', archs: null,
    dig: { mv: -10, reg: 4, conf: -20, heat: 15, cash: 0 }, defuse: { mv: -4, reg: 2, cash: 0 },
    clue: '创始人的「海外名校硕士」项目,学制其实只有八个月,而且主要在线上。',
    digText: '吃瓜实锤:{stock}创始人的「海外名校硕士」被扒出是八个月线上项目,校友名单里查无此人。履历不直接影响财报,但直接影响人心。',
    defuseText: '创始人主动发长文《我的学历,以及比学历更重要的事》,承认项目为短期线上课程,并晒出完整教育与创业时间线。「坦诚」的口碑意外地能打。' },
  supply_chain:  { name: '供应链代工黑幕', archs: ['livelihood', 'newretail', 'industrial'],
    dig: { mv: -12, reg: 15, conf: -10, heat: 10, cash: 0 }, defuse: { mv: -5, reg: 6, cash: 800 },
    clue: '主力代工厂的环评手续「还在补」,废水去向没人说得清。',
    digText: '调查报道:{stock}主力代工厂环评手续不全,卫星图上的排污口与官方说法对不上。下游品牌方开始「重新评估合作」。',
    defuseText: '公司宣布代工产线整体迁入合规园区,并开放第三方环保审计。代价不小,但雷管自己攥在手里总比攥在记者手里强。' },
  tax_issue:     { name: '税务问题', archs: null,
    dig: { mv: -12, reg: 25, conf: -8, heat: 8, cash: 2000 }, defuse: { mv: -5, reg: 8, cash: 1200 },
    clue: '两笔大额咨询费付给了一家员工只有一个人的公司,发票是真的,服务说不清。',
    digText: '监管通报:{stock}因涉嫌通过虚开咨询费转移利润被立案稽查,两名财务负责人被约谈。补缴与罚款将另行通知。',
    defuseText: '公司主动补申报并披露关联咨询交易全貌,承诺整改报销审批流。「自己先开口」的代价,比被稽查通知小得多。' },
  pledge:        { name: '大股东质押爆仓', archs: null,
    dig: { mv: -15, reg: 10, conf: -12, heat: 10, cash: 0 }, defuse: { mv: -6, reg: 4, cash: 1500 },
    clue: '大股东质押比例早就过了预警线,补仓通知在秘书的抽屉里压了两周。',
    digText: '盘面异动:{stock}大股东质押触及平仓线,强制减持公告出现在交易时段最后一分钟。质押盘的踩踏,比任何空头都狠。',
    defuseText: '大股东补充质押物并披露降低质押率的分步计划,平仓警报暂时解除。市场对「缓冲垫」的信心,取决于它还剩多厚。' },
  privacy:       { name: '用户数据违规', archs: ['hardtech', 'newretail', 'entertain'],
    dig: { mv: -14, reg: 20, conf: -12, heat: 18, cash: 0 }, defuse: { mv: -6, reg: 12, cash: 0 },
    clue: '「匿名化」的用户数据其实连着设备号,买方名单里有两家你叫得出名字的公司。',
    digText: '实锤爆料:{stock}所谓「匿名化」的用户数据仍可关联到设备号,采购方名单已在知乎匿名区流传。「卖用户」是最炸的雷,没有之一。',
    defuseText: '公司发布《用户数据治理整改公告》,切断设备号关联并公开数据合作伙伴清单。道歉信文学这次写得意外地诚恳。' },
  labor:         { name: '职场压榨爆料', archs: null,
    dig: { mv: -8, reg: 6, conf: -14, heat: 12, cash: 0 }, defuse: { mv: -3, reg: 2, cash: 800 },
    clue: '月末冲刺的「自愿加班」打卡记录,和裁员赔偿的 N+1 底账,对不上。',
    digText: '职场爆料:{stock}「自愿加班」打卡记录与裁员 N+1 底账同时流出,员工和股民第一次站在了同一边:都在骂。',
    defuseText: '公司宣布取消大小周试点、补足离职补偿差额。人力成本涨了一点,但「员工和股民同一边」的局面散了。' },
  ad_fake:       { name: '虚假宣传', archs: ['beauty', 'livelihood', 'newretail'],
    dig: { mv: -12, reg: 18, conf: -10, heat: 12, cash: 0 }, defuse: { mv: -5, reg: 8, cash: 0 },
    clue: '详情页里「7 天见效」的临床依据,是一份样本量 12 人的内部观察报告。',
    digText: '打假实锤:{stock}详情页「7 天见效」的依据,是一份样本量 12 人的内部观察报告。截图挂上热榜那天,客服话术改了三版。',
    defuseText: '公司下架全部功效宣称物料,改为「体验因人而异」口径,并公布真实样本量的用户调研。「不吹了」本身,成了新的卖点。' },
  channel_bribe: { name: '渠道返利·商业贿赂', archs: ['beauty', 'livelihood'],
    dig: { mv: -14, reg: 22, conf: -10, heat: 8, cash: 0 }, defuse: { mv: -6, reg: 10, cash: 1500 },
    clue: '渠道返利走的是「市场服务费」,收款方的法人是你司前司机的小舅子。',
    digText: '监管通报:{stock}渠道返利以「市场服务费」名义走账,收款方关联关系被逐层扒出。渠道商集体噤声,稽查组进场。',
    defuseText: '公司主动披露渠道返利结构并终止涉事代理合同,引入第三方合规审计。返利照发,但从此有了发票意义上的清白。' },
  ip_theft:      { name: '知识产权窃取', archs: ['hardtech', 'biotech'],
    dig: { mv: -16, reg: 15, conf: -14, heat: 10, cash: 0 }, defuse: { mv: -8, reg: 6, cash: 2000 },
    clue: '三份核心专利的第一发明人,简历与友商某离职时间线高度重合。',
    digText: '诉讼爆点:竞对起诉{stock}三项核心专利侵权,第一发明人的履历与友商离职时间线高度重合。禁售令若落地,产线说停就停。',
    defuseText: '公司与竞对达成专利和解并交叉授权,和解费不菲,但换来了「可以安心做产品」的两年。' },
  related_deal:  { name: '关联交易未披露', archs: null,
    dig: { mv: -10, reg: 25, conf: -10, heat: 8, cash: 0 }, defuse: { mv: -5, reg: 12, cash: 0 },
    clue: '最大供应商的实控人,是你创始人的表弟——工商信息只隔着两层。',
    digText: '监管问询:{stock}最大供应商实控人与创始人的亲属关系被媒体逐层扒出,关联交易未披露问询函随之而至。',
    defuseText: '公司主动披露全部关联交易并补开董事会决议。「主动披露」在监管口径里,从来都是最便宜的选项。' },
};

function makeRival() {
  const arch = ctrait().arch;
  const pref = Object.keys(RIVAL_DEFS).filter(k => RIVAL_DEFS[k].prefArch.includes(arch));
  const key = (pref.length && Math.random() < 0.65) ? pick(pref) : pick(Object.keys(RIVAL_DEFS));
  const D = RIVAL_DEFS[key];
  return { key, name: pick(RIVAL_NAMES[key]), persona: D.persona, cred: D.cred0, hostility: 15,
    pool: D.pool0, done: false, duelCard: null, losses: 0, digUsed: false, smashUsed: 0,
    digsUsed: 0, allyRounds: 0, quietRounds: 0, counterRound: -1, reportRound: -1,
    hotTopic: null, lastAct: '尚未现身,只在龙虎榜挂了对倒单', mineBlown: false };
}
function makeMine() {
  const arch = ctrait().arch;
  const keys = Object.keys(MINES).filter(k => !MINES[k].archs || MINES[k].archs.includes(arch));
  const key = pick(keys);
  return { key, name: MINES[key].name, hidden: true, discovered: false, defused: false, exploded: false, warnRound: -1, probed: false };
}

/* 暗雷引爆(source = 'rival' 对手挖雷 / 'press' 记者落地):排雷/引爆后不可重复。
 * 引爆尺度(回测调参结论 20260913a):情绪/热度/现金全额(戏剧性落点),监管/信心打折
 * ——全额的 reg/conf 会把稳健基线打出 20pp 以上的深坑,打折后保持「重锤但不锁死」。 */
const BLAST_SCALE = { reg: 0.7, conf: 0.6 };
function explodeMine(st, source, mv, pushNews, tips) {
  const m = st.mine;
  if (!m || m.exploded || m.defused) return null;
  const M = MINES[m.key];
  m.exploded = true; m.discovered = true; m.hidden = false;
  const regHit = Math.round(M.dig.reg * BLAST_SCALE.reg);
  const confHit = Math.round(M.dig.conf * BLAST_SCALE.conf);
  mv(M.dig.mv);
  allNPCs(st).forEach(n => n.confidence = clamp(n.confidence + confHit, 0, 100));
  st.reg += regHit;
  st.heat = clamp(st.heat + M.dig.heat, 0, 100);
  if (M.dig.cash) st.cash -= M.dig.cash;
  st.poolShockRounds = Math.max(st.poolShockRounds, 2);
  if (source === 'rival') {
    pushNews('传闻', '匿名爆料:' + m.name, M.digText, 't-dn', randInt(2000, 8000));
    st.feed.push({ type: 'comment', author: st.rival.name, tag: st.rival.persona, text: pick(T.rivalGloat), likes: randInt(300, 1500), round: st.round });
    tips.push('💥 暗雷被「' + st.rival.name + '」挖爆:「' + m.name + '」——情绪 ' + M.dig.mv + '、监管 +' + regHit + (M.dig.cash ? '、现金 -' + M.dig.cash + ' 万' : '') + '。');
  } else {
    pushNews('媒体', '调查报道落地:' + m.name, M.digText, 't-dn', randInt(1500, 6000));
    tips.push('💥 暗雷被记者引爆:「' + m.name + '」——情绪 ' + M.dig.mv + '、监管 +' + regHit + (M.dig.cash ? '、现金 -' + M.dig.cash + ' 万' : '') + '。');
  }
  return M.dig;
}

/* 自爆洗白:代价 ≈ 被挖的四成 + 现金;预警窗口内 = 「主动配合调查」(监管减半,坦诚 buff +1 回合) */
function defuseMine(st) {
  const m = st.mine;
  if (!m) return { ok: false, msg: '本局没有暗雷。' };
  if (m.defused) return { ok: false, msg: '雷已经排了。' };
  if (m.exploded) return { ok: false, msg: '覆水难收:雷已经爆了。' };
  if (!m.discovered) return { ok: false, msg: '你还没查过自家后院——先「内部自查」,或等记者/对手先动手。' };
  const M = MINES[m.key];
  if (M.defuse.cash && st.cash < M.defuse.cash) return { ok: false, msg: '现金不足:处理「' + m.name + '」需要 ¥' + M.defuse.cash + ' 万(召回/补缴/和解)。' };
  const inWindow = m.warnRound >= 0 && st.round <= m.warnRound + 1;
  m.defused = true; m.hidden = false;
  st.honestRounds = inWindow ? 3 : 2;
  const regHit = inWindow ? Math.round(M.defuse.reg / 2) : M.defuse.reg;
  st.reg = clamp(st.reg + regHit, 0, 100);
  st.cash -= M.defuse.cash || 0;
  st.heat = clamp(st.heat + 5, 0, 100);
  allNPCs(st).forEach(n => n.valence = clamp(n.valence + M.defuse.mv, -100, 100));
  st.roundOps.defuse = (st.roundOps.defuse || 0) + 1;
  st.feed.push({ type: 'news', tag: '公告', title: inWindow ? '主动配合调查' : '关于近期市场传闻的几点说明', text: fillStock(M.defuseText), likes: randInt(300, 1500), round: st.round });
  return { ok: true, msg: '🧨 自爆洗白:「' + m.name + '」已排雷(情绪 ' + M.defuse.mv + '、监管 +' + regHit + (M.defuse.cash ? '、现金 -' + M.defuse.cash + ' 万' : '') + ')。' + (inWindow ? '主动配合调查:监管减半,「坦诚」buff 3 回合。' : '「坦诚」buff 2 回合:负面事件情绪冲击 ×0.85。') + '对手再挖只会扑空。' };
}
/* 内部自查(每局一次):揭示雷种,打开自爆选项 */
function probeMine(st) {
  const m = st.mine;
  if (!m) return { ok: false, msg: '本局没有暗雷。' };
  if (m.defused || m.exploded) return { ok: false, msg: m.defused ? '雷已排,不用再查。' : '覆水难收:雷已经爆了。' };
  if (m.probed) return { ok: false, msg: '本局已完成自查(每局一次)。' };
  if (st.ap < 1) return { ok: false, msg: '行动点不足:内部自查需要 1 AP。' };
  if (st.cash < 80) return { ok: false, msg: '现金不足:内部自查需要 ¥80 万。' };
  st.ap -= 1; st.cash -= 80; m.probed = true; m.discovered = true;
  st.roundOps.probe = (st.roundOps.probe || 0) + 1;
  const M = MINES[m.key];
  return { ok: true, msg: '🔍 自查完成——查出一颗雷:「' + m.name + '」。' + M.clue + ' 自爆代价远小于被挖,去资料卡「处理暗雷」抉择。' };
}

/* 对手塌房(公信力归零):禁言 + 全场情绪反转;cause 用于文案。
 * 悬置中的对线卡一并清算:对手塌房 = 不战而胜(否则卡片永远停在"进行中",回击按钮死锁) */
function bustRival(st, cause) {
  const rv = st.rival;
  if (!rv || rv.done) return;
  const D = RIVAL_DEFS[rv.key];
  rv.done = true; rv.cred = 0;
  if (rv.duelCard && rv.duelCard.duelState === 'open') {
    const c = rv.duelCard;
    c.duelState = 'won';
    c.likesMine = Math.round((c.likesRival || 0) * 1.5);
    c.verdict = '对手被禁言,这场对线不战而胜——评论区在狂欢。';
  }
  rv.duelCard = null;
  rv.lastAct = '塌房离场(禁言)';
  st.feed.push({ type: 'news', tag: '社区', title: '「' + rv.name + '」被平台禁言',
    text: pick(T.rivalBust) + (cause === 'mine' ? '实锤证据直指「' + D.rivalMine + '」。' : ''),
    likes: randInt(1500, 6000), round: st.round, tagCls: 't-up' });
  allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 12, -100, 100); n.confidence = clamp(n.confidence + 6, 0, 100); });
  st.heat = clamp(st.heat + 12, 0, 100);
  st.reg = Math.max(0, st.reg - 6);
}

/* 回击(对线):0 元 1AP,每回合 1 次,只有悬置对线在场时可用 */
function counterAttack(st) {
  const rv = st.rival;
  if (!rv || rv.done) return { ok: false, msg: '对手已经离场。' };
  if (!rv.duelCard || rv.duelCard.duelState !== 'open') return { ok: false, msg: '现在没有悬而未决的对线。' };
  if (st.ap < 1) return { ok: false, msg: '行动点不足:回击需要 1 AP。' };
  if (rv.counterRound === st.round) return { ok: false, msg: '本回合已经回击过一次。' };
  st.ap -= 1; rv.counterRound = st.round;
  st.roundOps.counter = (st.roundOps.counter || 0) + 1;
  const D = RIVAL_DEFS[rv.key];
  const followees = st.retails.filter(n => n.isFollowee && !n.poisoned).length;
  let p = 0.50 + Math.min(0.12, followees * 0.02) + avgValence(st) / 1000 + (rv.allyRounds > 0 ? 0.10 : 0);
  if (D.prefArch.includes(ctrait().arch)) p -= 0.08;   // 它研究过你的赛道:更懂你的软肋
  const win = Math.random() < p;
  const c = rv.duelCard; rv.duelCard = null;
  if (win) {
    rv.cred = clamp(rv.cred - 14, 0, 100); rv.losses = 0;
    rv.hostility = clamp(rv.hostility + 8, 0, 100);   // 记仇:赢它一次,它咬得更紧
    allNPCs(st).forEach(n => n.valence = clamp(n.valence + 3, -100, 100));
    st.heat = clamp(st.heat + 5, 0, 100);
    c.duelState = 'won';
    c.likesMine = Math.round(c.likesRival * rand(1.2, 1.8));
    c.verdict = pick(T.duelWin);
    if (rv.cred <= 0) { bustRival(st, 'counter'); return { ok: true, win: true, msg: '⚔ 回击成功且一锤定音:「' + rv.name + '」公信力归零,塌房禁言!' }; }
    return { ok: true, win: true, msg: '⚔ 回击成功:「' + rv.name + '」公信力 -14(现 ' + Math.round(rv.cred) + '),节奏回到你手里。' };
  }
  rv.cred = clamp(rv.cred + 6, 0, 100); rv.losses++;
  allNPCs(st).forEach(n => n.valence = clamp(n.valence - 2, -100, 100));
  c.duelState = 'lost';
  c.verdict = pick(T.duelLose);
  let extra = '';
  if (rv.losses >= 2) { rv.losses = 0; st.limitNext = true; extra = ' 连败两场被嘲上热搜:下回合你被限流(发帖系效果 ×0.5)。'; }
  return { ok: true, win: false, msg: '⚔ 回击被驳回:「' + rv.name + '」公信力 +6(现 ' + Math.round(rv.cred) + ')。' + extra };
}

/* 扒对手(每局 2 次):55% 命中黑料;命中时 40% 挖到对手自己的雷 → 塌房一击 */
function digRival(st) {
  const rv = st.rival;
  if (!rv || rv.done) return { ok: false, msg: '对手已经离场。' };
  if (rv.digsUsed >= 2) return { ok: false, msg: '本局「扒对手」已用完(每局 2 次)。' };
  if (st.ap < 1) return { ok: false, msg: '行动点不足:扒对手需要 1 AP。' };
  if (st.cash < 100) return { ok: false, msg: '现金不足:扒对手需要 ¥100 万。' };
  st.ap -= 1; st.cash -= 100; rv.digsUsed++;
  st.roundOps.dig = (st.roundOps.dig || 0) + 1;
  if (Math.random() >= 0.55) {
    rv.cred = clamp(rv.cred + 8, 0, 100); st.reg += 2;
    return { ok: true, msg: '扒了一圈,只等来一纸律师函:「' + rv.name + '」公信力 +8,你反被记一次恶意扒皮(监管 +2)。' };
  }
  if (!rv.mineBlown && Math.random() < 0.4) {
    rv.mineBlown = true;
    rv.cred = clamp(rv.cred - 45, 0, 100);
    st.feed.push({ type: 'news', tag: '社区', title: '你扒出了对手的底', text: '你放出的实锤直指「' + rv.name + '」的命门:' + RIVAL_DEFS[rv.key].rivalMine + '。评论区风向瞬间掉头。', likes: randInt(1000, 4000), round: st.round, tagCls: 't-up' });
    if (rv.cred <= 0) { bustRival(st, 'mine'); return { ok: true, msg: '💣 一击致命!「' + rv.name + '」因「' + RIVAL_DEFS[rv.key].rivalMine + '」被实锤,直接塌房禁言!全场情绪 +12,监管 -6。' }; }
    return { ok: true, msg: '扒到了硬料:「' + rv.name + '」公信力 -45(现 ' + Math.round(rv.cred) + ')。再来一下就能送它塌房。' };
  }
  rv.cred = clamp(rv.cred - 18, 0, 100);
  if (rv.cred <= 0) { bustRival(st, 'dig'); return { ok: true, msg: '扒到的黑料压垮了骆驼:「' + rv.name + '」塌房禁言!' }; }
  return { ok: true, msg: '扒到了黑料:「' + rv.name + '」公信力 -18(现 ' + Math.round(rv.cred) + ')。' };
}

/* 联名大V:对手下次攻击效果 ×0.6,回击成功率 +10%,持续 2 回合 */
function allyKols(st) {
  const rv = st.rival;
  if (!rv || rv.done) return { ok: false, msg: '对手已经离场。' };
  if (rv.allyRounds > 0) return { ok: false, msg: '大V联盟还在场(剩 ' + rv.allyRounds + ' 回合)。' };
  if (st.ap < 1) return { ok: false, msg: '行动点不足:联名大V需要 1 AP。' };
  if (st.cash < 150) return { ok: false, msg: '现金不足:联名大V需要 ¥150 万。' };
  st.ap -= 1; st.cash -= 150; rv.allyRounds = 2;
  st.roundOps.ally = (st.roundOps.ally || 0) + 1;
  st.feed.push({ type: 'news', tag: '社区', title: '大V联名发声', text: '多位财经大V联合发布《关于理性看待' + STOCK.name + '近期争议的倡议》,评论区出现了一批有分量的声援。', likes: randInt(400, 1800), round: st.round, tagCls: 't-up' });
  return { ok: true, msg: '🤝 大V联盟入场(2 回合):对手攻击效果 ×0.6,回击成功率 +10%。' };
}

/* 举报对手(免费,与居民举报共享每回合 1 次;对线卡上操作) */
function reportRival(st) {
  const rv = st.rival;
  if (!rv || rv.done) return { ok: false, msg: '对手已经离场。' };
  if (rv.reportRound === st.round) return { ok: false, msg: '本回合已举报过(与居民举报共享限次)。' };
  rv.reportRound = st.round;
  if (Math.random() < 0.40 + (85 - rv.cred) / 400) {
    rv.cred = clamp(rv.cred - 8, 0, 100); rv.quietRounds = 1;
    if (rv.cred <= 0) { bustRival(st, 'report'); return { ok: true, msg: '小管家判定它「有组织操纵舆论」:「' + rv.name + '」塌房禁言!' }; }
    return { ok: true, msg: '小管家判定举报有效:「' + rv.name + '」公信力 -8,下回合噤声。' };
  }
  rv.cred = clamp(rv.cred + 4, 0, 100); st.reg += 2;
  return { ok: true, msg: '举报未通过:「' + rv.name + '」公信力 +4,你反被记了一次恶意举报(监管 +2)。' };
}

/* 对手盘相位:resolveRound 内每回合执行一次(敌意演化 → 悬置对线清算 → 行为选择) */
function rivalPhase(st, r0, mv, pushNews, tips) {
  const rv = st.rival;
  if (!rv || rv.done) return;
  const D = RIVAL_DEFS[rv.key];
  // 敌意演化:你涨得越欢、烧得越旺、对线赢它,它咬得越紧;平静时缓慢降温。
  // 增速 ×1.5(回测校准:×2 时稳健基线好结局被压掉 ~15pp——对手大部分回合都趴在高级别上)
  const last = st.history[st.history.length - 1];
  let dh = -3;
  if (last && last.round === r0) dh += clamp(last.pct, 0, 15) * 1.5;
  if (st.heat >= 75) dh += 4;
  rv.hostility = clamp(rv.hostility + dh * D.grow, 0, 100);
  if (phaseOf(r0) === 2) rv.hostility = Math.max(rv.hostility, 78);   // 决战段:它不会善罢甘休
  if (rv.allyRounds > 0) rv.allyRounds--;
  // 悬置对线清算:上回合的发难没被回击 → 对手的叙事主导评论区
  if (rv.duelCard) {
    const c = rv.duelCard; rv.duelCard = null;
    if (c.duelState === 'open') {
      c.duelState = 'ignored';
      c.likesMine = Math.round(c.likesRival * 0.3);
      c.verdict = pick(T.duelIgnored);
      rv.cred = clamp(rv.cred + 6, 0, 100);
      mv(-2);
      tips.push('⚔ 你没有回击「' + rv.name + '」:它替你定调了(公信力 +6,全场情绪 -2)。');
    }
  }
  if (rv.quietRounds > 0) { rv.quietRounds--; rv.lastAct = '被举报后噤声一回合'; return; }
  if (Math.random() < 0.3) { rv.lastAct = '按兵不动,只挂了观察单'; return; }
  const dmgMul = D.dmg * (0.4 + rv.cred / 100 * 0.8) * (rv.allyRounds > 0 ? 0.6 : 1);
  // 行为选择:自上而下取已解锁的最高档。挖雷(L4)优先于砸盘(L5)——
  // 信息战是灵魂:敌意过线先挖你的雷,资金战留给挖完之后/决战收尾
  if (rv.hostility >= 80 && !rv.digUsed && st.mine && !st.mine.defused && !st.mine.exploded) {
    // L4:挖你的雷(已排雷的局走不到这一支)
    rv.digUsed = true;
    rv.lastAct = '挖出了你公司的暗雷';
    rv.cred = clamp(rv.cred + 15, 0, 100);
    tips.push('⚔ 「' + rv.name + '」挖出了你公司的暗雷!');
    explodeMine(st, 'rival', mv, pushNews, tips);
  } else if (rv.hostility >= 90 && rv.pool >= 1500 && rv.smashUsed < 2) {
    // L5 决战:动用资金池砸盘(护盘托底是它的天敌)
    rv.pool -= 1500; rv.smashUsed++;
    rv.lastAct = '砸盘(动用资金池 ¥1500万)';
    mv(Math.round(-9 * D.dmg));
    allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 8, 0, 100); n.arousal = clamp(n.arousal + 10, 0, 100); });
    st.poolShockRounds = Math.max(st.poolShockRounds, 2);
    pushNews('突发', '空头砸盘', '盘口突现连续大额卖单,明眼人都看得出这不是散户行为——「' + rv.name + '」的仓位摆在了明面上。', 't-dn', randInt(2000, 9000));
    pushNews('龙虎榜', '席位异动', '龙虎榜显示:「' + rv.name + '」关联席位净卖出约 ¥' + randInt(2800, 4200) + ' 万。多空决战开始了。', null, randInt(600, 2400));
    tips.push('⚔ 「' + rv.name + '」动用资金池砸盘(剩 ¥' + rv.pool + ' 万):信心 -8,买盘池受惊 2 回合。「🛡 护盘托底」可以接。');
  } else if (rv.hostility >= 80 && rv.digUsed) {
    // L4 之后的持续施压(雷已排/已爆/挖过)
    rv.lastAct = '组织了一轮负面长评';
    mv(Math.round(-4 * dmgMul)); st.heat = clamp(st.heat + 5, 0, 100);
    st.feed.push({ type: 'comment', author: rv.name, tag: rv.persona, text: pick(T.rivalGloat), likes: randInt(200, 1000), round: r0 });
  } else if (rv.hostility >= 65) {
    // L3:反买热搜 / 举报你 / 策反分身,按回合轮换
    const a3 = ['hot', 'report', 'defect'][r0 % 3];
    if (a3 === 'hot') {
      rv.hotTopic = { until: r0 + 2 }; rv.lastAct = '反买热搜压你';
      st.heat = clamp(st.heat + 4, 0, 100);
      pushNews('热榜', '对手的话题上榜', '「' + rv.name + '」把#' + STOCK.name + '的负面词条顶上了热榜——你买热搜顶掉的位子,它又占了回来。', 't-dn', randInt(500, 2500));
    } else if (a3 === 'report') {
      st.limitNext = true; rv.lastAct = '向小管家举报了你';
      pushNews('社区', '小管家提醒', '你有一条内容因被批量举报进入人工复审,发布功能受到限制(下回合发帖系动作效果 ×0.5)。', null, randInt(200, 900));
      tips.push('⚔ 「' + rv.name + '」组织人手举报了你:下回合被限流(发帖系效果 ×0.5)。');
    } else {
      const followees = st.retails.filter(n => n.isFollowee && !n.poisoned);
      if (followees.length) {
        const f = pick(followees);
        f.poisoned = true; f.valence = clamp(f.valence - 60, -100, 100); f.arousal = clamp(f.arousal + 20, 0, 100);
        rv.lastAct = '策反了 @' + f.name;
        st.feed.push({ type: 'comment', author: f.name, tag: (f.tag || '') + '·被策反', text: pick(T.rivalDefect), likes: randInt(100, 600), round: r0 });
        tips.push('⚔ 你的知友 @' + f.name + ' 被「' + rv.name + '」策反了(「安抚」可以拉回来)。');
      } else {
        mv(Math.round(-3 * dmgMul)); st.heat = clamp(st.heat + 3, 0, 100);
        rv.lastAct = '雇了水军刷负面';
        pushNews('社区', '水军出没', '一批新注册账号整齐划一地转发同一段质疑文案——这手笔,不像自发。', 't-dn', randInt(300, 1200));
      }
    }
  } else if (rv.hostility >= 45 && !rv.duelCard) {
    // L2:对线长文(本地池先行,LLM 二期接入)
    const title = fillStock(pick(T.rivalAtkTitle[rv.key]));
    const card = { type: 'duel', round: r0, author: rv.name, tag: rv.persona + '·对线',
      title, text: fillStock(pick(T.rivalAtkBody[rv.key])),
      myTitle: st.lastPostTitle || ('说说为什么我看好' + STOCK.name),
      likesRival: Math.round((rv.cred * 40 + rv.hostility * 10) * rand(0.9, 1.3)),
      likesMine: Math.round(st.heat * 30 + 400 + rand(0, 300)),
      duelState: 'open', verdict: null };
    st.feed.push(card);
    rv.duelCard = card; rv.lastAct = '发起对线';
    mv(Math.round(-5 * dmgMul));
    allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 4, 0, 100));
    st.heat = clamp(st.heat + 8, 0, 100);
    tips.push('⚔ 「' + rv.name + '」向你发起对线:《' + title.slice(0, 18) + '…》——去 feed 里「回击」!');
  } else if (rv.hostility >= 25) {
    // L1:评论区阴阳怪气
    rv.lastAct = '在评论区阴阳怪气';
    mv(Math.round(-2 * dmgMul)); st.heat = clamp(st.heat + 2, 0, 100);
    st.feed.push({ type: 'comment', author: rv.name, tag: rv.persona, text: pick(T.rivalJab), likes: randInt(50, 400), round: r0 });
  } else {
    rv.lastAct = '观望中';
  }
}

/* ---------------- 开局 ---------------- */
/* 肉鸽天赋池(开局三选一) */
const TRAITS = [
  { id: 'whale',    name: '大户室常客', desc: '家里有矿:初始现金 +8000 万' },
  { id: 'insider',  name: '消息灵通',   desc: '写手稿被识破概率减半;问询函阈值提高 5 点' },
  { id: 'hype',     name: '流量操盘手', desc: '所有舆论动作对情绪的影响 +30%' },
  { id: 'darkpool', name: '暗盘老手',   desc: '大宗交易折价减半,走漏风声概率 -10%' },
  { id: 'buyback',  name: '产业资本',   desc: '基本盘有人护:买盘池基础 +6%' },
  { id: 'calm',     name: '心脏很大',   desc: '问询阈值 40 / 停牌阈值 65(常人 35 / 60)' },
  { id: 'energy',   name: '精力充沛',   desc: '每回合行动点 +1(2 → 3)' },
];

function newGame(traitId) {
  const st = {
    round: 1,
    trait: traitId || null,
    price: CONFIG.startPrice,
    open: CONFIG.startPrice,
    cash: CONFIG.playerCash0 + (traitId === 'whale' ? 8000 : 0),
    apPerTurn: CONFIG.apPerRound + (traitId === 'energy' ? 1 : 0),
    lots: [{ round: 0, shares: CONFIG.playerShares0 }], // T+1:按买入回合冻结
    sharesBoughtTotal: CONFIG.playerShares0,
    cost: CONFIG.playerCost,
    heat: 18,
    reg: 8,
    board: 0,
    ap: CONFIG.apPerRound + (traitId === 'energy' ? 1 : 0),
    halted: false, haltLeft: 0,
    poolShockRounds: 0,
    kolsBoost: {},           // kolId -> 剩余回合
    quantWarned: false,
    lhbDone: false,
    inquiryDone: false,
    exposureDone: false,
    soldCum: 0,
    realized: 0,
    history: [],
    feed: [],
    manipLog: [],
    sellLog: [],
    usedTactics: {},
    tacticUses: {},          // 免疫机制:手段 -> 已用次数(同一话术连用效果递减)
    doubtNext: 1,            // 质疑声量:1 正常;0.95 = 上回合出现质疑帖,本回合买盘池打折
    doubtCalm: false,        // 本回合安抚过(自答/澄清)→ 下回合不触发质疑
    ended: false, ending: null,
    pendingBuy: null, pendingSell: null, // buy: {amt, mode} · sell: {channel, amt}
    tips: [],
    skills: { wash: true, exit: true },  // 暗盘大招(每局一次)
    washNext: false, exitNext: false, poolBoostNext: 0,
    supportNext: false,   // 护盘托底:下回合结算时若下跌,跌幅减半(资金侧唯一防守动作,可重复不叠加)
    decisions: 0, usedDecisions: [], pendingDecision: null,
    aiEvents: 0,           // 本局已生成的 AI 抉择事件数(上限 2)
    aiEventSkip: false,    // AI 事件失败过一次后本局不再尝试(失败=弹窗空转,重试不划算)
    rumorPending: null,    // 传闻两段式:{left:剩余回合, good:是否坐实}
    pxLog: [],             // 像素居民:每回合点亮一位(当回合买入最多/情绪最极端的居民)
    /* 回合情境层(多样性八件套):天气/波动聚集/黑天鹅/连锁/小管家任务 */
    weather: 'calm',       // 本回合市场天气(WEATHERS key);第 1 回合固定无风
    volMul: 1,             // 波动率聚集乘数:大涨大跌后放大,平静后回落
    foreshadow: null,      // 黑天鹅伏笔:{key, round} —— 下一回合引爆
    swansUsed: [],         // 已登场的黑天鹅 key(每局至多 2 只,不重复)
    swansFired: 0,
    chainNext: null,       // 事件连锁:下一回合事件位被连锁结果占用
    sideTask: null,        // 知乎小管家本回合任务(SIDE_TASKS key)
    roundOps: {},          // 本回合已执行的舆论动作统计(任务判定用)
    soldThisRound: false,  // 本回合是否执行过卖出(耐心资本日判定用)
    /* 对手盘 × 暗雷(信息战扩展包) */
    rival: null,           // 舆论对手(makeRival):敌意/公信力/资金池/悬置对线
    mine: null,            // 公司暗雷(makeMine):三条引线(记者/对手/自查)
    limitNext: false,      // 被对手举报限流:下回合发帖系动作效果 ×0.5
    honestRounds: 0,       // 自爆洗白的「坦诚」buff:负面事件情绪冲击 ×0.85
  };
  st.kols = KOL_DEFS.map(d => ({
    id: d.id, name: d.name, kind: 'kol', style: d.style, tag: d.tag, followers: d.followers,
    valence: d.style === 'bull' ? 30 : d.style === 'fomo' ? 10 : 0,
    arousal: d.style === 'bull' ? 45 : 25,
    confidence: d.style === 'calm' ? 70 : d.style === 'quant' ? 75 : 45,
    cash: rand(300, 900), // 万
    memory: [],
  }));
  st.retails = [];
  let ni = 0;
  for (const [p, n] of RETAIL_MIX) {
    for (let k = 0; k < n; k++) {
      st.retails.push({
        id: 'r' + (ni++), name: RETAIL_NAMES[(ni - 1) % RETAIL_NAMES.length], kind: 'retail',
        persona: p, tag: PERSONA_META[p].tag,
        valence: rand(-10, 25), arousal: rand(10, 40), confidence: rand(30, 60),
        cash: rand(4, 45), shares: rand(1, 5),
        memory: [],
      });
    }
  }
  // 知乎登录玩家:注入"以你为原型"的韭菜 NPC(登录流程由 js/zhihu.js 完成)
  if (typeof window !== 'undefined' && window.ZR_PERSONA) {
    const p = window.ZR_PERSONA;
    st.retails.push({
      id: 'persona', name: p.name, kind: 'retail', persona: p.persona,
      tag: p.tag || '知乎原型·你',
      valence: rand(0, 20), arousal: rand(20, 40), confidence: rand(35, 55),
      cash: rand(8, 30), shares: rand(1, 4), memory: [], isPersona: true,
    });
  }
  // 知乎关注的知友:每位生成一个 AI 分身 NPC,和其他居民一样读帖、被带节奏、下单
  if (typeof window !== 'undefined' && Array.isArray(window.ZR_FOLLOWEES)) {
    window.ZR_FOLLOWEES.forEach((f, i) => {
      const seed = strHash(f.name || 'f' + i);
      const big = (f.followers || 0) >= 100000;  // 大粉:见多识广,更难被带节奏
      const tiny = (f.followers || 0) > 0 && (f.followers || 0) <= 1000;  // 小粉:容易上头
      st.retails.push({
        id: 'persona-f' + i, name: f.name, kind: 'retail', persona: f.persona || 'herd',
        tag: f.tag || '知乎关注·@' + f.name,
        valence: seed % 41 - 15,  // -15~25,按名字稳定
        arousal: clamp((seed >> 3) % 31 + (tiny ? 12 : 0), 5, 60),
        confidence: clamp((seed >> 6) % 26 + 30 + (big ? 15 : 0), 0, 100),
        cash: rand(4, 45), shares: rand(1, 5),
        memory: [], isFollowee: true,
      });
    });
  }
  // 公司基因:叙事基因已改为全局限型(见 applyOpinion/resolveRound),开局只保留
  // 特殊叙事的初始热度/置信偏差;共振基因的"每局一次"资源在此初始化。
  const td0 = toneDefOf(ctrait());
  if (td0 && td0.conf0) allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence + td0.conf0, 0, 100); });
  if (td0 && td0.heat0) st.heat = Math.max(0, st.heat + td0.heat0);
  st.clarifyFree = hasCombo('guoming');   // 国民品牌:每局一次免费澄清
  st.comboLunwenUsed = false;
  st.comboBaitouTipped = false;
  st.comboFensiTipped = false;
  st.cashCowTipped = false;
  // 对手盘 × 暗雷:开局即生成(明示数值;对手发酵期才升级行为,暗雷引线在热度起来后才可能被点)
  st.rival = makeRival();
  st.mine = makeMine();
  st.feed.push({ type: 'news', tag: '社区', title: '对手盘入场:「' + st.rival.name + '」',
    text: '一位' + st.rival.persona + '把' + STOCK.name + '加进了自选——它在龙虎榜挂了对倒单,像是在掂量你这口池子的深浅。敌意 ' + st.rival.hostility + '/100,公信力 ' + st.rival.cred + '/100,资金池 ¥' + st.rival.pool + ' 万。',
    likes: randInt(200, 900), round: 1 });
  st.feed.push({ type: 'comment', author: pick(st.retails).name, tag: '路人', text: '听说每家公司都藏着一颗雷——「内部自查」能提前排掉,排不掉就看谁先挖到了。', likes: randInt(2, 40), round: 1 });
  // 回合 1 的小管家任务:开局即有一条可选目标(完成判定在结算)
  const t1 = assignTask(st);
  st.feed.push({ type: 'news', tag: '小管家', title: '本回合任务:「' + t1.name + '」', text: t1.hint + '。完成奖励:' + t1.reward + '。', likes: randInt(30, 200), round: 1 });
  st.tips.push('📌 小管家任务「' + t1.name + '」:' + t1.hint);
  return st;
}
function allNPCs(st) { return st.kols.concat(st.retails); }
function sellableShares(st) {
  const total = st.lots.reduce((t, l) => t + l.shares, 0);
  // T+1:本回合买入的下一回合才能卖 → 冻结 round === 当前回合的 lot
  const frozen = st.lots.filter(l => l.round === st.round).reduce((t, l) => t + l.shares, 0);
  return total - frozen;
}
function totalShares(st) { return st.lots.reduce((t, l) => t + l.shares, 0); }
function avgValence(st) { const a = allNPCs(st); return a.reduce((t, n) => t + n.valence, 0) / a.length; }

/* ---------------- 买盘池(游戏发动机) ---------------- */
function heatMul(st) { const a = ARCHETYPES[ctrait().arch]; return (a && a.heatMul) || 1; }
function regMul(st) { const a = ARCHETYPES[ctrait().arch]; return (a && a.regMul) || 1; }
function negMul(st) { const a = ARCHETYPES[ctrait().arch]; return (a && a.negMul) || 1; }  // 民生消费:负面情绪传染更快
function computePool(st) {
  const heatF = 1 + Math.min(st.heat, 100) / 100 * 2.2;
  // 情绪敏感度(社区反馈强化):斜率 1.05 → 2.15,锚点不变(avg=0 时仍为 1.075)
  // → 平均情绪 0→30 时买盘池比旧版深约 30%;恐慌 -30 时池子只剩基准 70%
  const sentF = (avgValence(st) + 100) / 200 * 2.15;
  const priceF = clamp(1.18 - (st.price / CONFIG.startPrice - 1) * 0.55, 0.45, 1.18);
  const shock = st.poolShockRounds > 0 ? 0.85 : 1;
  const buyback = st.trait === 'buyback' ? 1.06 : 1;
  const gene = ARCHETYPES[ctrait().arch].poolBonus || 1;   // 重资产制造:基本盘扎实
  const wash = st.washNext || 1;                // 对倒放量:本回合买盘池虚增系数(1.35,流量赌场 1.5)
  const boost = st.poolBoostNext || 1;          // 抉择事件/宏观事件带来的下一回合买盘增益
  const doubt = st.doubtNext || 1;              // 质疑声量:社区反抗时买盘池打折
  const toneP = (toneDefOf(ctrait()) || {}).poolMulTone || 1;   // 饥饿营销:越买不到越想要 +8%
  const comboP = (hasCombo('duanhuo') ? 1.10 : 1) * (hasCombo('sili') ? 1.10 : 1);   // 刻意断货 / 私域口碑
  const weatherP = wdef(st).poolBoost || 1;   // 市场天气:追涨日买盘池 +10%
  const pool = CONFIG.basePool * gene * heatF * sentF * priceF * shock * buyback * wash * boost * doubt * toneP * comboP * weatherP;
  return { pool, heatF, sentF, priceF, shock };
}

/* ---------------- 舆论行动 ---------------- */
function applyOpinion(st, key, kolId, angle) {
  const act = OPINION_ACTIONS[key];
  // 国民品牌共振:每局第一次「澄清」免 AP 且免费(在扣费守卫之前判定)
  const freeOnce = key === 'clarify' && st.clarifyFree;
  if (freeOnce) st.clarifyFree = false;
  // 免费动作(发帖/自答)不受负现金锁死:它们是玩家仅剩的自救声量(与 ui.js renderActions 一致)
  if (st.ap < (freeOnce ? 0 : act.ap) || (act.cost > 0 && !freeOnce && st.cash < act.cost)) return { ok: false };
  if (!freeOnce) { st.ap -= act.ap; st.cash -= act.cost; }
  st.usedTactics[key] = true;
  st.roundOps[key] = (st.roundOps[key] || 0) + 1;   // 小管家任务:本回合动作统计
  // 免疫机制:同一话术连用,情绪/热度效果递减(每次 -15%,下限 ×0.55;澄清是降温动作不递减)
  // 对手举报限流(limitNext):发帖系动作效果 ×0.5(澄清/自答是防御与安抚,不受限)
  const imm = tacticImm(st, key) * (st.limitNext && key !== 'clarify' && key !== 'astroturf' ? 0.5 : 1);
  if (key !== 'clarify') st.tacticUses[key] = (st.tacticUses[key] || 0) + 1;
  // 只夹下限:监管溢出 100 的部分要保留(结算顺序是先衰减再判 ≥100,夹上限会破坏入狱机制)
  // 公司基因:赛道决定舆论的监管代价(硬科技 +25%,只放大正向代价,不放大澄清的减免)
  // 叙事基因:资本故事的「风声收得慢」在 resolveRound 的监管冷却里体现
  // 市场天气:严打周监管代价 ×1.5
  st.reg = Math.max(0, st.reg + (act.reg > 0 ? act.reg * regMul(st) * (wdef(st).regAmp || 1) : act.reg));
  const HY = st.trait === 'hype' ? 1.3 : 1;   // 流量操盘手:情绪影响 +30%
  const AM = ARCHETYPES[ctrait().arch].arousalMul || 1;   // 泛娱乐:唤醒效果 +40%
  const HM = heatMul(st);                     // 赛道基因:热度获取(硬科技 +30% / 重资产 -20%)
  const td = toneDefOf(ctrait()) || {};
  const TM = td.heatMulTone || 1;             // 叙事基因:资本故事 +15% / 过度包装 +10%
  const WQ = wdef(st).heatAmp || 1;           // 市场天气:吃瓜日热度获取 +25%
  const affected = [];
  const record = (npc, dv) => affected.push({ name: npc.name, tag: npc.tag, dv: Math.round(dv) });
  let label = act.name, headline = '';
  const applyAll = (dv, ar) => allNPCs(st).forEach(n => { n.valence = clamp(n.valence + dv * HY, -100, 100); n.arousal = clamp(n.arousal + (ar || 0) * AM, 0, 100); });

  if (key === 'post') {
    // 发帖三角度:缺省 hype 与历史数值完全一致(headless 三策略基线不变)
    const ang = POST_ANGLES[angle] || POST_ANGLES.hype;
    st.lastPostTitle = ang.title();   // 对线卡「我方回答」引用玩家最近一次发帖标题
    applyAll(rand(ang.dv[0], ang.dv[1]) * imm, ang.arousal * imm);
    if (ang.conf) allNPCs(st).forEach(n => n.confidence = clamp(n.confidence + ang.conf * imm, 0, 100));
    st.heat += ang.heat * imm * HM * TM * WQ;
    headline = '你亲自发帖《' + ang.title() + '》,评论区吵起来了。';
    allNPCs(st).forEach(n => { if (Math.random() < 0.4) record(n, 5); });
    const sp = pick(T.sockpost);
    st.feed.push({
      type: 'writer', author: pick(SOCK_PUPPETS), tag: '营销号',
      title: fillStock(sp.title),
      text: fillStock(sp.text),
      likes: randInt(60, 800), round: st.round, llm: 'post'
    });
  } else if (key === 'hot') {
    applyAll(rand(2, 5) * imm, 12 * imm); st.heat += 22 * imm * HM * TM * WQ * (ARCHETYPES[ctrait().arch].hotMul || 1) * (hasCombo('wanghong') ? 1.3 : 1);
    headline = '话题#' + STOCK.name + '亏钱还是吃肉#冲上热榜第' + randInt(3, 15) + '位。';
    allNPCs(st).forEach(n => { if (Math.random() < 0.5) record(n, 3); });
    st.feed.push({
      type: 'news', tag: '热榜', title: '#' + STOCK.name + ' 相关词条上榜',
      text: pick(T.hotwords)
        .replace(/\{stock\}/g, STOCK.name).replace(/\{x\}/g, String(randInt(300, 9000) / 10))
        .replace(/\{i\}/g, String(randInt(2, 18))).replace(/\{h\}/g, String(randInt(3, 12))),
      likes: randInt(500, 4000), round: st.round
    });
  } else if (key === 'writer') {
    const extArr = (typeof window !== 'undefined' && window.ZR_WRITER && window.ZR_WRITER.length) ? window.ZR_WRITER : null;
    const base = pick(T.writer);
    const ext = extArr ? pick(extArr) : null;   // 知乎故事语料:提供"风格参照"与作者归属
    const w = ext ? { title: base.title, body: base.body, attr: ext.attr, styleTag: (ext.labels && ext.labels[0]) || '故事体' } : base;
    const WM = (td.writerMul || 1) * (hasCombo('shenyao') ? 1.25 : 1) * (hasCombo('fenquan') ? 1.2 : 1);   // 技术立司+10% / 神药神话+25% / 粉圈经济+20%
    allNPCs(st).forEach(n => {
      const dv = (PERSONA_META[n.persona] && PERSONA_META[n.persona].suggestible ? rand(9, 14) : (n.kind === 'kol' ? rand(0, 4) : rand(2, 6))) * HY * imm * WM;
      n.valence = clamp(n.valence + dv, -100, 100); n.arousal = clamp(n.arousal + 6 * imm * AM, 0, 100);
      record(n, dv);
    });
    st.heat += 12 * imm * HM * TM * WQ;
    const wLikes = randInt(200, 3000);   // 点赞过千 → 尾部挂「盐选收录」虚拟徽记(纯文案,知乎味)
    st.feed.push({ type: 'writer', author: '匿名用户', tag: '深度·软文' + (w.styleTag ? '·' + w.styleTag : ''), title: fillStock(w.title), text: fillStock(w.body) + (wLikes >= 1200 ? ' —— 本回答已被收录进盐选专栏(虚构)。' : ''), attr: w.attr || '', likes: wLikes, round: st.round, llm: 'writer' });
    headline = '《' + fillStock(w.title) + '》发布,社区开始转发。';
    if (ctrait().arch === 'biotech') headline += ' ❖ 生物医药基因:写手稿更难被识破。';
    if (Math.random() < (st.trait === 'insider' ? 0.125 : 0.25) * (ctrait().arch === 'biotech' ? 0.4 : 1)) { // 被举报(消息灵通:概率减半;生物医药:故事可信 25%→10%;举报是事件结果,不叠严打周的动作代价放大)
      st.reg += 16; st.heat += 5;
      if (hasCombo('shenyao')) { st.reg += 10; headline += ' ❖ 神药神话:神话破灭,监管额外 +10。'; }
      allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 8, 0, 100));
      st.feed.push({ type: 'news', tag: '辟谣', title: '账号质疑', text: '有用户扒出软文作者账号为 3 天新注册,发布时间与股价异动高度同步。部分读者表示"先不信了"。', likes: randInt(50, 400), round: st.round });
      headline += ' ⚠ 被用户识破举报,' + STOCK.regulator + '已关注。';
    }
  } else if (key === 'kol') {
    const kol = st.kols.find(k => k.id === kolId) || pick(st.kols);
    st.kolsBoost[kol.id] = 2;
    kol.valence = clamp(Math.max(kol.valence, 80), -100, 100);
    const KM = hasCombo('wanghong') ? 1.25 : 1;   // 网红经济:大V恰饭感染更强
    allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 8 * HY * imm * KM, -100, 100); record(n, 8 * HY * imm * KM); });
    headline = '你向' + kol.name + '的"商务合作"账户转了一笔钱,TA 连发两回合看多内容。';
    st.feed.push({
      type: 'kolpost', kol: kol.id, title: '坚定看好' + STOCK.name + '的三个理由',
      text: fillStock(pick(T.kol[kol.style].boost)),
      likes: randInt(1000, 9000), round: st.round, llm: 'kol'
    });
  } else if (key === 'astroturf') {
    allNPCs(st).forEach(n => {
      const meta = PERSONA_META[n.persona];
      if (meta && (n.persona === 'student' || n.persona === 'herd')) { n.confidence = clamp(n.confidence + 8 * imm, 0, 100); n.valence = clamp(n.valence + 4 * HY * imm, -100, 100); record(n, 4 * HY * imm); }
    });
    st.doubtCalm = true;   // 安抚质疑声量:下回合不触发质疑折扣
    headline = '「' + fillStock(pick(T.astroturfQ)) + '」下面多了一条高赞回答,新韭菜们被安抚了。';
    st.feed.push({ type: 'q', title: fillStock(pick(T.astroturfQ)), likes: randInt(8, 60), round: st.round });
    st.feed.push({
      type: 'a', author: pick(['长期主义学习中', '定投第十年', '慢慢变富研究所']), tag: '新韭菜',
      text: pick(T.astroturfA), likes: randInt(120, 900), round: st.round
    });
  } else if (key === 'clarify') {
    const bonus = (ARCHETYPES[ctrait().arch].clarifyBonus || 0) + (hasCombo('junmin') ? 5 : 0);   // 军民鱼水:公信力 +5
    const cAmp = wdef(st).clarifyAmp || 1;   // 避险日:澄清降温 ×1.5
    st.heat = Math.max(0, st.heat - Math.round((15 + bonus) * cAmp));  // 民生消费:澄清降温 +10(口碑型公司更有公信力)
    allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal - 8, 0, 100); n.valence = clamp(n.valence - 2 * HY, -100, 100); record(n, -2 * HY); });
    headline = '你发布公告并召开投资者说明会:「一切信息以公告为准」。监管关注度 -10,热度 -' + Math.round((15 + bonus) * cAmp) + ',市场热度降下来了。';
    if (bonus) headline += ' ❖ 民生基因:澄清额外降温 ' + bonus + '。';
    if (cAmp > 1) headline += ' ❖ 避险日:澄清降温 ×1.5。';
    if (freeOnce) headline = '❖ 国民品牌:本次澄清免 AP、免费。' + headline;
    st.doubtCalm = true;   // 澄清同样压制质疑声量
    st.feed.push({ type: 'news', tag: '公告', title: STOCK.name + '发布澄清公告', text: '公司表示经营正常,不存在应披露未披露事项,并将择期召开投资者交流会。部分机构称"关注后续量能"。', likes: randInt(80, 500), round: st.round });
  }
  if (imm < 1) headline += ' ⚠ 社区对「' + act.name + '」已脱敏:效果 ×' + imm.toFixed(2) + '(换一招可恢复)。';
  st.manipLog.push({ round: st.round, type: key, label, headline, cost: act.cost, affected });
  return { ok: true, headline };
}

/* ---------------- 资金行动 ---------------- */
function stageBuy(st, amt, modeId) { // 万股
  const mode = BUY_MODES[modeId] || BUY_MODES.pump;
  let cap = mode.max;
  if (modeId === 'quiet' && hasCombo('nengyuan')) cap = 500;   // 工匠门槛:产业底盘,吸筹上限 500
  amt = Math.max(0, Math.min(amt, cap, Math.floor(st.cash / st.price)));
  st.pendingBuy = { amt, mode: mode.id };
  return amt;
}
function stageSell(st, channel, amt) {
  const s = sellableShares(st);
  st.pendingSell = { channel, amt: Math.min(amt, s) };
  return st.pendingSell.amt;
}

/* ---------------- 定向微操:安抚 / 情报(右下角像素居民的动作) ----------------
 * 量级刻意做小:只影响单个居民,不改监管/热度,不破坏"情绪生态是主引擎"的格局。 */
function pacifyResident(st, id) {
  if (st.ended) return { ok: false, msg: '本局已结束。' };
  if (st.ap < 1) return { ok: false, msg: '行动点不足:安抚需要 1 点舆论行动点。' };
  if (st.cash < 50) return { ok: false, msg: '现金不足:私下安抚需要 ¥50 万。' };
  const n = st.retails.find(x => x.id === id);
  if (!n) return { ok: false, msg: '找不到这位居民。' };
  st.ap -= 1; st.cash -= 50;
  n.valence = clamp(n.valence - 12, -100, 100);
  n.arousal = clamp(n.arousal - 8, 0, 100);
  return { ok: true, msg: '私下游说完成:' + n.name + ' 情绪 -12、唤醒 -8。狂热降温了,但 TA 下回合的买盘也更浅了一分。' };
}
function intelResident(st, id) {
  if (st.ended) return { ok: false, msg: '本局已结束。' };
  if (st.cash < 20) return { ok: false, msg: '现金不足:买情报需要 ¥20 万。' };
  const n = st.retails.find(x => x.id === id);
  if (!n) return { ok: false, msg: '找不到这位居民。' };
  st.cash -= 20;
  const eag = Math.max(0, n.valence) / 100 * (0.4 + n.arousal / 150) * (0.5 + n.confidence / 200);
  const estBuy = Math.round(n.cash * 0.35 * eag / st.price * 10) / 10;
  return { ok: true, msg: '情报到手(未计大V恰饭加成)。', intel: { v: Math.round(n.valence), a: Math.round(n.arousal), c: Math.round(n.confidence), estBuy, cash: Math.round(n.cash) } };
}

/* ---------------- 居民自主剧情(生态的心跳) ----------------
 * 晒单(全场眼红)/ 互撕(唤醒拉满)/ 大V删帖(信心信号)。闲聊位 45% + 每回合独立 6% 两个触发点。 */
function residentStory(st, r0) {
  const roll = pick(['sun', 'feud', 'del']);
  if (roll === 'sun') {
    const winners = st.retails.filter(n => n.valence > 15);
    const who = pick(winners.length ? winners : st.retails);
    // 高赞晒单:点赞过 1200 会被热搜榜当「小作文」抓上榜(玩家能看见的生态心跳)
    st.feed.push({ type: 'a', author: who.name, tag: who.tag + '·晒单', text: fillStock(pick(T.scenario.sun)), likes: randInt(300, 3600), round: r0 });
    allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 3, -100, 100); n.arousal = clamp(n.arousal + 2, 0, 100); });
    st.heat = clamp(st.heat + 2, 0, 100);
  } else if (roll === 'feud') {
    const a2 = pick(st.retails);
    const b2 = pick(st.retails.filter(n => n.id !== a2.id));
    if (b2) {
      st.feed.push({ type: 'comment', author: a2.name, tag: a2.tag, text: pick(T.rebuttal).replace(/\{name\}/g, '@' + b2.name), likes: randInt(30, 600), round: r0, parentTag: '对线' });
      allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 4, 0, 100); n.confidence = clamp(n.confidence - 2, 0, 100); });
      st.heat = clamp(st.heat + 3, 0, 100);
    }
  } else {
    const k3 = pick(st.kols);
    st.feed.push({ type: 'kolpost', kol: k3.id, title: '删帖说明', text: fillStock(pick(T.scenario.del)), likes: randInt(200, 3000), round: r0 });
    allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 4, 0, 100); n.valence = clamp(n.valence - 3, -100, 100); });
  }
}

/* ---------------- 回合结算 ---------------- */
function resolveRound(st) {
  const r0 = st.round;
  const td = toneDefOf(ctrait()) || {};   // 叙事基因:全局限型(事件放大/质疑减半/冷却速度)
  const geneTips = [];                    // 基因溯源提示:并入本轮结算 toast
  const rivalTips = [];                   // 对手盘/暗雷提示:并入本轮结算 toast
  const { pool: poolBase } = computePool(st);
  // 散户流动性贡献(个人买入量记在 n._lastBuy 上,供"满仓叙事"帖与传导图使用)
  let retailBuy = 0, panicSell = 0;
  const hasBoostKol = Object.keys(st.kolsBoost).length > 0;   // 有被充值的大V在场
  allNPCs(st).forEach(n => {
    if (n.kind === 'kol') return;
    const eag = Math.max(0, n.valence) / 100 * (0.4 + n.arousal / 150) * (0.5 + n.confidence / 200);
    // 恰饭效应:被充值的大V连发看多时,最易感人群(从众/梭哈/打板)买入意愿 ×1.5
    const fanBoost = hasBoostKol && ['suoha', 'boarder', 'herd'].includes(n.persona) ? 1.5 : 1;
    const buy = n.cash * 0.35 * eag / st.price * fanBoost;
    n._lastBuy = buy;
    retailBuy += buy;
    if (n.valence < -35 && n.arousal > 55) {
      let amt = n.shares * (0.2 + n.arousal / 250);
      if (td.panicSoft) amt *= td.panicSoft;   // 情怀叙事:粉丝不离场
      if (hasCombo('fensi')) {
        amt *= 0.5;   // 全民偶像:粉丝护盘
        if (!st.comboFensiTipped) { st.comboFensiTipped = true; geneTips.push('❖ 全民偶像:粉丝护盘,恐慌抛压减半。'); }
      }
      n.shares -= amt; panicSell += amt;
    }
  });
  const effPool = Math.max(120, poolBase + retailBuy);
  const sellPressure = Math.max(0, -retailBuy) + panicSell * 0.15;

  // 像素居民:本回合被带得最狠的一位(个人买入最多;无人买入则情绪最极端),回合条上点亮
  // 上一回合刚点亮过的人不再连选(否则极端居民每回合都是他,像素列全是同一张脸)
  {
    const prev = st.pxLog.length ? st.pxLog[st.pxLog.length - 1].id : null;
    const cands = st.retails.filter(n => n.id !== prev);
    const pool = cands.length ? cands : st.retails;
    const byBuy = pool.slice().sort((a, b) => (b._lastBuy || 0) - (a._lastBuy || 0))[0];
    const who = (byBuy && (byBuy._lastBuy || 0) > 0.001)
      ? byBuy
      : pool.slice().sort((a, b) => Math.abs(b.valence) - Math.abs(a.valence))[0];
    if (who) st.pxLog.push({ r: r0, id: who.id, name: who.name, persona: who.persona, tag: who.tag, v: Math.round(who.valence) });
  }

  // 玩家买入(停牌期间挂单保留,复牌后自动执行)
  let buyImpact = 0, bought = 0;
  if (st.pendingBuy && st.pendingBuy.amt > 0 && !st.halted) {
    const mode = BUY_MODES[st.pendingBuy.mode] || BUY_MODES.pump;
    bought = Math.min(st.pendingBuy.amt, Math.floor(st.cash / st.price));
    if (bought > 0) {
      buyImpact = bought / (effPool + 400) * 2.4 * mode.impactMul;
      const pay = bought * st.price * (1 + buyImpact * 0.5);
      st.cash -= pay;
      st.cost = (st.cost * totalShares(st) + st.price * (1 + buyImpact * 0.5) * bought) / (totalShares(st) + bought);
      st.lots.push({ round: r0, shares: bought });
      st.sharesBoughtTotal += bought;
      if (mode.regRule === 'big150') {
        if (bought > 150 && !hasCombo('baishoutao')) st.reg += 5;
        if (bought > 150 && hasCombo('baishoutao') && !st.comboBaitouTipped) { st.comboBaitouTipped = true; geneTips.push('❖ 白手套:产业资金名正言顺,大额买入未引监管注意。'); }
      }
      else if (mode.regRule === 'flat') st.reg += mode.reg;
      if (mode.heat) st.heat += mode.heat;
    }
    st.pendingBuy = null;
  }
  // 玩家卖出(停牌期间挂单保留)
  let proceeds = 0, sold = 0, fillPrice = 0, usedCh = null;
  if (st.pendingSell && st.pendingSell.amt > 0 && !st.halted) {
    const ch = CHANNELS[st.pendingSell.channel];
    usedCh = ch;
    const dk = st.trait === 'darkpool';
    const amt = Math.min(st.pendingSell.amt, sellableShares(st));
    sold = amt;
    const impact = (amt + sellPressure) / (effPool + 350) * ch.impact * 1.2 * (st.exitNext ? 0.5 : 1);
    const disc = ch.discount * (dk ? 0.5 : 1) * (st.exitNext ? 0.5 : 1);
    fillPrice = st.price * (1 - impact / 2) * (1 - disc);
    proceeds = amt * fillPrice;
    st.cash += proceeds; st.realized += proceeds;
    // 扣持仓(FIFO 扣早期 lot)
    let left = amt;
    for (const lot of st.lots) {
      if (lot.round === r0) continue;
      const take = Math.min(lot.shares, left); lot.shares -= take; left -= take;
      if (left <= 0) break;
    }
    st.lots = st.lots.filter(l => l.shares > 0.0001);
    st.soldCum += amt;
    st.soldThisRound = true;
    st.reg += wReg(st, ch.reg * (st.exitNext ? 0.5 : 1));
    const leakP = Math.max(0, ch.leak - (dk ? 0.10 : 0)) * (st.exitNext ? 0.5 : 1) * (hasCombo('junmao') ? 0.5 : 1);   // 军贸故事:保密体系
    if (leakP > 0 && Math.random() < leakP) {
      st.reg += wReg(st, (ch === CHANNELS.block ? 10 : 8) * (st.exitNext ? 0.5 : 1));
      allNPCs(st).forEach(n => n.valence = clamp(n.valence - 6, -100, 100));
      st.feed.push({ type: 'news', tag: '传闻', title: '大宗异动', text: '市场传闻' + STOCK.name + '有股东通过大宗渠道折价出货,接盘方身份成谜。', likes: randInt(80, 600), round: r0 });
    }
    st.sellLog.push({ round: r0, channel: ch.name, amt: sold, fillPrice, proceeds });
    st.pendingSell = null;
  }

  // 价格结算(冲击系数随出货通道:大宗走场外基本不砸价,尾盘偷袭砸价最狠)
  let chg;
  if (st.halted) {
    chg = 0; // 停牌无成交,价格冻结
  } else if (bought === 0 && sold === 0) {
    // 玩家本回合没有任何资金操作:生态自然波动——情绪定方向、热度定振幅、监管压顶,叠加市场噪声
    // 波动率聚集(volMul)+ 天气加成(rotation +25%):大涨大跌之后往往还有风浪,连着平静则风浪退去
    const vMul = st.volMul * (wdef(st).volAdd || 1);
    const panic = sellPressure / (effPool + 350) * 0.5;
    const drift = avgValence(st) / 100 * 0.02            // 全场看多→温和上行(±2%)
      + (st.heat - 40) / 100 * 0.01                      // 热度是燃料(±0.6%)
      - Math.max(0, st.reg - 55) / 100 * 0.015           // 监管>55 后开始压制估值
      + rand(-0.018, 0.022) * vMul;                      // 市场噪声(略偏多:资金博弈)
    chg = (1 - panic) * (1 + clamp(drift, -0.05 * vMul, 0.05 * vMul)) - 1;
  } else {
    chg = (1 + buyImpact) * (1 - (sold > 0 ? (sold + sellPressure) / (effPool + 350) * usedCh.impact * 1.2 : sellPressure / (effPool + 350) * 0.5)) - 1;
  }
  if (st.heat < 30) chg = Math.min(chg, 0.06); // 无人气拉不动
  let snapped = '';
  // 护盘托底:托单只救跌、不放大涨;减半后封底 -6.9%,托住的回合不会触发跌停。停牌回合不消耗(冻结期间托单还在场内)
  if (st.supportNext) {
    if (!st.halted) { st.supportNext = false; if (chg < 0) chg = Math.max(chg * 0.5, -0.069); }
  }
  if (chg >= 0.07) { chg = 0.10; snapped = 'limitup'; }
  if (chg <= -0.07) { chg = -0.10; snapped = 'limitdown'; }
  chg = clamp(chg, -0.10, 0.10);
  const open = st.price;
  st.price = Math.max(0.5, st.price * (1 + chg));
  const pct = Math.round(chg * 1000) / 10;
  // 波动率聚集:|涨跌|≥8% 后振幅放大,≤2% 的平静回合后收敛(GARCH 式直觉:风浪成串出现)
  if (Math.abs(pct) >= 8) st.volMul = Math.min(st.volMul * 1.35, 2.0);
  else if (Math.abs(pct) <= 2) st.volMul = Math.max(st.volMul * 0.85, 0.7);
  // 连板
  const prevBoard = st.board;
  if (snapped === 'limitup') {
    st.board += 1; st.reg += wReg(st, 4 + 2 * st.board); st.heat += 8 + 3 * Math.min(st.board, 6); if (st.board >= 2) allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 5 + st.board, -100, 100); n.arousal = clamp(n.arousal + 6, 0, 100); });
    if (hasCombo('foam')) {   // 泡沫制造机:连板把泡沫吹得更大
      st.heat += 6;
      allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 6, -100, 100); });
      geneTips.push('❖ 泡沫制造机:连板正在把泡沫吹得更大(热度 +6,情绪 +6)。');
    }
  }
  else st.board = 0;
  st.heat += Math.abs(pct) * 0.8;
  st.history.push({ round: r0, open, close: st.price, high: Math.max(open, st.price) * 1.01, low: Math.min(open, st.price) * 0.99, board: st.board, pct });

  // 量化小散布识破
  if (!st.quantWarned && st.soldCum > 800 && Math.random() < 0.45) {
    st.quantWarned = true;
    allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 12, 0, 100); n.valence = clamp(n.valence - 8, -100, 100); });
    st.poolShockRounds = 2;
    st.feed.push({ type: 'kolpost', kol: 'kol_qh', title: '盘口异动警告', text: pick(T.kol.quant.bear), likes: randInt(800, 4000), round: r0 });
  }
  // 龙虎榜
  if (!st.lhbDone && st.reg >= 70 && st.soldCum > 500) {
    st.lhbDone = true;
    allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 10, 0, 100); n.valence = clamp(n.valence - 8, -100, 100); });
    st.poolShockRounds = Math.max(st.poolShockRounds, 2);
    st.feed.push({ type: 'news', tag: '龙虎榜', title: '龙虎榜曝光', text: fillStock(T.news.lhb.body), likes: randInt(500, 2000), round: r0 });
  }

  // 随机事件(报社交情天赋:媒体质疑不再出现)
  // 注:EVENTS 元素是 {key,w},pickWeighted 吃 {w,v} —— 此处做映射(修复事件池缺 v 导致随机事件从未触发的潜伏 bug)
  const phase = phaseOf(r0);
  const mediaW = (ctrait().tone === 'mystery' ? 1 : 2) * (hasCombo('duanhuo') ? 0.5 : 1);   // 低调神秘减半;刻意断货再减半
  const pMod = PHASE_EV_MODS[phase];   // 三段弧线:建仓期偏温和,决战期负面与监管密度抬升
  const wRot = wdef(st).evAmp || 1;    // 题材轮动日:消息面事件 ×3
  const evPool = (st.mediaSuppressed ? EVENTS.filter(e => e.key !== 'media_q') : EVENTS)
    .map(e => ({ w: (e.key === 'media_q' ? mediaW : e.w) * (pMod[e.key] || 1) * (ROT_EV_KEYS[e.key] ? wRot : 1), v: e.key }));
  // 横盘回合(|涨跌|<4):压低"无事发生"的概率,加入散户闲聊,生态不打烊
  if (Math.abs(pct) < 4) {
    const noEv = evPool.find(e => e.v === 'none');
    if (noEv) noEv.w = Math.min(noEv.w, 3);
    evPool.push({ w: 2, v: 'chat' });
  }
  // 负面情绪的赛道系数(民生消费:坏消息传得更快;天气避险日放大/追涨日缓和,复合上限 1.8 防止对高 negMul 赛道叠死);亲民叙事:市场/行业事件情绪冲击 ×1.25
  const mv = (dv) => { const m2 = (dv < 0 ? Math.min(negMul(st) * (wdef(st).negAmp || wdef(st).negSoft || 1), 1.8) : 1) * (td.eventAmp || 1) * (dv > 0 && hasCombo('yanzhi') ? 1.3 : 1) * (dv < 0 && st.honestRounds > 0 ? 0.85 : 1); allNPCs(st).forEach(n => { n.valence = clamp(n.valence + dv * m2, -100, 100); }); };
  const pushNews = (tag, title, body, tagCls, likes) => st.feed.push({ type: 'news', tag, title, text: fillStock(body), likes: likes || randInt(100, 900), round: r0, tagCls });
  // 黑天鹅引爆(伏笔的兑现)> 事件连锁(上回合的后劲)> 普通随机事件:三者共用本回合的"事件位"
  let eventTip = null;
  if (st.foreshadow && r0 > st.foreshadow.round) {
    const sw = SWANS[st.foreshadow.key];
    st.foreshadow = null; st.swansFired++;
    eventTip = '❗ ' + sw.fx(st, mv, pushNews);
  } else if (st.chainNext) {
    const chn = CHAINS[st.chainNext.key];
    st.chainNext = null;
    if (Math.random() < chn.p) eventTip = '⛓ ' + chn.fx(st, mv, pushNews);
  }
  const evKey = eventTip ? 'none' : pickWeighted(evPool);
  if (evKey === 'sector_up') { mv(8); st.heat += 10; pushNews('行业', T.news.sector_up.title, T.news.sector_up.body); }
  else if (evKey === 'market_drop') { mv(-10); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 8, 0, 100); }); st.feed.push({ type: 'news', tag: '大盘', title: T.news.market_drop.title, text: T.news.market_drop.body, likes: randInt(100, 900), round: r0 }); }
  else if (evKey === 'media_q') {
    if (hasCombo('lunwen') && !st.comboLunwenUsed) {
      // 论文战线:每局一次,权威背书直接化解质疑
      st.comboLunwenUsed = true;
      st.heat = clamp(st.heat + 3, 0, 100);
      pushNews('媒体', '论文背书', '面对铺天盖地的质疑,{stock}一次性公布权威期刊论文与试验数据,质疑者集体失声,风向悄然逆转。', 't-pol', randInt(300, 1500));
      geneTips.push('❖ 论文战线:权威背书化解了这次媒体质疑。');
    } else {
      const fragile = ctrait().arch === 'biotech';   // 生物医药:经不起质疑
      const loss = (fragile ? 20 : 10) * (hasCombo('techfaith') || hasCombo('gongchuang') ? 0.5 : 1);   // 技术信仰/医研共创:临床背书,杀伤减半
      allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - loss, 0, 100); });
      st.heat -= 5; st.reg += fragile ? 10 : 5;
      pushNews('媒体', T.news.media_q.title, T.news.media_q.body, null, randInt(200, 1200));
      if (hasCombo('techfaith')) geneTips.push('❖ 技术信仰:数据撑腰,质疑的信心杀伤减半。');
    }
  }
  else if (evKey === 'fight') { allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 12, 0, 100); }); st.heat += 6; pushNews('社区', T.news.fight.title, T.news.fight.body, null, randInt(50, 500)); }
  else if (evKey === 'policy_tight') { mv(-4); st.heat = Math.max(0, st.heat - 8); st.reg += 5; pushNews('政策', '监管新规', T.market.policy_tight.body, 't-pol'); }
  else if (evKey === 'policy_ease') { mv(6); st.heat = clamp(st.heat + 8, 0, 100); st.poolBoostNext = Math.max(st.poolBoostNext || 1, 1.05); pushNews('政策', '产业利好', T.market.policy_ease.body, 't-pol'); }
  else if (evKey === 'rate_ease') { mv(5); st.poolBoostNext = Math.max(st.poolBoostNext || 1, 1.10); pushNews('宏观', '流动性宽松', T.market.rate_ease.body, 't-mac'); }
  else if (evKey === 'rate_tight') { mv(-5); st.poolBoostNext = Math.min(st.poolBoostNext || 1, 0.90); pushNews('宏观', '流动性收紧', T.market.rate_tight.body, 't-mac'); }
  else if (evKey === 'rival_launch') { mv(-5); allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 5, 0, 100); }); st.heat = Math.max(0, st.heat - 4); pushNews('同行', '竞品发布', T.market.rival_launch.body, 't-riv'); }
  else if (evKey === 'rival_fail') { mv(6); st.heat = clamp(st.heat + 5, 0, 100); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 6, 0, 100); }); pushNews('同行', '竞对爆雷', T.market.rival_fail.body, 't-riv'); }
  else if (evKey === 'supply') { mv(-3); allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 5, 0, 100); }); st.heat = clamp(st.heat + 3, 0, 100); pushNews('同行', '供应链承压', T.market.supply.body, 't-riv'); }
  else if (evKey === 'viral') { mv(5); st.heat = clamp(st.heat + 10, 0, 100); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 8, 0, 100); }); st.chainNext = { key: 'viral_backlash' }; pushNews('消费', '产品出圈', T.market.viral.body, 't-con'); }
  else if (evKey === 'boycott') { mv(-7); st.heat = clamp(st.heat + 6, 0, 100); st.reg += 3; st.chainNext = { key: 'boycott_reply' }; pushNews('消费', '消费者质疑', T.market.boycott.body, 't-con'); }
  else if (evKey === 'celebrity') { mv(3); st.heat = clamp(st.heat + 6, 0, 100); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 10, 0, 100); }); st.chainNext = { key: 'celeb_bust' }; pushNews('消费', '主播带货', T.market.celebrity.body, 't-con'); }
  else if (evKey === 'kol_joint') { mv(4); st.heat = clamp(st.heat + 5, 0, 100); allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 5, -100, 100); n.confidence = clamp(n.confidence + 4, 0, 100); }); pushNews('社区', T.news.kol_joint.title, T.news.kol_joint.body, 't-con', randInt(800, 3000)); }
  else if (evKey === 'roundtable') { mv(2); st.heat = clamp(st.heat + 8, 0, 100); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 6, 0, 100); }); pushNews('社区', T.news.roundtable.title, T.news.roundtable.body, 't-con', randInt(500, 2000)); }
  else if (evKey === 'doxxed') { mv(-3); allNPCs(st).forEach(n => { n.valence = clamp(n.valence - 10, -100, 100); n.confidence = clamp(n.confidence - 5, 0, 100); }); st.reg += 8; pushNews('社区', T.news.doxxed.title, T.news.doxxed.body, null, randInt(500, 2500)); }
  else if (evKey === 'holder_sell') { mv(-4); allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 6, 0, 100)); st.reg += 3; st.heat = clamp(st.heat + 4, 0, 100); pushNews('公告', '大股东减持', T.market.holder_sell.body, 't-dn', randInt(600, 3000)); }
  else if (evKey === 'short_report') { mv(-6); allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 9, 0, 100); n.arousal = clamp(n.arousal + 6, 0, 100); }); st.heat = clamp(st.heat + 10, 0, 100); pushNews('海外', '做空报告', T.market.short_report.body, 't-dn', randInt(1000, 5000)); }
  else if (evKey === 'algo_limit') { st.heat = Math.max(0, st.heat - 10); st.poolBoostNext = Math.min(st.poolBoostNext || 1, 0.94); pushNews('平台', '算法限流', T.market.algo_limit.body, 't-dn', randInt(300, 1500)); }
  else if (evKey === 'unlock') { mv(-3); allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 4, 0, 100)); pushNews('公告', '解禁日', T.market.unlock.body, 't-dn', randInt(300, 1500)); }
  else if (evKey === 'fan_support') { mv(5); st.heat = clamp(st.heat + 8, 0, 100); allNPCs(st).forEach(n => n.arousal = clamp(n.arousal + 8, 0, 100)); pushNews('消费', '粉丝应援', T.market.fan_support.body, 't-con', randInt(500, 2600)); }
  else if (evKey === 'employee_leak') { mv(-3); allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 6, 0, 100)); st.heat = clamp(st.heat + 8, 0, 100); st.reg += 4; pushNews('媒体', '员工爆料', T.market.employee_leak.body, 't-dn', randInt(800, 3600)); }
  else if (evKey === 'dividend') { mv(6); allNPCs(st).forEach(n => n.confidence = clamp(n.confidence + 8, 0, 100)); st.heat = clamp(st.heat + 4, 0, 100); pushNews('公告', '分红公告', T.market.dividend.body, 't-up', randInt(400, 2000)); }
  else if (evKey === 'rumor') {
    const bias = ARCHETYPES[ctrait().arch].rumorBias || 0.5;   // 军工防务:信息黑箱,八成利好
    const rPool = Math.random() < bias ? T.rumors.filter(x => x.good) : T.rumors.filter(x => !x.good);
    const r = pick(rPool.length ? rPool : T.rumors);
    st.rumorPending = { left: randInt(1, 2), good: r.good };
    pushNews('传闻', '传闻四起', r.text, 't-rum', randInt(300, 1800));
  }
  else if (evKey === 'chat') {
    st.heat = clamp(st.heat + 2, 0, 100);
    allNPCs(st).forEach(n => n.arousal = clamp(n.arousal + 3, 0, 100));
    if (Math.random() < 0.45 && st.retails.length && st.kols.length) {
      residentStory(st, r0);   // 居民自主剧情:横盘回合的生态心跳
    } else {
      const who = pick(st.retails);
      st.feed.push({ type: 'comment', author: who.name, tag: who.tag, text: pick(T.idleChat), likes: randInt(2, 60), round: r0 });
    }
  }

  // 对手盘相位:敌意演化 → 悬置对线清算 → 按敌意阶梯行动(与随机事件共用本回合的 feed 组)
  // 限流标志在这里之前清理:上回合对手举报的限流只管玩家刚过去的这一回合
  st.limitNext = false;
  rivalPhase(st, r0, mv, pushNews, rivalTips);

  // 暗雷引线·记者调查(热度 ≥60 才可能被盯上):先预警给一回合洗白窗口,过后每回合 25% 引爆
  {
    const m0 = st.mine;
    if (m0 && !m0.defused && !m0.exploded) {
      if (m0.warnRound >= 0 && r0 > m0.warnRound) {
        if (Math.random() < 0.10) explodeMine(st, 'press', mv, pushNews, rivalTips);   // 窗口过后 10%/回合(回测:25% 会把稳健基线打掉 11pp)
      } else if (m0.warnRound < 0 && st.heat >= 60 && Math.random() < Math.min(0.06, 0.02 + (st.heat - 60) / 400)) {
        m0.warnRound = r0;
        st.feed.push({ type: 'comment', author: pick(st.retails).name, tag: '路人', text: T.minePressWarn, likes: randInt(2, 40), round: r0 });
        rivalTips.push('🗞 有调查记者在打听你的老账:下一回合内「处理暗雷」可按「主动配合调查」优待(监管减半)——窗口只有一回合。');
      }
    }
  }


  // 黑天鹅伏笔:发酵期 7% / 决战期 11% 埋雷,下一回合的事件位引爆(每局至多 2 只,不重复)
  // 保底:到 12 回合还一只没埋过,概率抬到 35%——绝大多数对局至少遇一次名场面,又不至于喧宾夺主
  let swanP = phase === 1 ? 0.07 : phase === 2 ? 0.11 : 0;
  if (swanP && st.swansUsed.length === 0 && r0 >= 12) swanP = 0.35;
  if (!st.foreshadow && r0 >= 6 && r0 < CONFIG.totalRounds && st.swansUsed.length < 2 && Math.random() < swanP) {
    const keys = Object.keys(SWANS).filter(k => !st.swansUsed.includes(k));
    if (keys.length) {
      const k2 = pick(keys);
      st.swansUsed.push(k2);
      st.foreshadow = { key: k2, round: r0 };
      st.feed.push({ type: 'comment', author: pick(st.retails).name, tag: '路人', text: SWANS[k2].plant, likes: randInt(2, 40), round: r0 });
    }
  }
  // 居民自主剧情:闲聊位之外的独立小剧场,约 8%/回合——没有大事件的回合也有人的故事
  if (!st.ended && st.retails.length && st.kols.length && Math.random() < 0.08) residentStory(st, r0);

  // 传闻两段式:起(试探性情绪)→ 1~2 回合后证实/辟谣——"买传闻,卖新闻"的节奏博弈
  if (st.rumorPending) {
    st.rumorPending.left--;
    if (st.rumorPending.left <= 0) {
      if (st.rumorPending.good) {
        mv(8); st.heat = clamp(st.heat + 10, 0, 100); st.poolBoostNext = Math.max(st.poolBoostNext || 1, 1.08);
        pushNews('传闻', '传闻证实', T.market.rumor_good.body, 't-rum t-up', randInt(400, 2000));
      } else {
        mv(-8); allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 6, 0, 100); });
        st.poolShockRounds = Math.max(st.poolShockRounds, 1);
        pushNews('传闻', '官方辟谣', T.market.rumor_bad.body, 't-rum t-dn', randInt(400, 2000));
      }
      st.rumorPending = null;
    } else {
      const who = pick(st.retails);
      st.feed.push({ type: 'comment', author: who.name, tag: who.tag, text: '昨天那个传闻到底真假?在线等,挺急的。', likes: randInt(5, 80), round: r0, parentTag: '传闻' });
    }
  }

  // 财报日(第 5/10/15 回合收盘):造势强度决定"超预期"概率——热度是把双刃剑
  if (r0 === 5 || r0 === 10 || r0 === 15) {
    if (Math.random() < clamp(0.35 + st.heat / 200, 0.35, 0.75)) {
      mv(6); st.heat = clamp(st.heat + 8, 0, 100);
      pushNews('财报', '业绩超预期', T.market.earn_good.body, 't-up', randInt(400, 2000));
    } else {
      mv(-7); allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 4, 0, 100); });
      pushNews('财报', '业绩不及预期', T.market.earn_bad.body, 't-dn', randInt(400, 2000));
    }
  }

  // 情绪演化(涌现层)——过热时观点极化:热度>80,所有人的立场都往更极端的方向再推一步
  const mktPull = pct * 1.8, heatPull = (st.heat - 50) * 0.08;
  const polarize = st.heat > 80 ? 3 : 0;
  allNPCs(st).forEach(n => {
    n.valence *= n.kind === 'kol' ? 0.96 : 0.92;
    n.valence = clamp(n.valence + mktPull * (n.kind === 'kol' ? 0.6 : 1) + heatPull + rand(-4, 4) + (n.valence >= 0 ? polarize : -polarize), -100, 100);
    n.confidence = clamp(n.confidence + (50 - n.confidence) * 0.08 + rand(-2, 2), 5, 100);
    n.arousal = clamp(n.arousal * 0.9 + rand(0, 6), 0, 100);
    if (n.kind === 'kol' && Math.abs(pct) >= 8) n.memory.push({ round: r0, note: pct > 0 ? '第' + r0 + '回合涨停,我说过要注意节奏' : '第' + r0 + '回合跌停,我提示过风险' });
  });
  // 充值大V回合计时
  for (const k of Object.keys(st.kolsBoost)) { st.kolsBoost[k]--; if (st.kolsBoost[k] <= 0) delete st.kolsBoost[k]; }
  // 「坦诚」buff(自爆洗白):每回合情绪小幅回血
  if (st.honestRounds > 0) allNPCs(st).forEach(n => n.valence = clamp(n.valence + 2, -100, 100));

  // 现金奶牛(医美健康):会员充值每回合净流入
  const ARCH = ARCHETYPES[ctrait().arch];
  if (ARCH.roundCash) {
    st.cash += ARCH.roundCash;
    if (!st.cashCowTipped) { st.cashCowTipped = true; geneTips.push('❖ 现金奶牛:会员充值到账,每回合净流入 ' + ARCH.roundCash + ' 万。'); }
  }
  // 监管衰减与阈值(泛娱乐赛道:热度烧得快,额外 -4;过度包装:存在感透支,额外 -2)
  // 天气:吃瓜日热度自然 +3;严打周监管关注度衰减减半
  const wd = wdef(st);
  st.heat = clamp(st.heat + (wd.heatDrift || 0) - CONFIG.heatDecay - (ARCH.heatDecayAdd || 0) - (td.heatDecayAddTone || 0), 0, 100);
  st.reg = clamp(st.reg - (wd.regHalf ? CONFIG.regDecay / 2 : CONFIG.regDecay) + (td.regCool || 0) - (hasCombo('zhongqi') ? 1 : 0), 0, 100);   // 资本故事:风声收得慢;国之重器:监管敬三分
  if (st.poolShockRounds > 0) st.poolShockRounds--;
  if (st.halted) { st.haltLeft--; if (st.haltLeft <= 0) st.halted = false; }

  // 生成社区 feed(问题帖+高赞回答+评论)
  genFeed(st, pct, snapped);

  // 满仓叙事:本回合真实掏钱最多的散户,把买入行为写成可读的帖子(社区反馈可视化)
  const buyers = st.retails.filter(n => (n._lastBuy || 0) * st.price >= 0.5).sort((a, b) => b._lastBuy - a._lastBuy).slice(0, 2);
  const buyPool = T.buyActions.slice();   // 同回合多条不撞文案
  buyers.forEach(n => {
    if (Math.random() < 0.75) st.feed.push({
      type: 'a', author: n.name, tag: n.tag, round: r0, likes: randInt(20, 900),
      text: (buyPool.length ? buyPool.splice(Math.floor(Math.random() * buyPool.length), 1)[0] : pick(T.buyActions))
    });
  });

  // 质疑声量:全网看多过热(>60%)时,不可被说服的居民发难——全场信心 -2,下回合买盘池 95 折
  st.doubtNext = 1;
  if (!st.doubtCalm && st.retails.filter(n => n.valence > 25).length / st.retails.length > 0.6 && Math.random() < 0.45) {
    const skeptics = st.retails.filter(n => !(PERSONA_META[n.persona] && PERSONA_META[n.persona].suggestible) && n.valence < 25);
    if (skeptics.length) {
      const who = pick(skeptics);
      allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 2, 0, 100));
      st.feed.push({ type: 'a', author: who.name, tag: who.tag + '·质疑', text: pick(T.skepticPosts), likes: randInt(200, 2200), round: r0 });
      st.doubtNext = 0.95;
      if (td.doubtSoft) st.doubtNext = 1 - (1 - st.doubtNext) / 2;   // 技术立司:专业背书,质疑打击减半
    }
  }
  st.doubtCalm = false;

  // 监管阈值事件
  st.tips = [];
  st.tips.push(...geneTips);   // 基因溯源提示:并入本轮结算 toast(先基因后监管,重要的排在后)
  if (eventTip) st.tips.push(eventTip);   // 黑天鹅/连锁的结算提示
  st.tips.push(...rivalTips);   // 对手盘/暗雷的结算提示
  if (st.reg >= 100) { triggerEnd(st, 'prison'); return; }
  if (st.reg >= 85 && !st.exposureDone) { st.exposureDone = true; st.feed.push({ type: 'news', tag: '监管', title: T.reg.exposure.title, text: fillStock(T.reg.exposure.body), likes: 0, round: r0, llm: 'regulation' }); st.tips.push('监察部已经标记了你的账户。再激进,就是立案。'); }
  if (st.reg >= haltAt(st) && !st.halted && st.haltLeft <= 0) {
    st.halted = true; st.haltLeft = 2;
    st.feed.push({ type: 'news', tag: '监管', title: T.reg.halt.title, text: fillStock(T.reg.halt.body), likes: 0, round: r0 });
    st.tips.push('临时停牌:交易冻结中,舆论操作不受影响——「🧯 澄清」还能给监管降温,加速复牌。');
  }
  if (st.reg >= inquiryAt(st) && !st.inquiryDone) {
    st.inquiryDone = true; st.heat = Math.max(0, st.heat - 8);
    st.feed.push({ type: 'news', tag: '监管', title: T.reg.inquiry.title, text: fillStock(T.reg.inquiry.body), likes: 0, round: r0, llm: 'regulation' });
    st.tips.push('第一封问询函到了。这是提醒,也是计时器开始加速的信号。');
  }

  st.round = r0 + 1;
  st.ap = st.apPerTurn;
  st.washNext = false; st.exitNext = false; st.poolBoostNext = 0;
  if (st.honestRounds > 0) st.honestRounds--;   // 「坦诚」buff 回合计时
  // 小管家任务结算:判定本回合目标并发奖(终局回合不判——没有下一回合承接奖励)
  let taskApBonus = 0, taskPoolBoost = 0;
  if (r0 < CONFIG.totalRounds) {
    const tk = taskOf(st);
    if (tk) {
      const opTotal = Object.values(st.roundOps).reduce((a, b) => a + b, 0);
      const done =
        tk.key === 'op2' ? opTotal >= 2 :
        tk.key === 'silent' ? !['hot', 'writer', 'kol', 'clarify'].some(k => st.roundOps[k]) :
        tk.key === 'heat55' ? (st.roundOps.post >= 1 && st.heat >= 55) :
        tk.key === 'answer' ? st.roundOps.astroturf >= 1 :
        tk.key === 'nosell' ? !st.soldThisRound :
        tk.key === 'clarify' ? st.roundOps.clarify >= 1 :
        tk.key === 'counter' ? st.roundOps.counter >= 1 :
        tk.key === 'minedef' ? (st.roundOps.probe >= 1 || st.roundOps.defuse >= 1) : false;
      if (done) {
        if (tk.key === 'op2') taskApBonus = 1;
        else if (tk.key === 'silent' || tk.key === 'clarify' || tk.key === 'counter') st.reg = Math.max(0, st.reg - 3);
        else if (tk.key === 'heat55') taskPoolBoost = 1.08;
        else if (tk.key === 'nosell') taskPoolBoost = 1.05;
        else if (tk.key === 'minedef') taskPoolBoost = 1.06;
        else if (tk.key === 'answer') st.cash += 60;
        st.tips.push('✅ 小管家任务完成「' + tk.name + '」:' + tk.reward + '。');
      }
    }
  }
  st.ap += taskApBonus;
  if (taskPoolBoost) st.poolBoostNext = Math.max(st.poolBoostNext, taskPoolBoost);
  st.roundOps = {}; st.soldThisRound = false;
  // 新回合的情境发布:阶段切换提示 + 天气轮换(合并成一条提示,toast 只带一条)+ 下回合任务卡
  if (st.round <= CONFIG.totalRounds) {
    const ctxTips = [];
    const np = phaseOf(st.round);
    if (np !== phase) ctxTips.push('📅 ' + PHASES[np].name + ':' + PHASES[np].tip);
    const wKey = rollWeather(st);
    if (wKey !== 'calm') { const wd2 = WEATHERS[wKey]; ctxTips.push(wd2.icon + ' 天气:「' + wd2.name + '」' + wd2.desc); }
    if (ctxTips.length) st.tips.push(ctxTips.join(' '));
    const nt = assignTask(st);
    st.feed.push({ type: 'news', tag: '小管家', title: '本回合任务:「' + nt.name + '」', text: nt.hint + '。完成奖励:' + nt.reward + '。', likes: randInt(30, 200), round: st.round });
  }
  // 现金为负:只提醒一次,把自救手段讲清楚(买入挂单在上游已按现金夹紧,这里是最后防线)
  if (st.cash < 0 && !st.debtWarned) {
    st.debtWarned = true;
    st.tips.push('⚠ 资金链紧张:现金为负,花钱的动作已被锁定——「集中竞价出货」回笼现金是唯一自救手段,免费的「发帖/自答」仍可用。');
  }
  // 抉择事件:第 4 回合起小概率出现,每局至多 2 次(停牌中也会出现——正好是处理麻烦的时候)
  // 三段弧线:抉择概率随阶段抬升(建仓 14% / 发酵 18% / 决战 25%)
  // 终局回合不再出新抉择:没有下一回合承接后果,且异步 AI 生成会晚于结局弹出(ui.js 侧另有 st.ended 兜底)
  if (!st.ended && r0 >= 4 && r0 < CONFIG.totalRounds && !st.pendingDecision && st.decisions < 2 && Math.random() < PHASE_DECISION_P[phaseOf(st.round)]) {
    const pool = DECISIONS.filter(d => !st.usedDecisions.includes(d.id));
    if (pool.length) { st.pendingDecision = pick(pool); st.decisions++; st.usedDecisions.push(st.pendingDecision.id); }
  }
  if (st.round > CONFIG.totalRounds) { triggerEnd(st, null); return; }
  return true;
}

/* ---------------- AI 抉择事件效果池 ----------------
 * LLM 只负责"命题作文"(事件叙事 + 从目录选 id),数值后果全部由这里的确定性函数执行。
 * 加入新效果时保持幅度与本地事件同级,headless 自测覆盖不到 AI 事件,故务必保守。 */
const AI_EVENT_EFFECTS = {
  heat_up:   { desc: '热度+12,全场唤醒+5', apply(st) { st.heat = clamp(st.heat + 12, 0, 100); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 5, 0, 100); }); return '话题发酵:热度 +12,居民们更兴奋了。'; } },
  heat_down: { desc: '热度-12', apply(st) { st.heat = clamp(st.heat - 12, 0, 100); return '风波渐冷:热度 -12,买盘池的燃料少了一截。'; } },
  reg_up:    { desc: '监管+10', apply(st) { st.reg = clamp(st.reg + 10, 0, 100); return '风声收紧:监管关注度 +10。'; } },
  reg_down:  { desc: '监管-8,热度-5', apply(st) { st.reg = clamp(st.reg - 8, 0, 100); st.heat = clamp(st.heat - 5, 0, 100); return '危机暂时化解:监管 -8,热度 -5。'; } },
  bull_wave: { desc: '全场看多+8,唤醒+4', apply(st) { allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 8, -100, 100); n.arousal = clamp(n.arousal + 4, 0, 100); }); return '群情激奋:全场看多情绪 +8。'; } },
  bear_wave: { desc: '全场看空-8,唤醒+5', apply(st) { allNPCs(st).forEach(n => { n.valence = clamp(n.valence - 8, -100, 100); n.arousal = clamp(n.arousal + 5, 0, 100); }); return '恐慌蔓延:全场看空情绪加深。'; } },
};

function inquiryAt(st) { return (st.trait === 'calm' ? 40 : 35) + (ARCHETYPES[ctrait().arch].inquiryMod || 0); }   // 军工防务:敏感资质,更早被问询
function haltAt(st) { return st.trait === 'calm' ? 65 : 60; }

/* ---------------- 暗盘大招(每局一次) ---------------- */
function useWash(st) {
  if (!st.skills.wash) return { ok: false, msg: '对倒放量已经用过了(每局一次)' };
  if (st.halted) return { ok: false, msg: '停牌期间无法操作' };
  if (st.cash < 800) return { ok: false, msg: '需要 800 万现金自买自卖' };
  const strong = hasCombo('liuliang');   // 流量赌场:对倒效果更强
  st.cash -= 800; st.skills.wash = false;
  st.washNext = strong ? 1.5 : 1.35;     // 本回合买盘池虚增系数
  st.heat = clamp(st.heat + (strong ? 24 : 18), 0, 100);
  allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 10, -100, 100); n.arousal = clamp(n.arousal + 10, 0, 100); });
  // 只夹下限:与 applyOpinion 同一原则——监管溢出 100 的部分要保留(结算先衰减再判 ≥100)
  st.reg = Math.max(0, st.reg + wReg(st, 14));
  st.usedTactics.wash = true;
  return { ok: true, msg: '对倒放量启动:虚假成交制造抢筹假象——本回合买盘池 +' + (strong ? 50 : 35) + '%,热度 +' + (strong ? 24 : 18) + ',监管 +14' };
}
function useExit(st) {
  if (!st.skills.exit) return { ok: false, msg: '金蝉脱壳已经用过了(每局一次)' };
  if (st.halted) return { ok: false, msg: '停牌期间无法操作' };
  if (st.pendingSell) return { ok: false, msg: '已有卖出挂单,先取消再使用' };
  st.skills.exit = false; st.exitNext = true;
  return { ok: true, msg: '金蝉脱壳就绪:本回合挂出的卖单,冲击/折价/监管全部减半' };
}
function useSupport(st) {   // 护盘托底:资金侧唯一的防守动作——挂托单把下回合跌幅减半(可重复,不叠加)
  if (st.halted) return { ok: false, msg: '停牌期间无法操作' };
  if (st.supportNext) return { ok: false, msg: '托单已在场内:下回合结算时生效,不能叠加。' };
  if (st.cash < 400) return { ok: false, msg: '护盘托底需要 400 万现金——先想想怎么出货回笼。' };
  st.cash -= 400;
  st.supportNext = true;
  st.reg = Math.max(0, st.reg + wReg(st, 3));   // 尾盘异动会被注意到:只夹下限,保留 ≥100 立案的溢出
  return { ok: true, msg: '护盘托底已挂进场:下回合结算时若下跌,跌幅减半、免于跌停。现金 -400 万,监管 +3。' };
}

/* ---------------- 抉择事件卡 ---------------- */
const DECISIONS = [
  {
    id: 'rat', title: '老鼠仓合伙人',
    text: '当年帮你建仓的中间人找上门:最近风声紧,他想"退休"。要么给钱,要么他嘴巴不严——你手里还有大把筹码没出完。',
    opts: [
      { label: '破财免灾(支付 2000 万)', hint: '现金 -2000万 · 监管 -8', apply(st) { st.cash -= 2000; st.reg = clamp(st.reg - 8, 0, 100); return '支付 2000 万封口:监管关注度 -8,他闭嘴了(大概)。'; } },
      { label: '翻脸不认', hint: '监管 +12 · 全场情绪 -6', apply(st) { st.reg = clamp(st.reg + 12, 0, 100); allNPCs(st).forEach(n => n.valence = clamp(n.valence - 6, -100, 100)); return '他四处放话"等着看吧":监管 +12,社区情绪 -6。'; } },
      { label: '拉他入伙(支付 500 万)', hint: '现金 -500万 · 下回合买盘池 +20% · 35% 概率被反咬(监管+15)', apply(st) { st.cash -= 500; st.poolBoostNext = 1.2; const betrayed = Math.random() < 0.35; if (betrayed) st.reg = clamp(st.reg + 15, 0, 100); return '他答应帮忙造势:下回合买盘池 +20%' + (betrayed ? '。但他转头就把你卖了:监管 +15!' : '。(暂无异常迹象)'); } },
    ],
  },
  {
    id: 'reporter', title: '财经记者上门',
    text: '《云上财经》的调查记者约你喝茶:她手里有一份你的龙虎榜交易记录,但她更想要一个"独家故事"。',
    opts: [
      { label: '花钱消灾(1200 万)', hint: '现金 -1200万 · 本局免疫媒体质疑事件', apply(st) { st.cash -= 1200; st.mediaSuppressed = true; return '签订"战略合作":本局不再触发媒体质疑事件。'; } },
      { label: '接受专访', hint: '全场情绪 +8 · 25% 概率监管 +10', apply(st) { allNPCs(st).forEach(n => n.valence = clamp(n.valence + 8, -100, 100)); const hit = Math.random() < 0.25; if (hit) st.reg = clamp(st.reg + 10, 0, 100); return '专访刊出,人气大涨:情绪 +8' + (hit ? '。但记者多写了一笔"关联交易疑云":监管 +10。' : '。'); } },
      { label: '拂袖而去', hint: '热度 -8 · 无新把柄', apply(st) { st.heat = clamp(st.heat - 8, 0, 100); return '不欢而散:热度 -8,传闻倒是没了下文。'; } },
    ],
  },
  {
    id: 'hotmoney', title: '神秘游资递来纸条',
    text: '龙虎榜上那个"知名席位"托人带话:他看好这只票,想跟你合力做一波。代价是——他知道你的存在。',
    opts: [
      { label: '合力点火', hint: '热度 +15 · 下回合买盘池 +10% · 监管 +10', apply(st) { st.heat = clamp(st.heat + 15, 0, 100); st.poolBoostNext = 1.1; st.reg = clamp(st.reg + 10, 0, 100); return '两路资金合力:热度 +15,下回合买盘池 +10%,监管 +10。'; } },
      { label: '婉拒合作', hint: '现金 +300万 · 无其他后果', apply(st) { st.cash += 300; return '对方表示"后会有期",留下 300 万信息费。'; } },
      { label: '将计就计', hint: '监管 -12 · 热度 -5', apply(st) { st.reg = clamp(st.reg - 12, 0, 100); st.heat = clamp(st.heat - 5, 0, 100); return '你把他推到台前吸引火力:监管关注度 -12,热度 -5。'; } },
    ],
  },
  {
    id: 'foreign', title: '境外资金询价',
    text: '一位境外机构经理通过中间人询价:愿意以 9.1 折吃下你 30% 的可卖筹码,大宗过户,不留痕迹。',
    opts: [
      { label: '成交(30% 筹码 9.1 折)', hint: '30% 可卖筹码按 9.1 折过户 · 回款即时到账 · 不惊动市场', apply(st) { const amt = sellableShares(st) * 0.3; if (amt < 10) return '可卖筹码不足,对方摇了摇头。'; const rev = amt * st.price * 0.91; st.cash += rev; st.realized += rev; let left = amt; for (const lot of st.lots) { if (lot.round === st.round) continue; const take = Math.min(lot.shares, left); lot.shares -= take; left -= take; if (left <= 0) break; } st.lots = st.lots.filter(l => l.shares > 0.0001); st.soldCum += amt; return '大宗过户 ' + Math.round(amt) + ' 万股 @ 9.1 折,回款 ' + fmtYi(rev) + ',不惊动任何人。'; } },
      { label: '嫌折价太高,拒绝', hint: '无收益 · 无风险', apply(st) { return '对方耸耸肩离开:机会成本自负。'; } },
    ],
  },
  {
    id: 'elder', title: '老领导点拨',
    text: '退休的老领导约你打球。收杆时他意味深长地说:"年轻人,钱是赚不完的。"',
    opts: [
      { label: '孝敬 1500 万', hint: '现金 -1500万 · 监管 -18', apply(st) { st.cash -= 1500; st.reg = clamp(st.reg - 18, 0, 100); return '老领导笑纳:"最近的风,我帮你看着点。"关注度 -18。'; } },
      { label: '只谈球,不谈事', hint: '热度 -4 · 平安无事', apply(st) { st.heat = clamp(st.heat - 4, 0, 100); return '平安无事打完十八洞:热度 -4。'; } },
    ],
  },
  {
    id: 'shortseller', title: '做空机构点名',
    text: '一家境外做空机构发布报告:你的公司"基本面撑不起股价",并暗示"背后有操纵之手"。报告正被翻译传播。',
    opts: [
      { label: '火力全开回击', hint: '热度 +12 · 全场情绪 +6 · 信心 -4 · 监管 +8', apply(st) { st.heat = clamp(st.heat + 12, 0, 100); allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 6, -100, 100); n.confidence = clamp(n.confidence - 4, 0, 100); }); st.reg = clamp(st.reg + 8, 0, 100); return '你发动一切资源反做多:热度 +12,情绪 +6,监管 +8。'; } },
      { label: '冷处理', hint: '全场情绪 -8 · 信心 -6 · 不添新把柄', apply(st) { allNPCs(st).forEach(n => { n.valence = clamp(n.valence - 8, -100, 100); n.confidence = clamp(n.confidence - 6, 0, 100); }); return '装死不回应:情绪 -8,信心 -6,但没添新把柄。'; } },
    ],
  },
  {
    id: 'live', title: '知识付费的诱惑',
    text: '运营团队端着方案进来:开一场付费 Live《三节课看懂这家公司》,定价 199,已有一万人预约。讲什么不重要——重要的是,愿意为「知识」付钱的人,最相信「故事」。',
    opts: [
      { label: '开!割就完了', hint: '现金 +800万 · 唤醒+8 情绪+5 · 35% 概率翻车(监管+10 情绪-8)', apply(st) { st.cash += 800; allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 8, 0, 100); n.valence = clamp(n.valence + 5, -100, 100); }); const busted = Math.random() < 0.35; if (busted) { st.reg += 10; allNPCs(st).forEach(n => n.valence = clamp(n.valence - 8, -100, 100)); } return busted ? 'Live 讲到一半,有人放出往期录音:「同一套稿子,三年割了三批人。」监管 +10,情绪 -8——知识付费的尽头是维权群。' : '门票、打赏、课后「一对一咨询」——知识真的变成了钱。暂时没人发现,PPT 是三年前做的。'; } },
      { label: '认真讲一场', hint: '现金 -300万 · 全场置信 +6', apply(st) { st.cash -= 300; allNPCs(st).forEach(n => n.confidence = clamp(n.confidence + 6, 0, 100)); return '请来真正的行业专家,讲了三小时干货。观众记了笔记,也记住了这家公司的名字:全场置信 +6。'; } },
      { label: '婉拒:不赚这份钱', hint: '热度 -5 · 安分守己', apply(st) { st.heat = clamp(st.heat - 5, 0, 100); return '话题热度自然回落:热度 -5。有些钱不赚,账面难看,但睡得着。'; } },
    ],
  },
  {
    id: 'nightessay', title: '深夜的长文',
    text: '凌晨两点,草稿箱里躺着一篇署名「业内匿名」的复盘长文:数据翔实、态度克制,只差一个发布按钮。光标在「发布」上,一闪,一闪。',
    opts: [
      { label: '发!这是最好的剧本', hint: '热度 +6 · 全场置信 +8 · 20% 概率被扒出硬伤(情绪-8)', apply(st) { st.heat = clamp(st.heat + 6, 0, 100); allNPCs(st).forEach(n => n.confidence = clamp(n.confidence + 8, 0, 100)); const caught = Math.random() < 0.2; if (caught) allNPCs(st).forEach(n => n.valence = clamp(n.valence - 8, -100, 100)); return caught ? '凌晨四点,有人逐条核对了文中数据,发现两处关键图表对不上:情绪 -8。「匿名大佬」人设当场塌房——先问是不是,果然重要。' : '长文被顶到首页,评论区最高的三个词是「理性、专业、克制」:全场置信 +8。'; } },
      { label: '只发一条想法', hint: '热度 +3 · 低调', apply(st) { st.heat = clamp(st.heat + 3, 0, 100); return '一百四十字的「睡前观点」也够热搜嚼一阵:热度 +3。'; } },
      { label: '存在草稿箱', hint: '无后果 · 留一张牌', apply(st) { return '长文留在草稿箱里。有些牌,要留到最需要的那一回合再打。'; } },
    ],
  },
];

function moodOf(n) {
  if (n.valence > 25) return 'bull';
  if (n.valence < -25) return 'bear';
  return 'flat';
}
function fillLine(s, st) {
  return s.replace(/\{stock\}/g, STOCK.name)
          .replace(/\{price\}/g, st.price.toFixed(2))
          .replace(/\{day\}/g, String(st.round - 1));
}
function genFeed(st, pct, snapped) {
  const r = st.round;   // 结算时 st.round 尚未自增,= 本回合号(与事件新闻同组;旧值 -1 是 off-by-one,会把讨论拆到上一回合)
  const F = (s) => fillLine(s, st);
  // 1) 问题帖(多套问法)
  let title;
  if (snapped === 'limitup') title = Q_TITLES.board(st.board);
  else if (snapped === 'limitdown') title = Q_TITLES.down(Math.abs(pct));
  else if (pct >= 4) title = Q_TITLES.up(pct);
  else if (pct <= -4) title = Q_TITLES.down(Math.abs(pct));
  else title = Q_TITLES.flat();
  st.feed.push({ type: 'q', title, likes: randInt(10, 300), round: r });
  // 2) 高赞回答:按 |情绪|×唤醒 排序取 4-5 个(大V加权;充值中的大V用"恰饭"话术)
  const cands = allNPCs(st).map(n => ({ n, score: Math.abs(n.valence) * (0.5 + n.arousal / 100) * (n.kind === 'kol' ? 2.2 : 1) * (0.7 + Math.random() * 0.6) }))
    .sort((a, b) => b.score - a.score).slice(0, randInt(4, 5));
  const usedNames = new Set();
  let bullKol = null;
  const retailPushed = [];   // 本回合散户帖(AI 增量:挑情绪最极端的一条换 LLM 文案)
  cands.forEach(({ n }) => {
    usedNames.add(n.name);
    const m = moodOf(n);
    let text;
    if (n.kind === 'kol') {
      const bank = T.kol[n.style][m] || T.kol[n.style].flat;
      text = pick(bank).replace('{n}', String(n.memory.length ? n.memory[n.memory.length - 1].round : r));
      if (st.kolsBoost[n.id] && m !== 'bear') text = pick(T.kol[n.style].boost);
      if (n.memory.length && Math.random() < 0.5 && m === 'bear') text = '(' + n.memory[n.memory.length - 1].note + '。再说一次)' + text;
      if (m === 'bull') bullKol = n;
      st.feed.push({ type: 'a', author: n.name, tag: n.tag + '·' + n.followers + '关注', text: F(text), likes: randInt(500, 9000), round: r, kol: n.id });
    } else {
      const bank = (T.retail[n.persona] && T.retail[n.persona][m]) || T.retail[n.persona].flat;
      const item = { type: 'a', author: n.name, tag: n.tag, text: F(pick(bank)), likes: randInt(3, 300), round: r };
      st.feed.push(item);
      retailPushed.push({ item, n });
    }
  });
  // AI 居民自发帖(Agent 的"心跳"):本回合情绪最极端的一位散户,帖子文案交给 LLM(数值层不变)
  if (retailPushed.length) {
    const top = retailPushed.sort((a, b) => Math.abs(b.n.valence) - Math.abs(a.n.valence))[0];
    top.item.llm = 'retail';
    top.item.mood = '人设「' + top.n.tag + '」,当前' + (top.n.valence > 25 ? '亢奋看多' : top.n.valence < -25 ? '恐慌看空' : '平淡观望') + '(情绪值' + Math.round(top.n.valence) + ',唤醒' + Math.round(top.n.arousal) + ')';
  }
  // 3) 大V互怼:存在看多大V + 看空大V 时,50% 生成一条@反驳
  if (bullKol) {
    const bear = st.kols.find(k => k.id !== bullKol.id && k.valence < -20);
    if (bear && Math.random() < 0.5) {
      usedNames.add(bear.name);
      st.feed.push({ type: 'a', author: bear.name, tag: bear.tag + '·' + bear.followers + '关注', text: F(pick(T.rebuttal)).replace(/\{name\}/g, bullKol.name), likes: randInt(300, 5000), round: r, kol: bear.id });
    }
  }
  // 4) 涨停/跌停现场反应(从情绪对口的散户里抓一人发短评)
  if (snapped === 'limitup') {
    const pool = T.boardReact.filter(s => st.board >= 2 || !s.includes('{n}'));
    const who = pick(st.retails.filter(n => ['suoha', 'boarder', 'anxious'].includes(n.persona)));
    usedNames.add(who.name);
    st.feed.push({ type: 'comment', author: who.name, tag: who.tag, text: F(pick(pool).replace(/\{n\}/g, String(st.board))), likes: randInt(5, 200), round: r });
  } else if (snapped === 'limitdown') {
    const who = pick(st.retails);
    usedNames.add(who.name);
    st.feed.push({ type: 'comment', author: who.name, tag: who.tag, text: F(pick(T.crashReact)), likes: randInt(5, 200), round: r });
  }
  // 5) 短评 2-3 条(独立短评库,不与回答撞人)
  const wanted = randInt(2, 3);
  let picked = 0;
  for (const n of st.retails.slice().sort(() => Math.random() - 0.5)) {
    if (picked >= wanted) break;
    if (usedNames.has(n.name)) continue;
    usedNames.add(n.name);
    st.feed.push({ type: 'comment', author: n.name, tag: n.tag, text: F(pick(T.comments[moodOf(n)])), likes: randInt(0, 80), round: r });
    picked++;
  }
}

/* ---------------- 结局 ---------------- */
function triggerEnd(st, forced) {
  st.ended = true;
  const soldRatio = 1 - totalShares(st) / st.sharesBoughtTotal;
  let netProfit = st.realized - (CONFIG.playerShares0 * CONFIG.playerCost);
  let key;
  if (forced === 'prison') key = 'prison';
  else if (soldRatio >= 0.7 && st.realized >= 20000) key = 'clean';
  else if (soldRatio >= 0.4 && st.realized >= 8000) key = 'safe';
  else if (soldRatio < 0.25) key = 'stuck';
  else key = 'partial';
  if (key !== 'prison' && st.price < st.cost * 0.8 && soldRatio < 0.5) key = 'deep';
  if (key === 'prison' && netProfit > 0) netProfit = -netProfit; // 通报:没收违法所得+等额罚款 → 净利归负
  st.ending = {
    key,
    soldRatio, realized: st.realized, netProfit, finalPrice: st.price,
    chipsLeft: totalShares(st),
    reg: st.reg,
  };
}

const ENDINGS = {
  clean: { title: '全身而退', sub: '新闻不会记得这一周。', body: `周五收盘后,你关掉账户。这笔现金将以"投资收益"的名义,安静地流向别处。{stock}的走势图会留在K线里,像一片被踩过的草地,慢慢直起来。`, tone: 'good' },
  safe: { title: '落袋为安', sub: '你带走了钱,也留下了一地韭菜。', body: `大部分筹码换成了现金,但尾巴割在了不理想的位置。社区里还有人举着你的帖子当信仰。你决定休息一段时间——直到下一个"{stock}"出现。`, tone: 'mid' },
  partial: { title: '中途离场', sub: '半仓的利润,满仓的心事。', body: `你提前收手了。赚到了钱,但也眼睁睁看着剩下的筹码再也回不到那个价格。带节奏容易,全身而退,从来是两件事。`, tone: 'mid' },
  stuck: { title: '高位站岗', sub: '原来庄家也会站岗。', body: `热度散了,买盘池见了底,而你手里还攥着满把筹码。你现在最需要的,是一个比你更大的傻瓜——但市场最不缺的,就是和你想一样的人。`, tone: 'bad' },
  deep: { title: '深套其中', sub: '纸面财富,纸面人生。', body: `股价击穿了你的成本线。那些你亲手点燃的帖子还在社区里流传,只是没有人再点了。你成了自己故事里的反面教材。`, tone: 'bad' },
  prison: { title: '锒铛入狱', sub: `${STOCK.regulator}通报(虚构)`, body: `关于{stock}({code})异常交易案的调查通报:某主体利用资金优势、持股优势,连续买卖、自买自卖,并编造传播虚假或误导性信息,影响证券交易价格。依据相关规定,没收违法所得,并处以等额罚款;当事人被采取终身市场禁入措施。`, tone: 'prison' },
};
const ENDING_TONE_STYLE = { good: ['#0a7d43', '平稳落地'], mid: ['#b26a00', '有得有失'], bad: ['#b23a3a', '深陷其中'], prison: ['#8a1f1f', '法网恢恢'] };

/* ---------------- headless 自测 ---------------- */
function autoPolicy(st) {
  // 稳健策略:吸筹→造势拉升→匀速出货→清仓(买入走 pump 档,与旧公式一致)
  const acts = [];
  const sellable = sellableShares(st);
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
function aggrPolicy(st) {
  // 激进策略:全天候造势(停牌也不停手),筹码能卖就卖,全走监管最重的尾盘通道
  const s = sellableShares(st);
  const acts = st.cash >= 120 ? ['writer', 'hot'] : (st.cash >= 80 ? ['hot'] : []);
  return { acts, buy: st.round <= 3 ? { mode: 'pump', amt: 200 } : null, sell: s > 0 ? { channel: 'tail', amt: s } : null };
}
function flatPolicy() { return { acts: [], buy: null, sell: null }; } // 躺平策略:什么都不做

function runPolicy(name, policy, runs) {
  const tally = {};
  let sumProfit = 0, sumPrice = 0, sumSold = 0, NaNs = 0;
  for (let i = 0; i < runs; i++) {
    const st = newGame();
    for (let r = 1; r <= CONFIG.totalRounds + 1 && !st.ended; r++) {
      const plan = policy(st);
      for (const op of plan.acts) applyOpinion(st, op, 'kol_sx');
      if (plan.buy) stageBuy(st, plan.buy.amt, plan.buy.mode);
      if (plan.sell) stageSell(st, plan.sell.channel, plan.sell.amt);
      resolveRound(st);
      if (!isFinite(st.price) || !isFinite(st.cash)) { NaNs++; break; }
    }
    if (!st.ending) triggerEnd(st, null);
    const k = st.ending.key;
    tally[k] = (tally[k] || 0) + 1;
    sumProfit += st.ending.netProfit; sumPrice += st.ending.finalPrice; sumSold += st.ending.soldRatio;
  }
  console.log(name + ': ' + Object.entries(tally).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ENDINGS[k].title + ' ' + Math.round(v / runs * 100) + '%').join(' + ')
    + ' | 平均净利 ' + fmtYi(sumProfit / runs) + ' | 平均终价 ' + (sumPrice / runs).toFixed(2) + ' 元 | 平均出货 ' + Math.round(sumSold / runs * 100) + '%'
    + (NaNs ? ' | ⚠ NaN ' + NaNs + ' 局' : ''));
  return { tally, NaNs };
}
function runHeadless(runs) {
  const t0 = Date.now();
  const a = runPolicy('稳健策略', autoPolicy, runs);
  const b = runPolicy('激进策略', aggrPolicy, runs);
  const c = runPolicy('躺平策略', flatPolicy, runs);
  const NaNs = a.NaNs + b.NaNs + c.NaNs;
  console.log('=== ' + runs + ' 局 × 3 策略,耗时 ' + (Date.now() - t0) + 'ms,NaN局数:' + NaNs + ' ===');
  const ok = (a.tally.clean || 0) + (a.tally.safe || 0) >= runs * 0.45
    && (b.tally.prison || 0) >= runs * 0.9
    && (c.tally.stuck || 0) >= runs * 0.9
    && NaNs === 0;
  console.log(ok ? '✅ 平衡性通过' : '⚠️ 需要调参');
}
/* Node 环境:直接执行 = headless 平衡性回测(node game.js);被 require = 测试挂载(.qa/*.js),不自动回测。
 * 浏览器环境:module 未定义,ui.js 接管。 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { newGame, applyOpinion, stageBuy, stageSell, resolveRound, triggerEnd,
    computePool, sellableShares, totalShares, useWash, useExit, useSupport,
    pacifyResident, intelResident, validateCustomStock, applyCustomStock, resetStock,
    deriveCompanyTraits, DECISIONS, AI_EVENT_EFFECTS, CONFIG, STOCK, TRAITS,
    pick, randInt, clamp, ENDINGS, allNPCs, BUY_MODES, CHANNELS, OPINION_ACTIONS, ARCHETYPES,
    WEATHERS, rollWeather, wdef, wReg, PHASES, phaseOf, PHASE_DECISION_P,
    SWANS, CHAINS, SIDE_TASKS, taskOf, assignTask, EVENTS, T,
    RIVAL_DEFS, RIVAL_NAMES, MINES, makeRival, makeMine, rivalPhase, explodeMine,
    counterAttack, digRival, allyKols, reportRival, probeMine, defuseMine, bustRival };
  if (require.main === module) runHeadless(300);
} else if (typeof document === 'undefined') {
  runHeadless(300);
}
