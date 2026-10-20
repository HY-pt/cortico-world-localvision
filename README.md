# cortico-world-localvision（本地视觉 / LocalVision）

Coopanion / Cortico 的 **World 扩展**，给桌宠提供「屏幕感知 + 点击」能力，把云端 token 压到最低。

> 插件名：local vision（本地视觉）｜包名：`cortico-world-localvision`｜契约：`api: 6`

> **想直接装来用？** 推荐装已改造好的 [`HY-pt/cortico-world-cua`](https://github.com/HY-pt/cortico-world-cua)（方式 B，更彻底、且复用你 Coopanion 已填的 Key）。本仓库是这套思路的**独立设计原型 / PoC**。

---

## 产品定位：轻量优先，视觉兜底可选

作为**轻量级桌宠软件**，首要保证是**不卡顿、不烧 token**：

- **默认（轻量模式）完全不调用任何视觉大模型**：
  - 「看屏」用**本机原生 OCR**（Windows 10/11 内置 WinRT OCR / macOS tesseract），免下载、免模型、快。
  - 「点击」用**归一化坐标**（Tier2），无模型依赖，永远可用。
  - => 桌宠不联网传图、不加载模型、不占显存，最流畅。
- **视觉兜底（Tier3 看图定位）是【可选开关】，默认关闭**：
  - 仅当 `visionFallbackEnabled = true` **且** 填了 `visionApiBaseUrl` 时才启用；
  - 它是一个**标准 OpenAI 兼容 `/v1` 端点**——用户可填**本地 Ollama / LM Studio** 或**云端**，代码不硬编码、不假设任何后端在运行。
  - **Ollama 只是这个通用端点的一个示例，不是必需项**：本仓库默认不调用任何视觉模型，只有你显式打开 `visionFallbackEnabled` 并填 `visionApiBaseUrl` 时才会用到它。
- **彻底解耦本地模型**：本插件不依赖、不硬编码、不假设 Ollama 在运行。视觉端点只是配置项，填不填、填哪个完全由用户决定。

---

## 为什么能降 token

Coopanion「操作电脑」每轮都把屏幕截图发给云端。截图每帧都在变，导致云端输入前缀每轮变化，
**提示词缓存被击穿**——账单里 8% 的未命中输入占了 73% 成本，且视觉 token 本身很贵。

本插件把"看屏"从"每轮传图"改为"本机文字化 + 归一化坐标"：

```
轻量模式（默认）：   本机原生 OCR 文字  ·  归一化坐标点击   —— 完全不调用视觉模型
视觉兜底（可选）：   前两层都失败 -> 截图传视觉端点看图定位 —— 仅在必要时、可配置
```

- 屏幕没变时，OCR/描述**几乎不变** → 云端输入前缀稳定 → 缓存持续命中。
- 云端**收不到任何原始截图**（默认连图片都不截给模型，直接收归一化坐标）→ 视觉 token ≈ 0。
- 文字比 1280×800 的 JPEG 小几个数量级，即便偶尔未命中也很便宜。

---

## 工具

| 工具 | 作用 | 默认（轻量）是否需要模型 | 视觉兜底是否参与 |
|---|---|---|---|
| `localvision_see` | 截屏感知：默认用**本机原生 OCR** 把可见文字当"屏幕描述"返回；启用视觉兜底且配端点时改用视觉端点生成更丰富描述。 | 否（本机 OCR） | 可选（描述更丰富） |
| `localvision_ocr` | 截屏 → **本机原生 OCR** 逐字提取文字。本机无 OCR 且启用视觉兜底时回退到视觉端点 OCR。 | 否（本机 OCR） | 可选（回退） |
| `localvision_click` | 屏幕点击，坐标归一化(0-1)，本机乘回原生像素，**自适应任意分辨率/DPI/宽高比**。三级兜底：`text`(本机OCR锚定,优先) > `x,y`(归一化回退,始终) > `intent`(看图兜底,默认关)。 | 否（Tier1/Tier2 免模型） | Tier3 参与（默认关） |

---

## 配置（`worlds.localvision`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | Cortico World 总开关 |
| `visionFallbackEnabled` | `false` | **视觉兜底显式开关**。必须 `true` 且配了 `visionApiBaseUrl` 才会启用 Tier3 看图定位；**默认关闭**。 |
| `visionApiBaseUrl` | `''` | 通用视觉端点（OpenAI 兼容 `/v1`）。本地填 `http://127.0.0.1:11434/v1`；云端填其 `/v1`。**空=不用视觉模型**。 |
| `visionApiKey` | `''` | Bearer Token；本地 Ollama / LM Studio 等留空 |
| `visionApiModel` | `''` | 模型名：本地如 `minicpm-v2.6` / `qwen2-vl`；云端如 `gpt-4o` |
| `visionApiTimeoutMs` | `8000` | 单次视觉调用超时（毫秒）；兜底失败即降级、不卡死 |
| `ocrLang` | `''` | 预留：原生 OCR 语言偏好（当前自动选系统/英文） |
| `cropPadding` | `0.2` | 两级截图：局部裁剪时围绕 `lastNormPoint` 扩展的归一化半幅（0..0.45）。越小越省，越大越不易漏 |
| `screenshotMaxWidth` | `1280` | 发给识别引擎的图宽上限。截原生分辨率后**等比缩放**到此上限（只缩不放，不变形） |
| `screenshotMaxHeight` | `800` | 发给识别引擎的图高上限 |

**轻量模式（默认）**：`visionFallbackEnabled=false` 且 `visionApiBaseUrl=''` → 桌宠只用本机 OCR + 归一化坐标，不加载任何模型、最流畅。
**视觉兜底模式**：`visionFallbackEnabled=true` + 填好 `visionApiBaseUrl`/`visionApiModel` → 解锁 Tier3 看图定位（及更丰富的 see 描述）。

---

## 点击设计（三级兜底 + 两级截图 + 分辨率无关）

`localvision_click` 采用三级兜底，全程坐标归一化(0-1)、由本机乘回原生像素，**不受任何分辨率/DPI/宽高比影响**：

### 三级兜底触发逻辑

1. **Tier1 — 本机 OCR 文字锚定（优先，免模型，精度高）**：传入 `text`（如 `"登录"`），本机用**原生 OCR** 在屏幕上定位该文字并点其中心。
2. **Tier2 — 归一化坐标回退（无模型依赖，最轻量，始终可用）**：传入 `x,y`（0-1），本机直接乘回原生像素点击。
3. **Tier3 — 终极兜底（看图定位，仅在必要时传图；默认关闭）**：前两级都失败（或只给了 `intent` 但没锚定到），**重新截图**交给视觉端点按自然语言意图（`intent`，缺省复用 `text`）定位中心坐标再点。
   - 触发条件：`intent` 有值 + `visionFallbackEnabled=true` + 已配置视觉端点。否则自动跳过。

> 关键保护：Tier1 的 OCR 与 Tier3 的看图都带超时与 try/catch；任一层失败都只降级，不会让一次点击调用崩溃或陷入死循环。Tier3 默认关闭，轻量模式下点击只有 Tier1(OCR)+Tier2。

### 两级截图策略（Tier1 / Tier3 的文本/视觉定位共用）

为节约，定位前**先局部裁剪**、失败再全屏：

1. **第一级（节约模式）**：若有上次成功定位/点击的归一化坐标 `lastNormPoint`，围绕它按 `cropPadding` 扩展出一个局部矩形，**只截这一小块**（Windows 直接 `CopyFromScreen` 子矩形；macOS `screencapture -R`）。小块图送识别，token/算力都小。
2. **第二级（全屏兜底）**：局部识别失败 → 自动降级为**全屏截图**再识别一次。

`cropPadding` 控制裁剪范围大小，**可配置**；范围太小可能漏掉目标（触发全屏兜底，多花一次），太大则省得不多。默认 0.2（约覆盖屏幕 40% 区域）。

### 自适应截图与坐标变换

- 截屏先用**原生物理分辨率**（Windows 已设 `SetHighDpiMode(PerMonitorV2)`，绝不用逻辑像素），再**等比缩放**到
  `screenshotMaxWidth × screenshotMaxHeight` 上限（只缩不放，保持宽高比**不变形**）。
- 坐标一律**归一化(0-1)**，与分辨率、DPI、宽高比**完全无关**。
- `CaptureTransform` 自带 `regionX/Y/W/H`：无论全屏还是局部裁剪，点击还原都按
  `原生像素 = regionX + 归一化×regionW`（裁剪图也能正确回到屏幕绝对位置）。因此 1080p / 2K / 4K / 3:2 **像素级命中**。

```
截屏(原生, DPI感知) ──等比缩放──▶ 缩放图 ──▶ 本机OCR/视觉端点 ──▶ 归一化坐标(0-1)
                                                              │
云端只见到归一化坐标 / 文字 ──────────────────────────────────┘
点击时：原生像素 = regionX + 归一化 × regionW（本机执行，坐标永不离开本机）
```

### 用法示例

```js
// 默认轻量模式即可：
see  = localvision_see()          // 本机 OCR 文字描述
click= localvision_click({ text: '登录' })   // Tier1 本机 OCR 锚定（先局部裁剪，失败全屏）
click= localvision_click({ x: 0.5, y: 0.3 }) // Tier2 归一化坐标回退
```

> 多屏：截图默认主屏，可用 `localvision_see({ monitor: N })`（0-based）指定屏；点击沿用该基准。

---

## 怎么真正省到钱（集成方式 · 已落地）

本仓库（`cortico-world-localvision`）是这套思路的**独立设计原型 / PoC**（一个 `api: 6` 的 World，自带 `localvision_see/ocr/click` 三件套，零模型依赖、通用视觉端点可选）。

要把"云端不收 cua 截图"真正落地到 Coopanion，**推荐直接装已改造好的 cua 分支**（更彻底、且复用你已填的 Key，无需第二遍配置）：

- **✅ 方式 B（已落地，推荐）**：[`HY-pt/cortico-world-cua`](https://github.com/HY-pt/cortico-world-cua) —— Fork 原版 `cortico-world-cua`，在 `cua_screenshot` 链路里加了本机 OCR 拦截 + 两级截图 + 复用 Coopanion 已配视觉 API 的兜底。安装与配置见该仓库 README。
- 方式 A（本地代理在 API 边界替换截图）：指单独起一个代理进程，在 API 出口把截图换成文字，**不在本仓库内**，需自行搭建。它和本仓库的 `localvision` World 不是一回事——后者是 in-Cortico 的独立实现，不经任何外部代理。

> 结论：**以方式 B（cua 分支）为主**。本 `localvision` 仓库保留作为思路原型与独立 World（若你想要一套不依赖 cua 的 `localvision_*` 工具集可直接启用，它不需要任何外部代理）。

---

## 开发与安装

```bash
corepack pnpm install        # 装 cortico 开发依赖（类型/校验用）
pnpm describe:extension .   # 重新生成 describe.json
pnpm check:extension .      # 契约与声明校验（应全过）
node scripts/smoke.mjs      # 验证视觉端点连通性（可选，需填端点；不填则验证本机 OCR 路径）
```

装进 Coopanion / Cortico：扩展页「手动安装」填本目录绝对路径 → 重启 → World 总览启用；
或在部署 `config.json` 写 `worlds.localvision.enabled = true`。

---

## 许可

MIT。
