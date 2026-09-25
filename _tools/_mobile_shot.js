/* 移动端截图（README 用图）：平板横屏对局 + 手机竖屏引导层
 *
 * 为什么从**线上地址**抓而不是 file://：README 是给访客看的，
 * 图要与「点开链接后看到的东西」一致。顺带也是对部署产物的一次目视复核。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node _mobile_shot.js
 */
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "docs", "images");
fs.mkdirSync(OUT, { recursive: true });
const URL = "https://spin-pingpong.app.workbuddy.host/";
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--ignore-gpu-blocklist", "--enable-webgl"];

/* 与 _touch_browser.js 同款的页面内手势：真实 PointerEvent + rAF 节奏，
 * 在理想击球点松手。别自己手搓 fire 序列——第一版那样做 5 次里 4 次下网，
 * 抓出来是「结算中」而不是挥拍。 */
const INSTALL = () => {
  window.__simGesture = (o) => new Promise(res => {
    const c = document.getElementById("cv");
    const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {
      pointerId: 7, clientX: x, clientY: y, bubbles: true,
      pointerType: "touch", isPrimary: true, button: 0, buttons: 1 }));
    fire("pointerdown", o.x, o.y);
    let step = 0;
    const t0 = performance.now();
    const tick = () => {
      step++;
      fire("pointermove", o.x + (o.dx || 0) * step / o.steps, o.y + (o.dy || 0) * step / o.steps);
      if (step < o.steps) return requestAnimationFrame(tick);
      const wait = () => {
        if (G.idealSet || G.phase !== "incoming")
          { fire("pointerup", o.x + (o.dx || 0), o.y + (o.dy || 0)); return res(true); }
        if (performance.now() - t0 > 2500) { fire("pointerup", o.x, o.y); return res(false); }
        requestAnimationFrame(wait);
      };
      wait();
    };
    requestAnimationFrame(tick);
  });
  return "ok";
};

(async () => {
  const browser = await chromium.launch({ args: ARGS });

  /* ---- 1. 平板横屏：对局中（球在飞，HUD + 触屏控制簇都在）---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 },
                                           deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    /* 穿透 CDN / 浏览器缓存：截图必须反映**刚部署的**产物，
       否则会拿旧图当成新版的验证结果（本轮踩过：overlay 修完抓图，
       图还是旧的，一度以为修复没生效）。 */
    await page.route("**/*", r => r.continue({ headers: Object.assign({}, r.request().headers(), { "Cache-Control": "no-cache", "Pragma": "no-cache" }) }));
    await page.goto(URL, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(1600);
    const stamp = await page.evaluate(() => {
      const d = document.documentElement.outerHTML;
      return { autoMargin: d.indexOf("margin-top:auto") >= 0 || d.indexOf("margin-top: auto") >= 0 };
    });
    console.log("平板开始页 → 线上含 overlay 居中修复: " + stamp.autoMargin);
    await page.screenshot({ path: path.join(OUT, "08-tablet-start.png") });   // 开始页（触屏版）
    await page.click("#startBtn");
    await page.waitForTimeout(150);
    /* 等球飞到身前，抓「来球在途 + 理想击球点光环」这一帧 */
    const got = await page.evaluate(() => new Promise(res => {
      const t0 = Date.now();
      const w = () => {
        const b = G.ball;
        if (G.phase === "incoming" && b.z > 0.55 && b.z < 1.10) return res(true);
        if (Date.now() - t0 > 3200) return res(false);
        requestAnimationFrame(w);
      };
      w();
    }));
    await page.screenshot({ path: path.join(OUT, "09-tablet-play.png") });
    console.log("平板横屏对局帧: " + (got ? "已抓到来球在途" : "超时（仍出图）"));

    /* 再来一张挥拍/回球瞬间。用与回归同款的手势（8/8 命中率），
     * 抓完立刻检查阶段——若已成"结算中"就重开再来，避免把失败页当成功图。 */
    await page.evaluate(INSTALL);
    for (let k = 0; k < 4; k++) {
      await page.evaluate(() => { restart(); });
      await page.waitForTimeout(360);
      await page.evaluate(() => { G.paddleAngle = correctTiltFor(G.spin); });
      await page.evaluate(() => window.__simGesture({ x: 700, y: 470, dx: 0, dy: -150, steps: 6 }));
      await page.waitForTimeout(150);
      const ph = await page.evaluate(() => G.phase);
      if (ph === "returning" || ph === "over" && k === 3) {
        await page.screenshot({ path: path.join(OUT, "10-tablet-hit.png") });
        console.log("平板挥拍帧: phase=" + ph + "（第 " + (k + 1) + " 次尝试）");
        break;
      }
      console.log("  第 " + (k + 1) + " 次尝试未命中（phase=" + ph + "），重来");
    }
    await ctx.close();
  }

  /* ---- 2. 手机竖屏：引导层 ---- */
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 },
                                           deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(1600);
    await page.screenshot({ path: path.join(OUT, "11-phone-portrait.png") });
    const on = await page.evaluate(() => document.getElementById("rotateHint").classList.contains("on"));
    console.log("手机竖屏引导层: " + (on ? "已显示 ✓" : "未显示 ✗（出图仍生成）"));
    await ctx.close();
  }

  await browser.close();
  console.log("输出目录: " + OUT);
})().catch(e => { console.log("fatal: " + String(e && e.stack || e)); process.exit(1); });
