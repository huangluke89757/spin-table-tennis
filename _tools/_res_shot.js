/* 本轮新 UI 验证：外链图标布局 / 模式卡片 / 失败归因 / 历史榜 */
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
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  p.on("pageerror", e => errs.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  await p.goto(URL, { waitUntil: "load" });
  await p.waitForTimeout(900);

  /* 1) 外链图标与既有 HUD 是否重叠 */
  const lay = await p.evaluate(() => {
    const r = id => { const e = document.getElementById(id); return e ? e.getBoundingClientRect() : null; };
    const hit = (a, c) => {
      if (!a || !c) return false;
      const w = Math.min(a.right, c.right) - Math.max(a.left, c.left);
      const h = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      return w > 0 && h > 0;
    };
    const tl = r("topLinks");
    const gh = document.getElementById("ghLink");
    return {
      topLinks: tl ? [Math.round(tl.left), Math.round(tl.top), Math.round(tl.right), Math.round(tl.bottom)] : null,
      与档位重叠: hit(tl, r("hudLevel")),
      与左上读数重叠: hit(tl, r("hudScore")),
      与中间球型重叠: hit(tl, r("hudBall")),
      ghHref: gh ? gh.href : null,
      ghTip: (document.querySelector("#ghLink .tt") || {}).textContent || null,
      siteHref: (document.getElementById("siteLink") || {}).href || null,
      modeCards: document.querySelectorAll(".modeCard").length,
      modeOn: (document.querySelector(".modeCard.on") || {}).id || null,
    };
  });
  console.log("【布局与结构】", JSON.stringify(lay, null, 2));
  await p.screenshot({ path: path.join(OUT, "20_start_modes.png") });

  /* 2) 切到挑战模式 */
  await p.click("#modeChallenge");
  await p.waitForTimeout(250);
  console.log("【切挑战模式】", JSON.stringify(await p.evaluate(() => ({
    cardOn: (document.querySelector(".modeCard.on") || {}).id || null,
    G_mode: G.mode, G_assist: G.assist, fpp_mode: localStorage.getItem("fpp_mode"),
  }))));
  await p.screenshot({ path: path.join(OUT, "21_start_challenge.png") });

  /* 3) H 键在挑战模式必须无效 */
  await p.evaluate(() => { document.getElementById("startBtn").click(); });
  await p.waitForTimeout(200);
  await p.keyboard.press("h");
  await p.waitForTimeout(120);
  console.log("【挑战模式按 H】", JSON.stringify(await p.evaluate(() => ({ assist: G.assist }))));

  /* 4) 造一局挑战模式成绩并结算 */
  const over = await p.evaluate(() => {
    G.mode = "challenge"; G.assist = false;
    G.rally = 7; G.score = 23; G.level = 2; G.goodTotal = 3;
    G.bestAtStart = 12; G.failTotal = 5;
    G.failStats = { "吃旋转": 3, "时机早或晚": 1, "力量与落点": 1 };
    gameOver("吃旋转！上旋球要压拍");
    const hist = JSON.parse(localStorage.getItem("fpp_records") || "{}");
    return {
      endMode: document.getElementById("endMode").textContent,
      endGap: document.getElementById("endGap").textContent,
      failMain: document.getElementById("failMain").textContent,
      fbRows: document.querySelectorAll("#failList .fbRow").length,
      fbTop: (document.querySelector("#failList .fbRow.isTop .fbName") || {}).textContent || null,
      boardTitle: document.getElementById("boardTitle").textContent,
      bdRows: document.querySelectorAll("#boardList .bdRow").length,
      bdCur: document.querySelectorAll("#boardList .bdRow.isCur").length,
      histLen: (hist.history || []).length,
      bestChallenge: (hist.best || {}).challenge,
      levelBest: (hist.level || {})["2"],
    };
  });
  console.log("【结束页 · 挑战模式】", JSON.stringify(over, null, 2));
  await p.screenshot({ path: path.join(OUT, "22_end_challenge.png") });

  /* 5) 练习模式：不列榜、只给引导；辅助提示应恢复为可开 */
  const prac = await p.evaluate(() => {
    setMode("practice");
    G.rally = 3; G.score = 5; G.level = 1; G.goodTotal = 1;
    restart();
    G.rally = 3; G.score = 5; G.level = 1; G.goodTotal = 1; G.bestAtStart = 12;
    G.failTotal = 2; G.failStats = { "没打到球": 2 };
    gameOver("没打到球");
    return {
      endMode: document.getElementById("endMode").textContent,
      endGap: document.getElementById("endGap").textContent,
      boardTitle: document.getElementById("boardTitle").textContent,
      bdRows: document.querySelectorAll("#boardList .bdRow").length,
      emptyNote: !!document.querySelector("#boardList .boardEmpty"),
      histStillChallengeOnly: (JSON.parse(localStorage.getItem("fpp_records") || "{}").history || []).length,
    };
  });
  console.log("【结束页 · 练习模式】", JSON.stringify(prac, null, 2));
  await p.screenshot({ path: path.join(OUT, "23_end_practice.png") });

  /* 6) 容错：localStorage 被写坏时不应崩 */
  const broken = await p.evaluate(() => {
    localStorage.setItem("fpp_records", "{{{ 这不是 JSON");
    const r = loadRecords();
    return { ok: true, best: r.best, hist: r.history.length };
  });
  console.log("【脏数据容错】", JSON.stringify(broken));

  console.log("页面错误:", errs.length ? errs : "无");
  await b.close();
})();
