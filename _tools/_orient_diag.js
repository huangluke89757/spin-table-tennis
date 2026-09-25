/* 方向门控诊断：找出「粗指针 + 已横屏」却被拦截的设备组合。
 *
 * 为什么需要这个脚本：现有回归里，真浏览器场景只覆盖了「平板横屏 / 手机竖屏 / 桌面」，
 * 「手机横屏」这个格子从来没被测过 —— 于是 min-width:768px 这条门槛把一大批手机
 * 横屏挡在外面，没有任何断言能发现。
 *
 * 用法：node _tools/_orient_diag.js [url]
 */
const { chromium, devices } = require("playwright");

const URL = process.argv[2] || "https://spin-pingpong.app.workbuddy.host/";

const CASES = [
  "iPhone SE", "iPhone 8", "iPhone 12", "iPhone 13", "iPhone 13 Pro Max", "iPhone 14 Pro Max",
  "Pixel 5", "Galaxy S9+", "iPad (gen 7)", "iPad Pro 11",
  "iPhone SE landscape", "iPhone 8 landscape", "iPhone 12 landscape", "iPhone 13 landscape",
  "iPhone 13 Pro Max landscape", "iPhone 14 Pro Max landscape",
  "Pixel 5 landscape", "Galaxy S9+ landscape",
  "iPad (gen 7) landscape", "iPad Pro 11 landscape",
];

/* 中文按 2 列宽对齐，避免表格错位 */
function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const c of s) w += /[\u4e00-\u9fa5\uff00-\uffef\u3000-\u303f]/.test(c) ? 2 : 1;
  return s + " ".repeat(Math.max(1, n - w));
}

(async () => {
  const browser = await chromium.launch();
  console.log("方向门控诊断 @ " + URL + "\n");
  console.log(pad("设备", 30) + pad("CSS视口", 13) + pad("aspect", 8) + pad("coarse", 8) +
              pad("≥768", 7) + pad("land", 7) + pad("isSupported", 13) + "引导层");
  console.log("-".repeat(100));

  const blocked = [];
  for (const name of CASES) {
    const d = devices[name];
    if (!d) { console.log(pad(name, 30) + "（Playwright 无此描述符，跳过）"); continue; }
    let r;
    try {
      const ctx = await browser.newContext({ ...d });
      const page = await ctx.newPage();
      await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
      await page.waitForTimeout(900);
      r = await page.evaluate(() => {
        const mm = q => !!(window.matchMedia && window.matchMedia(q).matches);
        const hint = document.getElementById("rotateHint");
        return {
          iw: window.innerWidth, ih: window.innerHeight,
          coarse: mm("(pointer: coarse)"),
          wide: mm("(min-width: 768px)"),
          land: mm("(orientation: landscape)"),
          sup: typeof isSupported === "function" ? isSupported() : "（无此函数）",
          hintOn: hint ? hint.classList.contains("on") : null,
        };
      });
      await ctx.close();
    } catch (e) {
      console.log(pad(name, 30) + "（失败：" + String(e.message).slice(0, 40) + "）");
      continue;
    }
    const visLand = r.iw > r.ih;                      // 视觉上是否横屏（实测尺寸，不信任媒体查询）
    if (visLand && r.coarse && r.sup !== true) blocked.push(name + "  " + r.iw + "×" + r.ih);
    console.log(pad(name, 30) + pad(r.iw + "×" + r.ih, 13) + pad((r.iw / r.ih).toFixed(2), 8) +
      pad(r.coarse, 8) + pad(r.wide, 7) + pad(r.land, 7) + pad(String(r.sup), 13) +
      (r.hintOn ? "显示·拦住" : "隐藏·放行"));
  }
  await browser.close();

  console.log("\n【结论】");
  if (blocked.length) {
    console.log("「已横屏（实测宽＞高）却被拦」的组合 " + blocked.length + " 个 —— 与用户报告的现象一致：");
    blocked.forEach(b => console.log("  · " + b));
  } else {
    console.log("本轮未复现「已横屏却被拦」的组合。");
  }
})();
