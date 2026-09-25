/* 最终确认：模拟用户真机（iPhone 12/13 横屏 750×342，与截图一致）
 * 抓图 + 断言「能进游戏 + 能真的回球」，作为修复的交付证据。 */
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shots");
const URL = "https://spin-pingpong.app.workbuddy.host/";

(async () => {
  const browser = await chromium.launch();
  /* 用 iPhone 13 的真实描述符（含 UA / DPR / 触摸），最接近用户设备 */
  for (const [w, h, name] of [[740, 342, "iPhone12-13横屏"], [844, 390, "iPhone14Pro横屏"]]) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h }, deviceScaleFactor: 3,
      isMobile: true, hasTouch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 " +
                 "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on("pageerror", e => errs.push(e.message));
    await page.goto(URL + "?t=" + Date.now(), { waitUntil: "load" });
    await page.waitForTimeout(1800);

    /* 开始页截图 */
    await page.screenshot({ path: path.join(OUT, "50_fixed_" + name + "_start.png") });

    const gate = await page.evaluate(() => ({
      hintOn: document.getElementById("rotateHint").classList.contains("on"),
      supported: isSupported(),
      aspect: +(innerWidth / innerHeight).toFixed(3),
      iw: innerWidth, ih: innerHeight,
    }));

    /* 真的开始对局 */
    await page.click("#startBtn");
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, "50_fixed_" + name + "_play.png") });

    /* 真触摸回球。
     * 必须轮询等「球在飞且还没到最佳击球点」的干净窗口 —— 直接判断一次就挥拍，
     * 多半落在结算中/已击球的状态，循环会一次都进不去（tries=0），
     * 那是取样时机不对，不是功能坏。 */
    let hits = 0, tries = 0;
    const t0 = Date.now();
    while (tries < 8 && Date.now() - t0 < 20000) {
      const st = await page.evaluate(() => ({ p: G.phase, i: G.idealSet, over: !G.running }));
      if (st.over || st.p === "over") { await page.evaluate(() => restart()); await page.waitForTimeout(320); continue; }
      if (st.p !== "incoming" || st.i) { await page.waitForTimeout(35); continue; }
      await page.evaluate(() => { G.paddleAngle = correctTiltFor(G.spin); });
      await page.evaluate(() => {
        const c = document.getElementById("cv");
        const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {
          pointerId: 1, clientX: x, clientY: y, bubbles: true,
          pointerType: "touch", isPrimary: true, button: 0, buttons: 1 }));
        const cx = innerWidth * 0.78, cy = innerHeight * 0.72;
        fire("pointerdown", cx, cy);
        for (let i = 1; i <= 6; i++) fire("pointermove", cx, cy - i * 26);
        fire("pointerup", cx, cy - 156);
      });
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => G.hitDone);
      tries++;
      if (after) hits++;
    }
    const fin = await page.evaluate(() => ({ rally: G.rally, running: G.running, level: G.level }));

    console.log("\n=== " + name + "（" + w + "×" + h + "）===");
    console.log("  门控：" + (gate.hintOn ? "❌ 仍被拦" : "✅ 放行") +
                "　aspect=" + gate.aspect + "　supported=" + gate.supported);
    console.log("  对局：running=" + fin.running + "　连续回球=" + fin.rally + "　难度档=" + fin.level);
    console.log("  触摸回球：识别 " + hits + "/" + tries + " 次 " + (hits > 0 ? "✅" : "❌"));
    console.log("  页面错误：" + errs.length + (errs.length ? " " + errs[0] : ""));
    await ctx.close();
  }
  await browser.close();
  console.log("\n截图：_shots/50_fixed_*_start.png / _shots/50_fixed_*_play.png\n");
})();
