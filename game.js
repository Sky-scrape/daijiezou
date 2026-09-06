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
const STOCK = { name: '星阑科技', code: '888217', topic: 'AI 烹饪机器人', exchange: '云端证券交易所', regulator: '交易所监察部' };

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
    { title: `我在${STOCK.name}这三年`, body: `3 年前我入职${STOCK.name},参与过${STOCK.topic}项目的落地。公司内部远比外界想象的激进——下个季度的产品发布会,会讲一个"改变行业"的故事。离开是我自己的选择,但有些价值,市场还没有看懂。利益相关:已不持有该公司股票(真的吗?)。` },
    { title: `从${STOCK.name}离职后,我想说几句实话`, body: `看到最近的行情,忍不住说两句。内部人士都知道,公司手上有牌,只是还没到打出来的时间。那些喊着"庄股"的人,并不了解这家公司的执行力。以上。` },
    { title: `深度体验过${STOCK.topic}后,我理解了${STOCK.name}的野心`, body: `朋友送了我一台内测机。用了一周,我退还了某大厂的 offer——方向和执行力,差距是肉眼可见的。资本市场短期是投票机,长期是称重机,而它的重量,还没被称出来。` },
    { title: `楼下大爷都在聊${STOCK.name},我有点慌`, body: `（故事体）我在小区门口修了二十年自行车。这个月,问我${STOCK.name}的人比问我车胎的多十倍。上一次这么热闹的时候,是另一家公司的顶点。` },
    { title: `供应商眼里的${STOCK.name}`, body: `（深度体）我们给它供应核心部件三年,回款从来不拖。坊间都说它资金链紧张——可我们财务说,这季度订单加了一半。信谁,你自己判断。` },
    { title: `一个普通人的${STOCK.name}观察日记`, body: `（日记体）第 1 天,留意到它。第 9 天,同事全在讨论。第 15 天,我妈问我要不要买。今天我把这些写下来,留给三个月后的自己。` },
  ],
  astroturfQ: [`${STOCK.name}现在还能上车吗?`,`如何评价新手第一次买${STOCK.name}?`,`${STOCK.name}的长期逻辑是什么?`,`新手第一只票选${STOCK.name}合适吗?`,`${STOCK.name}拿到年底能翻倍吗?`,`定投${STOCK.name}靠谱吗?`],
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
    sector_up: { title: '行业利好', body: '虚拟世界博览会开幕,「智能厨房」概念全线走强,${stock}所在的云端交易所板块资金流入明显。' },
    market_drop: { title: '大盘跳水', body: '云端综指午后跳水,题材股集体回落,恐慌情绪蔓延,多股翻绿。' },
    media_q: { title: '媒体质疑', body: '《云上财经》发文质疑${stock}「营收成谜:爆款故事背后,订单在哪里?」,评论区吵翻了天。' },
    fight: { title: '股吧对线', body: '${stock}吧爆发大规模对线:看多派与唱空派互相举报,管理员连夜加精 37 个帖子。' },
    lhb: { title: '龙虎榜', body: '${stock}登上龙虎榜:某"知名游资席位"出现在卖方前列,卖出金额引发热议。' },
  },
  reg: {
    inquiry: { title: '问询函', body: `${STOCK.regulator}:近期${STOCK.name}(${STOCK.code})股价波动异常,现要求公司就"是否存在应披露未披露重大事项"作出书面说明。` },
    halt: { title: '盘中临时停牌', body: `${STOCK.name}盘中波动异常,${STOCK.regulator}决定实施临时停牌,两个回合后方可恢复交易。` },
    exposure: { title: '监察动态', body: `${STOCK.regulator}内部通报:已对${STOCK.code}账户异动启动重点监控,多个关联账户被标记。` },
    case: { title: '立案调查', body: `${STOCK.regulator}公告:对${STOCK.name}股票异常交易立案调查,相关账户被限制交易。` },
  },
};

const EVENTS = [
  { key: 'sector_up', w: 3 },
  { key: 'market_drop', w: 3 },
  { key: 'media_q', w: 2 },
  { key: 'fight', w: 3 },
  { key: 'none', w: 6 },
];

const VACCINES = [
  { key: 'writer', name: '离职员工自述体', real: '「前员工爆料帖」:身份无法验证,发布时间恰与行情共振,细节煽情但不可查证。', tip: '看到"内部人士"爆料,先查账号历史与发帖时机。' },
  { key: 'hot', name: '买热搜', real: '热搜榜是可以被购买的。突然爆榜、无信源、评论区整齐划一,都是信号。', tip: '热搜 ≠ 真实关注度,先找原始信源。' },
  { key: 'kol', name: '充值大V喊单', real: '「恰饭喊单」:大V立场可以与收益挂钩,且不必向你披露。', tip: '关注大V是否披露利益关系,历史立场是否反复横跳。' },
  { key: 'astroturf', name: '自问自答造势', real: '马甲账号提问+马甲回答,制造"大家都在买"的氛围。', tip: '看回答账号的注册时间与提问-回答时间差。' },
  { key: 'post', name: '亲自带节奏', real: '情绪化短帖是成本最低的引导工具,常成批出现。', tip: '同一话术反复出现时,警惕有组织的引导。' },
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
    ended: false, ending: null,
    pendingBuy: null, pendingSell: null, // buy: {amt, mode} · sell: {channel, amt}
    tips: [],
    skills: { wash: true, exit: true },  // 暗盘大招(每局一次)
    washNext: false, exitNext: false, poolBoostNext: 0,
    decisions: 0, usedDecisions: [], pendingDecision: null,
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
function computePool(st) {
  const heatF = 1 + Math.min(st.heat, 100) / 100 * 2.2;
  const sentF = 0.55 + (avgValence(st) + 100) / 200 * 1.05;
  const priceF = clamp(1.18 - (st.price / CONFIG.startPrice - 1) * 0.55, 0.45, 1.18);
  const shock = st.poolShockRounds > 0 ? 0.85 : 1;
  const buyback = st.trait === 'buyback' ? 1.06 : 1;
  const wash = st.washNext ? 1.35 : 1;          // 对倒放量:本回合买盘池虚增
  const boost = st.poolBoostNext || 1;          // 抉择事件带来的下一回合买盘增益
  const pool = CONFIG.basePool * heatF * sentF * priceF * shock * buyback * wash * boost;
  return { pool, heatF, sentF, priceF, shock };
}

/* ---------------- 舆论行动 ---------------- */
function applyOpinion(st, key, kolId) {
  const act = OPINION_ACTIONS[key];
  if (st.ap < act.ap || st.cash < act.cost) return { ok: false };
  st.ap -= act.ap; st.cash -= act.cost; st.usedTactics[key] = true;
  // 只夹下限:监管溢出 100 的部分要保留(结算顺序是先衰减再判 ≥100,夹上限会破坏入狱机制)
  st.reg = Math.max(0, st.reg + act.reg);
  const HY = st.trait === 'hype' ? 1.3 : 1;   // 流量操盘手:情绪影响 +30%
  const affected = [];
  const record = (npc, dv) => affected.push({ name: npc.name, tag: npc.tag, dv: Math.round(dv) });
  let label = act.name, headline = '';
  const applyAll = (dv, ar) => allNPCs(st).forEach(n => { n.valence = clamp(n.valence + dv * HY, -100, 100); n.arousal = clamp(n.arousal + (ar || 0), 0, 100); });

  if (key === 'post') {
    applyAll(rand(3, 6), 4); st.heat += 4;
    headline = '你亲自发帖《说说为什么我看好' + STOCK.name + '》,评论区吵起来了。';
    allNPCs(st).forEach(n => { if (Math.random() < 0.4) record(n, 5); });
    const sp = pick(T.sockpost);
    st.feed.push({
      type: 'writer', author: pick(SOCK_PUPPETS), tag: '营销号',
      title: sp.title.replace(/\{stock\}/g, STOCK.name),
      text: sp.text.replace(/\{stock\}/g, STOCK.name),
      likes: randInt(60, 800), round: st.round, llm: 'post'
    });
  } else if (key === 'hot') {
    applyAll(rand(2, 5), 12); st.heat += 22;
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
      const dv = (PERSONA_META[n.persona] && PERSONA_META[n.persona].suggestible ? rand(9, 14) : (n.kind === 'kol' ? rand(0, 4) : rand(2, 6))) * HY;
      n.valence = clamp(n.valence + dv, -100, 100); n.arousal = clamp(n.arousal + 6, 0, 100);
      record(n, dv);
    });
    st.heat += 12;
    st.feed.push({ type: 'writer', author: '匿名用户', tag: '深度·软文' + (w.styleTag ? '·' + w.styleTag : ''), title: w.title, text: w.body, attr: w.attr || '', likes: randInt(200, 3000), round: st.round, llm: 'writer' });
    headline = '《' + w.title + '》发布,社区开始转发。';
    if (Math.random() < (st.trait === 'insider' ? 0.125 : 0.25)) { // 被举报(消息灵通:概率减半)
      st.reg += 16; st.heat += 5;
      allNPCs(st).forEach(n => n.confidence = clamp(n.confidence - 8, 0, 100));
      st.feed.push({ type: 'news', tag: '辟谣', title: '账号质疑', text: '有用户扒出软文作者账号为 3 天新注册,发布时间与股价异动高度同步。部分读者表示"先不信了"。', likes: randInt(50, 400), round: st.round });
      headline += ' ⚠ 被用户识破举报,' + STOCK.regulator + '已关注。';
    }
  } else if (key === 'kol') {
    const kol = st.kols.find(k => k.id === kolId) || pick(st.kols);
    st.kolsBoost[kol.id] = 2;
    kol.valence = clamp(Math.max(kol.valence, 80), -100, 100);
    allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 8 * HY, -100, 100); record(n, 8 * HY); });
    headline = '你向' + kol.name + '的"商务合作"账户转了一笔钱,TA 连发两回合看多内容。';
    st.feed.push({
      type: 'kolpost', kol: kol.id, title: '坚定看好' + STOCK.name + '的三个理由',
      text: pick(T.kol[kol.style].boost).replace(/\{stock\}/g, STOCK.name),
      likes: randInt(1000, 9000), round: st.round, llm: 'kol'
    });
  } else if (key === 'astroturf') {
    allNPCs(st).forEach(n => {
      const meta = PERSONA_META[n.persona];
      if (meta && (n.persona === 'student' || n.persona === 'herd')) { n.confidence = clamp(n.confidence + 8, 0, 100); n.valence = clamp(n.valence + 4 * HY, -100, 100); record(n, 4 * HY); }
    });
    headline = '「' + pick(T.astroturfQ) + '」下面多了一条高赞回答,新韭菜们被安抚了。';
    st.feed.push({ type: 'q', title: pick(T.astroturfQ), likes: randInt(8, 60), round: st.round });
    st.feed.push({
      type: 'a', author: pick(['长期主义学习中', '定投第十年', '慢慢变富研究所']), tag: '新韭菜',
      text: pick(T.astroturfA), likes: randInt(120, 900), round: st.round
    });
  } else if (key === 'clarify') {
    st.heat = Math.max(0, st.heat - 15);
    allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal - 8, 0, 100); n.valence = clamp(n.valence - 2 * HY, -100, 100); record(n, -2 * HY); });
    headline = '你发布公告并召开投资者说明会:「一切信息以公告为准」。监管关注度 -10,热度 -15,市场热度降下来了。';
    st.feed.push({ type: 'news', tag: '公告', title: STOCK.name + '发布澄清公告', text: '公司表示经营正常,不存在应披露未披露事项,并将择期召开投资者交流会。部分机构称"关注后续量能"。', likes: randInt(80, 500), round: st.round });
  }
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
  // 散户流动性贡献
  let retailBuy = 0, panicSell = 0;
  allNPCs(st).forEach(n => {
    if (n.kind === 'kol') return;
    const eag = Math.max(0, n.valence) / 100 * (0.4 + n.arousal / 150) * (0.5 + n.confidence / 200);
    retailBuy += n.cash * 0.15 * eag / st.price;
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
  let chg = (1 + buyImpact) * (1 - (sold > 0 ? (sold + sellPressure) / (effPool + 350) * usedCh.impact * 1.2 : sellPressure / (effPool + 350) * 0.5)) - 1;
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
    st.feed.push({ type: 'news', tag: '龙虎榜', title: '龙虎榜曝光', text: T.news.lhb.body.replace(/\$\{stock\}/g, STOCK.name), likes: randInt(500, 2000), round: r0 });
  }

  // 随机事件(报社交情天赋:媒体质疑不再出现)
  const evPool = st.mediaSuppressed ? EVENTS.filter(e => e.key !== 'media_q') : EVENTS;
  const evKey = pickWeighted(evPool);
  if (evKey === 'sector_up') { allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 8, -100, 100); }); st.heat += 10; st.feed.push({ type: 'news', tag: '行业', title: T.news.sector_up.title, text: T.news.sector_up.body.replace(/\$\{stock\}/g, STOCK.name), likes: randInt(100, 900), round: r0 }); }
  else if (evKey === 'market_drop') { allNPCs(st).forEach(n => { n.valence = clamp(n.valence - 10, -100, 100); n.arousal = clamp(n.arousal + 8, 0, 100); }); st.feed.push({ type: 'news', tag: '大盘', title: T.news.market_drop.title, text: T.news.market_drop.body, likes: randInt(100, 900), round: r0 }); }
  else if (evKey === 'media_q') { allNPCs(st).forEach(n => { n.confidence = clamp(n.confidence - 10, 0, 100); }); st.heat -= 5; st.reg += 5; st.feed.push({ type: 'news', tag: '媒体', title: T.news.media_q.title, text: T.news.media_q.body.replace(/\$\{stock\}/g, STOCK.name), likes: randInt(200, 1200), round: r0 }); }
  else if (evKey === 'fight') { allNPCs(st).forEach(n => { n.arousal = clamp(n.arousal + 12, 0, 100); }); st.heat += 6; st.feed.push({ type: 'news', tag: '社区', title: T.news.fight.title, text: T.news.fight.body.replace(/\$\{stock\}/g, STOCK.name), likes: randInt(50, 500), round: r0 }); }

  // 情绪演化(涌现层)
  const mktPull = pct * 1.8, heatPull = (st.heat - 50) * 0.08;
  allNPCs(st).forEach(n => {
    n.valence *= n.kind === 'kol' ? 0.96 : 0.92;
    n.valence = clamp(n.valence + mktPull * (n.kind === 'kol' ? 0.6 : 1) + heatPull + rand(-4, 4), -100, 100);
    n.confidence = clamp(n.confidence + (50 - n.confidence) * 0.08 + rand(-2, 2), 5, 100);
    n.arousal = clamp(n.arousal * 0.9 + rand(0, 6), 0, 100);
    if (n.kind === 'kol' && Math.abs(pct) >= 8) n.memory.push({ round: r0, note: pct > 0 ? '第' + r0 + '回合涨停,我说过要注意节奏' : '第' + r0 + '回合跌停,我提示过风险' });
  });
  // 充值大V回合计时
  for (const k of Object.keys(st.kolsBoost)) { st.kolsBoost[k]--; if (st.kolsBoost[k] <= 0) delete st.kolsBoost[k]; }

  // 监管衰减与阈值
  st.heat = clamp(st.heat - CONFIG.heatDecay, 0, 100);
  st.reg = clamp(st.reg - CONFIG.regDecay, 0, 100);
  if (st.poolShockRounds > 0) st.poolShockRounds--;
  if (st.halted) { st.haltLeft--; if (st.haltLeft <= 0) st.halted = false; }

  // 生成社区 feed(问题帖+高赞回答+评论)
  genFeed(st, pct, snapped);

  // 监管阈值事件
  st.tips = [];
  if (st.reg >= 100) { triggerEnd(st, 'prison'); return; }
  if (st.reg >= 85 && !st.exposureDone) { st.exposureDone = true; st.feed.push({ type: 'news', tag: '监管', title: T.reg.exposure.title, text: T.reg.exposure.body, likes: 0, round: r0 }); st.tips.push('监察部已经标记了你的账户。再激进,就是立案。'); }
  if (st.reg >= haltAt(st) && !st.halted && st.haltLeft <= 0) {
    st.halted = true; st.haltLeft = 2;
    st.feed.push({ type: 'news', tag: '监管', title: T.reg.halt.title, text: T.reg.halt.body, likes: 0, round: r0 });
    st.tips.push('临时停牌:交易冻结中,舆论操作不受影响——「🧯 澄清」还能给监管降温,加速复牌。');
  }
  if (st.reg >= inquiryAt(st) && !st.inquiryDone) {
    st.inquiryDone = true; st.heat = Math.max(0, st.heat - 8);
    st.feed.push({ type: 'news', tag: '监管', title: T.reg.inquiry.title, text: T.reg.inquiry.body, likes: 0, round: r0 });
    st.tips.push('第一封问询函到了。这是提醒,也是计时器开始加速的信号。');
  }

  st.round = r0 + 1;
  st.ap = st.apPerTurn;
  st.washNext = false; st.exitNext = false; st.poolBoostNext = 0;
  // 抉择事件:第 4 回合起小概率出现,每局至多 2 次(停牌中也会出现——正好是处理麻烦的时候)
  if (!st.ended && r0 >= 4 && !st.pendingDecision && st.decisions < 2 && Math.random() < 0.14) {
    const pool = DECISIONS.filter(d => !st.usedDecisions.includes(d.id));
    if (pool.length) { st.pendingDecision = pick(pool); st.decisions++; st.usedDecisions.push(st.pendingDecision.id); }
  }
  if (st.round > CONFIG.totalRounds) { triggerEnd(st, null); return; }
  return true;
}

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
  st.reg = clamp(st.reg + 14, 0, 100);
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
      { label: '破财免灾(支付 2000 万)', apply(st) { st.cash -= 2000; st.reg = clamp(st.reg - 8, 0, 100); return '支付 2000 万封口:监管关注度 -8,他闭嘴了(大概)。'; } },
      { label: '翻脸不认', apply(st) { st.reg = clamp(st.reg + 12, 0, 100); allNPCs(st).forEach(n => n.valence = clamp(n.valence - 6, -100, 100)); return '他四处放话"等着看吧":监管 +12,社区情绪 -6。'; } },
      { label: '拉他入伙(支付 500 万)', apply(st) { st.cash -= 500; st.poolBoostNext = 1.2; const betrayed = Math.random() < 0.35; if (betrayed) st.reg = clamp(st.reg + 15, 0, 100); return '他答应帮忙造势:下回合买盘池 +20%' + (betrayed ? '。但他转头就把你卖了:监管 +15!' : '。(暂无异常迹象)'); } },
    ],
  },
  {
    id: 'reporter', title: '财经记者上门',
    text: '《云上财经》的调查记者约你喝茶:她手里有一份你的龙虎榜交易记录,但她更想要一个"独家故事"。',
    opts: [
      { label: '花钱消灾(1200 万)', apply(st) { st.cash -= 1200; st.mediaSuppressed = true; return '签订"战略合作":本局不再触发媒体质疑事件。'; } },
      { label: '接受专访', apply(st) { allNPCs(st).forEach(n => n.valence = clamp(n.valence + 8, -100, 100)); const hit = Math.random() < 0.25; if (hit) st.reg = clamp(st.reg + 10, 0, 100); return '专访刊出,人气大涨:情绪 +8' + (hit ? '。但记者多写了一笔"关联交易疑云":监管 +10。' : '。'); } },
      { label: '拂袖而去', apply(st) { st.heat = clamp(st.heat - 8, 0, 100); return '不欢而散:热度 -8,传闻倒是没了下文。'; } },
    ],
  },
  {
    id: 'hotmoney', title: '神秘游资递来纸条',
    text: '龙虎榜上那个"知名席位"托人带话:他看好这只票,想跟你合力做一波。代价是——他知道你的存在。',
    opts: [
      { label: '合力点火', apply(st) { st.heat = clamp(st.heat + 15, 0, 100); st.poolBoostNext = 1.1; st.reg = clamp(st.reg + 10, 0, 100); return '两路资金合力:热度 +15,下回合买盘池 +10%,监管 +10。'; } },
      { label: '婉拒合作', apply(st) { st.cash += 300; return '对方表示"后会有期",留下 300 万信息费。'; } },
      { label: '将计就计', apply(st) { st.reg = clamp(st.reg - 12, 0, 100); st.heat = clamp(st.heat - 5, 0, 100); return '你把他推到台前吸引火力:监管关注度 -12,热度 -5。'; } },
    ],
  },
  {
    id: 'foreign', title: '境外资金询价',
    text: '一位境外机构经理通过中间人询价:愿意以 9.1 折吃下你 30% 的可卖筹码,大宗过户,不留痕迹。',
    opts: [
      { label: '成交(30% 筹码 9.1 折)', apply(st) { const amt = sellableShares(st) * 0.3; if (amt < 10) return '可卖筹码不足,对方摇了摇头。'; const rev = amt * st.price * 0.91; st.cash += rev; st.realized += rev; let left = amt; for (const lot of st.lots) { if (lot.round === st.round) continue; const take = Math.min(lot.shares, left); lot.shares -= take; left -= take; if (left <= 0) break; } st.lots = st.lots.filter(l => l.shares > 0.0001); st.soldCum += amt; return '大宗过户 ' + Math.round(amt) + ' 万股 @ 9.1 折,回款 ' + fmtYi(rev) + ',不惊动任何人。'; } },
      { label: '嫌折价太高,拒绝', apply(st) { return '对方耸耸肩离开:机会成本自负。'; } },
    ],
  },
  {
    id: 'elder', title: '老领导点拨',
    text: '退休的老领导约你打球。收杆时他意味深长地说:"年轻人,钱是赚不完的。"',
    opts: [
      { label: '孝敬 1500 万', apply(st) { st.cash -= 1500; st.reg = clamp(st.reg - 18, 0, 100); return '老领导笑纳:"最近的风,我帮你看着点。"关注度 -18。'; } },
      { label: '只谈球,不谈事', apply(st) { st.heat = clamp(st.heat - 4, 0, 100); return '平安无事打完十八洞:热度 -4。'; } },
    ],
  },
  {
    id: 'shortseller', title: '做空机构点名',
    text: '一家境外做空机构发布报告:你的公司"基本面撑不起股价",并暗示"背后有操纵之手"。报告正被翻译传播。',
    opts: [
      { label: '火力全开回击', apply(st) { st.heat = clamp(st.heat + 12, 0, 100); allNPCs(st).forEach(n => { n.valence = clamp(n.valence + 6, -100, 100); n.confidence = clamp(n.confidence - 4, 0, 100); }); st.reg = clamp(st.reg + 8, 0, 100); return '你发动一切资源反做多:热度 +12,情绪 +6,监管 +8。'; } },
      { label: '冷处理', apply(st) { allNPCs(st).forEach(n => { n.valence = clamp(n.valence - 8, -100, 100); n.confidence = clamp(n.confidence - 6, 0, 100); }); return '装死不回应:情绪 -8,信心 -6,但没添新把柄。'; } },
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
      st.feed.push({ type: 'a', author: n.name, tag: n.tag, text: F(pick(bank)), likes: randInt(3, 300), round: r });
    }
  });
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
  clean: { title: '全身而退', sub: '新闻不会记得这一周。', body: `周五收盘后,你关掉账户。这笔现金将以"投资收益"的名义,安静地流向别处。${STOCK.name}的走势图会留在K线里,像一片被踩过的草地,慢慢直起来。`, tone: 'good' },
  safe: { title: '落袋为安', sub: '你带走了钱,也留下了一地韭菜。', body: `大部分筹码换成了现金,但尾巴割在了不理想的位置。社区里还有人举着你的帖子当信仰。你决定休息一段时间——直到下一个"星阑"出现。`, tone: 'mid' },
  partial: { title: '中途离场', sub: '半仓的利润,满仓的心事。', body: `你提前收手了。赚到了钱,但也眼睁睁看着剩下的筹码再也回不到那个价格。带节奏容易,全身而退,从来是两件事。`, tone: 'mid' },
  stuck: { title: '高位站岗', sub: '原来庄家也会站岗。', body: `热度散了,买盘池见了底,而你手里还攥着满把筹码。你现在最需要的,是一个比你更大的傻瓜——但市场最不缺的,就是和你想一样的人。`, tone: 'bad' },
  deep: { title: '深套其中', sub: '纸面财富,纸面人生。', body: `股价击穿了你的成本线。那些你亲手点燃的帖子还在社区里流传,只是没有人再点了。你成了自己故事里的反面教材。`, tone: 'bad' },
  prison: { title: '锒铛入狱', sub: `${STOCK.regulator}通报(虚构)`, body: `关于${STOCK.name}(${STOCK.code})异常交易案的调查通报:某主体利用资金优势、持股优势,连续买卖、自买自卖,并编造传播虚假或误导性信息,影响证券交易价格。依据相关规定,没收违法所得,并处以等额罚款;当事人被采取终身市场禁入措施。`, tone: 'prison' },
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
