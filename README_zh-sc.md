# KaraQueue

> [English](README.md) · [简体中文](README_zh-sc.md)

[![Release](https://img.shields.io/github/v/release/GarytheNoob/karaqueue)](https://github.com/GarytheNoob/karaqueue/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/GarytheNoob/karaqueue/total)](https://github.com/GarytheNoob/karaqueue/releases/latest)
[![License](https://img.shields.io/github/license/GarytheNoob/karaqueue)](LICENSE)
![Node ≥ 18](https://img.shields.io/badge/Node%20%E2%89%A5%2018-339933?logo=node.js&logoColor=white)
![Chromium · Firefox](https://img.shields.io/badge/Chrome%20%C2%B7%20Edge%20%C2%B7%20Firefox-000000?logo=googlechrome&logoColor=white)

<p align="center">
  <img src="docs/images/request.png" alt="KaraQueue 点歌页" width="100%">
</p>

局域网点歌机。大家用手机提交 B 站或 YouTube 视频，队列服务维护顺序，浏览器插件驱动大屏自动连播下一首点歌。服务端只用 Node 内置模块，没有 npm 依赖。

## 介绍

<div align="center">

| ![](docs/images/admin.png) | ![](docs/images/popup.png) |
|:---:|:---:|
| 管理后台 | 插件弹窗 |

</div>

**它做什么，一目了然：**

- **手机优先的点歌。** 表单认得 BV 号、av 号、完整网页链接、`?p=N` 分 P 链接和 `b23.tv` 短链；YouTube 的 `watch?v=`、`youtu.be`、shorts 链接；还有两家手机 App 的分享原文。B 站多 P 按单 P 算一首。歌单一律不展开；带 `list=` 的 YouTube 链接只入队单个视频。
- **即刻开播。** 房间空闲时提交的歌立刻开播，所有客户端跟着切；队列里的歌唱完自动切下一首——切歌由插件完成，整晚只有第一次手势。
- **房主控制。** 跳过、移出、调序（拖拽 / 置顶按钮 / 方向键）、重播已播歌曲——在管理后台或插件弹窗里做。
- **两条房间规则。** 允许队列重复点同一首；公平轮唱，每人限一首。
- **撤回与历史。** 客人随时能撤回自己点的歌；播过的进已播历史，一键回队。
- **实时，为手机优化。** 所有变更走 SSE，实测约 20 ms。手机浏览器会冻结后台标签、掐断 SSE，所以每个页面回前台即对账，可见期间每 5 秒轮询兜底。
- **完全离线的局域网栈。** 服务端、两个页面和插件都是原生 JS，零依赖；不取任何 CDN 资源或字体，全部东西都在这个仓库里。
- **三语界面**（英 / 简 / 繁），页头切换；服务端生成的提示跟随页面所选语言。
- **Chromium 与 Firefox。** 一份 MV3 插件两端通跑：Chromium 用 service worker 跑后台，Firefox 用 event page。

关于元数据：B 站高负载时会限流元数据接口（常见 HTTP 412），但点歌不会失败——服务端有 24 小时缓存，接着会改抓视频网页解析 `window.__INITIAL_STATE__`；只有视频 ID 本身无效（code -400/-404）才拒绝提交。YouTube 元数据走官方免 key 的 oEmbed 接口（标题、作者、缩略图；无时长）。两路都拿不到元数据时（已删除、地区受限，或网络到不了），曲目按纯链接入队，照样能播，标注"元数据未获取"。

## 构建与安装

**要求：Node ≥ 18**（用内置 fetch）。抓 YouTube 元数据可能还需要代理，见[错误排查](#错误排查)。

### 服务端

```sh
git clone https://github.com/GarytheNoob/karaqueue.git
cd karaqueue
node server/karaoke.mjs            # 默认监听 0.0.0.0:7777，管理后台 0.0.0.0:7778
```

局域网设备访问 `http://<本机局域网 IP>:7777`（macOS 上 `ipconfig getifaddr en0` 可查）。环境变量：

| 变量 | 含义 |
|---|---|
| `PORT` / `HOST` | 点歌页端口（默认 7777）/ 绑定地址 |
| `ADMIN_PORT` | 管理后台端口，默认 7778 |
| `KARAQUEUE_VIEW_API` / `KARAQUEUE_SPI_API` | 覆盖 B 站接口地址（测试用）；`KARAQUEUE_OEMBED_API` 同理覆盖 YouTube |
| `KARAQUEUE_PROXY` | 跨网请求强制走代理，写法 `host:port` 或 `http://host:port`。不设时读 `HTTPS_PROXY`，再退回 macOS 系统代理。只对公网目标生效；本机、局域网和 B 站一律直连 |

### 浏览器插件

**Chromium（Chrome/Edge）：**

1. 从[最新 Release](https://github.com/GarytheNoob/karaqueue/releases/latest) 下载插件 zip（或直接用本仓库的 `extension/` 目录）并解压。
2. 打开 `chrome://extensions`，开启开发者模式，点**加载已解压的扩展程序**，选解压出的目录。
3. 点工具栏 KaraQueue 图标确认服务地址。默认 `http://127.0.0.1:7777`；服务跑在别的机器上就改成那台机的局域网地址再保存。

**Firefox：**

1. 拿到同一个 zip，三选一：
   - `about:debugging` → 此 Firefox → **临时载入附加组件**，直接选 zip（临时安装，重启 Firefox 后消失）；
   - 用 `npx web-ext run --source-dir extension/` 做开发，源码改动自动重载；
   - 想常驻：换用 Firefox Nightly / Developer Edition，在 `about:config` 把 `xpinstall.signatures.required` 设为 `false`，再用附加组件管理器的"从文件安装附加组件"装 zip。
2. Firefox 安装时授予站点访问；权限缺失时，在弹窗里重新保存地址会再次发起授权，或在附加组件管理器的"权限"页手动开启。

客人什么都不用装：手机直接开 `http://<本机局域网 IP>:7777`。

## 使用方法

### 快速开始

1. 大屏电脑启动队列服务。
2. 大屏打开第一个视频——手动开，或用插件弹窗的"打开 / 播放当前曲目"。浏览器拦截自动播放时，点一次右下角的"继续播放"，这是整晚唯一一次交互。
3. 客人扫页面侧栏里的二维码进点歌页，开始点歌。
4. 房主通过插件弹窗或管理后台管理房间。
5. 一首播完，插件自动切下一首。

### 客人（点歌页）

- 提交表单认得上面所有链接形态，重复提交用人话报错拒绝。
- NOW / NEXT 卡片显示正在播放和下一首；队列行对本人点的歌带 ✕ 撤回按钮。
- 长标题不折行：悬停（触屏则点一下）才向左滚一遍，滚到末尾停住；放得下的标题不滚。
- 提交和撤回的结果用屏幕底部的短 toast；失败会原样复述服务器的本地化句子，4.5 秒后消失（点击可提前关掉）。
- 页头可折叠抽屉（☰）显示主机的 Wi-Fi 名称、局域网地址和直达点歌页的二维码。二维码编码的是当前请求实际到达的地址，VPN、隧道接口不会把它带偏。
- 已播历史在二级页面，旧的在上、带序号——序号 1 是全场第一首；"再点一次"把歌曲排回队列。
- 手机端没有跳过按钮，切歌是房主的职责。

### 房主（管理后台 / 插件弹窗）

- 跳过当前曲目，立即生效——弹窗或后台都能发。
- 管理队列：移出（✕）、按住把手拖拽、"提前"一键置顶、聚焦把手后按 ↑ / ↓ 方向键。
- 重播已播的任意一首：排回队列；房间空闲时立刻开播。

### 房间规则

后台里是两个开关：

- **允许队列重复。** 关（默认）：正在播放或已在队列的重复提交会被拒绝；开：同一首歌可以叠多条。
- **公平轮唱，每人限一首。** 开启后每人同时最多一首在唱或在排。识别用浏览器 Cookie，改昵称、刷页面都不影响。被锁定期间，这个客人的"加入队列"按钮置灰、昵称输入框锁定，直到自己的歌唱完。撤回队列里的歌会释放名额。

### 语言

两个页面顶部都是 `En | 简 | 繁` 段式切换（滑动的胶囊高亮，不是下拉框）。选择存在浏览器里，刷新不丢，默认简体中文。界面文案在 `server/static/i18n/`，每个语言一个 JSON；服务端生成的提示（拒绝、警告）通过 `X-Karaqueue-Lang` 请求头跟随页面语言。不带这个头的调用方——比如插件弹窗——看到的是中文。

## 错误排查

- **弹窗报 `TypeError: Failed to fetch`：** 配置的地址没有应答。先确认服务在大屏机器上跑着（`node server/karaoke.mjs`），再用浏览器开 `http://<大屏 IP>:7777/api/state`，能看到 JSON 就说明服务正常。
- **弹窗报 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON：** 配置的地址返回了网页而不是 KaraQueue 的 JSON，基本都是漏了 `:7777`、请求打到了 80 端口的别的服务（比如路由器管理页）。地址要写成 `http://192.168.1.5:7777` 这种形式。
- **不自动切歌 / 跳过上报被无视（Firefox）：** 插件没有站点访问权限。开 `about:addons` → KaraQueue → 权限，或在弹窗里点一次**保存**并再次批准授权。
- **YouTube 条目一直"元数据未获取"、总按纯链接入队：** 服务器直连不上 youtube.com，也没找到代理。打开 macOS 系统代理（HTTP 模式，只开 SOCKS 不算），或设 `KARAQUEUE_PROXY=127.0.0.1:7890`（端口填代理的），然后重启服务端。启动日志会写它发现了哪个代理。
- **大屏不停开新标签页：** 那台机上的插件是旧版。到 `chrome://extensions`（或 `about:debugging`）重载一次。
- **页面在跳过等操作后没跟上：** 手机浏览器冻结后台标签、掐断 SSE。把标签切回前台——回前台即对账，可见期间每 5 秒轮询兜底。
- **切歌在歌曲结尾附近变慢或抢跳：** 播放器自身的连播在和插件抢。关掉 B 站"自动连播"，关掉 YouTube 的"自动播放下一个视频"。

## 贡献

欢迎 PR。保证局域网好放养的几条底线：

- **零运行时依赖。** 服务端和页面是原生 JS，只用 Firefox 与 Chromium 一致的 Web API；新功能不应引入 npm 包、构建步骤或 CDN 资源。
- **设计 token 每个端一份：** 服务端页面在 `server/static/ui/theme.css`，插件在 `extension/popup.css`——插件回抄 tokens，因为扩展页面加载不了服务端的文件。
- **交互改动要验证。** 惯用流程：本地预览服务，CDP 驱动的页面检查覆盖每种状态（正常、空、超长内容、报错），`node --check` 过语法，最后目检确认。
- **提交格式：** `feat(scope): …` / `fix(scope): …` / `docs:` / `chore:`，scope 取 `server` 或 `extension`。
- **仓库结构：**

  ```
  server/karaoke.mjs      队列服务，只用 Node 内置模块
  server/static/          点歌页与管理后台（无框架单文件）
  server/static/i18n/     界面文案，每语言一个 JSON，附共享 i18n 内核
  server/static/ui/       两页共享部件：设计 token 与浏览器端部件
  extension/              浏览器插件（MV3）
  ```

- **新增翻译：** 复制 `server/static/i18n/zh-CN.json` 翻译值，把语言代码注册进 `static/i18n/i18n.js` 的 `I18N_LANGS`，并在 `I18N_SWITCH_CAPTION` 加段名。文档变更时两份 README 一起改。

## Misc

### 接口速览

调试用，全部 JSON：

- 公共：`GET /`、`GET /api/state`、`GET /api/events`（SSE）；`POST /api/submit` `{input, by, uid}`、`POST /api/withdraw` `{id, uid}`、`POST /api/advance`、`POST /api/skip`
- 管理端口（7778）：另有 `GET /api/config`、`POST /api/config` `{allowQueuedDuplicates, oneSongPerGuest}`、`POST /api/delete` `{id}`、`POST /api/reorder` `{id, direction: up|down|top}` 或 `{id, index: 从0开始的落位}`、`POST /api/rerequest` `{id}`

### 状态与复位

队列在 `server/queue.json`，元数据缓存 `server/meta-cache.json`，两个文件都已 gitignore。状态诡异就 `pkill -f karaoke.mjs` 再重启；想彻底清空删掉这两个文件。

### 已知限制

- 仅限局域网，明文 http，无 TLS、无登录——局域网里的任何人都能打开管理后台。
- 仅 B 站和 YouTube；歌单按单个视频处理；niconico 暂未纳入。
- 服务端和大屏浏览器都需要能连上 YouTube 的网络路径（直连或代理）；B 站一律直连。
- 公平轮唱和撤回的归属按浏览器（uid Cookie）算，不按昵称。
- 重启后会话从 `server/queue.json` 恢复；删两个状态文件即干净开局。

### 附注

- **免责声明：** 本项目与哔哩哔哩、YouTube 无关联。视频一律通过各家官方网页播放器播放，服务端只请求公开接口解析标题等元数据。
- 以 [MIT 许可证](LICENSE) 发布。
