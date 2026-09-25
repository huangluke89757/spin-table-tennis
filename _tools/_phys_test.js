// 回归测试：直接从 game.js 抽取物理内核（第 1~2 节），验证弹道求解与核心玩法判定
// 运行： node _phys_test.js     改动 K 或物理参数后必须重跑
const fs = require("fs");


const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;
const src = fs.readFileSync(ROOT + "/game.js", "utf8");
eval(src.slice(src.indexOf("/* ==================== 1."), src.indexOf("/* ==================== 3.")));
// const 声明在 eval 作用域内不会外泄，单独解析出 K
const K = eval("(" + src.match(/const K = (\{[\s\S]*?\});/)[1] + ")");
const HALFW = 0.7625;

const TOP = { wx: 300, wy: 0 }, BACK = { wx: -300, wy: 0 };
const RIGHT = { wx: 0, wy: 280 }, LEFT = { wx: 0, wy: -280 }, FLAT = { wx: 0, wy: 0 };

function cls(r) {
  if (r.net) return "net";
  if (r.z1 === null) return "out";
  if (r.z1 > -0.04) return "short";
  if (r.z1 < -1.36) return "out";
  if (Math.abs(r.z1x) > HALFW) return "wide";
  return "in";
}
function correctTilt(sp) {
  if (Math.abs(sp.wx) < 60 && Math.abs(sp.wy) < 60) return 0;
  if (Math.abs(sp.wx) >= Math.abs(sp.wy)) return Math.max(-1, Math.min(1, -sp.wx / 260));
  return 0;
}
/* 与 game.js 的 doHit 保持一致的回球公式 */
function hit(sp, tilt, aim, power, hitY, timErr, hx) {
  const tiltErr = tilt - correctTilt(sp);
  const speed = 5.0 + power * 3.1;
  let vy = K.base + K.errK * tiltErr + K.loftK * (-tilt) - timErr * K.timK + (0.94 - hitY) * K.hK - power * K.pwLoft;
  vy = Math.max(-0.8, Math.min(3.6, vy));
  const vx = aim * K.vxK * (0.5 + power * 0.5) + (sp.wy / 300) * K.sideK - (hx||0) * K.centerK;
  const r = shoot({ x: 0, y: hitY, z: 1.30, vx, vy, vz: -speed,
                    wx: tilt * K.spinMag + sp.wx * 0.10, wy: -aim * K.sideSpin, wz: 0 });
  return { c: cls(r), z1: r.z1, z1x: r.z1x };
}

/* 与 game.js 的 serve() 完全一致：逐级放宽重试 + 直球兜底。
 * 注意兜底那一步很重要——solveServe 内部用 Math.random() 选发球起始横位，
 * 侧旋这类苛刻组合偶发（约 1/40）在 5 级放宽内仍解不出，此时 game.js 会退化成直球发球。
 * 测试必须覆盖同一条链路，否则会把「偶发退化」误判成 bug，也会漏掉「退化球是否合法」。 */
function solveRetry(spin, tz, tt) {
  let s = null;
  for (let r = 0; r < 5 && !s; r++) s = solveServe(spin, tz, tt, r);
  return { sol: s, degraded: !s, fallback: s ? null : solveServe({ wx: 0, wy: 0 }, 0.85, tt, 3) };
}

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log("  PASS  " + label); }
  else { fail++; console.log("  FAIL  " + label + (extra ? "   " + extra : "")); }
}
const t = (l, sp, tl, aim, expect) => {
  const r = hit(sp, tl, aim, 0.5, 0.92, 0);
  ok(expect === "in" ? (r.c === "in") : (r.c !== "in"), l,
     "实际 " + r.c + (r.z1 === null ? "" : " 落点 " + r.z1.toFixed(2)));
};

console.log("\n[1] 发球求解器：五类来球都能解出合法弹道");
for (const s of [{ n:"上旋  ", wx: 300, wy: 0 }, { n:"下旋  ", wx: -300, wy: 0 },
                 { n:"右侧旋", wx: 0, wy: 260 }, { n:"左侧旋", wx: 0, wy: -260 },
                 { n:"直球  ", wx: 0, wy: 0 }]) {
  const sr = solveRetry({ wx: s.wx, wy: s.wy }, 0.85, 0.42);
  const sol = sr.sol || sr.fallback;
  if (!sol) { ok(false, s.n + " 求解成功（含直球兜底）"); continue; }
  ok(true, s.n + " 求解成功" + (sr.degraded ? "（走直球兜底，偶发退化）" : ""));
  const r = sol.r;
  ok(r.z1 < -0.12 && r.z1 > -1.32, s.n + " 第一落点在对手半台", "z1=" + r.z1.toFixed(2));
  ok(r.z2 > 0.15 && r.z2 < 1.30, s.n + " 第二落点在玩家半台", "z2=" + r.z2.toFixed(2));
  ok(r.hitT > 0.20 && r.hitT < 1.2, s.n + " 到位时间合理", "t=" + r.hitT.toFixed(3));
  ok(r.hitY > 0.84 && r.hitY < 1.26, s.n + " 击球高度可打", "y=" + r.hitY.toFixed(2));
}

console.log("\n[2] 旋转物理方向");
// 同发射参数下直接比较：球下降到台面高度时飞了多远（上旋更短＝下坠更快）
function dropDist(wx) {
  const s = makeBall();
  Object.assign(s, { x: 0, y: 1.05, z: -1.00, vx: 0, vy: -0.5, vz: 7, wx, wy: 0, wz: 0 });
  for (let i = 0; i < 900; i++) { step(s, 1 / 300); if (s.y <= 0.80) break; }
  return s.z;
}
const dTop = dropDist(320), dBack = dropDist(-320);
ok(dTop < dBack, "上旋比下旋下坠快", "上旋 " + dTop.toFixed(2) + "m vs 下旋 " + dBack.toFixed(2) + "m");
function sideDx(sign) {
  const s = makeBall();
  Object.assign(s, { x:0, y:1.0, z:-0.6, vx:0, vy:-1.2, vz:6, wx:0, wy:sign*280, wz:0 });
  for (let i = 0; i < 600; i++) if (step(s, 1/300) === "table") break;
  for (let i = 0; i < 30; i++) step(s, 1/300);
  return s.x;
}
ok(sideDx(1) > 0.05, "右侧旋落台后继续右偏", "dx=" + sideDx(1).toFixed(3));
ok(sideDx(-1) < -0.05, "左侧旋落台后继续左偏", "dx=" + sideDx(-1).toFixed(3));
function keepVz(wx) {
  const s = makeBall();
  Object.assign(s, { x:0, y:0.95, z:-0.4, vx:0, vy:-1.5, vz:7, wx, wy:0, wz:0 });
  const v0 = s.vz;
  for (let i = 0; i < 600; i++) if (step(s, 1/300) === "table") break;
  return s.vz / v0;
}
ok(keepVz(400) > keepVz(-400), "上旋落台前冲、下旋落台减速",
   "上旋 " + (keepVz(400)*100).toFixed(0) + "% vs 下旋 " + (keepVz(-400)*100).toFixed(0) + "%");

console.log("\n[3] 核心玩法：拍面接对上台 / 接错失误");
t("上旋 + 压拍 → 上台", TOP, -0.8, 0, "in");
t("上旋 + 亮拍 → 失误", TOP, 0.8, 0, "bad");
t("上旋 + 中性 → 失误", TOP, 0, 0, "bad");
t("下旋 + 亮拍 → 上台", BACK, 0.8, 0, "in");
t("下旋 + 压拍 → 失误", BACK, -0.8, 0, "bad");
t("直球 + 中性 → 上台", FLAT, 0, 0, "in");
t("右侧旋 + 左补偿 → 上台", RIGHT, 0, -0.8, "in");
t("右侧旋 + 不补偿 → 失误", RIGHT, 0, 0, "bad");
t("左侧旋 + 右补偿 → 上台", LEFT, 0, 0.8, "in");
t("左侧旋 + 不补偿 → 失误", LEFT, 0, 0, "bad");

console.log("\n[4] 直球往两侧打也要能上台（PRD：线路 左/中/右）");
for (const aim of [-0.85, -0.6, -0.3, 0.3, 0.6, 0.85]) {
  const r = hit(FLAT, 0, aim, 0.5, 0.92, 0);
  ok(r.c === "in", "直球 线路 " + aim.toFixed(2) + " → 上台", "实际 " + r.c);
}

/* 时机惩罚 = dt × timK 直接叠加在出球抬升上，落点随 dt 单调变化。
 * ±0.06s 内净效果小于 0.26 m/s，肉眼不可辨；越早弧线越高越过底线、越晚越容易下网。 */
console.log("\n[5] 时机惩罚：落点随偏差单调变化，早→出界、晚→下网");
const zAt = dt => hit(TOP, -0.8, 0, 0.5, 0.92, dt);
for (const dt of [-0.04, 0, 0.06]) {
  const r = zAt(dt);
  ok(r.c === "in", "时机 " + (dt < 0 ? "早 " : dt > 0 ? "晚 " : "准 ") + Math.abs(dt).toFixed(2) +
     "s → 仍在台上", "实际 " + r.c + " 落点 " + (r.z1 === null ? "出界" : r.z1.toFixed(2)));
}
ok(zAt(-0.18).c !== "in", "早 0.18s → 弧线过高飞出底线", "实际 " + zAt(-0.18).c);
// 单调性：越早弧线越高、落点越浅
{
  const a = zAt(-0.04), b = zAt(-0.10), c = zAt(-0.16);
  ok(a.c === "in" && (b.z1 === null || b.z1 < a.z1) && (c.z1 === null || c.z1 < (b.z1 === null ? -9 : b.z1)),
     "越早落点越浅（弧线越来越高）",
     "-0.04s→" + (a.z1 === null ? "出界" : a.z1.toFixed(2)) +
     "  -0.10s→" + (b.z1 === null ? "出界" : b.z1.toFixed(2)) +
     "  -0.16s→" + (c.z1 === null ? "出界" : c.z1.toFixed(2)));
}

console.log("\n[6] 鲁棒性：力量与击球高度全区间可打");
/* 力量上限落在 (0.65, 0.8] 区间：混合发力（0.65·速度 + 0.35·幅度）下，
 * 常规挥拍都能上台，只有刻意把速度和幅度都拉满才会越过底线——「力量」是可决策的变量。 */
for (const pw of [0.12, 0.3, 0.5, 0.65]) {
  const r = hit(TOP, -0.8, 0, pw, 0.92, 0);
  ok(r.c === "in", "力量 " + pw.toFixed(2) + " → 上台", "实际 " + r.c + " 落点 " + (r.z1 === null ? "出界" : r.z1.toFixed(2)));
}
ok(hit(TOP, -0.8, 0, 1.0, 0.92, 0).c !== "in", "力量 1.00 → 刻意满力会出界（风险反馈）");
for (const hy of [0.86, 0.96, 1.06, 1.16, 1.26]) {
  const r = hit(FLAT, 0, 0, 0.5, hy, 0);
  ok(r.c === "in", "击球高度 " + hy.toFixed(2) + " → 上台", "实际 " + r.c);
}

console.log("\n[7] 性能");
/* 为什么这样测：
 * ① 先预热。首次调用要过 JIT 解释器，把冷启动算进平均会得到偏高的数字——
 *    原来的写法（30 次直接平均）就受这个影响，且受机器负载影响，是个不稳定测试。
 * ② 取多批的**最小值**而非平均。最小值反映"这段代码能跑多快"（性能容量），
 *    平均值会被系统调度、GC、其它进程污染。用最小值才能让阈值有明确含义。
 * ③ 用 hrtime 而不是 Date.now()：后者只有 1ms 分辨率，对 20~30ms 的量级太粗。 */
function solveBatch(n) {
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) solveRetry({ wx: 250, wy: 120 }, 0.8, 0.42);
  return Number(process.hrtime.bigint() - t) / 1e6 / n;
}
for (let i = 0; i < 3; i++) solveBatch(10);                 // 预热
const batches = [];
for (let i = 0; i < 6; i++) batches.push(solveBatch(10));
const best = Math.min.apply(null, batches);
/* 阈值 35ms 的依据：优化后实测 Node 22 ≈ 26ms、Node 25 ≈ 20ms，留约 30% 余量；
 * 若回归到优化前的 ~45ms 则必然触发。 */
ok(best < 35, "单次发球求解最快 " + best.toFixed(1) + "ms（阈值 35ms）",
   "各批 " + batches.map(x => x.toFixed(1)).join("/") + " ms");

console.log("\n结果: " + pass + " 通过 / " + fail + " 失败\n");
process.exit(fail ? 1 : 0);
