# Nikokara Player

局域网点歌机原型：手机提交 BV 号/链接，队列服务维护顺序，Chrome 插件驱动 bilibili 标签页自动连播。

设计与背景调研见 [PROPOSAL.md](PROPOSAL.md)。

## 组成

- `server/karaoke.mjs` — 队列服务（零 npm 依赖，Node 内置模块实现）
- `server/static/index.html` — 手机点歌页（无框架，单文件）
- `extension/` — Chrome 插件（MV3），驱动 B 站原生标签页播放

## 运行

要求：**Node ≥ 18**（用到内置 fetch）。

```sh
node server/karaoke.mjs
# => [karaoke] queue server on http://0.0.0.0:7777
```

局域网内其他设备访问 `http://<本机局域网IP>:7777` 点歌（启动时日志未打印 IP，可用 `ipconfig getifaddr en0` / `ifconfig` 查询）。

## 安装插件（Load unpacked）

1. Chrome 打开 `chrome://extensions`，右上角开启 **开发者模式**
2. **加载已解压的扩展程序** → 选择本仓库 `extension/` 目录
3. 点击工具栏的 Nikokara Player 图标，确认服务地址（默认 `http://127.0.0.1:7777`；若服务跑在别的机器上改成对应 IP 并保存）

## 使用流程

1. 大屏电脑上启动队列服务
2. 在大屏 Chrome 里手动打开第一个视频（或用插件弹窗"打开当前曲目"）；**播放开始时如果浏览器拦截自动播放，点一次右下角"继续播放"** —— 这是本会话唯一需要的一次手势
3. 大家手机点歌；一首播完，插件会自动把标签页切到下一首
4. 手机端"跳过"会在 ≤15 秒内被插件同步（轮询对账）

## 注意事项 / 已知边界

- **请关闭 B 站播放器的"自动连播"**，否则页面原生连播会和插件切歌竞争
- 队列状态持久化在 `server/queue.json`（已 gitignore）；解析失败的元数据会降级为"仅 BV 号"条目
- B 站元数据来自公开 web 接口，频繁点歌有触发风控的可能（原型未做节流，单房间使用量级基本无风险）
- 暂不支持 YouTube / niconico（resolver 遇到会报错提示，属预期行为）
