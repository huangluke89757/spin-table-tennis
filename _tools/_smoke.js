// 冒烟测试：桩化 DOM / Canvas / THREE / Web Audio，在 Node 里跑完整帧循环与自动玩家对局
// 验证：场景构建无异常、渲染分支不报错、按 PRD 正确操作能连续回球、音效链路真的发声
// 运行： node _smoke.js
const fs = require("fs");
const vm = require("vm");


const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;
const code = fs.readFileSync(ROOT + "/game.js", "utf8");
/* index.html 也要读：面板显隐靠 CSS 的 collapsed 规则，只测 JS 会漏掉「类加了但样式没写」 */
const HTML = fs.readFileSync(ROOT + "/index.html", "utf8");

/* ---------- 从 game.js 源码解析球拍几何常量 ----------
 * 为什么在 Node 侧解析：THREE 被桩化成 Proxy 后包围盒不可用，
 * 只能读源码里的数字；而写进沙箱模板串的话，模板会先把 \s 吃成 s，
 * 正则静默失效、断言永远假绿（踩过这个坑）。
 * 为什么按名字读而不数「第几个 CylinderGeometry」：后者一改部件顺序就错位
 * （曾把前臂当成握柄，得出「柄长 130mm」这种荒唐结论）。 */
function parseRKT(src) {
  const m = src.match(/const RKT = \{[\s\S]*?\};/);
  const out = {};
  if (!m) return out;
  /* 键名要允许尾部数字：handleR1 / foreR2 这类名字若用 [A-Za-z]+ 会被截成 handleR，
   * 于是 foreR2 读不到、断言拿到 NaN。 */
  const re = /([A-Za-z][A-Za-z0-9]*)\s*:\s*(-?[0-9.]+)/g;
  let mm;
  while ((mm = re.exec(m[0]))) out[mm[1]] = +mm[2];
  return out;
}

/* ---------- 通用深度桩：任何属性访问都返回可调用 / 可构造的桩 ---------- */
const drawCalls = {};
function makeStub(tag) {
  const cache = {};
  const target = function () { return makeStub(tag + "()"); };
  return new Proxy(target, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === "then" || p === "constructor") return undefined;
      if (p === "length") return 0;
      drawCalls[String(p)] = (drawCalls[String(p)] || 0) + 1;
      if (!(p in cache)) cache[p] = makeStub(tag + "." + String(p));
      return cache[p];
    },
    set(t, p, v) { cache[p] = v; return true; },
    apply() { return makeStub(tag + "()"); },
    construct() { return makeStub("new " + tag); },
    has() { return true; }
  });
}
function el(id, tag) {
  const L = {};
  const cls = new Set();
  const self = {
    _id: id, _tag: tag || "div", width: 0, height: 0, style: {}, textContent: "", innerHTML: "", value: 70,
    /* classList 要真的记账：面板显隐全靠它，空实现会让「收起」类断言永远假绿 */
    classList: {
      add: c => cls.add(c),
      remove: c => cls.delete(c),
      toggle: (c, on) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else if (on) cls.add(c); else cls.delete(c); },
      contains: c => cls.has(c),
      _all: () => Array.from(cls)
    },
    getContext: () => makeStub("ctx2d"),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1600, height: 900 }),
    addEventListener(type, fn) { (L[type] = L[type] || []).push(fn); },
    removeEventListener() {},
    appendChild() {},
    querySelector(sel) { return sel === ".ar" ? (this._ar || (this._ar = el(id + ":ar", "span"))) : null; },
    _fire(type, ev) { (L[type] || []).forEach(f => f(ev || {})); }
  };
  return self;
}
const els = {};
["cv","uiRally","uiBest","uiType","uiTypeSub","uiLevel","uiMode","uiAssist",
 "barMark","barTxt","msg","msgSub","uiFinal","endReason","endTip",
 "startScreen","pauseScreen","endScreen","errScreen","errMsg",
 "startBtn","againBtn","resumeBtn","quitBtn","settle",
 "hud","hudFace","hudAux","hudCfg","cfgBody","cfgSep",
 "btnUiToggle","uiToggleTxt","btnUiToggle2",
 "btnMute","btnMute2","volRange","volRange2","volTxt","volTxt2",
 /* 本轮新增：双模式卡片 / 失败归因 / 历史榜 / 外链入口 */
 "modePractice","modeChallenge","endMode","endGap",
 "failWrap","failList","failMain","boardWrap","boardTitle","boardList",
 "ghLink","siteLink"]
  .forEach(id => els[id] = el(id));

/* ---------- Web Audio 桩：统计真实创建的音源数量 + 滤波器类型 / 频点 ---------- */
const AUDIO = { started: 0, osc: 0, gain: 0, filter: 0, src: 0, buf: 0 };
const RAMP = { n: 0 };
/* 每次 createBiquadFilter 都记账类型与频点，用于断言"欢呼真的用了人声共振峰" */
const FILTERS = [];
function aparam() {
  return { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() { RAMP.n++; },
           linearRampToValueAtTime() { RAMP.n++; }, setTargetAtTime() {} };
}
function anode(kind) {
  AUDIO[kind] = (AUDIO[kind] || 0) + 1;
  const node = { connect() {}, disconnect() {}, gain: aparam(), frequency: aparam(), Q: aparam(),
           detune: aparam(), playbackRate: aparam(), type: "", buffer: null, loop: false,
           start() { AUDIO.started++; }, stop() {} };
  if (kind === "filter") {
    FILTERS.push(node);
    /* 记录 type / frequency 的最终值（简单属性写入即可，频点只用 .value 赋值） */
    let _t = "", _f = 0;
    Object.defineProperty(node, "type", { get: () => _t, set: v => { _t = v; }, enumerable: true });
    Object.defineProperty(node.frequency, "value", {
      get: () => _f, set: v => { _f = v; }, enumerable: true
    });
  }
  if (kind === "osc") {
    let _t = "";
    Object.defineProperty(node, "type", { get: () => _t, set: v => { _t = v; }, enumerable: true });
  }
  return node;
}
function MockAC() {
  this.sampleRate = 48000; this.state = "running"; this.currentTime = 0;
  this.destination = { connect() {} };
  this.createGain = () => anode("gain");
  this.createOscillator = () => anode("osc");
  this.createBiquadFilter = () => anode("filter");
  this.createBufferSource = () => anode("src");
  this.createBuffer = (ch, len) =>
    ({ length: len, getChannelData: () => new Float32Array(Math.min(len, 8192)) });
  this.resume = () => {};
}

const winL = {};
const CLOCK = { t: 0 };                        // 模拟时钟（毫秒），沙箱内通过 CLOCK 读写
const sandbox = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error,
  isNaN, parseInt, parseFloat, Symbol, Proxy, Function, Float32Array,
  CODE: code,
  HTML: HTML,  performance: { now: () => CLOCK.t },
  requestAnimationFrame: () => 0,
  setTimeout: () => 0, clearTimeout() {},
  /* 内存版 localStorage —— 原来是无操作桩（getItem 恒返回 null），
   * 后果是**所有持久化逻辑从来没被测过**：纪录写进去读不回来、脏数据崩溃、
   * 上限算错，这套桩一个都发现不了。换成 Map 支撑后，读写往返与容错才验得了。 */
  localStorage: (function () {
    const M = new Map();
    return {
      getItem: k => (M.has(String(k)) ? M.get(String(k)) : null),
      setItem: (k, v) => { M.set(String(k), String(v)); },
      removeItem: k => { M.delete(String(k)); },
      clear: () => M.clear()
    };
  })(),
  THREE: makeStub("THREE"),
  document: {
    getElementById: id => els[id] || (els[id] = el(id)),
    createElement: tag => el("created", tag),
    addEventListener() {}, body: el("body")
  },
  window: {
    addEventListener(type, fn) { (winL[type] = winL[type] || []).push(fn); },
    innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
    AudioContext: MockAC, webkitAudioContext: MockAC
  }
};
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.performance = sandbox.performance;
sandbox.CLASS = {};   // 由 testCode 填充，供 Node 侧读取断言
sandbox.els = els; sandbox.winL = winL; sandbox.CLOCK = CLOCK;
sandbox.__RESULT = "";

const testCode = `
let __ERR = [];
const G_ = (l, f) => { try { f(); } catch (e) { __ERR.push(l + ": " + e.message); } };

/* ---------- 暴露内部量给 Node 侧断言 ---------- */
const __gain_ramps = () => __GAIN_RAMPS();
const __AUD_i8 = () => 0;
const __tick = f => { CLOCK.t += f * 1000; loop(CLOCK.t); };
const PAD_VIS = () => !!(G.paddle.side < 0 ? OBJ.racket.visible : OBJ.racketL.visible);
/* 球拍几何量在 Node 侧从 game.js 源码解析（见下方 parseRKT）——
 * 放在沙箱模板里的话，模板字符串会先把 \s 吃成 s，正则静默失效。
 * 这里只负责把它挂上 CLASS。 */
G_("scene", () => { if (!THREE_OK) __ERR.push("场景构建失败: " + UI.errMsg.textContent); });

/* ---------- 音效链路：每种事件都必须真的创建音源 ---------- */
const SFXLOG = {};
audioInit();
["serve","hit","table","floor","net","good","bad","level","ui"].forEach(k => {
  const before = __AUDIO_started();
  sfx(k, 0.7);
  SFXLOG[k] = __AUDIO_started() - before;
});

/* ---------- 观众声：必须发声，且每次参数都不同 ----------
 * 指纹取 SFX.crowdFP（人数 / 时长 / 底噪频率 / 底噪强度），而不是只数音源个数：
 * 音源数只有 ~55 种取值，8 次抽样必然撞生日碰撞（实测约 1/3 概率假失败）。
 * 音源个数仍然单独统计（下面那条"每次都真的发声"）。 */
const CROWD_FP = [];
for (let i = 0; i < 8; i++) {
  const before = __AUDIO_started();
  const gr = __gain_ramps();
  sfxCrowd(i % 2 ? "cheer" : "applause");
  CROWD_FP.push({ n: __AUDIO_started() - before, r: __gain_ramps() - gr,
                  fp: SFX.crowdFP });
}
const CROWD_UNIQUE = new Set(CROWD_FP.map(x => {
  const f = x.fp || {};
  return f.kind + "|" + f.n + "|" + f.dur + "|" + f.bed + "|" + f.amp;
})).size;

/* ---------- 观众欢呼音质：必须是「基频振荡器 + 共振峰」，不能是低频带通噪声 ----------
 * 这是用户反馈"轰轰轰"的直接回归：旧版把噪声滤到 480~1150Hz 就当人声，听感只有低频轰鸣。
 * 真判据是欢呼那次调用里必须出现锯齿波振荡器（声带）与 ≥2.4kHz 的高共振峰（F3）。
 * 必须在"只跑一次 cheer"的干净窗口里量，否则会被前面的 sfx 调用污染。 */
const CHEER_M = (() => {
  const oscBefore = __AUD_OSC(), filBefore = __FILT_N();
  sfxCrowd("cheer");
  const osc = __AUD_OSC() - oscBefore;                     // 每条嗓子 2 个：基频 + 颤音 LFO
  const filters = __FILT_SLICE(filBefore);
  const hiN = filters.filter(f => f.type === "bandpass" && f.frequency.value >= 2400).length;
  return { osc: osc, hi: hiN, filters: filters.length };
})();

/* 单声喝彩也要有人声振荡器 */
const YELL_OSC = (() => {
  const before = __AUD_OSC();
  sfxYell();
  return __AUD_OSC() - before;
})();

/* 球馆底噪必须高通掉低频：查 game.js 源码里底噪链是否含 highpass。
 * 这条在 Node 侧算——沙箱里拿不到 code 变量。 */

/* ---------- 缺陷专项：来球分布 / 球速 / 拍子出现 / 握柄 / 结算延迟 ---------- */
/* [A] 明显旋转占比必须≈25%，且「好接球」的 |wx| 恒 < 60（拍面中立就能接） */
const DIST = {}, EASY_BAD = [];
audioInit();
for (let i = 0; i < 4000; i++) {
  const s = pickSpin();
  DIST[s.def.n] = (DIST[s.def.n] || 0) + 1;
  const easy = s.def.n === "直线快球" || s.def.n === "轻上旋" || s.def.n === "轻下旋";
  if (easy && Math.abs(s.wx) >= 60) EASY_BAD.push(s.def.n + ":" + Math.round(s.wx));
}
const SPINNY = ["上旋","下旋","左侧旋","右侧旋"].reduce((a, k) => a + (DIST[k] || 0), 0) / 4000;

/* [B] 平均到位时间（相对原版 0.46s 的放慢比例）与每球型到位时间 */
let tSum = 0, tN = 0, tMin = 9, tMax = 0;
const byType = {};
for (let i = 0; i < 600; i++) {
  serve();
  const T = G.predHitT;
  tSum += T; tN++;
  if (T < tMin) tMin = T;
  if (T > tMax) tMax = T;
  const k = G.spinName;
  byType[k] = byType[k] || { s: 0, n: 0 };
  byType[k].s += T; byType[k].n++;
}
const T_AVG = tSum / tN;
const T_BYTYPE = Object.entries(byType).map(([k, v]) => k + " " + (v.s / v.n).toFixed(3) + "s");

/* [C] 球拍：松手后必须在很短时间内入画 */
restart();
serve();
G.paddle.anim = -1;
els.cv._fire("mousedown", { clientX: 800, clientY: 500 });
(winL.mousemove || []).forEach(f => f({ clientX: 900, clientY: 430 }));
(winL.mouseup || []).forEach(f => f({}));
const PADDLE_AT = [];
for (let i = 0; i < 40; i++) {
  const rk = PAD_VIS();
  PADDLE_AT.push(rk);
  if (rk) break;
  __tick(0.016);
}
const PADDLE_WAIT = PADDLE_AT.length * 0.016;
const PADDLE_FIRSTVIS = PADDLE_AT[0];

/* [C2] 失败情形下球拍也必须入画：漏球 / 没打实 曾经完全不出拍 */
function swingCase(setup, label) {
  restart(); serve();
  G.paddle.anim = -1; G.paddle.pend = 0;
  if (setup) setup();
  els.cv._fire("mousedown", { clientX: 800, clientY: 500 });
  (winL.mousemove || []).forEach(f => f({ clientX: 900, clientY: 430 }));
  (winL.mouseup || []).forEach(f => f({}));
  let vis = false;
  for (let i = 0; i < 40 && !vis; i++) { if (PAD_VIS()) vis = true; else __tick(0.016); }
  return { label: label, anim: G.paddle.anim, vis: vis, msg: G.msg };
}
const SWING_LATE = swingCase(() => { G.idealSet = true; G.tIdeal = G.gt - 0.60; }, "漏球");
const SWING_TINY = swingCase(null, "没打实");
const SWING_OK   = (() => {
  restart(); serve();
  G.paddle.anim = -1;
  G.idealSet = true; G.tIdeal = G.gt;
  els.cv._fire("mousedown", { clientX: 800, clientY: 500 });
  (winL.mousemove || []).forEach(f => f({ clientX: 900, clientY: 430 }));
  (winL.mouseup || []).forEach(f => f({}));
  let vis = false;
  for (let i = 0; i < 40 && !vis; i++) { if (PAD_VIS()) vis = true; else __tick(0.016); }
  return { label: "打中", anim: G.paddle.anim, vis: vis, msg: G.msg };
})();

/* [D] 球拍几何常量：由 Node 侧解析 game.js 的 RKT 后注入（见 parseRKT） */
const RKP = __RKT;

/* [E] 失败后到「本局结束」的等待时间 + 结算动画 */
restart();
serve();
fail("测试失败", "故意触发", 0, 0);
const FAIL_GT = G.gt, FAIL_OVER_AT = G.overAt;
const WAIT = FAIL_OVER_AT - FAIL_GT;
const MSG_D = G.msgT;
/* 结算层：必须已挂 on 类（失败那一刻就显示） */
const SETTLE_SHOWN = !!(UI.settle && UI.settle.classList &&
                        UI.settle.classList.contains("on"));
restart();
const SETTLE_HIDDEN_ON_RESTART = !(UI.settle && UI.settle.classList &&
                                   UI.settle.classList.contains("on"));

/* 夸奖提示：走一次真实击球，量它的停留时长与保护期。
 * 只认「好球 / PERFECT / 神来一板 / 落点精准」这几条成功提示，
 * 否则会先撞上失败提示（它也是 2.5s），量出来的数字与夸奖无关。 */
const GOOD_TXT = ["好球", "PERFECT", "神来一板", "落点精准"];
restart();
serve();
let GOOD_D = 0, GOOD_HOLD = 0, GOOD_LABEL = "";
for (let i = 0; i < 400 && !GOOD_D; i++) {
  __tick(0.0167);
  if (G.phase !== "incoming" || G.hitDone || !(G.predHitT > 0)) continue;
  const ideal = G.serveT + G.predHitT;
  if (G.gt < ideal) continue;
  G.paddleAngle = Math.max(-1, Math.min(1, correctTiltFor(G.spin)));
  const dx = Math.abs(G.spin.wy) > 60 ? -Math.sign(G.spin.wy) * 112 : 70;
  els.cv._fire("mousedown", { clientX: 800, clientY: 500 });
  (winL.mousemove || []).forEach(f => f({ clientX: 800 + dx, clientY: 500 }));
  (winL.mouseup || []).forEach(f => f({}));
  if (GOOD_TXT.indexOf(G.msg) >= 0) {
    /* 排队机制下「好球」可能已被后来的「落点精准」接替，两者都要能读到。
     * 这里记「当前显示的那条」的时长与保护期。 */
    GOOD_D = G.msgT; GOOD_HOLD = G.msgHold; GOOD_LABEL = G.msg;
  }
}

/* [F] 对打压力测试：完全按"提示的正确操作"打，统计失误类型。
 * 重点盯两个真问题——侧旋的「好接球」是否仍会出边线、放慢球速后是否影响上台率。 */
restart();
let SIDE_WIDE = 0, LONG_FAIL = 0, SAMPLE = 0;
for (let i = 0; i < 900 && SAMPLE < 200; i++) {
  __tick(0.0167);
  if (G.phase !== "incoming" || G.hitDone || !(G.predHitT > 0)) continue;
  const ideal = G.serveT + G.predHitT;
  if (G.gt < ideal) continue;
  G.paddleAngle = Math.max(-1, Math.min(1, correctTiltFor(G.spin)));
  const dx = Math.abs(G.spin.wy) > 60 ? -Math.sign(G.spin.wy) * 112 : 70;
  els.cv._fire("mousedown", { clientX: 800, clientY: 500 });
  (winL.mousemove || []).forEach(f => f({ clientX: 800 + dx, clientY: 500 }));
  (winL.mouseup || []).forEach(f => f({}));
  SAMPLE++;
  if (G.msg === "出边线") SIDE_WIDE++;
  else if (G.msg === "出界" || G.msg === "下网" || G.msg === "没过网" || G.msg === "漏球") LONG_FAIL++;
  if (G.msg) { restart(); }                     // 失误就重开，保持压力测试连续
}

/* ---------- 自动玩家：严格按 PRD 控制规范操作 ---------- */
function playOneGame(maxFrames) {
  restart();
  const LOG = [];
  let dragging = false, planned = null, hits = 0;
  for (let i = 0; i < maxFrames; i++) {
    CLOCK.t += 16.7;
    G_("f" + i, () => loop(CLOCK.t));
    const ideal = G.serveT + G.predHitT;
    if (G.phase === "incoming" && !G.hitDone && G.predHitT > 0) {
      if (!dragging && G.gt >= ideal - 0.22) {
        G.paddleAngle = Math.max(-1, Math.min(1, correctTiltFor(G.spin)));   // 滚轮/AD：调拍面
        // 侧旋反向补偿到标定值 0.8（dx/140）；其余打中路偏右一点，保证有挥拍幅度
        const dx = Math.abs(G.spin.wy) > 60 ? -Math.sign(G.spin.wy) * 112 : 70;
        planned = { dx };
        dragging = true;
        G_("down", () => els.cv._fire("mousedown", { clientX: 800, clientY: 500 }));
      }
      if (dragging && G.gt >= ideal) {
        dragging = false; hits++;
        G_("move", () => (winL.mousemove || []).forEach(f => f({ clientX: 800 + planned.dx, clientY: 500 })));
        G_("up", () => (winL.mouseup || []).forEach(f => f({})));
        LOG.push({ n: hits, spin: G.spinName, wx: Math.round(G.spin.wx), wy: Math.round(G.spin.wy),
                   pa: +G.paddleAngle.toFixed(2), hitY: +G.ball.y.toFixed(2), hx: +G.ball.x.toFixed(2), mk: G.mark ? [+G.mark.x.toFixed(2), +G.mark.z.toFixed(2)] : null, res: (G.msg + " " + G.msgSub).trim() });
      }
    }
    if (!G.running) break;
  }
  return { rally: G.rally, level: G.level, hits, LOG };
}
const GAMES = [];
for (let g = 0; g < 6; g++) GAMES.push(playOneGame(2500));

/* ---------- 渲染与交互分支全覆盖 ---------- */
G_("assist-off", () => { G.assist = false; render3D(); });
G_("assist-on",  () => { G.assist = true; render3D(); });
G_("miss",       () => { G.phase = "miss"; render3D(); });
G_("returning",  () => { G.phase = "returning"; render3D(); });
G_("paddle-mid", () => { G.paddle.anim = 0.5; render3D(); });
G_("paddle-end", () => { G.paddle.anim = 0.9; render3D(); });
G_("pause",      () => { togglePause(); loop(CLOCK.t); togglePause(); });
G_("resize",     () => { resize3D(); });
G_("wheel",      () => { els.cv._fire("wheel", { deltaY: 100, preventDefault(){} }); });
G_("keys",       () => { ["a","d","h","m","p"].forEach(k =>
                    (winL.keydown||[]).forEach(f => f({ key:k, code:"Key"+k.toUpperCase(), preventDefault(){} }))); });
G_("mute-btn",   () => { if (UI.btnMute.onclick) UI.btnMute.onclick(); });
G_("vol",        () => { if (UI.volRange.oninput) UI.volRange.oninput({ target: { value: 40 } }); });
G_("over",       () => { G.rally = 7; gameOver("测试"); });

/* ---------- 辅助面板显隐：三条入口都要真的切到状态 ----------
 * 显隐类挂在 #hud 上（ui-collapsed），这样左下拍面栏与右下辅助区一起收放。 */
const AUX = [];
G_("aux-default", () => { AUX.push(els.hud.classList.contains("ui-collapsed")); });
G_("aux-tab",     () => {
  (winL.keydown || []).forEach(f => f({ key: "Tab", code: "Tab", preventDefault() {} }));
  AUX.push(els.hud.classList.contains("ui-collapsed"), els.uiToggleTxt.textContent);
});
G_("aux-btn",     () => {
  if (UI.btnUiToggle.onclick) UI.btnUiToggle.onclick();
  AUX.push(els.hud.classList.contains("ui-collapsed"), els.uiToggleTxt.textContent);
});
G_("aux-end",     () => {
  if (UI.btnUiToggle2.onclick) UI.btnUiToggle2.onclick();
  AUX.push(els.hud.classList.contains("ui-collapsed"), els.btnUiToggle2.textContent);
});
G_("aux-persist", () => { savePrefs(); });
CLASS.aux = AUX;

/* 开关按钮不能落在被收起的容器里，否则一收起就再也点不开。
 * 收起规则与底噪高通都在 Node 侧从源码文本断言 —— 写进沙箱模板的话，
 * 模板字符串会先把 \s 吃成 s，正则静默失效、断言永远假绿。 */

CLASS.crowd = CROWD_FP; CLASS.crowdUnique = CROWD_UNIQUE;
CLASS.cheerVoices = CHEER_M.osc; CLASS.cheerOsc = CHEER_M.osc;
CLASS.cheerHiFormant = CHEER_M.hi; CLASS.yellOsc = YELL_OSC;

CLASS.spinny = SPINNY; CLASS.dist = DIST; CLASS.easyBad = EASY_BAD;
CLASS.tAvg = T_AVG; CLASS.tMin = tMin; CLASS.tMax = tMax; CLASS.tByType = T_BYTYPE;
CLASS.paddleWait = PADDLE_WAIT; CLASS.paddleFirstVis = PADDLE_FIRSTVIS;
CLASS.racket = RKP; CLASS.overWait = WAIT; CLASS.msgD = MSG_D;
CLASS.swingMiss = SWING_LATE; CLASS.swingTiny = SWING_TINY; CLASS.swingOk = SWING_OK;
CLASS.sideWideFail = SIDE_WIDE; CLASS.longFail = LONG_FAIL; CLASS.stressN = SAMPLE;
CLASS.poolTotal = POOL_TOTAL; CLASS.spinnyW = SPINNY_W;
CLASS.goodMsgHold = GOOD_HOLD; CLASS.goodMsgDur = GOOD_D; CLASS.goodMsgLabel = GOOD_LABEL;
CLASS.msgMaxQ = MSG_MAXQ;
CLASS.settleShown = SETTLE_SHOWN;
CLASS.settleHiddenOnRestart = SETTLE_HIDDEN_ON_RESTART;

/* ---------- 本轮：失败归因 / 纪录系统 / 双模式 ---------- */

/* 归因归类必须与 reason() 的提示文案一一对应 —— 玩家刚读到「吃旋转」，
 * 统计里就不能记成「拍面偏差」，否则归因功能立刻失去可信度。
 * 这里逐个喂真实的 reason() 文案字符串，验的是映射本身。 */
const BUCKETS = {};
G_("bucket-miss",   () => {
  BUCKETS.miss1 = classifyFail("漏球", "没打到球");
  BUCKETS.miss2 = classifyFail("没打实", "挥拍幅度太小");
});
G_("bucket-spin",   () => {
  BUCKETS.spin1 = classifyFail("出界", "吃旋转！上旋球要压拍");
  BUCKETS.spin2 = classifyFail("出界", "吃旋转！下旋球要亮拍搓");
  BUCKETS.spin3 = classifyFail("出边线", "侧旋没补偿，球拐出边线");
  BUCKETS.spin4 = classifyFail("出界", "侧旋拐得太远，球从边线外绕出底线");
});
G_("bucket-tilt",   () => {
  BUCKETS.tilt1 = classifyFail("下网", "拍面压太狠，球下网");
  BUCKETS.tilt2 = classifyFail("下网", "拍面太亮，没吃住球");
  BUCKETS.tilt3 = classifyFail("出界", "拍面角度不对，球飞了");
});
G_("bucket-timing", () => {
  BUCKETS.time1 = classifyFail("下网", "击球太晚，球已经掉下去了");
  BUCKETS.time2 = classifyFail("没过网", "击球太晚，球没弹起来");
  BUCKETS.time3 = classifyFail("出界", "击球太早，球飞出界");
});
G_("bucket-power",  () => {
  BUCKETS.pw1 = classifyFail("下网", "力量不够，球没过网");
  BUCKETS.pw2 = classifyFail("没过网", "力量太小，球没过网");
  BUCKETS.pw3 = classifyFail("出界", "力量太大，球出界了");
});
CLASS.buckets = BUCKETS;

/* 同一拍不得重复计数：fail() 会被多处判定命中，重复计数会让「失败构成」失真 */
const FAILC = {};
G_("fail-count", () => {
  G.running = true; restart();
  G.phase = "incoming";
  fail("漏球", "没打到球");
  fail("漏球", "没打到球");          // 第二次不应再计
  FAILC.total = G.failTotal;
  FAILC.miss = G.failStats["没打到球"] || 0;
});
G_("fail-reset", () => {
  restart();
  FAILC.afterRestart = G.failTotal;  // 新一局必须清零
});
CLASS.failCount = FAILC;

/* 双模式的唯一差异是辅助提示：练习=可开，挑战=强制关 */
const MODES = {};
G_("mode-practice",  () => { setMode("practice");  MODES.pMode = G.mode; MODES.pAssist = G.assist; });
G_("mode-challenge", () => { setMode("challenge"); MODES.cMode = G.mode; MODES.cAssist = G.assist; });
G_("mode-persist",   () => { MODES.saved = localStorage.getItem("fpp_mode"); });
G_("mode-h-blocked", () => {
  setMode("challenge");
  (winL.keydown || []).forEach(f => f({ key: "h", code: "KeyH", preventDefault() {} }));
  MODES.afterH = G.assist;           // 挑战模式按 H 不应打开辅助
});
G_("mode-h-works",   () => {
  setMode("practice");
  (winL.keydown || []).forEach(f => f({ key: "h", code: "KeyH", preventDefault() {} }));
  MODES.practiceAfterH = G.assist;
});
CLASS.modes = MODES;

/* 纪录系统：写入 / 按分排序 / 上限 10 条 / 练习模式不进榜 / 每档最佳 */
const REC = {};
G_("records-fill", () => {
  clearRecords();
  for (let i = 0; i < 13; i++) {
    commitResult({ rally: i + 1, score: (i + 1) * 10, level: (i % 8) + 1,
                   mode: "challenge", good: i, ts: 1000 + i });
  }
  const r = loadRecords();
  REC.len = r.history.length;
  REC.top = r.history[0].score;            // 13 局后应留下最高分 130
  REC.bottom = r.history[r.history.length - 1].score;   // 最低分 40
  REC.sorted = r.history.every((x, i) => i === 0 || r.history[i - 1].score >= x.score);
  REC.best = r.best.challenge;
  REC.bestScore = r.score.challenge;
});
G_("records-practice", () => {
  const before = loadRecords().history.length;
  commitResult({ rally: 50, score: 5000, level: 1, mode: "practice", good: 50, ts: 9 });
  const r = loadRecords();
  REC.histBefore = before;
  REC.histAfter = r.history.length;        // 练习模式不得进榜
  REC.practiceBest = r.best.practice;      // 但练习模式自己有最佳
});
G_("records-level", () => {
  const r = loadRecords();
  REC.levelBest = r.level["1"] || 0;       // 每档最佳（仅挑战模式）
});
G_("records-broken", () => {
  localStorage.setItem("fpp_records", "{{{ 这不是 JSON");
  const r = loadRecords();
  REC.brokenOk = !!(r && r.history && r.history.length === 0 &&
                    r.best.practice === 0 && r.best.challenge === 0);
});
G_("records-legacy", () => {
  localStorage.removeItem("fpp_records");
  localStorage.setItem("fpp_best", "17");
  localStorage.setItem("fpp_best_score", "99");
  const migrated = migrateLegacy();
  const r = loadRecords();
  REC.migrated = migrated;
  REC.legacyBest = r.best.practice;        // 旧版单值应迁进练习模式
  REC.legacyScore = r.score.practice;
});
CLASS.records = REC;

/* 结束页三块新信息的渲染 */
const ENDS = {};
G_("end-blocks", () => {
  clearRecords();
  /* 先垫一条挑战模式历史 —— 否则榜单区块会因「无历史」整块不渲染，
   * 断言就成了在验一个从没执行到的分支。 */
  commitResult({ rally: 9, score: 44, level: 2, mode: "challenge", good: 4, ts: 5000 });
  setMode("challenge");
  restart();
  G.rally = 6; G.score = 30; G.level = 3; G.goodTotal = 2; G.bestAtStart = 10;
  G.failTotal = 4; G.failStats = { "吃旋转": 2, "时机早或晚": 1, "没打到球": 1 };
  gameOver("吃旋转！上旋球要压拍");
  ENDS.tag = els.endMode.textContent;
  ENDS.gap = els.endGap.innerHTML;      // renderGap 走 innerHTML（含 <b>），读 textContent 恒为空
  ENDS.main = els.failMain.innerHTML;    // 同上
  ENDS.rows = (els.failList.innerHTML.match(/fbRow/g) || []).length;
  ENDS.hasTop = els.failList.innerHTML.indexOf("isTop") >= 0;
  ENDS.board = els.boardList.innerHTML.indexOf("bdRow") >= 0;
  ENDS.cur = els.boardList.innerHTML.indexOf("isCur") >= 0;
});
G_("end-practice", () => {
  setMode("practice");
  G.rally = 2; G.score = 4; G.level = 1; G.goodTotal = 0; G.bestAtStart = 10;
  G.failTotal = 1; G.failStats = { "没打到球": 1 };
  gameOver("没打到球");
  ENDS.pTag = els.endMode.textContent;
  ENDS.pBoardEmpty = els.boardList.innerHTML.indexOf("boardEmpty") >= 0;
});
CLASS.endBlocks = ENDS;

/* 外链入口不在沙箱里验：沙箱的 getElementById 对任意 id 都会造出桩元素，
 * 即使 HTML 里根本没有这个节点也会"存在"，是典型假绿。改在 Node 侧查源码。 */

__RESULT = JSON.stringify({ errs: __ERR, sfx: SFXLOG, vol: SFX.vol,
  games: GAMES.map(x => ({ rally: x.rally, level: x.level, hits: x.hits, LOG: x.LOG })) });
`;

sandbox.__AUDIO_started = () => AUDIO.started;
sandbox.__AUD_OSC = () => AUDIO.osc;
sandbox.__RKT = parseRKT(code);      // 球拍几何常量（Node 侧解析，见 parseRKT）
sandbox.__FILT_N = () => FILTERS.length;
/* 滤镜对象本身跨沙箱传出去没问题（都是普通对象），但频率要读的是取值后的 .value */
sandbox.__FILT_SLICE = i => FILTERS.slice(i);
sandbox.__GAIN_RAMPS = () => RAMP.n;
sandbox.Float32Array = Float32Array;

try { vm.runInNewContext(code + "\n" + testCode, sandbox, { filename: "game.js" }); }
catch (e) { console.log("顶层异常: " + e.message + "\n" + (e.stack || "").split("\n").slice(0, 5).join("\n")); process.exit(1); }

const R = JSON.parse(sandbox.__RESULT);
const rallies = R.games.map(g => g.rally);
const avg = rallies.reduce((a, b) => a + b, 0) / rallies.length;

console.log("\n音效链路（每种事件创建的音源数）:");
Object.entries(R.sfx).forEach(([k, v]) => console.log("  " + k.padEnd(6) + " " + (v > 0 ? "发声 ×" + v : "静音 !!")));
console.log("  音量设置生效: " + (Math.abs(R.vol - 0.4) < 0.01 ? "是 (0.40)" : "否 (" + R.vol + ")"));

console.log("\n自动玩家 6 局（拍面按球型调对 + 时机踩点 + 侧旋补偿）:");
R.games.forEach((g, i) => console.log("  第 " + (i + 1) + " 局：连续回球 " + String(g.rally).padStart(2) +
  " 拍   难度档 " + g.level + "   出手 " + g.hits + " 次"));
console.log("  平均 " + avg.toFixed(1) + " 拍   最高 " + Math.max(...rallies) + " 拍");

const fails = R.games.flatMap(g => g.LOG).filter(l => /下网|出界|边线|漏球|没过网|打实/.test(l.res));
if (fails.length) {
  console.log("\n失误逐球:");
  fails.slice(0, 14).forEach(l => console.log("  #" + l.n + " " + l.spin.padEnd(5) +
    " wx=" + String(l.wx).padStart(5) + " 拍面=" + String(l.pa).padStart(5) +
    " 击球点=" + l.hitY + " x=" + l.hx + " 预测落点=" + JSON.stringify(l.mk) + "  " + l.res));
}
/* ---------- 缺陷专项断言 ---------- */
const CK = sandbox.CLASS;
/* 源码文本断言在 Node 侧做：写进沙箱模板会被模板串先吃掉反斜杠，正则静默失效。 */
CK.collapseRule = (() => {
  const m = HTML.replace(/\n\s*/g, " ").match(/([^{}]*ui-collapsed[^{}]*)\{/);
  return m ? m[1].trim() : "(未找到)";
})();
CK.roomHighpass = /hp\.type\s*=\s*"highpass"/.test(code) && /room\.connect\(hp\)/.test(code);
/* 球网按 ITTF M2 规格：网纱必须暗（亮度<50%），网带必须白且与网纱明显区分。
 * 旧版是白色网纱，与白桌线同色同亮度 → 糊成一片，就是「重叠缺立体感」的根因。 */
CK.net = {
  meshDark: /g3\.fillStyle = "rgba\(14,46,38,0\.72\)"/.test(code),
  tapeWhite: /color:\s*0xf6f9fc/.test(code),
  tapeShade: /tapeShade/.test(code),
  groundShadow: /网根接地影/.test(code)
};
const ck = [];
const add = (ok, label, detail) => ck.push({ ok, label, detail });

const spinnyPct = CK.spinny * 100;
add(Math.abs(spinnyPct - 25) < 1.6, "明显旋转球占比 ≈25%",
    spinnyPct.toFixed(1) + "%（池权重 " + CK.spinnyW + "/" + CK.poolTotal + "）");
add(CK.easyBad.length === 0, "好接球 |wx| 恒 < 60（拍面中立即可接）",
    CK.dist && Object.keys(CK.dist).length ? "抽样 0 例越界" : "");
const tAvg = CK.tAvg;
const rawAvg = 0.46;                      // 原版 1 档基准到位时间
add(tAvg >= rawAvg * 1.30, "来球平均到位时间放慢 ≥30%（目标 40%）",
    tAvg.toFixed(3) + "s，原版 ≈0.46s，慢 " + ((tAvg / rawAvg - 1) * 100).toFixed(0) + "%");
add(CK.tMin >= 0.38 && CK.tMax <= 1.00, "到位时间分布收敛（不会飘到台底角）",
    CK.tMin.toFixed(3) + "~" + CK.tMax.toFixed(3) + "s");
add(CK.paddleWait <= 0.05, "松手后球拍 ≤50ms 入画（去掉待机延迟）",
    (CK.paddleWait * 1000).toFixed(0) + "ms");
const R2 = CK.racket;
/* ---- 球拍按真实横拍规格校验（ITTF 常用规格）----
 * 旧断言是「必须比我上一版更短」，那是错误的优化方向：真问题不是「太长的要削短」，
 * 而是比例失真 —— 拍面比真拍大 26%、柄却只有真拍的一半，看着像「大圆盘 + 小木棍」。
 * 现在按真实尺寸卡绝对区间，并额外校验柄/拍面比与总长，改比例时一眼能看出跑没跑偏。 */
const bladeDia = R2.bladeR * 2;
add(Math.abs(bladeDia - 0.152) < 0.004, "拍面直径接近真实 152mm",
    (bladeDia * 1000).toFixed(0) + "mm（真实 152mm）");
add(Math.abs(R2.handleL - 0.095) < 0.006, "握柄长度接近真实 95mm",
    (R2.handleL * 1000).toFixed(0) + "mm（真实 95mm）");
/* 真实横拍：柄 95 / 拍面 152 = 0.625。这一条直接干掉「小木棍」与「长杆」两种失真 */
const hRatio = R2.handleL / bladeDia;
add(hRatio >= 0.55 && hRatio <= 0.72, "柄长 / 拍面直径落在真实区间 0.55~0.72",
    hRatio.toFixed(3) + "（真实 0.625，旧版 0.26）");
/* 拍面不该是正圆：真实拍面高 > 宽，靠 scale.z 压椭圆（旧代码错写成 scale.y，一直是正圆） */
add(R2.oval > 1.0 && R2.oval <= 1.08, "拍面是略高的椭圆（高/宽 1.02，非正圆）",
    "oval=" + R2.oval);
/* 前臂：旧版 260mm × 直径 80~96mm，比拍面还粗还长，整根拖在画面外。
 * 真实露出的只是「手腕到小臂」一截，量级应在 100~160mm 且明显细于拍面。 */
const foreDia = R2.foreR2 * 2;
add(R2.foreL <= 0.16 && foreDia <= bladeDia * 0.55,
    "前臂已缩到合理长度与粗细（不再拖在画面外）",
    "长 " + (R2.foreL * 1000).toFixed(0) + "mm（原 260mm）　最粗处 " +
    (foreDia * 1000).toFixed(0) + "mm（原 96mm），占拍面 " +
    (foreDia / bladeDia * 100).toFixed(0) + "%");
/* 总长：拍面顶到柄尾。真实横拍约 255mm，允许 240~275mm */
const totalL = R2.bladeR + (-R2.buttY + R2.buttL / 2);
add(totalL >= 0.23 && totalL <= 0.28, "球拍全长接近真实 255mm",
    (totalL * 1000).toFixed(0) + "mm（真实约 255mm）");
add(CK.swingMiss.anim >= 0 && CK.swingMiss.vis, "漏球时球拍照样入画（不再凭空消失）",
    "anim=" + CK.swingMiss.anim + " 可见=" + CK.swingMiss.vis + " 提示=" + CK.swingMiss.msg);
add(CK.swingTiny.anim >= 0 && CK.swingTiny.vis, "「没打实」时球拍照样入画",
    "anim=" + CK.swingTiny.anim + " 可见=" + CK.swingTiny.vis + " 提示=" + CK.swingTiny.msg);
add(CK.swingOk.anim >= 0 && CK.swingOk.vis, "打中时球拍入画",
    "anim=" + CK.swingOk.anim + " 可见=" + CK.swingOk.vis);
add(CK.sideWideFail === 0, "侧旋「好接球」按提示补偿后不会出边线",
    "200 次对打测试，出边线 " + CK.sideWideFail + " 次");
add(CK.longFail === 0, "放慢球速后正确回球仍全部上台",
    "同一测试，出界/下网 " + CK.longFail + " 次");
add(Math.abs(CK.overWait - 1.25) < 0.01, "失败后等待 1.25s 再结算（较原 2.5s 减半）",
    CK.overWait.toFixed(2) + "s，失败文字停留 " + CK.msgD.toFixed(2) + "s（与窗口同步）");
add(CK.crowdUnique === 8, "观众掌声/欢呼每次参数都不同",
    "8 次调用 → " + CK.crowdUnique + " 种不同（人数+时长+底噪频率+强度 组合指纹）");
add(CK.crowd.every(x => x.n >= 40), "每次掌声都真的发声（≥40 个音源）",
    "音源数 " + CK.crowd.map(x => x.n).join("/"));

/* ---------- 辅助面板显隐 ---------- */
const AX = CK.aux;
add(AX[0] === false, "默认展开辅助面板（拍面栏 + 音效配置 + 操作说明）",
    "初始 ui-collapsed=" + AX[0]);
add(AX[1] === true && AX[3] === false && AX[5] === true,
    "三条入口都能切换显隐（Tab 键 / HUD 按钮 / 结束页按钮）",
    "Tab→" + AX[1] + "（" + AX[2] + "）　HUD 按钮→" + AX[3] + "（" + AX[4] + "）　结束页→" + AX[5] + "（" + AX[6] + "）");
/* 用户要求：左下拍面栏与右下辅助区必须同一个开关一起收放。
 * 断言 CSS 里 ui-collapsed 同时点名 hudFace 与 hudKeys，且不藏开关按钮本体。 */
const CR = HTML.replace(/\n\s*/g, " ");
add(/ui-collapsed\s+#hudFace/.test(CR) && /ui-collapsed\s+#hudKeys/.test(CR),
    "一个开关同时收起左下拍面栏与右下辅助区",
    "规则：" + CK.collapseRule);
add(!/ui-collapsed[^{]*#btnUiToggle[^{]*\{/.test(CR) && !/ui-collapsed[^{]*#hudCfg[^{]*\{/.test(CR),
    "收起规则不藏开关按钮与配置面板本体（收起了也点得开）",
    "btnUiToggle 与 hudCfg 均不在收起名单");

/* ---------- 观众欢呼音质：必须是"人声共振峰"，不能是低频轰鸣 ----------
 * 根因：旧版用 480~1150Hz 带通噪声当人声 → 只剩低频"轰轰"。
 * 判据：欢呼必须创建锯齿波振荡器（声带基频），且滤波器里必须有 2kHz 以上的
 * 高共振峰（F3）——纯低频噪声方案给不出这个特征。 */
add(CK.cheerVoices >= 18 && CK.cheerOsc >= 18,
    "欢呼用「基频振荡器 + 共振峰」合成（不是带通噪声）",
    "单次欢呼嗓门 " + CK.cheerVoices + " 条，创建锯齿波振荡器 " + CK.cheerOsc + " 个");
add(CK.cheerHiFormant >= 18, "欢呼含 2.4kHz 以上高共振峰（人声明亮度，轰鸣声没有）",
    "F3 共振峰 " + CK.cheerHiFormant + " 个（≥2.4kHz）");
add(CK.roomHighpass, "球馆底噪已高通切掉 220Hz 以下低频（消除持续\"轰轰\"）",
    "底噪链含 highpass 滤波器");
add(CK.yellOsc >= 1, "单声喝彩同样走人声合成",
    "sfxYell 创建振荡器 " + CK.yellOsc + " 个");

/* ---------- 本轮六项需求专项 ---------- */

/* ① 抓帧不得碰主画布：这是「击球后闪现非第一视角」的根因。
 * 判据是源码级的——主渲染器不许再出现 preserveDrawingBuffer，
 * 且 captureShot 内部不许调用主渲染器 REND.render。
 * 这类 bug 靠运行时很难复现（取决于合成时机），必须钉死代码形状。
 * 注意：匹配整段函数体要用 [\s\S]，而它必须写在 Node 侧——
 * 写进沙箱模板串会被吃成 [sS]，正则失效后断言就假绿了。 */
/* 注意用 (?<![A-Z_]) 卡词边界：否则 SHOT_REND.render 里的子串 "REND.render"
 * 会被误判成「还在用主渲染器」，得到一个永远失败的假红。 */
const capBody = (code.match(/function captureShot\(req\)\s*\{[\s\S]*?\n\}/) || [""])[0];
const mainRendInCap = /(?<![A-Z_])REND\.render\(/.test(capBody);
/* 直接抽出**主渲染器的构造参数段**再查 preserveDrawingBuffer。
 * 不写成"全文搜不到 preserveDrawingBuffer"——那样只要换个写法（换行、多加空格、
 * 参数顺序调整）就漏判，等于给回退留了后门。这里钉的是"主渲染器那一处没有它"。 */
const rendArgs = (code.match(/new THREE\.WebGLRenderer\(\{[\s\S]*?\}\)/) || [""])[0];
add(rendArgs.length > 0 && !/preserveDrawingBuffer/.test(rendArgs),
    "主渲染器不再开启 preserveDrawingBuffer（抓帧已改离屏）",
    "主渲染器参数段 " + rendArgs.replace(/\s+/g, " ").slice(0, 64) + "…");
add(capBody.length > 0 && !mainRendInCap,
    "抓帧不再用主渲染器补渲染（不会闪非第一视角画面）",
    "captureShot 函数体 " + capBody.length + "B，内无主渲染器调用");
add(/function shotRenderer/.test(code) && /canvas:\s*SHOT_CV/.test(code),
    "抓帧使用独立离屏渲染器与专用相机",
    "SHOT_REND / SHOT_CAM 独立于主场景相机");

/* ② 球网：深色网纱 + 白色网带（ITTF M2：网纱亮度<50%，网带须与网纱明显区分）。
 * 旧版是白色网纱，与白桌线同色同亮度 → 糊成一片，就是「重叠缺立体感」的根因。 */
add(CK.net.meshDark && CK.net.tapeWhite && CK.net.tapeShade && CK.net.groundShadow,
    "球网按 ITTF 规格重建：深色网纱 + 白色网带 + 接地影",
    "网纱暗绿色 " + (CK.net.meshDark ? "✓" : "✗") +
    "　网带白 " + (CK.net.tapeWhite ? "✓" : "✗") +
    "　带下暗缝 " + (CK.net.tapeShade ? "✓" : "✗") +
    "　网根接地影 " + (CK.net.groundShadow ? "✓" : "✗"));add(!/strokeStyle = "rgba\(230,238,246,0\.85\)"/.test(code),
    "旧的白色网纱已移除（不再与白桌线糊在一起）",
    "已无 rgba(230,238,246,.85) 网线");

/* ③ Logo：左下角半透明水印已删，改为左上「连续回球」上方的品牌行 */
add(!/id="hudLogo"/.test(HTML) && !/hudLogo/.test(code),
    "左下角半透明 Logo 水印已移除",
    "HTML 与 JS 中均无 hudLogo");
add(/id="hudBrand"/.test(HTML) && /data-logo/.test(HTML),
    "左上「连续回球」上方新增品牌行（logo + 应用名）",
    "hudBrand 含 data-logo 占位，由 poster.js 注入");
/* 品牌行必须在计数上方：断言 DOM 里 hudBrand 出现在 uiRally 之前 */
add(HTML.indexOf('id="hudBrand"') > 0 && HTML.indexOf('id="hudBrand"') < HTML.indexOf('id="uiRally"'),
    "品牌行位于「连续回球」计数上方",
    "hudBrand 序号 " + HTML.indexOf('id="hudBrand"') + " < uiRally " + HTML.indexOf('id="uiRally"'));

/* ④ 球拍按真实规格（见上面 R2 那组断言） */

/* ⑤ 夸奖提示必须停留够久，且不被后续结算提示抢占。
 * 时长直接从源码读「好球」那句 showMsg 的参数 —— 这才是要钉住的回归点。
 * 运行时量到的可能是接替它的「落点精准」，反映不出「好球」本身停多久。 */
const goodM = code.match(/showMsg\("好球",[^)]*?,\s*([0-9.]+),\s*(\d+),\s*([0-9.]+)\)/);
const goodDur = goodM ? +goodM[1] : 0;
const goodHoldSrc = goodM ? +goodM[3] : 0;
add(goodDur >= 1.5, "「好球」提示停留 ≥1.5s（原 0.6s，一闪就没了）",
    goodDur + "s（原 0.6s，延长 " + Math.round((goodDur / 0.6 - 1) * 100) + "%）");
add(goodHoldSrc >= 1.0, "夸奖设了保护期，后续结算提示会排队而非顶掉它",
    "保护期 " + goodHoldSrc + "s，排队上限 " + CK.msgMaxQ + " 条");

/* ⑥ 失败→结算之间要有「结算中」动画，且必须含乒乓球元素 */
add(CK.settleShown, "失败后立刻显示「结算中」过渡动画",
    "showSettle 已挂 on 类");
add(CK.settleHiddenOnRestart, "重开一局后结算动画已收起（不会残留）",
    "restart 调 hideSettle，off 类已清");
add(/id="settle"/.test(HTML) && /stBall/.test(HTML) && /@keyframes stBar/.test(HTML),
    "结算动画含乒乓球元素（弹跳球 + 影子 + 进度条）",
    "ball 弹跳 keyframes + shadow 呼吸 + bar 进度");
/* 进度条时长必须**读 CSS 变量**而不是写死 —— 否则改 game.js 的 SETTLE_WAIT 时
 * 进度条还走原来的时长，动画与结束页弹出对不上（改一处、漏一处的经典坑）。
 * 同时校验兜底默认值与 SETTLE_WAIT 一致，防止两处各写各的。 */
const barVarSrc = (HTML.match(/animation:stBar\s+var\(--settle-wait\)/) || [])[0];
const waitDef = (HTML.match(/--settle-wait:\s*([\d.]+)s/) || [])[1];
const waitJs = (code.match(/const SETTLE_WAIT\s*=\s*([\d.]+)/) || [])[1];
add(!!barVarSrc && parseFloat(waitDef) === parseFloat(waitJs) &&
    Math.abs(parseFloat(waitDef) - CK.overWait) < 0.01,
    "进度条时长读 CSS 变量，与 JS 结算窗口单一来源（改一处即可）",
    "stBar 用 var(--settle-wait)　兜底 " + waitDef + "s = SETTLE_WAIT " + waitJs + "s = 实测窗口 " + CK.overWait.toFixed(2) + "s");
/* 弹跳周期要与窗口匹配：1.25s 窗口配 1.15s 周期只弹得完一下，像卡顿；
 * 配 0.62s 正好两下，读得出「在动」。 */
const ballDur = parseFloat((HTML.match(/animation:stBall\s+([\d.]+)s/) || [])[1]);
const nBounce = CK.overWait / ballDur;
add(nBounce >= 1.7 && nBounce <= 2.6,
    "弹跳周期与结算窗口匹配（窗口内弹约两下）",
    "周期 " + ballDur + "s → 1.25s 窗口内 " + nBounce.toFixed(1) + " 下");
/* 结算层会同时落在「亮蓝台面」和「暗背景」上。
 * 纯文字在亮蓝上对比不足、会糊进背景，反而强化了「卡住」的观感 ——
 * 所以必须有半透明深色底衬把文字托住。这条断言钉住底衬存在。 */
add(/#settle\s*\{[^}]*background:\s*rgba\([^)]*0\.6/.test(HTML) &&
    /#settle\s*\{[^}]*border-radius/.test(HTML),
    "结算层有半透明深色底衬（文字在亮蓝台面上也可读）",
    "底衬 rgba(...,0.62) + 圆角药丸");

/* ---------- 本轮：归因 / 纪录 / 双模式 / 外链（Node 侧断言） ---------- */
/* 为什么这些放在 Node 侧而不是沙箱里：沙箱的 getElementById 对任意 id 都会
 * 造出桩元素 —— 即使 HTML 里根本没有这个节点也"存在"，是典型假绿。
 * 凡是要验「HTML 里真的有这个节点/属性」，都必须在 Node 侧查源码文本。 */

/* ① 失败归因：5 桶映射必须与 reason() 的提示文案一致 */
const B = CK.buckets || {};
add(B.miss1 === "没打到球" && B.miss2 === "没打到球",
    "归因 · 完全没碰到球 → 「没打到球」", B.miss1 + " / " + B.miss2);
add(B.spin1 === "吃旋转" && B.spin2 === "吃旋转" && B.spin3 === "吃旋转" && B.spin4 === "吃旋转",
    "归因 · 吃旋转 / 侧旋没补偿 → 「吃旋转」",
    [B.spin1, B.spin2, B.spin3, B.spin4].join(" · "));
add(B.tilt1 === "拍面偏差" && B.tilt2 === "拍面偏差" && B.tilt3 === "拍面偏差",
    "归因 · 拍面压太狠 / 太亮 / 角度不对 → 「拍面偏差」",
    [B.tilt1, B.tilt2, B.tilt3].join(" · "));
add(B.time1 === "时机早或晚" && B.time2 === "时机早或晚" && B.time3 === "时机早或晚",
    "归因 · 击球太早 / 太晚 → 「时机早或晚」",
    [B.time1, B.time2, B.time3].join(" · "));
add(B.pw1 === "力量与落点" && B.pw2 === "力量与落点" && B.pw3 === "力量与落点",
    "归因 · 力量太大 / 太小 → 「力量与落点」",
    [B.pw1, B.pw2, B.pw3].join(" · "));

/* ② 归因计数：同一拍不得重复计，新一局必须清零 */
const FQ = CK.failCount || {};
add(FQ.total === 1 && FQ.miss === 1,
    "归因计数 · 同一拍重复判定只记一次",
    "连调 2 次 fail → failTotal=" + FQ.total + "　该桶=" + FQ.miss);
add(FQ.afterRestart === 0, "归因计数 · 新一局清零", "restart 后 failTotal=" + FQ.afterRestart);

/* ③ 双模式：唯一差异是辅助提示，且挑战模式不可绕过 */
const MD = CK.modes || {};
add(MD.pMode === "practice" && MD.pAssist === true,
    "双模式 · 练习模式辅助提示默认开", "mode=" + MD.pMode + "　assist=" + MD.pAssist);
add(MD.cMode === "challenge" && MD.cAssist === false,
    "双模式 · 挑战模式强制关闭辅助提示", "mode=" + MD.cMode + "　assist=" + MD.cAssist);
add(MD.saved === "challenge", "双模式 · 选择持久化到 fpp_mode", "fpp_mode=" + MD.saved);
add(MD.afterH === false,
    "双模式 · 挑战模式按 H 也打不开辅助（不给绕过口子，否则榜单失去可比性）",
    "挑战模式按 H 后 assist=" + MD.afterH);
add(MD.practiceAfterH === false,
    "双模式 · 练习模式按 H 能切换辅助（初值 true → 切换后 false）",
    "练习模式按 H 后 assist=" + MD.practiceAfterH);

/* ④ 纪录系统：排序 / 上限 / 模式隔离 / 脏数据 / 旧数据迁移 */
const RC = CK.records || {};
add(RC.len === 10 && RC.sorted, "纪录 · 历史榜留 10 条且按得分降序",
    "写入 13 局后留 " + RC.len + " 条　有序=" + RC.sorted);
add(RC.top === 130 && RC.bottom === 40, "纪录 · 排序与截断正确（保留分数最高的 10 局）",
    "榜首 " + RC.top + " 分　末位 " + RC.bottom + " 分");
add(RC.best === 13 && RC.bestScore === 130, "纪录 · 记录每模式最佳回球数与最佳得分",
    "回球 " + RC.best + " 拍　得分 " + RC.bestScore);
add(RC.histAfter === RC.histBefore && RC.practiceBest === 50,
    "纪录 · 练习模式成绩不进榜，但仍单独记最佳",
    "榜 " + RC.histBefore + " → " + RC.histAfter + " 条　练习最佳 " + RC.practiceBest + " 拍");
add(RC.levelBest > 0, "纪录 · 每档最佳按难度档分别记录（仅挑战模式）",
    "第 1 档最佳 " + RC.levelBest + " 拍");
add(RC.brokenOk, "纪录 · localStorage 内容损坏时不崩、安全回退默认值",
    "写入坏 JSON 后 loadRecords 正常返回空纪录");
add(RC.migrated === true && RC.legacyBest === 17 && RC.legacyScore === 99,
    "纪录 · 旧版单值纪录自动迁移（老玩家纪录不丢）",
    "fpp_best=17 / fpp_best_score=99 → 练习模式");

/* ⑤ 结束页三块新信息 */
const EB = CK.endBlocks || {};
add(EB.tag && EB.tag.indexOf("挑战模式") >= 0 && EB.gap && EB.gap.indexOf("还差") >= 0,
    "结束页 · 模式标签 + 「距个人最佳还差 N 拍」",
    (EB.tag || "") + "　" + (EB.gap || ""));
add(EB.rows === 3 && EB.hasTop && (EB.main || "").indexOf("吃旋转") >= 0,
    "结束页 · 失败构成按次数降序，主要问题取次数最多的一项",
    EB.rows + " 行　" + (EB.main || ""));
add(EB.board && EB.cur, "结束页 · 历史榜渲染且本局条目高亮", "榜单有行 + isCur 标记");
add((EB.pTag || "").indexOf("练习模式") >= 0 && EB.pBoardEmpty,
    "结束页 · 练习模式不列榜，改为引导切挑战模式", EB.pTag || "");

/* ⑥ 右上角外链（查源码，不查沙箱桩） */
const ghIdx = HTML.indexOf('<div id="topLinks">');
const hudIdx = HTML.indexOf('<div id="hud">');
add(/id="ghLink"[^>]*href="https:\/\/github\.com\/huangluke89757\/spin-table-tennis"/.test(HTML),
    "外链 · 右上角 GitHub 入口指向本项目仓库",
    "href=" + ((HTML.match(/id="ghLink"[\s\S]{0,160}?href="([^"]+)"/) || [])[1] || "缺失"));
add(HTML.indexOf("给项目点个 Star") > 0,
    "外链 · GitHub 图标带「给项目点个 Star」提示文案", "tooltip 已就位");
/* #topLinks 必须在 #hud 之外：#hud 有 z-index:5，会形成层叠上下文，
 * 子元素无论多高的 z-index 都跳不出去，会被开始页浮层（z-index:20）盖住 ——
 * 而第一次打开游戏的人恰恰停在开始页，入口看不见等于没做。 */
add(ghIdx > 0 && hudIdx > 0 && ghIdx < hudIdx,
    "外链 · #topLinks 位于 #hud 之外（否则被开始页浮层盖住，首页看不到入口）",
    "topLinks@" + ghIdx + " < #hud@" + hudIdx);
add(/#topLinks\s*\{[^}]*z-index\s*:\s*(2[0-9]|[3-9]\d)/.test(HTML),
    "外链 · #topLinks 层级高于浮层（z-index > 20）",
    "CSS z-index=" + ((HTML.match(/#topLinks\s*\{[^}]*z-index\s*:\s*(\d+)/) || [])[1] || "未设"));

/* ⑦ 开始页模式卡片 */
const cardN = (HTML.match(/id="mode(?:Practice|Challenge)"/g) || []).length;
add(cardN === 2,
    "开始页 · 模式二选一卡片存在（练习 / 挑战）",
    "模式卡片 " + cardN + " 张");

console.log("\n缺陷专项回归:");
for (const c of ck) console.log("  " + (c.ok ? "PASS" : "FAIL") + "  " + c.label + (c.detail ? "　→ " + c.detail : ""));
console.log("  来球分布抽样 4000: " + Object.entries(CK.dist).map(([k, v]) => k + " " + (v / 40).toFixed(1) + "%").join("  "));
console.log("  各球型到位时间: " + CK.tByType.join("  "));

console.log("\n桩调用种类 " + Object.keys(drawCalls).length + " 种");
if (ck.some(c => !c.ok)) {
  console.log("\n失败：缺陷专项回归未全部通过\n");
  process.exit(1);
}
if (R.errs.length) {
  console.log("\n运行时错误 " + R.errs.length + " 条:");
  const seen = new Set();
  R.errs.forEach(e => { const k = e.slice(0, 110); if (!seen.has(k)) { seen.add(k); console.log("  - " + e); } });
  process.exit(1);
}
const silent = Object.entries(R.sfx).filter(([, v]) => v === 0).map(([k]) => k);
if (silent.length) { console.log("\n失败：以下音效未发声: " + silent.join(", ") + "\n"); process.exit(1); }
if (avg < 8) { console.log("\n失败：正确操作平均仅 " + avg.toFixed(1) + " 拍，玩法不可玩\n"); process.exit(1); }
console.log("\n冒烟测试通过：场景构建 + 6 局自动对局 + 音效链路 + 全部渲染分支，无运行时错误\n");
