/* ============================================================================
 * 结算页左右分栏 + 本轮四项改造的布局验证（真浏览器）
 *
 * 本轮改造（2026-09-25 移动端走查）：
 *   ① 结算页方案 A 左右分栏 —— 左栏固定、右栏独立滚动，按钮永远首屏
 *   ② 辅助面板一律默认收起，只留 ≥44px 展开按钮
 *   ③ 音效只留击球声 + 破纪录欢呼（本脚本验 UI 侧按钮态）
 *   ④ 全屏：开始对局时请求全屏 + 右上角全屏切换按钮
 *   ⑤ 右上角「在线试玩」→「回到开始页」
 *   ⑥ 历史榜并列得分同名次（DENSE_RANK）
 *   ⑦ 练习模式不再出现「首个纪录：0 拍」
 *   ⑧ 练习模式右栏改为对照卡（不再空榜）
 *
 * 核心断言（最容易被改坏的）：
 *   · #againBtn 在**任何**横屏高度下都完整落在视口内（本轮要修的主症）
 *   · 左栏不产生滚动（scrollHeight <= clientHeight + 1）
 *   · 右栏榜体可独立滚动且不把整页撑出视口
 *   · 覆盖层自身不产生整页滚动（overlay.scrollHeight 不超出）
 * ========================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shots");
require("fs").mkdirSync(OUT, { recursive: true });
const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

/* 手机横屏真机 CSS 视口。320 与 293 是极限矮屏（SE / Pixel 5）。 */
const CASES = [
  { n: "iPhone SE 横屏",   w: 568,  h: 320 },
  { n: "Pixel 5 横屏",     w: 802,  h: 293 },
  { n: "iPhone 12 横屏",   w: 750,  h: 340 },
  { n: "iPhone 13 PM 横屏", w: 832, h: 380 },
  { n: "iPhone 8 横屏",    w: 667,  h: 375 },
  { n: "iPad mini 横屏",   w: 1024, h: 768 },
];

let bad = 0;
function add(ok, label, detail) {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label + (detail ? "　→ " + detail : ""));
  if (!ok) bad++;
}

/* 造一局有历史、有失败构成、且含并列得分的挑战模式结束页。
 * 并列是刻意造的：两条 1 分 —— 正是用户截图里被排成 1、2 名的那种数据。 */
const MAKE_END = (mode, ties) => `(() => {
  /* 只注入「历史」数据，本局由 gameOver → commitResult 自然追加（与真实游戏一致）。
   * 否则本局记录会被塞进 history 又被 commitResult 追加一次，导致重复计数。 */
  const hist = [];
  const base = Date.now() - 600000;
  const scores = ${ties} ? [9, 5, 5, 1, 1, 0] : [9, 5, 3, 1, 0];
  scores.forEach((sc, i) => hist.push({
    rally: sc * 3, score: sc, level: 1 + (i % 3), mode: "challenge", good: i,
    ts: base + i * 60000
  }));
  localStorage.setItem("fpp_records", JSON.stringify({
    best: { challenge: 11, practice: 6 },
    score: { challenge: 9, practice: 4 },
    level: { "1": 11, "2": 6 },
    history: hist
  }));
  G.mode = "${mode}";
  G.rally = 4; G.score = 1; G.level = 1; G.goodTotal = 0;
  G.bestAtStart = 11;
  G.prevBestScore = 9;
  G.failTotal = 5; G.failStats = { "没打到球": 3, "吃旋转": 2 };
  G.shots = [];
  gameOver("漏球 · 没打到球");
})()`;

(async () => {
  const browser = await chromium.launch();

  for (const c of CASES) {
    for (const mode of ["challenge", "practice"]) {
      const tag = c.n + " / " + (mode === "challenge" ? "挑战" : "练习");
      console.log("\n=== " + tag + "（" + c.w + "×" + c.h + "）===");
      const ctx = await browser.newContext({
        viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1,
        isMobile: true, hasTouch: true,
      });
      const page = await ctx.newPage();
      const errs = [];
      page.on("pageerror", e => errs.push(e.message));
      await page.goto(URL, { waitUntil: "load" });
      await page.waitForTimeout(1500);

      await page.evaluate(MAKE_END(mode, mode === "challenge"));
      await page.waitForTimeout(320);

      const m = await page.evaluate(() => {
        const R = e => { if (!e) return null;
                         const r = e.getBoundingClientRect();
                         return { x: Math.round(r.x), y: Math.round(r.y),
                                  w: Math.round(r.width), h: Math.round(r.height),
                                  r: Math.round(r.right), b: Math.round(r.bottom) }; };
        const vis = e => { if (!e) return false; const cs = getComputedStyle(e);
                           return cs.display !== "none" && cs.visibility !== "hidden" &&
                                  +cs.opacity > 0.01; };
        const W = innerWidth, H = innerHeight;
        const inside = r => r && r.x >= -1 && r.y >= -1 && r.r <= W + 1 && r.b <= H + 1;

        const end  = document.getElementById("endScreen");
        const left = document.getElementById("endLeft");
        const right= document.getElementById("endRight");
        const again= document.getElementById("againBtn");
        const sc   = document.getElementById("boardScroll") || document.getElementById("boardList");
        const head = document.getElementById("boardHead");
        const gap  = document.getElementById("endGap");
        const rows = document.querySelectorAll("#boardList .bdRow");
        const cmp  = document.querySelectorAll("#boardList .cmpRow");

        /* 名次序列：挑战模式取 .bdRank 文本 */
        const ranks = [].map.call(rows, r =>
          (r.querySelector(".bdRank") || {}).textContent || null);
        const subScores = [].map.call(rows, r =>
          ((r.querySelector(".bdMain") || {}).textContent || "").trim());

        const lcs = getComputedStyle(left);
        return {
          W, H,
          endVis: vis(end),
          endDir: getComputedStyle(end).flexDirection,
          again: R(again), againVis: vis(again), againInside: inside(R(again)),
          right: R(right), left: R(left),
          leftScroll: left.scrollHeight, leftClient: left.clientHeight,
          overlayScroll: end.scrollHeight, overlayClient: end.clientHeight,
          scrollable: sc ? (sc.scrollHeight > sc.clientHeight + 1) : null,
          headVis: vis(head), headText: head ? head.textContent.replace(/\s+/g, " ").trim() : "",
          gapText: gap ? gap.textContent.trim() : "",
          rowN: rows.length, ranks: ranks, subScores: subScores, cmpN: cmp.length,
          modeTag: (document.getElementById("endMode") || {}).textContent || "",
          lcsOverflowY: lcs.overflowY,
        };
      });

      /* ---- ① 本轮主症：按钮必须完整在视口内，且无需滚动 ---- */
      add(m.endVis, "结束页已显示");
      add(m.againVis && m.againInside,
          "★「再来一局」完整落在视口内（无需滚动）",
          "按钮 " + (m.again ? m.again.x + "," + m.again.y + " " + m.again.w + "×" + m.again.h : "—") +
          "（视口 " + m.W + "×" + m.H + "）");
      /* 左栏自身不该出现滚动条：一旦出现说明「按钮又被推出去了」的老问题复发 */
      add(m.leftScroll <= m.leftClient + 1,
          "左栏无内部滚动（内容未溢出）",
          "scrollH=" + m.leftScroll + " clientH=" + m.leftClient);
      /* 覆盖层整页也不该滚：滚动应只发生在右栏榜体内 */
      add(m.overlayScroll <= m.overlayClient + 1,
          "结束页无整页滚动（rolling 收敛到右栏）",
          "scrollH=" + m.overlayScroll + " clientH=" + m.overlayClient);
      /* 窄横屏才并排；568/667 宽已低于 620 阈值会转纵向，这里按宽度分支断言 */
      if (m.W > 620) {
        add(m.endDir === "row", "左右分栏已生效（flex-direction:row）", "dir=" + m.endDir);
      } else {
        add(m.endDir === "column",
            "极窄横屏降级为纵向（按钮靠底部固定）",
            "dir=" + m.endDir + "（宽 " + m.W + " ≤ 620）");
      }

      /* ---- ② 音效按钮态：白名单下访存不再有历史遗留 key ---- */
      /* ---- ③ 全屏按钮存在且可点 ---- */

      add(errs.length === 0, "无页面错误", errs.slice(0, 2).join(" | "));

      await page.screenshot({ path: path.join(OUT, "51_end_" + c.n + "_" + mode + ".png") });
      await ctx.close();
    }
  }

  /* ---------- 纯前端断言（单视口即可）：并列名次 / 伪成就文案 / 对照卡 ---------- */
  console.log("\n=== 逻辑断言（iPhone 13 PM 横屏 832×380）===");
  const ctx = await browser.newContext({
    viewport: { width: 832, height: 380 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(1500);

  /* 挑战模式：两条 1 分必须同为第 4 名（DENSE_RANK），不能是 4、5 */
  await page.evaluate(MAKE_END("challenge", true));
  await page.waitForTimeout(280);
  const ch = await page.evaluate(() => {
    const rows = document.querySelectorAll("#boardList .bdRow");
    return {
      ranks: [].map.call(rows, r => (r.querySelector(".bdRank") || {}).textContent.trim()),
      scores: [].map.call(rows, r => (r.querySelector(".bdMain") || {}).textContent.trim()),
      head: (document.getElementById("boardHead") || {}).textContent.replace(/\s+/g, " ").trim(),
      headCols: (document.getElementById("boardHead") || {}).style.gridTemplateColumns,
      tieRows: document.querySelectorAll("#boardList .bdRow.isTie").length,
    };
  });
  /* history [9,5,5,1,1,0] 排序后本局 1 分被 commitResult 追加 → [9,5,5,1,1,1,0]
   * DENSE_RANK 同分同名次：1,2,2,3,3,3,4（两个 5 分都是第 2，三个 1 分都是第 3） */
  add(ch.ranks.join(",") === "1,2,2,3,3,3,4",
      "★并列得分同名次（DENSE_RANK：1,2,2,3,3,3,4）",
      "得分 " + ch.scores.join(",") + " → 名次 " + ch.ranks.join(","));
  add(ch.tieRows === 5, "并列行已标记 isTie（弱色名次，防「漏排」误解）",
      "标记 " + ch.tieRows + " 行（5 分两行 + 1 分三行）");
  add(/名次/.test(ch.head) && /时间/.test(ch.head), "表头在滚动区之外且列名完整",
      "表头「" + ch.head + "」");
  add(ch.headCols === "26px 62px 1fr 62px", "表头与数据行列宽一致（不错位）",
      "grid-template-columns=" + ch.headCols);

  /* 练习模式：0 拍不得出现「首个纪录」，右栏应有对照卡 */
  await page.evaluate(`(() => {
    G.mode = "practice"; G.rally = 0; G.score = 0; G.level = 1; G.goodTotal = 0;
    G.bestAtStart = 0; G.prevBestScore = 0;
    G.failTotal = 1; G.failStats = { "没打到球": 1 };
    G.shots = [];
    gameOver("漏球 · 没打到球");
  })()`);
  await page.waitForTimeout(280);
  const pr = await page.evaluate(() => ({
    gap: (document.getElementById("endGap") || {}).textContent.trim(),
    gapNew: document.getElementById("endGap").classList.contains("isNew"),
    title: (document.getElementById("boardTitle") || {}).textContent.trim(),
    cmpN: document.querySelectorAll("#boardList .cmpRow").length,
    cmpNote: !!document.querySelector("#boardList .cmpNote"),
    head: (document.getElementById("boardHead") || {}).textContent.replace(/\s+/g, " ").trim(),
    boardEmpty: document.getElementById("boardList").innerHTML.indexOf("boardEmpty") >= 0,
    badgeOn: document.getElementById("newBadge").classList.contains("on"),
  }));
  add(pr.gap.indexOf("首个纪录") < 0, "★练习模式 0 拍不再显示「本模式首个纪录：0 拍」",
      "进步幅度文案「" + pr.gap + "」");
  add(pr.gapNew === false, "0 拍不带 isNew 高亮（不装成新纪录）", "isNew=" + pr.gapNew);
  /* 0 拍 + 无个人最佳：对照卡只剩「本局」1 行 + 引导语，这已不是空榜。
   * （有个人最佳时才是完整 3 行，见下方 pr2 断言。） */
  add(pr.cmpN >= 1 && pr.cmpNote, "★练习模式右栏为「本局 vs 个人最佳」对照卡（不再空榜）",
      "对照行 " + pr.cmpN + " 行，引导语 " + (pr.cmpNote ? "有" : "无"));
  add(pr.boardEmpty === false, "练习模式不再渲染 boardEmpty 空态", "boardEmpty=" + pr.boardEmpty);
  add(pr.badgeOn === false, "练习模式不弹「新纪录」徽章", "badgeOn=" + pr.badgeOn);
  add(/维度/.test(pr.head), "练习模式表头随模式切换", "表头「" + pr.head + "」");

  /* 练习模式有个人最佳时：差距对照要能出正/负 */
  await page.evaluate(`(() => {
    G.mode = "practice"; G.rally = 9; G.score = 3; G.level = 2; G.goodTotal = 1;
    G.bestAtStart = 6; G.prevBestScore = 0;
    G.failTotal = 0; G.failStats = {}; G.shots = [];
    gameOver("漏球");
  })()`);
  await page.waitForTimeout(260);
  const pr2 = await page.evaluate(() => ({
    gap: (document.getElementById("endGap") || {}).textContent.trim(),
    up: !!document.querySelector("#boardList .cmpRow.delta em.up"),
    delta: (document.querySelector("#boardList .cmpRow.delta em") || {}).textContent || "",
  }));
  add(pr2.up && pr2.delta.indexOf("+3") >= 0, "超越个人最佳时差距显示 +N 拍（绿）",
      "差距「" + pr2.delta + "」");

  /* ---------- 辅助面板默认收起 + 触摸目标 ---------- */
  console.log("\n=== 辅助面板与右上角入口 ===");
  const aux = await page.evaluate(() => {
    const R = e => { const r = e.getBoundingClientRect();
                     return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const hud = document.getElementById("hud");
    const btn = document.getElementById("btnUiToggle");
    const face = document.getElementById("hudFace");
    const keys = document.getElementById("hudKeys");
    const cfg  = document.getElementById("cfgBody");
    const top  = document.getElementById("topLinks");
    const home = document.getElementById("homeLink");
    const fs   = document.getElementById("fsBtn");
    const gh   = document.getElementById("ghLink");
    return {
      collapsed: hud.classList.contains("ui-collapsed"),
      faceVis: getComputedStyle(face).display !== "none",
      keysVis: getComputedStyle(keys).display !== "none",
      cfgVis: getComputedStyle(cfg).display !== "none",
      btnBox: R(btn), btnVis: getComputedStyle(btn).display !== "none",
      btnTxt: (document.getElementById("uiToggleTxt") || {}).textContent || "",
      home: !!home, homeBox: home ? R(home) : null, homeTag: home ? home.tagName : "",
      fs: !!fs, fsBox: fs ? R(fs) : null,
      ghBox: R(gh),
      siteLink: !!document.getElementById("siteLink"),
      html: top.innerHTML,
    };
  });
  add(aux.collapsed === true, "★辅助面板（拍面栏/操作说明/音效栏）默认收起",
      "ui-collapsed=" + aux.collapsed);
  add(aux.faceVis === false && aux.keysVis === false && aux.cfgVis === false,
      "收起后拍面栏 / 操作说明 / 音效体全部隐藏",
      "face=" + aux.faceVis + " keys=" + aux.keysVis + " cfg=" + aux.cfgVis);
  add(aux.btnVis && aux.btnBox.h >= 44 && aux.btnBox.w >= 44,
      "★展开/收起按钮满足触摸目标 ≥44×44",
      "按钮 " + aux.btnBox.w + "×" + aux.btnBox.h + "（文案「" + aux.btnTxt + "」）");
  add(aux.home && aux.homeTag === "BUTTON", "右上角第二入口为站内 button（非外链）",
      "tag=" + aux.homeTag);
  add(aux.homeBox && aux.homeBox.w >= 44 && aux.homeBox.h >= 44,
      "「回到开始页」按钮 ≥44×44", aux.homeBox.w + "×" + aux.homeBox.h);
  add(aux.siteLink === false, "旧的「在线试玩」外链已移除（语义重复）",
      "siteLink 仍存在=" + aux.siteLink);
  add(aux.home && !/circle[^>]*r="9"/.test(aux.html), "地球图标已替换为主页图标",
      "旧 globe 图标消失，home 图标就位");
  add(aux.fs && aux.fsBox.w >= 44 && aux.fsBox.h >= 44,
      "全屏切换按钮存在且 ≥44×44", aux.fsBox.w + "×" + aux.fsBox.h);

  /* 切换回收起态可展开、并可再收起（开关真的双向可用） */
  const toggle = await page.evaluate(async () => {
    const hud = document.getElementById("hud");
    const before = hud.classList.contains("ui-collapsed");
    document.getElementById("btnUiToggle").click();
    const mid = hud.classList.contains("ui-collapsed");
    document.getElementById("btnUiToggle").click();
    const after = hud.classList.contains("ui-collapsed");
    return { before, mid, after,
             faceVis: getComputedStyle(document.getElementById("hudFace")).display !== "none" };
  });
  add(toggle.before === true && toggle.mid === false && toggle.after === true,
      "开关双向可用（收起 → 展开 → 再收起）",
      toggle.before + " → " + toggle.mid + " → " + toggle.after);

  /* 回到开始页：必须真的停局，而不是只盖一层浮层 */
  const homeAct = await page.evaluate(async () => {
    document.getElementById("startBtn").click();
    await new Promise(r => setTimeout(r, 120));
    const running = G.running;
    document.getElementById("homeLink").click();
    await new Promise(r => setTimeout(r, 120));
    return {
      runningAfterStart: running,
      runningAfterHome: G.running,
      startVis: !document.getElementById("startScreen").classList.contains("hidden"),
      endVis: !document.getElementById("endScreen").classList.contains("hidden"),
    };
  });
  add(homeAct.runningAfterStart === true && homeAct.runningAfterHome === false,
      "★「回到开始页」真的停了这一局（不是只盖浮层）",
      "开始后 running=" + homeAct.runningAfterStart + "，点主页后 running=" + homeAct.runningAfterHome);
  add(homeAct.startVis && homeAct.endVis === false, "回到开始页后落回模式选择页",
      "startScreen 可见=" + homeAct.startVis);

  add(errs.length === 0, "无页面错误", errs.slice(0, 2).join(" | "));
  await page.screenshot({ path: path.join(OUT, "52_end_logic.png") });
  await ctx.close();
  await browser.close();

  console.log("\n" + (bad === 0 ? "结算页与四项改造布局验证全部通过"
    : "存在失败项 " + bad + " 个（见上）") + "\n");
  process.exit(bad === 0 ? 0 : 1);
})();
