# 旋转乒乓 · 本轮任务清单

> 计划全文见 `plan.md`。本文件是执行用的勾选清单（已完成项保留，作为过程记录）。

## Phase 1 — 数据层 ✅

- [x] **Task 1 [S]** 失败归因数据采集 —— `classifyFail()` 纯函数归到 5 桶，`fail()` 内以 `phase` 为闸门累加 `G.failStats`
- [x] **Task 2 [S]** 排行榜与历史数据层 —— `fpp_records`（best/score/level/history）+ 逐字段兜底 + 旧版单值自动迁移

### Checkpoint: 数据层 ✅
- [x] 语法全通过
- [x] 旧断言零回归

## Phase 2 — 规则层 + 展示层 ✅

- [x] **Task 3 [M]** 双模式显式化 —— 开始页二选一卡片；`setMode()` 单一入口；挑战模式 `H` 键被拦并给出原因
- [x] **Task 4 [M]** 失败归因展示 —— 结束页「本局失败构成」横向条 + 「本局主要问题」标注
- [x] **Task 5 [M]** 本地排行榜展示 —— 「距本模式最佳还差 N 拍」+ 历史前十（本局高亮）+ 练习模式引导文案

### Checkpoint: 三项玩法改动 ✅
- [x] 语法 + 冒烟全绿（冒烟 43 → **71 项**）
- [x] 无历史 / 练习模式 / 挑战模式 三种状态经真浏览器验证
- [x] **额外发现并修复**：`#hud` 的 `z-index` 层叠上下文导致右上角入口被开始页浮层盖住

## Phase 3 — 开源与传播 ✅

- [x] **Task 6 [S]** 右上角 GitHub 入口 + 「给项目点个 Star ⭐」tooltip + 在线试玩图标
- [x] **Task 7 [M]** README 图文结合重写（**7 张图**：5 截图 + 1 海报 + 1 自制核心循环图）+ 原 41KB 技术文档迁至 `docs/TECHNICAL.md`
- [x] **Task 8 [S]** 仓库整理与发布 —— 21 个脚本归档 `_tools/`（ROOT/TOOLS 路径约定）、MIT LICENSE、.gitignore、
      `gh repo create --public` → **https://github.com/huangluke89757/spin-table-tennis**

### Checkpoint: 开源 ✅
- [x] 仓库 PUBLIC、默认分支 `main`、8 个话题标签、7 张 README 图片全部上传到位
- [x] `_run_all.js` 十一关全绿（脚本迁移后路径全部修正）

## Phase 4 — 验证与上线 ✅

- [x] **Task 9 [M]** 测试更新 —— 冒烟 +28 项、海报测试 13 → **15 项**、线上探针 12 → **20 项**
- [x] **Task 10 [S]** 全量回归十一关全绿 + 版本戳 `ve11c0189` + 部署 + 线上 20 项全 PASS

### Checkpoint: 完成 ✅
- [x] 线上 https://spin-pingpong.app.workbuddy.host/ 可玩且新功能全部可见
- [x] GitHub 仓库 https://github.com/huangluke89757/spin-table-tennis 可访问

---

## 过程中的计划外收益

1. **测试桩 `localStorage` 从「无操作」改为内存实现** —— 原桩 `getItem` 恒返回 null，
   意味着所有持久化逻辑从未被测试覆盖。改后读写往返 / 脏数据容错 / 旧数据迁移才验得了。
2. **`_syntax.js` 从手写文件清单改为自动枚举** —— 原来只检查 6 个文件，现在覆盖 16 个，
   以后新增脚本不用再维护清单。
3. **海报断言从「2 情形」升级为「3 情形 + 异步弹窗」** —— 原写法对 0.4s 延迟弹窗没等待，
   「没弹」永远是假绿；现在挑战/练习两种模式各有独立断言。
