'use strict';
/* 无状态登录会话回归(zrs):seal/open 往返、篡改拒绝、密钥轮换拒绝、
 * 跨"重启"(清 require 缓存重载 server.js)凭密文复原、24h 过期。
 * 前置:ZHIHU_OAUTH_APP_ID / ZHIHU_OAUTH_APP_KEY 需存在(测试自带假值即可,不必是真凭证);
 * server.js 以 require 方式加载(不 listen),经 module.exports 复用 seal/open/getSession。 */
process.env.ZHIHU_OAUTH_APP_ID = process.env.ZHIHU_OAUTH_APP_ID || 'qa-app';
process.env.ZHIHU_OAUTH_APP_KEY = process.env.ZHIHU_OAUTH_APP_KEY || 'qa-key-0123456789abcdef';

function fresh() {
  delete require.cache[require.resolve('../server.js')];
  return require('../server.js');
}
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; console.error('  ✘ ' + msg); }
}

let S = fresh();

/* 1. seal → open 往返(含中文昵称 UTF-8) */
const tok = 'tok_' + 'a'.repeat(40);
const zrs = S.sealSession(tok, '测试昵称');
ok(typeof zrs === 'string' && zrs.indexOf('.') > 0, 'seal 返回 iv.ct 两段 base64url');
ok(zrs.length < 512, 'zrs 长度适合 URL/localStorage(实际 ' + zrs.length + ')');
const back = S.getSession(zrs);
ok(!!back && back.oauthToken === tok && back.name === '测试昵称', 'getSession 往返还原令牌与昵称');
/* 注:L1 写入(sessions.set)发生在登录路由,sealSession 本身只产密文 —— L1 行为在第 5 节以手工置入验证 */

/* 2. 篡改/伪造/畸形一律拒绝(GCM 认证标签) */
ok(S.getSession(zrs.slice(0, -4) + 'AAAA') === null, '密文尾部篡改 → 拒绝');
ok(S.getSession(zrs.slice(0, Math.floor(zrs.length / 2))) === null, '密文截断 → 拒绝');
ok(S.getSession('garbage') === null, '无点分段 → 拒绝');
ok(S.getSession('x.y') === null, '过短两段 → 拒绝');
ok(S.getSession('') === null, '空 zrs → 拒绝');
ok(S.getSession(null) === null, 'null zrs → 拒绝');

/* 3. "重启"复原:重载模块(全新 sessions Map,同密钥),旧 zrs 仍可解 —— 进程回收/部署后免重登 */
const zrsBefore = zrs;
S = fresh();
ok(S.sessions.size === 0, '重载后内存会话为空(模拟 Render 回收/重启)');
const after = S.getSession(zrsBefore);
ok(!!after && after.oauthToken === tok && after.name === '测试昵称', '重启后凭密文复原会话(免重登)');

/* 4. 密钥轮换:换 APP_KEY 重载 → 旧 zrs 全部拒绝 */
process.env.ZHIHU_OAUTH_APP_KEY = 'qa-key-rotated-ffffffffffff';
S = fresh();
ok(S.getSession(zrsBefore) === null, '密钥轮换后旧 zrs → 拒绝');

/* 5. 24h 过期(时钟前拨):密文内嵌过期与内存 L1 TTL 两条路径都要拒绝 */
const realNow = Date.now;
const zrs2 = S.sealSession('tok2', 'n2');   // 密文内嵌 e = now+24h;登录路由会同时写 L1,此处先绕开
S.sessions.delete(zrs2);
Date.now = () => realNow() + 25 * 3600e3;
let expired = S.getSession(zrs2);
ok(expired === null, '密文内嵌过期(>24h)→ 拒绝');
const zrs3 = S.sealSession('tok3', 'n3');   // 时钟仍前拨:密文 e 在遥远未来,只可能由 L1 TTL 拦下
S.sessions.set(zrs3, { oauthToken: 'tok3', name: 'n3', at: realNow() });   // 模拟登录路由的 L1 写入(真实签发时刻)
expired = S.getSession(zrs3);
ok(expired === null, '内存 L1 TTL(>24h)→ 拒绝');
Date.now = realNow;

/* 6. 过期后时钟复原:新签发会话恢复正常 */
const zrs4 = S.sealSession('tok4', 'n4');
ok(!!S.getSession(zrs4) && S.getSession(zrs4).oauthToken === 'tok4', '时钟复原后新会话正常');

console.log('zrs-session: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
