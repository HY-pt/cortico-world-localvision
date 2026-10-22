# cortico-world-localvision（本地视觉 / LocalVision）

<div align="center">
  <img src="docs/cover.jpg" alt="本地视觉 LocalVision" width="320" />
</div>

Coopanion 的 World 扩展：在本机把屏幕 OCR 成「文字 + 坐标」再交给模型，默认不把截图发到云端，省掉每帧看屏的 token。点击、打字、按键等操作交给内置的「电脑操作」（`pet_cua_*`），本插件不重造引擎。

需要看图片、图表、游戏画面时，可选接一个**视觉模型**（本地 > 在线 > Coopanion 模型商自动路由）；也可以打一个小补丁**硬拦截**内置截图，图片不落库、不上传。

## 安装

推荐从 **Coopanion 扩展市场**一键安装：

1. 打开 Coopanion（项目主页 / 下载：<https://github.com/Pal-AI-Lab/Coopanion>），进入 **扩展市场**。
2. 搜索「本地视觉 LocalVision」，点击 **安装**。
3. 打开 **World 总览**，启用「本地视觉 LocalVision」（新 World 默认待命）。
4. **习惯 → 电脑操作**：确认「使用电脑」「允许操作鼠标和键盘」已打开（内置 cua 的开关）。
5. 强烈建议：把内置 cua 的「操作后附截图」关掉，否则每次动作后仍会传一张图——高级配置里把 `worlds.desktop-pet.cua.screenshot.afterAction` 设为 `false`（诊断面板会检查这项，忘了关会提醒）。

装好后，对话里说「看一眼屏幕」，模型应当返回文字 + 坐标，而不是 `pet_cua_screenshot` 传图。

> 想从源码装（开发者 / 改代码）：见文末「开发与校验」。

## 使用

- **看屏**：模型自动走 `localvision_see`（文字 + 坐标，可直接传给 `pet_cua_click`）；`localvision_ocr` 只取纯文字；`localvision_doctor` 或「诊断」面板用于排错。
- **小字 / 局部看不清**：先用 `localvision_see` 拿坐标，再带 `region` 按原始分辨率重看那一块。嫌坐标算不准？直接传 `expand`（像素值）：插件自动把 `region` 向外扩大再截、**不用模型算坐标**；若 OCR 仍没字，会自动再扩一轮重试。不传 `expand` 时用配置页「默认外扩像素」（默认 100，设 0 关闭外扩与重试）。例：`localvision_see({ region: {x,y,w,h}, expand: 200 })`。
- **World 页面签**：「模型」配/测视觉模型，「诊断」跑检测（上次结果会保留到下次检测），「配置」改截图/OCR 设置，「本地视觉·环境提示词」是框架原生页。
- **看画面**：在「模型」页启用视觉模型并填端点（可点「获取可用模型」拉模型清单）；之后 `localvision_describe` 或 OCR 无文字时会按「优先选择的模型」（自动 / 本地 / 在线 / Coopanion）路由。

## 大致原理

```
截屏（本机） → tesseract.js OCR（本机） → 文字 + 坐标 → 模型只收文字
```

- 云端收不到原始截图，视觉 token ≈ 0；文字比 1280×800 的 JPEG 小几个数量级，提示词缓存也不被每帧变化的截图击穿。
- 坐标与 `pet_cua_*` 同一套等比缩放（默认 1280×800 上限、只缩不放），Windows 按物理像素截屏（DPI 感知），拿到的坐标可直接点击。
- OCR 只读文字：图标、颜色、布局、游戏画面读不出——这类需求走视觉模型（见上）。

## 可选：硬拦截内置截图

仅靠提示词 + 关 afterAction 是软约束，模型仍可能直接调 `pet_cua_screenshot` 传图。给核心打一个小钩子即可硬拦截：内置 cua 的截图回执在落库前就地换成 OCR 文本（生成图、用户上传图不受影响）。

补丁已随扩展内置（`patches/` 里的补丁文件 + 幂等应用脚本），**按需应用一次即可**，两种方式任选：

1. **「诊断」面板一键打**（最省事）：World 页 → 诊断 → 「打核心补丁」按钮。幂等、改前自动备份，打完**重启 Coopanion** 生效。
2. **命令行**：在扩展安装目录跑 `npm run patch:hook`（或 `npm run patch:hook -- <cortico/src 路径>`）。

补丁只改 3 个核心文件、备份就在旁边（撤销＝把 `.bak-hookpatch` 改回文件名）；Coopanion 升级后补丁会被覆盖，重打一次即可。

打完后重启 Coopanion，配置页的「硬拦截截图」开启即生效（**重新开启需重启 World**）。没打补丁时自动降级为软约束，不会报错。

<details>
<summary>硬拦截细节（手动打补丁 / 撤销 / 维护）</summary>

- 补丁约 120 行，只改 `core/types.ts`、`core/loop.ts`、`core/core.ts`，源码见 [`patches/core-tool-outcome-hook.patch`](patches/core-tool-outcome-hook.patch)。
- 手动应用（需要 `patch` 命令）：

  ```bash
  cd "C:/Users/synf/AppData/Local/Programs/Coopanion/resources/app/build/cortico/src"
  patch -p0 < <本仓库>/patches/core-tool-outcome-hook.patch
  ```

- 撤销：把 `core/*.ts.bak-hookpatch` 备份改回原文件名，或直接升级/重装 Coopanion。
- 维护成本：这是唯一跟随 Coopanion 版本的改动，升级后忘了打补丁只会退回软约束，不会坏。
- 不想打补丁、又想要硬保证的备选路线：`kind: provider` 包装器（默认不安装，设计与骨架见 [`docs/provider-wrapper.md`](docs/provider-wrapper.md)）。
</details>

---

## 完整参数（`worlds.localvision`）

<details>
<summary>全部配置键与默认值</summary>

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | World 总开关（装好后在 World 总览里激活） |
| `ocrLang` | `"auto"` | `auto` 跟随系统语言；也可填 `chi_sim` / `eng` / `chi_sim+eng`，或 `zh-Hans` / `en-US` 自动映射 |
| `screenshotMaxWidth` | `1280` | 截图缩放上限；**要和内置 cua 的 `screenshot.maxWidth` 一致**，坐标才能直接复用 |
| `screenshotMaxHeight` | `800` | 同上 |
| `hookIntercept` | `true` | **硬拦截**：注册核心 hook，把内置 cua 的截图回执换成 OCR 文本（框架没打 hook 时自动降级）。关闭即时生效，**重新开启需重启 World** |
| `hookTools` | `["pet_cua_screenshot","pet_cua_zoom","cua_screenshot","cua_zoom"]` | 额外强制拦截的工具名；带 `screen/zoom/截图` 特征的 blob 无论工具名都会被拦 |
| `onOcrEmpty` | `"image"` | OCR 兜底方式（硬拦截截图与 `localvision_see` 共用）：`image` OCR 认不出字时把截图发给 Coopanion 已配的模型兜底，看得懂游戏、视频等画面（**费 token**，默认）；`text` 只返回文字，不发图、零额外开销 |
| `textAssist` | `false` | ⚠️ **默认关，开启要多花 token**；位于配置页「**实验性功能**」组（编号 EXP-01，该组功能仍在调试、可能报错）：真的需要发图时（视觉模型看图、或图片兜底给 Coopanion 模型商），在原图之外额外附一份本机 OCR 的「文字 + 坐标」，让模型按坐标定位。**只在本地小模型认字不准、幻觉严重时才值得开**；在线大模型自己读图就够准。截图始终是原图，不涂改；画面 0 文字时不附加任何内容。诊断面板会列出它的开关状态与最近一次报错（编号一致） |
| `visionStrategy` | `"auto"` | 感知顺序，界面只给三项：`auto` 自动（OCR>视觉模型>图片上传）/ `model-first` 模型（先视觉模型，OCR 兜底）/ `ocr-only` 只 OCR。旧值 `model-only`、`image-only` 代码仍支持 |
| `localModelPriority` | `"auto"` | 优先选择的模型（看图）：`auto` 按本地>在线>Coopanion 兜底自动路由（端点按地址自动判本地/在线）；`local` / `online` 只用对应端点；`coop` 直接把截图交给 Coopanion 对话模型 |
| `localModelEnabled` | `false` | 启用视觉模型（本地或线上；游戏/图片/图表等 OCR 读不出的内容） |
| `localModelProvider` | `"qwen"` | 厂商预设：`openai` / `deepseek` / `qwen` / `openrouter` / `gemini` / `anthropic` / `xai` / `kimi` / `zhipu` / `minimax` / `doubao` / `qianfan` / `stepfun` / `ollama` / `lmstudio` / `custom` |
| `localModelProtocol` | `"auto"` | `auto` 跟随预设；或 `openai-chat` / `anthropic-messages` / `openai-responses` / `custom` |
| `localModelPath` | `"/chat/completions"` | 仅 `custom` 协议用，默认 `/chat/completions` |
| `localModelBaseUrl` | `""` | 留空用厂商预设地址；也可覆盖为线上/本地地址 |
| `localModelApiKey` | `""` | 线上填厂商 Key；本地 Ollama / LM Studio 一般留空 |
| `localModelName` | `"qwen-vl-plus"` | 如 `gpt-5`、`qwen-vl-max`、`claude-haiku-5-5`、`qwen2.5vl:7b` |
| `localModelTimeoutMs` | `20000` | 调用超时（毫秒） |
| `localModelMaxTokens` | `1000` | 最大输出 token |
| `localModelTemperature` | `0.2` | 温度（0–2） |
| `localModelPrompt` | `""` | 追加给视觉模型的指令；留空用内置提示 |
| `localModelDetail` | `"auto"` | OpenAI 兼容的 `image_url.detail`：`auto` / `low` / `high` |

感知优先级 `visionStrategy`：`auto`（默认）= OCR → 视觉模型 → 图片，OCR 有字就不调模型；`model-first` = 视觉模型 → OCR → 图片；`ocr-only` = 只 OCR。界面下拉为 自动 / 模型 / OCR-only。
</details>

<details>
<summary>视觉模型：厂商预设与端点速查</summary>

| 厂商 | 协议 | Base URL | 模型示例 |
|---|---|---|---|
| OpenAI | `openai-chat` | `https://api.openai.com/v1` | `gpt-5` |
| Anthropic | `anthropic-messages` | `https://api.anthropic.com/v1` | `claude-haiku-5-5` |
| Gemini（OpenAI 兼容） | `openai-chat` | `https://generativelanguage.googleapis.com/v1beta/openai` | `gemini-3.5-flash-lite` |
| DeepSeek | `openai-chat` | `https://api.deepseek.com/v1` | 选支持图片的模型 |
| Qwen / DashScope | `openai-chat` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-vl-max` |
| OpenRouter | `openai-chat` | `https://openrouter.ai/api/v1` | 任意视觉模型 |
| xAI | `openai-chat` | `https://api.x.ai/v1` | `grok-...` |
| Ollama（本地） | `openai-chat` | `http://127.0.0.1:11434/v1` | `qwen2.5vl:7b` |
| LM Studio（本地） | `openai-chat` | `http://127.0.0.1:1234/v1` | 界面里加载的视觉模型 |
| 其他 Responses 兼容 | `openai-responses` | 服务商的 `/responses` 地址 | 支持 Responses 的视觉模型 |
| 其他 OpenAI Chat 兼容 | `custom` | 自己填地址 + `localModelPath` | 任意视觉模型 |

- 选厂商预设后地址可留空（用默认地址）、协议选 `auto`（用默认协议）；模型必须支持图片输入，文本模型会在 `localvision_describe` 报错。
- 本地：Ollama `ollama pull qwen2.5vl:7b`；LM Studio 加载视觉模型后照界面填端点与模型名。
- 不想填端点、直接用 Coopanion 已配的模型看图：「优先选择的模型」设 `Coopanion`（截图交给对话模型，费 token），或保持「OCR 兜底方式」为 `图片`（默认，仅 OCR 认不出字时才发图）；不想发图改为 `文本`。
- 默认关闭：不配端点就不会发起任何本地或网络请求。面板改动即时保存，改完 `src/webui/` 需重新 `npm run build:web` 并重启进程。
</details>

<details>
<summary>低配机 / 性能调优（本地视觉模型太慢怎么办）</summary>

在入门级硬件上本地跑视觉大模型（如 `qwen2.5vl:3b`）单次调用动辄 20s+（实测约 24.6s），瓶颈主要是 **CPU 推理 + 1280×800 截图的视觉 token 预填充太重**；若每次调用都重新加载模型会更慢。按下面顺序调，收益从大到小：

1. **纯文字需求直接跳过模型（零成本、最稳）**：把 `visionStrategy` 设为 `ocr-only`，屏幕只有文字时完全不调视觉模型。OCR 首次冷启动约 8.8s，之后通常几秒内返回。
2. **降分辨率（视觉 token 收益最大）**：`screenshotMaxWidth/Height` 从 `1280×800` 降到 `960×600`，甚至 `768×480`。视觉 token 数随分辨率近似**平方**下降，对 CPU 推理速度影响最直接。
3. **降输出长度**：`localModelMaxTokens` 从 `1000` 调到 `300~500`，CPU 上输出 token 同样慢。
4. **让模型常驻，别每次重载**：Ollama 设 `keep_alive=-1`（或环境变量 `OLLAMA_KEEP_ALIVE=-1`）；LM Studio 在模型设置里关掉自动卸载。否则每次调用都重新加载模型，延迟翻倍。
5. **确认真的在走 GPU**：`ollama ps` 看 GPU 占用。纯 CPU 跑 3B 的 VL 模型就是这个速度，加 GPU 通常能快几倍。
6. **换更小的 VL 模型**：`moondream`、`MiniCPM-V` 的小量化版等，参数量远小于 3B/7B 的通用 VL 模型。
7. **降采样**：`localModelDetail` 设 `low`，部分服务端会据此降采样图片。

> 一句话：能 OCR 就别上模型；非上模型就先降分辨率 + 让模型常驻 + 确认 GPU。

</details>

<details>
<summary>工具参数表</summary>

| 工具 | 参数 | 返回 |
|---|---|---|
| `localvision_see` | `display?`（1 起）、`prompt?`（仅提示）、`region?`（截图坐标的局部）、`expand?`（搭配 `region`：向外扩展的像素，不传时用配置页「默认外扩像素」；自动重截并在 OCR 落空时兜底再扩一轮，无需模型算坐标） | 阅读顺序文字 + 每个词的中心坐标（截图像素）；感知顺序由 `visionStrategy` 决定（默认 `auto`：OCR→模型→图片） |
| `localvision_ocr` | `display?`、`region?` | 纯文本（不含坐标、不回退图片） |
| `localvision_describe` | `prompt?`、`display?`、`region?` | 用视觉模型描述画面；按「优先选择的模型」路由到本地端点 / 在线端点 / Coopanion 模型商 |
| `localvision_doctor` | `checkModel?` | 诊断报告：屏幕/DPI、OCR 语言与缓存、硬拦截、视觉模型端点；`checkModel:true` 会实测端点 |
</details>

<details>
<summary>边界与实现细节（OCR 后端 / 坐标 / 分辨率）</summary>

**OCR 只读文字**，会丢失：布局与位置关系、图标、颜色、字体样式、控件状态；图片、图表、视频、游戏画面、地图、设计稿内容；手写、艺术字、极小字号、低对比度文字。
适合：读文字、找按钮、填表单、点菜单、读报错、切窗口。不适合：玩游戏、看视频、看图找茬、审设计稿、像素级还原 UI。

**OCR 后端用 tesseract.js（WASM）**：不启外部进程、不落 exe、杀软友好，Windows / macOS / Linux 一致。语言数据首次使用自动下载到 `localvision-tessdata/`（`chi_sim` 约 2.5 MB、`eng` 约 5 MB），之后复用；不需要装 tesseract，也不需要任何视觉大模型。`ocrLang: auto` 跟随系统语言（`zh-CN`→`chi_sim`、`zh-Hant`→`chi_tra`、`ja`→`jpn`、`ko`→`kor`、`ru/fr/de/es/pt/it`→对应语言，其余 `eng`）。

**坐标**：两边同一套等比缩放 `min(maxW/w, maxH/h, 1)`，只缩不放；多屏 `display` 从 1 起与 `pet_cua_*` 同编号；任一边改了 `maxWidth/maxHeight`，两边要一致。

**分辨率**：任意分辨率缩到 1280×800 以内——1080p→1280×720；2K→1280×720（文字变小）；4K→1280×720（建议 `region`）；21:9→1280×536；32:9→1280×360；竖屏→450×800；小于上限不放大。Windows 先声明 DPI 感知按物理像素截屏（125% 缩放下也是 1920×1080）；macOS 走 `screencapture`，Retina 坐标对齐尚未实测，建议先用小区域验证。
</details>

<details>
<summary>排错</summary>

- **装了但 World 总览没有？** 先重启进程；扩展页显示「待重启」就是还没载入。重启后在 World 总览手动启用。
- **OCR 识别 0 个字？** 首次使用需下载语言数据：确认网络可用、`localvision-tessdata/` 可写；中文界面把 `ocrLang` 设为 `chi_sim`。
- **模型还是调 `pet_cua_screenshot` 传图？** 软约束是两层：环境提示词要求「看屏只用 localvision_see」+ 关掉 cua 的 `afterAction`。要硬拦截用 `npm run patch:hook` 打上核心 hook。诊断面板会读全局配置，显示内置 cua「操作后截图」的开关状态，开着时给出关闭建议（高级配置里把 `worlds.desktop-pet.cua.screenshot.afterAction` 设为 `false`）。
- **坐标点偏了？** 确认 `screenshotMaxWidth/Height` 与内置 cua 一致，且 `localvision_see` 和 `pet_cua_*` 看的是同一个 `display`。
- **卡巴斯基报毒？** 不启动 PowerShell、不落 exe，只跑 WASM；仍被拦就把 `localvision-tessdata/` 与 Node 进程加白名单。
</details>

<details>
<summary>开发与校验</summary>

```bash
npm install
npm run build:web              # 构建面板 dist/webui.js + dist/webui.css
npm run describe:extension     # 生成 describe.json
npm run check:extension        # 契约校验（工具声明与 describe.json 一致性）
npm run patch:hook             # 一键给宿主打核心 hook（幂等、自动备份）
```

装进 Coopanion：扩展页「手动安装」填本目录绝对路径 → 重启 → World 总览启用。
</details>

<details>
<summary>设计取舍：为什么发图绝不涂改（已评估并否决「拼字 / Text-Image Fusion」）</summary>

曾设想「上传前把 OCR 命中的文字涂成灰条，图 + 坐标一起发」，目标是让云端少读错字。做过完整 PoC（纯 Node + `node:zlib` 自实现 PNG 编解码，零新依赖）：开销确实可忽略（1148×791 实测解码 22ms + 涂抹 4ms + 重编码 77ms，相对同帧 OCR 约 9s 占比 <3%），涂抹也够彻底（重跑 OCR 残留 0 词）。

但仍**否决**，原因是语义层的：把文字涂掉留下的灰色块，会被视觉模型当成**空白按钮或输入框**，原本「按钮 + 文字」的排版语义断裂，反而制造比认错字更严重的幻觉。

因此定调三条：
1. **原图优先**：截图一个像素都不改，100% 传原始截图（局部裁剪传局部原图，彻底兜底传全屏原图）。
2. **文字走文本**：本机 OCR 已经绝对准确，就以纯文本（带坐标）的形式**额外**附上，让模型拿文本定位、拿原图看图标与排版——这正是 `textAssist` 做的事。
3. 视觉 token 按分辨率计费，涂改不仅不省 token，收益远小于破坏 UI 语义的风险。
</details>

---

<details>
<summary>0.4.0（规划中，未开工）——视频 / 摄像头方向</summary>

### 大方向：把「看图」从屏幕扩展到**视频与摄像头**

**先说调研结论（2026-10-22）**：Coopanion / Cortico 生态里**目前没有**摄像头或视频流类的 World——npm 上 `cortico-world-*` 全量扫过，GitHub 上 56 个同名仓库也逐个看过，最接近的都不做 devices 采集。相邻参照是这样的：

| 已有扩展 | 它做什么 | 对 0.4.0 的意义 |
|---|---|---|
| `cortico-world-vision`（Lostdegree） | 静态图的**区域裁剪放大**（400×300 铺成 1600×1200），`koffi` FFI + `jpeg-js` + 自写 zlib PNG 解码，Windows only | 同一赛道的不同解法：它解决「字太小看不清」，我们若做摄像头解决「画面是活的」。两者互补不冲突 |
| `cortico-world-asr`（Phantivia） | **麦克风**（RtAudio 采集 + FireRedASR2-AED），运行时与权重由**面板托管安装** | 关键先例：生态接受「World 托管安装外部运行时」。所以引入 ffmpeg 不是不能谈，但要照它的做法做成可选 + 引导安装 |
| `cortico-world-presence`（biliye） | 在场感：持续读前台窗口 + 键鼠空闲 + 截屏，Windows、零安装 | 摄像头能做得更准，但功能会重叠；0.4.0 先不碰「盯人在不在」，避免撞车 |
| `cortico-world-bilibili-video` | 登录态浏览器里看 B 站视频：**抽帧 + 字幕 + 时间轴** | 视频侧的标准答案已经有人给过——抽帧 + 字幕/时间线，可以直接抄思路 |

结论：**缺口真实存在，没有重复造轮子**。localvision 的定位是「在本机、省 token 地读懂画面」，视频与摄像头是这条路的自然延伸，而不是另起炉灶。

**技术路线（三条，取舍明确）**

- **A. ffmpeg 抽帧**：最稳，Win（`dshow`）/ Mac（`avfoundation`）通吃，视频文件 `-vf fps=1/N`。代价是要二进制，和本项目「零 npm 依赖、杀软友好」的卖点冲突 → 只能按 `cortico-world-asr` 的做法：**可选安装、面板引导、检测不到就明确降级提示**，绝不做成硬依赖。
- **B. WebUI 浏览器通道 `getUserMedia`**（**推荐先做 PoC**）：Coopanion 面板跑在 Electron 渲染进程里，理论上能直接拿到摄像头；帧可以 canvas 转 JPEG，再经**已被本扩展验证可用的 `ctx.invoke(...)`**（现在就在用它跑 save / models / state / probe / patch）送回 World。零依赖、跨平台。**代价：面板没打开就采不到帧**（不能后台盯家），且需要 Electron 的摄像头授权。
- **C. 视频文件 / 录屏**：浏览器里 `<video>` + canvas 抓帧（复用 B 的通道），或离线 ffmpeg 抽帧（复用 A）。

**真正的难点不是取帧，是节奏。** 一秒 25 帧全问模型，再省也烧穿 token。必须解决的四个问题：

1. **采样**：fps 上限、去抖（画面还没稳定就别问）。
2. **变化检测**：帧差 / 感知哈希，只有画面真的变了才值得上报——直接复用现有的 sha256 图片缓存思路。
3. **时间轴聚合**：把 N 帧压成一条「时刻 → 画面发生了什么」的概览，而不是每帧一张图塞给模型。
4. **成本阀门**：沿用本扩展一贯的哲学「**能走文本就不发图**」——视频/摄像头默认输出 OCR 文本时间线，只有检测到显著变化的那一帧才作为图片例外上送。（这也是刚做完的 `textAssist` 要默认关的原因：视频场景里每帧都附文本，账单会失控。）

**分阶段：**

- **0.4.0 MVP — 先看「录下来的」**：新增 `localvision_watch`（source = 视频文件路径 / 已有录屏），抽帧 + 变化检测 + OCR，产出**时间线文本**（帧号 + 时刻 + 该帧文字），显著变化帧作为图片附件。不带摄像头，零外部依赖风险。
- **0.4.1 — 再看「活着的」**：摄像头，走 B 通道，独立开关 + 明确的隐私说明（画面是否出本机，由现有的路由（`modelRoute`）决定，规则不变）。

**开工前必须先验证的三件事**：① `ctx.invoke` 能否承载一帧 1280×720 JPEG（base64 约 100–200KB），要不要改走临时文件中转；② Electron 摄像头权限在不同 Coopanion 版本上的差异；③ macOS（`avfoundation` / 浏览器授权）有没有办法守住跨平台承诺。

</details>

---

## 0.3.1（暂未发布）

> 本版本已合并、尚未发布到扩展市场。以下只列**与 0.3.0 的差异**。
> 更新日志展示规则：**未发布但已做的版本展开；规划中的未来版本折叠；当前市场版本展开**。0.3.1 发布到市场后，此节并入更新日志，0.3.0 一节随之折叠。

- **新增「发图时附带本机 OCR 文字」（`textAssist`，⚠️ **默认关**，配置页「实验性功能」组 / 编号 EXP-01）**：需要真的发图时（视觉模型看图、或缺 Key / 调用失败降级到 Coopanion 模型商），可额外附一份本机 OCR 的「文字 + 坐标」纯文本，模型按坐标定位即可，不必靠读图认字。**只对本地小模型（7B 级）认字不准、幻觉严重的场景有意义**；在线大模型自己读图就够准，开着纯属多花 token——所以它默认关闭，配置页与诊断面板都会给出「会增加 token 开销」的提示。**截图始终是原图，不做涂改或抠字**；画面本来就 0 文字时不附加任何内容。同一张截图 OCR 结果会缓存，一帧只识别一次。该功能仍在调试：运行时报错不会中断主流程（照常发原图），但会按 EXP-01 编号留痕，诊断面板「实验性功能」区展示开关状态与最近一次报错，与配置页编号一致，方便定位。
- **`localvision_see` 新增 `expand` 一键向外延伸**：传 `region` 时带 `expand`，插件自动把区域向外扩大再截、无需模型算坐标；OCR 落空时自动再扩一轮重试。配置页新增「默认外扩像素」（默认 100，0 = 关闭外扩与重试），不传 `expand` 时生效。
- **诊断面板新增「提交 Issue」入口与反馈引导**：面板内一键直达仓库 issue 页（免去从扩展市场层层翻找）；并提示把上方诊断（已自动脱敏，不含画面内容与密钥）复制贴进 issue 正文。诊断文本已做敏感数据预清理（API Key 完全遮罩 + `sk-/pk-/Bearer` 令牌兜底剔除）。按钮顺序也按使用逻辑重排为 运行诊断 → 复制 → 提交 Issue → 打核心补丁。
- **诊断面板「运行环境」新增「模型」行**：一眼看清当前**实际**由谁看图——本地模型 ✓ / 在线模型 ✓ / 其余情况显示 Coopanion 模型商 ✓。判定标准是「真的会不会被调用」：在线端点没填 API Key（请求必然 401）时如实显示 Coopanion 模型商并提示去补 Key，不会谎报「在线模型 ✓」。
- **设备压力负载进度条改为按实际使用场景测量**：0.3.0 起面板就有 CPU / 内存两条进度条；现在本地模型用户点「运行诊断」时，会按当前设置实测**一次截图尝试**期间的 CPU 压力与内存占用（绿 < 60% / 黄 60–85% / 红 ≥ 85%），入门显卡跑本地视觉模型时压力会直接顶到红区；使用在线模型或 Coopanion 模型商时推理不在本机，负载直接显示 0%。
- **配置页按同类分组**：拆成「本地视觉 · 识别（OCR）」（感知优先级 / OCR 语言 / OCR 兜底方式 / 硬拦截截图）、「本地视觉 · 截图尺寸」（截图最大宽 / 截图最大高 / 默认外扩像素）与「本地视觉 · 实验性功能」（发图时附带本机 OCR 文字），像素类不再与 OCR 项混排；最后一组专放仍在调试、可能报错的功能，组说明里写清「出问题先关开关验证」，诊断面板按同一套编号（EXP-01…）回报状态与最近一次报错。
- **诊断面板「运行环境」新增「内置 cua 操作后截图」行**：读全局配置观察内置 cua 的「操作后附截图」开关（`worlds.desktop-pet.cua.screenshot.afterAction`，桌面宠默认开着）。开着时给出去高级配置关掉它的建议——没打硬拦截时说明「每次动作后都会向模型传一张图」，硬拦截生效时说明「截图会被转成文字，但仍会多一次本地截图」；已关或没启用 cua 时不显示、不给建议。
- **「OCR 兜底方式」更名、说明重写并默认改为图片**：原「OCR 无文字时」更名为「OCR 兜底方式」，两行说明对齐重写；默认值由 `文本` 改为 `图片`——只有 OCR 认不出字（游戏、视频等纯画面）时才把截图发给 Coopanion 已配的模型，文字场景照旧零开销，桌宠开箱即可"看懂"画面；不想发图的用户可改回 `文本`。已保存过配置的老用户不受影响（保持原值）。
- **低配机 / 性能调优指引**：README 新增折叠块，给出 7 条缓解方案（OCR-only、降分辨率、降 maxTokens、模型常驻、确认 GPU、换小模型、detail=low），按收益从大到小排序。
- **环境提示词新增卡顿应对指引**：用户反馈「识别慢 / 卡顿」时，桌宠能建议更换更好的设备，或调低分辨率 / maxTokens / detail 等参数。
- **修复**：`localModelPriority` 默认值由 `online` 改回文档承诺的 `auto`——0.3.0 起默认值就是 `online`，于是配了本机 Ollama / LM Studio（地址 127.0.0.1）却没改优先级的用户，本地模型会被**静默跳过**、直接回退 Coopanion 模型商。
- **修复**：「获取可用模型」的请求补上 12 秒超时——0.3.0 就有该功能且没有超时，本地 Ollama 没起或远端挂住时面板会永久卡死。

MIT。
