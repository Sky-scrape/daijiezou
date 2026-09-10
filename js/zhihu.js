'use strict';
/* ============================================================
 * zhihu.js —— 知乎开放平台接入加载器(《带节奏》)
 * 设计原则:服务器不可达/未配置/额度耗尽时,一切静默降级为
 * 本地模板模式(game.js 的内置文案库),绝不阻断游戏。
 *
 * 四个接入点:
 *   A. 故事语料(window.ZR_WRITER)→ 雇写手动作,含作者归属
 *   B. 热榜背景板(#hotstrip)    → 社区头部滚动真实知乎热榜
 *   C. 知乎登录(window.ZR_PERSONA)→ 生成"以你为原型"的韭菜 NPC
 *   D. 直答问答(刘看山·看盘版输入框) → 问"什么是T+1"等新手问题
 * ============================================================ */
(function () {
  'use strict';
  window.ZR = { corpus: false, oauth: false, hotlist: false, zhida: false, appId: null, loggedIn: false };
  window.ZR_WRITER = [];       // [{title, body, attr}]
  window.ZR_PERSONA = null;    // {name, tag, persona} 以玩家为原型的 NPC
  window.ZR_FOLLOWEES = [];    // [{name, headline, followers, tag, persona}] 玩家关注的知友 → 批量 AI 分身

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  /* 同源断言:本模块的 fetch 只允许 /api/ 相对路径(浏览器端无 SSRF 面,这里锁定调用契约,防未来被拼绝对地址) */
  function assertApiPath(url) {
    if (!/^\/api\//.test(String(url))) throw new Error('same-origin /api/ paths only');
  }
  async function jget(url) {
    assertApiPath(url);
    const r = await fetch(url);
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  async function jpost(url, obj) {
    assertApiPath(url);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }

  /* ---------- A. 故事语料 → 写手系统 ---------- */
  async function loadCorpus() {
    const data = await jget('/api/zhihu/corpus');
    const ps = (data.patterns || []).slice(0, 8);
    if (!ps.length) return;
    window.ZR_WRITER = ps.map(p => ({
      title: '', body: '',   // title/body 在使用时按本地模板生成,语料提供"风格参照"
      styleTitle: p.title, labels: p.labels || [],
      attr: '写手风格样本:《' + p.title + '》' + (p.author ? '@' + p.author : '') + '(知乎盐言故事)',
    }));
    window.ZR.corpus = true;
    console.log('[知乎] 故事语料就绪:' + window.ZR_WRITER.length + ' 条风格参照');
  }

  /* ---------- B. 热榜背景板 ---------- */
  async function loadHotList() {
    const data = await jget('/api/zhihu/hot');
    const items = (data.items || []).slice(0, 8);
    if (!items.length) return;
    const strip = $('hotstrip');
    if (!strip) return;
    strip.innerHTML = '<span class="hs-badge">真实知乎热榜</span>' +
      items.map(i => '<span class="hs-item">' + esc(i.title) + '</span>').join('');
    strip.classList.add('on');
    window.ZR.hotlist = true;
  }

  /* ---------- C. 知乎登录 → 个性化 NPC(本人 + 关注的知友批量分身) ---------- */
  function derivePersona(digest) {
    const text = (digest.contents || []).concat(digest.favorites || []).join(' ');
    const heads = (digest.followees || []).join(' ');
    const has = (re, s) => re.test(s || '');
    if (has(/股票|基金|理财|A股|涨停|价值投资|巴菲特|同花顺|k线|K线|市场/, text)) return 'value';
    if (has(/AI|互联网|编程|科技|芯片|量化|智能/, text + heads)) return 'boarder';
    if (has(/旅行|美食|摄影|电影|游戏/, text)) return 'suoha';
    if ((digest.contents || []).length === 0 && (digest.followees || []).length === 0) return 'student';
    return 'herd';
  }
  // 知友人设推导只用一句话介绍 + 粉丝数(确定性:同一人永远推出同一人设)
  function deriveFolloweePersona(f) {
    const text = f.headline || '';
    if (/股票|基金|理财|投资|价值|巴菲特|k线|K线|量化|证券|港股|美股/.test(text)) return 'value';
    if (/AI|互联网|编程|科技|芯片|智能|创业|程序员|产品/.test(text)) return 'boarder';
    if (/旅行|美食|摄影|电影|游戏|健身|宠物|穿搭/.test(text)) return 'suoha';
    if ((f.followers || 0) >= 100000) return 'value';   // 大粉多为内容创作者,偏理性
    return (f.followers || 0) > 0 && (f.followers || 0) <= 500 ? 'herd' : 'student';
  }
  async function applyPersona(digest, mode) {
    const persona = derivePersona(digest);
    window.ZR_PERSONA = {
      name: (digest.nickname || '知乎来的你').slice(0, 12),
      tag: mode === 'self' ? '知乎原型·开发者' : mode === 'demo' ? '虚构示例·分身' : '知乎原型·你',
      persona,
      digest,
    };
    window.ZR_FOLLOWEES = (digest.followeesFull || []).slice(0, 8).map(f => ({
      name: f.name,
      headline: f.headline || '',
      followers: f.followers || 0,
      tag: mode === 'demo' ? '虚构示例·关注' : '知乎关注·@' + f.name,
      persona: deriveFolloweePersona(f),
    }));
    window.ZR.loggedIn = true;
    const btn = $('btn-zhihu-login');
    if (btn) {
      const n = window.ZR_FOLLOWEES.length;
      btn.textContent = (mode === 'demo' ? '✔ 已生成示例分身(虚构)' : '✔ 已生成你的韭菜分身') + (n ? ' + ' + n + ' 位知友分身' : '');
      btn.classList.add('done');
      btn.disabled = true;
    }
  }
  async function loadPersona(zrs) {
    try {
      const digest = await jget('/api/zhihu/npc?zrs=' + encodeURIComponent(zrs));
      await applyPersona(digest, 'oauth');
      history.replaceState(null, '', location.pathname);
    } catch (e) {
      history.replaceState(null, '', location.pathname);
    }
  }
  async function loadSelfPersona() {
    const digest = await jget('/api/zhihu/npc-self');
    if (!digest.nickname) digest.nickname = '开发者本人';
    await applyPersona(digest, 'self');
  }
  async function wireLogin() {
    const btn = $('btn-zhihu-login');
    if (!btn) return;
    if (window.ZR.oauth) {
      // 完整 OAuth 模式:任何玩家登录生成自己的分身
      btn.classList.remove('hidden');
      btn.addEventListener('click', async () => {
        try {
          const cfg = await jget('/api/zhihu/authorize-url');
          location.href = cfg.url;
        } catch (e) { btn.textContent = '登录服务暂不可用'; }
      });
    } else if (window.ZR.selfDemo) {
      // 演示模式:无 OAuth 但有 Access Secret,且仅本机开放 → 用 Secret 所属账号本人画像
      btn.classList.remove('hidden');
      btn.textContent = '🔗 用知乎画像生成 NPC(本机演示 · 读取服务器主人的关注列表)';
      btn.title = '仅本机可用:以服务器配置的知乎账号画像,生成一位"你"放进社区里一起被收割。';
      btn.addEventListener('click', async () => {
        btn.disabled = true; btn.textContent = '正在读取知乎画像…';
        try { await loadSelfPersona(); }
        catch (e) { btn.disabled = false; btn.textContent = '画像服务暂不可用,稍后再试'; }
      });
    } else {
      // 公网评审环境:无 OAuth、也不允许读开发者画像 → 降级为虚构示例分身,
      // 保证"分身进社区被收割"的玩法在任何环境都能演示,且诚实标注为虚构。
      btn.classList.remove('hidden');
      btn.textContent = '🔗 生成示例分身(虚构演示 · 无需登录)';
      btn.addEventListener('click', () => {
        applyPersona({
          nickname: '示例居民·小知',
          contents: ['最近在研究量化基金,求入门建议', '如何看懂K线图?', '记录一次川西自驾'],
          followees: ['价值投资', '量化小散布'],
          favorites: ['理财入门书单'],
          followeesFull: [
            { name: '量化老周', headline: '十年量化私募从业者,聊策略与风控', followers: 123000 },
            { name: '川西旅行箱', headline: '旅行摄影博主,镜头里全是路', followers: 45000 },
            { name: '奶茶不加糖', headline: '大学生,爱美食也爱记账', followers: 300 },
          ],
        }, 'demo');
      });
    }
  }

  /* ---------- D. 直答 → 已并入 ui.js 的「AI 军师」降级链(BYOK/服务端LLM → 直答 → 本地规则) ---------- */

  /* ---------- 启动 ---------- */
  async function boot() {
    let cfg = null;
    try { cfg = await jget('/api/config'); } catch (e) { return; }  // file:// 直接打开:静默离线模式
    Object.assign(window.ZR, cfg || {});
    wireLogin();
    try { await loadCorpus(); } catch (e) { /* 降级:内置写手文案 */ }
    try { await loadHotList(); } catch (e) { /* 降级:无背景板 */ }
    const zrs = new URLSearchParams(location.search).get('zrs');
    if (zrs) await loadPersona(zrs);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
