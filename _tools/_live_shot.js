/* 线上实景抓图：确认右上角 GitHub 入口在真实部署中可见可用 */
const { chromium } = require("playwright");
const path = require("path");
/* 本脚本位于 _tools/：产物写到项目根的 _shots/，与其它脚本保持一致 */
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "_shots");
const URL = "https://spin-pingpong.app.workbuddy.host/";

(async () => {
  const b = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--no-sandbox"],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on("pageerror", e => errs.push("pageerror: " + e.message));
  await p.goto(URL, { waitUntil: "load", timeout: 60000 });
  await p.waitForTimeout(2500);

  const info = await p.evaluate(() => {
    const tl = document.getElementById("topLinks");
    const gh = document.getElementById("ghLink");
    const hud = document.getElementById("hud");
    return {
      href: gh ? gh.href : null,
      outsideHud: !!tl && !!hud && !hud.contains(tl),
      zIndex: tl ? getComputedStyle(tl).zIndex : null,
      modeCards: document.querySelectorAll(".modeCard").length,
    };
  });
  console.log("线上状态:", JSON.stringify(info, null, 2));

  await p.screenshot({ path: path.join(OUT, "30_live_full.png") });
  await p.screenshot({ path: path.join(OUT, "33_start_final.png") });   // 供 README 用：线上最终版开始页
  await p.screenshot({ path: path.join(OUT, "31_live_corner.png"),
                       clip: { x: 1230, y: 0, width: 210, height: 200 } });
  await p.hover("#ghLink");
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, "32_live_hover.png"),
                       clip: { x: 1200, y: 0, width: 240, height: 200 } });

  console.log("页面错误:", errs.length ? errs : "无");
  await b.close();
})();
