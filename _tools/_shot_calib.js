// 抓帧机位标定：在真浏览器里扫方位角/仰角/距离，找出「对方半台完整入画」的距离。
// 运行： NODE_PATH=<workspace>/node_modules node _shot_calib.js
const { chromium } = require("playwright");
const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;



const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

(async () => {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(900);

  const out = await page.evaluate(() => {
    /* 目标：对方半台四角（z 从 -halfL 到 0）全部落在 NDC |x|<0.94 / |y|<0.94，
     * 同时让画面"填充度"尽量高——半台占画面越大，海报上的落点越清楚。 */
    function measure(az, el, d) {
      const cp = shotCamPos(az, el, d);
      CAM.position.set(cp[0], cp[1], cp[2]);
      CAM.lookAt(SHOT_TARGET[0], SHOT_TARGET[1], SHOT_TARGET[2]);
      CAM.updateMatrixWorld(true);
      let mx = 0, my = 0, mnx = 1, mny = 1;
      [[-1, 0], [1, 0], [-1, -1], [1, -1]].forEach(q => {
        const v = new THREE.Vector3(q[0] * T.halfW, T.h, q[1] * T.halfL).project(CAM);
        mx = Math.max(mx, Math.abs(v.x)); my = Math.max(my, Math.abs(v.y));
        mnx = Math.min(mnx, Math.abs(v.x)); mny = Math.min(mny, Math.abs(v.y));
      });
      return { mx: mx, my: my, mnx: mnx, mny: mny };
    }
    const rows = [];
    for (const cam of SHOT_CAMS) {
      let best = null;
      for (let d = 1.0; d <= 4.0; d += 0.05) {
        const m = measure(cam.az, cam.el, d);
        if (m.mx >= 0.94 || m.my >= 0.94) continue;
        const fill = Math.min(m.mx, m.my);          // 越大越"填满"
        if (!best || fill > best.fill) best = { d: +d.toFixed(2), fill: +fill.toFixed(3),
                                                mx: +m.mx.toFixed(2), my: +m.my.toFixed(2) };
      }
      rows.push({ az: cam.az, el: cam.el, cur: cam.d, best: best });
    }
    CAM.position.set(0, CAM_Y, CAM_Z); CAM.lookAt(0, 0.96, -0.3);
    return rows;
  });
  rows_echo(out);
  await browser.close();

  function rows_echo(rows) {
    console.log("方位角  仰角   当前距离  建议距离  半台填充  NDC±");
    for (const r of rows) {
      const b = r.best;
      console.log("  " + String(r.az).padStart(3) + "°   " + String(r.el).padStart(3) + "°   " +
        String(r.cur).padEnd(8) + (b ? String(b.d).padEnd(9) + String(b.fill).padEnd(10) +
        "(" + b.mx + "," + b.my + ")" : "无解（该角度下怎么调都框不下）"));
    }
  }
})();
