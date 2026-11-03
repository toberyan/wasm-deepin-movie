# Remaining Work Analysis

Date: 2026-11-03. Baseline: `cee63d1` + current working tree.
Evidence: 78 unit tests, 9 browser e2e tests, `pnpm check`, `pnpm build`.

## 1. Short conclusion

P0 的功能面已经走通：核心架构、WebCodecs/WebGL2/AudioWorklet、真实浏览器播放、
HTTP Range、5 GiB 稀疏文件、100 次开关、JASSUB ASS、MCP Companion，以及自建
ST/MT WASM 变体的 AVI/MPEG-4/MP3 与强制 H.264/AAC/HEVC/AC-3 回退均已验证。

P0 还不能宣布完全退出，主要剩两类：

1. **证据门禁**：物理 GPU 基准机上的 1080p30 10 分钟、2 小时长稳、进程内存、
   GPU context loss；真实 >4 GiB 实片（当前只有稀疏扩展 MP4）。
2. **打包优化**：单体 `wasm-player-p0` 尚未拆成 `demux-common`/`decode-*` 并按需
   加载；MT 产物已构建但运行时仍用 ST；AVI 默认路径需要手动 `?libav=wasm-player-p0`。

P1 的产品化缺口最大：多轨切换、内嵌字幕/字体、存储持久化、Host/Agent SDK、
完整 UI、兼容矩阵和发布硬化仍需要成体系的工作。

## 2. 现状审计

| 模块 | 现状 | 主要缺口 |
| --- | --- | --- |
| contracts | 动作/设置/事件/错误/能力/schema 完整；46 个 MCP 工具 | 设置描述分组过滤未生效；部分动作输出仍是空对象 |
| player-core | Controller、revision、去重、设置分层、jobs、内存版列表/历史/书签/预设 | 无持久化；历史位置不更新；播放列表循环未实现；视频/音频切轨未实现 |
| source-readers | File/HTTP Range/稀疏；206/ETag/200 回退/取消单测 | 无 Range 源的浏览器 e2e、整片下载缓存、读失败时 AVIO 解阻塞 |
| ffmpeg-adapter | 自定义变体 ST/MT；AVI/MPEG-4/MP3、H.264/AAC/HEVC/AC-3 WASM 解码；seek/flush | 单体包；无 VP8/VP9/AV1 WASM 解码器；无自动变体选择；章节/附件内容未提取；MT 未运行时验证 |
| webcodecs-adapter | Video/Audio Worker、config/支持探测 | 单轨；运行时失败回退仅到 WASM 路由层；未做故障注入 |
| renderer | WebGL2 主线程；亮度/对比度/饱和度/Gamma/适配；截图 | 无 WebGPU 后端；无 YUV 直通；无旋转/翻转/裁切/平移/锐化；缩放仅线性；截图不含 ASS 样式 |
| audio | AudioWorklet、PCM 队列、音频主时钟、音量/静音/倍速 | 无 SAB 环形缓冲；无 EQ/平衡/单双声道/延迟/增益/防削波/保留音调变速/输出设备 |
| subtitles | SRT/VTT 解析、外挂 ASS via JASSUB、文本 overlay | 无内嵌字幕包提取、字体附件、编码选择 UI、双字幕、ASS 强制覆盖、PGS/VobSub |
| storage | 包存在但无 `src` | 无 IndexedDB/OPFS/PWA/迁移/媒体身份 |
| host | 包存在但无 `src` | BrowserHost 在 app 内；无 CompanionHost/DesktopHost；PiP/saveFile/pickFiles 未统一 |
| agent-sdk | 缺失 | 无类型化 SDK、事件游标、重连/去重客户端 |
| mcp-server/Companion | stdio MCP、loopback WS、Range broker、46 工具、安全校验 | 无 Streamable HTTP/远程 relay；capture 二进制未通过 MCP 返回；长连/重连/配对撤销未测；无签名分发包 |
| apps/web | 打开/拖放、播放控制、基础设置、轨道列表、截图、统计、Companion 状态 | 无列表/历史/书签 UI、命令面板、快捷键配置、主题切换、预设/搜索/高级设置、PWA、完整 a11y |

空包/缺失包：`packages/host`（无 src）、`packages/storage`（无 src）、
`packages/agent-sdk`（目录缺失）。

## 3. P0 剩余（G0 前）

| 项 | 现状/风险 | 下一步 |
| --- | --- | --- |
| 1080p30 10 分钟、2 小时长稳、进程内存、GPU context loss | 未执行；headless SwiftShader 不是有效门禁 | 在物理 GPU 基准机跑 `tests/perf` 并归档 `docs/reports/performance-*`/`soak-*` |
| 真实 >4 GiB 实片 | 只有 5 GiB 稀疏扩展 MP4；不能证明长时长/尾索引真实媒体 | 外部环境准备 >4 GiB 实片，记录读取、seek、常驻内存曲线 |
| 自动变体选择 | 默认预构建变体无法打开 AVI；必须手动 `?libav=wasm-player-p0` | 先按容器/扩展名或 probe 失败自动加载自定义变体并重试；保持 `decodePath` 报告准确 |
| 功能包拆分/按需加载 | 当前单体 wasm ~3.9 MB ST / ~4.1 MB MT | 拆 `demux-common`/`decode-audio-common`/`decode-video-common`，跨实例只传序列化包/帧，按需加载 |
| MT 运行时 | MT 产物与 manifest 已生成；浏览器仍用 ST | 在 COOP/COEP+SAB 环境验证 MT 加载、吞吐、worker 数、回退 |
| 运行时故障注入 | 100 次开关/无效媒体已测；解码器崩溃、GPU context loss、Worker 中断、后台恢复未测 | 加故障注入 e2e；验证 epoch 丢弃、重建、错误码与资源释放 |
| AVIO 读失败解阻塞 | `onblockread` 读失败只记录 `lastSourceError`，未向 FFmpeg 发送终止信号，可能挂起 | 设计有界读超时/EOF 错误路径，并在 HTTP/File 故障注入中验证 |
| 可复现/许可构建 | emsdk 记录 6.0.13 但无固定工具链镜像；未设 `SOURCE_DATE_EPOCH`；自定义 FFmpeg 含专利编码 | 固定 emsdk commit/镜像、源码哈希、可复现构建、SBOM、LGPL source offer、codec 专利评审 |
| 真实 >4 GiB 内存曲线 | 未记录 WASM heap/纹理/网络缓存/Worker 峰值 | 插桩记账并按 2.6 预算复核 256 MiB 目标 |

## 4. P1 可用播放器剩余

### 4.1 媒体与轨道

- **视频/音频切轨**：`selectTrack` 对非字幕轨仍返回 `UNSUPPORTED`；需要重建对应
  decoder/clock/queue，保留位置与兼容设置，并发布 `decodePathChanged`。
- **内嵌字幕**：demux/probe 能列出字幕 stream，但没有提取 subtitle packet/ASS
  内容；需要 FFmpeg subtitle packet 输出、文本/位图分流、字体附件。
- **字体**：JASSUB 当前用默认 Liberation Sans + 外挂 ASS；MKV 附件字体、用户导入
  字体、字体缺失回退与编码选择未实现。
- **章节/附件**：`chapters` 恒为空；附件只有元数据，无内容读取/字体提取。
- **WebM VP9/Opus**：probe/route 已验证；缺少浏览器播放 e2e 和 WebCodecs 不支持时
  的 WASM 回退（自定义变体只有 VP8/VP9/AV1 parser，无 decoder）。
- **HTTP 无 Range**：仅 Node 单测；需要浏览器 e2e、整片下载缓存选项、短读/取消。
- **sourceId/授权源**：纯 Web 不支持；Companion 才做 sourceId→URL 转换；File System
  Access / 目录句柄 / 权限恢复未实现。

### 4.2 存储与列表

- `storage` 包为空。需要 IndexedDB 版本化设置/历史/书签/列表/预设，OPFS 可选缓存，
  迁移/回滚，媒体身份（大小+修改时间+局部摘要），File 句柄权限恢复。
- 当前 `history` 只在内存且 `positionUs` 固定为 0；需要播放中/关闭时更新续播位置、
  完成标记。
- 播放列表、书签、预设仅内存；刷新即丢。UI 也没有列表/历史/书签面板。
- `playback.loop` 只实现单文件循环；列表循环未实现。

### 4.3 UI/宿主

- 主题：`app.theme` 被记录为 applied，但界面始终深色；light/system/reduced-motion
  没有实际生效。
- 缺少 Ctrl+K 命令面板、快捷键配置、设置搜索/预设/高级分组、逐层恢复展示。
- 缺少列表/历史/书签 UI、当前值/单位/默认值/来源层的完整设置 UI。
- `playback.autoPlay` 存了但 UI 打开文件始终 `autoPlay:false`；`volumeStep` 未用于
  键盘音量。
- Host Port：fullscreen 可用；PiP 对 WebGL canvas 不支持（没有 `<video>`）；
  saveFile/pickFiles 未统一；File System Access 未接入。
- PWA/service worker、离线 codec 包缓存、安装清单未实现。
- 可访问性：焦点、键盘全覆盖、对比度、reduced-motion、屏幕阅读器未系统验收。

### 4.4 Agent/SDK/MCP

- `packages/agent-sdk` 缺失；需要类型化 `invoke/getState/subscribe`、事件游标、
  重连、requestId 去重。
- Companion 只有 stdio + loopback WS；无 Streamable HTTP/远程 relay、配对撤销、
  多用户授权、签名分发包。
- capture 任务 `jobs.get` 只返回元数据；MCP 客户端无法取回 PNG/JPEG 二进制。
- `settings.describe` 的 `group` 参数在 MCP 本地处理中未过滤。
- 多标签/多会话的 attach、断线重连、超时、取消、超大/畸形输入、长稳未系统测试。
- 文件 broker 已做 allow-root/realpath/Range；仍需 fuzz/逃逸与安全评审。

### 4.5 测试/发布

- 兼容矩阵仅 Chrome 156/Deepin；无 Chromium/Edge/Windows/macOS/Firefox/Safari。
- CI 不构建自定义 WASM，AVI/H.264/HEVC e2e 会跳过；没有 WASM build job。
- 无 SBOM、依赖许可扫描、性能 nightly、Windows/macOS runner。
- 兼容矩阵结果仍为手写 JSON，不是自动生成。

## 5. P2 核心高级能力

- 画面：hue/色温/RGB 增益、旋转/翻转/裁切/平移/缩放、最近邻/双线性/高质量缩放、
  锐化；明确的 YUV range/matrix/transfer/primaries 契约；截图含 ASS/OSD 的合成。
- 音频：10 段 EQ、平衡、单/双声道、混音、延迟、增益/防削波、保留音调变速
  （LGPL atempo/Web Audio）、输出设备选择。
- 字幕：主副双字幕、ASS 强制覆盖、字体管理；ASS 字体附件。
- 播放：A-B 循环、章节、暂停向前逐帧；反向逐帧延后到 P3。
- 任务/配置：截图/导出任务结果可通过 SDK/MCP 取回；预设、配置导入导出、命令面板、
  主题、快捷键持久化；设置 UI 进阶（搜索/高级/来源层/生效状态）。
- 诊断：队列/丢帧/同步/内存/GPU 可视化与脱敏导出；参考图/PCM 对照测试。

## 6. P3 扩展与稳定

- 旧格式包：ASF/WMV/VC-1/WMA、RM/RMVB/RealVideo、Theora/MJPEG/ProRes/ALAC/APE/
  TrueHD，逐包构建+样本+性能+许可。
- 位图字幕：PGS/VobSub，FFmpeg 位图字幕解码+合成层+裁切位置。
- 反向逐帧：回退前一关键帧+正向解码+有界缓存。
- HDR→SDR/10-bit/WebGPU：分别验收；SDR 基线不得回退。
- HLS/DASH：按需求和许可条件纳入；单独网络/能力矩阵。
- 兼容矩阵自动化、2 小时长稳、100 次开关、后台恢复、断网、GPU/Worker 故障、
  损坏文件、内存曲线。
- 文档、支持矩阵、RC、回滚、发布说明、SBOM、第三方声明。

## 7. P4 / 明确非目标

- Electron 桌面壳、文件关联、目录访问、窗口控制、MCP 无人值守宿主操作；原生解码/
  mpv 需独立验收。
- 非目标：AI 超分、补帧、蓝光菜单、商业 DRM、Dolby Vision 全链路、独占音频、
  音频源码直通、RTSP/RTMP/SRT 直连、移动端同等能力、全部设备 WASM 4K 实时。

## 8. 建议执行顺序

1. **自动 WASM 变体选择 + MT 运行时**（让 AVI/旧格式在默认 UI 可用，关闭 P0 打包缺口）。
2. **切轨 + 内嵌字幕/字体**（P1 媒体核心，影响多音轨/多字幕样本）。
3. **storge 包 + 历史/书签/列表/设置持久化 + UI 面板**（P1 日常可用）。
4. **Host 包 + Agent SDK + MCP 生产化**（capture 二进制、分组过滤、重连、分发）。
5. **物理 GPU 基准机性能/长稳 + 真实 >4 GiB 实片**（关闭 G0 证据门禁）。
6. **兼容矩阵/CI（WASM build、Windows/macOS、SBOM/许可）**。
7. **拆分 demux-common/decode-\* 并按需加载**（体积/冷启动优化）。
8. P2 画面/音频/字幕/任务，随后 P3 长尾与 P4。
