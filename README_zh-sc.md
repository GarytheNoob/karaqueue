# KaraQueue

> 🇬🇧 English docs: [README.md](README.md)

局域网点歌机原型：手机提交 BV 号/链接/B站分享文本，队列服务维护顺序，Chrome 插件驱动 bilibili 标签页自动连播。零 npm 依赖。

## 功能总览

**点歌（bilibili）**

- 输入格式：BV 号、av 号、完整网页链接、`?p=N` 分P、`b23.tv` 短链、手机 App 分享文本（`【标题】 https://b23.tv/xxx` 形式，自动提取链接）。多 P 投稿按单 P 为一首歌（分P号进曲目 ID）
- **风控容错**：B 站元数据接口被拦截（如 HTTP 412 返回网页）时点歌不会失败——优先使用缓存的元数据（24h TTL，缓存命中零触网）；无缓存则按纯链接降级入队（可正常播放，标题显示"元数据未获取"）。仅当视频 ID 本身无效或不存在（B 站 code -400/-404）时才拒绝提交。首次请求前自动获取 `buvid3/buvid4` Cookie 降低 412 概率

**队列与规则**

- FIFO 队列，展示点歌人；**空闲时提交的歌自动开始播放**（提升为正在播放，所有客户端跟随）；重启后自动恢复未播完的会话
- 判重以归一化 ID（`bvid + 分P`）为准：正在播放/已在队列中的重复提交被拒绝（人话中文报错），播过的歌可以重复点；队列与已播历史均无容量上限
- **随时撤回自己的点歌**：绿色「我点的」badge 标出本人点的所有歌（正在播放/队列/历史都会标），队列里自己的歌带「✕ 撤回」按钮。归属在服务端按浏览器 uid 校验、**不受公平轮唱开关影响**（撤回队列里的歌同时也会释放公平模式的名额）
- 实时同步：所有变更（点歌/跳过/删除/调序/规则切换）通过 SSE 即时广播（实测 ~20ms），并带"回到前台立即对账 + 可见时 5 秒轮询"的双保险，规避手机后台标签冻结

**点歌页**（手机）

- 提交表单、正在播放、队列；"已播历史"在二级页面（旧的在上、带序号，1 = 全场第一首）。卡片样式区分 NOW（蓝）/ NEXT（琥珀）。手机端没有跳过按钮——切歌是房主的职责

**Chrome 插件**（MV3，驱动大屏播放）

- 视频播完自动切下一首（监听 `<video>` `ended`，SPA 路由切换后自动重绑）
- autoplay 被浏览器拦截时显示"继续播放"悬浮按钮（每会话仅需一次手势）
- 弹窗：配置服务地址、打开当前曲目、**跳过**（立即生效）；NOW/NEXT 卡片与点歌页同款样式；地址配错时给人话报错而不是裸的 JSON 解析错误

**管理后台**（独立端口、手机友好、面向房主）

- 跳过当前（立即生效）、移出队列、逐格调序（上移/下移）**以及一键置顶的 ⤒ 提前按钮**
- 已播历史列表：带序号 + **一键"再点一次"**（把播过的歌重新入队；房间空闲时立即开播）
- 房间规则开关（两个）："允许队列中重复点同一首歌"（关：宁播不重；开：同一首歌可在队列叠多条），以及 **"公平轮唱 · 每人限点一首"**（开启后每人同时只能有一首在唱或在排，按浏览器 Cookie 识别、改昵称/刷新页面都不影响；被锁定期间，点歌页上该客人的"加入队列"按钮置灰、昵称输入框锁定，直到自己的歌唱完）
- 可选 `ADMIN_PIN`：管理后台所有读写需要 PIN

## 组成

- `server/karaoke.mjs` — 队列服务（Node 内置模块，零依赖）
- `server/static/index.html` — 手机点歌页；`server/static/admin.html` — 管理后台（均为无框架单文件）
- `extension/` — Chrome 插件

服务端 API 速览（供折腾用）：

- 公共端口：`GET /`（页面）、`GET /api/state`、`GET /api/events`（SSE）、`POST /api/submit` `{input, by, uid}`、`POST /api/withdraw` `{id, uid}`、`POST /api/advance`、`POST /api/skip`
- 管理端口：`GET /`（控制台）、`GET /api/state`、`GET /api/events`、`GET /api/config`、`POST /api/config` `{allowQueuedDuplicates, oneSongPerGuest}`、`POST /api/skip`、`POST /api/delete` `{id}`、`POST /api/reorder` `{id, direction: up|down|top}`、`POST /api/rerequest` `{id}`

## 运行

要求 **Node ≥ 18**（内置 fetch）。

```sh
node server/karaoke.mjs                      # 默认 0.0.0.0:7777
PORT=8080 HOST=127.0.0.1 node server/karaoke.mjs
```

局域网内设备访问 `http://<本机局域网IP>:7777`（macOS 可用 `ipconfig getifaddr en0` 查询本机 IP）。

环境变量：`PORT`（服务，默认 7777）、`HOST`（绑定地址）、`ADMIN_PORT`（管理后台，默认 7778）、`ADMIN_PIN`（保护后台）。`KARAQUEUE_VIEW_API` / `KARAQUEUE_SPI_API` 可覆盖 bilibili 接口地址用于测试。

## 管理后台

启动服务后，房主手机打开 `http://<本机局域网IP>:7778`：

```sh
node server/karaoke.mjs
# => [karaqueue] queue server on http://0.0.0.0:7777
# => [karaqueue] admin console on http://0.0.0.0:7778 (no PIN set (ADMIN_PIN env to protect))
```

设置 `ADMIN_PIN=xxxx` 后管理后台所有读写需要 PIN（页面会把 PIN 存在手机上）。不设置则局域网内任何人都能操作，建议局域网共用时开启。

## 安装插件（Load unpacked）

1. Chrome 打开 `chrome://extensions`，右上角开启 **开发者模式**
2. **加载已解压的扩展程序** → 选择本仓库 `extension/` 目录
3. 点击工具栏的 KaraQueue 图标，确认服务地址（默认 `http://127.0.0.1:7777`；服务跑在别的机器上就改成对应 IP 并保存）

## 使用流程

1. 大屏电脑启动队列服务
2. 大屏 Chrome 里手动打开第一个视频（或用插件弹窗"打开当前曲目"）；**若浏览器拦截自动播放，点一次右下角"继续播放"**——之后整晚不再需要交互
3. 大家手机点歌：空闲时点歌会自动开播；一首播完插件自动切下一首
4. 房主在插件弹窗或管理后台随时：跳过切歌、删除/调序/置顶队列、一键重播历史歌曲
5. 客人想重听某首歌？在点歌页"已播历史"里找到再提交一次即可

## 排障

- 弹窗报 **`TypeError: Failed to fetch`**：所配置地址上没有应答——服务是否在大屏机子上运行（`node server/karaoke.mjs`）？地址是否可达？可在浏览器里直接打开 `http://<大屏IP>:7777/api/state` 验证，应显示一段 JSON。
- 弹窗报 **`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`**：配置的地址返回的是网页而不是 KaraQueue 的 JSON——基本都是漏了 `:7777` 端口（请求打到了 80 端口上的其他 Web 服务，如路由器管理页）。地址应形如 `http://192.168.1.5:7777`。
- **客人根本不需要装插件**。插件只负责驱动大屏浏览器，手机点歌访问 `http://<大屏IP>:7777` 就行。
- 页面在跳过等操作后看起来"没跟上"：手机浏览器会冻结后台标签并掐掉 SSE 连接；页面回前台即对账、可见期间 5 秒轮询兜底，把标签页切回前台即可。

## 注意事项 / 已知边界

- **关闭 B 站播放器的"自动连播"**，否则页面原生连播会和插件切歌竞争
- 队列状态持久化在 `server/queue.json`、元数据缓存在 `server/meta-cache.json`（均已 gitignore）；修改代码或遇到诡异状态时先 `pkill -f karaoke.mjs` 再重启，测试想完全干净可删除这两个文件
- 弹窗的即时跳过依赖"打开当前曲目"触发的即时对账；其他远端变更（如未来多数派跳过）在 ≤15 秒内由 alarm 轮询同步
- 暂不支持 YouTube / niconico（resolver 遇到会报错提示，属预期行为；架构已预留 source 适配层）
- **免责声明**：本项目与哔哩哔哩无关联；视频一律通过 B 站官方网页播放器播放，服务端仅请求公开接口用于解析标题等元数据
