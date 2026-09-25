// 抓「结算中」过渡动画的几帧，供人工复核用户需求⑥（失败→统计之间不再像卡住）。
// 运行： NODE_PATH=<workspace>/node_modules node _settle_shot.js
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
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(1000);

  /* 直接调 showSettle 把过渡动画放出来，抓三个不同时刻。
   * 采样点按窗口长度等比给：窗口现在是 1.25s（原 2.5s），
   * 故取 0.08s / 0.32s / 0.80s（约 6% / 26% / 64%），
   * 对应「球在低处 / 弹到高处影子最小 / 进度条推进过半」三个可判读状态。
   * 注意最后一个必须留在窗口内，否则抓到的是已被结束页接管的画面。 */
  const info = await page.evaluate(() => {
    document.getElementById("startScreen").style.display = "none";
    showSettle();
    const el = document.getElementById("settle");
    return { on: el.classList.contains("on"),
             display: getComputedStyle(el).display,
             wait: getComputedStyle(el).getPropertyValue("--settle-wait").trim(),
             ball: !!el.querySelector(".ball"),
             bar: !!el.querySelector(".bar"),
             text: (el.querySelector(".txt") || {}).textContent || "" };
  });
  console.log("结算层: " + JSON.stringify(info));

  for (const [ms, name] of [[80, "15_settle_a"], [240, "15_settle_b"], [480, "15_settle_c"]]) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: OUT + "\\" + name + ".png" });
  }
  console.log(errs.length ? "页面错误: " + errs.join(" | ") : "无页面错误");
  await browser.close();
  process.exit(errs.length ? 1 : 0);
})();
