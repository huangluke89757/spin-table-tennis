/* 右上角外链图标 + hover tooltip 的局部放大验证 */
const { chromium } = require("playwright");
const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;


const OUT = path.join(ROOT, "_shots");
const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

(async () => {
  const b = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--no-sandbox"],
  });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await p.goto(URL, { waitUntil: "load" });
  await p.waitForTimeout(900);

  const CLIP = { x: 1230, y: 0, width: 210, height: 200 };
  await p.screenshot({ path: path.join(OUT, "24_links_idle.png"), clip: CLIP });

  // hover GitHub → tooltip
  await p.hover("#ghLink");
  await p.waitForTimeout(350);
  const tip = await p.evaluate(() => {
    const t = document.querySelector("#ghLink .tt");
    const s = getComputedStyle(t);
    const r = t.getBoundingClientRect();
    return { opacity: s.opacity, text: t.textContent, box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
  });
  console.log("tooltip:", JSON.stringify(tip));
  await p.screenshot({ path: path.join(OUT, "25_links_hover.png"), clip: CLIP });

  await b.close();
})();
