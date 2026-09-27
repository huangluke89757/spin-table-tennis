/* ============================================================================
 * 「改动前 / 改动后」同尺寸对照截图（一轮走查一份证据，非回归）
 *
 * 为什么要它：用户报的是「主体内容散落在四周」，这是一个**形状**问题 ——
 * 文字描述（“居中了吗”）说服力弱，同视口、同数据、同缩放的两张图并排看，
 * 一眼就能判定改没改到位。所以两张图必须在完全相同的条件下拍：
 * 同一 viewport、同一份注入数据、同一 deviceScaleFactor。
 *
 * 用法：node _tools/_end_center_compare.js
 *   BEFORE_DIR 指向「上一版」的项目副本（用 git show <sha>:<file> 覆盖两个文件得到）
 * ========================================================================== */
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shots");
const BEFORE_DIR = path.join(ROOT, "..", ".before_shot");

/* 与用户截图同形：宽而矮的窗口（桌面浏览器拖成横向长条） */
const CASES = [
  { n: "1030x469", w: 1030, h: 469 },
  { n: "1280x720", w: 1280, h: 720 },
];

const MAKE_END = (mode) => `(() => {
  const hist = [];
  const base = Date.now() - 600000;
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

const url = dir => "file:///" + path.join(dir, "index.html").replace(/\\/g, "/");

(async () => {
  if (!fs.existsSync(BEFORE_DIR)) {
    console.log("缺少对照副本:", BEFORE_DIR);
    process.exit(1);
  }
  const browser = await chromium.launch();
  for (const c of CASES) {
    for (const mode of ["challenge", "practice"]) {
      for (const [tag, dir] of [["before", BEFORE_DIR], ["after", ROOT]]) {
        const ctx = await browser.newContext({
          viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1,
          isMobile: true, hasTouch: true,
        });
        const page = await ctx.newPage();
        await page.goto(url(dir), { waitUntil: "load" });
        await page.waitForTimeout(1400);
        await page.evaluate(MAKE_END(mode));
        await page.waitForTimeout(300);
        await page.screenshot({
          path: path.join(OUT, "62_cmp_" + tag + "_" + c.n + "_" + mode + ".png") });
        await ctx.close();
      }
      console.log("已拍 " + c.n + " / " + mode);
    }
  }
  await browser.close();
})();
