# 部署与知乎能力接入指南

《带节奏》= 纯前端游戏(离线可玩)+ 一个零依赖 Node 服务器(server.js,提供知乎能力)。
**不配置任何环境变量也能跑**——所有知乎能力缺失时自动降级为内置文案。

## 一、本地运行

```bash
cd daijiezou-demo
node server.js          # http://localhost:8788
```

直接双击 `index.html` 也可以玩(离线模板模式,无知乎能力)。

## 二、四个知乎接入点

| 接入点 | 需要什么 | 降级行为 |
|---|---|---|
| A. 故事语料 → 写手软文归属 | 无(免鉴权免额度) | 内置 6 篇软文 |
| B. 热榜背景板 | `ZHIHU_ACCESS_SECRET` | 无背景板 |
| C. 知乎登录 → 个性化 NPC | `ZHIHU_OAUTH_APP_ID` + `APP_KEY` + `ACCESS_SECRET` + 活动页登记回调 | 登录按钮隐藏 |
| D. 直答问答(看盘君) | `ZHIHU_ACCESS_SECRET` | 问答框隐藏 |

### 需要你操作的事(按顺序)

**第 1 步:申请 Access Secret(5 分钟,激活 B/D)**
1. 打开 https://developer.zhihu.com/profile ,登录知乎
2. 生成 **Access Secret**,复制(只显示一次)
3. 启动服务器时带上:
   ```
   # PowerShell
   $env:ZHIHU_ACCESS_SECRET="粘贴你的Secret"; node server.js
   # Git Bash
   ZHIHU_ACCESS_SECRET="粘贴你的Secret" node server.js
   ```
4. 验证:浏览器打开 http://localhost:8788 ,社区头部出现红色「真实知乎热榜」滚动条即成功

**第 2 步:创建黑客松项目拿 OAuth 凭证(激活 C)**
1. 打开 https://www.zhihu.com/hackathon?activity_code=zhihu_hackathon_2026_p2 ,完成报名(需学生/毕业3年内身份验证)
2. 「我的项目」→ 创建项目,页体会分配 `App ID` 和 `App Key`
3. 在项目信息里填写**知乎登录回调地址**(本地调试填 `http://localhost:8788/zhihu/callback`;正式部署填线上地址,两者必须与实际完全一致)
4. 带凭证启动:
   ```
   ZHIHU_ACCESS_SECRET="..." ZHIHU_OAUTH_APP_ID="..." ZHIHU_OAUTH_APP_KEY="..." node server.js
   ```
5. 验证:开始页出现「🔗 知乎登录」按钮 → 点击跳知乎授权 → 回来后按钮变绿「✔ 已生成你的韭菜分身」→ 开局后居民面板出现 🌟 你的 NPC

**第 3 步:部署上线(提交要求"公网可访问")**
推荐 Vercel / Render / Railway(免费档够用,支持 Node + 环境变量):
1. 把 `daijiezou-demo` 文件夹推到 GitHub(⚠ 先确认 `.gitignore` 排除凭证——本项目凭证只走环境变量,仓库里没有秘密)
2. 平台导入仓库,Start command 填 `node server.js`
3. 在平台 Dashboard 的 Environment Variables 里配置三个环境变量(等同本地第 1/2 步)
4. **回活动页面把回调地址改成线上域名** `https://你的域名/zhihu/callback`(必须完全一致,含 https)
5. 打开线上地址完整验证:登录 → 开局 → 结算一局 → 结局页

**第 4 步:提交(9月13日 10:00 ~ 15日 10:00)**
按活动页要求填写:项目名/介绍/赛道(跨次元游乐场或自选)/Demo 地址/产品说明/icon 封面。

## 三、产品说明里可以直接用的「知乎能力」章节

> - **盐言故事内容 API**(免鉴权):拉取真实故事标题套路作为游戏内「雇写手」软文的风格参照,并在帖内保留作者归属标注——让玩家看到的每一篇"离职员工体"都有真实的社区文风出处。
> - **黑客松 OAuth**:玩家知乎登录后,依据其公开创作/关注/收藏画像生成一位「以你为原型」的 AI 散户 NPC 进入游戏——你亲手操纵舆论,然后看着"另一个自己"被收割。
> - **热榜 API**(服务端 30 分钟缓存):真实知乎热榜作为游戏社区的现实背景板,与玩家购买的"热搜位"形成虚实对照。
> - **知乎直答**:游戏内操盘助手「看盘君」的问答能力,新手可随时提问(T+1 是什么/什么是连板),带 24h 问题级缓存。
> - 所有能力的调用均在服务端完成,凭证不落前端;额度耗尽或接口异常时自动降级为本地生成,体验不中断。

## 四、文件结构

```
index.html / style.css / game.js / ui.js   纯前端游戏(离线可玩)
server.js                                   零依赖 Node 服务器:静态托管 + 4 个知乎 API + 缓存降级
js/zhihu.js                                 前端接入加载器(探测能力/拉语料/热榜/OAuth回调/直答)
README.md / README-DEPLOY.md
```

## 五、安全红线(提交前自查)

- [ ] App Key / Access Secret / OAuth Token 未出现在代码、前端响应、日志、截图、演示视频中
- [ ] 回调地址与活动页登记值完全一致(协议/域名/路径/尾部斜杠)
- [ ] 接口失败与额度耗尽时,页面展示的是真实降级提示(本项目:自动回退本地模板)
- [ ] 声明:本游戏纯属虚构,不构成投资建议
