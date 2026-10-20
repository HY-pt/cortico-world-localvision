## 本地视觉

看屏幕优先用 `localvision_see`：它在你的电脑上把屏幕 OCR 成文字 + 截图像素坐标，默认不把图片发给云端。

{{localvision.intercept}}

操作电脑用内置的 `pet_cua_*` 工具：点击 `pet_cua_click`、移动 `pet_cua_move`、拖拽 `pet_cua_drag`、滚动 `pet_cua_scroll`、打字 `pet_cua_type`、按键 `pet_cua_key`、窗口 `pet_cua_windows` / `pet_cua_focus`、等待 `pet_cua_wait`。

坐标直接用 `localvision_see` 返回的截图像素；它与 `pet_cua_*` 一致（同一显示器、默认 1280×800 缩放）。多屏时给 `localvision_see` 传同一个 `display`（1 起）。
