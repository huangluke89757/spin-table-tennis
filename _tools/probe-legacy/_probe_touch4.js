/* 原型 v4：干净验证
 * A. 页面内 rAF 驱动的触摸手势（dx=0 纯上滑 → 中路回球，成功率最高），拍面按来球设正确值
 *    → 验证「触摸拖拽输入 → 击球判定 → 回球成功」整条链路能否跑通（看 rally 是否增长）
 * B. CDP 真实触摸事件链（带间隔），确认 pointercancel 是否只是时序问题
 */
const { chromium } = require("playwright");
const fs = require("fs");

const GAME = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/first-person-pingpong";
const URL = "file:///" + GAME + "/index.html";
const OUT = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe4_out.json";
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--ignore-gpu-blocklist", "--enable-webgl"];

const PATCH = () => {
  if (window.__patched) return "already";
  window.__patched = true;
  const cv = document.getElementById("cv");
  cv.style.touchAction = "none";
  window.__diag = [];
  window.__hitCalls = 0;
  window.__fails = [];
  let pid = null, facePid = null, fy0 = 0;

  cv.addEventListener("pointerdown", e => {
    if (e.clientX < innerWidth * 0.45 && facePid === null) { facePid = e.pointerId; fy0 = e.clientY; return; }
    pid = e.pointerId;
    drag.on = true; drag.sx = drag.x = e.clientX; drag.sy = drag.y = e.clientY;
    drag.speed = 0; drag.t0 = performance.now();
  });
  window.addEventListener("pointermove", e => {
    if (e.pointerId === facePid) { G.paddleAngle = clamp((fy0 - e.clientY) / 140, -1, 1); return; }
    if (e.pointerId !== pid) return;
    drag.x = e.clientX; drag.y = e.clientY;
  });
  window.addEventListener("pointerup", e => {
    if (e.pointerId === facePid) { facePid = null; return; }
    if (e.pointerId !== pid) return;
    pid = null; drag.on = false;
    const len = Math.hypot(drag.x - drag.sx, drag.y - drag.sy);
    const secs = Math.max(0.05, (performance.now() - drag.t0) / 1000);
    drag.speed = len / secs;
    const pass = G.running && !G.paused && G.phase === "incoming" && !G.hitDone;
    window.__diag.push("hitUp len=" + Math.round(len) + " v=" + Math.round(drag.speed) + " phase=" + G.phase + " pass=" + pass);
    if (pass) { window.__hitCalls++; doHit(drag); }
  });
  window.addEventListener("pointercancel", () => window.__diag.push("pointerCANCEL"));

  /* 页面内手势模拟：真实 PointerEvent，rAF 控制节奏，等到理想点松手 */
  window.__simGesture = (o) => new Promise(res => {
    const c = document.getElementById("cv");
    const id = o.id || 7;
    const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {
      pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: "touch", isPrimary: true }));
    fire("pointerdown", o.x, o.y);
    let step = 0;
    const t0 = performance.now();
    const moveTick = () => {
      step++;
      fire("pointermove", o.x + (o.dx || 0) * step / o.steps, o.y + (o.dy || 0) * step / o.steps);
      if (step < o.steps) return requestAnimationFrame(moveTick);
      const wait = () => {
        if (G.idealSet || G.phase !== "incoming") {
          fire("pointerup", o.x + (o.dx || 0), o.y + (o.dy || 0));
          return res({ ok: true, atIdeal: G.idealSet, phaseAtUp: G.phase, ms: Math.round(performance.now() - t0) });
        }
        if (performance.now() - t0 > 2500) return res({ ok: false, reason: "timeout", phase: G.phase });
        requestAnimationFrame(wait);
      };
      wait();
    };
    requestAnimationFrame(moveTick);
  });
  return "patched";
};

(async () => {
  const browser = await chromium.launch({ args: ARGS });
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(1500);
  await page.click("#startBtn");
  await page.waitForTimeout(120);
  await page.evaluate(PATCH);
  const cdp = await ctx.newCDPSession(page);

  const R = { A_simGesture: [], B_cdpTouch: [], errs };

  const fresh = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await page.evaluate(() => ({ p: G.phase, i: G.idealSet }));
      if (s.p === "incoming" && !s.i) return true;
      if (s.p === "over") { await page.evaluate(() => restart()); await page.waitForTimeout(350); }
      await page.waitForTimeout(10);
    }
    return false;
  };

  /* ---------- A. 页面内手势：从屏幕右上往正上方滑 150px（中路、中高力量） ---------- */
  for (let k = 0; k < 6; k++) {
    if (!(await fresh(3000))) { R.A_simGesture.push({ k, skip: true }); break; }
    const prep = await page.evaluate(() => {
      G.paddleAngle = correctTiltFor(G.spin);          // 拍面按正确对策（隔离"拍面判断"这个变量）
      return { spin: G.spinName, angle: +G.paddleAngle.toFixed(2) };
    });
    const before = await page.evaluate(() => ({ rally: G.rally, score: G.score }));
    const g = await page.evaluate(() => window.__simGesture({ x: 600, y: 340, dx: 0, dy: -150, steps: 6 }));
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({
      phase: G.phase, rally: G.rally, score: G.score, msg: G.msg, sub: G.msgSub,
      hitDone: G.hitDone, hits: window.__hitCalls, diag: window.__diag.slice(-3)
    }));
    R.A_simGesture.push({ k, spin: prep.spin, angle: prep.angle, gesture: g,
      before, after: { phase: after.phase, rally: after.rally, score: after.score, msg: after.msg,
                       sub: after.sub, hitDone: after.hitDone, hits: after.hits, diag: after.diag },
      rallied: after.rally > before.rally });
  }

  /* ---------- B. CDP 真实触摸（带节奏间隔），看事件链是否完整 ---------- */
  await page.evaluate(() => restart());
  await page.waitForTimeout(400);
  await page.evaluate(() => { window.__diag.length = 0; });
  for (let k = 0; k < 3; k++) {
    if (!(await fresh(3000))) break;
    await page.evaluate(() => { G.paddleAngle = correctTiltFor(G.spin); });
    const b = await page.evaluate(() => G.rally);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 620, y: 340, id: 1 }] });
    await page.waitForTimeout(40);
    for (let i = 1; i <= 4; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 620, y: 340 - i * 28, id: 1 }] });
      await page.waitForTimeout(30);
    }
    // 在理想点附近松手
    const t1 = Date.now();
    while (Date.now() - t1 < 1200) {
      const s = await page.evaluate(() => ({ i: G.idealSet, p: G.phase }));
      if (s.i || s.p !== "incoming") break;
      await page.waitForTimeout(10);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(250);
    const a = await page.evaluate(() => ({
      phase: G.phase, rally: G.rally, msg: G.msg, sub: G.msgSub, hitDone: G.hitDone,
      diag: window.__diag.slice(-5)
    }));
    R.B_cdpTouch.push({ k, rallyBefore: b, after: a, rallied: a.rally > b });
  }

  R.finalHits = await page.evaluate(() => window.__hitCalls);
  R.finalDiag = await page.evaluate(() => window.__diag.slice(-12));
  await ctx.close(); await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(R, null, 2), "utf8");
  console.log("done");
})().catch(e => {
  fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e && e.stack || e) }, null, 2), "utf8");
  console.log("fatal");
});
