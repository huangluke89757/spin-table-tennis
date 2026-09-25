/* 移动端可行性实测探针（只读，不改项目文件）
 * 目的：用真 headless Chromium 回答三个问题
 *   1) 竖屏 / 横屏下，球台与击球点是否还在相机视野内（量 NDC）
 *   2) 当前代码对触摸事件的真实响应（事件序列 + drag 状态 + phase）
 *   3) 像素量纲（dx/140、len/190）在不同屏幕宽度下的手感差异
 */
const { chromium } = require("playwright");
const fs = require("fs");

const GAME = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/first-person-pingpong";
const URL = "file:///" + GAME + "/index.html";
const OUT = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe_out.json";

const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--ignore-gpu-blocklist", "--enable-webgl"];

const results = {};

function ndcOf() {
  try {
    if (typeof CAM === "undefined" || !CAM) return { err: "CAM 不可用" };
    const p = (x, y, z) => {
      const v = new THREE.Vector3(x, y, z).project(CAM);
      return { x: +v.x.toFixed(3), y: +v.y.toFixed(3), off: Math.abs(v.x) > 1 || Math.abs(v.y) > 1 };
    };
    // 相机在 z=+2.72 朝 -z 看。横向可见半宽 = tan(hFov/2) * 深度
    const hHalf = Math.tan(Math.atan(Math.tan(CAM.fov * Math.PI / 360) * CAM.aspect));
    const depthAt = z => CAM.position.z - z;
    const halfWAt = z => +(hHalf * depthAt(z)).toFixed(3);
    return {
      aspect: +CAM.aspect.toFixed(3),
      vFovDeg: CAM.fov,
      hFovDeg: +(2 * Math.atan(hHalf) * 180 / Math.PI).toFixed(1),
      camPos: { x: CAM.position.x, y: +CAM.position.y.toFixed(2), z: +CAM.position.z.toFixed(2) },
      visibleHalfWidth: {
        atHitZ_1p30: halfWAt(1.30), atTableNear_1p37: halfWAt(1.37), atNet_0: halfWAt(0), atFar_neg1p37: halfWAt(-1.37)
      },
      // 球台 / 击球带在屏幕上的 NDC
      tableFarEdge: { L: p(-0.7625, 0.76, -1.37), R: p(0.7625, 0.76, -1.37) },
      tableNet: { L: p(-0.915, 0.76, 0), R: p(0.915, 0.76, 0) },
      tableNearEdge: { L: p(-0.7625, 0.76, 1.37), R: p(0.7625, 0.76, 1.37) },
      hitPointBand: { far: p(-0.90, 0.94, 1.30), c: p(0, 0.94, 1.30), near: p(0.90, 0.94, 1.30) },
      // 击球带上有多少横向范围可见（米）
      hitBandVisibleMeters: +(halfWAt(1.30) * 2).toFixed(2),
      hitBandNeededMeters: 1.8
    };
  } catch (e) { return { err: String(e && e.message || e) }; }
}

(async () => {
  const browser = await chromium.launch({ args: ARGS });

  /* ---------------- A. 竖屏（iPhone 13 逻辑尺寸 390×844） ---------------- */
  const ctxA = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
  });
  const pA = await ctxA.newPage();
  const errsA = [];
  pA.on("pageerror", e => errsA.push("pageerror: " + e.message));
  await pA.goto(URL, { waitUntil: "load" });
  await pA.waitForTimeout(1500);

  const domA = await pA.evaluate(() => {
    const cv = document.getElementById("cv");
    const cs = cv ? getComputedStyle(cv) : {};
    const box = id => { const e = document.getElementById(id); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
               right: Math.round(r.right), bottom: Math.round(r.bottom),
               disp: getComputedStyle(e).display,
               offRight: Math.round(r.right - innerWidth), offBottom: Math.round(r.bottom - innerHeight) }; };
    return {
      innerW: innerWidth, innerH: innerHeight, dpr: devicePixelRatio,
      visualViewportH: window.visualViewport ? Math.round(window.visualViewport.height) : null,
      canvasTouchAction: cs.touchAction,
      canvasCursor: cs.cursor,
      bodyOverflow: getComputedStyle(document.body).overflow,
      metaViewport: (document.querySelector('meta[name=viewport]') || {}).content,
      boxes: {
        startBtn: box("startBtn"), hudKeys: box("hudKeys"), hudFace: box("hudFace"),
        hudAux: box("hudAux"), hudCfg: box("hudCfg"), hudBrand: box("hudBrand"),
        hudScore: box("hudScore"), hudBall: box("hudBall"), topLinks: box("topLinks"),
        btnUiToggle: box("btnUiToggle")
      }
    };
  });

  await pA.click("#startBtn");
  await pA.waitForTimeout(150);

  const geomA = await pA.evaluate(ndcOf, null).catch(() => null);

  // 注入事件记录器
  await pA.evaluate(() => {
    window.__ev = [];
    ["pointerdown","pointermove","pointerup","pointercancel",
     "mousedown","mousemove","mouseup","touchstart","touchmove","touchend","wheel","click"]
      .forEach(t => window.addEventListener(t, e => {
        window.__ev.push(t + "#" + (e.pointerType || "") + "@" + Math.round(performance.now()));
      }, true));
  });

  // 一次真实触摸拖拽：屏幕中下部按住 → 向右上拖 120px → 松手
  const cdp = await ctxA.newCDPSession(pA);
  const x0 = 195, y0 = 560;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= 5; i++) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x0 + i * 24, y: y0 - i * 6 }] });
    await pA.waitForTimeout(16);
  }
  const midState = await pA.evaluate(() => ({
    dragOn: drag.on, dragX: drag.x, dragY: drag.y, sx: drag.sx,
    phase: G.phase, running: G.running, hitDone: G.hitDone, paddleAngle: G.paddleAngle
  }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pA.waitForTimeout(120);

  const afterState = await pA.evaluate(() => ({
    dragOn: drag.on, dragSpeed: Math.round(drag.speed),
    phase: G.phase, hitDone: G.hitDone, rally: G.rally, msg: G.msg,
    events: window.__ev.slice(-40)
  }));

  results.mobilePortrait = { dom: domA, geom: geomA, midTouchState: midState, afterTouch: afterState, errs: errsA };
  await pA.screenshot({ path: "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe_portrait.png" });
  await ctxA.close();

  /* ---------------- B. 横屏（844×390） ---------------- */
  const ctxB = await browser.newContext({
    viewport: { width: 844, height: 390 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true
  });
  const pB = await ctxB.newPage();
  await pB.goto(URL, { waitUntil: "load" });
  await pB.waitForTimeout(1500);
  await pB.click("#startBtn");
  await pB.waitForTimeout(150);
  results.mobileLandscape = {
    geom: await pB.evaluate(ndcOf, null).catch(() => null),
    dom: await pB.evaluate(() => ({ innerW: innerWidth, innerH: innerHeight }))
  };
  await pB.screenshot({ path: "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/_probe_landscape.png" });
  await ctxB.close();

  /* ---------------- C. 桌面基准（1440×900 横屏） ---------------- */
  const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pC = await ctxC.newPage();
  await pC.goto(URL, { waitUntil: "load" });
  await pC.waitForTimeout(1500);
  await pC.click("#startBtn");
  await pC.waitForTimeout(150);
  results.desktop = { geom: await pC.evaluate(ndcOf, null).catch(() => null) };
  await ctxC.close();

  /* ---------------- D. 量纲换算 ---------------- */
  const sensi = (w) => ({
    screenW: w,
    aimFullAtPx: 140, aimFullPctOfWidth: +(140 / w * 100).toFixed(1),
    aimClampAtPx: 119, aimClampPctOfWidth: +(119 / w * 100).toFixed(1),
    lenFullAtPx: 190, lenFullPctOfWidth: +(190 / w * 100).toFixed(1)
  });
  results.sensitivity = { mobile390: sensi(390), pad768: sensi(768), pc1440: sensi(1440) };

  await browser.close();
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8");
  console.log("done -> " + OUT);
})().catch(e => {
  fs.writeFileSync(OUT, JSON.stringify({ fatal: String(e && e.stack || e) }, null, 2), "utf8");
  console.log("fatal: " + e);
});
