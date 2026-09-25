/* 移动端手势改造原型验证（只注入运行时补丁，不改项目文件）
 * 目的：不做可行性推测，直接把「Pointer 事件 + touch-action:none + 双指分区」实现出来跑一遍，
 *      回答：① 触摸能不能击球成功 ② 双指（左半屏调拍面 + 右半屏击球）能不能同时生效
 */
const { chromium } = require("playwright");
const fs = require("fs");

const GAME = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/first-person-pingpong";
const URL = "file:///" + GAME + "/index.html";
const OUT = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe2_out.json";

const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--ignore-gpu-blocklist", "--enable-webgl"];

/* 原型补丁：完全用页面内已有的 G / clamp / doHit 等全局绑定 */
const PATCH = () => {
  const cv = document.getElementById("cv");
  cv.style.touchAction = "none";                 // 改动 ①：让浏览器不再把拖动当滚动手势
  window.__log = [];
  window.__stat = { hitCalls: 0, faceChanges: 0, pointerDowns: 0 };
  const clamp01 = (v, a, b) => v < a ? a : v > b ? b : v;

  let faceId = null, faceY0 = 0, hitId = null;
  const FACE_ZONE = 0.45;                        // 左 45% 屏宽 = 拍面区

  cv.addEventListener("pointerdown", e => {
    window.__stat.pointerDowns++;
    if (e.clientX < innerWidth * FACE_ZONE && faceId === null) {
      faceId = e.pointerId; faceY0 = e.clientY;
      window.__log.push("faceBegin@" + Math.round(e.clientY));
      return;                                    // 这一指不进击球链路
    }
    hitId = e.pointerId;
    cv.dispatchEvent(new MouseEvent("mousedown", { clientX: e.clientX, clientY: e.clientY, bubbles: true }));
    window.__log.push("hitBegin@" + Math.round(e.clientX) + "," + Math.round(e.clientY));
  });

  window.addEventListener("pointermove", e => {
    if (e.pointerId === faceId) {
      // 改动 ②：纵向拖动 = 拍面角度（上滑压拍 / 下滑亮拍），灵敏度 140px 走满 -1..1
      G.paddleAngle = clamp01((faceY0 - e.clientY) / 140, -1, 1);
      window.__stat.faceChanges++;
      return;
    }
    if (e.pointerId !== hitId) return;
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: e.clientX, clientY: e.clientY, bubbles: true }));
  });

  window.addEventListener("pointerup", e => {
    if (e.pointerId === faceId) { faceId = null; window.__log.push("faceEnd"); return; }
    if (e.pointerId !== hitId) return;
    hitId = null;
    window.__stat.hitCalls++;
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  window.addEventListener("pointercancel", () => window.__log.push("pointerCANCEL"));
};

(async () => {
  const browser = await chromium.launch({ args: ARGS });
  const ctx = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 3,   // 手机横屏
    isMobile: true, hasTouch: true
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
  const R = { attempts: [], finalStat: null, errs };

  const snap = () => page.evaluate(() => ({
    phase: G.phase, hitDone: G.hitDone, rally: G.rally, msg: G.msg, msgSub: G.msgSub,
    paddleAngle: +G.paddleAngle.toFixed(2), spin: G.spinName,
    phaseAt: performance.now()
  }));

  const waitIncoming = async (ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await page.evaluate(() => ({ p: G.phase, ideal: G.idealSet }));
      if (s.p === "incoming") return true;
      await page.waitForTimeout(20);
    }
    return false;
  };

  /* 单指击球：等到球飞到理想点附近再松手 */
  for (let k = 0; k < 5; k++) {
    if (!(await waitIncoming())) break;
    const bx = 620, by = 300;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bx, y: by, id: 1 }] });
    for (let i = 1; i <= 4; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: bx - i * 16, y: by - i * 5, id: 1 }] });
      await page.waitForTimeout(10);
    }
    // 等理想击球点
    const t1 = Date.now();
    while (Date.now() - t1 < 1200) {
      const s = await page.evaluate(() => ({ ideal: G.idealSet, p: G.phase }));
      if (s.ideal || s.p !== "incoming") break;
      await page.waitForTimeout(15);
    }
    await page.waitForTimeout(90);
    const before = await snap();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(160);
    const after = await snap();
    R.attempts.push({ k, spin: before.spin, msgBefore: before.msg, phaseBefore: before.phase,
                      after: { phase: after.phase, hitDone: after.hitDone, rally: after.rally, msg: after.msg, sub: after.msgSub } });
    if (after.phase === "over" || after.msg) { /* 失败即结束，重开继续测 */ }
    // 若这一局已结束，重开
    const over = await page.evaluate(() => G.phase === "over" || !G.running);
    if (over) { await page.evaluate(() => { if (typeof restart === "function") restart(); }); await page.waitForTimeout(400); await page.evaluate(PATCH); }
  }

  /* 双指：左手在左半屏纵向拖动调拍面，右手击球 */
  await page.evaluate(() => { if (typeof restart === "function") restart(); });
  await page.waitForTimeout(300);
  await page.evaluate(PATCH);
  if (await waitIncoming()) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 140, y: 260, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 140, y: 220, id: 1 }] });
    await page.waitForTimeout(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: 140, y: 190, id: 1 }, { x: 700, y: 320, id: 2 }] });
    await page.waitForTimeout(60);
    const faceNow = await page.evaluate(() => +G.paddleAngle.toFixed(2));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: 140, y: 170, id: 1 }, { x: 640, y: 280, id: 2 }] });
    const t1 = Date.now();
    while (Date.now() - t1 < 1200) {
      const s = await page.evaluate(() => ({ ideal: G.idealSet, p: G.phase }));
      if (s.ideal || s.p !== "incoming") break;
      await page.waitForTimeout(15);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: 140, y: 170, id: 1 }] });
    await page.waitForTimeout(150);
    const mid = await snap();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(200);
    const end = await snap();
    R.twoFinger = { faceAngleWhilePressing: faceNow, afterFaceLift: mid, afterHitLift: end,
                    stat: await page.evaluate(() => window.__stat), log: await page.evaluate(() => window.__log) };
  }

  R.finalStat = await page.evaluate(() => window.__stat);
  R.events = await page.evaluate(() => window.__log.slice(-30));
  await page.screenshot({ path: "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe2_landscape.png" });
  await ctx.close();
  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(R, null, 2), "utf8");
  console.log("done");
})().catch(e => {
  fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e && e.stack || e) }, null, 2), "utf8");
  console.log("fatal");
});
