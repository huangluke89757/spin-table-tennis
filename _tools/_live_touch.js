/* 线上移动端手势端到端验证（Task 11 · 线上复验）
 *
 * 与另两个触摸测试的分工：
 *   _touch.js         —— 本地逻辑与契约（Node 桩，快）
 *   _touch_browser.js —— 本地真浏览器触摸（file://，验行为）
 *   _live_touch.js    —— **线上产物**（https://...，验部署）
 *
 * 为什么必须有这一关：本地 file:// 全绿只证明「源代码对」，证明不了「部署产物对」。
 * CDN 各边缘节点回源时间不一致，完全可能出现「新 index.html + 旧 game.js」这种错配 ——
 * 那时本地测试毫无意义。移动端改造横跨 index.html（CSS / DOM / viewport meta）
 * 与 game.js（量纲 / 门控 / 手势）两层，是错配的高危区，必须实地量。
 *
 * 最硬的一条证据是「线上 measureDrag 真的分两套量纲」：版本戳只能证明
 * `game.js?v=xxx` 变了，证明不了里面的内容变了（脚本 URL 变了也可能被 CDN
 * 拼上旧内容）。直接在线上页面里调这个函数、比对 touch 与 mouse 的阈值，
 * 才是「本次改动真的上了线」不可辩驳的证据。
 *
 * 运行：NODE_PATH=<workspace>/node_modules node _live_touch.js
 */
const { chromium } = require("playwright");

const URL = "https://spin-pingpong.app.workbuddy.host/";
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
              "--ignore-gpu-blocklist", "--enable-webgl"];

const FAILS = [];
let PASS_N = 0;
function ok(label, cond, detail) {
  if (cond) { PASS_N++; console.log("  PASS  " + label + (detail ? "　→ " + detail : "")); }
  else { FAILS.push(label); console.log("  FAIL  " + label + (detail ? "　→ " + detail : "")); }
}

/* 页面内注入：只装探针，不接管输入。
 * 关键手法与 _touch_browser.js 一致 —— 派发真实 PointerEvent 让 game.js 自己的
 * pointerdown/move/up 去接，不自己桥接，否则测的是桥接层而不是游戏本身。 */
const INSTALL = () => {
  if (window.__probeInstalled) return "already";
  window.__probeInstalled = true;
  window.__ev = [];
  window.__cancels = 0;
  ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(t =>
    window.addEventListener(t, e => {
      window.__ev.push(t + "@" + Math.round(e.clientX) + "," + Math.round(e.clientY));
      if (t === "pointercancel") window.__cancels++;
    }, true));

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

  async function open(w, h, touch) {
    const opts = { viewport: { width: w, height: h } };
    if (touch) { opts.isMobile = true; opts.hasTouch = true; opts.deviceScaleFactor = 2; }
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    page.on("pageerror", e => pageErrs.push(e.message));
    await page.goto(URL, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(1600);
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

  /* ============ A · 线上产物确实含本次移动端改动 ============ */
  console.log("=== A · 线上产物含移动端改动（静态契约直读线上）===");
  {
    const { ctx, page } = await open(1280, 800, false);
    const a = await page.evaluate(() => {
      const cs = el => el ? getComputedStyle(el) : null;
      const meta = document.querySelector('meta[name="viewport"]');
      /* 本次最硬的证据：线上 measureDrag 是否真的分两套量纲。
       * 版本戳只能证明 URL 变了，这一条证明**内容**变了。 */
      let scale = null;
      try {
        const mk = t => ({ on: false, zone: "hit", type: t, sx: 0, sy: 0, x: 120, y: 0,
                           speed: 900, t0: 0, startY: 0, startAngle: 0 });
        const t = measureDrag(mk("touch")), m = measureDrag(mk("mouse"));
        scale = { vmin: Math.min(innerWidth, innerHeight),
                  touchMin: t.minSwing, mouseMin: m.minSwing,
                  touchAim: t.aim, mouseAim: m.aim,
                  hasConst: typeof TOUCHSCALE === "object",
                  constMin: TOUCHSCALE && TOUCHSCALE.minSwing };
      } catch (e) { scale = { err: e.message }; }

      const hint = document.getElementById("rotateHint");
      const ctl = document.getElementById("touchCtl");
      const btns = ["tcPause", "tcRestart", "tcAssist", "tcHand"].map(id => !!document.getElementById(id));
      const hintCs = cs(hint);
      return {
        scale,
        hasHint: !!hint,
        hintZ: hintCs ? hintCs.zIndex : "",
        hintPE: hintCs ? hintCs.pointerEvents : "",
        hasCtl: !!ctl,
        btns,
        ta: {
          html: cs(document.documentElement).touchAction,
          body: cs(document.body).touchAction,
          hud: cs(document.getElementById("hud")).touchAction,
          cv: cs(document.getElementById("cv")).touchAction,
        },
        ob: cs(document.documentElement).overscrollBehavior,
        meta: meta ? meta.getAttribute("content") : "",
        coarseFn: typeof isCoarse === "function",
        supportedFn: typeof isSupported === "function",
        gateFn: typeof applySupportGate === "function",
      };
    });

    ok("线上存在竖屏引导层 DOM", a.hasHint === true);
    ok("线上引导层层级 z-index=30、可拦截触摸", a.hintZ === "30" && a.hintPE === "auto",
       "z=" + a.hintZ + " pointer-events=" + a.hintPE);
    ok("线上存在触屏控制簇 + 四个按钮", a.hasCtl && a.btns.every(Boolean),
       "touchCtl=" + a.hasCtl + " 按钮=" + a.btns.join(","));
    ok("线上四层 touch-action=none（html/body/#hud/#cv）",
       a.ta.html === "none" && a.ta.body === "none" && a.ta.hud === "none" && a.ta.cv === "none",
       "html=" + a.ta.html + " body=" + a.ta.body + " hud=" + a.ta.hud + " cv=" + a.ta.cv);
    ok("线上 overscroll-behavior=none（禁橡皮筋手势）", a.ob === "none", "ob=" + a.ob);
    ok("线上 viewport meta 已禁缩放（user-scalable=no）",
       /user-scalable\s*=\s*no/.test(a.meta), "content=" + a.meta);
    ok("线上存在 TOUCHSCALE 常量与门控三件套（isCoarse/isSupported/applySupportGate）",
       a.scale && a.scale.hasConst && a.coarseFn && a.supportedFn && a.gateFn,
       "TOUCHSCALE=" + (a.scale && a.scale.hasConst) + " isSupported=" + a.supportedFn);
    ok("线上 measureDrag 真的分两套量纲（触摸按视口、鼠标按原版绝对像素）",
       !!a.scale && !a.scale.err &&
       Math.abs(a.scale.touchMin - a.scale.constMin * a.scale.vmin) < 0.02 &&
       a.scale.mouseMin === 10 && a.scale.touchMin !== a.scale.mouseMin,
       "触摸 minSwing=" + (a.scale.touchMin || 0).toFixed(2) + "（=0.055×" + a.scale.vmin +
       "）／鼠标 minSwing=" + a.scale.mouseMin);
    await ctx.close();
  }

  /* ============ B · 平板横屏：真实触摸可玩 ============ */
  console.log("\n=== B · 平板横屏，真实触摸手势完整回球 ===");
  {
    const { ctx, page } = await open(900, 420, true);
    await page.click("#startBtn");
    await page.waitForTimeout(200);
    await page.evaluate(INSTALL);

    /* B1. CDP 真实触摸序列：touch-action 在线上是否真的生效 */
    const cdp = await ctx.newCDPSession(page);
    await page.evaluate(() => { window.__ev.length = 0; window.__cancels = 0; });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 620, y: 200, id: 1 }] });
    await page.waitForTimeout(40);
    for (let i = 1; i <= 4; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 620, y: 200 - i * 30, id: 1 }] });
      await page.waitForTimeout(28);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(200);
    const cdpR = await page.evaluate(() => ({
      ev: window.__ev.slice(), cancels: window.__cancels,
      ctl: (() => { const c = document.getElementById("touchCtl"); const r = c.getBoundingClientRect();
                    return { display: getComputedStyle(c).display, w: Math.round(r.width), h: Math.round(r.height) }; })(),
      touchOn: document.getElementById("hud").classList.contains("touch-on"),
      hintOn: document.getElementById("rotateHint").classList.contains("on"),
    }));
    ok("线上真实触摸序列收到 pointerdown 与 pointerup",
       cdpR.ev.some(e => e.startsWith("pointerdown")) && cdpR.ev.some(e => e.startsWith("pointerup")),
       cdpR.ev.slice(0, 3).join(" "));
    ok("线上全程零 pointercancel（部署版 touch-action 真的生效）", cdpR.cancels === 0,
       "cancels=" + cdpR.cancels + " 事件数=" + cdpR.ev.length);
    ok("平板横屏 → 门控放行（引导层不显示）", cdpR.hintOn === false);
    ok("平板横屏 → 控制簇真实渲染（display:flex 且有尺寸）",
       cdpR.ctl.display === "flex" && cdpR.ctl.w > 0 && cdpR.ctl.h > 0,
       cdpR.ctl.display + " " + cdpR.ctl.w + "×" + cdpR.ctl.h);
    ok("平板横屏 → #hud 带 touch-on（粗指针规则命中）", cdpR.touchOn === true);

    /* B2. 右区触摸手势能不能真的把球打回去
     * 与 _touch_browser.js 同样的稳健性考虑：headless SwiftShader 抢 GPU 时掉帧会让
     * 手势 rAF 节奏失真、整轮 0 命中（环境抖动，不是功能坏），故重试一轮再判。 */
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
    ok("线上触摸手势被识别为有效击球（hitDone 真的置位过）", hits > 0,
       "识别 " + hits + "/" + attempts + " 次");
    ok("线上触摸手势能真的得分（连续回球增长）", rallies > 0,
       rallies + "/" + attempts + " 次成功回球得分");

    /* B3. 左区手势（辅助关）调拍面 —— 线上同样按两套量纲/分区走 */
    await page.evaluate(() => { restart(); G.assist = false; });
    await page.waitForTimeout(320);
    const face = await page.evaluate(() => {
      const c = document.getElementById("cv");
      const fire = (t, x, y) => c.dispatchEvent(new PointerEvent(t, {
        pointerId: 11, clientX: x, clientY: y, bubbles: true,
        pointerType: "touch", isPrimary: true, button: 0, buttons: 1 }));
      fire("pointerdown", 80, 300);            // 左 45% 区（900 宽 → <405）
      const zone = drag.zone;
      fire("pointermove", 80, 160);
      const mid = G.paddleAngle;
      fire("pointerup", 80, 160);
      return { zone, mid, hitDone: G.hitDone };
    });
    ok("线上左 45% 区按下 → 判为拍面区（双区手势分流生效）", face.zone === "paddle", "zone=" + face.zone);
    ok("线上左区手势改拍面且不串扰击球", face.mid > 0 && face.hitDone === false,
       "拍面 " + face.mid.toFixed(2) + " hitDone=" + face.hitDone);

    /* B4. 线上控制簇不得侵入球的下落走廊
     * 本轮的部署产物里踩过这个坑：控制簇原本放屏幕底部居中，正好压住球的落点区
     * （第一视角下球近身时投影在屏幕下方）。CSS 改动不会换脚本 URL，
     * 版本戳证明不了这条，只能在线上实地量。 */
    await page.evaluate(() => restart());
    await page.waitForTimeout(360);
    const corridor = await page.evaluate(() => new Promise(res => {
      const s = [];
      const t0 = Date.now();
      const w = () => {
        if (G.phase === "incoming" && G.ball) {
          const v = new THREE.Vector3(G.ball.x, G.ball.y, G.ball.z).project(CAM);
          s.push({ z: G.ball.z, x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight });
        }
        if ((G.phase !== "incoming" && s.length > 5) || Date.now() - t0 > 5000) return res(s);
        requestAnimationFrame(w);
      };
      w();
    }));
    const near = corridor.filter(s => s.z > 0.3 && s.z <= 1.2);
    const fy = await page.evaluate(() => {
      const r = document.getElementById("touchCtl").getBoundingClientRect();
      return { l: r.left, r: r.right };
    });
    const cMinX = near.length ? Math.min(...near.map(s => s.x)) : 0;
    const cMaxX = near.length ? Math.max(...near.map(s => s.x)) : 0;
    ok("线上控制簇不侵入球的下落走廊（水平分离 ≥20px）",
       near.length >= 3 && (cMaxX < fy.l - 20 || cMinX > fy.r + 20),
       "近身样本 " + near.length + " 个　球走廊 x[" + Math.round(cMinX) + "," + Math.round(cMaxX) +
       "]　控制簇 x[" + Math.round(fy.l) + "," + Math.round(fy.r) + "]");
    await ctx.close();
  }

  /* ============ C · 手机竖屏：引导层必须拦住 ============ */
  console.log("\n=== C · 手机竖屏，引导层拦截 ===");
  {
    const { ctx, page } = await open(390, 844, true);
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const hint = document.getElementById("rotateHint");
      const hr = hint.getBoundingClientRect();
      const cs = getComputedStyle(hint);
      const top = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
      return { on: hint.classList.contains("on"), display: cs.display, z: cs.zIndex,
               w: Math.round(hr.width), h: Math.round(hr.height),
               coverW: Math.round(hr.width) >= Math.round(innerWidth),
               coverH: Math.round(hr.height) >= Math.round(innerHeight),
               topId: top ? (top.id || top.className || top.tagName) : "null",
               ctl: getComputedStyle(document.getElementById("touchCtl")).display };
    });
    ok("手机竖屏 → 引导层加 on 类", r.on === true);
    ok("引导层真实渲染并铺满全屏", r.display === "flex" && r.coverW && r.coverH,
       r.display + " " + r.w + "×" + r.h);
    ok("引导层层级在最上（z-index=30）", r.z === "30", "z=" + r.z);
    ok("屏幕中心命中的是引导层（对局真的不可达）",
       String(r.topId).indexOf("rotate") >= 0 || /rh-/.test(String(r.topId)), "命中=" + r.topId);
    await ctx.close();
  }

  /* ============ D · 桌面：零回归 ============ */
  console.log("\n=== D · 桌面，零回归基线 ===");
  {
    const { ctx, page } = await open(1280, 800, false);
    await page.click("#startBtn");
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => ({
      ctl: getComputedStyle(document.getElementById("touchCtl")).display,
      touchOn: document.getElementById("hud").classList.contains("touch-on"),
      hintOn: document.getElementById("rotateHint").classList.contains("on"),
      keys: getComputedStyle(document.getElementById("hudKeys")).display !== "none",
      running: G.running,
      /* 鼠标量纲必须还是原版绝对像素 —— 桌面手感零回归的线上证据 */
      mouseMin: (() => { try { return measureDrag({ on: false, zone: "hit", type: "mouse",
        sx: 0, sy: 0, x: 5, y: 0, speed: 0, t0: 0, startY: 0, startAngle: 0 }).minSwing; }
        catch (e) { return null; } })(),
    }));
    ok("桌面 → 触屏控制簇隐藏（不出现冗余按钮）", r.ctl === "none", "display=" + r.ctl);
    ok("桌面 → #hud 不带 touch-on", r.touchOn === false);
    ok("桌面 → 引导层永不显示", r.hintOn === false);
    ok("桌面 → 键盘操作说明仍可见（未被粗指针规则误伤）", r.keys === true);
    ok("桌面 → 对局正常启动", r.running === true);
    ok("桌面鼠标量纲仍是原版绝对像素 10（手感零回归的线上证据）", r.mouseMin === 10,
       "mouse minSwing=" + r.mouseMin);
    await ctx.close();
  }

  ok("全程无页面 JS 异常", pageErrs.length === 0, pageErrs.slice(0, 2).join(" | "));

  await browser.close();

  console.log("\n共 " + (PASS_N + FAILS.length) + " 项断言，通过 " + PASS_N + " 项");
  if (FAILS.length) {
    console.log("失败：线上移动端手势未全部通过");
    FAILS.forEach(f => console.log("  - " + f));
    process.exit(1);
  }
  console.log("线上移动端手势全部通过");
})().catch(e => {
  console.log("fatal: " + String(e && e.stack || e));
  process.exit(1);
});
