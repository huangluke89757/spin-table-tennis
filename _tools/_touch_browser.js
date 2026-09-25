/* 真浏览器触摸链路验证（Task 10 · 真机路径）
 *
 * 与 _touch.js 的分工：
 *   _touch.js         —— 逻辑与契约（快、无浏览器依赖，可在任何环境跑）
 *   _touch_browser.js —— 浏览器真实触摸行为（慢、需 Chromium + SwiftShader）
 *
 * 为什么这一关不能省：有些事只有真浏览器说了算——
 *   ① touch-action 到底有没有生效？触摸序列会不会被系统手势掐成 pointercancel？
 *   ② 改造后的双区手势（左调拍面 / 右击球）在真实 PointerEvent 下能不能把球打回去？
 *   ③ 竖屏时引导层是不是真的盖住了对局（而不是只是加了个类）？
 * Node 桩里这些都是"设了属性"，真浏览器里才是"真的没被掐断"。
 *
 * 关键手法：**不注入自己的点击处理逻辑**，直接派发 PointerEvent 让 game.js 自己的
 * pointerdown/move/up 去接。早期原型（probe v2/v3）自己桥接 mouse 事件，
 * 结果测的是桥接层而不是游戏本身，白跑两轮。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node _touch_browser.js
 */
const { chromium } = require("playwright");

const GAME = "D:/卢克先生WorkBuddy专区/2026-09-23-15-10-03/first-person-pingpong";
const URL = "file:///" + GAME + "/index.html";
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--ignore-gpu-blocklist", "--enable-webgl"];

const FAILS = [];
let PASS_N = 0;
function ok(label, cond, detail) {
  if (cond) { PASS_N++; console.log("  PASS  " + label + (detail ? "　→ " + detail : "")); }
  else { FAILS.push(label); console.log("  FAIL  " + label + (detail ? "　→ " + detail : "")); }
}

/* 页面内注入：只装探针，不接管输入。
 * __probe 记录事件序列；__simGesture 用真实 PointerEvent 模拟一次完整挥拍。 */
const INSTALL = () => {
  if (window.__probeInstalled) return "already";
  window.__probeInstalled = true;
  const cv = document.getElementById("cv");
  window.__ev = [];
  window.__cancels = 0;
  ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(t =>
    window.addEventListener(t, e => {
      window.__ev.push(t + "@" + Math.round(e.clientX) + "," + Math.round(e.clientY));
      if (t === "pointercancel") window.__cancels++;
    }, true));

  /* 页面内手势：与真手指同构（pointerType=touch），节奏靠 rAF，
   * 在理想击球点（G.idealSet）附近松手。 */
  window.__simGesture = (o) => new Promise(res => {
    const c = document.getElementById("cv");
    const id = 7;
    const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {
      pointerId: id, clientX: x, clientY: y, bubbles: true,
      pointerType: "touch", isPrimary: true, button: 0, buttons: 1 }));
    fire("pointerdown", o.x, o.y);
    let step = 0;
    const t0 = performance.now();
    const tick = () => {
      step++;
      fire("pointermove", o.x + (o.dx || 0) * step / o.steps, o.y + (o.dy || 0) * step / o.steps);
      if (step < o.steps) return requestAnimationFrame(tick);
      const wait = () => {
        if (G.idealSet || G.phase !== "incoming")
          { fire("pointerup", o.x + (o.dx || 0), o.y + (o.dy || 0));
            return res({ ok: true, atIdeal: !!G.idealSet }); }
        if (performance.now() - t0 > 2500) return res({ ok: false, reason: "timeout", phase: G.phase });
        requestAnimationFrame(wait);
      };
      wait();
    };
    requestAnimationFrame(tick);
  });
  return "ok";
};

(async () => {
  const browser = await chromium.launch({ args: ARGS });
  const pageErrs = [];

  async function open(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2,
                                           isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    page.on("pageerror", e => pageErrs.push(e.message));
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    return { ctx, page };
  }
  /* 等到一个「来球在飞、还没打」的干净状态 */
  async function fresh(page, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await page.evaluate(() => ({ p: G.phase, i: G.idealSet }));
      if (s.p === "incoming" && !s.i) return true;
      if (s.p === "over") { await page.evaluate(() => restart()); await page.waitForTimeout(320); }
      await page.waitForTimeout(10);
    }
    return false;
  }

  /* ============ 场景 1：平板横屏（900×420）触摸手势完整回球 ============ */
  console.log("=== 场景 1 · 平板横屏，触摸手势完整回球 ===");
  {
    const { ctx, page } = await open(900, 420);
    await page.click("#startBtn");
    await page.waitForTimeout(150);
    await page.evaluate(INSTALL);

    /* 1a. touch-action 生效：CDP 真实触摸序列不该出现 pointercancel */
    const cdp = await ctx.newCDPSession(page);
    await page.evaluate(() => { window.__ev.length = 0; window.__cancels = 0; });
    await page.evaluate(() => { G.paddleAngle = 0; });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 620, y: 200, id: 1 }] });
    await page.waitForTimeout(40);
    for (let i = 1; i <= 4; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 620, y: 200 - i * 30, id: 1 }] });
      await page.waitForTimeout(28);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(180);
    const cdpR = await page.evaluate(() => ({
      ev: window.__ev.slice(), cancels: window.__cancels,
      cvTa: getComputedStyle(document.getElementById("cv")).touchAction,
      bodyTa: getComputedStyle(document.body).touchAction,
      hintOn: document.getElementById("rotateHint").classList.contains("on")
    }));
    const hasDown = cdpR.ev.some(e => e.startsWith("pointerdown"));
    const hasUp = cdpR.ev.some(e => e.startsWith("pointerup"));
    ok("真实触摸序列收到 pointerdown", hasDown, cdpR.ev.slice(0, 3).join(" "));
    ok("真实触摸序列收到 pointerup（未被系统手势截断）", hasUp);
    ok("全程零 pointercancel（touch-action 真的生效了）", cdpR.cancels === 0,
       "cancels=" + cdpR.cancels + " 事件数=" + cdpR.ev.length);
    ok("计算样式确认 canvas touch-action=none", cdpR.cvTa === "none", "cv=" + cdpR.cvTa);
    ok("计算样式确认 body touch-action=none", cdpR.bodyTa === "none", "body=" + cdpR.bodyTa);
    ok("平板横屏 → 引导层不显示（可正常游玩）", cdpR.hintOn === false);

    /* 1b. 双区手势真的能把球打回去
     * 两条稳健性设计，都是踩坑加的：
     * ① 断言必须测「真被识别为击球」（hitDone 置位过）。原来写的是 attempts > 0，
     *    而循环至少进一次 → 恒真，等于没测（这类假断言比没有更危险）。
     * ② headless SwiftShader 与别的浏览器实例抢 GPU 时会掉帧，手势的 rAF 节奏被拉长，
     *    整轮 0 命中。这是环境抖动不是功能坏（单独跑稳定 8/8），所以重试一轮再判，
     *    避免并行跑回归时出现假红。 */
    let rallies = 0, hits = 0, attempts = 0;
    for (let round = 0; round < 2 && hits === 0; round++) {
      if (round) { await page.evaluate(() => restart()); await page.waitForTimeout(420); }
      for (let k = 0; k < 8; k++) {
        if (!(await fresh(page, 4000))) break;
        await page.evaluate(() => { G.paddleAngle = correctTiltFor(G.spin); });
        const before = await page.evaluate(() => G.rally);
        await page.evaluate(() => window.__simGesture({ x: 620, y: 320, dx: 0, dy: -150, steps: 6 }));
        await page.waitForTimeout(280);
        const after = await page.evaluate(() => ({ rally: G.rally, hitDone: G.hitDone }));
        attempts++;
        if (after.hitDone) hits++;
        if (after.rally > before) rallies++;
      }
    }
    ok("右区触摸挥拍被识别为有效击球（hitDone 真的置位过）",
       hits > 0, "识别 " + hits + "/" + attempts + " 次");
    ok("触摸手势能真的得分（连续回球增长）", rallies > 0,
       rallies + "/" + attempts + " 次成功回球得分");

    /* 1c. 左区手势调拍面
     * 必须先关辅助：练习模式默认 assist=true，此时拍面由每帧自动跟随接管、
     * 左区手动被**刻意忽略**（设计如此，否则玩家的手会跟自动角度打架）。
     * 左区手动只在辅助关（挑战模式）下生效——这里显式关辅助来验那条路径。 */
    await page.evaluate(() => { restart(); G.assist = false; });
    await page.waitForTimeout(300);
    const face = await page.evaluate(() => {
      window.__ev.length = 0;
      const before = G.paddleAngle;
      const c = document.getElementById("cv");
      const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {
        pointerId: 11, clientX: x, clientY: y, bubbles: true,
        pointerType: "touch", isPrimary: true, button: 0, buttons: 1 }));
      fire("pointerdown", 80, 300);            // 左 45% 区（900 宽 → <405）
      fire("pointermove", 80, 160);            // 上拖 140px
      const mid = G.paddleAngle;
      fire("pointerup", 80, 160);
      return { before, mid, assist: G.assist };
    });
    ok("左区手势改拍面（辅助关 + 上拖 → 拍面变亮）", face.mid > 0,
       "拍面 " + face.mid.toFixed(2) + "（assist=" + face.assist + "）");
    ok("左区手势不触发击球（不串扰）", (await page.evaluate(() => G.hitDone)) === false);

    /* 1d. 控制簇真实可见（粗指针 + 横屏） */
    const ctl = await page.evaluate(() => {
      const c = document.getElementById("touchCtl");
      const r = c.getBoundingClientRect();
      return { display: getComputedStyle(c).display, w: Math.round(r.width), h: Math.round(r.height),
               hudTouchOn: document.getElementById("hud").classList.contains("touch-on") };
    });
    ok("平板横屏下控制簇真实渲染（display:flex 且有尺寸）",
       ctl.display === "flex" && ctl.w > 0 && ctl.h > 0,
       "display=" + ctl.display + " " + ctl.w + "×" + ctl.h);

    /* 1e. 控制簇不得压住球的下落走廊
     * 这条是本轮抓到的真 bug：控制簇最初放屏幕底部居中，而第一视角下球飞到身前时
     * 恰好投影在屏幕下方中央 —— 实测与球的可见走廊重叠，玩家会看着球被按钮盖住。
     * 屏幕四角已被 HUD 占满，最终把它挪到右下角。这里用「球的屏幕投影轨迹」
     * 与控制簇包围盒求交，锁死这个约束，避免以后挪回去又退化。 */
    await page.evaluate(() => restart());
    await page.waitForTimeout(360);
    const corridor = await page.evaluate(() => new Promise(res => {
      const samples = [];
      const t0 = Date.now();
      const w = () => {
        if (G.phase === "incoming" && G.ball) {
          const v = new THREE.Vector3(G.ball.x, G.ball.y, G.ball.z).project(CAM);
          samples.push({ z: G.ball.z,
                         x: (v.x * 0.5 + 0.5) * innerWidth,
                         y: (-v.y * 0.5 + 0.5) * innerHeight });
        }
        if ((G.phase !== "incoming" && samples.length > 5) || Date.now() - t0 > 5000) return res(samples);
        requestAnimationFrame(w);
      };
      w();
    }));
    /* 只看「球已进入近身可见区」的样本（z ≤ 1.2）。
     * 别用「全程不出屏」当判据：远球（z > 1.4）本来就在画面外——
     * 第一视角下球从远处飞来是**从屏幕下方进入**画面，近身段才是玩家必须看清的区间。
     * 初版把边界卡在全程，2 个远球样本假红，是断言写错而不是功能问题。 */
    const vis = corridor.filter(s => s.z > 0.3 && s.z <= 1.2);
    const outside = vis.filter(s =>
      s.x < 0 || s.x > 900 || s.y < 0 || s.y > 420).length;
    ok("球在近身可见段（z≤1.2）确实落在画面内（探针有效，不是空集）",
       vis.length >= 3 && outside === 0,
       "样本 " + vis.length + " 个，出屏 " + outside + " 个");
    /* 控制簇在右下角，球的近身走廊在中央偏右下：水平区间必须分离（留 20px 余量）。
     * 这是本轮抓到的真 bug —— 控制簇最初放屏幕底部居中，正好压住球的落点区。 */
    const fy = await page.evaluate(() => {
      const r = document.getElementById("touchCtl").getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    });
    const near = corridor.filter(s => s.z > 0.3 && s.z <= 1.2);
    const cMinX = Math.min(...near.map(s => s.x)), cMaxX = Math.max(...near.map(s => s.x));
    const overlap = !(cMaxX < fy.l - 20 || cMinX > fy.r + 20);
    ok("控制簇不侵入球的下落走廊（水平方向分离 ≥20px）", !overlap,
       "球走廊 x[" + Math.round(cMinX) + "," + Math.round(cMaxX) + "]  控制簇 x[" +
       Math.round(fy.l) + "," + Math.round(fy.r) + "]");

    await ctx.close();
  }

  /* ============ 场景 1b：手机横屏（真机 CSS 视口）→ 必须能进游戏并回球 ============
   * 这个场景是本次修复的核心回归。旧的 isSupported() 用「屏宽 ≥768px」判支持，
   * 而 iPhone 12/13/14 横屏的 CSS 视口是 750×342 —— 宽 750 < 768，于是被判不支持，
   * 玩家旋转到横屏后依然卡在「请横置设备」。判据改为只看宽高比后必须放行。
   * 用 750×342（iPhone 13 横屏真机视口）与 568×320（iPhone SE 横屏，最窄）两个点。 */
  for (const [vw, vh, tag] of [[750, 342, "iPhone 13 横屏"], [568, 320, "iPhone SE 横屏"]]) {
    console.log("\n=== 场景 1b · " + tag + "（" + vw + "×" + vh + "）触摸可玩 ===");
    const { ctx, page } = await open(vw, vh);
    await page.click("#startBtn");
    await page.waitForTimeout(200);

    const g = await page.evaluate(() => {
      const el = id => document.getElementById(id);
      const rc = el("startBtn").getBoundingClientRect();
      return {
        hintOn: el("rotateHint").classList.contains("on"),
        supported: isSupported(),
        aspect: +(innerWidth / innerHeight).toFixed(3),
        btnInView: rc.top >= 0 && rc.bottom <= innerHeight && rc.left >= 0 && rc.right <= innerWidth,
        running: G.running,
        hudTouchOn: el("hud").classList.contains("touch-on"),
        ctlDisplay: getComputedStyle(el("touchCtl")).display,
      };
    });
    ok(tag + " → 门控放行（引导层不遮挡）",
       g.hintOn === false && g.supported === true, "aspect=" + g.aspect + " supported=" + g.supported);
    ok(tag + " → 开始按钮在视口内（能真的点到）", g.btnInView === true);
    ok(tag + " → 对局已启动", g.running === true);
    ok(tag + " → 触屏控制簇出现（有替代键盘的操作入口）",
       g.hudTouchOn === true && g.ctlDisplay === "flex", "display=" + g.ctlDisplay);

    /* 真触摸能否回球 —— 与场景 1 同法，避免只验「门开了」却没验「能玩」 */
    await page.evaluate(INSTALL);
    let hits = 0, tries = 0;
    for (let k = 0; k < 6; k++) {
      if (!(await fresh(page, 4000))) break;
      await page.evaluate(() => { G.paddleAngle = correctTiltFor(G.spin); });
      await page.evaluate(() => window.__simGesture({ x: 620, y: 320, dx: 0, dy: -150, steps: 6 }));
      await page.waitForTimeout(260);
      const st = await page.evaluate(() => G.hitDone);
      tries++;
      if (st) hits++;
    }
    ok(tag + " → 触摸手势被识别为有效击球", hits > 0, "识别 " + hits + "/" + tries + " 次");
    await ctx.close();
  }

  /* ============ 场景 2：手机竖屏（360×780）→ 引导层必须拦住 ============ */
  console.log("\n=== 场景 2 · 手机竖屏，引导层拦截 ===");
  {
    const { ctx, page } = await open(360, 780);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const hint = document.getElementById("rotateHint");
      const hr = hint.getBoundingClientRect();
      const cs = getComputedStyle(hint);
      /* 引导层中心点上是哪个元素？如果是引导层自己，说明真的盖住了对局 */
      const top = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      return { on: hint.classList.contains("on"), display: cs.display, z: cs.zIndex,
               w: Math.round(hr.width), h: Math.round(hr.height),
               coverW: Math.round(hr.width) >= Math.round(innerWidth),
               coverH: Math.round(hr.height) >= Math.round(innerHeight),
               topId: top ? (top.id || top.className || top.tagName) : "null" };
    });
    ok("手机竖屏 → 引导层加 on 类", r.on === true);
    ok("引导层真实渲染（display:flex）", r.display === "flex", "display=" + r.display);
    ok("引导层铺满全屏", r.coverW && r.coverH, r.w + "×" + r.h);
    ok("引导层层级在最上（z-index=30）", r.z === "30", "z=" + r.z);
    ok("屏幕中心命中的是引导层（对局真的不可达）",
       String(r.topId).indexOf("rotate") >= 0 || /rh-/.test(String(r.topId)),
       "命中元素=" + r.topId);
    await ctx.close();
  }

  /* ============ 场景 3：桌面（1280×800，细指针）→ 控制簇必须不出现 ============ */
  console.log("\n=== 场景 3 · 桌面，零回归基线 ===");
  {
    const { ctx, page } = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      .then(async c => ({ ctx: c, page: await c.newPage() }));
    await page.goto(URL, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await page.click("#startBtn");
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => ({
      ctlDisplay: getComputedStyle(document.getElementById("touchCtl")).display,
      hudTouchOn: document.getElementById("hud").classList.contains("touch-on"),
      hintOn: document.getElementById("rotateHint").classList.contains("on"),
      keysVisible: getComputedStyle(document.getElementById("hudKeys")).display !== "none",
      running: G.running
    }));
    ok("桌面 → 触屏控制簇隐藏（不出现冗余按钮）", r.ctlDisplay === "none", "display=" + r.ctlDisplay);
    ok("桌面 → #hud 不带 touch-on", r.hudTouchOn === false);
    ok("桌面 → 引导层永不显示", r.hintOn === false);
    /* 2026-09-25 走查改造：辅助面板「一律默认收起」是全局策略，桌面也不例外，
     * 所以这里不再是「说明可见」。但原断言要防的是「桌面被粗指针规则误伤后
     * 再也打不开」—— 那条防线改为：点一下必须能展开。 */
    ok("桌面 → 辅助面板同样默认收起（全局默认，非仅移动端）", r.keysVisible === false,
       "keysVisible=" + r.keysVisible);
    const deskOpen = await page.evaluate(() => {
      document.getElementById("btnUiToggle").click();
      return getComputedStyle(document.getElementById("hudKeys")).display !== "none";
    });
    ok("桌面 → 点开后操作说明可见（开关未被粗指针规则锁死）", deskOpen === true);
    ok("桌面 → 对局正常启动", r.running === true);
    await ctx.close();
  }

  ok("全程无页面 JS 异常", pageErrs.length === 0, pageErrs.slice(0, 2).join(" | "));

  await browser.close();

  console.log("\n共 " + (PASS_N + FAILS.length) + " 项断言，通过 " + PASS_N + " 项");
  if (FAILS.length) {
    console.log("失败：真浏览器触摸链路未全部通过");
    FAILS.forEach(f => console.log("  - " + f));
    process.exit(1);
  }
  console.log("真浏览器触摸链路全部通过");
})().catch(e => {
  console.log("fatal: " + String(e && e.stack || e));
  process.exit(1);
});
