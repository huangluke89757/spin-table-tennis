/* ============================================================================
 * 手机横屏可用性验证（真浏览器）
 *
 * 三层判据，缺一不可：
 *   ① 门控放行 —— 引导层不再遮挡（这是本次修复的主目标）
 *   ② 关键路径可达 —— 「开始对局」按钮真实落在视口内且可点（不是被裁在屏外）
 *   ③ 关键信息可见 —— 模式卡片（练习/挑战）可读可点，GitHub 入口可见
 *
 * 为什么要单独验 ②③：门控放行只是「进门」，进门后如果按钮在屏幕外，
 * 玩家依然进不去游戏 —— 实测 568×320 就是这个状态。
 * 判据用 getBoundingClientRect，Node 桩里这个值是常量，量不出问题。
 * ========================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shots");
const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

/* 手机横屏真机 CSS 视口（用官方设备描述符的宽高，横屏即宽高互换） */
const CASES = [
  { n: "iPhone SE 横屏",   w: 568,  h: 320 },
  { n: "iPhone 8 横屏",    w: 667,  h: 375 },
  { n: "Galaxy S9+ 横屏",  w: 658,  h: 320 },
  { n: "iPhone 12 横屏",   w: 750,  h: 340 },
  { n: "iPhone 13 横屏",   w: 750,  h: 342 },
  { n: "iPhone 13 PM 横屏", w: 832, h: 380 },
  { n: "Pixel 5 横屏",     w: 802,  h: 293 },
  { n: "iPad mini 横屏",   w: 1024, h: 768 },
  /* 竖屏必须仍然拦住 */
  { n: "iPhone 13 竖屏",   w: 390,  h: 844, wantBlock: true },
  { n: "iPad Pro 11 竖屏", w: 834,  h: 1194, wantBlock: true },
];

let bad = 0;
function add(ok, label, detail) {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label + (detail ? "　→ " + detail : ""));
  if (!ok) bad++;
}

(async () => {
  const browser = await chromium.launch();

  for (const c of CASES) {
    console.log("\n=== " + c.n + "（" + c.w + "×" + c.h + "）===");
    const ctx = await browser.newContext({
      viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true,
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForTimeout(1700);

    const m = await page.evaluate(() => {
      const R = e => { const r = e.getBoundingClientRect();
                       return { x: Math.round(r.x), y: Math.round(r.y),
                                w: Math.round(r.width), h: Math.round(r.height),
                                r: Math.round(r.right), b: Math.round(r.bottom) }; };
      const vis = e => { const cs = getComputedStyle(e);
                         return cs.display !== "none" && cs.visibility !== "hidden" &&
                                +cs.opacity > 0.01; };
      const W = innerWidth, H = innerHeight;
      const inside = r => r.x >= -1 && r.y >= -1 && r.r <= W + 1 && r.b <= H + 1;

      const startBtn  = document.getElementById("startBtn");
      const modes     = document.getElementById("modePractice");
      const challenge = document.getElementById("modeChallenge");
      const gh        = document.getElementById("ghLink");
      const hint      = document.getElementById("rotateHint");
      const startScr  = document.getElementById("startScreen");

      const hs = getComputedStyle(hint);
      /* 开始页自身能否滚动到按钮（overflow-y:auto）—— 不能只看静态位置，
         还要确认滚动后按钮真的可达 */
      const scr = getComputedStyle(startScr);

      return {
        W, H, aspect: +(W / H).toFixed(3),
        hintOn: hint.classList.contains("on"),
        hintDisplay: hs.display,
        supported: typeof isSupported === "function" ? isSupported() : null,
        btn: R(startBtn), btnVis: vis(startBtn),
        btnInside: inside(R(startBtn)),
        mode: R(modes), modeVis: vis(modes), modeInside: inside(R(modes)),
        ch: R(challenge), chInside: inside(R(challenge)),
        gh: R(gh), ghVis: vis(gh), ghInside: inside(R(gh)),
        modeCols: getComputedStyle(document.querySelector(".modeCards")).gridTemplateColumns,
        canScroll: scr.overflowY === "auto",
        scrollH: startScr.scrollHeight, clientH: startScr.clientHeight,
      };
    });

    /* ① 门控 */
    if (c.wantBlock) {
      add(m.hintOn === true, "竖屏 · 引导层正确拦截", "hintOn=" + m.hintOn + " supported=" + m.supported);
    } else {
      add(m.hintOn === false, "门控放行（引导层不再遮挡）",
          "hintOn=" + m.hintOn + " aspect=" + m.aspect + " supported=" + m.supported);
      /* ② 关键路径可达 */
      add(m.btnVis && m.btnInside, "「开始对局」按钮在视口内可见可点",
          "按钮 " + m.btn.x + "," + m.btn.y + " " + m.btn.w + "×" + m.btn.h +
          "（视口 " + m.W + "×" + m.H + "）");
      /* ③ 模式卡片 */
      add(m.modeVis && m.modeInside && m.chInside, "两张模式卡片都在视口内",
          "练习 " + m.mode.x + "," + m.mode.y + "/" + m.mode.b +
          "  挑战 " + m.ch.x + "," + m.ch.y + "/" + m.ch.b);
      add(m.modeCols.split(" ").length >= 2, "模式卡片并排（低矮横屏不叠成单列）",
          "grid-template-columns=" + m.modeCols);
      add(m.ghVis && m.ghInside, "GitHub 入口可见",
          "位置 " + m.gh.x + "," + m.gh.y);
      /* 兜底：内容真超出时必须能滚到 */
      add(m.btnInside || m.canScroll, "内容超高时可滚动到按钮（overflow-y:auto）",
          "scrollHeight=" + m.scrollH + " clientHeight=" + m.clientH);
    }
    add(errs.length === 0, "无页面错误", errs.slice(0, 2).join(" | "));

    await page.screenshot({ path: path.join(OUT, "41_gate_" + c.n + ".png") });
    await ctx.close();
  }

  await browser.close();
  console.log("\n" + (bad === 0 ? "手机横屏可用性验证全部通过" :
    "存在失败项 " + bad + " 个（见上）") + "\n");
  process.exit(bad === 0 ? 0 : 1);
})();
