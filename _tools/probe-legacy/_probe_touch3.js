/* 原型 v3：干净地验证「Pointer 事件 + touch-action:none + 双指分区」能否让触摸真正击球
 * 与 v2 的差别：不桥接 MouseEvent，而是直接复刻鼠标输入那 6 行逻辑接到 pointer 事件上
 * （这正是真实改造的做法）；补丁幂等，只注入一次；每步都有诊断输出。
 */
const { chromium } = require("playwright");
const fs = require("fs");

const GAME = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/first-person-pingpong";
const URL = "file:///" + GAME + "/index.html";
const OUT = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe3_out.json";
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--ignore-gpu-blocklist", "--enable-webgl"];

const PATCH = () => {
  if (window.__patched) return "already";
  window.__patched = true;
  const cv = document.getElementById("cv");
  cv.style.touchAction = "none";
  window.__diag = [];
  window.__hitCalls = 0;
  let pid = null, facePid = null, fy0 = 0;

  cv.addEventListener("pointerdown", e => {
    if (e.clientX < innerWidth * 0.45 && facePid === null) {
      facePid = e.pointerId; fy0 = e.clientY; window.__diag.push("faceDown"); return;
    }
    pid = e.pointerId;
    drag.on = true; drag.sx = drag.x = e.clientX; drag.sy = drag.y = e.clientY;
    drag.speed = 0; drag.t0 = performance.now();
    window.__diag.push("hitDown phase=" + G.phase + " running=" + G.running);
  });

  window.addEventListener("pointermove", e => {
    if (e.pointerId === facePid) { G.paddleAngle = clamp((fy0 - e.clientY) / 140, -1, 1); return; }
    if (e.pointerId !== pid) return;
    drag.x = e.clientX; drag.y = e.clientY;
  });

  window.addEventListener("pointerup", e => {
    if (e.pointerId === facePid) { facePid = null; window.__diag.push("faceUp angle=" + G.paddleAngle.toFixed(2)); return; }
    if (e.pointerId !== pid) return;
    pid = null; drag.on = false;
    const len = Math.hypot(drag.x - drag.sx, drag.y - drag.sy);
    const secs = Math.max(0.05, (performance.now() - drag.t0) / 1000);
    drag.speed = len / secs;
    const pass = G.running && !G.paused && G.phase === "incoming" && !G.hitDone;
    window.__diag.push("hitUp len=" + Math.round(len) + " v=" + Math.round(drag.speed) +
                       " phase=" + G.phase + " guard=" + pass);
    if (pass) { window.__hitCalls++; doHit(drag); }
  });
  window.addEventListener("pointercancel", () => window.__diag.push("pointerCANCEL"));
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
  await page.waitForTimeout(100);
  const patchRes = await page.evaluate(PATCH);
  const cdp = await ctx.newCDPSession(page);

  const st = () => page.evaluate(() => ({
    phase: G.phase, ideal: G.idealSet, hitDone: G.hitDone, rally: G.rally, score: G.score,
    msg: G.msg, sub: G.msgSub, spin: G.spinName, angle: +G.paddleAngle.toFixed(2),
    running: G.running, diag: window.__diag.slice(-6), hits: window.__hitCalls
  }));

  /* 等一个「新一轮来球、尚未到理想点」的时刻 */
  async function waitFreshIncoming(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await page.evaluate(() => ({ p: G.phase, i: G.idealSet }));
      if (s.p === "incoming" && !s.i) return true;
      await page.waitForTimeout(10);
    }
    return false;
  }
  async function waitIdeal(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await page.evaluate(() => ({ p: G.phase, i: G.idealSet }));
      if (s.p !== "incoming") return "phase=" + s.p;
      if (s.i) return "ideal";
      await page.waitForTimeout(8);
    }
    return "timeout";
  }

  const R = { patchRes, touchSingle: [], touchTwoFinger: null, errs };

  /* ---------- A. 单指触摸击球：按住 → 拖 → 在理想点松手 ---------- */
  for (let k = 0; k < 6; k++) {
    if (!(await waitFreshIncoming(2500))) { R.touchSingle.push({ k, skip: "no incoming" }); break; }
    const bx = 660, by = 300;
    const tDown = Date.now();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: bx, y: by, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: bx - 30, y: by - 10, id: 1 }] });
    const w = await waitIdeal(1400);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: bx - 62, y: by - 20, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(140);
    const s = await st();
    R.touchSingle.push({ k, waitedFor: w, dragMs: Date.now() - tDown, spin: s.spin,
      phase: s.phase, hitDone: s.hitDone, rally: s.rally, msg: s.msg, sub: s.sub, diag: s.diag, hits: s.hits });
    const dead = await page.evaluate(() => G.phase === "over" || !G.running);
    if (dead) { await page.evaluate(() => restart()); await page.waitForTimeout(450); }
  }

  /* ---------- B. 双指：左半屏纵向调拍面 + 右半屏击球 ---------- */
  await page.evaluate(() => restart());
  await page.waitForTimeout(400);
  if (await waitFreshIncoming(2500)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: 280, id: 1 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 150, y: 230, id: 1 }] });
    await page.waitForTimeout(50);
    // 第二指加入
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: 150, y: 200, id: 1 }, { x: 700, y: 320, id: 2 }] });
    await page.waitForTimeout(40);
    const faceMid = await page.evaluate(() => +G.paddleAngle.toFixed(2));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: 150, y: 175, id: 1 }, { x: 660, y: 300, id: 2 }] });
    const w = await waitIdeal(1400);
    const beforeUp = await page.evaluate(() => ({ p: G.phase, i: G.idealSet, angle: +G.paddleAngle.toFixed(2) }));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove",
      touchPoints: [{ x: 150, y: 175, id: 1 }, { x: 620, y: 285, id: 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: 150, y: 175, id: 1 }] });
    await page.waitForTimeout(160);
    const s1 = await st();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(200);
    const s2 = await st();
    R.touchTwoFinger = { waitedFor: w, faceAngleMid: faceMid, beforeUp, afterHitLift: s1, final: s2,
                         log: await page.evaluate(() => window.__diag) };
  }

  await page.screenshot({ path: "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe3_landscape.png" });
  await ctx.close(); await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(R, null, 2), "utf8");
  console.log("done");
})().catch(e => {
  fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e && e.stack || e) }, null, 2), "utf8");
  console.log("fatal");
});
