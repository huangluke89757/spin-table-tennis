// 终局标定：在 _calib2 的侧向参数基础上，补搜「力量—弧线压平」项 pwLoft
// 目标：正确操作在 球型 × 击球高度 × 力量 × 击球横向位置 全维度上台；错误拍面 / 侧旋不补偿必失误
const fs = require("fs");


const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;
const src = fs.readFileSync(ROOT + "/game.js", "utf8");
eval(src.slice(src.indexOf("/* ==================== 1."), src.indexOf("/* ==================== 3.")));
const K0 = eval("(" + src.match(/const K = (\{[\s\S]*?\});/)[1] + ")");
const HALFW = 0.7625;

const FIX = { vxK: 1.605, centerK: 2.931, sideK: 3.154, sideSpin: 112 };
const SPINS = [
  { n: "上旋",   wx:  300, wy:   0 },
  { n: "下旋",   wx: -300, wy:   0 },
  { n: "右侧旋", wx:    0, wy: 280 },
  { n: "左侧旋", wx:    0, wy: -280 },
  { n: "直球",   wx:    0, wy:   0 }
];
const YS  = [0.87, 0.95, 1.05, 1.18];
const PWS = [0.3, 0.6, 0.9];
const HX  = [-0.60, -0.32, 0, 0.32, 0.60];

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
function goodAim(sp) { return Math.abs(sp.wy) > 60 ? -Math.sign(sp.wy) * 0.85 : 0; }

function hit(P, sp, tilt, aim, power, hitY, hx) {
  const tiltErr = tilt - correctTilt(sp);
  const speed = 5.0 + power * 3.1;
  let vy = P.base + P.errK * tiltErr + P.loftK * (-tilt) + (0.94 - hitY) * P.hK - power * P.pwLoft;
  vy = Math.max(-0.8, Math.min(3.6, vy));
  const vx = aim * FIX.vxK * (0.5 + power * 0.5) + (sp.wy / 300) * FIX.sideK - (hx || 0) * FIX.centerK;
  const r = shoot({ x: hx || 0, y: hitY, z: 1.30, vx, vy, vz: -speed,
                    wx: tilt * P.spinMag + sp.wx * 0.10, wy: -aim * FIX.sideSpin, wz: 0 });
  return { c: cls(r), x: r.z1x, z: r.z1, r };
}

function score(P) {
  let s = 0;
  for (const sp of SPINS) {
    const ct = correctTilt(sp), aim = goodAim(sp);
    for (const y of YS) for (const pw of PWS) for (const hx of HX) {
      const r = hit(P, sp, ct, aim, pw, y, hx);
      if (r.c === "in") { s += 1; if (Math.abs(r.x) > 0.62) s -= 1; } else s -= 3;
      const bad = hit(P, sp, ct === 0 ? 0.9 : -ct, aim, pw, y, hx);
      if (bad.c !== "in") s += 1; else s -= 2;
      if (Math.abs(sp.wy) > 60) {
        const nb = hit(P, sp, ct, 0, pw, y, hx);
        if (nb.c !== "in") s += 1; else s -= 2;
      }
    }
  }
  for (const pw of PWS) {
    const R = hit(P, { wx: 0, wy: 0 }, 0,  0.85, pw, 0.95, 0);
    const L = hit(P, { wx: 0, wy: 0 }, 0, -0.85, pw, 0.95, 0);
    if (R.c === "in" && R.x > 0.18) s += 2; else s -= 2;
    if (L.c === "in" && L.x < -0.18) s += 2; else s -= 2;
  }
  return s;
}

function rand() {
  return {
    base: 1.2 + Math.random() * 1.4, errK: 0.2 + Math.random() * 1.0,
    loftK: Math.random() * 1.0, hK: 0.5 + Math.random() * 3.5,
    spinMag: 60 + Math.random() * 140, pwLoft: Math.random() * 1.2
  };
}
let best = null, bestS = -1e9;
const N = Number(process.argv[2] || 700);
for (let i = 0; i < N; i++) { const P = rand(); const s = score(P); if (s > bestS) { bestS = s; best = P; } }
for (let round = 0; round < 3; round++) {
  const d = 0.26 / (round + 1);
  for (let i = 0; i < 500; i++) {
    const P = {
      base: Math.max(0.4, best.base + (Math.random() - 0.5) * d * 3),
      errK: Math.max(0.05, best.errK + (Math.random() - 0.5) * d * 2),
      loftK: Math.max(0, best.loftK + (Math.random() - 0.5) * d * 2),
      hK: Math.max(0.1, best.hK + (Math.random() - 0.5) * d * 8),
      spinMag: Math.max(20, best.spinMag + (Math.random() - 0.5) * d * 300),
      pwLoft: Math.max(0, best.pwLoft + (Math.random() - 0.5) * d * 2)
    };
    const s = score(P); if (s > bestS) { bestS = s; best = P; }
  }
}
const total = SPINS.length * YS.length * PWS.length * HX.length * 2
            + 2 * YS.length * PWS.length * HX.length + PWS.length * 4;
console.log("\n得分 " + bestS + " / " + total);
console.log("base=" + best.base.toFixed(3) + "  errK=" + best.errK.toFixed(3) + "  loftK=" + best.loftK.toFixed(3) +
            "  hK=" + best.hK.toFixed(3) + "  spinMag=" + best.spinMag.toFixed(0) + "  pwLoft=" + best.pwLoft.toFixed(3));
console.log("vxK=" + FIX.vxK + "  centerK=" + FIX.centerK + "  sideK=" + FIX.sideK + "  sideSpin=" + FIX.sideSpin);

console.log("\n--- 正确操作：球型 × 击球横向位置（每格 12 次）---");
let header = "        "; HX.forEach(x => header += x.toFixed(2).padStart(6)); console.log(header);
for (const sp of SPINS) {
  let row = sp.n.padEnd(8);
  for (const hx of HX) {
    let bad = 0;
    for (const y of YS) for (const pw of PWS)
      if (hit(best, sp, correctTilt(sp), goodAim(sp), pw, y, hx).c !== "in") bad++;
    row += (bad === 0 ? "   OK" : "  X" + bad).padStart(6);
  }
  console.log(row);
}
console.log("\n--- 错误拍面必须失误 / 侧旋不补偿必须失误 ---");
for (const sp of SPINS) {
  let a = 0, b = 0, tot = 0;
  for (const y of YS) for (const pw of PWS) for (const hx of HX) {
    tot++;
    if (hit(best, sp, correctTilt(sp) === 0 ? 0.9 : -correctTilt(sp), goodAim(sp), pw, y, hx).c === "in") a++;
    if (Math.abs(sp.wy) > 60 && hit(best, sp, correctTilt(sp), 0, pw, y, hx).c === "in") b++;
  }
  console.log("  " + sp.n.padEnd(6) + " 错拍面上台 " + a + "/" + tot +
              (Math.abs(sp.wy) > 60 ? "   不补偿上台 " + b + "/" + tot : ""));
}
console.log("\n--- 线路控制（直球满幅瞄准落点 x）---");
for (const pw of PWS) {
  const R = hit(best, { wx: 0, wy: 0 }, 0,  0.85, pw, 0.95, 0);
  const L = hit(best, { wx: 0, wy: 0 }, 0, -0.85, pw, 0.95, 0);
  console.log("  力量 " + pw.toFixed(2) + "  右 " + R.c + " x=" + (R.x || 0).toFixed(2) +
              "   左 " + L.c + " x=" + (L.x || 0).toFixed(2));
}
