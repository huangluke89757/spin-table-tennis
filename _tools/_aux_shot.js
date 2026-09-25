/* 辅助面板布局验证（真浏览器）
 *
 * 为什么必须用真浏览器：重叠是「盒子在屏幕上的位置」问题，Node 桩里
 * getBoundingClientRect 是写死的常量，量不出任何东西。
 *
 * 判据（用户明确要求「避免重叠」+「左下拍面栏一起收放」）：
 *   1. 右下辅助面板内部各块（操作说明 / 配置栏）互不相交
 *   2. 面板整体不与画面其它 HUD（拍面栏、Logo、顶部三栏）相交
 *   3. 展开与收起两种状态都要满足，且收起后开关仍可见可点
 *   4. 收起时左下拍面栏（#hudFace）必须一起隐藏 —— 一个开关统管
 *   5. 多种窗口尺寸都要满足（重叠是尺寸相关的）
 *
 * 运行： NODE_PATH=<playwright node_modules> node _aux_shot.js
 */
const { chromium } = require("playwright");
const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;



const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");
const OUT = path.join(ROOT, "_shots");
const SIZES = [[1440, 900], [1280, 720], [1920, 1080], [1100, 660]];

let bad = 0;
function add(ok, label, detail) {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + label + (detail ? "　→ " + detail : ""));
  if (!ok) bad++;
}

/* 在页面里量：返回各元素的盒子 + 两两相交结果 */
const MEASURE = () => {
  const g = id => {
    const e = document.getElementById(id);
    if (!e) return null;
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    return { id: id, x: r.x, y: r.y, w: r.width, h: r.height,
             disp: cs.display, vis: cs.visibility, op: +cs.opacity,
             shown: cs.display !== "none" && cs.visibility !== "hidden" && +cs.opacity > 0.01 };
  };
  const inter = (a, b) => {
    const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return Math.round(x * y);
  };
  /* 右下辅助区里「并列」的两块内容：操作说明 + 配置栏。
   * 开关按钮是 #hudCfg 的子元素（同处一个面板，是设计上要求的"配置类归到一起"），
   * 父子嵌套必然相交，所以它不参与两两求交，单独做「是否被遮挡」的检查。 */
  const aux = ["hudKeys", "hudCfg"].map(g).filter(Boolean);
  const toggle = g("btnUiToggle");
  /* 需要检查是否被辅助区压到的邻居：左下拍面栏、Logo、顶部三栏 */
  const other = ["hudFace", "hudLogo", "hudScore", "hudBall", "hudLevel"].map(g).filter(Boolean);

  const pairs = [];
  for (let i = 0; i < aux.length; i++)
    for (let j = i + 1; j < aux.length; j++)
      if (aux[i].shown && aux[j].shown)
        pairs.push({ a: aux[i].id, b: aux[j].id, px: inter(aux[i], aux[j]) });

  /* 辅助区整体盒（用于与左侧邻居做交叉检测），含开关 */
  const allAux = aux.concat(toggle ? [toggle] : []);
  const shownAux = allAux.filter(a => a.shown);
  const box = shownAux.length ? {
    x: Math.min(...shownAux.map(a => a.x)), y: Math.min(...shownAux.map(a => a.y)),
    w: Math.max(...shownAux.map(a => a.x + a.w)) - Math.min(...shownAux.map(a => a.x)),
    h: Math.max(...shownAux.map(a => a.y + a.h)) - Math.min(...shownAux.map(a => a.y))
  } : null;

  const cross = [];
  if (box) other.forEach(o => {
    if (!o.shown) return;
    // 顶部三栏离得很远，只有同侧底部才可能撞
    if (o.y > 400) cross.push({ a: o.id, b: "hudAux", px: inter(o, box) });
  });

  // 视口溢出（含开关）
  const over = shownAux.filter(a =>
    a.x < 0 || a.y < 0 || a.x + a.w > innerWidth + 0.5 || a.y + a.h > innerHeight + 0.5)
    .map(a => a.id + "(" + Math.round(a.x) + "," + Math.round(a.y) + "," + Math.round(a.w) + "x" + Math.round(a.h) + ")");

  return { aux: allAux.map(a => ({ id: a.id, shown: a.shown, y: Math.round(a.y), h: Math.round(a.h), disp: a.disp })),
           pairs: pairs, cross: cross, over: over,
           face: g("hudFace"),
           vw: innerWidth, vh: innerHeight };
};

(async () => {
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

  for (const [w, h] of SIZES) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    const errs = [];
    p.on("pageerror", e => errs.push(e.message));
    await p.goto(URL, { waitUntil: "load" });
    await p.waitForTimeout(900);

    /* 底部辅助面板是「对局中」的 HUD。开始页浮层 z-index 更高、本来就该盖住它，
     * 所以先进入对局态（隐藏所有浮层）再量，否则量到的是浮层，不是真实布局。 */
    await p.evaluate(() => {
      ["startScreen", "pauseScreen", "endScreen", "posterScreen", "errScreen"]
        .forEach(id => document.getElementById(id).classList.add("hidden"));
    });
    await p.waitForTimeout(150);

    // ---- 展开态 ----
    const open = await p.evaluate(MEASURE);
    console.log("\n[" + w + "×" + h + "] 展开态");
    add(open.pairs.every(x => x.px === 0), "右下辅助面板内部各块互不重叠",
        open.pairs.length ? open.pairs.map(x => x.a + "/" + x.b + "=" + x.px + "px²").join("　") : "（仅两块同时显示）");
    add(open.cross.every(x => x.px === 0), "辅助面板不与左下拍面栏 / Logo 重叠",
        open.cross.length ? open.cross.map(x => x.a + "/" + x.b + "=" + x.px + "px²").join("　") : "无同侧冲突");
    add(open.over.length === 0, "辅助面板完全在视口内", open.over.length ? open.over.join(" ") : "ok");
    add(open.face && open.face.shown, "展开态左下拍面栏可见", open.face ? open.face.disp : "未找到");
    add(errs.length === 0, "无页面错误", errs.slice(0, 2).join(" | ") || "无");

    // ---- 收起态 ----
    await p.evaluate(() => document.getElementById("btnUiToggle").click());
    await p.waitForTimeout(350);
    const shut = await p.evaluate(MEASURE);
    const keys = shut.aux.find(a => a.id === "hudKeys");
    const cfg = shut.aux.find(a => a.id === "hudCfg");
    const tgl = shut.aux.find(a => a.id === "btnUiToggle");
    console.log("[" + w + "×" + h + "] 收起态");
    add(!keys.shown, "操作说明已隐藏", "hudKeys=" + keys.disp);
    add(cfg.shown && cfg.disp !== "none", "配置栏本体仍在（开关住在里面，不能整个藏）", "hudCfg=" + cfg.disp);
    add(!shut.face.shown, "左下拍面栏随同一个开关一起隐藏（用户核心诉求）", "hudFace=" + shut.face.disp);
    add(tgl.shown, "开关按钮仍在（收起了就点不开是致命 bug）", "display=" + tgl.disp);
    add(shut.over.length === 0, "收起后按钮仍在视口内", shut.over.join(" ") || "ok");

    // 点得动吗
    const clicked = await p.evaluate(() => {
      const r = document.getElementById("btnUiToggle").getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!(el && (el.id === "btnUiToggle" || el.closest("#btnUiToggle")));
    });
    add(clicked, "开关按钮未被其它元素遮挡（命中测试通过）", clicked ? "elementFromPoint 命中" : "被遮挡");

    // ---- 再展开，确认可逆 ----
    await p.evaluate(() => document.getElementById("btnUiToggle").click());
    await p.waitForTimeout(300);
    const back = await p.evaluate(() => ({
      collapsed: document.getElementById("hud").classList.contains("ui-collapsed"),
      keysShown: getComputedStyle(document.getElementById("hudKeys")).display !== "none",
      faceShown: getComputedStyle(document.getElementById("hudFace")).display !== "none",
      txt: document.getElementById("uiToggleTxt").textContent
    }));
    add(!back.collapsed && back.keysShown && back.faceShown, "再次点击可恢复展开（拍面栏 + 说明一起回来）",
        "ui-collapsed=" + back.collapsed + " 说明=" + back.keysShown + " 拍面栏=" + back.faceShown +
        " 按钮文案=「" + back.txt + "」");

    // ---- 结束页开关 ----
    const endOk = await p.evaluate(() => {
      document.getElementById("endScreen").classList.remove("hidden");
      const row = document.getElementById("endUiRow");
      const r = row.getBoundingClientRect();
      const btn = document.getElementById("btnUiToggle2");
      const br = btn.getBoundingClientRect();
      return { rowVisible: r.height > 0, btnText: btn.textContent,
               btnInside: br.y >= r.y - 1 && br.y + br.height <= r.y + r.height + 1 };
    });
    add(endOk.rowVisible && endOk.btnInside, "结束页有独立开关，且按钮在行内正常排布",
        "文案=「" + endOk.btnText + "」");

    // ---- 结束页整体不重叠 ----
    const endOverlap = await p.evaluate(() => {
      const ids = ["endBrand", "newBadge", "finalStat", "endReason", "endUiRow", "endTip"];
      const boxes = ids.map(id => {
        const e = document.getElementById(id);
        const r = e.getBoundingClientRect();
        return { id, x: r.x, y: r.y, w: r.width, h: r.height, shown: r.height > 0 };
      }).filter(o => o.shown);
      const out = [];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], c = boxes[j];
          const ix = Math.max(0, Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x));
          const iy = Math.max(0, Math.min(a.y + a.h, c.y + c.h) - Math.max(a.y, c.y));
          if (ix * iy > 1) out.push(a.id + "/" + c.id + "=" + Math.round(ix * iy) + "px²");
        }
      return out;
    });
    add(endOverlap.length === 0, "结束页各块互不重叠", endOverlap.join("　") || "ok");

    if (w === 1440) {
      // 展开态：结束页已在上一步打开，先关掉再截「纯对局 + 展开面板」
      await p.evaluate(() => document.getElementById("endScreen").classList.add("hidden"));
      await p.waitForTimeout(200);
      await p.screenshot({ path: OUT + "\\12_aux_open.png" });
      await p.evaluate(() => document.getElementById("btnUiToggle").click());
      await p.waitForTimeout(300);
      await p.screenshot({ path: OUT + "\\13_aux_closed.png" });
      // 结束页整体
      await p.evaluate(() => document.getElementById("endScreen").classList.remove("hidden"));
      await p.waitForTimeout(200);
      await p.screenshot({ path: OUT + "\\14_end_ui.png" });
    }
    await p.close();
  }

  console.log("\n" + (bad === 0 ? "布局验证全部通过" : "存在 " + bad + " 项失败"));
  await b.close();
  process.exit(bad === 0 ? 0 : 1);
})();
