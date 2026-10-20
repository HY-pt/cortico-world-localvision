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
| `enabled` | `true` | World 总开关（还要在 World 总览里激活） |
| `ocrLang` | `''` | OCR 语言：`chi_sim`（中英，默认）、`eng`、`chi_sim+eng` 等；也接受 `zh-Hans` / `en-US` 自动映射 |
| `screenshotMaxWidth` | `1280` | 截图缩放上限；**要和内置 cua 的 `screenshot.maxWidth` 一致**，坐标才能直接复用 |
| `screenshotMaxHeight` | `800` | 同上 |
| `fallbackImage` | `true` | OCR 找不到文字时，是否把截图作为图片回退；`false` = 永不传图 |
| `hookIntercept` | `true` | **硬拦截**：注册核心 hook，把内置 cua 的截图回执换成 OCR 文本（框架没打 hook 时自动降级） |
| `hookTools` | `["pet_cua_screenshot","pet_cua_zoom","cua_screenshot","cua_zoom"]` | 额外强制拦截的工具名；带 `screen/zoom/截图` 特征的 blob 无论工具名都会被拦 |
| `onOcrEmpty` | `"image"` | OCR 找不到文字时：`image` 保留原图，`text` 丢弃图片只留提示 |

---

## OCR 后端：tesseract.js（为什么不是系统 OCR）

- 试过 Windows 自带的 WinRT OCR，但它要用 **PowerShell + .NET 反射** 调 WinRT，**卡巴斯基等杀软会直接拦掉**（本机实测）。
- 现在用 **tesseract.js 7（纯 Node / WASM）**：不启外部进程、不加载反射、不落 exe，Windows / macOS / Linux 一致，杀软友好。
- 语言数据首次使用时下载到部署数据目录的 `localvision-tessdata/`，之后复用：`chi_sim` 约 2.5 MB、`eng` 约 5 MB。
- 不需要安装 tesseract，也不需要任何视觉大模型。

---

## 坐标为什么能直接给 `pet_cua_*`

两边都用同一套等比缩放：`min(maxW/w, maxH/h, 1)`，默认 `1280×800`，只缩不放。

- 同一显示器下，`localvision_see` 返回的截图像素 = `pet_cua_click` 要的截图像素；
- 多屏时给 `localvision_see` 传 `display`（1 起，1 = 最左），与 `pet_cua_*` 用同一个编号；
- 如果你改过任一边的 `maxWidth/maxHeight`，两边要改成一样。

---

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `localvision_see` | `display?`（1 起）、`prompt?`（仅提示） | 阅读顺序文字 + 每个词的中心坐标（截图像素）；没文字时按 `fallbackImage` 回退图片 |
| `localvision_ocr` | `display?` | 纯文本（不含坐标、不回退图片） |

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
node --experimental-transform-types scripts/describe-extension.ts .   # 生成 describe.json
node --experimental-transform-types scripts/check-extension.ts .      # 契约校验
```

装进 Coopanion：扩展页「手动安装」填本目录绝对路径 → 重启 → World 总览启用。

---

## 许可

MIT。
