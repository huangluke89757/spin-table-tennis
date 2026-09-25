/* 原型 v5：两个关键问题的实测
 * ① 触摸事件的真实落点：屏幕上到底有多少区域按下去能到达 canvas（即能起手势）？
 *    —— 用 elementFromPoint 网格采样，量"可用触摸区占比"（HUD 的按钮/滑块会吃掉触摸）
 * ② pointercancel 是不是因为触摸点在 HUD 上（touch-action 只设在 canvas）？
 *    —— 对比「只 canvas 设 touch-action:none」与「html/body/#stage 全设」
 */
const { chromium } = require("playwright");
const fs = require("fs");

const GAME = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/first-person-pingpong";
const URL = "file:///" + GAME + "/index.html";
const OUT = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe5_out.json";
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--ignore-gpu-blocklist", "--enable-webgl"];

(async () => {
  const browser = await chromium.launch({ args: ARGS });
  const R = {};

  async function open(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2,
                                           isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForTimeout(1400);
    return { ctx, page };
  }

  const HUD_IDS = ["hudBrand", "hudScore", "hudBall", "hudFace", "hudKeys", "hudCfg", "btnUiToggle", "topLinks", "barMark"];

  async function survey(page, w, h) {
    return page.evaluate(({ ids, W, H }) => {
      const rect = id => { const e = document.getElementById(id); if (!e) return null;
        const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                 display: cs.display, pe: cs.pointerEvents, ta: cs.touchAction }; };
      const boxes = {}; ids.forEach(id => boxes[id] = rect(id));

      // 网格采样：按下这个点，指针事件的目标元素是谁
      const step = 20, hits = {}; let canvasPts = 0, total = 0;
      for (let y = 10; y < H; y += step) for (let x = 10; x < W; x += step) {
        total++;
        const el = document.elementFromPoint(x, y);
        const key = el ? (el.id || el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "")) : "null";
        hits[key] = (hits[key] || 0) + 1;
        if (el && el.id === "cv") canvasPts++;
      }
      const cv = document.getElementById("cv");
      const stage = document.getElementById("stage");
      return {
        canvasTouchAction: getComputedStyle(cv).touchAction,
        stageTouchAction: getComputedStyle(stage).touchAction,
        bodyTouchAction: getComputedStyle(document.body).touchAction,
        htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehavior,
        boxes, hitMapTop: Object.entries(hits).sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([k, v]) => k + ":" + v),
        total, canvasPts, canvasPct: +(canvasPts / total * 100).toFixed(1)
      };
    }, { ids: HUD_IDS, W: w, H: h });
  }

  async function touchChain(page, ctx, x, y, label) {
    const cdp = await ctx.newCDPSession(page);
    await page.evaluate(() => {
      window.__ev = [];
      ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend"]
        .forEach(t => window.addEventListener(t, e => window.__ev.push(t), true));
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await page.waitForTimeout(40);
    for (let i = 1; i <= 3; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - i * 25, id: 1 }] });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(120);
    const r = await page.evaluate(({ x, y }) => ({
      target: (() => { const e = document.elementFromPoint(x, y); return e ? (e.id || e.tagName) : "null"; })(),
      ev: window.__ev
    }), { x, y });
    return { label, at: { x, y }, target: r.target, ev: r.ev };
  }

  /* ---------- 横屏手机 844×390 ---------- */
  {
    const { ctx, page } = await open(844, 390);
    await page.click("#startBtn");
    await page.waitForTimeout(150);
    const s = await survey(page, 844, 390);
    const chains = [];
    // 三个典型位置：屏幕正中、中下、右下（HUD 区）
    chains.push(await touchChain(page, ctx, 420, 200, "屏幕正中(200)"));
    chains.push(await touchChain(page, ctx, 420, 330, "中下(330)"));
    chains.push(await touchChain(page, ctx, 620, 340, "右下HUD区"));
    chains.push(await touchChain(page, ctx, 150, 340, "左下拍面栏区"));
    R.landscape844x390 = { survey: s, chains };
    await ctx.close();
  }

  /* ---------- 竖屏手机 390×844 ---------- */
  {
    const { ctx, page } = await open(390, 844);
    await page.click("#startBtn");
    await page.waitForTimeout(150);
    R.portrait390x844 = { survey: await survey(page, 390, 844) };
    await ctx.close();
  }

  /* ---------- 对照组：html/body/#stage 也设 touch-action:none 后再测 CDP 触摸 ---------- */
  {
    const { ctx, page } = await open(844, 390);
    await page.click("#startBtn");
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      [document.documentElement, document.body, document.getElementById("stage"), document.getElementById("cv")]
        .forEach(e => { e.style.touchAction = "none"; });
      document.documentElement.style.overscrollBehavior = "none";
      window.__ev = [];
      ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(t =>
        window.addEventListener(t, e => window.__ev.push(t + "@" + Math.round(e.clientX)), true));
    });
    const cdp = await ctx.newCDPSession(page);
    // (a) 在 canvas 空白区（屏幕正中偏左，避开 HUD）
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 300, y: 120, id: 1 }] });
    await page.waitForTimeout(40);
    for (let i = 1; i <= 3; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 300, y: 120 - i * 25, id: 1 }] });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(120);
    R.controlTouchActionNone = {
      atCanvasBlank300x120: await page.evaluate(() => window.__ev.slice())
    };
    await ctx.close();
  }

  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(R, null, 2), "utf8");
  console.log("done");
})().catch(e => {
  fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e && e.stack || e) }, null, 2), "utf8");
  console.log("fatal");
});
