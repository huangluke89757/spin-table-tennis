/* ============================================================================
 * 视野对比 —— 直接看图，验证「手机横屏的 3D 视野不比平板横屏差」
 *
 * 判据不用公式，用眼睛 + 像素：
 *   同一时刻、同一场景，把球台远端两个角 + 球网两端的屏幕坐标量出来，
 *   看它们在两种视口下是否都在屏内、以及距屏幕边缘的余量。
 *   若手机横屏（被拦）的水平余量 ≥ 平板横屏（放行），则宽度门槛无依据。
 *
 * 同时抓图供肉眼复核（_shots/40_view_*.png）。
 * ========================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shots");
const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

const CASES = [
  { n: "手机横屏_被拦_iPhone13", w: 750,  h: 342 },
  { n: "手机横屏_被拦_iPhoneSE", w: 568,  h: 320 },
  { n: "平板横屏_放行_844x390",  w: 844,  h: 390 },
  { n: "平板横屏_放行_iPadPro",  w: 1194, h: 834 },
  { n: "手机竖屏_应拦",          w: 390,  h: 844 },
];

(async () => {
  const browser = await chromium.launch();
  const rows = [];

  for (const c of CASES) {
    const ctx = await browser.newContext({
      viewport: { width: c.w, height: c.h }, deviceScaleFactor: 1,
      isMobile: true, hasTouch: true,
    });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForTimeout(1700);

    /* 门控会拦住非支持设备 —— 但它只是遮罩层，场景仍在渲染。
     * 为了量 3D 视野，临时撤掉遮罩（不改任何游戏逻辑）。 */
    const m = await page.evaluate(() => {
      const hint = document.getElementById("rotateHint");
      hint.classList.remove("on");
      const W = innerWidth, H = innerHeight;
      CAM.aspect = W / H; CAM.updateProjectionMatrix();

      const proj = (x, y, z) => {
        const v = new THREE.Vector3(x, y, z).project(CAM);
        return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
      };
      /* 场地关键点：远端两角 + 网两端（看清这些 = 能判断落点与旋转） */
      const field = {
        "远端左角": proj(-0.7625, 0.76, -1.37),
        "远端右角": proj( 0.7625, 0.76, -1.37),
        "网左端":   proj(-0.915,  0.9125, 0),
        "网右端":   proj( 0.915,  0.9125, 0),
      };
      /* 击球平面 HIT_Z=1.30 处的横向可见半宽（米）：扫描世界 x，
       * 找屏幕 x 落在 [0,W] 的边界 —— 这是「能不能瞄准落点」的量化指标 */
      let halfW = null;
      try {
        let lo = null, hi = null;
        for (let x = -5; x <= 5; x += 0.002) {
          const s = proj(x, 0.90, 1.30);
          if (s.x >= 0 && s.x <= W) { if (lo === null) lo = x; hi = x; }
        }
        if (lo !== null) halfW = Math.min(Math.abs(lo), Math.abs(hi));
      } catch (e) {}

      const inS = p => p.x >= 0 && p.x <= W && p.y >= 0 && p.y <= H;
      return {
        W, H, aspect: +(W / H).toFixed(3),
        field: Object.fromEntries(Object.entries(field).map(
          ([k, p]) => [k, { x: Math.round(p.x), y: Math.round(p.y), in: inS(p) }])),
        halfW: halfW === null ? null : +halfW.toFixed(2),
        hintWasOn: true,
      };
    });

    await page.screenshot({ path: path.join(OUT, "40_view_" + c.n + ".png") });
    rows.push({ ...c, ...m });
    await ctx.close();
  }

  await browser.close();

  const pad = (s, n) => { s = String(s); let w = 0; for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
                          return s + " ".repeat(Math.max(0, n - w)); };
  console.log("\n同一场景、同一机位下的 3D 视野实测（撤掉门控遮罩后量）\n");
  console.log(pad("视口", 22) + pad("宽高比", 8) + pad("HIT_Z 可见半宽", 15) +
              pad("远端角入画", 12) + pad("网端入画", 11) + "场地判定");
  console.log("-".repeat(88));
  for (const r of rows) {
    const far = [r.field["远端左角"], r.field["远端右角"]];
    const net = [r.field["网左端"], r.field["网右端"]];
    const farOk = far.every(p => p.in), netOk = net.every(p => p.in);
    console.log(pad(r.n, 22) + pad(r.aspect, 8) +
      pad(r.halfW === null ? "?" : r.halfW + " m", 15) +
      pad(farOk ? "是" : "否", 12) + pad(netOk ? "是" : "否", 11) +
      (farOk && netOk ? "完整可见" : "有裁切"));
  }

  /* 结论：把「被拦的手机横屏」与「放行的平板横屏」直接比 */
  const phone = rows.filter(r => r.n.includes("手机横屏"));
  const tab = rows.filter(r => r.n.includes("平板横屏") && r.aspect < 2);
  const pHalf = Math.min(...phone.map(r => r.halfW ?? 0));
  const tHalf = Math.min(...tab.map(r => r.halfW ?? 0));
  console.log("\n【结论】");
  console.log("  被拦的手机横屏：HIT_Z 可见半宽最小 " + pHalf + " m");
  console.log("  放行的平板横屏：HIT_Z 可见半宽最小 " + tHalf + " m");
  console.log("  → 手机横屏的水平视野 " + (pHalf >= tHalf ? "≥" : "＜") + " 平板横屏" +
              (pHalf >= tHalf ? "：旧门槛拦错了（宽高比才是关键变量）" : "：门槛有依据，需保留"));
  const vert = rows.find(r => r.n.includes("竖屏"));
  if (vert) console.log("  竖屏参照：" + vert.aspect + "  可见半宽 " + vert.halfW +
                        " m（" + (vert.halfW !== null && vert.halfW < 0.8 ? "确实不足，应拦" : "需复核") + "）");
  console.log("\n  对比图已存 _shots/40_view_*.png，可肉眼复核。\n");
})();
