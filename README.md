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
5. 强烈建议：把内置 cua 的「操作后附截图」关掉，否则每次动作后仍会传一张图——高级配置里把 `worlds.desktop-pet.cua.screenshot.afterAction` 设为 `false`。

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
| `visionStrategy` | `"auto"` | 感知顺序，界面只给三项：`auto` 自动（OCR>视觉模型>图片上传）/ `model-first` 模型（先视觉模型，OCR 兜底）/ `ocr-only` 只 OCR。旧值 `model-only`、`image-only` 代码仍支持 |
| `localModelPriority` | `"auto"` | 优先选择的模型（看图）：`auto` 按本地>在线>Coopanion 兜底自动路由（端点按地址自动判本地/在线）；`local` / `online` 只用对应端点；`coop` 直接把截图交给 Coopanion 对话模型 |
| `localModelEnabled` | `false` | 启用视觉模型（本地或线上；游戏/图片/图表等 OCR 读不出的内容） |
| `localModelProvider` | `"custom"` | 厂商预设：`openai` / `deepseek` / `qwen` / `openrouter` / `gemini` / `anthropic` / `xai` / `kimi` / `zhipu` / `minimax` / `doubao` / `qianfan` / `stepfun` / `ollama` / `lmstudio` / `custom` |
| `localModelProtocol` | `"auto"` | `auto` 跟随预设；或 `openai-chat` / `anthropic-messages` / `openai-responses` / `custom` |
| `localModelPath` | `""` | 仅 `custom` 协议用，默认 `/chat/completions` |
| `localModelBaseUrl` | `""` | 留空用厂商预设地址；也可覆盖为线上/本地地址 |
| `localModelApiKey` | `""` | 线上填厂商 Key；本地 Ollama / LM Studio 一般留空 |
| `localModelName` | `""` | 如 `gpt-5`、`qwen-vl-max`、`claude-haiku-5-5`、`qwen2.5vl:7b` |
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
- **模型还是调 `pet_cua_screenshot` 传图？** 软约束是两层：环境提示词要求「看屏只用 localvision_see」+ 关掉 cua 的 `afterAction`。要硬拦截用 `npm run patch:hook` 打上核心 hook。
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

---

## 0.3.1（暂未发布）

> 本版本已合并、尚未发布到扩展市场。发布后此节并入更新日志。

- **诊断面板新增「设备压力负载」进度条**：一眼看清当前 CPU / 内存占用（绿 < 60% / 黄 60–85% / 红 ≥ 85%）；入门显卡（如 GTX 1650 / 4GB）跑本地视觉模型时压力会直接顶到红区。
- **低配机 / 性能调优指引**：README 新增折叠块，给出 7 条缓解方案（OCR-only、降分辨率、降 maxTokens、模型常驻、确认 GPU、换小模型、detail=low），按收益从大到小排序。
- **环境提示词新增卡顿应对指引**：用户反馈「识别慢 / 卡顿」时，桌宠能建议更换更好的设备，或调低分辨率 / maxTokens / detail 等参数。
- **`localvision_see` 新增 `expand` 一键向外延伸**：传 `region` 时带 `expand`，插件自动把区域向外扩大再截、无需模型算坐标；OCR 落空时自动再扩一轮重试。配置页新增「默认外扩像素」（默认 100，0 = 关闭外扩与重试），不传 `expand` 时生效。
- **诊断面板新增「提交 Issue」入口与反馈引导**：面板内一键直达仓库 issue 页（免去从扩展市场层层翻找）；并提示把上方诊断（已自动脱敏，不含画面内容与密钥）复制贴进 issue 正文。诊断文本已做敏感数据预清理（API Key 完全遮罩 + `sk-/pk-/Bearer` 令牌兜底剔除）。
- **「OCR 兜底方式」更名、说明重写并默认改为图片**：原「OCR 无文字时」更名为「OCR 兜底方式」，两行说明对齐重写；默认值由 `文本` 改为 `图片`——只有 OCR 认不出字（游戏、视频等纯画面）时才把截图发给 Coopanion 已配的模型，文字场景照旧零开销，桌宠开箱即可"看懂"画面；不想发图的用户可改回 `文本`。已保存过配置的老用户不受影响（保持原值）。

MIT。
