# cortico-world-localvision（本地视觉 / LocalVision）

Coopanion / Cortico 的 World 扩展：**只负责「看屏幕」**——在本机把截图 OCR 成文字 + 坐标，默认不把图片发到云端，省掉每帧截图的 token。**点击、打字、按键等操作交给 Coopanion 内置的「电脑操作」**（`pet_cua_*` 工具），本插件不重造引擎。

> 插件名：local vision（本地视觉）｜包名：`cortico-world-localvision`｜契约：`api: 6`

---

## 它做什么 / 不做什么

| 做 | 怎么做 |
|---|---|
| **看屏** `localvision_see` | 本机截屏 → tesseract.js（WASM）OCR → 返回「文字 + 截图像素坐标」，默认**不上传图片** |
| **提字** `localvision_ocr` | 同上，只返回纯文本、不含坐标 |
| **兜底** | 屏幕上没有任何文字（纯图表/图片/视频）时，才把截图作为图片回退给 Coopanion 已配的模型 |

| 不做（用内置 `pet_cua_*`） | 工具 |
|---|---|
| 点击 / 移动 / 拖拽 | `pet_cua_click` / `pet_cua_move` / `pet_cua_drag` |
| 滚动 / 打字 / 按键 | `pet_cua_scroll` / `pet_cua_type` / `pet_cua_key` |
| 窗口 / 等待 | `pet_cua_windows` / `pet_cua_focus` / `pet_cua_wait` |

> 为什么不做操作：Coopanion 内置的电脑操作（`desktop-pet` 里的 `pet_cua_*`）已经完整可靠，再 fork 一套引擎就是重复造轮子。本插件只补「看屏不上图」这一层。

---

## ⚠️ OCR 的边界（视觉损失）

本插件把截图转成**文字**，它不是一个视觉模型。下面这些信息会丢失：

- 布局与位置关系、图标、颜色、字体样式、控件状态（选中 / 禁用 / 悬停）；
- 图片、图表、视频、游戏画面、地图、CAD / 设计稿的具体内容；
- 手写、艺术字、极小字号、低对比度、被遮挡的文字。

**不适合**：玩游戏、看视频、看图找茬、审设计稿、像素级还原 UI。
**适合**：读文字、找按钮、填表单、点菜单、读报错、按标题切窗口。

视觉任务的处理：

- 关掉硬拦截（`hookIntercept: false`），截图照常发给模型；
- 或保留拦截，把 `onOcrEmpty` 设为 `"image"`，OCR 没文字时回退图片（费 token）；
- 小字用 `region` 局部重看；纯看图用 `localvision_describe`（本地/线上视觉模型）或内置的 `pet_cua_zoom`。

> 一句话：省 token 的代价就是「模型看不到像素，只看到 OCR 读出来的字」。玩游戏这类场景请直接关掉 OCR 拦截。

---

## 为什么能省 token

Coopanion 内置电脑操作默认每轮把整张截图发给云端。截图每帧都在变，导致提示词缓存被击穿（实测账单里 8% 的未命中输入占了约 73% 费用），图片 token 本身也贵。

本插件把「看屏」换成：

```
截屏（本机） → tesseract.js OCR（本机） → 文字 + 坐标  →  模型只收文字
```

- 云端收不到原始截图 → 视觉 token ≈ 0；
- 屏幕没变时文字几乎不变 → 缓存持续命中；
- 文字比 1280×800 的 JPEG 小几个数量级。

配合把内置 cua 的「操作后附截图」关掉（见下），动作型任务也能稳定省下来。

---

## 安装

> 前提：Coopanion / Cortico 已装好，并且你打算用内置的「电脑操作」。

1. 拿到代码：`git clone https://github.com/HY-pt/cortico-world-localvision.git`，或下载 ZIP 解压，记住**绝对路径**。
2. 扩展页 → **手动安装**，填这个绝对路径，确认。
3. **重启 Coopanion 进程**（所有插件都要重启才载入；扩展页会显示「待重启」）。
4. 打开 **World 总览**，启用「本地视觉 LocalVision」——新 World 默认是**待命/未激活**状态，需要在这里打开（或写进 bot 的 `declares`）。
5. 打开 **习惯 → 电脑操作**，确认「使用电脑」「允许操作鼠标和键盘」已打开（这是内置 cua 的开关）。
6. **强烈建议**：把内置 cua 的「操作后附截图」关掉，否则每次动作后仍会传一张图。在高级配置里把 `worlds.desktop-pet.cua.screenshot.afterAction` 设为 `false`（或在高级模式的「电脑操作」页关掉对应开关）。

装好后，对话里说「看一眼屏幕」，模型应当走 `localvision_see` 返回文字 + 坐标，而不是 `pet_cua_screenshot` 传图。

---

## 硬拦截（方案 1，推荐）

软约束（envPrompt + `afterAction=false`）挡不住模型直接调 `pet_cua_screenshot`。要**硬拦截**，给 Cortico 打一个很小的补丁：在工具回执落库前加一个变换钩子。

- 补丁：`patches/core-tool-outcome-hook.patch`（约 120 行，只改 `core/types.ts`、`core/loop.ts`、`core/core.ts`）
- 应用（Coopanion 0.2.5）：

  ```bash
  cd "C:/Users/synf/AppData/Local/Programs/Coopanion/resources/app/build/cortico/src"
  patch -p0 < <本仓库>/patches/core-tool-outcome-hook.patch
  ```

  先备份这三个文件；Coopanion 升级后补丁会被覆盖，重新打一次即可。
  撤销：把同目录下的 `core/*.ts.bak-lv-hook-*` 覆盖回原文件，或直接升级/重装 Coopanion。
- 然后**重启 Coopanion**。本插件启动时会检测 `registerToolOutcomeTransform` 并注册：
  - `pet_cua_screenshot` / `pet_cua_zoom` 的图片 → 本机 OCR 文字 + 坐标，图片不落库、不上传；
  - 动作后自动附的截图（`pet_cua_click` 等）也会被按 `screen/zoom/截图` 特征识别并替换；
  - 生成图、用户上传图不受影响（不是截图特征、也不在 `hookTools` 里）。
- 没打补丁时自动降级为软约束，不会报错。

> 维护成本：这是唯一需要跟 Coopanion 版本走的改动。升级后如果忘了打补丁，插件会退回软约束，不会坏。

---

## 配置（`worlds.localvision`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | World 总开关（装好后在 World 总览里激活） |
| `ocrLang` | `"auto"` | `auto` 跟随系统语言；也可填 `chi_sim` / `eng` / `chi_sim+eng`，或 `zh-Hans` / `en-US` 自动映射 |
| `screenshotMaxWidth` | `1280` | 截图缩放上限；**要和内置 cua 的 `screenshot.maxWidth` 一致**，坐标才能直接复用 |
| `screenshotMaxHeight` | `800` | 同上 |
| `hookIntercept` | `true` | **硬拦截**：注册核心 hook，把内置 cua 的截图回执换成 OCR 文本（框架没打 hook 时自动降级） |
| `hookTools` | `["pet_cua_screenshot","pet_cua_zoom","cua_screenshot","cua_zoom"]` | 额外强制拦截的工具名；带 `screen/zoom/截图` 特征的 blob 无论工具名都会被拦 |
| `onOcrEmpty` | `"text"` | OCR 找不到文字时怎么办（硬拦截截图与 `localvision_see` 共用）：`image` 把截图发给 Coopanion 已配的模型（**费 token**），`text` 丢弃图片只留提示（默认，最省 token） |
| `visionStrategy` | `"auto"` | 感知顺序：`auto`（OCR→模型→图片）/ `ocr-only` / `model-first` / `model-only` / `image-only` |
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

---

## OCR 后端：tesseract.js（为什么不是系统 OCR）

- 试过 Windows 自带的 WinRT OCR，但它要用 **PowerShell + .NET 反射** 调 WinRT，**卡巴斯基等杀软会直接拦掉**（本机实测）。
- 现在用 **tesseract.js 7（纯 Node / WASM）**：不启外部进程、不加载反射、不落 exe，Windows / macOS / Linux 一致，杀软友好。
- 语言数据首次使用时下载到部署数据目录的 `localvision-tessdata/`，之后复用：`chi_sim` 约 2.5 MB、`eng` 约 5 MB。
- `ocrLang: auto`（默认）跟随系统语言：`zh-CN`→`chi_sim`、`zh-Hant`→`chi_tra`、`ja`→`jpn`、`ko`→`kor`、`ru/fr/de/es/pt/it`→对应语言，其余 `eng`；首次使用自动下载对应语言包。
- 不需要安装 tesseract，也不需要任何视觉大模型。

---

## 视觉模型（本地 / 线上，可选，默认关闭）

OCR 读不出「画面内容」（游戏、图片、图表、视频帧）时，可以接一个视觉模型。**本地和线上都行**。

### 线上（硬件不够跑本地模型时用这个）

Coopanion 已支持 OpenAI、Anthropic、Gemini、xAI、OpenRouter、DeepSeek、Kimi、Qwen、MiniMax、智谱 GLM、豆包、百度千帆、StepFun（见 [Coopanion README](https://github.com/Pal-AI-Lab/Coopanion) 的 “Changing the model”）。配置页有「**厂商预设**」下拉：选 `openai` / `deepseek` / `qwen` / `openrouter` / `gemini` / `anthropic` / `xai` / `kimi` / `zhipu` / `minimax` / `doubao` / `qianfan` / `stepfun`，**地址留空就用它的默认地址，协议选 `auto` 就用它的默认协议**；不在列表里的选 `custom` 自己填。

> World 读不到 Coopanion 的 provider 注册表（框架没给 World 这个 API），所以这里用「厂商预设 + 你自己的 Key」来切换，而不是直接复用 Coopanion 里已配的 provider 条目。你只有一个模型商也不影响，预设列表是独立的。

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

> 模型必须支持图片输入；文本模型会在 `localvision_describe` 里报错。
> **不想填端点、直接用 Coopanion 已配的模型看图**：在「配置」页把「OCR 无文字时」设为 `image`——OCR 没文字时会把截图交给当前对话模型（官方默认模型都能读图）。注意这会消耗 token，默认 `text`（不发图）。也可以把「优先选择的模型」设为 `coop`，所有截图都直接交给对话模型看。

### 本地（能跑动再用）

- Ollama：`ollama pull qwen2.5vl:7b`，端点 `http://127.0.0.1:11434/v1`，模型名 `qwen2.5vl:7b`
- LM Studio：加载视觉模型，端点 `http://127.0.0.1:1234/v1`，模型名照界面填

### 配置与调参

- `localModelEnabled=true`，填 `localModelBaseUrl` / `localModelApiKey` / `localModelName`。
- 调参：`localModelMaxTokens`、`localModelTemperature`、`localModelPrompt`（追加指令）、`localModelDetail`（`auto/low/high`）。
- 用法：模型问「画面里有什么」时用 `localvision_describe`；`localvision_see` 在 OCR 无文字时也会先问它，再回退图片。

### 感知优先级

`visionStrategy` 决定 `localvision_see` 的顺序：

| 值 | 顺序 |
|---|---|
| `auto`（默认） | OCR → 视觉模型 → 图片；OCR 有字就不调模型 |
| `ocr-only` | 只 OCR，不调模型、不回退图片 |
| `model-first` | 视觉模型 → OCR → 图片 |
| `model-only` | 只视觉模型 |
| `image-only` | 直接回退图片（游戏/视频） |

> 默认 `auto` 即「OCR 优先」，只有 OCR 读不出字才调用视觉模型。

### World 页页签与诊断

World 页共四个页签：**模型 → 诊断 → 配置 → 本地视觉·环境提示词**（顺序由框架固定：自定义面板 → 配置 → 提示词，跨类型不能重排）。

- **模型** —— 视觉模型全部配置：**Coopanion 模型 / 本地 / 在线** 三行状态表（类型 / 地址 / 模型 / 状态）+ 连接与调参（启用、厂商预设、协议、地址、API Key（密钥 sk-…，本地服务留空）、模型名、自定义路径、maxTokens、temperature、精度、**优先选择的模型**），改动即保存。**取消勾选「启用视觉模型」后**，「端点与模型」「高级调参」两个折叠区自动收起并灰掉——已填的配置保留不清空，只是不生效；「优先选择的模型」保持在顶层可改（`coop` 不依赖端点）。「Coopanion 模型商」行**不做连通测试**，直接显示「本身支持视觉」（对话模型天然能看图）；下面「实测端点」只测你配的视觉模型端点（本地/在线，按地址自动判定，真发一次带图请求）。模型名一行下方有「**获取可用模型**」按钮：填好地址与密钥后点它，会从端点拉取已部署模型清单并生成下拉，选一个即自动填入模型名，不用手敲（Ollama 走 `/api/tags`，OpenAI 兼容走 `/models`，自带密钥时带 `Bearer`）。注意：框架的 cognition 通道传不了图片，所以**看图仍需在下面配一个支持图片输入的端点**，或者把「优先选择的模型」设为 `coop`（截图交给对话模型看）。
- **诊断** —— **懒加载**：打开页面不自动检测，点「运行诊断」才采集（屏幕/DPI、系统语言、硬拦截、OCR 语言与缓存、统计），附可复制的原始报告。
- **配置** —— 一张「本地视觉 · 配置」卡，**所有配置都在这里**（截图/OCR + 视觉模型），和「模型」面板是同一份数据；面板是更顺手的编辑器，这里作为原始/高级入口。
- **本地视觉·环境提示词** —— 框架原生提示词模板页。

工具 `localvision_doctor` 仍然可用，`checkModel: true` 会实测端点。

> 面板改完要重新 `npm run build:web`（`src/webui/client.ts` → `dist/webui.js` / `dist/webui.css`），再重启进程。

> 默认关闭：不配端点就不会发起任何本地或网络请求。

---

## 坐标为什么能直接给 `pet_cua_*`

两边都用同一套等比缩放：`min(maxW/w, maxH/h, 1)`，默认 `1280×800`，只缩不放。

Windows 截屏脚本会先声明 DPI 感知（`SetProcessDPIAware`）再读屏幕尺寸，所以 125% 缩放下拿到的也是物理像素（1920×1080），不会读成 1536×864。

- 同一显示器下，`localvision_see` 返回的截图像素 = `pet_cua_click` 要的截图像素；
- 多屏时给 `localvision_see` 传 `display`（1 起，1 = 最左），与 `pet_cua_*` 用同一个编号；
- 如果你改过任一边的 `maxWidth/maxHeight`，两边要改成一样。

---

## 分辨率适配

任意分辨率都能用：只缩不放、保持宽高比，缩到 `1280×800` 以内（与内置 cua 的默认上限一致）。

| 屏幕 | 截图 | 说明 |
|---|---|---|
| 1920×1080 | 1280×720 | 标准 |
| 2560×1440 | 1280×720 | 文字变小 |
| 3840×2160（4K） | 1280×720 | 小字更小，建议 `region` |
| 3440×1440（21:9） | 1280×536 | 同上 |
| 5120×1440（32:9） | 1280×360 | 高度压缩明显 |
| 1080×1920（竖屏） | 450×800 | 宽度压缩 |
| 1280×1024（5:4） | 1000×800 | 等比适配 |
| 1024×768 / 800×600 | 原尺寸 | 小于上限不放大 |

- Windows 截屏先声明 DPI 感知，按**物理像素**截取（125% 缩放下也是 1920×1080）。
- 多屏：`display` 从 1 起，与 `pet_cua_*` 用同一个编号。
- macOS 走 `screencapture`；Retina 下的坐标对齐尚未实测，建议先用小区域验证。
- 4K / 超宽 / 竖屏下小字会明显变小：先 `localvision_see` 拿坐标，再用 `region` 按原生分辨率重看。

---

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `localvision_see` | `display?`（1 起）、`prompt?`（仅提示）、`region?`（截图坐标的局部） | 阅读顺序文字 + 每个词的中心坐标（截图像素）；感知顺序由 `visionStrategy` 决定（默认 `auto`：OCR→模型→图片） |
| `localvision_ocr` | `display?`、`region?` | 纯文本（不含坐标、不回退图片） |
| `localvision_describe` | `prompt?`、`display?`、`region?` | 用视觉模型描述画面（本地/线上）；需配置视觉模型 |
| `localvision_doctor` | `checkModel?` | 诊断报告：屏幕/DPI、OCR 语言与缓存、硬拦截、视觉模型端点；`checkModel:true` 会实测端点 |

> **小字看不清？** 先用 `localvision_see` 拿坐标，再把那一块用 `region` 重看一次：`region` 与返回坐标同一空间，裁剪图按原始分辨率 OCR（不缩放），小字清楚很多。

---

## 高级：Provider 包装器（可选，默认关闭）

如果你不能/不想给 Cortico 打补丁，还有一条**纯插件**的硬拦截路线：做一个 `kind: provider` 的包装器，在 `BaseProvider.respond()` 里把 `function_call_output` 记录中的截图 blob 换成 OCR 文本。

- **默认不安装、不启用**；只给愿意折腾的用户。
- 用户需要把 provider 切换到这个包装器（多一步设置）。
- 包装器必须完整转发流式、工具调用、usage、错误与重试；做错了会影响全部对话。
- 设计、挂点、代码骨架与注意事项见 [`docs/provider-wrapper.md`](docs/provider-wrapper.md)。

> 结论：能打补丁就用上面的核心 hook；不能打补丁、又想要硬保证，再考虑这个包装器。

---

## 排错

**Q：装了但 World 总览没有？**
A：先**重启进程**；扩展页显示「待重启」就是还没载入。重启后在 World 总览里手动启用。

**Q：OCR 识别为 0 个字？**
A：首次使用需要下载语言数据，确认网络可用、`localvision-tessdata/` 可写；中文界面把 `ocrLang` 设为 `chi_sim`。

**Q：模型还是调了 `pet_cua_screenshot` 传图？**
A：本插件不能强制拦截别的 World 的工具（Cortico 没有 tool-result hook）。靠两层约束：① 本插件的环境提示词明确要求「看屏只用 localvision_see，操作传 `screenshot:false`」；② 把内置 cua 的 `screenshot.afterAction` 关掉。

**Q：坐标点偏了？**
A：确认 `screenshotMaxWidth/Height` 与内置 cua 一致，并且 `localvision_see` 和 `pet_cua_*` 看的是同一个 `display`。

**Q：卡巴斯基报毒/拦截？**
A：本插件不启动 PowerShell、不落 exe，只跑 tesseract.js 的 WASM；如果仍被拦，把 `localvision-tessdata/` 与 Node 进程加白名单。

---

## 开发与校验

```bash
npm install                    # 或 pnpm install
npm run build:web              # 构建面板 dist/webui.js + dist/webui.css
node --experimental-transform-types scripts/describe-extension.ts .   # 生成 describe.json
node --experimental-transform-types scripts/check-extension.ts .      # 契约校验
```

装进 Coopanion：扩展页「手动安装」填本目录绝对路径 → 重启 → World 总览启用。

---

## 许可

MIT。
