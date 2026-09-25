# 旋转乒乓 · 移动端纯手势改造 任务清单

> 计划全文见 `plan.md`。本文件是执行用勾选清单（按 Phase 推进，每阶段有 Checkpoint）。
> 旧一轮（留存+开源）计划已归档为 `plan-retention-github.md` / `todo-retention-github.md`（全部完成）。

## Phase 0 — P0 输入层地基

- [x] **Task 1 [S]** 移动端视口与触摸拦截
  - viewport 加 `user-scalable=no, viewport-fit=cover`；`html/body/#hud/#cv` 四层 `touch-action:none` + `overscroll-behavior:none`
  - 交互控件（`.mini`/range/按钮/模式卡/ `.tbtn`/引导层）单独 `touch-action:none`
  - 验收：`_touch.js` 静态契约 8 项全 PASS（含「四层都盖住」）
- [x] **Task 2 [M]** Pointer Events 统一输入
  - 删 `mousedown/move/up`，改 `pointerdown/move/up`；保留 `wheel` + 键盘；`drag.zone` / `drag.type` 字段
  - 验收：`_touch.js` 断言「鼠标事件监听残留 = 0」；`_smoke.js` 桩已同步改派 pointer 事件
- [x] **Task 3 [M]** doHit 量纲归一化（**按键型分两套**）
  - 抽出纯函数 `measureDrag()`：鼠标沿用原版绝对像素 10/190/1100/140，触摸走 `TOUCHSCALE`（视口比例）
  - 判据用 `pointerType` 而非 `isCoarse()`：二合一设备上鼠标与手指各按各的算
  - 验收：`_touch.js` 断言鼠标 dx=70→aim 0.5（与原版一致）、触摸同 dx 显著更小
- [x] **Task 4 [S]** 横屏布局适配
  - `resize3D` 绑 `orientationchange`；`@media (pointer:coarse)` 隐藏 `#hudKeys`
  - 验收：`_touch.js` 断言 media 规则存在；`_aux_shot.js` 多尺寸两两求交不重叠（全 PASS）

### Checkpoint: P0
- [x] `node _syntax.js` 全绿、`node _smoke.js` 旧断言不回归（29.5 拍 / 0 FAIL）
- [x] 真浏览器（平板横屏视口）注入触摸：零 `pointercancel`、单拖拽触发 `doHit`

## Phase 1 — P1 触屏手势

- [x] **Task 5 [M]** 双区手势
  - `pointerdown` 命中测试：`clientX<0.45*vw`→左区调拍面，否则右区击球
  - 左区纵向拖 → `G.paddleAngle∈[-1,1]`；右区拖 → `drag`→`doHit`
  - 验收：`_touch.js` + `_touch_browser.js` 断言双区分流、左区不触发击球、右区真的回球得分
- [x] **Task 6 [M]** 拍面辅助跟随
  - 辅助开 + 触屏时 incoming 每帧 `G.paddleAngle=correctTiltFor(G.spin)`；辅助态左区手动被刻意忽略
  - 挑战模式（assist 关）左区全手动
  - 验收：两关均断言辅助态每帧跟随、挑战态左区可变
- [x] **Task 7 [M]** 触屏控制簇 + 浮层可达
  - 新增 暂停/重开/辅助/正反手 四按钮（替代 Esc/P/R/H/Shift），绑 `togglePause/restart/H逻辑/G.backhand`
  - 仅 coarse pointer 显示（`#hud.touch-on`）；桌面隐藏
  - 验收：两关断言四按钮 DOM + 绑定 + 行为 + 粗指针可见/细指针隐藏

### Checkpoint: P1
- [x] 真浏览器：触摸手势 6/8 次成功回球得分、左区拍面变化、控制簇真实渲染 214×46
- [x] 桌面端：鼠标 + 键盘 + 滚轮完全可用，`_smoke.js` / `_run_all.js` 零回归

## Phase 2 — P2 手机竖屏降级

- [x] **Task 8 [M]** 设备/方向门控
  - `isSupported()`：桌面(fine) 或 (coarse && ≥768px && landscape) → 放行；其余拦截
  - 验收：`_touch.js` 桩 matchMedia 五组合断言（桌面/平板横/平板竖/手机横/手机竖）
- [x] **Task 9 [S]** 「请横屏」引导层
  - 新增 `#rotateHint` 遮罩（z-index:30），`!isSupported()` 显示；`orientationchange/resize` 即时切换
  - 验收：真浏览器断言竖屏时引导层铺满全屏且屏幕中心命中它（对局真的不可达）

### Checkpoint: P2
- [x] 手机竖屏视口：引导层可见（360×780 全覆盖）、对局界面不可达
- [x] 平板横屏视口：引导层隐藏、正常进入

## Phase 3 — 验证与上线

- [x] **Task 10 [M]** 移动端回归测试
  - 新建 `_tools/_touch.js`（53 项：静态契约 + 沙箱运行时，含竖屏几何物理依据）
  - 新建 `_tools/_touch_browser.js`（22 项：CDP 真实触摸 + 三场景，真浏览器行为）
  - 5 个 `_probe_touch*.js` + 输出日志归档进 `_tools/probe-legacy/`
  - 接入 `_run_all.js` 为第 5/13、12/13 关
  - 验收：两关全绿且**非假绿**（右区真的让 `G.rally` 增长；左区真的改 `G.paddleAngle`）
- [ ] **Task 11 [S]** 全量回归 + 版本戳 + 部署 + 线上验证
  - [x] `_run_all.js` 13 关全绿（退出码 0）
  - [x] `_stamp.py` 刷戳 v8ea495c5
  - [ ] 提交推送 GitHub
  - [ ] 线上 `--live` 全 PASS

### Checkpoint: 完成
- [ ] 平板横屏纯手势完整可玩、桌面零回归、线上可访问、移动端断言全 PASS
