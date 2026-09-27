/* ============================================================================
 * 结算页「内容居中」探针（诊断用，非回归）
 *
 * 用户反馈：结算界面主体内容散落在屏幕四周 ——
 *   · 左栏文字贴着屏幕最左边，右栏表格的「时间」列被顶到屏幕最右边
 *   · 练习模式「本局对照」一行里，标签在极左、数值在极右，中间一大片空白
 *   · 横向留白全被吃进表格列宽里（1fr 被撑成几百 px）
 *
 * 本脚本不做断言，只输出几何证据：分栏矩形、每列单元格位置、
 * 主体内容的左右边界与两侧留白，用来定位「散开」发生在哪一层。
 * ========================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shots");
require("fs").mkdirSync(OUT, { recursive: true });
const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

/* 覆盖：手机横屏真机 + 用户截图那种「宽而矮」的窗口 + 桌面 */
const CASES = [
  { n: "SE 横屏 568×320",   w: 568,  h: 320 },
  { n: "边界 621×360",      w: 621,  h: 360 },
  { n: "边界 640×360",      w: 640,  h: 360 },
  { n: "iPhone8 横屏 667×375", w: 667, h: 375 },
  { n: "Pixel5 横屏 802×293", w: 802, h: 293 },
  { n: "13PM 横屏 832×380", w: 832,  h: 380 },
  { n: "用户截图型 1030×469", w: 1030, h: 469 },
  { n: "用户截图型 1080×469", w: 1080, h: 469 },
  { n: "桌面 1280×720",     w: 1280, h: 720 },
];

const MAKE_END = (mode) => `(() => {
  const hist = [];
  const base = Date.now() - 600000;
  /* 9 条历史 + 本局追加 = 10 行，与用户截图里的「历史前十局」同形，
     纵向占满才能看出居中是不是真的居中（6 行时内容太矮，看不出差别）。 */
  [9, 5, 5, 4, 3, 2, 1, 1, 0].forEach((sc, i) => hist.push({
    rally: sc * 3, score: sc, level: 1 + (i % 3), mode: "challenge", good: i,
    ts: base + i * 60000
  }));
  localStorage.setItem("fpp_records", JSON.stringify({
    best: { challenge: 11, practice: 6 }, score: { challenge: 9, practice: 4 },
    level: { "1": 11, "2": 6 }, history: hist
  }));
  G.mode = "${mode}";
  G.rally = 4; G.score = 1; G.level = 1; G.goodTotal = 0;
  G.bestAtStart = 11; G.prevBestScore = 9;
  G.failTotal = 5; G.failStats = { "没打到球": 3, "吃旋转": 2 };
  G.shots = [];
  gameOver("漏球 · 没打到球");
})()`;

const MEASURE = () => {
  const R = e => { if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width),
             h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) }; };
  const end = document.getElementById("endScreen");
  const left = document.getElementById("endLeft");
  const right = document.getElementById("endRight");
  const W = innerWidth, H = innerHeight;

  /* 右栏第一行各单元格的位置 —— 「散开」最直观的证据 */
  const row = document.querySelector("#boardList .bdRow, #boardList .cmpRow");
  const cells = row ? [].map.call(row.children, c => {
    const b = R(c); return { t: c.textContent.trim().slice(0, 10), x: b.x, w: b.w, r: b.r };
  }) : [];

  /* 主体内容左右边界：取左右两栏所有可见叶子元素的极值 */
  const ext = sel => {
    const els = document.querySelectorAll(sel);
    let mn = 1e9, mx = -1e9;
    for (const e of els) {
      if (!e.getClientRects().length) continue;
      if (e.children.length) continue;                 // 只看叶子
      const t = (e.textContent || "").trim();
      if (!t) continue;
      const b = R(e); if (!b) continue;
      mn = Math.min(mn, b.x); mx = Math.max(mx, b.r);
    }
    return mn > 1e8 ? null : { min: mn, max: mx };
  };

  /* 榜体内部「列间空隙」：得分列右边缘 → 拍准档列左边缘 */
  let innerGap = null;
  if (cells.length >= 3) innerGap = cells[2].x - cells[1].r;

  /* 主体内容（左右两栏并集）的上下边界 —— 判断「贴顶 / 贴底」 */
  const lExt = ext("#endLeft *"), rExt = ext("#endRight *");
  const box = [lExt, rExt].filter(Boolean);

  /* 两个「附属行」的自然宽度：卡片收窄后它们不能被挤到换行 */
  const uw = document.getElementById("endUiRow");
  const tip = document.getElementById("endTip");

  return {
    W, H,
    endDir: getComputedStyle(end).flexDirection,
    endAlign: getComputedStyle(end).alignItems,
    left: R(left), right: R(right),
    leftGap: R(left).x, rightGap: W - R(right).r,     // 两侧留白
    colGap: R(right).x - R(left).r,
    cells, innerGap,
    leftExt: lExt, rightExt: rExt,
    topGap: Math.min(R(left).y, R(right).y),
    contentTop: Math.min(R(left).y, R(right).y),
    contentBot: Math.max(R(left).b, R(right).b),
    uiRow: uw ? { w: uw.clientWidth, sw: uw.scrollWidth, h: R(uw).h } : null,
    /* 底部行剩余余量：文字撑到换行就差这几 px，必须留够 */
    uiRowSlack: uw ? uw.clientWidth - uw.scrollWidth : null,
    rowN: document.querySelectorAll("#boardList .bdRow").length,
    rowH: (() => { const r = document.querySelector("#boardList .bdRow");
                   return r ? Math.round(r.getBoundingClientRect().height) : null; })(),
    timeH: (() => { const t = document.querySelector("#boardList .bdTime");
                    return t ? Math.round(t.getBoundingClientRect().height) : null; })(),
    tip: tip ? { w: tip.clientWidth, sw: tip.scrollWidth, h: R(tip).h } : null,
    headSw: (() => { const h = document.getElementById("boardHead");
                     return h ? { w: h.clientWidth, sw: h.scrollWidth } : null; })(),
  };
};

(async () => {
  const browser = await chromium.launch();
  for (const c of CASES) {
    for (const mode of ["challenge", "practice"]) {
      const ctx = await browser.newContext({
        viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1,
        isMobile: true, hasTouch: true,
      });
      const page = await ctx.newPage();
      await page.goto(URL, { waitUntil: "load" });
      await page.waitForTimeout(1400);
      await page.evaluate(MAKE_END(mode));
      await page.waitForTimeout(300);
      const m = await page.evaluate(MEASURE);

      console.log("\n=== " + c.n + " / " + mode + " → " + m.endDir +
                  " / align:" + m.endAlign + " ===");
      console.log("  左栏 x=" + m.left.x + " w=" + m.left.w + " h=" + m.left.h +
                  " y=" + m.left.y + "–" + m.left.b);
      console.log("  右栏 x=" + m.right.x + " w=" + m.right.w + " h=" + m.right.h +
                  " y=" + m.right.y + "–" + m.right.b + "  右边界 " + m.right.r + "/" + m.W);
      console.log("  两侧留白 左 " + m.leftGap + "px / 右 " + m.rightGap + "px" +
                  "　栏间距 " + m.colGap + "px");
      console.log("  主内容块 y=" + m.contentTop + "–" + m.contentBot +
                  "（上 " + m.contentTop + " / 下 " + (m.H - m.contentBot) + "，视口高 " + m.H + "）");
      console.log("  首行列位置：");
      m.cells.forEach((s, i) => console.log("    [" + i + "] 「" + s.t + "」x=" + s.x +
                  " w=" + s.w + " 右=" + s.r));
      if (m.innerGap !== null) console.log("  得分列→拍准档列 空隙 = " + m.innerGap + "px");
      console.log("  左栏内容跨度 " + m.leftExt.min + " → " + m.leftExt.max);
      console.log("  右栏内容跨度 " + m.rightExt.min + " → " + m.rightExt.max);
      console.log("  底部行 辅助面板 " + (m.uiRow ? m.uiRow.w + "/" + m.uiRow.sw +
                  (m.uiRow.sw > m.uiRow.w ? " ⚠溢出" : " ok") + "（余量 " + m.uiRowSlack + "px）" : "—") +
                  "　tip " + (m.tip ? m.tip.w + "/" + m.tip.sw : "—") +
                  "　表头 " + (m.headSw ? m.headSw.w + "/" + m.headSw.sw : "—"));
      console.log("  榜单 " + m.rowN + " 行，行高 " + m.rowH + "px，时间格高 " + m.timeH + "px");
      await page.screenshot({ path: path.join(OUT, "61_center_" + c.n.replace(/[^\w\u4e00-\u9fa5]/g, "") + "_" + mode + ".png") });
      await ctx.close();
    }
  }
  await browser.close();
})();
