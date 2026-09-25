// 发球求解器：性能基准 + 新旧实现数值一致性对比
// 用法： node _phys_perf.js            → 性能数字
//        node _phys_perf.js --compare  → 新旧内核逐位对比（判定必须一致）
const fs = require("fs");
const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;
const src = fs.readFileSync(ROOT + "/game.js", "utf8");
const NEW = src.slice(src.indexOf("/* ==================== 1."), src.indexOf("/* ==================== 3."));

if (process.argv.indexOf("--compare") >= 0) {
  const { execFileSync } = require("child_process");


  // 从新内核还原旧内核：hypot + 返回数组 + 每步算 spinAmt
  const OLD = NEW
    .replace(
`const A = { x: 0, y: 0, z: 0 };
function accel(s) {
  const v = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
  A.x = -DRAG_K * v * s.vx + MAG_K * (s.wy * s.vz - s.wz * s.vy);
  A.y = -DRAG_K * v * s.vy - GRAV + MAG_K * (s.wz * s.vx - s.wx * s.vz);
  A.z = -DRAG_K * v * s.vz + MAG_K * (s.wx * s.vy - s.wy * s.vx);
}
function step(s, dt) {
  accel(s);
  s.vx += A.x * dt; s.vy += A.y * dt; s.vz += A.z * dt;`,
`function accel(s) {
  const v = Math.hypot(s.vx, s.vy, s.vz);
  let ax = -DRAG_K * v * s.vx;
  let ay = -DRAG_K * v * s.vy - GRAV;
  let az = -DRAG_K * v * s.vz;
  ax += MAG_K * (s.wy * s.vz - s.wz * s.vy);
  ay += MAG_K * (s.wz * s.vx - s.wx * s.vz);
  az += MAG_K * (s.wx * s.vy - s.wy * s.vx);
  return [ax, ay, az];
}
function step(s, dt) {
  const [ax, ay, az] = accel(s);
  s.vx += ax * dt; s.vy += ay * dt; s.vz += az * dt;`)
    .replace(/\n  \/\* spinAmt[\s\S]*?\*\//, "\n  s.spinAmt = Math.hypot(s.wx, s.wy, s.wz);");

  if (!/Math\.hypot\(s\.vx/.test(OLD)) { console.error("还原旧内核失败，脚本需更新"); process.exit(2); }

  const DRIVER = `
const HALFW = 0.7625;
function cls(r) {
  if (r.net) return "net";
  if (r.z1 === null) return "out";
  if (r.z1 > -0.04) return "short";
  if (r.z1 < -1.36) return "out";
  if (Math.abs(r.z1x) > HALFW) return "wide";
  return "in";
}
const spins = [{ wx: 300, wy: 0 }, { wx: -300, wy: 0 }, { wx: 0, wy: 260 },
               { wx: 0, wy: -260 }, { wx: 0, wy: 0 }, { wx: 250, wy: 120 }];
const rows = [];
for (const sp of spins)
  for (let vx = -1.6; vx <= 1.6; vx += 0.4)
    for (let vy = -2.4; vy <= 1.4; vy += 0.4)
      for (let vz = 4.4; vz <= 8.6; vz += 0.6) {
        const r = shoot({ x: 0.2, y: 0.99, z: -1.34, vx: vx, vy: vy, vz: vz,
                          wx: sp.wx, wy: sp.wy, wz: 0 });
        rows.push(cls(r) + "|" + [r.z1, r.z2, r.z1x, r.z2x, r.hitT, r.hitY, r.hitX]
          .map(v => v === null ? "null" : v.toFixed(9)).join(","));
      }
console.log(rows.join("\\n"));
`;
  const runVariant = (label, code) => {
    const f = path.join(ROOT, "_tmp_variant.js");
    fs.writeFileSync(f, code + "\n" + DRIVER);
    const out = execFileSync(process.execPath, [f], { encoding: "utf8" });
    fs.unlinkSync(f);
    console.log(label + " → " + out.trim().split("\n").length + " 条弹道");
    return out.trim().split("\n");
  };
  const a = runVariant("新内核（sqrt + 复用对象）", NEW);
  const b = runVariant("旧内核（hypot + 返回数组）", OLD);
  let diff = 0, clsDiff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diff++;
      if (a[i].split("|")[0] !== b[i].split("|")[0]) clsDiff++;
    }
  }
  console.log("\n逐位差异  " + diff + " / " + a.length);
  console.log("判定翻转  " + clsDiff + "  ← 必须为 0");
  console.log("结论：" + (diff === 0 ? "完全逐位一致，零风险"
    : clsDiff === 0 ? "浮点末位差异但判定一致 → 安全"
    : "存在判定翻转 → 必须回退"));
  process.exit(clsDiff === 0 ? 0 : 1);
}

// ---- 性能基准 ----
eval(NEW);
const SPIN = { wx: 250, wy: 120 };
function batch(n) {
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) solveServe(SPIN, 0.8, 0.42, 0);
  return Number(process.hrtime.bigint() - t) / 1e6 / n;
}
const runs = [];
for (let b = 0; b < 8; b++) runs.push(batch(10));
const min = Math.min.apply(null, runs);
const avg = runs.reduce((a, b) => a + b, 0) / runs.length;
console.log("solveServe（侧旋 wx=250 wy=120, relax=0）");
console.log("  每批 10 次: " + runs.map(x => x.toFixed(1)).join("  "));
console.log("  最小值 " + min.toFixed(1) + "ms   平均 " + avg.toFixed(1) + "ms");
console.log("  node " + process.version);
