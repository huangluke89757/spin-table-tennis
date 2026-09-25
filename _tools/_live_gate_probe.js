/* 线上门控探查：为什么 aspect=2.193 时 isSupported() 仍返回 false */
const { chromium } = require("playwright");
const URL = "https://spin-pingpong.app.workbuddy.host/";

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 750, height: 342 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(2000);

  const r = await page.evaluate(() => {
    const out = {};
    out.iw = window.innerWidth; out.ih = window.innerHeight;
    out.ratio = window.innerWidth / window.innerHeight;
    out.coarse = window.matchMedia("(pointer: coarse)").matches;
    out.hasMM = !!window.matchMedia;
    /* 判据常量本身 */
    try { out.MIN_PLAY_ASPECT = typeof MIN_PLAY_ASPECT === "undefined" ? "UNDEFINED" : MIN_PLAY_ASPECT; }
    catch (e) { out.MIN_PLAY_ASPECT = "THROW:" + e.message; }
    /* 直接算一遍：与函数内部应该一致 */
    try { out.manual = out.ratio >= MIN_PLAY_ASPECT; } catch (e) { out.manual = "THROW:" + e.message; }
    /* 函数返回值 */
    try { out.supported = isSupported(); } catch (e) { out.supported = "THROW:" + e.message; }
    /* 源码里的函数体，看线上到底跑的哪一版 */
    try {
      const src = isSupported.toString();
      out.fnBody = src.slice(0, 340);
      out.fnHasMin = src.indexOf("MIN_PLAY_ASPECT") >= 0;
      out.fnHas768 = src.indexOf("768") >= 0;
    } catch (e) { out.fnBody = "THROW:" + e.message; }
    return out;
  });

  console.log("\n线上门控探查 @ 750×342\n");
  for (const [k, v] of Object.entries(r)) console.log("  " + k + ": " + v);
  if (errs.length) { console.log("\n  页面错误 " + errs.length + " 条:"); errs.slice(0, 5).forEach(e => console.log("    " + e)); }
  console.log("");
  await browser.close();
})();
