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
  if (blurb.length > 100) return { error: '公司介绍不能超过 100 字' };
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
  hardtech:   { name: '硬科技赛道', kw: ['ai', '智能', '机器人', '芯片', '量子', '脑机', '半导体', '航天', '核聚', '算法', '大模型', '无人', '卫星'], heatMul: 1.12, regMul: 1.10, desc: '热度易燃:舆论热度获取 +12%;风口瞩目:舆论监管代价 +10%' },
  livelihood: { name: '民生消费', kw: ['食品', '餐饮', '农业', '医疗', '养老', '教育', '母婴', '健身', '奶茶', '超市', '外卖'], clarifyBonus: 4, negMul: 1.15, desc: '口碑敏感:负面情绪冲击 ×1.15;但「澄清」降温 +25%(额外 -4 热度)' },
  entertain:  { name: '泛娱乐文旅', kw: ['游戏', '娱乐', '影视', '文旅', '旅游', '社交', '直播', '潮玩', '音乐', '电竞'], arousalMul: 1.15, heatDecayAdd: 2, desc: '情绪放大器:舆论唤醒效果 +15%;但热度烧得快(每回合额外衰减 2)' },
  industrial: { name: '重资产制造', kw: ['电池', '材料', '钢铁', '能源', '汽车', '化工', '装备', '光伏', '工程机械'], poolBonus: 1.06, heatMul: 0.92, desc: '基本盘扎实:基础买盘池 +6%;题材保守:舆论热度获取 -8%' },
  biotech:    { name: '生物医药', kw: ['基因', '生物', '医药', '疫苗', '疗法', '临床', '制药'], writerSafe: true, mediaFragile: true, desc: '故事动人:写手识破率 25%→15%;经不起质疑:媒体质疑事件杀伤翻倍' },
  diversified:{ name: '综合业务', kw: [], desc: '业务多元,无明显赛道倾向' },
};
const BLURB_TONES = [
  { id: 'capital', kw: ['融资', '轮', '估值', '独角兽', '上市', '券商', '路演', '对赌'], name: '资本故事', desc: '赌徒爱听故事:梭哈/从众型居民初始情绪 +6,价值型 -4' },
  { id: 'tech',    kw: ['专利', '技术', '研发', '实验室', '博士', '论文', '首席', '工程'], name: '技术立司', desc: '专业背书:价值/冷嘲型初始置信 +5;新人更谨慎:学生置信 -3' },
  { id: 'warm',    kw: ['用户', '家庭', '生活', '普惠', '平价', '每个人', '美好', '陪伴'], name: '亲民叙事', desc: '天然好感:大学生新股民初始情绪 +6、置信 +4' },
];
const TONE_SPECIAL = {
  mystery:  { name: '低调神秘', desc: '没料可扒:媒体质疑事件概率减半;初始热度 -3', mediaHalf: true, heat0: -3 },
  overwrap: { name: '过度包装', desc: '话说太满:全体居民初始置信 -3;但话题十足,初始热度 +4', heat0: 4, conf0: -3 },
};
function deriveCompanyTraits(name, topic, blurb) {
  const hay = (String(topic) + ' ' + String(name)).toLowerCase();
  const arch = Object.keys(ARCHETYPES).find(id => id !== 'diversified' && ARCHETYPES[id].kw.some(k => hay.includes(k))) || 'diversified';
  const b = String(blurb || '').trim();
  const kwTone = BLURB_TONES.find(t => t.kw.some(k => b.includes(k)));
  const tone = kwTone ? kwTone.id : (b.length >= 85 ? 'overwrap' : (b.length > 0 && b.length < 20 ? 'mystery' : null));
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

function cnNum(n) { return '一二三四五六七八九十'[Math.min(n - 1, 9)]; }
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
  ],
  astroturfQ: [`{stock}现在还能上车吗?`,`如何评价新手第一次买{stock}?`,`{stock}的长期逻辑是什么?`,`新手第一只票选{stock}合适吗?`,`{stock}拿到年底能翻倍吗?`,`定投{stock}靠谱吗?`],
  astroturfA: ['刚入不久,说说体验:节奏很稳,拿得住。','长线逻辑清晰,短线有资金关照,这种票不多见。','别问,问就是格局。','已经拿到不少了,无惧波动。','这票我拿了一年,越来越有底。','别人恐惧我贪婪,仅供参考。'],
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
  skepticPosts: ['都在喊多,谁在买单?挂单簿不会说谎。','涨成这样,基本面跟得上吗?话我放这儿了。','这种走势我见过太多次——最后接棒的人,已经在排队了。','提醒一句:热度不等于价值。等潮水退了再看。','评论区整齐划一的时候,恰恰最危险。独立思考,勿谓言之不预。'],
  /* 横盘闲聊(随机事件"chat":没有大动作的回合,生态也有心跳) */
  idleChat: ['横好几天了,庄家是在等我先下车?','这量能,主力还在吗?在线等,挺急的。','每日打卡:今天依然没动静。','薛定谔的主力——你不看盘它就横,你一割它就拉。','横久必涨还是横久必跌?评论区吵了三百楼。','挂单价一分没动,我的心态先动了。','这票现在是真正意义上的"风景线"。'],
  /* 大V互怼 */
  rebuttal: ['@{name} 你知不知道你这句话害了多少人?','@{name} 又是你,上次喊单的帖子删得倒是快。','@{name} 立场可以变,麻烦把持仓截图放出来再喊。','@{name} 看空可以,先标注一下你的仓位再说。'],
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

/* 随机市场事件池:政策面/宏观面/同行面/消费面 + 传闻两段式。文本见 T.market */
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
  { key: 'rumor', w: 2 },
  { key: 'none', w: 6 },
];

const VACCINES = [
  { key: 'writer', name: '离职员工自述体', real: '「前员工爆料帖」:身份无法验证,发布时间恰与行情共振,细节煽情但不可查证。', tip: '看到"内部人士"爆料,先查账号历史与发帖时机。' },
  { key: 'hot', name: '买热搜', real: '热搜榜是可以被购买的。突然爆榜、无信源、评论区整齐划一,都是信号。', tip: '热搜 ≠ 真实关注度,先找原始信源。' },
  { key: 'kol', name: '充值大V喊单', real: '「恰饭喊单」:大V立场可以与收益挂钩,且不必向你披露。', tip: '关注大V是否披露利益关系,历史立场是否反复横跳。' },
  { key: 'astroturf', name: '自问自答造势', real: '马甲账号提问+马甲回答,制造"大家都在买"的氛围。', tip: '看回答账号的注册时间与提问-回答时间差。' },
  { key: 'post', name: '亲自带节奏', real: '情绪化短帖是成本最低的引导工具,常成批出现。', tip: '同一话术反复出现时,警惕有组织的引导。' },
  { key: 'wash', name: '对倒放量', real: '「虚假放量」:自买自卖制造成交活跃的假象,让盘面看起来"有资金进场"。', tip: '放量要看真实性:只有量能异动、却找不到对应消息与成交分布的"活跃",多半是演的。' },
];

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
    decisions: 0, usedDecisions: [], pendingDecision: null,
    aiEvents: 0,           // 本局已生成的 AI 抉择事件数(上限 2)
    rumorPending: null,    // 传闻两段式:{left:剩余回合, good:是否坐实}
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
  // 公司基因·简介风格:开局民意底色(同一套设定 → 同一批初始居民,确定性)
  const g0 = ctrait();
  if (g0.tone === 'capital') st.retails.forEach(n => { if (n.persona === 'suoha' || n.persona === 'herd') n.valence = clamp(n.valence + 6, -100, 100); else if (n.persona === 'value') n.valence = clamp(n.valence - 4, -100, 100); });
  if (g0.tone === 'tech') st.retails.forEach(n => { if (n.persona === 'value' || n.persona === 'sarcasm') n.confidence = clamp(n.confidence + 5, 0, 100); else if (n.persona === 'student') n.confidence = clamp(n.confidence - 3, 0, 100); });
  if (g0.tone === 'warm') st.retails.forEach(n => { if (n.persona === 'student') { n.valence = clamp(n.valence + 6, -100, 100); n.confidence = clamp(n.confidence + 4, 0, 100); } });
  const td0 = toneDefOf(g0);
  if (td0 && td0.conf0) allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence + td0.conf0, 0, 100); });
  if (td0 && td0.heat0) st.heat = Math.max(0, st.heat + td0.heat0);
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
  const wash = st.washNext ? 1.35 : 1;          // 对倒放量:本回合买盘池虚增
  const boost = st.poolBoostNext || 1;          // 抉择事件/宏观事件带来的下一回合买盘增益
  const doubt = st.doubtNext || 1;              // 质疑声量:社区反抗时买盘池打折
  const pool = CONFIG.basePool * gene * heatF * sentF * priceF * shock * buyback * wash * boost * doubt;
  return { pool, heatF, sentF, priceF, shock };
}

/* ---------------- 舆论行动 ---------------- */
function applyOpinion(st, key, kolId, angle) {
  const act = OPINION_ACTIONS[key];
  // 免费动作(发帖/自答)不受负现金锁死:它们是玩家仅剩的自救声量(与 ui.js renderActions 一致)
  if (st.ap < act.ap || (act.cost > 0 && st.cash < act.cost)) return { ok: false };
  st.ap -= act.ap; st.cash -= act.cost; st.usedTactics[key] = true;
  // 免疫机制:同一话术连用,情绪/热度效果递减(每次 -15%,下限 ×0.55;澄清是降温动作不递减)
  const imm = tacticImm(st, key);
  if (key !== 'clarify') st.tacticUses[key] = (st.tacticUses[key] || 0) + 1;
  // 只夹下限:监管溢出 100 的部分要保留(结算顺序是先衰减再判 ≥100,夹上限会破坏入狱机制)
  // 公司基因:赛道决定舆论的监管代价(硬科技 +10%)与热度获取(硬科技 +12% / 重资产 -8%)
  st.reg = Math.max(0, st.reg + act.reg * regMul(st));
  const HY = st.trait === 'hype' ? 1.3 : 1;   // 流量操盘手:情绪影响 +30%
  const AM = ARCHETYPES[ctrait().arch].arousalMul || 1;   // 泛娱乐:唤醒效果 +15%
  const HM = heatMul(st);
  const affected = [];
  const record = (npc, dv) => affected.push({ name: npc.name, tag: npc.tag, dv: Math.round(dv) });
  let label = act.name, headline = '';
  const applyAll = (dv, ar) => allNPCs(st).forEach(n => { n.valence = clamp(n.valence + dv * HY, -100, 100); n.arousal = clamp(n.arousal + (ar || 0) * AM, 0, 100); });

  if (key === 'post') {
    // 发帖三角度:缺省 hype 与历史数值完全一致(headless 三策略基线不变)
    const ang = POST_ANGLES[angle] || POST_ANGLES.hype;
    applyAll(rand(ang.dv[0], ang.dv[1]) * imm, ang.arousal * imm);
    if (ang.conf) allNPCs(st).forEach(n => n.confidence = clamp(n.confidence + ang.conf * imm, 0, 100));
    st.heat += ang.heat * imm * HM;
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
    applyAll(rand(2, 5) * imm, 12 * imm); st.heat += 22 * imm * HM;
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
    allNPCs(st).forEach(n => {
      const dv = (PERSONA_META[n.persona] && PERSONA_META[n.persona].suggestible ? rand(9, 14) : (n.kind === 'kol' ? rand(0, 4) : rand(2, 6))) * HY * imm;
      n.valence = clamp(n.valence + dv, -100, 100); n.arousal = clamp(n.arousal + 6 * imm * AM, 0, 100);
      record(n, dv);
    });
    st.heat += 12 * imm * HM;
    st.feed.push({ type: 'writer', author: '匿名用户', tag: '深度·软文' + (w.styleTag ? '·' + w.styleTag : ''), title: fillStock(w.title), text: fillStock(w.body), attr: w.attr || '', likes: randInt(200, 3000), round: st.round, llm: 'writer' });
    headline = '《' + fillStock(w.title) + '》发布,社区开始转发。';
    if (Math.random() < (st.trait === 'insider' ? 0.125 : 0.25) * (ctrait().arch === 'biotech' ? 0.6 : 1)) { // 被举报(消息灵通:概率减半;生物医药:故事可信 25%→15%)
      st.reg += 16; st.heat += 5;
      allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 8, 0, 100));
      st.feed.push({ type: 'news', tag: '辟谣', title: '账号质疑', text: '有用户扒出软文作者账号为 3 天新注册,发布时间与股价异动高度同步。部分读者表示"先不信了"。', likes: randInt(50, 400), round: st.round });
      headline += ' ⚠ 被用户识破举报,' + STOCK.regulator + '已关注。';
    }
  } else if (key === 'kol') {
    const kol = st.kols.find(k => k.id === kolId) || pick(st.kols);
    st.kolsBoost[kol.id] = 2;
    kol.valence = clamp(Math.max(kol.valence, 80), -100, 100);
    allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 8 * HY * imm, -100, 100); record(n, 8 * HY * imm); });
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
    st.heat = Math.max(0, st.heat - 15 - (ARCHETYPES[ctrait().arch].clarifyBonus || 0));  // 民生消费:澄清更有公信力
    allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal - 8, 0, 100); n.valence = clamp(n.valence - 2 * HY, -100, 100); record(n, -2 * HY); });
    headline = '你发布公告并召开投资者说明会:「一切信息以公告为准」。监管关注度 -10,热度 -15,市场热度降下来了。';
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
  amt = Math.max(0, Math.min(amt, mode.max, Math.floor(st.cash / st.price)));
  st.pendingBuy = { amt, mode: mode.id };
  return amt;
}
function stageSell(st, channel, amt) {
  const s = sellableShares(st);
  st.pendingSell = { channel, amt: Math.min(amt, s) };
  return st.pendingSell.amt;
}

/* ---------------- 回合结算 ---------------- */
function resolveRound(st) {
  const r0 = st.round;
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
      const amt = n.shares * (0.2 + n.arousal / 250);
      n.shares -= amt; panicSell += amt;
    }
  });
  const effPool = Math.max(120, poolBase + retailBuy);
  const sellPressure = Math.max(0, -retailBuy) + panicSell * 0.15;

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
      if (mode.regRule === 'big150') { if (bought > 150) st.reg += 5; }
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
    st.reg += ch.reg * (st.exitNext ? 0.5 : 1);
    const leakP = Math.max(0, ch.leak - (dk ? 0.10 : 0)) * (st.exitNext ? 0.5 : 1);
    if (leakP > 0 && Math.random() < leakP) {
      st.reg += (ch === CHANNELS.block ? 10 : 8) * (st.exitNext ? 0.5 : 1);
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
    const panic = sellPressure / (effPool + 350) * 0.5;
    const drift = avgValence(st) / 100 * 0.02            // 全场看多→温和上行(±2%)
      + (st.heat - 40) / 100 * 0.01                      // 热度是燃料(±0.6%)
      - Math.max(0, st.reg - 55) / 100 * 0.015           // 监管>55 后开始压制估值
      + rand(-0.018, 0.022);                             // 市场噪声(略偏多:资金博弈)
    chg = (1 - panic) * (1 + clamp(drift, -0.05, 0.05)) - 1;
  } else {
    chg = (1 + buyImpact) * (1 - (sold > 0 ? (sold + sellPressure) / (effPool + 350) * usedCh.impact * 1.2 : sellPressure / (effPool + 350) * 0.5)) - 1;
  }
  if (st.heat < 30) chg = Math.min(chg, 0.06); // 无人气拉不动
  let snapped = '';
  if (chg >= 0.07) { chg = 0.10; snapped = 'limitup'; }
  if (chg <= -0.07) { chg = -0.10; snapped = 'limitdown'; }
  chg = clamp(chg, -0.10, 0.10);
  const open = st.price;
  st.price = Math.max(0.5, st.price * (1 + chg));
  const pct = Math.round(chg * 1000) / 10;
  // 连板
  const prevBoard = st.board;
  if (snapped === 'limitup') { st.board += 1; st.reg += 4 + 2 * st.board; st.heat += 8 + 3 * Math.min(st.board, 6); if (st.board >= 2) allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 5 + st.board, -100, 100); n.arousal = clamp(n.arousal + 6, 0, 100); }); }
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
  const mediaW = ctrait().tone === 'mystery' ? 1 : 2;   // 低调神秘:简介没料可扒,媒体质疑概率减半
  const evPool = (st.mediaSuppressed ? EVENTS.filter(e => e.key !== 'media_q') : EVENTS)
    .map(e => ({ w: e.key === 'media_q' ? mediaW : e.w, v: e.key }));
  // 横盘回合(|涨跌|<4):压低"无事发生"的概率,加入散户闲聊,生态不打烊
  if (Math.abs(pct) < 4) {
    const noEv = evPool.find(e => e.v === 'none');
    if (noEv) noEv.w = 3;
    evPool.push({ w: 2, v: 'chat' });
  }
  const evKey = pickWeighted(evPool);
  // 负面情绪的赛道系数(民生消费:坏消息传得更快)
  const mv = (dv) => { const m2 = dv < 0 ? negMul(st) : 1; allNPCs(st).forEach(n => { n.valence = clamp(n.valence + dv * m2, -100, 100); }); };
  const pushNews = (tag, title, body, tagCls, likes) => st.feed.push({ type: 'news', tag, title, text: fillStock(body), likes: likes || randInt(100, 900), round: r0, tagCls });
  if (evKey === 'sector_up') { mv(8); st.heat += 10; pushNews('行业', T.news.sector_up.title, T.news.sector_up.body); }
  else if (evKey === 'market_drop') { mv(-10); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 8, 0, 100); }); st.feed.push({ type: 'news', tag: '大盘', title: T.news.market_drop.title, text: T.news.market_drop.body, likes: randInt(100, 900), round: r0 }); }
  else if (evKey === 'media_q') {
    const fragile = ctrait().arch === 'biotech';   // 生物医药:经不起质疑
    allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - (fragile ? 16 : 10), 0, 100); });
    st.heat -= 5; st.reg += fragile ? 9 : 5;
    pushNews('媒体', T.news.media_q.title, T.news.media_q.body, null, randInt(200, 1200));
  }
  else if (evKey === 'fight') { allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 12, 0, 100); }); st.heat += 6; pushNews('社区', T.news.fight.title, T.news.fight.body, null, randInt(50, 500)); }
  else if (evKey === 'policy_tight') { mv(-4); st.heat = Math.max(0, st.heat - 8); st.reg += 5; pushNews('政策', '监管新规', T.market.policy_tight.body, 't-pol'); }
  else if (evKey === 'policy_ease') { mv(6); st.heat = clamp(st.heat + 8, 0, 100); st.poolBoostNext = Math.max(st.poolBoostNext || 1, 1.05); pushNews('政策', '产业利好', T.market.policy_ease.body, 't-pol'); }
  else if (evKey === 'rate_ease') { mv(5); st.poolBoostNext = Math.max(st.poolBoostNext || 1, 1.10); pushNews('宏观', '流动性宽松', T.market.rate_ease.body, 't-mac'); }
  else if (evKey === 'rate_tight') { mv(-5); st.poolBoostNext = Math.min(st.poolBoostNext || 1, 0.90); pushNews('宏观', '流动性收紧', T.market.rate_tight.body, 't-mac'); }
  else if (evKey === 'rival_launch') { mv(-5); allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 5, 0, 100); }); st.heat = Math.max(0, st.heat - 4); pushNews('同行', '竞品发布', T.market.rival_launch.body, 't-riv'); }
  else if (evKey === 'rival_fail') { mv(6); st.heat = clamp(st.heat + 5, 0, 100); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 6, 0, 100); }); pushNews('同行', '竞对爆雷', T.market.rival_fail.body, 't-riv'); }
  else if (evKey === 'supply') { mv(-3); allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 5, 0, 100); }); st.heat = clamp(st.heat + 3, 0, 100); pushNews('同行', '供应链承压', T.market.supply.body, 't-riv'); }
  else if (evKey === 'viral') { mv(5); st.heat = clamp(st.heat + 10, 0, 100); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 8, 0, 100); }); pushNews('消费', '产品出圈', T.market.viral.body, 't-con'); }
  else if (evKey === 'boycott') { mv(-7); st.heat = clamp(st.heat + 6, 0, 100); st.reg += 3; pushNews('消费', '消费者质疑', T.market.boycott.body, 't-con'); }
  else if (evKey === 'celebrity') { mv(3); st.heat = clamp(st.heat + 6, 0, 100); allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 10, 0, 100); }); pushNews('消费', '主播带货', T.market.celebrity.body, 't-con'); }
  else if (evKey === 'rumor') {
    const r = pick(T.rumors);
    st.rumorPending = { left: randInt(1, 2), good: r.good };
    pushNews('传闻', '传闻四起', r.text, 't-rum', randInt(300, 1800));
  }
  else if (evKey === 'chat') {
    st.heat = clamp(st.heat + 2, 0, 100);
    allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 3, 0, 100); });
    const who = pick(st.retails);
    st.feed.push({ type: 'comment', author: who.name, tag: who.tag, text: pick(T.idleChat), likes: randInt(2, 60), round: r0 });
  }

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
      st.feed.push({ type: 'comment', author: who.name, tag: who.tag, text: '昨天那个传闻到底真假?在线等,挺急的。', likes: randInt(5, 80), round: r0 });
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

  // 监管衰减与阈值(泛娱乐赛道:热度烧得快,额外 -2)
  st.heat = clamp(st.heat - CONFIG.heatDecay - (ARCHETYPES[ctrait().arch].heatDecayAdd || 0), 0, 100);
  st.reg = clamp(st.reg - CONFIG.regDecay, 0, 100);
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
    }
  }
  st.doubtCalm = false;

  // 监管阈值事件
  st.tips = [];
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
  // 现金为负:只提醒一次,把自救手段讲清楚(买入挂单在上游已按现金夹紧,这里是最后防线)
  if (st.cash < 0 && !st.debtWarned) {
    st.debtWarned = true;
    st.tips.push('⚠ 资金链紧张:现金为负,花钱的动作已被锁定——「集中竞价出货」回笼现金是唯一自救手段,免费的「发帖/自答」仍可用。');
  }
  // 抉择事件:第 4 回合起小概率出现,每局至多 2 次(停牌中也会出现——正好是处理麻烦的时候)
  if (!st.ended && r0 >= 4 && !st.pendingDecision && st.decisions < 2 && Math.random() < 0.14) {
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

function inquiryAt(st) { return st.trait === 'calm' ? 40 : 35; }
function haltAt(st) { return st.trait === 'calm' ? 65 : 60; }

/* ---------------- 暗盘大招(每局一次) ---------------- */
function useWash(st) {
  if (!st.skills.wash) return { ok: false, msg: '对倒放量已经用过了(每局一次)' };
  if (st.halted) return { ok: false, msg: '停牌期间无法操作' };
  if (st.cash < 800) return { ok: false, msg: '需要 800 万现金自买自卖' };
  st.cash -= 800; st.skills.wash = false; st.washNext = true;
  st.heat = clamp(st.heat + 18, 0, 100);
  allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 10, -100, 100); n.arousal = clamp(n.arousal + 10, 0, 100); });
  // 只夹下限:与 applyOpinion 同一原则——监管溢出 100 的部分要保留,否则满格前夜的对倒会白喂(结算先衰减再判 ≥100)
  st.reg = Math.max(0, st.reg + 14);
  st.usedTactics.wash = true;
  return { ok: true, msg: '对倒放量启动:虚假成交制造抢筹假象——本回合买盘池 +35%,热度 +18,监管 +14' };
}
function useExit(st) {
  if (!st.skills.exit) return { ok: false, msg: '金蝉脱壳已经用过了(每局一次)' };
  if (st.halted) return { ok: false, msg: '停牌期间无法操作' };
  if (st.pendingSell) return { ok: false, msg: '已有卖出挂单,先取消再使用' };
  st.skills.exit = false; st.exitNext = true;
  return { ok: true, msg: '金蝉脱壳就绪:本回合挂出的卖单,冲击/折价/监管全部减半' };
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
  const r = st.round - 1;
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
if (typeof document === 'undefined') {
  runHeadless(300);
} else {
  // 浏览器环境:ui.js 接管
}
