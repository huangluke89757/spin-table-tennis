# Implementation Plan: 旋转乒乓 · 移动端纯手势操作（横屏 + 平板）

## Overview

基于已交付的《移动端手势可行性分析报告》，把当前「鼠标 + 键盘」操作改造为「横屏 + 平板」下的纯手势操作。
分三阶段推进：**P0 输入层地基**（touch-action 四层覆盖 + Pointer Events 统一 + 量纲归一化 + 横屏适配）、
**P1 触屏手势**（双区手势 + 拍面辅助跟随 + 触屏控制簇 + 浮层可达）、**P2 手机竖屏降级**（仅平板横屏支持，其余显示「请横屏」引导）。

**核心约束**：桌面端（鼠标 + 键盘 + 滚轮）必须零回归；所有结论均来自报告里的 8 条真浏览器实测证据（E1–E8），
改造方法已用 5 轮 Playwright 探针验证可行（6/6 手势识别有效击球、4/6 成功回球得分）。

---

## 一、架构决策

### 决策 1：输入层用 Pointer Events 统一，而非新增独立 Touch 分支
- 现有 `setupInput` 只绑 `mousedown/mousemove/mouseup` + `wheel` + `keydown`。
- 改用 `pointerdown/pointermove/pointerup`（统一 mouse/touch/pen），**删除原 mouse 监听**，避免 mouse+pointer 双触发 `doHit`。
- 桌面鼠标走 `pointerType==="mouse"` 仍被覆盖；`wheel` 拍面保留给桌面；键盘快捷键全部保留。
- 必须配 `touch-action:none`（见决策 2），否则触摸会被浏览器手势掐断成 `pointercancel`。

### 决策 2：touch-action 必须覆盖四层 + HUD 交互元素单独设
- 报告 E2/E5 实测：只给 `#cv` 设 `none` 不够——触摸点落在 HUD 元素（hudKeys/hudCfg）上时仍会被 `pointercancel`。
- 必须 `html, body, #stage, #cv` 全部 `touch-action:none` + `overscroll-behavior:none`；
  HUD 里真正可交互的元素（按钮 / range / 模式卡）单独 `touch-action:none`，其余面板设 `pointer-events:none` 让出触摸区。

### 决策 3：量纲归一化到视口，而非绝对像素
- 报告 E8：旧 `dx/140`、`len/190`、`speed/1100` 全是绝对 CSS 像素，竖屏屏宽仅 PC 9.7%，手机精度需求是 PC 的 ~3.7×。
- 新增 `normDrag()`：把位移按「视口宽/高/对角线」归一（如 `aim = dx/(0.30*vw)`、`lenN = len/(0.22*vmin)`、`speedN = (len/secs)/(0.9*vmin)`），
  做到分辨率 / 方向无关。桌面端手感通过系数微调保持与现状一致（用 Task 11 触摸测试校准）。

### 决策 4：双区手势 = 左手调拍面 / 右手击球（与「左手键盘 + 右手鼠标」同构）
- `pointerdown` 命中测试：`clientX < 0.45*vw` → 左区（调拍面，替代滚轮/AD）；否则右区（击球，替代鼠标拖拽）。
- 左区纵向拖拽映射到 `G.paddleAngle∈[-1,1]`（上=亮拍，下=压拍）。
- 右区拖拽写入 `drag` 对象，松手调用 `doHit(drag)`——直接复用真实物理内核，不重写判定。

### 决策 5：拍面辅助跟随只在「辅助开」时启用（挑战模式全手动）
- 报告 P1：辅助开（`G.assist`）时每帧 `G.paddleAngle = correctTiltFor(G.spin)` 实时跟随，玩家只需做击球手势 + 方向；
  左区拖拽在辅助态下禁用（自动已是最优），避免「自动值被手动覆盖」的混乱。
- 挑战模式（`G.assist=false`，由 `setMode` 强制）左区完全手动——保留「看旋转、自己调拍面」的核心技巧点。

### 决策 6：P2 门控规则 =「仅平板横屏」
- `isTabletLandscape = matchMedia("(pointer:coarse)").matches && matchMedia("(min-width:768px)").matches && matchMedia("(orientation:landscape)").matches`
- 放行条件：`!coarse`（桌面）OR `isTabletLandscape`（平板横屏）。
- 其余（手机任意方向、平板竖屏）显示「请横屏」全屏引导层，不进入对局。
- 开放问题：宽屏手机横置（CSS 宽 ≥768）会误放行。可接受（其横屏本就可玩）；若需严格排除，改用 UA/设备内存启发式，列为待定。

### 决策 7：验证复用探针方法论，沉淀为常驻回归
- 现有 5 个 `_probe_touch*.js`（工作区根）是一次性探针，归档进 `_tools/` 作参考；
  正式测试新建 `_tools/_touch.js`，用 Playwright CDP `Input.dispatchTouchEvent` 注入真实触摸，复刻 E1–E8 断言并接入 `_run_all.js`。

---

## 二、任务清单

### Phase 0 — P0 输入层地基

- [ ] **Task 1 [S]** 移动端视口与触摸拦截（viewport + touch-action 四层覆盖 + HUD 交互元素）
- [ ] **Task 2 [M]** Pointer Events 统一输入（mouse→pointer，消除双触发；保留 wheel + 键盘）
- [ ] **Task 3 [M]** doHit 量纲归一化（normDrag，视口比例，桌面手感不变）
- [ ] **Task 4 [S]** 横屏布局适配（resize3D 绑 orientationchange；移动端 HUD 死区清理）

### Checkpoint: P0（桌面零回归 + 平板横屏能开局、触摸不被掐断）
- [ ] `node _syntax.js` 全绿、`node _smoke.js` 旧断言不回归
- [ ] 真浏览器（iPad 横屏视口）注入触摸序列：无 `pointercancel`、单次拖拽能触发 `doHit`

### Phase 1 — P1 触屏手势

- [ ] **Task 5 [M]** 双区手势（右区击球 + 左区调拍面，命中测试分流）
- [ ] **Task 6 [M]** 拍面辅助跟随（辅助开自动 correctTiltFor；挑战模式左区全手动）
- [ ] **Task 7 [M]** 触屏控制簇（暂停 / 重开 / 辅助 / 正反手 按钮，替代 Esc/P/R/H/Shift）+ 浮层触屏可达

### Checkpoint: P1（平板横屏纯手势可完整对局）
- [ ] 真浏览器：双区手势下能连续回球 ≥3 拍、拍面随左区变化、控制簇各按钮生效
- [ ] 桌面端：鼠标 + 键盘 + 滚轮仍完全可用，旧断言不回归

### Phase 2 — P2 手机竖屏降级

- [ ] **Task 8 [M]** 设备/方向门控（仅平板横屏放行，其余拦截）
- [ ] **Task 9 [S]** 「请横屏」引导层（竖屏/非平板遮罩 + orientationchange/resize 实时切换）

### Checkpoint: P2（手机竖屏显示引导、不进入对局）
- [ ] 手机竖屏视口：引导层可见、对局界面不可达
- [ ] 平板横屏视口：引导层隐藏、正常进入

### Phase 3 — 验证与上线

- [ ] **Task 10 [M]** 移动端回归测试（`_tools/_touch.js`，复刻 E1–E8，接入 `_run_all.js`）
- [ ] **Task 11 [S]** 全量回归 + 版本戳 + 部署 + 线上验证

### Checkpoint: 完成
- [ ] 平板横屏纯手势完整可玩、桌面零回归、线上可访问、移动端断言全 PASS

---

## 三、任务详情

### Task 1: 移动端视口与触摸拦截 [S]
**Description:** 改 `index.html` 的 viewport meta（加 `user-scalable=no, maximum-scale=1, viewport-fit=cover`），并在 CSS 给 `html, body, #stage, #cv` 设 `touch-action:none` + `overscroll-behavior:none`；HUD 内可交互元素（按钮 / range / 模式卡）单独 `touch-action:none`，纯展示面板 `.panel` 设 `pointer-events:none` 让出触摸区。

**Acceptance criteria:**
- [ ] viewport meta 含 `user-scalable=no` 与 `viewport-fit=cover`（禁止双指缩放、适配安全区）
- [ ] `html, body, #stage, #cv` 四层均有 `touch-action:none` 与 `overscroll-behavior:none`
- [ ] `#hudKeys` 文本块 `pointer-events:none`（消除报告 E5 的触摸死区）；`#btnUiToggle`/`btnMute`/`volRange`/模式卡仍 `auto` 且各自 `touch-action:none`
- [ ] 桌面端 `#hudAux` 收放逻辑（ui-collapsed）不受影响

**Verification:**
- [ ] `node _smoke.js`：断言 viewport 字符串含 user-scalable=no；断言 CSS 四层 `touch-action:none`
- [ ] 真浏览器注入触摸序列（Task 10）确认无 `pointercancel`

**Dependencies:** None
**Files:** `index.html`
**Scope:** Small

---

### Task 2: Pointer Events 统一输入 [M]
**Description:** 在 `setupInput` 中删除 `mousedown/mousemove/mouseup`，改为 `cv.addEventListener("pointerdown", …)` + `window` 上的 `pointermove/pointerup`。新增 `drag` 状态字段 `zone`（"hit"|"paddle"|null）。保留 `wheel`（桌面拍面）与全部 `keydown` 快捷键。`pointerup` 仅对非鼠标指针、且 zone==="hit" 时调 `doHit`，杜绝双触发。

**Acceptance criteria:**
- [ ] 无 `mousedown/mousemove/mouseup` 监听残留
- [ ] 桌面鼠标拖拽仍触发 `doHit`（pointerType==="mouse" 路径覆盖）
- [ ] 触摸拖拽触发 `doHit`，且 mouse+pointer 不会在同一拖拽里各调一次
- [ ] `wheel` 拍面、`Shift/A/D`、`H/M/Tab/R/P/Esc` 行为与原版完全一致

**Verification:**
- [ ] `node _smoke.js`：断言源码无 `mousedown` 字符串、有 `pointerdown`；旧键盘/滚轮断言不回归
- [ ] 桌面真浏览器：鼠标拖拽击球正常
- [ ] Task 10 触摸序列：触摸拖拽触发 `doHit`

**Dependencies:** Task 1
**Files:** `game.js`
**Scope:** Medium

---

### Task 3: doHit 量纲归一化 [M]
**Description:** 新增 `normDrag(drag)` 在 `doHit` 入口把像素位移换算成与视口相关的归一值：`aim = clamp(dx/(0.30*vw), -0.85, 0.85)`、`lenN = clamp(len/(0.22*vmin), 0, 1)`、`speedN = clamp((len/secs)/(0.9*vmin), 0, 1)`。原 `dx/140`、`len/190`、`speed/1100` 替换为归一结果。系数以桌面（1920×1080）手感为基准校准，使现有桌面体验不退化。

**Acceptance criteria:**
- [ ] `doHit` 不再出现绝对像素常量 140/190/1100
- [ ] 桌面真机（1920×1080）击球线路/力量手感与原版一致（回归测试覆盖 `aim` 映射区间）
- [ ] 平板横屏（如 1180×820）下小幅拖拽即可达到合理 aim/power，不再需要「拖满全屏」

**Verification:**
- [ ] `node _smoke.js`：注入已知 dx/len 断言 `aim/lenN/speedN` 落在预期区间（多分辨率）
- [ ] Task 10：iPad 横屏下中等拖拽回球成功

**Dependencies:** Task 2
**Files:** `game.js`
**Scope:** Medium

---

### Task 4: 横屏布局适配 [S]
**Description:** `resize3D` 额外绑定 `orientationchange` 事件（iOS Safari 旋转时不总触发 resize）；移动端 `matchMedia("(max-width:640px)")` 的 `#hudKeys` 隐藏规则扩展到触摸设备（改用 `@media (pointer:coarse)` 隐藏纯文本说明，因触屏无键盘）；确认 HUD 在平板横屏下不重叠。

**Acceptance criteria:**
- [ ] `orientationchange` 触发 `resize3D`（`CAM.aspect` 更新正确，无拉伸）
- [ ] 触摸设备隐藏 `#hudKeys` 文本块（避免死区），但配置按钮/收起开关保留
- [ ] 平板横屏（≥768px 宽）下 HUD 各面板 `getBoundingClientRect` 两两不重叠

**Verification:**
- [ ] `node _smoke.js`：断言 `resize3D` 注册了 `orientationchange`；断言粗指针下 `#hudKeys` 不渲染
- [ ] `_aux_shot.js` 风格布局断言在 1180×820 下两两求交为 0

**Dependencies:** Task 1
**Files:** `game.js`, `index.html`
**Scope:** Small

---

### Task 5: 双区手势 [M]
**Description:** `pointerdown` 命中测试分流：若 `clientX < 0.45*vw` 设 `drag.zone="paddle"` 并记录 `startY/startAngle`；否则 `drag.zone="hit"` 走原击球流程。`pointermove`：paddle 区 → `G.paddleAngle = clamp(startAngle + (startY - y)/paddleSpan, -1, 1)`（上拖亮拍、下拖压拍）；hit 区 → 更新 `drag.x/y`。`pointerup`：hit 区按 Task 2 流程调 `doHit`。

**Acceptance criteria:**
- [ ] 右区（>45% 宽）拖拽触发 `doHit`，线路/力量由拖拽方向/速度决定
- [ ] 左区（<45% 宽）纵向拖拽改变 `G.paddleAngle`，范围 [-1,1] 且方向正确
- [ ] 两个区同时各有一次独立手势时不串扰（各自 zone 隔离）
- [ ] 桌面鼠标仍走 hit 路径（zone 由 clientX 判定，鼠标同样适用）

**Verification:**
- [ ] Task 10：右区 swipe → `G.hitDone` 置位；左区纵向拖 → `G.paddleAngle` 单调变化
- [ ] `node _smoke.js`：新增命中测试单测（clientX 分桶）

**Dependencies:** Task 2, Task 3
**Files:** `game.js`
**Scope:** Medium

---

### Task 6: 拍面辅助跟随 [M]
**Description:** 在游戏主循环每帧（incoming 阶段）：若 `G.assist` 为真，设 `G.paddleAngle = correctTiltFor(G.spin)`（实时跟随当前旋转的正确拍面）；辅助态下左区拖拽不覆盖该自动值（或仅作微调偏移，由实现选定，本计划取「辅助态禁用左区手动」最简方案）。挑战模式 `G.assist=false` → 左区完全手动控制拍面。

**Acceptance criteria:**
- [ ] 辅助开 + 来球为「上旋」→ `G.paddleAngle` 自动趋近压拍负值；「下旋」→ 亮拍正值
- [ ] 辅助开时左区拖拽不影响拍面（自动值优先）
- [ ] 挑战模式（`setMode("challenge")` 后 `G.assist=false`）左区拖拽可自由设拍面，自动跟随关闭
- [ ] 自动跟随不破坏 `doHit` 的 `tiltErr` 计算（拍面数值真实进入判定）

**Verification:**
- [ ] `node _smoke.js`：断言辅助态每帧 `paddleAngle===correctTiltFor(spin)`；挑战态断言左区拖拽改变 paddleAngle
- [ ] Task 10：辅助开 iPad 横屏，不同旋转来球下拍面自动变化且回球成功

**Dependencies:** Task 5
**Files:** `game.js`
**Scope:** Medium

---

### Task 7: 触屏控制簇 + 浮层可达 [M]
**Description:** 新增一组触屏控制按钮（替代键盘 Esc/P/R/H/Shift）：暂停、重开、辅助开关、正反手切换。位置选不挡球台处（如右下控制簇或顶部贴近 `#topLinks` 下方），`pointer-events:auto` + `touch-action:none`，绑定 `togglePause()/restart()/辅助切换(复用 H 键逻辑，挑战模式拦截)/G.backhand=!G.backhand`。同时确认开始页模式卡、结束页「再来一局/分享海报」在触摸下可点（现有用 click，需确保 `touch-action` 不挡）。

**Acceptance criteria:**
- [ ] 四个触屏按钮均可见可点，且不与 `#topLinks`/`#hudAux` 重叠
- [ ] 暂停按钮 → `togglePause()`；重开 → `restart()`（仅对局中）；辅助按钮 → 复用 H 逻辑（挑战模式给提示不切换）；正反手 → `G.backhand` 翻转且 HUD `#uiMode` 同步
- [ ] 开始页模式卡、结束页按钮在触摸注入下可触发对应回调
- [ ] 桌面端不显示这组触屏按钮（仅在 coarse pointer 下出现，避免桌面冗余）

**Verification:**
- [ ] `node _smoke.js`：断言四个按钮 DOM 存在且绑定了处理函数；断言粗指针下可见、细指针下隐藏
- [ ] Task 10：触摸点击各按钮验证行为
- [ ] 桌面真浏览器：四个按钮不可见、键盘仍生效

**Dependencies:** Task 4, Task 6
**Files:** `index.html`, `game.js`
**Scope:** Medium

---

### Task 8: 设备/方向门控 [M]
**Description:** 新增 `isSupported()` 判定：`!matchMedia("(pointer:coarse)").matches`（桌面）OR（coarse && `min-width:768px` && `orientation:landscape`）（平板横屏）→ 放行。否则拦截。开局前与每次 `orientationchange/resize` 都重新判定。

**Acceptance criteria:**
- [ ] 桌面（fine pointer）→ 放行
- [ ] 平板（coarse + ≥768px）+ 横屏 → 放行
- [ ] 手机（coarse，任意方向）→ 拦截
- [ ] 平板竖屏（coarse + ≥768px + portrait）→ 拦截

**Verification:**
- [ ] `node _smoke.js`：用桩 matchMedia 注入四种组合，断言 `isSupported()` 返回正确
- [ ] Task 10：手机竖屏视口 `isSupported()===false`

**Dependencies:** Task 4
**Files:** `game.js`
**Scope:** Medium

---

### Task 9: 「请横屏」引导层 [S]
**Description:** 新增全屏遮罩 `#rotateHint`（默认隐藏），当 `!isSupported()` 时显示，文案「请将设备横置使用平板体验」；`isSupported()` 为真时隐藏。监听 `orientationchange`/`resize` 即时切换。遮罩 `z-index` 高于 HUD 但低于开始页之上（或覆盖全屏），`pointer-events:auto` 阻断误触。

**Acceptance criteria:**
- [ ] 非支持设备/方向 → `#rotateHint` 可见且覆盖全屏，对局界面不可达
- [ ] 旋转到平板横屏 → 遮罩立即隐藏，正常进入
- [ ] 桌面端永不显示该遮罩
- [ ] 遮罩自身 `touch-action:none`，旋转过程不触发页面滚动

**Verification:**
- [ ] `node _smoke.js`：断言 `!isSupported()` 时 `#rotateHint` 有可见类、`isSupported()` 时无
- [ ] Task 10：手机竖屏视口遮罩可见；切横屏后隐藏

**Dependencies:** Task 8
**Files:** `index.html`, `game.js`
**Scope:** Small

---

### Task 10: 移动端回归测试 [M]
**Description:** 新建 `_tools/_touch.js`（Playwright headless Chromium + SwiftShader），用 CDP `Input.dispatchTouchEvent` / `page.touchscreen` 注入真实触摸：① 四层 touch-action 下触摸序列无 `pointercancel`（E1/E2）；② 单指右区 swipe 触发 `doHit` 且能回球（E3/E4）；③ 双区分流正确（E4）；④ 竖屏 NDC 出屏/横屏 FOV 正常（E5，用视口切换验证）；⑤ 可用触摸区比例（E7）；⑥ 量纲归一后手机精度合理（E8）。复用 `_probe_touch*.js` 方法论，把 5 个探针归档到 `_tools/` 作参考。接入 `_run_all.js` 新增「移动端手势」关。

**Acceptance criteria:**
- [ ] `_touch.js` 覆盖 E1–E8 中可自动化项（至少 6 条），逐条 PASS
- [ ] 断言非假绿：触摸触发的是真实 `doHit` 副作用（如 `G.hitDone` / `rally` 变化），而非只查字符串
- [ ] `_run_all.js` 新增 `run("移动端手势", "_touch.js")` 且全绿
- [ ] 旧 71 项冒烟 + 十一关不回归

**Verification:**
- [ ] `node _run_all.js` 含移动端手势关且 PASS
- [ ] 人工复核 `_shots/` 下平板横屏截图（双区手势对局画面）

**Dependencies:** Task 1–9
**Files:** `_tools/_touch.js`, `_tools/_probe_touch*.js`（归档）, `_tools/_run_all.js`
**Scope:** Medium

---

### Task 11: 全量回归 + 部署 [S]
**Description:** 跑全套回归（语法 → 物理 61 → 数值一致性 4320 → 冒烟 71 → 截图/海报 → 声学 → 线上 → 移动端手势），刷新版本戳，部署，线上端到端验证。

**Acceptance criteria:**
- [ ] `node _run_all.js` 全关（含新增移动端手势关）绿
- [ ] `_stamp.py` 刷版本戳且 `index.html` 引用一致
- [ ] 线上部署成功，`_live_verify.js --live` 全 PASS，含新增移动端可达性探针

**Verification:**
- [ ] 线上 https://spin-pingpong.app.workbuddy.host/ 用平板横屏视口可纯手势对局

**Dependencies:** Task 10
**Files:** `index.html`（版本戳）
**Scope:** Small

---

## 四、风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 删除 mouse 监听后桌面拖拽失效（双触发修复过头） | 高 | Task 2 保留 pointerType==="mouse" 路径；Task 10 含桌面鼠标回归 |
| 量纲归一系数调偏，桌面手感退化 | 中 | Task 3 以 1920×1080 为校准基线，冒烟断言覆盖 aim 区间 |
| iOS Safari `orientationchange` 不全触发 → 横屏后画面拉伸 | 中 | Task 4 同时绑 `resize`+`orientationchange`，并监听 `visualViewport` |
| 双区命中测试与 HUD 按钮区域重叠（左下拍面栏/右下配置） | 中 | Task 5 左区阈值 0.45 与 HUD 位置错开；Task 7 按钮独占区域 |
| 宽屏手机横置误放行（CSS 宽≥768） | 低 | 决策 6 已记为可接受；如需严格排除改用 UA 启发式（待定） |
| 真机 GPU 帧率 / iOS 触摸节流未验证（headless 局限） | 中 | 报告已标注；上线后真机抽检，必要时降 pixelRatio |
| 触摸按钮与现有 `#topLinks`/`#hudAux` 层叠冲突 | 中 | Task 7 明确独占区域 + `z-index` 规划，布局断言防重叠 |

## 五、开放问题
- 宽屏手机横屏是否需严格拦截？（当前规则会放行，待用户确认）
- 辅助开时左区拖拽：完全禁用 / 仅作微调偏移？（本计划取「禁用」最简方案）
- 触屏控制簇位置：右下独立簇 vs 顶部贴近 `#topLinks`？（待布局断言后定）

## 六、Task List 位置
本地任务清单见同目录 `todo.md`。旧一轮（留存+开源）计划已归档为 `plan-retention-github.md` / `todo-retention-github.md`。
