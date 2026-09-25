# 旋转乒乓 · 本轮任务清单

> 计划全文见 `plan.md`。本文件是执行用的勾选清单。

## Phase 1 — 数据层

- [ ] **Task 1 [S]** 失败归因数据采集 —— `fail()` 归类到 5 桶，累加 `G.failStats`，归类逻辑做成纯函数
- [ ] **Task 2 [S]** 排行榜与历史数据层 —— `fpp_history`(10) / `fpp_best_level` / `fpp_mode`，含容错与旧数据迁移

### Checkpoint: 数据层
- [ ] `node _syntax.js` 全绿
- [ ] `node _smoke.js` 旧断言不回归

## Phase 2 — 规则层 + 展示层

- [ ] **Task 3 [M]** 双模式显式化 —— 开始页二选一（练习：辅助开、不计榜 / 挑战：无辅助、计榜），`fpp_mode` 持久化
- [ ] **Task 4 [M]** 失败归因展示 —— 结束页「本局失败构成」+「本局主要问题」标注
- [ ] **Task 5 [M]** 本地排行榜展示 —— 「距个人最佳还差 N 球」+ 历史前十列表 + HUD 分模式最佳

### Checkpoint: 三项玩法改动
- [ ] 语法 + 冒烟全绿
- [ ] 无历史 / 练习模式 / 挑战模式 三种状态手动验证通过
- [ ] **人工复核后进入 Phase 3**

## Phase 3 — 开源与传播

- [ ] **Task 6 [S]** 右上角 GitHub 入口 + 「给项目点个 Star ⭐」tooltip + 地球（在线试玩）
- [ ] **Task 7 [M]** README 图文结合重写（≥4 图）+ 原技术文档迁至 `docs/TECHNICAL.md`
- [ ] **Task 8 [S]** 仓库整理与发布 —— `_tools/` 归档 / MIT LICENSE / .gitignore / `gh repo create --public` + push

### Checkpoint: 开源
- [ ] 仓库公开可访问、README 图片正常显示
- [ ] `node _run_all.js` 全绿（验证脚本移动后路径已修）

## Phase 4 — 验证与上线

- [ ] **Task 9 [M]** 测试更新 —— `_smoke.js` + `_live_verify.js` 补新断言（避免假绿）
- [ ] **Task 10 [S]** 全量回归 + 刷新版本戳 + 部署 + 线上验证

### Checkpoint: 完成
- [ ] 全部验收标准达成
- [ ] 线上 `https://spin-pingpong.app.workbuddy.host/` 可玩且新功能可见
- [ ] GitHub 仓库 `huangluke89757/spin-table-tennis` 可访问
