# cortico-world-localvision（本地视觉 / LocalVision）

Coopanion / Cortico 的 **World 扩展**，给桌宠提供「屏幕感知 + 点击」能力，把云端 token 压到最低。

> 插件名：local vision（本地视觉）｜包名：`cortico-world-localvision`｜契约：`api: 6`

---

## 产品定位：轻量优先，视觉可选

作为**轻量级桌宠软件**，首要保证是**不卡顿**：

- **视觉端点是【可选】的**。默认配置下 `visionApiBaseUrl` 为空，插件进入「轻量模式」——
  只提供**归一化坐标点击**（`localvision_click` 的 Tier2），**不调用任何视觉模型**，桌宠因此最流畅。
- 当用户愿意在设置里填上 `visionApiBaseUrl`（本地 **Ollama / LM Studio** 的 `/v1`，或任意**云端 OpenAI 兼容**端点），
  再解锁「看屏」能力（`localvision_see` / `localvision_ocr`）和点击的 Tier1(OCR 锚定) / Tier3(看图兜底)。
- **彻底解耦本地模型**：本插件不依赖、不硬编码、不假设 Ollama 在运行。视觉端点只是一个
  标准 OpenAI 兼容的 `/v1/chat/completions`，用户自由选择本地或云端、填不填完全由配置决定。

---

## 为什么能降 token

Coopanion「操作电脑」每轮都把屏幕截图发给云端。截图每帧都在变，导致云端输入前缀每轮变化，
**提示词缓存被击穿**——账单里那 8% 的未命中输入占了 73% 的成本，且视觉 token 本身很贵。

本插件把"看屏"从"每轮传图"改为"按需文字化"：

```
轻量模式：          归一化坐标点击（无模型，最流畅）
视觉增强模式：      截屏 ──本机/云端视觉端点──▶ 稳定文字描述 ──▶ 云端(只收文字)
```

- 屏幕没变时，文字描述**几乎不变** → 云端输入前缀稳定 → 缓存持续命中。
- 云端**收不到任何原始截图**（轻量模式连文字化都不做，直接收归一化坐标）→ 视觉 token ≈ 0。
- 文字比 1280×800 的 JPEG 小几个数量级，即便偶尔未命中也很便宜。

---

## 工具

| 工具 | 作用 | 是否需要视觉端点 |
|---|---|---|
| `localvision_see` | 截屏 → 视觉端点 → 稳定文字描述（窗口/文字/可点元素）。**感知主工具。** | 是 |
| `localvision_ocr` | 截屏 → 视觉端点逐字提取文字。需要读具体文字时用。 | 是 |
| `localvision_click` | 在屏幕上点击。坐标用归一化(0-1)，由本机乘回原生像素，**自适应任意分辨率/DPI/宽高比**。三级兜底：`text`(OCR 锚定,优先) > `x,y`(归一化回退,始终可用) > 看图兜底(需视觉端点)。 | Tier2 不需要；Tier1/Tier3 需要 |

---

## 配置（`worlds.localvision`）

| 键 | 默认 | 说明 |
|---|---|---|
| `visionApiBaseUrl` | `''`（空 = 轻量模式） | 通用视觉端点（OpenAI 兼容 `/v1`）。本地填 `http://127.0.0.1:11434/v1`；云端填其 `/v1`。**空则不调用任何视觉模型**。 |
| `visionApiKey` | `''` | Bearer Token；本地 Ollama / LM Studio 等留空 |
| `visionApiModel` | `''` | 模型名：本地如 `minicpm-v2.6` / `qwen2-vl`；云端如 `gpt-4o` |
| `visionApiTimeoutMs` | `8000` | 单次视觉调用超时（毫秒）；兜底失败即降级、不卡死 |
| `screenshotMaxWidth` | `1280` | 发给视觉端点的图宽上限。截原生分辨率后**等比缩放**到此上限（只缩不放，不变形） |
| `screenshotMaxHeight` | `800` | 发给视觉端点的图高上限 |

**轻量模式（默认）**：以上视觉相关键都为空 → 桌宠不加载任何模型、最流畅，仅 `localvision_click` 的 `x,y` 可用。
**视觉增强模式**：填好 `visionApiBaseUrl` + `visionApiModel` → 解锁 `see` / `ocr` 与点击的 OCR 锚定 / 看图兜底。

运行前（视觉增强模式）：`ollama pull minicpm-v2.6`（或任意视觉模型）；或把 `visionApiBaseUrl` 指向云端端点并填 `visionApiKey`。

---

## 怎么真正省到钱（集成方式）

本插件只负责"本地/可选感知 + 确定性点击"。要让云端**完全不收截图**，配合以下任一种：

- **方式 A（现在就能用）**：把 Coopanion 的模型连接指向我们之前写的**本地代理**
  （`coopanion_local_vision_proxy.py`）。代理会在 API 边界把所有图片（含 cua 工具回执里的截图）
  替换成本地 VLM 的文字，云端彻底看不到图。这是当前的即时方案。
- **方式 B（更彻底，待做）**：让 cua World 不再自己上传截图，改为消费 `localvision_see` 的文字。
  需要给 `cortico-world-cua` 打补丁或提供一个替代 World，配合下面的"三级兜底点击"做确定性操作。

---

## 点击设计（三级兜底 + 分辨率无关）

`localvision_click` 采用三级兜底，全程坐标归一化(0-1)、由本机乘回原生像素，**不受任何分辨率/DPI/宽高比影响**：

### 三级兜底触发逻辑

1. **Tier1 — OCR / 视觉锚定（优先，精度最高；需视觉端点）**：传入 `text`（如 `"登录"`），本机用视觉端点在屏幕上定位该文字的归一化边界框并点其中心。
   - 触发：传入 `text` 且已配置视觉端点。成功即点；失败（定位不到 / 超时 / 异常）**不崩溃**，落入下一级。
2. **Tier2 — 归一化坐标回退（无模型依赖，最轻量，始终可用）**：传入 `x,y`（0-1），本机直接乘回原生像素点击。
   - 触发：Tier1 未走成（或轻量模式下本就无 Tier1）且传入了 `x,y`。
3. **Tier3 — 终极兜底（看图定位，仅在必要时传图；需视觉端点）**：前两级都失败（或只给了文字意图但没锚定到），重新截图，把图片交给视觉端点按自然语言意图（复用 `text` 或显式 `intent`）定位中心坐标再点。
   - 触发：传入了 `text`/`intent`、Tier1 未命中、也无 `x,y`、且已配置视觉端点。
   - **受 `visionApiTimeoutMs` 超时与错误控制**：超时或端点报错即返回清晰错误文案，**绝不向上抛异常**。

> 关键保护：Tier1 的 OCR 与 Tier3 的看图都带超时与 try/catch；任一层失败都只降级，不会让一次点击调用崩溃或陷入死循环。轻量模式（未配置视觉端点）下，Tier1/Tier3 自动跳过，只剩 Tier2 归一化坐标，绝不卡顿。

### 自适应截图与坐标变换

- `localvision_see` / `localvision_ocr` 先用**原生物理分辨率**截屏（Windows 已设 `SetHighDpiMode(PerMonitorV2)`，绝不用逻辑像素），再**等比缩放**到
  `screenshotMaxWidth × screenshotMaxHeight` 上限（只缩不放，保持宽高比**不变形**）。
- 截图送给视觉端点；坐标一律**归一化(0-1)**，与分辨率、DPI、宽高比**完全无关**。
- 本机保存最近一次截图的变换基准（`nativeWidth/Height`、`scaledWidth/Height`、`scale`、`monitor`）。
  点击时执行 `原生像素 = 归一化坐标 × 原生尺寸`，因此无论屏幕是 1080p / 2K / 4K / 3:2，**点击都像素级命中**。

```
截屏(原生, DPI感知) ──等比缩放──▶ 缩放图 ──▶ 视觉端点 ──▶ 归一化坐标(0-1)
                                                              │
云端只见到归一化坐标 / 文字 ──────────────────────────────────┘
点击时：原生像素 = 归一化 × 原生尺寸（本机执行，坐标永不离开本机）
```

### 两种点击路径（精度从高到低）

1. **`text`（OCR / 视觉锚定，推荐，精度高；需视觉端点）**：`localvision_click({ text: '登录' })`。
   本机用视觉端点在屏幕上定位该文字的归一化边界框，点其区域中心。
2. **`x, y`（归一化直接点击，回退；始终可用）**：`localvision_click({ x: 0.5, y: 0.3 })` 直接给归一化坐标点击。
   轻量模式下这是唯一路径；视觉增强模式下作为兜底。

> 多屏：截图默认主屏，可用 `localvision_see({ monitor: N })`（0-based）指定屏；点击沿用该基准。

---

## 开发与安装

```bash
corepack pnpm install        # 装 cortico 开发依赖（类型/校验用）
pnpm describe:extension .   # 重新生成 describe.json
pnpm check:extension .      # 契约与声明校验
node scripts/smoke.mjs      # 验证视觉端点连通性（需先启动 Ollama 或填云端端点）
```

装进 Coopanion / Cortico：扩展页「手动安装」填本目录绝对路径 → 重启 → World 总览启用；
或在部署 `config.json` 写 `worlds.localvision.enabled = true`。

---

## 许可

MIT。
