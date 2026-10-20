# cortico-world-localvision（本地视觉）

Coopanion / Cortico 的 World 扩展：**截屏在本机由本地视觉模型转成稳定文字，云端只收文字**，
用来提升提示词缓存命中、降低 token 消耗。

> 插件名：local vision（本地视觉）｜包名：`cortico-world-localvision`｜契约：`api: 6`

---

## 为什么能降 token

Coopanion「操作电脑」每轮都把屏幕截图发给云端。截图每帧都在变，导致云端输入前缀每轮变化，
**提示词缓存被击穿**——账单里那 8% 的未命中输入占了 73% 的成本，且视觉 token 本身很贵。

本插件把"看屏"改成本地行为：

```
截屏 ──本机──▶ 本地视觉模型 ──▶ 稳定文字描述 ──▶ 云端(只收文字)
```

- 屏幕没变时，文字描述**几乎不变** → 云端输入前缀稳定 → 缓存持续命中。
- 云端**收不到任何图片** → 视觉 token ≈ 0。
- 文字比 1280×800 的 JPEG 小几个数量级，即便偶尔未命中也很便宜。

## 工具

| 工具 | 作用 |
|---|---|
| `localvision_see` | 截屏 → 本地 VLM → 稳定文字描述（窗口/文字/可点元素）。**感知主工具。** |
| `localvision_ocr` | 截屏 → 本地模型逐字提取文字。需要读具体文字时用。 |
| `localvision_click` | 在屏幕上点击。坐标用归一化(0-1)，由本机乘回原生像素执行，**自适应任意分辨率/DPI/宽高比**。两条路径：`text`（OCR/视觉锚定，精度高，优先）> `x,y`（归一化直接点击，回退）。 |

## 配置（`worlds.localvision`）

| 键 | 默认 | 说明 |
|---|---|---|
| `vlmBaseUrl` | `http://127.0.0.1:11434/v1` | 本地 OpenAI 兼容视觉端点（Ollama / LM Studio / llama.cpp） |
| `vlmModel` | `minicpm-v2.6` | 本地视觉模型；0.8B–4B 描述屏幕足够 |
| `screenshotMaxWidth` | `1280` | 发给 VLM 的图宽上限。截原生分辨率后**等比缩放**到此上限（只缩不放，不变形） |
| `screenshotMaxHeight` | `800` | 发给 VLM 的图高上限 |
| `ocrEnabled` | `true` | 是否开放 `localvision_ocr` |
| `autoSeeOnStart` | `false` | 预留 |
| `visionApiBaseUrl` | `''`（回退到 `vlmBaseUrl`） | Tier3 终极兜底的 Vision API 端点（OpenAI 兼容 /chat/completions）。留空则默认仍走本地 Ollama；也可填云端端点 |
| `visionApiKey` | `''` | 云端 Vision API 的 Bearer Token；本地 Ollama 留空 |
| `visionApiModel` | `''`（回退到 `vlmModel`） | Tier3 使用的模型名 |
| `visionApiTimeoutMs` | `20000` | Tier3 调用超时（毫秒），超时即判兜底失败、转清晰报错 |

运行前：`ollama pull minicpm-v2.6`（或任意视觉模型）。若要用云端 Vision API 做终极兜底，另配 `visionApiBaseUrl` + `visionApiKey`。

## 怎么真正省到钱（集成方式）

本插件只负责"本地感知"。要让云端**完全不收截图**，需配合以下任一种：

- **方式 A（现在就能用）**：把 Coopanion 的模型连接指向我们之前写的**本地代理**
  （`coopanion_local_vision_proxy.py`）。代理会在 API 边界把所有图片（含 cua 工具回执里的截图）
  替换成本地 VLM 的文字，云端彻底看不到图。这是当前的即时方案。
- **方式 B（更彻底，待做）**：让 cua World 不再自己上传截图，改为消费 `localvision_see` 的文字。
  需要给 `cortico-world-cua` 打补丁或提供一个替代 World，配合下面的"点击设计"做确定性操作。

## 点击设计（已实现：三级兜底 + 分辨率无关）

`localvision_click` 采用三级兜底，**不依赖结构化元素框**（对极小本地模型没必要），且全程坐标归一化(0-1)、由本机乘回原生像素：

### 三级兜底触发逻辑

1. **Tier1 — OCR / 视觉锚定（优先，精度最高）**：给出 `text`（如 `"登录"`），本机用本地 VLM 在屏幕上定位该文字的归一化边界框并点其中心。
   - 触发：传入 `text`。成功即点；失败（定位不到 / 超时 / 异常）**不崩溃**，落入下一级。
2. **Tier2 — 归一化坐标回退**：给出 `x,y`（0-1），本机直接乘回原生像素点击。
   - 触发：未走成 Tier1 且传入了 `x,y`。
3. **Tier3 — 终极兜底（看图定位，仅在必要时传图）**：前两级都失败（或只给了文字意图但没锚定到），重新截图，把图片传给配置的 **Vision API** 让其按自然语言意图（复用 `text` 或显式 `intent`）定位中心坐标再点。
   - 触发：传入了 `text`/`intent` 且 Tier1 未命中、也无 `x,y`。
   - **受 `visionApiTimeoutMs` 超时与错误控制**：超时或 API 报错即返回清晰错误文案，**绝不向上抛异常**；未配置 `visionApiBaseUrl` 时默认回退到本地 `vlmBaseUrl`（即默认仍走本地、不额外花钱）。

> 关键保护：Tier1 的 OCR 与 Tier3 的 Vision API 都带超时与 try/catch；任一层失败都只降级，不会让一次点击调用崩溃或陷入死循环。

### 自适应截图与坐标变换

- `localvision_see` / `localvision_ocr` 先用**原生物理分辨率**截屏（Windows 已设 `SetHighDpiMode(PerMonitorV2)`，绝不用逻辑像素），再**等比缩放**到
  `screenshotMaxWidth × screenshotMaxHeight` 上限（只缩不放，保持宽高比**不变形**）。
- 缩放图送给本地 VLM；坐标一律**归一化(0-1)**，与分辨率、DPI、宽高比**完全无关**。
- 本机保存最近一次截图的变换基准（`nativeWidth/Height`、`scaledWidth/Height`、`scale`、`monitor`）。
  点击时执行 `原生像素 = 归一化坐标 × 原生尺寸`，因此无论屏幕是 1080p / 2K / 4K / 3:2，**点击都像素级命中**。

```
截屏(原生, DPI感知) ──等比缩放──▶ 缩放图 ──▶ 本地VLM ──▶ 归一化坐标(0-1)
                                                              │
云端只见到归一化坐标 / 文字 ──────────────────────────────────┘
点击时：原生像素 = 归一化 × 原生尺寸（本机执行，坐标永不离开本机）
```

### 两条点击路径（精度从高到低）

1. **`text`（OCR / 视觉锚定，推荐，精度高）**：`localvision_click({ text: '登录' })`。
   本机用本地 VLM 在屏幕上定位该文字的归一化边界框，点其区域中心。
   **相比直接给坐标，OCR 锚定把"文字→位置"的 grounding 交给本地模型，精度更高、对极小模型更稳。**
2. **`x, y`（归一化直接点击，回退）**：`localvision_click({ x: 0.5, y: 0.3 })` 直接给归一化坐标点击。
   当具体文字拿不准时使用。

> 多屏：截图默认主屏，可用 `localvision_see({ monitor: N })`（0-based）指定屏；点击沿用该基准。

这样云端 100% 是文字、点击确定性高、坐标永不离开本机，且**不受任何分辨率/DPI 影响**；
对极小视觉模型也只需它做"看描述"和"文字→位置"的轻量 grounding，无需输出复杂结构化元素框。

## 开发与安装

```bash
corepack pnpm install        # 装 cortico 开发依赖（类型/校验用）
pnpm describe:extension .   # 重新生成 describe.json
pnpm check:extension .      # 契约与声明校验
```

装进 Coopanion / Cortico：扩展页「手动安装」填本目录绝对路径 → 重启 → World 总览启用；
或在部署 `config.json` 写 `worlds.localvision.enabled = true`。

## 许可

MIT。
