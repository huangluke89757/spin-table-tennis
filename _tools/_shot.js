// 真浏览器验证：headless Chromium + SwiftShader 跑 WebGL，截关键帧检查 3D 与 HUD
// 运行： NODE_PATH=<workspace>/node_modules node _shot.js
const { chromium } = require("playwright");
const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;



const OUT = ROOT + "\\_shots";
require("fs").mkdirSync(OUT, { recursive: true });
const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

(async () => {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
           "--ignore-gpu-blocklist", "--enable-webgl"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });

  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + "\\01_start.png" });

  const diag = await page.evaluate(() => ({
    three: typeof THREE !== "undefined" && THREE.REVISION,
    ok: typeof THREE_OK !== "undefined" ? THREE_OK : null,
    err: (document.getElementById("errMsg") || {}).textContent || "",
    canvas: (() => { const c = document.getElementById("cv"); return c.width + "x" + c.height; })()
  }));
  console.log("three r" + diag.three + "  THREE_OK=" + diag.ok + "  canvas=" + diag.canvas +
              (diag.err ? "  err=" + diag.err : ""));

  await page.click("#startBtn");
  await page.screenshot({ path: OUT + "\\02_play.png" });

  // 等球飞到身前（z 0.5~1.15），做一次真实拖动击球；错过就重开重试
  let st = null;
  for (let attempt = 0; attempt < 4 && !st; attempt++) {
    if (attempt) { await page.evaluate(() => restart()); }
    const got = await page.evaluate(() => new Promise(res => {
      const t0 = Date.now();
      const w = () => {
        const b = G.ball;
        if (G.phase === "incoming" && b.z > 0.50 && b.z < 1.15) return res("ok");
        if (Date.now() - t0 > 3000) return res("timeout");
        requestAnimationFrame(w);
      };
      w();
    }));
    if (got === "ok") st = await page.evaluate(() => ({ phase: G.phase, z: +G.ball.z.toFixed(2), type: G.spinName }));
  }
  console.log("击球前: " + JSON.stringify(st));

  // 按当前来球球型设置拍面（模拟玩家滚轮调拍面），再拖动
  const aimInfo = await page.evaluate(() => {
    G.paddleAngle = Math.max(-1, Math.min(1, correctTiltFor(G.spin)));
    const side = Math.abs(G.spin.wy) > 60 ? -Math.sign(G.spin.wy) : 0;
    return { tilt: +G.paddleAngle.toFixed(2), side, pz: +G.ball.z.toFixed(2), ideal: +(G.predHitT - (G.gt - G.serveT)).toFixed(3) };
  });
  console.log("拍面设置: " + JSON.stringify(aimInfo));

  await page.mouse.move(720, 520);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(720 + i * 16 + aimInfo.side * 60, 520 - i * 9); await page.waitForTimeout(14); }
  await page.evaluate(() => new Promise(res => {          // 踩到理想击球时刻再松手
    const t0 = Date.now();
    const w = () => { if (G.idealSet || Date.now() - t0 > 500) return res(); requestAnimationFrame(w); };
    w();
  }));
  await page.mouse.up();
  await page.waitForTimeout(115);                       // 球拍前推段（t≈0.34，正好在击球点）
  await page.screenshot({ path: OUT + "\\03_hit.png" });
  await page.waitForTimeout(120);
  await page.screenshot({ path: OUT + "\\03c_out.png" });
  const after = await page.evaluate(() => ({ phase: G.phase, rally: G.rally, msg: G.msg, sub: G.msgSub,
                                             anim: +G.paddle.anim.toFixed(2), side: G.paddle.side, act: G.paddle.action,
                                             racketVis: !!OBJ.racket.visible, racketLVis: !!OBJ.racketL.visible,
                                             rPos: OBJ.racket.position.toArray().map(v => +v.toFixed(2)),
                                             rLPos: OBJ.racketL.position.toArray().map(v => +v.toFixed(2)) }));
  console.log("击球后: " + JSON.stringify(after));
  await page.waitForTimeout(120);
  await page.screenshot({ path: OUT + "\\03b_out.png" });

  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + "\\04_after.png" });

  // 重开一局，抓一张球正在飞行中的实时帧（验证残影与时机环）
  await page.evaluate(() => restart());
  await page.waitForTimeout(1400);
  await page.screenshot({ path: OUT + "\\06_live.png" });

  /* 球拍专项：先把来球摆到击球点，再挥拍，连抓三帧确认球拍真的入画且比例正常。
   * 同时量一下球的屏幕投影宽高比，确认「运动和静止都是正圆」。 */
  const rk = await page.evaluate(() => new Promise(res => {
    restart();
    const t0 = Date.now();
    const w = () => {
      if (G.phase === "incoming" && G.ball.z > 0.9 && G.ball.z < 1.2) return res(measure());
      if (Date.now() - t0 > 3000) return res(null);
      requestAnimationFrame(w);
    };
    function measure() {
      const v = new THREE.Vector3(G.ball.x, G.ball.y, G.ball.z).project(CAM);
      return { z: +G.ball.z.toFixed(2), ndc: [+v.x.toFixed(3), +v.y.toFixed(3)] };
    }
    w();
  }));
  await page.mouse.move(720, 520);
  await page.mouse.down();
  await page.evaluate(() => { G.idealSet = true; G.tIdeal = G.gt; });   // 踩到理想击球时刻
  for (let i = 1; i <= 6; i++) { await page.mouse.move(720 + i * 16, 520 - i * 9); await page.waitForTimeout(12); }
  await page.mouse.up();
  await page.waitForTimeout(70);
  /* 球拍必须真的在屏幕上「看得见」。
   * 只断言 OBJ.racket.visible 是不够的——球拍曾经的入画点在 NDC y≈-0.83（屏幕最底边），
   * 渲染了但没人看得见。这里直接量投影：可见 + NDC 落在画面内 + 屏幕占比够大。 */
  const rkCheck = await page.evaluate(() => {
    G.paddle.anim = 0.45; G.paddle.pend = 0; updatePaddle();
    const r = G.paddle.side < 0 ? OBJ.racket : OBJ.racketL;
    const v = new THREE.Vector3(r.position.x, r.position.y, r.position.z).project(CAM);
    const dist = CAM.position.distanceTo(r.position);
    const px = 0.19 * r.scale.x * (window.innerHeight / 2) /
               (Math.tan(CAM.fov * Math.PI / 360) * dist);      // 球拍直径的屏幕像素
    return { vis: !!r.visible, ndc: [+v.x.toFixed(2), +v.y.toFixed(2)],
             px: Math.round(px), pctH: +(px / window.innerHeight * 100).toFixed(1) };
  });
  /* 上界同样要卡：球拍太大（占屏高 >30%）会把来球与台面挡掉，比看不见更糟 */
  const rkOk = rkCheck.vis && Math.abs(rkCheck.ndc[0]) < 0.9 && Math.abs(rkCheck.ndc[1]) < 0.9 &&
               rkCheck.pctH >= 6 && rkCheck.pctH <= 26;
  console.log("球拍可见性: " + JSON.stringify(rkCheck) + (rkOk ? "  ✓ 在画面内且尺度合理" : "  ✗ 有问题"));
  await page.screenshot({ path: OUT + "\\07_swing1.png" });
  await page.waitForTimeout(110);
  await page.screenshot({ path: OUT + "\\07_swing2.png" });
  await page.waitForTimeout(110);
  await page.screenshot({ path: OUT + "\\07_swing3.png" });
  console.log("球拍专项: 球位置 " + JSON.stringify(rk) + "  拍子可见=" +
    await page.evaluate(() => !!(G.paddle.side < 0 ? OBJ.racket.visible : OBJ.racketL.visible)));

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.screenshot({ path: OUT + "\\05_pause.png" });

  console.log(errs.length ? "\n页面错误:\n  " + errs.join("\n  ") : "\n无页面错误");
  await browser.close();
  process.exit(errs.length || !rkOk ? 1 : 0);
})();
