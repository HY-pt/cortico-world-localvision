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
| `localvision_see` | 截屏 → 本地 VLM → 稳定文字描述（窗口/文字/可点元素）。`structured=true` 时额外返回带 id 与归一化坐标的元素清单。**感知主工具。** |
| `localvision_ocr` | 截屏 → 本地模型逐字提取文字。需要读具体文字时用。 |
| `localvision_click` | 在屏幕上点击。坐标用归一化(0-1)，由本机乘回原生像素执行，**自适应任意分辨率/DPI/宽高比**。优先级：`elementId` > `text`（OCR 锚定） > `x,y`。 |

## 配置（`worlds.localvision`）

| 键 | 默认 | 说明 |
|---|---|---|
| `vlmBaseUrl` | `http://127.0.0.1:11434/v1` | 本地 OpenAI 兼容视觉端点（Ollama / LM Studio / llama.cpp） |
| `vlmModel` | `minicpm-v2.6` | 本地视觉模型；0.8B–4B 描述屏幕足够 |
| `screenshotMaxWidth` | `1280` | 发给 VLM 的图宽上限。截原生分辨率后**等比缩放**到此上限（只缩不放，不变形） |
| `screenshotMaxHeight` | `800` | 发给 VLM 的图高上限 |
| `ocrEnabled` | `true` | 是否开放 `localvision_ocr` |
| `autoSeeOnStart` | `false` | 预留 |

运行前：`ollama pull minicpm-v2.6`（或任意视觉模型）。

## 怎么真正省到钱（集成方式）

本插件只负责"本地感知"。要让云端**完全不收截图**，需配合以下任一种：

- **方式 A（现在就能用）**：把 Coopanion 的模型连接指向我们之前写的**本地代理**
  （`coopanion_local_vision_proxy.py`）。代理会在 API 边界把所有图片（含 cua 工具回执里的截图）
  替换成本地 VLM 的文字，云端彻底看不到图。这是当前的即时方案。
- **方式 B（更彻底，待做）**：让 cua World 不再自己上传截图，改为消费 `localvision_see` 的文字。
  需要给 `cortico-world-cua` 打补丁或提供一个替代 World，配合下面的"点击设计"做确定性操作。

## 点击设计（已实现：归一化坐标 + 元素引用，分辨率无关）

`localvision_click` 已不再是占位，核心思路是**把"屏幕分辨率"这件事完全挡在本机内部**：

### 自适应截图与坐标变换

- `localvision_see` / `localvision_ocr` 先用**原生物理分辨率**截屏（Windows 已设 `SetHighDpiMode(PerMonitorV2)`，绝不用逻辑像素），再**等比缩放**到
  `screenshotMaxWidth × screenshotMaxHeight` 上限（只缩不放，保持宽高比**不变形**）。
- 缩放图送给本地 VLM；VLM 给出的所有坐标都是**归一化(0-1)**，与分辨率、DPI、宽高比**完全无关**。
- 本机保存最近一次截图的变换基准（`nativeWidth/Height`、`scaledWidth/Height`、`scale`、`monitor`）。
  点击时执行 `原生像素 = 归一化坐标 × 原生尺寸`，因此无论你屏幕是 1920×1080、2K、4K 还是 3:2，
  **点击都像素级命中**。

```
截屏(原生, DPI感知) ──等比缩放──▶ 缩放图 ──▶ 本地VLM ──▶ 归一化坐标(0-1)
                                                              │
云端只见到归一化坐标 / 文字 ──────────────────────────────────┘
点击时：原生像素 = 归一化 × 原生尺寸（本机执行，坐标永不离开本机）
```

### 三种点击路径（优先级从高到低）

1. **`elementId`（最精确，推荐）**：`localvision_see({ structured: true })` 让本地 VLM 返回一份
   带 `id` 与归一化边界框的元素清单；云端只选 id，调用 `localvision_click({ elementId: 3 })`，
   本机解析为中心坐标并真实点击。**坐标不上云、不靠云端猜像素。**
2. **`text`（OCR 锚定）**：`localvision_click({ text: '登录' })`，本机用 VLM 在屏幕上定位该文字的
   边界框，点其区域中心。文字密集界面尤其好用。
3. **`x, y`（归一化直接点击，回退）**：`localvision_click({ x: 0.5, y: 0.3 })` 直接给归一化坐标点击。

> 多屏：截图默认主屏，可用 `localvision_see({ monitor: N })`（0-based）指定屏；点击沿用该基准。

这样云端 100% 是文字、点击确定性高、坐标永不离开本机，且**不受任何分辨率/DPI 影响**。

> 仍待你拍板的一点：VLM 出结构化元素框对模型有一定要求（0.8B–4B 的 MiniCPM-V/Qwen2-VL 基本可用，
> 但极小的模型可能框不准）。若你更在意兼容最弱模型，可默认走 `text`/`x,y` 回退，把 `structured` 设为可选。

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
