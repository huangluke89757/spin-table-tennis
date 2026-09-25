/* ============================================================================
 * 门控在「旋转」场景下的行为诊断
 *
 * 要回答的问题：玩家从竖屏转到横屏后，引导层能不能自动消失？
 *
 * 为什么怀疑这里：iOS Safari 在 orientationchange 触发的那一刻，innerWidth/
 * innerHeight 可能仍是旋转前的旧值（已知行为）。旧代码 isSupported() 用
 * `min-width:768px` 判宽度 —— 竖屏 iPhone 的 innerWidth = 390 < 768，
 * 旋转瞬间读到 390 就判「不支持」，而若之后没有再次触发 resize，引导层
 * 就永久留在屏幕上：玩家明明已横屏，却一直看到「请横置设备」。
 *
 * 本脚本记录每次视口变化后的「实际尺寸 / 判定结果 / 引导层状态」，
 * 用来看判定是否跟随尺寸变化。
 * ========================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

const STEPS = [
  { n: "① 初始：竖屏 390×844",        w: 390,  h: 844  },
  { n: "② 旋转到横屏 844×390",        w: 844,  h: 390  },
  { n: "③ 再转回竖屏 390×844",        w: 390,  h: 844  },
  { n: "④ 再转到横屏 844×390（复现）", w: 844,  h: 390  },
  { n: "⑤ 切到窄手机横屏 568×320",     w: 568,  h: 320  },
];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(1700);

  const probe = () => page.evaluate(() => ({
    iw: window.innerWidth, ih: window.innerHeight,
    vv: window.visualViewport ? Math.round(window.visualViewport.width) + "×" +
                                Math.round(window.visualViewport.height) : "—",
    aspect: +(window.innerWidth / window.innerHeight).toFixed(3),
    coarse: window.matchMedia("(pointer: coarse)").matches,
    /* 旧判据的三个因子，拆开看是哪一项把它拦下的 */
    qCoarse: window.matchMedia("(pointer: coarse)").matches,
    qWide: window.matchMedia("(min-width: 768px)").matches,
    qLand: window.matchMedia("(orientation: landscape)").matches,
    supported: typeof isSupported === "function" ? isSupported() : null,
    hintOn: document.getElementById("rotateHint").classList.contains("on"),
  }));

  const pad = (s, n) => { s = String(s); let w = 0; for (const ch of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1;
                          return s + " ".repeat(Math.max(0, n - w)); };
  console.log("\n门控在旋转场景下的行为 @" + URL + "\n");
  console.log(pad("步骤", 26) + pad("innerWH", 13) + pad("宽高比", 9) + pad("coarse", 8) +
              pad("≥768", 7) + pad("land", 7) + pad("判定", 7) + "引导层");
  console.log("-".repeat(96));

  const rows = [];
  for (const s of STEPS) {
    await page.setViewportSize({ width: s.w, height: s.h });
    await page.waitForTimeout(420);            // 等事件与布局稳定
    const r = await probe();
    rows.push({ ...s, ...r });
    console.log(pad(s.n, 26) + pad(r.iw + "×" + r.ih, 13) + pad(r.aspect, 9) +
                pad(r.coarse ? "是" : "否", 8) + pad(r.qWide ? "是" : "否", 7) +
                pad(r.qLand ? "是" : "否", 7) +
                pad(r.supported ? "放行" : "拦截", 7) + (r.hintOn ? "显示" : "隐藏"));
  }

  await browser.close();

  /* ---- 结论：旋转到横屏后是否恢复 ---- */
  console.log("\n【诊断结论】");
  const land = rows.filter(r => r.qLand);
  const stuck = land.filter(r => r.hintOn);
  for (const r of land) {
    console.log("  " + r.n + "  " + r.iw + "×" + r.ih + "  宽高比 " + r.aspect +
                "  → " + (r.hintOn ? "❌ 仍被拦（横屏了却进不去）" : "✅ 放行"));
  }
  console.log("\n  已横屏但仍被拦的步骤：" + stuck.length + " 个" +
              (stuck.length ? " ← 与用户报告一致" : ""));
  if (stuck.length) {
    for (const r of stuck) {
      const why = !r.qWide ? "「宽 < 768px」" : "（非宽度原因，需另查）";
      console.log("    · " + r.n + "  拦因 " + why);
    }
  }
  if (errs.length) { console.log("\n  页面错误 " + errs.length + " 条"); errs.slice(0, 4).forEach(e => console.log("    " + e)); }
  console.log("");
})();
