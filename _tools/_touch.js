/* 移动端纯手势改造 · 回归测试（Task 10）
 *
 * 两层验证，分工明确：
 *   ① Node 侧静态断言 —— 视口 meta、touch-action 四层、overscroll、粗指针媒体查询、
 *      控制簇 / 引导层的 DOM 与 CSS 契约。
 *      为什么必须在源码字符串上做：沙箱的 getElementById 对任意 id 都会造出桩元素，
 *      "JS 里加了类但 CSS 忘了写" 这类问题它永远看不见（典型假绿）。
 *   ② 沙箱运行时断言 —— 控制簇显隐与绑定、双区手势分流、辅助拍面跟随、设备门控、拖拽量纲。
 *      matchMedia 做成可切换桩：isSupported() 每次调用都重读配置，改完重调即可验四组合，
 *      不必为每种设备重启沙箱。
 *
 * 为什么必须有这一关：在接入线上验证之前，本地回归只覆盖桌面路径。而移动端改造的风险
 * （触摸被 pointercancel 掐断、双区串扰、竖屏几何不成立、量纲在小屏被放大）**全都不会
 * 在桌面路径上暴露**。真浏览器触摸链路另见 _touch_browser.js。
 *
 * 运行：node _touch.js
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const code = fs.readFileSync(ROOT + "/game.js", "utf8");
const HTML = fs.readFileSync(ROOT + "/index.html", "utf8");

const FAILS = [];
let PASS_N = 0;
function ok(label, cond, detail) {
  if (cond) { PASS_N++; console.log("  PASS  " + label + (detail ? "　→ " + detail : "")); }
  else { FAILS.push(label); console.log("  FAIL  " + label + (detail ? "　→ " + detail : "")); }
}

/* ============================ ① 静态契约（源码字符串） ============================ */
console.log("=== 静态契约（在真源码字符串上断言） ===");

const VP = HTML.match(/<meta name="viewport" content="([^"]+)"/);
const vpStr = VP ? VP[1] : "";
ok("视口声明禁止缩放（user-scalable=no）", /user-scalable=no/.test(vpStr), vpStr.slice(0, 60));
ok("视口声明适配刘海屏（viewport-fit=cover）", /viewport-fit=cover/.test(vpStr));

/* touch-action：只给 canvas 设是不够的 —— 本轮实测（报告 E2）证明触摸点落在 HUD 元素上时，
 * 浏览器照样把序列掐成 pointercancel。四层都要盖住。 */
const TA = {
  "html/body": /html,\s*body\s*\{[^}]*touch-action:none/.test(HTML),
  "#hud":      /#hud\s*\{[^}]*touch-action:none/.test(HTML),
  "#cv":       /canvas\s*\{[^}]*touch-action:none/.test(HTML),
  ".rotate-hint": /\.rotate-hint\s*\{[^}]*touch-action:none/.test(HTML)
};
ok("touch-action:none 覆盖 html/body", TA["html/body"]);
ok("touch-action:none 覆盖 #hud（触摸点落在 HUD 上也不被劫持）", TA["#hud"]);
ok("touch-action:none 覆盖 canvas", TA["#cv"]);
ok("touch-action:none 覆盖 .rotate-hint", TA[".rotate-hint"]);
ok("overscroll-behavior:none 已设（防下拉刷新吃掉手势）",
   /html,\s*body\s*\{[^}]*overscroll-behavior:none/.test(HTML));

ok("粗指针下隐藏键盘说明 #hudKeys（@media pointer:coarse）",
   /@media\s*\(pointer:coarse\)\s*\{\s*#hudKeys\s*\{\s*display:none/.test(HTML));

/* 控制簇：默认隐藏 + 仅 .touch-on 显示 —— 桌面不该出现冗余按钮 */
ok("触屏控制簇默认隐藏（#touchCtl display:none）",
   /#touchCtl\s*\{\s*display:none/.test(HTML));
ok("粗指针下由 #hud.touch-on 显示控制簇",
   /#hud\.touch-on\s+#touchCtl\s*\{\s*display:flex/.test(HTML));
["tcPause", "tcRestart", "tcAssist", "tcHand"].forEach(id =>
  ok("控制簇按钮 " + id + " 存在于 DOM", HTML.indexOf('id="' + id + '"') >= 0));
ok("引导层 #rotateHint 存在于 DOM", /class="rotate-hint"\s+id="rotateHint"/.test(HTML));
ok("引导层靠 .rotate-hint.on 显示", /\.rotate-hint\.on\s*\{\s*display:flex/.test(HTML));
ok("引导层层级高于所有浮层（z-index ≥ 30）",
   /\.rotate-hint\s*\{[^}]*z-index:30/.test(HTML));

/* 输入层必须已从 mouse 迁到 pointer：残留 mouse 监听会让「触摸」与「鼠标」两套并存，
 * 二合一设备上一次触摸被当两次击球。 */
const mouseListeners = (code.match(/addEventListener\(\s*"mouse(?:down|move|up)"/g) || []).length;
ok("输入层无 mouse 事件监听残留（全部迁至 pointer）", mouseListeners === 0,
   "残留 " + mouseListeners + " 处");
["pointerdown", "pointermove", "pointerup"].forEach(t =>
  ok("已注册 " + t, code.indexOf('addEventListener("' + t + '"') >= 0));

/* ============================ 沙箱基建（极简桩） ============================ */
function makeStub(tag) {
  const cache = {};
  const target = function () { return makeStub(tag + "()"); };
  return new Proxy(target, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === "then" || p === "constructor") return undefined;
      if (p === "length") return 0;
      if (!(p in cache)) cache[p] = makeStub(tag + "." + String(p));
      return cache[p];
    },
    set(t, p, v) { cache[p] = v; return true; },
    apply() { return makeStub(tag + "()"); },
    construct() { return makeStub("new " + tag); },
    has() { return true; }
  });
}
function aparam() {
  return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {},
           linearRampToValueAtTime() {}, setTargetAtTime() {} };
}
function anode() {
  return { connect() {}, disconnect() {}, gain: aparam(), frequency: aparam(), Q: aparam(),
           detune: aparam(), playbackRate: aparam(), type: "", buffer: null, loop: false,
           start() {}, stop() {} };
}
function MockAC() {
  this.sampleRate = 48000; this.state = "running"; this.currentTime = 0;
  this.destination = { connect() {} };
  this.createGain = anode; this.createOscillator = anode;
  this.createBiquadFilter = anode; this.createBufferSource = anode;
  this.createBuffer = (ch, len) => ({ length: len, getChannelData: () => new Float32Array(Math.min(len, 8192)) });
  this.resume = () => {};
}
function el(id) {
  const cls = new Set();
  return {
    _id: id, width: 0, height: 0, style: {}, textContent: "", innerHTML: "", value: 70,
    classList: {
      add: c => cls.add(c), remove: c => cls.delete(c),
      toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); }
                           else if (on) cls.add(c); else cls.delete(c); },
      contains: c => cls.has(c)
    },
    getContext: () => makeStub("ctx2d"),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
    addEventListener(type, fn) { (this._L = this._L || {}); (this._L[type] = this._L[type] || []).push(fn); },
    removeEventListener() {}, appendChild() {}, querySelector: () => null,
    _fire(type, ev) { ((this._L || {})[type] || []).forEach(f => f(ev || {})); }
  };
}

/* 跑一个场景沙箱。
 * mm  —— matchMedia 配置（键就是查询串，值 = matches）。门控断言靠它切换。 */
function bootScene(mm, testBody) {
  const els = {}, winL = {};
  const CLOCK = { t: 0 };
  const MM = Object.assign({}, mm);
  const sandbox = {
    console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error,
    isNaN, parseInt, parseFloat, Symbol, Proxy, Function, Float32Array,
    performance: { now: () => CLOCK.t },
    requestAnimationFrame: () => 0, setTimeout: () => 0, clearTimeout() {},
    localStorage: (function () {
      const M = new Map();
      return { getItem: k => (M.has(String(k)) ? M.get(String(k)) : null),
               setItem: (k, v) => { M.set(String(k), String(v)); },
               removeItem: k => { M.delete(String(k)); }, clear: () => M.clear() };
    })(),
    THREE: makeStub("THREE"),
    document: {
      getElementById: id => els[id] || (els[id] = el(id)),
      createElement: tag => el("created:" + tag),
      querySelectorAll: () => [], addEventListener() {}, body: el("body"),
      documentElement: el("html")
    },
    window: {
      addEventListener(type, fn) { (winL[type] = winL[type] || []).push(fn); },
      innerWidth: 1600, innerHeight: 900, devicePixelRatio: 2,
      matchMedia: q => ({ matches: !!MM[q], media: q,
                          addListener() {}, removeListener() {},
                          addEventListener() {}, removeEventListener() {} }),
      AudioContext: MockAC, webkitAudioContext: MockAC
    }
  };
  sandbox.window.document = sandbox.document;
  sandbox.window.localStorage = sandbox.localStorage;
  sandbox.window.performance = sandbox.performance;
  sandbox.els = els; sandbox.winL = winL; sandbox.CLOCK = CLOCK; sandbox.MM = MM;
  sandbox.__OUT = "";

  const testCode = `
const R = {};
const G_ = (l, f) => { try { f(); } catch (e) { R["ERR:" + l] = String(e && e.message || e); } };
const __tick = f => { CLOCK.t += f * 1000; loop(CLOCK.t); };
const PTR = (type, o) => Object.assign({ pointerType: type, button: 0, buttons: 1,
                                          pointerId: 1, preventDefault() {} }, o);
const fireDown = (t, x, y) => els.cv._fire("pointerdown", PTR(t, { clientX: x, clientY: y }));
const fireMove = (t, x, y) => (winL.pointermove || []).forEach(f => f(PTR(t, { clientX: x, clientY: y })));
const fireUp   = (t)    => (winL.pointerup   || []).forEach(f => f(PTR(t, {})));
G_("audio", () => audioInit());

R.hudTouchOn    = UI.hud.classList.contains("touch-on");
R.hasRotateHint = !!UI.rotateHint;
R.bindings = {
  pause:   typeof UI.tcPause.onclick,
  restart: typeof UI.tcRestart.onclick,
  assist:  typeof UI.tcAssist.onclick,
  hand:    typeof UI.tcHand.onclick
};
R.isCoarse = isCoarse();

/* ---- 按钮行为 ---- */
G_("btn-hand", () => {
  const before = G.backhand;
  UI.tcHand.onclick();
  R.handFlips = (G.backhand !== before);
  UI.tcHand.onclick();                       // 还原
});
G_("btn-pause", () => {
  /* togglePause 有 "if (!G.running) return" 守卫：必须先真正进局，否则是空操作、
   * 断言会假红（本轮踩过）。restart() 把 running 立起来再点按钮。 */
  restart();
  const before = G.paused;
  UI.tcPause.onclick();
  R.pauseFlips = (G.paused !== before);
  R.pauseAfter = G.paused;
  UI.tcPause.onclick();
});

/* ---- 双区手势：左 45% 调拍面、右 55% 击球 ----
 * 左区行为分两态（这是设计契约，不是二选一）：
 *   辅助关（挑战模式）→ 左区纵向拖拽手动调拍面；
 *   辅助开（练习模式）→ 拍面由 Task 6 每帧自动跟随，左区手动被刻意忽略，
 *                       否则玩家的手会与自动角度互相打架。 */
G_("zone-paddle-manual", () => {
  setMode("challenge");                      // 辅助恒关 → 左区手动生效
  restart(); serve();
  const W = window.innerWidth;
  G.paddleAngle = 0;
  fireDown("touch", W * 0.2, 400);           // 左区
  R.zoneIsPaddle = (drag.zone === "paddle");
  fireMove("touch", W * 0.2, 400 - 160);     // 上拖 → 亮拍
  R.paddleMoved = (G.paddleAngle > 0.2);
  const hitBefore = G.hitDone;
  fireUp("touch");
  R.leftNoHit = (G.hitDone === hitBefore);   // 左区不该触发击球
  setMode("practice");
});
G_("zone-paddle-assisted", () => {
  setMode("practice");                       // 辅助恒开 → 左区手动被忽略（设计如此）
  restart(); serve();
  const W = window.innerWidth;
  G.assist = true;
  const before = G.paddleAngle;
  fireDown("touch", W * 0.2, 400);
  fireMove("touch", W * 0.2, 400 - 160);
  const afterMove = G.paddleAngle;
  fireUp("touch");
  R.assistIgnoresManual = Math.abs(afterMove - before) < 1e-9;
});
G_("zone-hit", () => {
  restart(); serve();
  const W = window.innerWidth;
  fireDown("touch", W * 0.8, 400);           // 右区
  R.zoneIsHit = (drag.zone === "hit");
  fireMove("touch", W * 0.8 + 120, 400);
  fireUp("touch");
  R.rightHit = !!G.hitDone;
});

/* ---- 拖拽量纲：鼠标绝对像素 / 触摸视口比例，两套并存 ---- */
R.unit = (function () {
  const W = window.innerWidth, H = window.innerHeight;
  const drag = (type, dx, dy) => ({ type, sx: 0, sy: 0, x: dx, y: dy || 0, speed: 0 });
  const m = measureDrag(drag("mouse", 70, 0));
  const t = measureDrag(drag("touch", 70, 0));
  return { mouseAim: m.aim, touchAim: t.aim, mouseMin: m.minSwing, touchMin: t.minSwing,
           mouseTooSmall10: measureDrag(drag("mouse", 5, 0)).tooSmall,
           touchTooSmall10: measureDrag(drag("touch", 5, 0)).tooSmall };
})();

/* ---- 辅助跟随：粗指针 + 辅助开 → 每帧拍面自动对齐正确角度 ---- */
G_("assist-follow", () => {
  restart(); serve();
  if (G.mode === "challenge") setMode("practice");
  G.assist = true;
  G.paddleAngle = 0.99;                      // 故意先设错
  let followed = false;
  for (let i = 0; i < 60; i++) {
    __tick(0.0167);
    if (G.phase === "incoming" && Math.abs(G.paddleAngle - correctTiltFor(G.spin)) < 1e-9) {
      followed = true; break;
    }
  }
  R.assistFollowed = followed;
});

/* ---- 设备门控四组合（纯函数，改配置重调即可） ---- */
G_("gate", () => {
  const set = (coarse, wide, land) => {
    MM["(pointer: coarse)"] = coarse;
    MM["(min-width: 768px)"] = wide;
    MM["(orientation: landscape)"] = land;
    return isSupported();
  };
  R.gate = {
    desktop:      set(false, true,  true),   // 桌面（细指针）→ 放行
    tabletLand:   set(true,  true,  true),   // 平板横屏 → 放行
    tabletPort:   set(true,  true,  false),  // 平板竖屏 → 拦截
    phoneLand:    set(true,  false, true),   // 手机横屏 → 拦截（屏宽不足）
    phonePort:    set(true,  false, false)   // 手机竖屏 → 拦截
  };
  // 引导层随门控切换
  set(true, true, true);  applySupportGate();
  R.hintHiddenOnTablet = !UI.rotateHint.classList.contains("on");
  set(true, false, false); applySupportGate();
  R.hintShownOnPhone = UI.rotateHint.classList.contains("on");
  set(false, true, true);  applySupportGate();
  R.hintHiddenOnDesktop = !UI.rotateHint.classList.contains("on");
});

/* 竖屏几何不在这里算：CAM 是 Proxy 桩读不到真值（第一版踩过，假红两项）。
 * 改由 Node 侧解析源码常量，见下方 hFov / visibleHalfWidth。 */

__OUT = JSON.stringify(R);
`;
  sandbox.__BODY = testBody;
  try { vm.runInNewContext(code + "\n" + testCode, sandbox, { filename: "game.js" }); }
  catch (e) {
    console.log("  顶层异常: " + e.message);
    console.log((e.stack || "").split("\n").slice(0, 4).join("\n"));
    FAILS.push("场景沙箱启动");
    return { R: {}, els, winL, sandbox };
  }
  let R = {};
  try { R = JSON.parse(sandbox.__OUT); } catch (e) { FAILS.push("场景结果解析"); }
  return { R, els, winL, sandbox };
}

/* ==================== ② 场景 A：粗指针 · 平板横屏（受支持设备） ==================== */
console.log("\n=== 运行时 · 粗指针 + 平板横屏（受支持设备） ===");
const A = bootScene({
  "(pointer: coarse)": true, "(min-width: 768px)": true, "(orientation: landscape)": true
}).R;
Object.keys(A).filter(k => k.startsWith("ERR:")).forEach(k => ok("沙箱无异常 " + k, false, A[k]));

ok("粗指针下 #hud 挂上 touch-on（控制簇显示）", A.hudTouchOn === true);
ok("四个控制簇按钮均已绑定 onclick",
   A.bindings && A.bindings.pause === "function" && A.bindings.restart === "function" &&
   A.bindings.assist === "function" && A.bindings.hand === "function",
   JSON.stringify(A.bindings));
ok("「正反手」按钮真的切换 G.backhand", A.handFlips === true);
ok("「暂停」按钮真的切换 G.paused", A.pauseFlips === true);
ok("isCoarse() 在粗指针下为 true", A.isCoarse === true);

/* ---- 双区手势 · 左区两态 ---- */
ok("挑战模式（辅助关）：左区纵向拖拽 → 拍面手动变亮", A.paddleMoved === true,
   "paddleAngle=" + A.paddleMoved);
ok("练习模式（辅助开）：左区手动被忽略（拍面交给自动跟随，避免与自动角度打架）",
   A.assistIgnoresManual === true);
ok("左 45% 屏按下 → 判为拍面区", A.zoneIsPaddle === true);
ok("左区手势不触发击球（不串扰）", A.leftNoHit === true);
ok("右 55% 屏按下 → 判为击球区", A.zoneIsHit === true);
ok("右区挥拍 → G.hitDone 置位（真的打到球）", A.rightHit === true);

/* ---- 竖屏几何：从源码解析真实机位，算击球带可见半宽 ----
 * 为什么不能在沙箱里读 CAM.fov：CAM 是 Proxy 桩，任何属性都返回可调用对象，
 * 读到的是 0 或对象，断言必假（第一版就这么假红了两项）。
 * 改用源码解析——机位参数与 HIT_Z 都是明文常量，算出来的才是真实几何。 */
const CAMFOV = (() => {
  const m = code.match(/new THREE\.PerspectiveCamera\(\s*([\d.]+)\s*,/);
  return m ? +m[1] : 0;
})();
const CAMZ = (code.match(/CAM_Z\s*=\s*([\d.]+)/) || [])[1];
const CAMY = (code.match(/CAM_Y\s*=\s*([\d.]+)/) || [])[1];
const HITZ = (code.match(/HIT_Z\s*=\s*([\d.]+)/) || [])[1];
/* 水平 FOV（垂直 FOV 固定，随 aspect 变化） */
function hFov(deg, w, h) {
  return 2 * Math.atan(Math.tan(deg * Math.PI / 360) * (w / h)) * 180 / Math.PI;
}
/* 击球带（z = HIT_Z 那个纵深平面）的可见半宽：相机到该平面还要往前看 lookAt 高度，
 * 这里按最保守的近似——距离取 (CAM_Z - HIT_Z)，误差不影响「竖屏装不下」的量级判断。 */
function visibleHalfWidth(deg, w, h) {
  const dist = (+CAMZ) - (+HITZ);
  return Math.tan(hFov(deg, w, h) * Math.PI / 360) * dist;
}
const TABLE_HALF = 0.7625;   // 标准球台半宽 1525mm / 2

console.log("  —— 量纲 ——");
ok("鼠标走绝对像素：dx=70 → aim 0.5（与原版 140 一致）",
   Math.abs((A.unit || {}).mouseAim - 0.5) < 1e-9, "aim=" + (A.unit || {}).mouseAim);
ok("触摸走视口比例：同 dx=70 在 1600 宽下 aim 明显更小（不会一点就飞）",
   (A.unit || {}).touchAim > 0 && A.unit.touchAim < 0.25, "aim=" + (A.unit || {}).touchAim);
ok("鼠标 5px 抖动不算挥拍（保留原版 minSwing=10）", A.unit && A.unit.mouseTooSmall10 === true);
ok("触摸 5px 抖动被判无效（防手指误触）", A.unit && A.unit.touchTooSmall10 === true);

console.log("  —— 辅助跟随 / 门控 / 几何 ——");
ok("粗指针 + 辅助开 → 每帧拍面自动对齐正确角度", A.assistFollowed === true);
const g = A.gate || {};
ok("门控 · 桌面（细指针）放行", g.desktop === true);
ok("门控 · 平板横屏放行", g.tabletLand === true);
ok("门控 · 平板竖屏拦截", g.tabletPort === false);
ok("门控 · 手机横屏拦截（屏宽 < 768）", g.phoneLand === false);
ok("门控 · 手机竖屏拦截", g.phonePort === false);
ok("平板横屏 → 引导层隐藏", A.hintHiddenOnTablet === true);
ok("手机竖屏 → 引导层显示", A.hintShownOnPhone === true);
ok("桌面 → 引导层永不显示", A.hintHiddenOnDesktop === true);

/* 竖屏几何是 P2 门控的**物理依据**：不是"体验差"，是球台真的画不进来。
 * 固定 40° 垂直 FOV 的相机，竖屏时水平视野被压窄到装不下 1.525m 宽的球台。 */
console.log("  —— 竖屏几何（P2 门控的物理依据） ——");
const fP = hFov(CAMFOV, 390, 844), fL = hFov(CAMFOV, 844, 390);
const wP = visibleHalfWidth(CAMFOV, 390, 844), wL = visibleHalfWidth(CAMFOV, 844, 390);
ok("竖屏水平 FOV 远窄于横屏",
   fP < 25 && fL > 60, "竖屏 " + fP.toFixed(1) + "° / 横屏 " + fL.toFixed(1) + "°");
ok("横屏时击球带可见半宽 > 球台半宽（球台完整入画）",
   wL > TABLE_HALF, "可见 " + wL.toFixed(3) + "m vs 球台 " + TABLE_HALF + "m");
ok("竖屏时击球带可见半宽 < 球台半宽（球台被裁，故必须拦竖屏）",
   wP < TABLE_HALF, "可见 " + wP.toFixed(3) + "m vs 球台 " + TABLE_HALF + "m");
ok("机位常量解析成功（CAM_Y/CAM_Z/HIT_Z/垂直FOV 均非空）",
   !!CAMFOV && !!CAMY && !!CAMZ && !!HITZ,
   "FOV=" + CAMFOV + "° CAM_Y=" + CAMY + " CAM_Z=" + CAMZ + " HIT_Z=" + HITZ);

/* ==================== ③ 场景 B：细指针 · 桌面（零回归） ==================== */
console.log("\n=== 运行时 · 细指针 + 桌面（零回归基线） ===");
const B = bootScene({ "(pointer: coarse)": false, "(min-width: 768px)": true,
                      "(orientation: landscape)": true }).R;
ok("细指针下 #hud 不带 touch-on（桌面不出现触屏按钮）", B.hudTouchOn === false);
ok("isCoarse() 在细指针下为 false", B.isCoarse === false);
ok("细指针下门控放行（桌面不受移动端限制）", (B.gate || {}).desktop === true);
ok("细指针下拍面不自动跟随（保留手动滚轮/AD）",
   B.assistFollowed === false || B.assistFollowed === undefined,
   "assistFollowed=" + B.assistFollowed);

/* ============================ 汇总 ============================ */
console.log("\n共 " + (PASS_N + FAILS.length) + " 项断言，通过 " + PASS_N + " 项");
if (FAILS.length) {
  console.log("失败：移动端手势回归未全部通过");
  FAILS.forEach(f => console.log("  - " + f));
  process.exit(1);
}
console.log("移动端手势验证全部通过");
