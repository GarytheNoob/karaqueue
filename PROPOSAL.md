# Nikokara Player — 设计提案（Draft v0.1）

> 目标：一个可以动态接受"点歌"的播放系统 —— 用户提交 bilibili（后期含 YouTube）的 MV / ニコカラ视频，按顺序自动播放，播完自动切下一个。
> 使用场景： ニコカラ / K歌房 / 同好聚会自娱自乐。

---

## 1. 背景调研：B 站的"多人合作 playlist"现状

### 1.1 结论先行

**B 站没有 YouTube 那样的"协作播放列表（Collaborative Playlist）"功能。** B 站当前的 playlist 生态分为以下几类，逐一分析它们能否满足"多人同时点歌"：

### 1.2 可选机制盘点

| 机制 | 是什么 | 多人共同编辑？ | 适合点歌场景？ |
|---|---|---|---|
| **收藏夹（Favlist）** | 用户私有/公开收藏夹，只有所有者能增删内容 | ❌ 仅本人可添加（可分享"查看"，不能协同编辑） | ⚠️ 最多只能作为静态歌单备份 |
| **合集（Collections）** | UP 主创作中心管理的分集结构，只能是 UP 本人维护 | ❌ 仅 UP 主可编辑，且要求稿件过审、单 P | ❌ 面向创作者，不适合观众点歌 |
| **联合投稿（Co-authoring）** | 一条稿件最多 10 位 STAFF 共同署名 | ❌ 这是"投稿合作"，与 playlist 无关 | ❌ 完全不相关 |
| **YouTube 协作播放列表**（对照组） | 播放列表可开启 Collaborate 开关，分享邀请链接，好友可添加视频，甚至有投票排序 | ✅ 原生支持 | ✅ 若平台是 YouTube，几乎没有必要自建 |

> 补充：B 站收藏夹连播（网页/APP "播放全部"）只能按收藏夹固定顺序播，且存在已知质量问题（如收藏夹随机播放在大列表下会漏视频、循环播同一批视频，社区已在 Bilibili-Evolved 等插件仓库提出过相关 issue）。生鲜动态也没法实时感知"谁在点歌"。

### 1.3 小结

- 如果只做 YouTube：**可以直接用官方协作播放列表**，配合一个本地播放器（iframe embed + onStateChange 监听 ENDED 事件）即可自动切歌，不需要自建队列服务。
- 但 B 站既没有协同 playlist，也没有官方 playlist API 给第三方实时写入（收藏夹写入接口虽为私有 API 但频繁操作有风控风险，不适合点歌这种高频实时场景）。
- 所以**如果目标是覆盖 B 站（以及ニコカラ常驻的 bilibili/Niconico 双平台），自建队列层是不可避免的** —— 而一旦队列层自建了，同一套架构天然可以覆盖所有平台，YouTube 官方协作 playlist 只是需要"兼容接入"的其中一种数据源。

---

## 2. 自建软件的架构 Proposal

### 2.1 总体思路

把系统拆成三层：**换台（点歌/互动）层、队列编排层、播放器适配层**。核心思想是：

> **队列与播放解耦，平台与业务解耦。**
> 所有点歌统一进入一个自维护的播放队列；不管视频来自 bilibili、YouTube 还是 niconico，都会在播放前被"翻译"成播放器能理解的标准接口。

```
┌─────────────────────────────────────────────────────────┐
│                    用户触点层                 │
│   Web 点歌页 │ 手机扫码上传 │ 命令行/Discord Bot（可选）      │
│   （输入 BV号 / niconico URL / YouTube URL）              │
└───────────────┬─────────────────────────────────────────┘
                │ HTTP / WebSocket
┌───────────────▼─────────────────────────────────────────┐
│                队列编排服务 (Queue Server)                 │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌─────────┐ │
│  │ 点歌入库  │→│ 队列排序  │→│ 播放推进器  │→│ 状态广播  │ │
│  │ Resolve  │  │ Shuffle/ │  │ AutoNext  │  │(WS 推送) │ │
│  │ 元数据抓取│  │ 优先级   │  │ (播完→下首)│  │          │ │
│  └──────────┘  └──────────┘  └───────────┘  └─────────┘ │
│      持久化：SQLite (queue / played_history / users)      │
└───────────────┬─────────────────────────────────────────┘
                │ 标准化的 "PlayableTrack" 数据结构
┌───────────────▼─────────────────────────────────────────┐
│                播放器适配层 (Player Adapter)               │
│  ┌──────────────┐ ┌──────────────┐ ┌────────────────┐   │
│  │ BilibiliSrc  │ │ YouTubeSrc   │ │ NiconicoSrc    │   │
│  │ (bplayer/    │ │ (YT iframe / │ │ (embed player) │   │
│  │  iframe/pendant)│  Player API)│                │   │
│  └──────┬───────┘ └──────┬───────┘ └───────┬────────┘   │
│         └────────────────┴─────────────────┘            │
│                    统一播放器壳 (Player Shell)             │
│      - onEnded → 通知 QueueServer 推进                  │
│      - 播控（暂停/跳过/重播/音量）                          │
│      - 弹幕渲染（可选，ニコカラ氛围）                        │
└─────────────────────────────────────────────────────────┘
```

### 2.2 关键技术决策点

#### A. 视频源：iframe 嵌入 vs 本地流（下载后播放）

这是整个项目最大的架构分叉点，需要先拍板：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A1: `<iframe>` 官方播放器嵌入** | 合规、零成本、能带弹幕(B站)和官方播放控件 | 控制力有限（难以自定义 UI / 精确 seek）；跨平台 UI 不统一；部分页面有 X-Frame-Options 限制 |
| **A2: 本地解析流（下载/直链，借助如 yt-dlp、bilibili 播放接口）** | 完全自定义播放器、支持多平台统一 UI、可以做卡拉OK歌词同步等进阶功能 | 合规风险（DRM/防盗链/风控），实现复杂度高，需持续维护解析器 |
| **A3: 混合**（默认 iframe，特定需求走本地） | 短期见效，长期演进 | 架构需提前设计好 Source 抽象 |

**建议 MVP 选 A1（iframe 嵌入）先把流程跑通**；若后续做ニコカラ专属功能（如"本地字幕/伴奏替换"、歌词条展示），再升级到 A3。

#### B. "播完自动下一首"的实现

有两条路径，可同时保留：

1. **客户端驱动（推荐 MVP）**：iframe 播放器事件（B站播放器有 `ended` 事件；YouTube iframe API 有 `onStateChange → ENDED`）。客户端收到后 `POST /queue/advance`，服务端返回下一首。
   - 优点：简单、实时、无需复杂状态机。
   - 风险：用户关掉页面就没人推进了 → 需超时兜底逻辑。
2. **服务端驱动（增强）**：服务端记录每首歌时长，到达 `start_time + duration + ε` 时主动通过 WebSocket 推送"切歌"事件。
   - 优点：即使没人在看也能推进队列、编辑队列不受客户端存活影响。
   - 缺点：需要精准时长元数据（bilibili 的 API 有 `duration` 字段，可用）。

**推荐：MVP 用客户端驱动 + 服务端时长兜底超时；V2 再切到纯服务端驱动。**

#### C. "点歌" 的输入解析

需要一个统一的 `TrackResolver` 模块，把用户输入规范化：

```
输入可能是：
  BV1xx411c7mD           → bilibili
  https://www.bilibili.com/video/BV1xx411c7mD?p=3
  av170001
  https://www.youtube.com/watch?v=xxxx
  https://www.nicovideo.jp/watch/sm9
```

- 解析规则：正则/URL 解析 → 判定平台 → 提取唯一 ID（BV号/av号/videoId/sm号）→ 元数据查询。
- **B 站元数据**：官方公开接口有限，但 `https://api.bilibili.com/x/web-interface/view?bvid=BVxxxx` 这类网页接口广泛可用（需注意 UA、限频、风控；不要依赖未公开接口的高频调用）。
- ⚠️ **分P 处理**：ニコカラ经常一个视频里的多个分P是不同调（原调/男声调/女声调），所以 `PlayableTrack` 应包含 `bv_id + page` 字段， resolves 时把"P3"单独识别出来。

#### D. 队列公平性（点歌场景特有）

普通 playlist 是"固定列表"，点歌系统是"动态队列"，需要决定排序策略：

- **FIFO（先到先播）**：最直觉，符合"点歌机"心智。
- **轮转公平（Round-Robin per user）**：避免同一个人连刷 20 首，类似 K 歌房机制。
- **投票/插队/删除**：多人场景常见功能，但 MVP 可以不做。
- **ニコカラ特色**："连播同一系列"、"别人点过的歌半小时内不能重复" 等小约束可以后加。

**MVP：纯 FIFO + 去重（已在队列/最近10首内的歌提示但不拒绝）。**
**V2：按点歌人轮转公平。**

#### E. 多人参与方式（实时协同）

B 站不能协同，但我们自己可以做：

| 参与方式 | 实现成本 | 体验 |
|---|---|---|
| **同一局域网 web 页面**（手机扫码/输入房间 IP） | 低 | 每人一部手机打开点歌页即可 |
| **房间号 + WebSocket 实时同步** | 中 | 每人看到同一个队列、可点赞/插队 |
| **接入 Discord/QQ Bot** | 中 | 缺席场景也能点歌 |
| **公开房间里加"投币点歌"之类趣味功能** | 高（需要账户体系） | 暂不在 MVP |

**MVP：单机局域网 + 简单 Web 点歌页（不用账号，只记一个 nickname）。**

### 2.3 模块拆分与数据流

```
用户手机 ──POST /api/queue/submit {raw_input, by:"Gary"}──▶ queue-api
Queue Server:
  1) TrackResolver.resolve(raw_input) → { platform, video_id, page, title, duration, thumbnail, uploader }
  2) DedupFilter.check()  → 提示重复
  3) Enqueue → DB写入 queue 表
  4) Broadcast via WS → 所有客户端刷新队列 UI

Player Shell (主屏幕，比如一台连电视的电脑/平板):
  - 订阅 WS → 收到 current_track_changed → 加载新 iframe
  - 监听 ended / 服务端超时事件 → POST /api/queue/advance
  - 弹幕/歌词区（V2）
```

### 2.4 数据库 Schema（Draft）

```sql
CREATE TABLE queue_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform     TEXT NOT NULL,          -- 'bilibili' | 'youtube' | 'niconico'
  video_id     TEXT NOT NULL,          -- BV号/av号/YouTube id/sm号
  page         INTEGER DEFAULT 1,      -- 分P序号
  title        TEXT,
  uploader     TEXT,
  duration_s   INTEGER,                -- 用于服务端超时兜底
  thumbnail    TEXT,
  requested_by TEXT,                   -- 点歌人昵称
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  status       TEXT DEFAULT 'pending', -- pending/playing/played/skipped/failed
  started_at   DATETIME,
  finished_at  DATETIME
);

CREATE TABLE recent_plays (
  ...  -- 用于"最近播过"去重、以及 Khi 在歌单里查看历史
);
```

### 2.5 技术栈推荐（T型：Web端为主）

| 层 | 推荐 | 理由 |
|---|---|---|
| 前端（点歌页 + 播放器壳） | **Next.js / Vite+React（或 Svelte）** | 单仓库同时承载两个页面；iframe 控制逻辑需要 JS |
| 后端 | **Node.js (Fastify/Hono) + WebSocket** | 前端同栈；低延迟广播队列状态 |
| 数据库 | **SQLite（更小项目）/ Postgres（若多房间）** | 点歌场景并发极低，SQLite 足够 |
| 部署形态 | **单二进制/单 Docker 容器，本地跑** | K歌房场景最可能没有公网服务器；局域网跑起来即可 |
| 平台适配器 | **可插拔模块**（`/sources/bilibili.ts` 等） | 便于以后加 YouTube / niconico |

> 未来如果想上 NAS 或树莓派挂在客厅电视上跑，建议后端尽量轻量，Docker 单容器启动。

### 2.6 MVP vs V2 vs V3 路线

| 阶段 | 目标 | 关键能力 |
|---|---|---|
| **MVP (2-4周)** | 一台电脑跑起来，手机点歌，自动连播 | BV号/URL 解析；bilibili iframe 播放；Web 点歌页；FIFO 队列；播完 auto-next |
| **V2 (再 2-4 周)** | 体验升级 | youtube 适配器；服务端时长兜底切歌；轮转公平；弹幕点歌可视化；错误重试（视频失效提示） |
| **V3** | 社区化 | 多房间；QQ/Discord Bot；歌词条/卡拉OK字幕同步；用户账户与收藏同步 |

---

## 3. 风险与待验证项（Pre-mortem）

1. **B 站接口风控**：频繁抓元数据可能触发风控。缓解：缓存元数据（SQLite 里落盘）、限频、失败降级（仅存 BV 号也能播）。
2. **iframe 播放限制**：<iframe> 嵌 B 站视频目前用 `//player.bilibili.com/player.html?bvid=` 是可行的，但**自动播下一首是否被浏览器策略拦截（autoplay）**需要实测 —— 用户上一次有交互 gesture 可解锁 autoplay。
3. **分P识别体验**：用户粘 URL 时经常粘到带 `?p=3` 的链接，务必测好。
4. **视频下架/审核中/私有稿件**：队列里要有 `failed` 状态和 UI 可见性，不能默默吞掉。
5. **播放控制**（暂停/跳过）如果只在主屏幕脑，手机点歌端能否"跳过"昵称显示权限，需要在 V2 设计简单的"房主"机制。

---

## 4. 一句话抓手（Pitch）

> **自建一个"点歌机"，用 iframe 嵌入各平台官方播放器、用一个本地 Web 服务维护动态队列。MVP 只做 bilibili，两周内可跑通；架构里预留 Source 抽象，将来加 YouTube / niconico 只需新增一个适配器。**

---

## 5. v0.2 架构修订（已确认约束）

已在讨论中确认的三个约束：

1. **同一房间网络**（局域网内使用，无公网需求）
2. **尽可能轻量化**（最好零依赖、单机一键启动）
3. **播放客户端希望做成浏览器插件**（而非独立 App / iframe 页面）

### 5.1 插件方案的意外收益

用浏览器插件直接驱动 **bilibili 的原生视频页**（而不是 iframe 嵌入），一次性解决了 v0.1 中的多个风险项：

| v0.1 的风险 | 插件方案下的变化 |
|---|---|
| iframe 播放限制 / UI 不统一 | ✅ 直接在 B 站原生页面播放，弹幕、高清、播放控件全都是原生的 |
| autoplay 被浏览器策略拦截 | ✅ 用户在大屏上手动打开第一个视频（一次手势）后，插件用 `chrome.tabs.update` 桌面级导航打开后续视频，同 tag 首次过检后基本不再受限 |
| B 站播放器事件难拿 | ✅ Content Script 直接挂在视频页面里，`video` 元素的 `ended` 事件随手可得，还能拿到真实播放进度 |
| 需要独立播放器壳 UI | ❌ 不需要了，省掉一大块前端工作 |

### 5.2 修订后的架构

```
┌──────────────────────────────┐
│  点歌端：手机浏览器（局域网）           │
│  http://<大屏电脑IP>:7777             │
│  - 单页表单：贴 BV号/URL + 昵称          │
│  - 队列列表 + "已播历史"                  │
└───────┬───────────────────────┘
        │ HTTP POST / SSE（见 5.3，零依赖选型）
┌───────▼───────────────────────┐
│  服务端：src/karaoke.mjs（单文件）      │
│  - POST /api/submit   解析+去重+入队     │
│  - GET  /api/state    当前队列/正在播   │
│  - GET  /api/events   SSE 广播状态变更   │
│  - POST /api/advance  播完推进（插件调用）│
│  - POST /api/skip     跳过（可加房主权限） │
│  持久化：queue.json（放弃 SQLite，见 5.3）│
└───────┬───────────────────────┘
        │ HTTP POST（content script → SW 转发）
┌───────▼───────────────────────┐
│  播放端：Chrome 插件 (MV3)             │
│  ├ content script                     │
│  │   挂在 bilibili/video 页面：          │
│  │   - 监听 <video> ended → 通知 SW    │
│  │   - (V2) 读取进度供超时兜底           │
│  └ background service worker          │
│      - 轮询/SSE 订阅服务端               │
│      - 收到 current_track_changed      │
│        → chrome.tabs.update(下一首URL) │
│      - 每首歌的 URL 由服务端下发           │
│        （含分P参数 bv+p）                │
└──────────────────────────────┘
```

**一句话描述交互闭环**：大屏电脑开着 B 站视频页 + 装好插件；服务端一个终端跑起来；大家手机连 `http://<IP>:7777` 点歌；插件检测到当前视频播完 → 问服务端要下一首 → 服务端返回带分P的完整播放 URL → 插件把当前标签页导航过去 → 继续。**全场唯一常驻 UI 就是浏览器里的一个 B 站标签页。**

### 5.3 轻量化选型（对比 v0.1 的降级）

| 项 | v0.1 方案 | v0.2 方案 | 理由 |
|---|---|---|---|
| 后端框架 | Hono/Fastify | **Node 原生 `http` 模块，零 npm 依赖** | 端点少（submit/state/events/advance/skip），手写完全可控；SSE 用原生 `http` 即可实现，连 WebSocket 库都省了 |
| 启动方式 | Docker 容器 | **`node karaoke.mjs`（可选打包成单可执行文件）** | K歌房现场最好"拷过去就能跑"；依赖为 0 意味着不会有 npm install 意外 |
| 数据库 | SQLite | **`queue.json`（启动时读入内存，写操作原子落盘）** | 数据量极小（一晚几十条）；避免原生模块编译；坏了也只是丢队列不丢钱 |
| 实时推送 | WebSocket | **SSE (Server-Sent Events)** | 单向够用（服务端→手机端广播）；零依赖；自动重连是浏览器原生行为 |
| 播放器 | iframe 壳页面 | **浏览器插件驱动原生标签页** | 见 5.1，收益巨大 |
| 部署目标 | 单容器 | **先支持 macOS/任意桌面机** | 房间场景不需要服务器 |

### 5.4 插件的技术要点

1. **MV3 Service Worker 休眠**：SW 在空闲约 30 秒后会被浏览器杀掉。对策：
   - 不依赖 SW 常驻；content script 检测到 `ended` 时**主动**通过 `chrome.runtime.sendMessage` 唤醒 SW 并执行 advance。
   - 队列状态同步改为"每次需要时拉取"，而不是 SW 长连接维持。
2. **SPA 路由感知**：B 站视频页是 SPA，插件需要监听 `history.pushState` / URL 变化来重新绑定（navigate 到下一首时 URL 变化触发 content script 重新初始化）。
3. **分P跳转**：下一首 URL 形如 `https://www.bilibili.com/video/BVxxxx?p=3`，content script 可在页面加载后校验当前 P 与目标一致，不一致时纠偏。
4. **播放控制**（暂停/跳过从手机发起）→ V2：服务端广播 `skip` 事件，SW 通过向 content script 注入 `player.seek(0)/ended` 事件或直接模拟。隐私上一个大屏标签页所有人可见，权限模型可以很低。
5. **首次启动**：服务端 `GET /api/state` 返回"当前应播放"的 URL，插件安装后可一键打开；或房主手动打开第一首（需要的那一次点击手势由此产生）。
6. **多平台预留**：MV3 的 content script `matches` 是清单配置，将来加 `*://*.youtube.com/*`、`*://*.nicovideo.jp/*` 即可，配合统一的 `ended` 检测逻辑；服务端的 `resolve` 层不变。

### 5.5 修订后的里程碑

| 阶段 | 范围 |
|---|---|
| **MVP-1** | `karaoke.mjs`（submit/state/advance + queue.json）+ 手机点歌页 + B 站插件（ended→advance→tabs.update）跑通 bilibili 单平台 |
| **MVP-2** | 失效视频容错（自动跳过 + 队列标注）、去重提示、房主"跳过"按钮 |
| **V2** | YouTube/niconico 适配（插件 matches + resolver 扩展）；按点歌人轮转公平；播放历史持久化为歌单 |
| **V3** | 弹幕/点赞可视化、多平台搜索建议（用户只记得歌名不记得 BV号） |

### 5.6 仍然存在的风险

1. **插件商店 vs 本地加载**：自用完全可以 Developer Mode + "Load unpacked"，无需上架（也就不用审 review）。
2. **B 站页面改版**：content script 依赖的 DOM（`<video>` 元素位置）可能随改版失效，但 selectors 极稳定（`video` 标签本身），主要风险在 P 参数校验，写兜底逻辑即可。
3. **上传/URL 解析容错**：不同用户粘贴的格式五花八门（短链 `b23.tv`、移动端 URL），resolver 需要处理 301 展开或直接解 B23 短链。
4. **手机页面缓存**：SSE 断线后要拉一次 `/api/state` 做全量对账，否则队列 UI 会失真。
