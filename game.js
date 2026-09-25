"use strict";
/* 《第一视角 · 旋转乒乓》 MVP
 * 渲染：Three.js（真 3D，WebGL）  物理：自研 3D 弹道内核（重力 + 空气阻力 + 马格努斯力 + 台面摩擦）
 * 物理参数经离线标定，改动 K 必须重跑 _phys_test.js 与 _smoke.js
 */

/* ==================== 1. 常量与物理参数 ==================== */
const TAU = Math.PI * 2;
const T = { halfW: 0.7625, halfL: 1.37, h: 0.76, netH: 0.1525, netHalfW: 0.915 };
const BR = 0.02;                 // 球半径
const GRAV = 9.81;
const DRAG_K = 0.128;            // 空气阻力（含 0.5*rho*Cd*A/m）
const MAG_K = 0.0055;            // 马格努斯系数
const REST_E = 0.82;             // 台面恢复系数
const FRIC = 0.28;               // 台面摩擦
const SPIN_DECAY = 0.78;         // 落台旋转衰减
const SIDE_KICK = 0.15;          // 侧旋落台侧跳
const HIT_Z = 1.30;              // 理想击球纵深
/* 漏球线。原为 1.85，球一旦 z>1.85 立即判漏球。
 * 但相机在 z=2.72，球飞到 1.9~2.4 时正对着镜头（屏幕纵向最下方），
 * 放慢 40% 后球会在这个区间停留约 0.25~0.45s —— 玩家明明还在挥拍，
 * 游戏却已经抢先判了「漏球」，于是 mouseup 里的击球分支直接被守卫跳过，
 * 球拍永远不出现。放到 2.55：既留出完整挥拍窗口，又不让球穿过相机。 */
const MISS_Z = 2.55;             // 越过即漏球
const MAX_LEVEL = 8;             // 难度封顶档位

/* 「结算中」过渡窗口（秒）。失败那一刻起到弹出「本局结束」之间的时长。
 * 这个数字有三处必须同步，改的时候一起改：
 *   ① 此处（G.overAt）—— 决定结束页何时弹出；
 *   ② 失败提示 showMsg 的停留与保护期（都传 SETTLE_WAIT）—— 结束页弹出的
 *      同一刻提示正好消失，不留残影（结束页 z-index 更高，但同步消失更干净）；
 *   ③ index.html 进度条 stBar 的时长 —— 通过 CSS 变量 --settle-wait 读取，
 *      由 injectCssVars() 在运行时写进去，避免两处硬编码各写各的。
 * 原为 2.5s，用户反馈「等待偏长」，减半到 1.25s。 */
const SETTLE_WAIT = 1.25;

/* 回球公式系数（离线全维度搜索标定，勿手改；改动必须重跑 _calib3 / _phys_test / _smoke）
 * 已验证 732/732：球型 × 击球高度 × 力量 × 击球横向位置 全维度下，
 * 正确操作必上台，错拍面 / 侧旋不补偿必失误。 */
const K = {
  base: 1.826,     // 基准出球抬升
  errK: 0.992,     // 拍面接错惩罚
  loftK: 0.606,    // 补偿自身制造的上/下旋
  hK: 2.867,       // 击球高度自适应抬拍（越高越压、越低越抬）
  pwLoft: 0.355,   // 力量越大弧线越平（大力球不会必然出界）
  spinMag: 102,    // 回球自旋
  timK: 4.4,       // 时机惩罚
  vxK: 1.605,      // 横向瞄准系数（满幅打到两侧但不贴边）
  sideK: 3.154,    // 来球侧旋漂移
  sideSpin: 112,   // 回球侧旋（横向拖动带来）
  centerK: 2.931   // 边线球自动往台内带的强度
};

/* 场景配色：与 index.html :root 变量一一对应（accent=#ffb454 ok=#7ee0a8 bad=#ff7b72），改一侧需同步另一侧 */
const C = {
  bg: 0x0a0e15, bgCss: "#0a0e15", accent: 0xffb454, ok: 0x7ee0a8, bad: 0xff7b72,
  table: 0x1d6b82, tableCss: "#1d6b82", floor: 0x141b26, wall: 0x0f151f, trail: 0xffd9a0
};

/* 来球池（色值与 CSS --spin-* 保持一致）
 * 明显旋转的球合计 25%，其余 75% 是旋转弱、飞行慢的「好接球」：
 * 「轻上旋 / 轻下旋 / 直线快球」的 |wx| 恒 < 60，拍面保持中立就能接住，新手也能上路。
 * spd = 该球型的目标到位时间系数（越小越快）；整体到位时间已比原版放慢约 40%。 */
const SPIN_POOL = [
  { n: "上旋",     w: 10,  c: "#ff8a4c", spd: 1.00, mk: p => ({ wx:  (210 + Math.random() * 150) * p, wy: 0 }) },
  { n: "下旋",     w: 10,  c: "#4cb8ff", spd: 1.00, mk: p => ({ wx: -(210 + Math.random() * 150) * p, wy: 0 }) },
  { n: "左侧旋",   w: 2.5, c: "#c07bff", spd: 1.00, mk: p => ({ wx: 0, wy: -(180 + Math.random() * 140) * p }) },
  { n: "右侧旋",   w: 2.5, c: "#c07bff", spd: 1.00, mk: p => ({ wx: 0, wy:  (180 + Math.random() * 140) * p }) },
  { n: "直线快球", w: 45,  c: "#e6edf3", spd: 0.88, mk: p => ({ wx: (Math.random() * 50 - 25) * p, wy: 0 }) },
  { n: "轻上旋",   w: 15,  c: "#ffc9a8", spd: 1.06, mk: p => ({ wx:  (25 + Math.random() * 30) * p, wy: 0 }) },
  { n: "轻下旋",   w: 15,  c: "#a8d8ff", spd: 1.06, mk: p => ({ wx: -(25 + Math.random() * 30) * p, wy: 0 }) }
];
const POOL_TOTAL = SPIN_POOL.reduce((a, b) => a + b.w, 0);
/* 明显旋转（需要动拍面）的球型占比——回归测试会校验它稳定在 25% */
const SPINNY_W = SPIN_POOL.filter(s => s.n === "上旋" || s.n === "下旋" ||
                                        s.n === "左侧旋" || s.n === "右侧旋")
                          .reduce((a, b) => a + b.w, 0);

/* ==================== 2. 物理内核（纯计算，无渲染依赖） ==================== */
function makeBall() {
  return { x:0, y:0, z:0, vx:0, vy:0, vz:0, wx:0, wy:0, wz:0, spinAmt:0 };
}
/* 加速度写进复用对象 A 而不是 return [ax,ay,az]。
 * 为什么：step() 在 solveServe 的网格搜索里会被调用几十万次（一次发球约 480 条弹道 ×
 * 最多 700 步），每次 return 数组都是一次堆分配，实测比写复用对象慢 4.8 倍（见 _bench_serve.js）。
 * 同理 Math.hypot(三参) 比手写 Math.sqrt(a*a+b*b+c*c) 慢 2.6 倍（hypot 要做溢出保护）。
 * 数值完全一致（同样的加法与乘法顺序），已由 _phys_snapshot.js 逐位比对确认。 */
const A = { x: 0, y: 0, z: 0 };
function accel(s) {
  const v = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
  A.x = -DRAG_K * v * s.vx + MAG_K * (s.wy * s.vz - s.wz * s.vy);
  A.y = -DRAG_K * v * s.vy - GRAV + MAG_K * (s.wz * s.vx - s.wx * s.vz);
  A.z = -DRAG_K * v * s.vz + MAG_K * (s.wx * s.vy - s.wy * s.vx);
}
function step(s, dt) {
  accel(s);
  s.vx += A.x * dt; s.vy += A.y * dt; s.vz += A.z * dt;
  const px = s.x, py = s.y, pz = s.z;
  s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
  /* spinAmt 只被渲染层读（球的贴图自转、旋转箭头显隐），物理积分里算它纯属浪费——
   * 改成积分结束后由调用方按帧刷新（见 update() / shoot()）。 */

  if (pz * s.z <= 0 && pz !== s.z) {
    const k = Math.abs(pz) / Math.abs(pz - s.z);
    const yy = py + (s.y - py) * k, xx = px + (s.x - px) * k;
    if (Math.abs(xx) < T.netHalfW && yy < T.h + T.netH + BR * 0.5) return "net";
  }
  if (s.y - BR <= T.h && s.vy < 0 && Math.abs(s.x) <= T.halfW && Math.abs(s.z) <= T.halfL) {
    s.y = T.h + BR;
    const vn = -s.vy;
    s.vy = vn * REST_E;
    const cx = s.vx + s.wz * BR;
    const cz = s.vz - s.wx * BR;
    const cm = Math.hypot(cx, cz);
    if (cm > 1e-6) {
      let j = FRIC * (1 + REST_E) * vn;
      const jmax = (2 / 7) * cm;
      if (j > jmax) j = jmax;
      s.vx -= j * cx / cm;
      s.vz -= j * cz / cm;
    }
    s.vx += SIDE_KICK * s.wy * BR;
    s.wx *= SPIN_DECAY; s.wz *= SPIN_DECAY; s.wy *= 0.86;
    return "table";
  }
  if (s.y - BR <= 0) { s.y = BR; s.vy = -s.vy * 0.4; s.vx *= 0.7; s.vz *= 0.7; return "floor"; }
  return null;
}
function shoot(p) {
  const s = makeBall();
  Object.assign(s, p);
  const out = { z1: null, z2: null, z1x: 0, z2x: 0, hitY: 0, hitX: 0, hitT: 0,
                net: false, outX: 0, outZ: 0 };
  let t = 0, b1 = false;
  for (let i = 0; i < 700; i++) {
    const ev = step(s, 1 / 300); t += 1 / 300;
    out.outX = s.x; out.outZ = s.z;
    if (ev === "net") { out.net = true; break; }
    if (ev === "table") {
      if (!b1) { b1 = true; out.z1 = s.z; out.z1x = s.x; }
      else if (out.z2 === null) { out.z2 = s.z; out.z2x = s.x; }
    }
    if (ev === "floor") break;
    if (s.z >= HIT_Z && !out.hitT) { out.hitT = t; out.hitY = s.y; out.hitX = s.x; }
    if (s.z > MISS_Z || s.z < -2.4 || Math.abs(s.x) > 2.2) break;
    if (out.z2 !== null && out.hitT) break;
  }
  return out;
}
/* 发球求解：网格搜索"过网 + 落对手半台 + 落玩家半台 + 可击打"的发射参数 */
function solveServe(spin, targetZ2, targetT, relax) {
  relax = relax || 0;
  const z1Min = -1.32, z1Max = -0.12;
  const z2Min = 0.15 - relax * 0.04, z2Max = 1.30 + relax * 0.04;
  const yMin = 0.86, yMax = 1.24 + relax * 0.06;   // 下界不放宽：低球抬不过网
  const xMax = T.halfW * (0.72 + relax * 0.06);    // 击球点必须还在台内，否则球够不着
  // 侧旋漂移配平：按旋转方向预置几档反向横速，让球能停在台内
  const trims = Math.abs(spin.wy) > 60
    ? [0, -Math.sign(spin.wy) * 0.30, -Math.sign(spin.wy) * 0.62] : [0];
  let best = null, bestScore = -1e9;
  for (let vy = -2.4; vy <= 1.4; vy += 0.4) {
    for (let vz = 4.4; vz <= 8.6; vz += 0.6) {
      for (const trim of trims) {
        for (let sgn = -1; sgn <= 1; sgn += 2) {
          const x0 = sgn * (0.12 + Math.random() * 0.34);
          const p = { x: x0, y: 0.99, z: -1.34,
                      vx: -x0 * 0.55 - (spin.wy / 300) * 0.5 + trim,
                      vy: vy, vz: vz, wx: spin.wx, wy: spin.wy, wz: 0 };
          const r = shoot(p);
          if (r.net || r.z1 === null || r.z2 === null) continue;
          if (r.z1 > z1Max || r.z1 < z1Min) continue;
          if (r.z2 < z2Min || r.z2 > z2Max) continue;
          if (!r.hitT || r.hitY < yMin || r.hitY > yMax) continue;
          if (Math.abs(r.hitX) > xMax) continue;
          let sc = -Math.abs(r.z2 - targetZ2) * 3 - Math.abs(r.hitY - 0.93) * 4
                   - Math.abs(r.hitX) * 3 - Math.abs(r.hitT - targetT) * 8;
          if (sc > bestScore) { bestScore = sc; best = { p, r }; }
        }
      }
    }
  }
  return best;
}

/* ==================== 3. 三维场景（Three.js） ==================== */
let THREE_OK = true, REND = null, SCENE = null, CAM = null;
let OBJ = {};   // 场景对象集合
const CAM_Y = 1.84, CAM_Z = 2.72;   // 第一视角机位：站位高度 + 退台距离（固定机位，不切镜）

function buildScene() {
  const canvas = document.getElementById("cv");
  /* 主渲染器不需要 preserveDrawingBuffer：海报抓帧已改用独立的离屏渲染器
   * （见 shotRenderer）。这个开关每帧都要额外保留一份帧缓冲，是有代价的，
   * 既然不需要就关掉。 */
  REND = new THREE.WebGLRenderer({ canvas, antialias: true });
  REND.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  REND.shadowMap.enabled = true;
  REND.shadowMap.type = THREE.PCFSoftShadowMap;

  SCENE = new THREE.Scene();
  SCENE.background = new THREE.Color(C.bg);
  SCENE.fog = new THREE.Fog(C.bg, 6, 14);

  CAM = new THREE.PerspectiveCamera(40, 1, 0.05, 60);
  CAM.position.set(0, CAM_Y, CAM_Z);
  CAM.lookAt(0, 0.96, -0.3);

  /* 灯光 */
  SCENE.add(new THREE.AmbientLight(0x55637a, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(1.8, 3.4, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = -2; sc.right = 2; sc.top = 2; sc.bottom = -2; sc.near = 0.5; sc.far = 9;
  SCENE.add(key);
  const fill = new THREE.DirectionalLight(0x7fa8ff, 0.35);
  fill.position.set(-2.5, 2.2, -1.5); SCENE.add(fill);
  const l1 = new THREE.PointLight(0xa8c8ff, 0.5, 12); l1.position.set(0, 3.1, -1.2); SCENE.add(l1);
  const l2 = new THREE.PointLight(0xffd9a0, 0.35, 10); l2.position.set(0, 2.6, 2.4); SCENE.add(l2);

  /* 地面与背景墙 */
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.MeshStandardMaterial({ color: C.floor, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; SCENE.add(floor);

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 8),
    new THREE.MeshStandardMaterial({ color: C.wall, roughness: 1 }));
  wall.position.set(0, 4, -6.5); SCENE.add(wall);
  const wall2 = wall.clone(); wall2.position.set(0, 4, 7.5); wall2.rotation.y = Math.PI; SCENE.add(wall2);

  /* 球台 */
  const topMat = new THREE.MeshStandardMaterial({ color: C.table, roughness: 0.42, metalness: 0.05 });
  const tableTop = new THREE.Mesh(new THREE.BoxGeometry(T.halfW * 2, 0.05, T.halfL * 2), topMat);
  tableTop.position.set(0, T.h - 0.025, 0);
  tableTop.receiveShadow = true; tableTop.castShadow = true;
  SCENE.add(tableTop);

  // 台面贴图：白边线 + 中线（画在略高于台面的薄片上）
  const tc = document.createElement("canvas"); tc.width = 256; tc.height = 460;
  const g2 = tc.getContext("2d");
  g2.fillStyle = C.tableCss; g2.fillRect(0, 0, 256, 460);
  g2.strokeStyle = "#ffffff"; g2.lineWidth = 8; g2.strokeRect(4, 4, 248, 452);
  g2.lineWidth = 4;
  g2.beginPath(); g2.moveTo(128, 4); g2.lineTo(128, 456); g2.stroke();
  const surf = new THREE.Mesh(
    new THREE.PlaneGeometry(T.halfW * 2, T.halfL * 2),
    new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(tc), roughness: 0.42 }));
  surf.rotation.x = -Math.PI / 2;
  surf.position.set(0, T.h + 0.0012, 0);
  surf.receiveShadow = true;
  SCENE.add(surf);

  const legMat = new THREE.MeshStandardMaterial({ color: 0x11181f, roughness: 0.8 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, T.h - 0.05, 0.06), legMat);
    leg.position.set(sx * (T.halfW - 0.14), (T.h - 0.05) / 2, sz * (T.halfL - 0.18));
    leg.castShadow = true; SCENE.add(leg);
  }

  /* 球网：按 ITTF 器材规格重建（三层结构 + 接地影）
   *
   * 颜色规则来自 ITTF M2 网具标准：
   *   - 网纱（mesh）亮度必须 < 50% → 必须是暗绿/暗蓝，不能是亮的
   *   - 网顶带（tape）必须是白/浅黄，且与网纱「明显区分」
   * 旧版正好把两条都做反了：网纱是白色网格（rgba(230,238,246,.85)）+ opacity 0.55，
   * 白色网纱叠在白色桌线附近，两者同色同亮度 → 糊成一片，这就是
   * 用户反馈的「球网和桌面划线重叠、缺少立体感」。
   *
   * 现在：网纱深墨绿（与蓝台面拉开色相，与白桌线拉开明度），
   * 网顶带给足对比，网柱做出体积，再补一层「网根接地影」压出台面的前后关系。 */
  const NET_H = T.netH;   // 网高（ITTF：15.25cm）。网宽直接用 T.netHalfW*2，不再单独存深度值
  const nc = document.createElement("canvas");
  nc.width = 512; nc.height = 44;                     // 网眼横向 ~128 格，视觉密度接近真实
  const g3 = nc.getContext("2d");
  g3.clearRect(0, 0, 512, 44);
  /* 网纱底色：极暗的墨绿，把「网是实体」这件事先立住，
   * 否则纯线条在没有环境遮罩的深色场景里会看不出存在。 */
  g3.fillStyle = "rgba(14,46,38,0.72)";
  g3.fillRect(0, 0, 512, 44);
  /* 网线：比底色亮一档的绿，让网格结构可见 */
  g3.strokeStyle = "rgba(96,168,142,0.85)";
  g3.lineWidth = 1;
  for (let i = 0; i <= 512; i += 4) { g3.beginPath(); g3.moveTo(i + 0.5, 0); g3.lineTo(i + 0.5, 44); g3.stroke(); }
  for (let j = 0; j <= 44; j += 4) { g3.beginPath(); g3.moveTo(0, j + 0.5); g3.lineTo(512, j + 0.5); g3.stroke(); }
  /* 纵向明暗：顶部受光略亮、底部靠台面略暗 —— 这一层渐变就是「厚度感」的来源。
   * 没有它，网永远像一张贴在空中的贴纸。 */
  const vg = g3.createLinearGradient(0, 0, 0, 44);
  vg.addColorStop(0, "rgba(180,220,205,0.22)");
  vg.addColorStop(0.35, "rgba(120,180,160,0.06)");
  vg.addColorStop(1, "rgba(0,0,0,0.42)");
  g3.fillStyle = vg; g3.fillRect(0, 0, 512, 44);
  const netMat = new THREE.MeshStandardMaterial({
    map: new THREE.CanvasTexture(nc), transparent: true, opacity: 0.92,
    side: THREE.DoubleSide, depthWrite: false, roughness: 0.95 });
  const net = new THREE.Mesh(new THREE.PlaneGeometry(T.netHalfW * 2, NET_H), netMat);
  net.position.set(0, T.h + NET_H / 2, 0);
  SCENE.add(net);

  /* 网顶白带：做成有厚度的扁盒（而不是贴片），受光时上表面亮、前立面暗，
   * 一条明暗交界就出来了 —— 这是「立体感」最省成本的做法。 */
  const tape = new THREE.Mesh(
    new THREE.BoxGeometry(T.netHalfW * 2, 0.017, 0.014),
    new THREE.MeshStandardMaterial({ color: 0xf6f9fc, roughness: 0.45,
                                     emissive: 0xdfe8f2, emissiveIntensity: 0.28 }));
  tape.position.set(0, T.h + NET_H - 0.008, 0);
  tape.castShadow = true;
  SCENE.add(tape);
  /* 网顶带下沿压一条暗边：白带与绿网纱的交接处要有「缝」，
   * 否则两者在远处会糊成一条灰带，白带的立体感立刻没了。 */
  const tapeShade = new THREE.Mesh(
    new THREE.BoxGeometry(T.netHalfW * 2, 0.008, 0.0155),
    new THREE.MeshStandardMaterial({ color: 0x0d2a22, roughness: 1 }));
  tapeShade.position.set(0, T.h + NET_H - 0.0205, 0);
  SCENE.add(tapeShade);

  /* 网柱：立柱 + 底座，做出高度方向上的体积（旧版是 2cm 见方的细杆，远看像根线） */
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.024, NET_H + 0.075, 0.024),
      new THREE.MeshStandardMaterial({ color: 0x1a2531, roughness: 0.62, metalness: 0.25 }));
    post.position.set(sx * T.netHalfW, T.h + (NET_H + 0.075) / 2 - 0.012, 0);
    post.castShadow = true;
    SCENE.add(post);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.016, 0.062),
      new THREE.MeshStandardMaterial({ color: 0x141d26, roughness: 0.8 }));
    foot.position.set(sx * T.netHalfW, T.h + 0.008, 0);
    SCENE.add(foot);
  }

  /* 网根接地影：网离台面只有约 1.5cm，真实比赛里会在正下方压出一道窄暗带。
   * 补上它，球网与台面之间才有「接触」关系，而不是悬空贴片。
   * 用两层：贴台面的实影 + 稍微外扩的柔影。 */
  for (const [w, a] of [[0.030, 0.55], [0.075, 0.20]]) {
    const sh = new THREE.Mesh(
      new THREE.PlaneGeometry(T.netHalfW * 2, w),
      new THREE.MeshBasicMaterial({ color: 0x04121a, transparent: true, opacity: a,
                                    depthWrite: false }));
    sh.rotation.x = -Math.PI / 2;
    sh.position.set(0, T.h + 0.0022, 0);
    SCENE.add(sh);
  }

  /* 球（贴图让旋转可见）
   * 为了让「运动和静止都是正圆」：给球加 0.6cm 的白色外壳（半径与物理半径 BR 完全一致，
   * 不做任何缩放），内层球体稍微缩一点藏在外壳里。外壳挡住远景下的锯齿边缘，
   * 近景又因为比内层稍大而始终显示为完美圆——任何角度都不可能看出"变形"。 */
  const bc = document.createElement("canvas"); bc.width = 256; bc.height = 128;
  const gb = bc.getContext("2d");
  gb.fillStyle = "#f7f8fa"; gb.fillRect(0, 0, 256, 128);
  gb.strokeStyle = "#c9cfd8"; gb.lineWidth = 5;
  gb.beginPath(); gb.ellipse(128, 64, 104, 50, 0, 0, TAU); gb.stroke();
  gb.fillStyle = "#e0524a"; gb.beginPath(); gb.arc(66, 44, 21, 0, TAU); gb.fill();
  gb.fillStyle = "#2f6fd0"; gb.beginPath(); gb.arc(186, 84, 15, 0, TAU); gb.fill();
  const ball = new THREE.Group();
  const ballSkin = new THREE.Mesh(
    new THREE.SphereGeometry(BR, 28, 20),
    new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(bc), roughness: 0.32,
                                     emissive: 0xffffff, emissiveMap: new THREE.CanvasTexture(bc),
                                     emissiveIntensity: 0.30 }));
  ballSkin.castShadow = true;
  ball.add(ballSkin);
  const ballHalo = new THREE.Mesh(
    new THREE.SphereGeometry(BR * 1.06, 22, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16,
                                  depthWrite: false, blending: THREE.AdditiveBlending }));
  ball.add(ballHalo);
  /* 远景保底：球在屏幕上小于 7px 时，外壳自动撑到 3.5px 半径，
   * 保证远台来球也是一个能看清的圆点，而不是几个像素的锯齿块。 */
  ball.userData.halo = ballHalo;
  OBJ.ballSkin = ballSkin;
  SCENE.add(ball); OBJ.ball = ball;

  /* 旋转指示箭头（环绕球体的弧 + 箭头，轴与自旋轴对齐） */
  const arrowG = new THREE.Group();
  const arc = new THREE.Mesh(
    new THREE.TorusGeometry(0.062, 0.0042, 8, 30, Math.PI * 1.35),
    new THREE.MeshBasicMaterial({ color: 0xff8a4c, transparent: true, opacity: 0.95 }));
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.013, 0.032, 12),
    new THREE.MeshBasicMaterial({ color: 0xff8a4c }));
  const a0 = Math.PI * 1.35;
  tip.position.set(Math.cos(a0) * 0.062, Math.sin(a0) * 0.062, 0);
  tip.rotation.z = a0 - Math.PI / 2;
  arrowG.add(arc); arrowG.add(tip);
  SCENE.add(arrowG); OBJ.arrow = arrowG; OBJ.arrowArc = arc; OBJ.arrowTip = tip;

  /* 轨迹残影：只做气流感，绝不参与"球体形状"的视觉——缩小 + 极低不透明度，
   * 否则远距离下真球会被叠成一团椭圆"变形"。 */
  OBJ.trail = [];
  for (let i = 0; i < 10; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(BR * 0.5, 8, 6),
      new THREE.MeshBasicMaterial({ color: C.trail, transparent: true, opacity: 0.10,
                                    depthWrite: false, blending: THREE.AdditiveBlending }));
    m.visible = false; SCENE.add(m); OBJ.trail.push(m);
  }

  /* 预测落点圈 */
  const land = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.108, 40),
    new THREE.MeshBasicMaterial({ color: C.accent, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
  land.rotation.x = -Math.PI / 2; land.position.y = T.h + 0.003;
  SCENE.add(land); OBJ.land = land;

  /* 失败落点标注（PRD M6：失败时标注偏差方向） */
  const fmark = new THREE.Group();
  const fring = new THREE.Mesh(new THREE.RingGeometry(0.075, 0.095, 36),
    new THREE.MeshBasicMaterial({ color: C.bad, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  fmark.add(fring);
  const barMat = new THREE.MeshBasicMaterial({ color: C.bad });
  for (const rot of [Math.PI / 4, -Math.PI / 4]) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.014), barMat);
    bar.rotation.z = rot; fmark.add(bar);
  }
  fmark.rotation.x = -Math.PI / 2;
  fmark.position.y = T.h + 0.004;
  fmark.visible = false;
  SCENE.add(fmark); OBJ.fmark = fmark;

  /* 击球时机环（始终面向相机） */
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.84, 1.0, 44),
    new THREE.MeshBasicMaterial({ color: C.accent, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
  SCENE.add(ring); OBJ.ring = ring;

  /* 对手：仅手臂与球拍（PRD M1）——确认机位下完整入画 */
  const opp = new THREE.Group();
  opp.position.set(-0.34, 0.98, -1.55);
  const sleeve = new THREE.MeshStandardMaterial({ color: 0x1a2432, roughness: 0.9 });
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.042, 0.44, 14), sleeve);
  arm.position.set(0, -0.22, 0); arm.castShadow = true; opp.add(arm);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xcfa079, roughness: 0.85 }));
  hand.position.set(0, -0.44, 0); opp.add(hand);
  const oppRacket = makeRacket(0xb8332c);
  oppRacket.position.set(0, -0.52, 0.04);
  oppRacket.rotation.set(Math.PI / 2, 0, 0);
  opp.add(oppRacket);
  SCENE.add(opp); OBJ.opp = opp;

  /* 玩家球拍：击球瞬间入画——正手从左下、反手从右下进入演出区 */
  const pr = makeRacket(0xc4453a);
  pr.visible = false;
  SCENE.add(pr); OBJ.racket = pr;
  const prL = makeRacket(0xc4453a);
  prL.visible = false;
  SCENE.add(prL); OBJ.racketL = prL;
  /* 击球点标记：标出球在屏幕上的实际位置，让「提前量」是可以练的 */
  const aim = new THREE.Mesh(new THREE.RingGeometry(0.048, 0.060, 32),
    new THREE.MeshBasicMaterial({ color: C.accent, transparent: true, opacity: 0.62, side: THREE.DoubleSide }));
  aim.visible = false;
  SCENE.add(aim); OBJ.aim = aim;

  /* 球拍运动痕迹：挥拍路径上的半透明「拍面残影」。
   * 要求是「有，但不明显」——所以厚度为零（薄圆片）、加法混合、不透明度上限 0.15，
   * 只在挥拍进行中采样，0.28s 内淡出。它不参与任何判定，也不遮挡来球。 */
  OBJ.ghosts = [];
  for (let i = 0; i < 16; i++) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(0.082, 22),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.visible = false; SCENE.add(m); OBJ.ghosts.push(m);
  }

  resize3D();
}

/* 球拍几何：按真实球拍规格重建。
 *
 * 真实横拍尺寸（ITTF 常用规格，单位米）：
 *   拍面 152mm 宽 × 155mm 高 × 6mm 厚（略呈椭圆，不是正圆）
 *   拍柄 95mm 长，颈部细（23mm）、柄尾渐粗（30mm）并外扩一圈
 *   全长约 255mm
 *
 * 旧版三处比例都失真：
 *   1) 拍面半径 96mm（直径 192mm，比真实大 26%）—— 贴脸看就是一块大圆盘
 *   2) 拍柄只有 50mm（真实 95mm），柄/拍面仅 0.26（真实 0.625）
 *   3) 前臂是 260mm × 直径 80~96mm 的圆柱，比拍面还粗还长，出画时整根拖在画面外
 * 三者叠加，观感就是「一块大圆盘接了根小木棍，后面拖着一根球棒飞出画面」。
 *
 * 尺寸全部集中在 RKT 常量里：一是调比例只改一处，二是回归测试按名字读它，
 * 不必再去猜「第几个 CylinderGeometry 才是握柄」（那种靠顺序的解析一改布局就错位）。
 *
 * 另外修掉一个潜伏 bug：旧代码用 `blade.scale.y = 1.26` 想让拍面变椭圆，
 * 但 CylinderGeometry 的轴就是局部 Y、且该网格已 `rotation.x = π/2`，
 * 于是 scale.y 实际作用在**厚度**上 —— 拍面一直是正圆，只是被加厚了 26%。
 * 要压成椭圆必须缩放局部 Z（旋转后映射到世界 Y）。这里改用 scale.z。 */
const RKT = {
  bladeR: 0.076,     // 拍面半径（76mm → 直径 152mm）
  bladeT: 0.006,     // 拍面厚度
  oval: 1.02,        // 拍面高 / 宽 = 155 / 152
  faceT: 0.0038,     // 胶皮厚度
  faceInset: 0.0022, // 胶皮比木板小一圈
  handleR1: 0.0115,  // 柄上端半径（靠拍面，细）
  handleR2: 0.0150,  // 柄下端半径（渐粗）
  handleL: 0.095,    // 柄长 95mm
  handleY: -0.113,   // 柄中心 y（上端插进拍面 12mm）
  buttL: 0.020,      // 柄尾喇叭口长度
  buttY: -0.1705,
  foreR1: 0.026,     // 前臂半径（靠近手腕细）
  foreR2: 0.032,     // 前臂半径（靠小臂粗）
  foreL: 0.130,      // 前臂可视长度 130mm
  foreY: -0.240
};

function makeRacket(rubber) {
  const g = new THREE.Group();
  const blade = new THREE.Mesh(
    new THREE.CylinderGeometry(RKT.bladeR, RKT.bladeR, RKT.bladeT, 36),
    new THREE.MeshStandardMaterial({ color: 0xe4d5b8, roughness: 0.62 }));
  blade.rotation.x = Math.PI / 2; blade.scale.z = RKT.oval;
  blade.castShadow = true; g.add(blade);
  for (const s of [-1, 1]) {
    const face = new THREE.Mesh(
      new THREE.CylinderGeometry(RKT.bladeR - RKT.faceInset, RKT.bladeR - RKT.faceInset,
                                 RKT.faceT, 36),
      new THREE.MeshStandardMaterial({ color: rubber, roughness: 0.78 }));
    face.rotation.x = Math.PI / 2; face.scale.z = RKT.oval;
    face.position.z = s * (RKT.bladeT / 2 + RKT.faceT / 2 - 0.0008);
    g.add(face);
  }
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(RKT.handleR1, RKT.handleR2, RKT.handleL, 20),
    new THREE.MeshStandardMaterial({ color: 0x8a5a34, roughness: 0.82 }));
  handle.position.y = RKT.handleY;
  handle.castShadow = true; g.add(handle);
  /* 柄尾喇叭口：真实拍柄末端会外扩一圈，是「握得住」的视觉线索 */
  const butt = new THREE.Mesh(
    new THREE.CylinderGeometry(RKT.handleR2, RKT.handleR2 * 0.85, RKT.buttL, 20),
    new THREE.MeshStandardMaterial({ color: 0x6f4527, roughness: 0.85 }));
  butt.position.y = RKT.buttY; g.add(butt);
  /* 前臂：只留「手腕到小臂」一截 —— 长 130mm、直径 52→64mm。
   * 旧版是 260mm × 直径 80~96mm，比拍面还粗还长，整根拖在画面外，
   * 这正是用户说的「球拍飞出去了」。 */
  const fa = new THREE.Mesh(
    new THREE.CylinderGeometry(RKT.foreR1, RKT.foreR2, RKT.foreL, 16),
    new THREE.MeshStandardMaterial({ color: 0x2b3a4d, roughness: 0.9 }));
  fa.position.y = RKT.foreY; g.add(fa);
  return g;
}

function resize3D() {
  const w = window.innerWidth, h = window.innerHeight;
  REND.setSize(w, h, false);
  CAM.aspect = w / h;
  CAM.updateProjectionMatrix();
  if (typeof onOrientationMaybeChanged === "function") onOrientationMaybeChanged();
}
window.addEventListener("resize", resize3D);
/* 横屏/竖屏切换（尤其 iOS Safari）不一定触发 resize，必须显式监听 */
window.addEventListener("orientationchange", resize3D);
if (window.visualViewport) window.visualViewport.addEventListener("resize", resize3D);

/* ==================== 4. 游戏状态 ==================== */
const G = {
  running: false, paused: false, phase: "idle",
  ball: makeBall(),
  gt: 0, rally: 0, best: 0, level: 1,
  tIdeal: 0, idealSet: false, hitDone: false,
  serveT: 0, predHitT: 0, predZ2: 0, predZ2x: 0,
  nextServeAt: 0, overAt: 0,
  spin: { wx: 0, wy: 0 }, spinName: "—", spinColor: "#e6edf3", spinSpeed: 1, cheerT: 0,
  score: 0, goodStreak: 0, landErr: null, pending: null,
  assist: true, paddleAngle: 0, backhand: false,
  uiHidden: false,                       // 底部辅助面板（操作说明 + 音效栏）是否收起
  paddle: { anim: -1, side: 1, action: "推挡", hx: 0, hy: 0.92, pend: 0, dur: 0.34 },
  opp: { anim: -1 },
  msg: "", msgSub: "", msgT: 0, msgColor: "#e6edf3",
  msgPri: 0, msgHold: 0, msgQueue: [],      // 提示优先级 / 保护期 / 排队（见 showMsg）
  shake: 0, flash: 0, trail: [],
  /* 海报：落台瞬间抓帧（最多 3 张，按单拍得分取最高） */
  shots: [], shotReq: null,
  /* 球拍运动痕迹的采样队列 */
  ghosts: [],
  /* 海报三项指标统计 */
  statSpinTotal: 0, statSpinHit: 0, statErrSum: 0, statErrN: 0, statMaxSpeed: 0,
  curSpinBall: false, prevBestScore: 0,
  /* 本轮新增：模式 / 失败归因统计 / 本局累计精准拍数
   * mode 决定辅助提示初值与「是否计榜」（见 setMode）。
   * failStats 按 5 个桶累计本局失败原因，供结束页的「本局失败构成」使用；
   * 只在内存里，不持久化 —— 跨局统计交给 fpp_records.history。 */
  mode: "practice", failTotal: 0, failStats: {}, goodTotal: 0,
  /* bestAtStart = 本局开始时的最佳纪录。G.best 会在打到新纪录的瞬间就被刷新
   * （HUD 要实时显示），到结束页时已经无从判断「本局究竟有没有破纪录」——
   * 所以在开局时留一份快照，用来算「距个人最佳还差 N 球」。 */
  bestAtStart: 0
};

/* 线上地址。海报二维码指向它；改这里后要重跑 python _qr.py 重编码内联矩阵 */
const GAME_URL = "https://spin-pingpong.app.workbuddy.host/";

const UI = {};
function bindUI() {
  ["uiRally","uiBest","uiType","uiTypeSub","uiLevel","uiMode","uiAssist",
   "barMark","barTxt","msg","msgSub","uiFinal","endReason","endTip",
   "uiScore","uiStreak","uiScore2","uiPrevBest","newBadge",
   "startScreen","pauseScreen","endScreen","errScreen","errMsg",
   "posterScreen","posterCv","posterBtn","savePosterBtn","closePosterBtn","settle",
   "hud","hudAux","hudCfg","btnUiToggle","uiToggleTxt","btnUiToggle2",
   "btnMute","volRange","volTxt","btnMute2","volRange2","volTxt2",
   /* 本轮新增：双模式卡片 / 失败归因 / 历史榜 / GitHub 入口 */
   "modePractice","modeChallenge","startBtn","endMode","endGap",
   "failWrap","failList","failMain","boardWrap","boardTitle","boardList",
   "ghLink","siteLink",
   /* 移动端触屏控制簇（Task 7）：暂停 / 重开 / 辅助 / 正反手 */
   "tcPause","tcRestart","tcAssist","tcHand",
   /* P2：请横屏引导层 */
   "rotateHint"]
    .forEach(id => UI[id] = document.getElementById(id));
}

/* 模式卡片的高亮状态与开始页文案同步。三处入口共用 G.mode：
 * 开始页卡片、结束页的模式标签、HUD 的辅助提示状态。 */
function syncModeUI() {
  const ranked = G.mode === "challenge";
  const cards = [[UI.modePractice, "practice"], [UI.modeChallenge, "challenge"]];
  for (let i = 0; i < cards.length; i++) {
    const el = cards[i][0];
    if (el && el.classList) el.classList.toggle("on", cards[i][1] === G.mode);
  }
  if (UI.endMode) { /* 结束页标签由 renderModeTag 在 gameOver 时写入 */ }
}

/* 偏好持久化：音量 / 静音 / 辅助提示 */
function savePrefs() {
  try {
    localStorage.setItem("fpp_vol", String(Math.round(SFX.vol * 100)));
    localStorage.setItem("fpp_mute", SFX.mute ? "1" : "0");
    /* 辅助提示只在练习模式里是「玩家偏好」。挑战模式下 G.assist 恒为 false，
     * 若无条件写入会把玩家在练习模式的选择冲掉 —— 切回练习模式就变了。
     * 所以只在练习模式写。 */
    if (G.mode !== "challenge") localStorage.setItem("fpp_assist", G.assist ? "1" : "0");
    localStorage.setItem("fpp_uihidden", G.uiHidden ? "1" : "0");
  } catch (e) {}
}
function loadPrefs() {
  try {
    const v = parseInt(localStorage.getItem("fpp_vol") || "", 10);
    if (!isNaN(v)) setVol(v / 100, false);
    setMute(localStorage.getItem("fpp_mute") === "1", false);
    G.assist = localStorage.getItem("fpp_assist") !== "0";
    G.uiHidden = localStorage.getItem("fpp_uihidden") === "1";
  } catch (e) {}
}
/* HUD 与暂停面板两处音量控件保持同步 */
function syncSoundUI() {
  const pct = Math.round(SFX.vol * 100);
  for (const btn of [UI.btnMute, UI.btnMute2]) {
    if (!btn || !btn.classList || !btn.classList.toggle) continue;
    btn.textContent = SFX.mute ? "音效 关" : "音效 开";
    btn.classList.toggle("off", SFX.mute);
  }
  if (UI.volRange) UI.volRange.value = pct;
  if (UI.volRange2) UI.volRange2.value = pct;
  if (UI.volTxt) UI.volTxt.textContent = SFX.mute ? "静音" : pct;
  if (UI.volTxt2) UI.volTxt2.textContent = SFX.mute ? "静音" : pct;
}

/* 辅助面板显隐同步：拍面栏（左下）+ 操作说明 + 配置栏（右下）共用一个开关。
 * 只切 #hud 上的 ui-collapsed 类，由 CSS 决定藏哪几块——
 * 这样新增辅助面板不用改 JS，也不会出现「JS 说藏了、CSS 还显示着」的两头维护。 */
function syncUiToggle() {
  if (UI.hud && UI.hud.classList) UI.hud.classList.toggle("ui-collapsed", !!G.uiHidden);
  if (UI.btnUiToggle) UI.btnUiToggle.classList.toggle("off", !!G.uiHidden);
  if (UI.uiToggleTxt) UI.uiToggleTxt.textContent = G.uiHidden ? "展开辅助" : "收起辅助";
  if (UI.btnUiToggle2) UI.btnUiToggle2.textContent = G.uiHidden ? "显示" : "隐藏";
  const ar = UI.btnUiToggle && UI.btnUiToggle.querySelector
    ? UI.btnUiToggle.querySelector(".ar") : null;
  if (ar) ar.textContent = G.uiHidden ? "▲" : "▼";
}
function toggleUi() {
  G.uiHidden = !G.uiHidden;
  savePrefs();
  syncUiToggle();
  sfx("ui");
}

/* ==================== 5. 来球与判定 ==================== */
function pickSpin() {
  const lv = G.level;
  /* 旋转强度随难度缓涨，但「轻上旋 / 轻下旋」的 wx 上限锁在 55（< 60 阈值），
   * 无论打到第几档都保持"拍面中立就能接"——它们必须永远是新手友好球。 */
  const power = 1 + Math.min(lv - 1, MAX_LEVEL - 1) * 0.07;   // 最高 1.49
  let r = Math.random() * POOL_TOTAL;
  let def = SPIN_POOL[0];
  for (const s of SPIN_POOL) { r -= s.w; if (r <= 0) { def = s; break; } }
  const spin = def.mk(power);
  if (def.n === "轻上旋") spin.wx = Math.min(55, Math.abs(spin.wx));
  if (def.n === "轻下旋") spin.wx = -Math.min(55, Math.abs(spin.wx));
  return { def, spd: def.spd, ...spin };
}

/* 到位时间基准：原版 0.46s（1 档）→ 现在 0.74s ≈ 慢 40%（含 per-type spd 后的均值也 ≈ 0.72s） */
const SERVE_T0 = 0.74, SERVE_STEP = 0.030, SERVE_TMIN = 0.50, SERVE_TRAMP = 0.70;

function serve() {
  const sp = pickSpin();
  G.spin = { wx: sp.wx, wy: sp.wy };
  G.spinName = sp.def.n; G.spinColor = sp.def.c;
  G.spinSpeed = sp.spd || 1;      // 该球型的快慢系数，HUD 与测试都读它
  /* 海报指标①：旋转球接发率的分母。阈值与 correctTiltFor 的 60 一致，
   * 只有真正需要动拍面的球才算「旋转球」。 */
  G.curSpinBall = Math.abs(sp.wx) >= 60 || Math.abs(sp.wy) >= 60;
  if (G.curSpinBall) G.statSpinTotal++;
  /* 难度越高越短（略快），但整体比原版慢 40% 左右，给反应留出余量。
   * spd 让「直线快球」再快一点、「轻上/下旋」再慢一点，快慢有了节奏差。 */
  const targetT = Math.max(0.40, Math.min(SERVE_TRAMP,
                   (SERVE_T0 - (G.level - 1) * SERVE_STEP) * G.spinSpeed));
  // 上限 0.95 而非 1.20：开局来球别飘到台底角，保证"好接球"第一落点就落得正
  const targetZ2 = 0.45 + Math.random() * 0.50;
  // 逐级放宽约束求解：侧旋等苛刻组合下保证一定能发出合法球
  let sol = null;
  for (let relax = 0; relax < 5 && !sol; relax++) {
    sol = solveServe(G.spin, targetZ2, targetT, relax);
  }
  if (!sol) { sol = solveServe({ wx: 0, wy: 0 }, 0.85, SERVE_TRAMP, 3); }   // 兜底：发一个直球
  if (!sol) return;
  Object.assign(G.ball, sol.p);
  G.trail.length = 0;
  G.phase = "incoming"; G.tIdeal = 0; G.idealSet = false; G.hitDone = false;
  G.serveT = G.gt; G.predHitT = sol.r.hitT; G.predZ2 = sol.r.z2; G.predZ2x = sol.r.z2x;
  G.nextServeAt = 0; G.opp.anim = 0;
  sfx("serve");
  if (G.cheerT <= 0 && Math.random() < 0.30) { sfx("yell"); G.cheerT = 3.2; }   // 发球前的零星加油
}

/* 拍面角度：错拍面惩罚的核心 */
function correctTiltFor(sp) {
  if (Math.abs(sp.wx) < 60 && Math.abs(sp.wy) < 60) return 0;      // 直球：中性
  if (Math.abs(sp.wx) >= Math.abs(sp.wy))                           // 上下旋：压 / 亮
    return Math.max(-1, Math.min(1, -sp.wx / 260));
  return 0;                                                          // 纯侧旋：中性即可
}

/* 无论打没打中，只要玩家挥了拍，拍子就必须入画并演完。
 * 原实现只在「打中」分支里启动演出，导致「漏球 / 没打实」两个失败情形下球拍根本不出现，
 * 玩家看到的是一记凭空消失的挥拍——这是"球拍出现太慢/不出现"的核心原因。 */
function showSwing(b, action) {
  G.paddle.anim = 0;
  G.paddle.pend = 0;
  G.paddle.dur = 0.34;
  G.paddle.side = G.backhand ? -1 : 1;
  G.paddle.action = action || "拨";
  G.paddle.hx = clamp(b.x, -0.7, 0.7);
  G.paddle.hy = clamp(b.y, 0.75, 1.35);
}

/* 视口短边：触屏量纲归一化的基准（报告 E8）。 */
function viewportMin() { return Math.min(window.innerWidth, window.innerHeight); }

/* ===== 触屏量纲系数（集中一处，便于真机手感微调）=====
 * 为什么鼠标不走归一化：原版 doHit 的 140/190/1100 是绝对 CSS 像素常量，
 * 桌面玩家（鼠标 ≈1mm 落点精度）已按它练出手感。改成按视口比例后，
 * 同一台机器换个窗口大小手感就漂 —— 「判定可信」是这个项目的核心价值，
 * 不能为了移动端把桌面基准动掉。所以：**鼠标保持绝对像素，触摸才归一化**。
 * 判据用 pointerType 而不是 isCoarse()：二合一设备上鼠标与手指要各按各的算。
 * 为什么触摸要更宽松（系数比等比例换算更大）：手指落点精度 ≈1cm，
 * 远低于鼠标；沿用桌面量纲会出现「手指微抖就打飞」（报告 E8：手机屏宽仅 PC 的 9.7%）。 */
const TOUCHSCALE = {
  minSwing:  0.055,   // 最小有效挥拍幅度（× vmin），低于此判「没打实」
  fullLen:   0.200,   // lenN 满值（× vmin）
  fullSpeed: 0.850,   // speedN 满值（× vmin）
  fullAim:   0.260    // aim 满幅（× 视口宽），横扫 26% 屏宽即打到底线
};

/* 是否触屏（粗指针）。用于「辅助开 + 触屏」时自动跟随拍面，桌面仍走手动滚轮/AD，不回归。 */
function isCoarse() { return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); }

/* ===== 拖拽量纲换算（纯函数，便于回归直接断言，不必跑完整对局） =====
 * 两套量纲：鼠标沿用原版绝对像素 10/190/1100/140（与历史判定逐位等价、桌面手感零回归）；
 * 触摸改按视口比例（TOUCHSCALE），解决小屏「精度需求被放大 3.7 倍」的问题（报告 E8）。
 * 判据是 pointerType 而不是 isCoarse()：二合一设备上鼠标与手指必须各按各的算。 */
function measureDrag(drag) {
  const vw = window.innerWidth, vmin = viewportMin();
  const dx = drag.x - drag.sx, dy = drag.y - drag.sy;
  const len = Math.hypot(dx, dy);
  const touch = drag.type === "touch";
  const minSwing  = touch ? TOUCHSCALE.minSwing  * vmin : 10;
  const fullLen   = touch ? TOUCHSCALE.fullLen   * vmin : 190;
  const fullSpeed = touch ? TOUCHSCALE.fullSpeed * vmin : 1100;
  const fullAim   = touch ? TOUCHSCALE.fullAim   * vw   : 140;
  const speedN = Math.min(1, drag.speed / fullSpeed);
  const lenN   = Math.min(1, len / fullLen);
  const power  = Math.max(0.12, Math.min(1, 0.65 * speedN + 0.35 * lenN));
  // 线路幅度封顶 ±0.85：满幅打两侧仍落在台内，避免"瞄边必出界"
  const aim = Math.max(-0.85, Math.min(0.85, dx / fullAim));
  return { touch, dx, len, speedN, lenN, power, aim, minSwing, tooSmall: len < minSwing };
}

function doHit(drag) {
  const b = G.ball;
  let dt;
  if (G.idealSet) dt = G.gt - G.tIdeal;
  else dt = -Math.max(0.05, (HIT_Z - b.z) / Math.max(0.8, b.vz));
  if (dt > 0.42) { showSwing(b, "推挡"); fail("漏球", "球已经过去了"); return; }

  const M = measureDrag(drag);
  const dx = M.dx, len = M.len, speedN = M.speedN, lenN = M.lenN, power = M.power, aim = M.aim;
  if (M.tooSmall) { showSwing(b, "推挡"); fail("没打实", "挥拍幅度太小"); return; }
  const tilt = G.paddleAngle;

  const correctTilt = correctTiltFor(G.spin);
  const tiltErr = tilt - correctTilt;
  const sideCorrect = Math.abs(G.spin.wy) > 60 ? -Math.sign(G.spin.wy) * 0.8 : 0;
  const sideErr = Math.abs(G.spin.wy) > 60 ? Math.abs(aim - sideCorrect) : 0;

  const speed = 5.0 + power * 3.1;
  if (speed > G.statMaxSpeed) G.statMaxSpeed = speed;   // 海报指标③：最快回球（m/s → km/h）
  const hitY = b.y;
  const timErr = dt * K.timK;
  let vy = K.base + K.errK * tiltErr + K.loftK * (-tilt) - timErr
         + (0.94 - hitY) * K.hK - power * K.pwLoft;
  vy = Math.max(-0.8, Math.min(3.6, vy));
  // 击球点越靠边，回球越自然往台内带（否则边线球必出界，玩家无从补救）
  const vx = aim * K.vxK * (0.5 + power * 0.5) + (G.spin.wy / 300) * K.sideK - b.x * K.centerK;

  b.vx = vx; b.vy = vy; b.vz = -speed;
  b.wx = tilt * K.spinMag + G.spin.wx * 0.10;   // 回球沿 -z，压拍给负 wx 才是上旋
  b.wy = -aim * K.sideSpin;
  b.wz = 0;

  G.hitDone = true;
  G.phase = "returning";
  showSwing(b, (speedN < 0.45 && lenN < 0.5) ? "推挡" : "拨");
  G.shake = Math.min(1, power) * 0.035;
  G.flash = 1;
  sfx("hit");

  const r = shoot({ x: b.x, y: b.y, z: b.z, vx, vy, vz: -speed, wx: b.wx, wy: b.wy, wz: 0 });
  // 失败标注：球停在哪里，标记就画在哪里（网前 / 出底线 / 出边线都是本帧可读的信息）
  G.mark = { x: Math.max(-1.5, Math.min(1.5, r.outX || 0)),
             z: Math.max(-2.1, Math.min(1.85, r.outZ || 0)), t: 2.0 };
  /* 球飞向对手半台需要 (b.z+1.37)/speed 秒。玩家击球时球还在自己这半台（b.z≈1.1），
   * 所以这段飞行往往有 0.4s 以上，足够球拍演完一整轮。
   * 注意 pend 只能是 0：一旦给"摆拍延迟"，玩家出手后拍子就会先消失一下再出现——
   * 那正是"球拍出现太慢"的观感来源。挥拍必须先于球，而不是等球落台再演。 */
  G.paddle.pend = 0;

  /* 落点精准度：回球二次落点相对「黄圈理想落点」的横向偏差。
   * 记录在案，等这一拍真正打完（球落到对手台面）再结算得分与观众反应。 */
  G.landErr = (r.z2 !== null && r.z2x !== null) ? Math.abs(r.z2x - G.predZ2x) : null;
  G.pending = { err: G.landErr, level: G.level };

  if (r.net) { fail("下网", reason("net", tiltErr, dt, sideErr), tiltErr, dt); return; }
  if (r.z1 === null) {                                   // 从未落台：区分「飞出边线」还是「飞出底线」
    const wide = Math.abs(r.outX) > T.halfW + 0.02;
    fail(wide ? "出边线" : "出界",
         wide ? (sideErr > 0.8 ? "侧旋没补偿，球拐出边线" : "回球线路太偏，球出边线")
              : reason("out", tiltErr, dt, sideErr), tiltErr, dt);
    return;
  }
  if (r.z1 > -0.04) { fail("没过网", reason("short", tiltErr, dt, sideErr), tiltErr, dt); return; }
  if (r.z1 < -1.36) { fail("出界", reason("out", tiltErr, dt, sideErr), tiltErr, dt); return; }
  if (Math.abs(r.z1x) > T.halfW) {
    /* 侧旋且没补偿时，球是「先拐出去、再落到台外」，二次落点 z1 又远又偏。
     * 这时说「出边线」是误导——玩家会去改拍面，而真正错的是没做横向补偿。 */
    const broke = sideErr > 0.8;
    const tag = broke && r.z1 < -T.halfL ? "出界" : "出边线";
    fail(tag, broke ? (tag === "出界" ? "侧旋拐得太远，球从边线外绕出底线" : "侧旋拐了，球拐出边线")
                    : "回球线路太偏，球出边线", tiltErr, dt);
    return;
  }
  succeed(dt);
}

function reason(kind, tiltErr, dt, sideErr) {
  if (kind === "net") {
    if (Math.abs(tiltErr) > 0.85) return tiltErr < 0 ? "拍面压太狠，球下网" : "拍面太亮，没吃住球";
    if (dt > 0.12) return "击球太晚，球已经掉下去了";
    return "力量不够，球没过网";
  }
  if (kind === "short") return dt > 0.1 ? "击球太晚，球没弹起来" : "力量太小，球没过网";
  if (Math.abs(tiltErr) > 0.95) {
    return G.spin.wx > 60 ? "吃旋转！上旋球要压拍"
         : G.spin.wx < -60 ? "吃旋转！下旋球要亮拍搓"
         : "拍面角度不对，球飞了";
  }
  if (sideErr > 0.8) return "侧旋没补偿，球拐出边线";
  if (dt < -0.13) return "击球太早，球飞出界";
  return "力量太大，球出界了";
}

/* 回合结束（球已飞向对手台面）时补算「落点精准度」，累加得分。
 * 得分与难度档位挂钩，所以「稳」比「猛」更值钱——这也给了玩家一个不越打越急的理由。 */
function finalizePoint() {
  const pt = G.pending; if (!pt) return 0;
  G.pending = null;
  const near = pt.err === null ? 99 : pt.err;
  if (pt.err !== null) { G.statErrSum += pt.err; G.statErrN++; }   // 海报指标②：平均落点偏差
  const good = near < 0.13;                        // 落在黄圈附近
  const great = near < 0.065;
  const base = pt.level, mult = good ? 2 : 1;
  let gain = base * mult + (great ? base : 0);
  if (good) {
    G.goodStreak++;
    G.goodTotal++;                                 // 本局累计精准拍数（进历史榜）
    gain += G.goodStreak * 2;                      // 连续精准奖励，越稳越滚雪球
    /* 这条会紧跟「好球」而来。给 pri 2 + 0.55s 保护期：等「好球」的 1.5s 保护期
     * 走完才显示，两条夸奖就串成「好球」→「落点精准 +N 分」，不会被吞掉。 */
    showMsg(great ? "神来一板" : "落点精准",
            "连准 " + G.goodStreak + " 拍　+" + gain + " 分", "#ffd166", 1.7, 2, 0.55);
    if (great) sfx("good");
    crowdCheer(true);
  } else {
    G.goodStreak = 0;
  }
  G.score += gain;
  if (G.cheerT <= 0 && Math.random() < 0.20) { sfx("yell"); G.cheerT = 2.8; }   // 稀疏的零星喝彩
  return gain;                                     // 海报按单拍得分挑「高光三连拍」
}

function succeed(dt) {
  const perfect = Math.abs(dt) < 0.07;
  if (G.curSpinBall) G.statSpinHit++;      // 海报指标①的分子：旋转球接住了
  G.rally++;
  if (G.rally > G.best) { G.best = G.rally; saveBest(); }
  const prevLevel = G.level;
  G.level = Math.min(MAX_LEVEL, 1 + Math.floor(G.rally / 4));
  if (G.level > prevLevel) sfx("level");
  /* 夸奖必须看得清：旧版只停 0.6s，而球落台（0.5~1.2s 后）马上弹「落点精准」把它顶掉，
   * 玩家基本读不到。现在停 1.9s，并设 1.5s 保护期 —— 后面那条结算提示会排队等一下。 */
  if (!perfect) {                                   // 完美时机有专属提示，普通上台就交给落点结算
    showMsg("好球", "连续 " + G.rally + " 拍", "#7ee0a8", 1.9, 1, 1.5);
  } else {
    showMsg("PERFECT", "时机完美　连续 " + G.rally + " 拍", "#ffd166", 2.1, 2, 1.7);
    sfx("good");
  }
  crowdCheer(perfect);          // 观众反应：掌声 / 欢呼，每次参数都不同
  if (G.cheerT <= 0 && Math.random() < 0.18) { sfx("yell"); G.cheerT = 2.6; }
}
/* ===== 失败归因分类 =====
 * 把一次失败收敛到 5 个「玩家能理解」的桶：
 *   吃旋转 / 拍面偏差 / 时机早或晚 / 力量与落点 / 没打到球
 *
 * 判定依据刻意用**提示文案里的关键词**，而不是重算一遍 tiltErr/dt 的阈值。
 * 原因：reason() 已经决定「告诉玩家什么原因」，如果这里再独立算一套阈值，
 * 两者会出现「提示说吃旋转、统计记成拍面偏差」的自相矛盾 —— 玩家一旦发现
 * 数据和自己刚看到的话对不上，整个归因功能的可信度就没了。用文案反推，
 * 保证桶一定与玩家刚读到的那句话一致。
 *
 * 纯函数（不读 G），便于 Node 桩测直接调用。 */
const FAIL_BUCKETS = ["吃旋转", "拍面偏差", "时机早或晚", "力量与落点", "没打到球"];
function classifyFail(tag, why) {
  /* 完全没碰到球：与「碰到了但打坏」是两类问题，先分出去 */
  if (tag === "漏球" || tag === "没打实") return "没打到球";
  const w = String(why === undefined || why === null ? "" : why);
  /* 「侧旋没补偿 / 侧旋拐了」本质也是没读对旋转的横向影响，并入吃旋转 */
  if (w.indexOf("吃旋转") >= 0 || w.indexOf("侧旋") >= 0) return "吃旋转";
  if (w.indexOf("拍面") >= 0) return "拍面偏差";
  if (w.indexOf("太早") >= 0 || w.indexOf("太晚") >= 0) return "时机早或晚";
  return "力量与落点";
}

function fail(tag, why, tiltErr, dt) {
  /* 归因统计每拍只记一次：同一拍可能被多处判定命中（doHit 里多个 fail 分支、
   * 外加主循环的漏球兜底），重复计数会让「失败构成」失真。
   * 用 phase 做闸门 —— fail 自身会把它置为 "miss"，天然幂等。 */
  if (G.phase !== "miss") {
    const bucket = classifyFail(tag, why);
    G.failStats[bucket] = (G.failStats[bucket] || 0) + 1;
    G.failTotal++;
  }
  G.phase = "miss";
  const b = G.ball;
  b.vz = Math.abs(b.vz) * 0.22; b.vy = -0.6; b.vx = (Math.random() - 0.5) * 1.1;
  let dev = "";
  if (tiltErr !== undefined && Math.abs(tiltErr) > 0.5)
    dev = "　拍面" + (tiltErr > 0 ? "偏亮 +" : "偏压 ") + tiltErr.toFixed(2);
  if (dt !== undefined && Math.abs(dt) > 0.13)
    dev += "　时机" + (dt < 0 ? "早 " : "晚 ") + Math.abs(dt).toFixed(2) + "s";
  /* 失败提示优先级最高（pri 3）：它解释「为什么结束」，任何夸奖都得让路。
   * 停留时长与结算窗口同步（见下方 SETTLE_WAIT）：结束页弹出的同一刻提示正好消失，
   * 不留残影。失败原因另由结束页的「失败原因」字段承接，信息不会丢。 */
  showMsg(tag, why + dev, "#ff7b72", SETTLE_WAIT, 3, SETTLE_WAIT);
  if (tag === "下网") { sfx("net"); b.vz = -Math.abs(b.vz) * 0.14; }   // 让球真实地栽在网前
  sfx("bad");
  /* 失败后先静置 SETTLE_WAIT 秒：让玩家看清失败原因 + 落点标注 + 屏幕下方的偏差读数，
   * 读完了再弹「本局结束」。期间不锁输入以外的任何东西，HUD 照常刷新。
   * 这段时间不再是空白等待 —— 由「结算中」动画填上（见 showSettle）。 */
  G.overAt = G.gt + SETTLE_WAIT;
  showSettle();
}
/* ===== 「结算中」过渡动画 =====
 * 失败后要等 SETTLE_WAIT 秒才弹结束页（那段时间是给玩家读失败原因的）。
 * 原来这段时间画面完全静止，观感像卡死。用一个带乒乓球弹跳的遮罩填上：
 * 球上下弹 + 影子呼吸 + 进度条走满 SETTLE_WAIT，正好接上结束页。
 * 用 CSS 类切换而不是改 style —— 动画靠 CSS keyframes，重播只需重挂类。
 * 重挂类要强制 reflow，否则连续两局失败时动画不会重新开始。 */
function showSettle() {
  const el = UI.settle;
  if (!el || !el.classList) return;
  /* 把窗口时长交给 CSS：进度条动画写死会与 JS 侧各改各的，逐渐漂移。
   * 每次显示前重设，改 SETTLE_WAIT 后无需再动 index.html。 */
  if (el.style && el.style.setProperty) el.style.setProperty("--settle-wait", SETTLE_WAIT + "s");
  el.classList.remove("on");
  void el.offsetWidth;                 // 强制 reflow：让 keyframes 从 0 重播
  el.classList.add("on");
}
function hideSettle() {
  if (UI.settle && UI.settle.classList) UI.settle.classList.remove("on");
}

/* 提示消息。带「优先级 + 保护期 + 排队」，避免后到的提示把夸奖压成闪现。
 *
 * 原来的问题：击球成功瞬间弹「好球」，球落到对台后（约 0.5~1.2s）立刻又弹
 * 「落点精准 +N 分」，后者直接把前者顶掉 —— 玩家反馈的「夸奖一闪就没了」。
 * 现在高优先级消息在保护期内不会被抢占：低优先级的消息先排队，
 * 等保护期结束再显示。于是读起来是「好球」→ 停顿一下 →「落点精准 +N 分」，
 * 两条都看得清。
 *
 * pri：3 = 失败（最高，永远立刻打断）；2 = 大夸奖（PERFECT / 神来一板）；1 = 常规。
 * hold：保护期秒数，只挡 pri ≤ 自己的消息；更高优先级照样能打断。 */
const MSG_MAXQ = 4;
function showMsg(t, sub, c, d, pri, hold) {
  const P = pri === undefined ? 1 : pri;
  const H = hold === undefined ? 0 : hold;
  if (G.msgT > 0 && G.msgHold > 0 && P <= G.msgPri) {
    G.msgQueue.push({ t: t, sub: sub, c: c, d: d, pri: P, hold: H });
    if (G.msgQueue.length > MSG_MAXQ) G.msgQueue.shift();
    return;
  }
  applyMsg(t, sub, c, d, P, H);
}
function applyMsg(t, sub, c, d, pri, hold) {
  G.msg = t; G.msgSub = sub; G.msgColor = c; G.msgT = d;
  G.msgPri = pri; G.msgHold = hold;
}
/* 每帧推进：保护期先走完，再放行排队中的消息。一帧最多放行一条。 */
function tickMsg(frame) {
  if (G.msgT > 0) G.msgT -= frame;
  if (G.msgHold > 0) G.msgHold -= frame;
  if (G.msgHold <= 0 && G.msgQueue.length) {
    const m = G.msgQueue.shift();
    applyMsg(m.t, m.sub, m.c, m.d, m.pri, m.hold);
  }
  if (G.msgT <= 0) { G.msg = ""; G.msgSub = ""; G.msgPri = 0; G.msgHold = 0; }
}

/* ==================== 6. 输入 ==================== */
const drag = { on: false, zone: null, type: "mouse", sx: 0, sy: 0, x: 0, y: 0, speed: 0, t0: 0,
              startY: 0, startAngle: 0 };
function setupInput() {
  const cv = document.getElementById("cv");
  cv.addEventListener("pointerdown", e => {
    if (!G.running || G.paused) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;  // 鼠标只认左键
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}  // 手指移出 canvas 仍收得到 move/up
    drag.on = true;
    // 量纲分支标记（doHit 用）：触摸归一化、鼠标沿用绝对像素
    drag.type = (e.pointerType === "touch" || e.pointerType === "pen") ? "touch" : "mouse";
    // 双区手势（报告 P1）：左 45% 屏调拍面、右 55% 屏击球 —— 与「左手键盘 / 右手鼠标」分工同构
    drag.zone = (e.clientX < window.innerWidth * 0.45) ? "paddle" : "hit";
    drag.sx = drag.x = e.clientX;
    drag.sy = drag.y = e.clientY;
    drag.speed = 0; drag.t0 = performance.now();
    drag.startY = e.clientY; drag.startAngle = G.paddleAngle;
  });
  window.addEventListener("pointermove", e => {
    if (!drag.on) return;
    if (drag.zone === "paddle") {
      // 左区纵向拖拽 → 拍面：上拖亮拍(+)，下拖压拍(-)。辅助开时由 Task 6 每帧自动跟随，这里不动。
      if (!G.assist) {
        const span = Math.max(90, window.innerHeight * 0.28);
        G.paddleAngle = clamp(drag.startAngle + (drag.startY - e.clientY) / span, -1, 1);
      }
      return;
    }
    drag.x = e.clientX; drag.y = e.clientY;
  });
  window.addEventListener("pointerup", () => {
    if (!drag.on) return;
    drag.on = false;
    const wasHit = drag.zone === "hit";
    drag.zone = null;
    if (!wasHit) return;   // 左区调拍面手势不触发击球
    // 拖动速度取全程平均（位移 / 时长），比末段瞬时值稳定，避免"猛拖后停住"误判成大力
    const len = Math.hypot(drag.x - drag.sx, drag.y - drag.sy);
    const secs = Math.max(0.05, (performance.now() - drag.t0) / 1000);
    drag.speed = len / secs;
    if (G.running && !G.paused && G.phase === "incoming" && !G.hitDone) doHit(drag);
  });
  cv.addEventListener("wheel", e => {
    if (!G.running) return;
    e.preventDefault();
    G.paddleAngle = clamp(G.paddleAngle - Math.sign(e.deltaY) * 0.12, -1, 1);
  }, { passive: false });
  window.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (k === "shift") G.backhand = true;
    if (k === "a") G.paddleAngle = clamp(G.paddleAngle + 0.12, -1, 1);
    if (k === "d") G.paddleAngle = clamp(G.paddleAngle - 0.12, -1, 1);
    /* 挑战模式强制无辅助：这里直接拦掉。挑战模式的全部意义就是「无提示下的真实水平」，
     * 留一个后门会让榜单失去可比性 —— 也就是让这套纪录系统白做。 */
    if (k === "h") {
      if (G.mode === "challenge") {
        showMsg("挑战模式", "辅助提示不可开启（成绩计入排行榜）", "#ffb454", 1.2, 1, 0);
        sfx("ui");
      } else {
        G.assist = !G.assist; savePrefs(); sfx("ui");   // HUD 文案由 updateHUD 每帧同步
      }
    }
    if (k === "m") { setMute(!SFX.mute); syncSoundUI(); sfx("ui"); }
    if (k === "tab") { e.preventDefault(); toggleUi(); }   // 收起/展开底部辅助面板
    if (k === "r" && G.running) restart();
    if (k === "p" || e.key === "Escape") togglePause();
    if (e.code === "Space") e.preventDefault();
  });
  window.addEventListener("keyup", e => { if (e.key.toLowerCase() === "shift") G.backhand = false; });
  cv.addEventListener("contextmenu", e => e.preventDefault());

  document.getElementById("startBtn").onclick = () => { audioInit(); syncSoundUI(); sfx("ui"); restart(); };
  document.getElementById("againBtn").onclick = () => { sfx("ui"); restart(); };
  document.getElementById("resumeBtn").onclick = () => { sfx("ui"); togglePause(); };
  document.getElementById("quitBtn").onclick = () => { G.paused = false; gameOver("主动结束"); };
  document.getElementById("posterBtn").onclick = () => { sfx("ui"); openPoster(); };
  document.getElementById("closePosterBtn").onclick = () => {
    sfx("ui"); UI.posterScreen.classList.add("hidden"); UI.endScreen.classList.remove("hidden");
  };
  document.getElementById("savePosterBtn").onclick = () => {
    POSTER.save(UI.posterCv, "旋转乒乓_" + G.rally + "拍_" + G.score + "分.png");
  };
  const onMute = () => { audioInit(); setMute(!SFX.mute); syncSoundUI(); sfx("ui"); };
  if (UI.btnMute) UI.btnMute.onclick = onMute;
  if (UI.btnMute2) UI.btnMute2.onclick = onMute;
  if (UI.btnUiToggle) UI.btnUiToggle.onclick = toggleUi;
  if (UI.btnUiToggle2) UI.btnUiToggle2.onclick = toggleUi;
  const onVol = e => { audioInit(); setVol(parseInt(e.target.value, 10) / 100); syncSoundUI(); };
  if (UI.volRange) UI.volRange.oninput = onVol;
  if (UI.volRange2) UI.volRange2.oninput = onVol;
}

/* ===== 移动端触屏控制簇（Task 7）：替代键盘 Esc/P/R/H/Shift =====
   仅粗指针（触屏）下启用：给 #hud 加 .touch-on 显示四个按钮，桌面端始终隐藏、键盘照旧。
   各按钮复用已有逻辑：暂停→togglePause、重开→restart、辅助→H 键逻辑（挑战模式拦截）、正反手→G.backhand。 */
let touchCtlOn = false;
function syncTouchCtl() {
  if (!touchCtlOn) return;
  const pause = UI.tcPause, restart = UI.tcRestart, assist = UI.tcAssist, hand = UI.tcHand;
  if (!pause) return;
  pause.classList.toggle("on", G.paused);
  restart.classList.toggle("off", !G.running);
  assist.classList.toggle("on", G.assist);
  assist.classList.toggle("off", !G.assist);
  hand.classList.toggle("on", G.backhand);
  hand.textContent = G.backhand ? "正" : "反";
}
function setupTouchControls() {
  if (!isCoarse()) return;            // 桌面不显示控制簇
  touchCtlOn = true;
  if (UI.hud) UI.hud.classList.add("touch-on");
  UI.tcPause.onclick = () => { sfx("ui"); togglePause(); syncTouchCtl(); };
  UI.tcRestart.onclick = () => { if (G.running) { sfx("ui"); restart(); } syncTouchCtl(); };
  UI.tcAssist.onclick = () => {
    // 复用 H 键逻辑：挑战模式强制无辅助，不给绕过口子
    if (G.mode === "challenge") {
      showMsg("挑战模式", "辅助提示不可开启（成绩计入排行榜）", "#ffb454", 1.2, 1, 0); sfx("ui");
    } else { G.assist = !G.assist; savePrefs(); sfx("ui"); }
    syncTouchCtl();
  };
  UI.tcHand.onclick = () => { G.backhand = !G.backhand; sfx("ui"); syncTouchCtl(); };
  syncTouchCtl();
}

/* ===== P2：仅平板横屏支持；其余（手机任意方向 / 平板竖屏）显示「请横屏」引导层 =====
   放行条件：桌面(fine pointer) 或（粗指针 + 屏宽≥768 + 横屏）。 */
function isSupported() {
  if (!window.matchMedia) return true;                                  // 不支持媒体查询 → 不拦截
  if (!window.matchMedia("(pointer: coarse)").matches) return true;     // 桌面（细指针）放行
  const wide = window.matchMedia("(min-width: 768px)").matches;
  const land = window.matchMedia("(orientation: landscape)").matches;
  return wide && land;                                                  // 仅平板横屏放行
}
function applySupportGate() {
  if (!UI.rotateHint) return;
  const ok = isSupported();
  UI.rotateHint.classList.toggle("on", !ok);
  // 不支持时由引导层（z-index:30 全屏遮罩 + pointer-events:auto）阻断误触，
  // 这里不强行暂停，避免旋转回横屏后状态错乱。
}
function onOrientationMaybeChanged() { applySupportGate(); }

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/* ==================== 7. 音效（Web Audio 程序化合成，零外部资源） ====================
 * 乒乓球声学特征：击球是「极短瞬态 + 1~2kHz 共振 + 快速衰减」，落台比击拍更闷、音高更低。
 * 因此击拍用带通噪声瞬态叠三角波共振；落台用更低的带通与更快衰减；落网/落地用低通噪声。
 */
const SFX = { ac: null, master: null, noise: null, vol: 0.7, mute: false, ready: false,
              crowdAt: 0, crowdKind: "", crowdFP: null };

function audioInit() {
  if (SFX.ready) { if (SFX.ac.state === "suspended") SFX.ac.resume(); return; }
  try {
    const AC = new (window.AudioContext || window.webkitAudioContext)();
    const master = AC.createGain();
    master.gain.value = SFX.mute ? 0 : SFX.vol;
    master.connect(AC.destination);

    // 2 秒白噪声缓冲，供所有瞬态复用
    const n = Math.floor(AC.sampleRate * 2);
    const buf = AC.createBuffer(1, n, AC.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    /* 球馆底噪：只保留中高段的"空气感"，营造空间但不抢戏。
     * 旧版是 400Hz 低通噪声 → 那是一层持续的低频轰鸣（用户听到的"轰轰"）。
     * 实测（_audio_spectrum.py）：旧版 <200Hz 能量占比 33.1%、谱质心 315Hz；
     * 新版高通切掉 220Hz 以下"轰"、低通到 2.6kHz，质心升到 ≈1983Hz，
     * 增益同时压到 1/3 以下，把绝对能量也降下来。 */
    const room = AC.createBufferSource(); room.buffer = buf; room.loop = true;
    const hp = AC.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 220;
    const lp = AC.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2600;
    const rg = AC.createGain(); rg.gain.value = 0.006;
    room.connect(hp); hp.connect(lp); lp.connect(rg); rg.connect(master); room.start();

    SFX.ac = AC; SFX.master = master; SFX.noise = buf; SFX.ready = true;
    SFX.crowdAt = 0; SFX.crowdKind = "";
  } catch (e) { SFX.ready = false; }
}
function applyVol() {
  if (SFX.ready) SFX.master.gain.value = SFX.mute ? 0 : SFX.vol;
}
function setVol(v, persist) {
  SFX.vol = Math.max(0, Math.min(1, v));
  if (SFX.vol > 0 && SFX.mute) SFX.mute = false;
  applyVol();
  if (persist !== false) savePrefs();
}
function setMute(m, persist) {
  SFX.mute = !!m;
  applyVol();
  if (persist !== false) savePrefs();
}

/* 单音：freq→f2 可做音高滑动，模拟击球瞬间的"降调"感 */
function tone(freq, dur, type, gain, f2, at) {
  if (!SFX.ready || SFX.mute) return;
  const AC = SFX.ac, t = at || AC.currentTime;
  const o = AC.createOscillator(), g = AC.createGain();
  o.type = type || "sine";
  o.frequency.setValueAtTime(Math.max(20, freq), t);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(SFX.master);
  o.start(t); o.stop(t + dur + 0.03);
}
/* 噪声瞬态：带通 / 低通塑形，模拟球体撞击的"啪" */
function noiseHit(dur, freq, q, gain, type, at) {
  if (!SFX.ready || SFX.mute) return;
  const AC = SFX.ac, t = at || AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise;
  const f = AC.createBiquadFilter();
  f.type = type || "bandpass"; f.frequency.value = freq; f.Q.value = q || 3;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(SFX.master);
  s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.03);
}

function sfxPaddle(p) {                       // 球拍击球：清脆的"砰"
  const t = SFX.ac.currentTime, k = Math.max(0.2, Math.min(1, p || 0.5));
  noiseHit(0.030, 2200 + k * 900, 3.0, 0.20 * k + 0.05, "bandpass", t);
  tone(1180 + k * 540, 0.065, "triangle", 0.15 * k + 0.04, 640 + k * 260, t);
  tone(2500, 0.020, "square", 0.028 * k, 1600, t);
}
function sfxTable(p) {                        // 落台：更闷、音高更低
  const t = SFX.ac.currentTime, k = Math.max(0.2, Math.min(1, p || 0.5));
  noiseHit(0.024, 1450 + k * 350, 3.6, 0.10 * k + 0.03, "bandpass", t);
  tone(720 + k * 180, 0.050, "triangle", 0.075 * k + 0.03, 420, t);
}
function sfxFloor() {                         // 落地：闷响
  const t = SFX.ac.currentTime;
  noiseHit(0.090, 240, 1.2, 0.085, "lowpass", t);
  tone(155, 0.105, "sine", 0.05, 92, t);
}
function sfxNet() {                           // 挂网：短促的钝响
  const t = SFX.ac.currentTime;
  noiseHit(0.130, 330, 1.4, 0.10, "lowpass", t);
  tone(190, 0.130, "sawtooth", 0.045, 110, t);
}

/* 观众席：程序化合成，不用采样。
 *
 * 旧版是"带通噪声当人声"，听起来是低频的"轰轰轰"——噪声被 480~1150Hz 的窄带滤过之后
 * 只剩一团低频轰鸣，完全没有人的音色。人声之所以是人声，靠的是「声带基频 + 共振峰」：
 * 声带提供带谐波的基频（锯齿波），口腔/鼻腔把其中几个频段放大成 F1/F2/F3 共振峰。
 * 所以这里改成真正的共振峰合成：
 *   每条嗓子 = 锯齿波（基频 110~280Hz，带音高上扬再回落的语调 + 轻微颤音）
 *              → 三条并联带通（F1≈800 / F2≈1500 / F3≈2800）→ 各自的包络
 *   一群嗓子错峰起唱、音高互不相同 → 就是"哇——"的热烈欢呼
 * 掌声单独一层：极短的高频 click（2~4.5kHz），起点抖动模拟"不齐"。
 * 每次调用的嗓门数、时长、音高分布、底噪频率全都重新随机 → 不可能两次一样。 */
function rand(a, b) { return a + Math.random() * (b - a); }

/* 一条嗓子：基频振荡器 → 三共振峰，模拟人声"哇——" */
function crowdVoice(t0, dur, amp, f0) {
  const AC = SFX.ac;
  const o = AC.createOscillator();
  o.type = "sawtooth";
  /* 语调：起音稍低 → 迅速上扬 → 拖长回落，这是欢呼的典型音高曲线 */
  o.frequency.setValueAtTime(f0 * rand(0.90, 1.00), t0);
  o.frequency.linearRampToValueAtTime(f0 * rand(1.08, 1.24), t0 + dur * rand(0.22, 0.36));
  o.frequency.linearRampToValueAtTime(f0 * rand(0.88, 0.99), t0 + dur);

  /* 颤音：5~8Hz 的轻微抖动，去掉"电子音"的僵硬感 */
  const lfo = AC.createOscillator();
  lfo.type = "sine"; lfo.frequency.value = rand(5, 8);
  const lfoG = AC.createGain(); lfoG.gain.value = f0 * rand(0.012, 0.030);
  lfo.connect(lfoG); lfoG.connect(o.frequency);

  /* 三共振峰并联相加。Q 不能太高，否则会变成哨声而不是人声 */
  const sum = AC.createGain(); sum.gain.value = 1;
  const F = [[rand(680, 980), 1.00, rand(3, 5)],      // F1：决定"啊/哇"的开口度
             [rand(1180, 1750), 0.55, rand(4, 7)],    // F2：决定元音前后
             [rand(2450, 3100), 0.26, rand(5, 8)]];   // F3：决定明亮度
  for (const [fq, w, q] of F) {
    const bp = AC.createBiquadFilter();
    bp.type = "bandpass"; bp.frequency.value = fq; bp.Q.value = q;
    const g = AC.createGain(); g.gain.value = w;
    o.connect(bp); bp.connect(g); g.connect(sum);
  }

  const env = AC.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0004, amp), t0 + rand(0.05, 0.14));
  env.gain.exponentialRampToValueAtTime(Math.max(0.0004, amp * 0.72), t0 + dur * 0.55);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  sum.connect(env); env.connect(SFX.master);

  o.start(t0); o.stop(t0 + dur + 0.03);
  lfo.start(t0); lfo.stop(t0 + dur + 0.03);
}

function sfxCrowd(kind) {
  if (!SFX.ready || SFX.mute || !SFX.noise) return;
  const AC = SFX.ac, t0 = AC.currentTime + rand(0.02, 0.12);
  const big = kind === "cheer";
  const dur = big ? rand(1.30, 2.20) : rand(0.85, 1.45);    // 每次欢呼长度都不同
  const n = Math.round(big ? rand(72, 112) : rand(58, 98)); // 每次鼓掌人次都不同
  const m = Math.round(big ? rand(18, 30) : rand(9, 16));   // 每次嗓门数都不同

  /* 人群"空气层"：高频段宽带噪声，只是把欢呼垫起来，不做低频轰鸣 */
  const bed = AC.createBufferSource(); bed.buffer = SFX.noise;
  const bedHP = AC.createBiquadFilter(); bedHP.type = "highpass"; bedHP.frequency.value = 600;
  const bedF = AC.createBiquadFilter();
  bedF.type = "bandpass"; bedF.frequency.value = rand(1400, 2400); bedF.Q.value = 0.6;
  const bedAmp = rand(0.030, 0.055);
  const bedG = AC.createGain();
  bedG.gain.setValueAtTime(0.0001, t0);
  bedG.gain.exponentialRampToValueAtTime(bedAmp, t0 + 0.10);
  bedG.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  bed.connect(bedHP); bedHP.connect(bedF); bedF.connect(bedG); bedG.connect(SFX.master);
  bed.start(t0, Math.random() * 1.5); bed.stop(t0 + dur + 0.05);

  /* 掌击：每掌一个极短高频 click，频率与延迟全随机 → 自然的"不整齐" */
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const env = Math.exp(-2.4 * u) * (0.55 + 0.45 * Math.sin(u * Math.PI * rand(1.2, 2.6)));
    if (Math.random() < 0.06) continue;                  // 随机漏拍：真实观众不会拍得一样齐
    const at = t0 + (big ? u * u * dur : Math.pow(u, rand(0.6, 1.3)) * dur) + rand(-0.012, 0.020);
    if (at < t0) continue;
    const s = AC.createBufferSource(); s.buffer = SFX.noise;
    const f = AC.createBiquadFilter();
    f.type = "bandpass"; f.frequency.value = rand(2200, 4600); f.Q.value = rand(1.8, 3.6);
    const hp2 = AC.createBiquadFilter(); hp2.type = "highpass"; hp2.frequency.value = 900;
    const g = AC.createGain();
    const amp = Math.max(0.0004, rand(0.020, 0.050) * env);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(amp, at + 0.0035);
    g.gain.exponentialRampToValueAtTime(0.0001, at + rand(0.018, 0.050));
    s.connect(hp2); hp2.connect(f); f.connect(g); g.connect(SFX.master);
    s.start(at, Math.random() * 1.5); s.stop(at + 0.10);
  }

  /* 合唱：m 条嗓子错峰起唱，音高各不同（女声偏高、男声偏低），
   * 起唱时间用平方分布 → 开头瞬间涌上来一片，正是"爆发式欢呼"的听感 */
  const fBase = rand(140, 200);                 // 本次观众席的整体音区
  for (let i = 0; i < m; i++) {
    const u = i / m;
    const at = t0 + u * u * dur * 0.55 + rand(0, 0.09);
    const f0 = fBase * rand(0.72, 1.55);        // 每条嗓子的本嗓音高
    const amp = rand(0.014, 0.032) * (1 - 0.45 * u);
    crowdVoice(at, dur * rand(0.62, 1.0), amp, f0);
  }
  SFX.crowdAt = t0;
  SFX.crowdKind = kind;
  /* 本次演出的参数指纹（嗓门数 / 鼓掌人次 / 时长 / 底噪频率 / 底噪强度 全是连续随机量）。
   * 只数音源个数会让回归测试撞"生日碰撞"而假失败，指纹才是"每次都不一样"的真判据。 */
  SFX.crowdFP = { kind: kind, n: m * 2 + n, dur: +dur.toFixed(4),
                  bed: Math.round(bedF.frequency.value), amp: +bedAmp.toFixed(4) };
}

/* 单声"加油/漂亮"的短呼喝：同样走共振峰合成，但只有一条嗓子、音高更高更短 */
function sfxYell() {
  if (!SFX.ready || SFX.mute || !SFX.noise) return;
  const t = SFX.ac.currentTime + rand(0.02, 0.09);
  crowdVoice(t, rand(0.42, 0.62), rand(0.030, 0.055), rand(210, 330));
}

function sfx(k, v) {
  if (!SFX.ready || SFX.mute) return;
  if (k === "serve") sfxPaddle(0.30);                 // 对手发球触拍
  else if (k === "hit") sfxPaddle(v);                 // 玩家击球（力度决定亮度）
  else if (k === "table") sfxTable(v);                // 球落台
  else if (k === "floor") sfxFloor();
  else if (k === "net") sfxNet();
  else if (k === "good") {                            // 完美击球：上行三度
    const t = SFX.ac.currentTime;
    tone(1318, 0.085, "sine", 0.10, null, t);
    tone(1976, 0.130, "sine", 0.075, null, t + 0.055);
  }
  else if (k === "bad") {                             // 失误：下行 + 钝响
    const t = SFX.ac.currentTime;
    tone(233, 0.300, "sawtooth", 0.085, 110, t);
    noiseHit(0.200, 300, 1.0, 0.05, "lowpass", t);
  }
  else if (k === "level") {                           // 升档提示
    const t = SFX.ac.currentTime;
    [880, 1108, 1318].forEach((f, i) => tone(f, 0.085, "triangle", 0.06, null, t + i * 0.058));
    sfxCrowd("cheer");
  }
  else if (k === "crowd") sfxCrowd(v && v.cheer ? "cheer" : "applause");
  else if (k === "yell") sfxYell();
  else if (k === "ui") tone(660, 0.045, "sine", 0.05);
}
/* 观众反应随机化：掌声尾音未落时不再叠一串，但只要上一次已经响过一小段，
 * 下一次一定是全新参数的全新一条——所以「每次都不一样」是可验证的。 */
function crowdCheer(perfect) {
  if (!SFX.ready || SFX.mute) return;
  const now = SFX.ac.currentTime;
  const busy = SFX.crowdAt && now - SFX.crowdAt < 0.55;
  const want = perfect ? Math.random() < 0.92 : Math.random() < 0.74;
  if (busy || !want) return;
  sfxCrowd(perfect && Math.random() < 0.55 ? "cheer" : "applause");
}

/* ==================== 8. 主循环 ==================== */
const DT = 1 / 300;
let acc = 0, last = 0, FDT = 1 / 60;     // FDT：真实帧时长，供渲染层做与帧率无关的动画
function loop(ts) {
  requestAnimationFrame(loop);
  if (!last) last = ts;
  let frame = (ts - last) / 1000; last = ts;
  if (frame > 0.1) frame = 0.1;
  FDT = frame > 0 ? frame : 1 / 60;
  if (!G.running) { render3D(); return; }
  if (!G.paused) {
    acc += frame;
    let n = 0;
    while (acc >= DT && n < 20) { update(DT); acc -= DT; n++; }
    if (G.msgT > 0 || G.msgHold > 0 || G.msgQueue.length) tickMsg(frame);
    if (G.cheerT > 0) G.cheerT -= frame;
    if (G.paddle.anim >= 0) { G.paddle.anim += frame / (G.paddle.dur || 0.34); if (G.paddle.anim > 1) G.paddle.anim = -1; }
    if (G.opp.anim >= 0) { G.opp.anim += frame / 0.34; if (G.opp.anim > 1) G.opp.anim = -1; }
  }
  G.shake *= 0.86; G.flash *= 0.88;
  updateHUD();
  render3D();
}

function update(dt) {
  G.gt += dt;
  const b = G.ball;

  if (G.phase === "incoming" || G.phase === "returning" || G.phase === "miss") {
    const vyIn = b.vy;                                   // 撞击强度：入射垂直速度
    const ev = step(b, dt);
    /* spinAmt 由这里按帧刷新（step 里不再算）：它只服务渲染层的贴图自转与旋转箭头，
     * 而 step 会被网格搜索调用几十万次，每步算一次 hypot 纯属浪费。 */
    b.spinAmt = Math.sqrt(b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
    if (ev === "table") sfx("table", Math.min(1, Math.abs(vyIn) / 3.2));
    else if (ev === "floor") sfx("floor");
    else if (ev === "net") sfx("net");
    const lp = G.trail[G.trail.length - 1];
    if (!lp || Math.hypot(b.x - lp.x, b.y - lp.y, b.z - lp.z) > 0.022) {
      G.trail.push({ x: b.x, y: b.y, z: b.z });
      if (G.trail.length > 14) G.trail.shift();
    }
    if (G.phase === "incoming") {
      if (!G.idealSet && b.z >= HIT_Z && b.vz > 0) { G.tIdeal = G.gt; G.idealSet = true; }
      if (b.z > MISS_Z || ev === "floor") fail("漏球", "没打到球");
      // 辅助开 + 触屏：拍面每帧自动跟随当前旋转的正确角度（报告 P1），触屏玩家无需手动调拍面。
      // 桌面（fine pointer）即使辅助开也保留手动滚轮/AD，行为不回归。
      if (G.assist && isCoarse()) G.paddleAngle = correctTiltFor(G.spin);
    } else if (G.phase === "returning") {
      if (!G.nextServeAt && (ev === "table" || ev === "floor" || b.z < -2.2)) {
        const gain = finalizePoint();         // 这一拍落定 → 结算落点得分（含观众反应）
        /* 海报抓帧：只认「球击中对手球桌」的那一瞬间（落点在网另一侧）。
         * 真正的抓图放到 render3D 末尾执行——那时这一帧已经画完，
         * 画面上正好是球压在对方台面上的样子。 */
        if (ev === "table" && b.z < -0.05) {
          G.shotReq = { gain: gain, rally: G.rally, name: G.spinName };
        }
        G.nextServeAt = G.gt + 0.26;          // 用游戏时钟排下一拍，暂停安全
      }
      if (G.nextServeAt && G.gt >= G.nextServeAt) { G.nextServeAt = 0; serve(); }
    } else if (G.phase === "miss") {
      if (ev === "floor") { b.vx *= 0.9; b.vz *= 0.9; }
      if (G.overAt && G.gt >= G.overAt) { G.overAt = 0; gameOver(G.msg + "　" + G.msgSub); }
      else if (G.overAt && G.mark && G.mark.t < 0.35) G.mark.t = 0.35;   // 标注留到结算那一刻
    }
  }
}

/* ==================== 9. 渲染 ==================== */
const _v = { a: null };
function render3D() {
  if (!THREE_OK || !REND) return;
  const b = G.ball;
  const fdt = FDT;
  const live = G.running && G.phase !== "idle";

  // 球
  OBJ.ball.visible = live;
  OBJ.ball.position.set(b.x, b.y, b.z);
  if (b.spinAmt > 1) {
    const ax = new THREE.Vector3(b.wx, b.wy, b.wz).normalize();
    OBJ.ballSkin.rotateOnWorldAxis(ax, b.spinAmt * fdt);   // 只转内层贴图球，外层光晕保持正球
  }
  // 远景保底：屏幕投影半径不足 3.5px 时把光晕撑开，杜绝"远台小圆点糊成方块"
  if (OBJ.ball.userData.halo) {
    const dist = CAM.position.distanceTo(OBJ.ball.position);
    const px = BR * (window.innerHeight / 2) / (Math.tan(CAM.fov * Math.PI / 360) * dist);
    OBJ.ball.userData.halo.scale.setScalar(px < 3.5 ? 3.5 / Math.max(px, 0.2) : 1);
  }

  // 旋转箭头
  const showArrow = live && G.assist && G.phase === "incoming" && b.spinAmt > 45;
  OBJ.arrow.visible = showArrow;
  if (showArrow) {
    OBJ.arrow.position.set(b.x, b.y, b.z);
    const ax = new THREE.Vector3(b.wx, b.wy, b.wz).normalize();
    OBJ.arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ax);
    OBJ.arrowArc.material.color.set(G.spinColor);
    OBJ.arrowTip.material.color.set(G.spinColor);
  }

  // 轨迹残影：越旧越小越淡（半径上限压到球的 50%，远看只是"一道气"）
  for (let i = 0; i < OBJ.trail.length; i++) {
    const m = OBJ.trail[i];
    const idx = G.trail.length - 1 - i;
    if (idx >= 0 && live) {
      const p = G.trail[idx];
      m.visible = true;
      m.position.set(p.x, p.y, p.z);
      const k = 1 - i / OBJ.trail.length;      // 1 = 最新
      m.scale.setScalar(0.30 + k * 0.70);
      m.material.opacity = 0.03 + k * 0.12;
    } else m.visible = false;
  }

  // 预测落点
  const showLand = G.assist && G.phase === "incoming" && !G.hitDone && G.predZ2;
  OBJ.land.visible = !!showLand;
  if (showLand) OBJ.land.position.set(G.predZ2x, T.h + 0.003, G.predZ2);

  // 失败落点标注
  if (G.mark && G.mark.t > 0) {
    G.mark.t -= fdt;
    OBJ.fmark.visible = true;
    OBJ.fmark.position.set(G.mark.x, T.h + 0.004, G.mark.z);
    const pulse = 0.9 + Math.sin(G.gt * 9) * 0.12;
    OBJ.fmark.scale.setScalar(pulse);
  } else OBJ.fmark.visible = false;

  // 击球点标记：告诉玩家球在屏幕上的位置，给「提前量」一个可练的参照
  const showAim = showRing0();
  OBJ.aim.visible = showAim;
  if (showAim) {
    OBJ.aim.position.set(0, 0.96, HIT_Z);
    OBJ.aim.lookAt(CAM.position);
  }

  // 击球时机环
  const showRing = showRing0();
  OBJ.ring.visible = showRing;
  if (showRing) {
    OBJ.ring.position.set(b.x, b.y, b.z);
    OBJ.ring.lookAt(CAM.position);
    let prog;
    if (G.idealSet) prog = 1 + (G.gt - G.tIdeal) / 0.35;
    else if (G.predHitT > 0.05) prog = (G.gt - G.serveT) / G.predHitT;
    else prog = 1;
    /* ring.scale 的单位是「环基础半径 1.0」的倍数，所以半径必须乘 1.0 而非球半径 BR，
     * 否则环会缩到一个像素点。这里直接按目标环半径（米）设 scale。 */
    const rr = (0.020 * 1.25 + Math.max(0, 1 - prog) * 0.068) * 1.7;
    OBJ.ring.scale.setScalar(rr);
    const good = Math.abs(prog - 1) < 0.28;
    OBJ.ring.material.color.set(good ? C.ok : C.accent);
    OBJ.ring.material.opacity = good ? 0.95 : 0.6;
  }

  // 对手挥拍
  if (OBJ.opp) {
    const a = G.opp.anim;
    const sw = a >= 0 ? Math.sin(a * Math.PI) : 0;
    OBJ.opp.rotation.x = -0.35 + sw * 1.35;
    OBJ.opp.rotation.z = 0.30 - sw * 0.85;
  }

  // 玩家球拍演出（顺带采集运动痕迹）
  updatePaddle();
  renderGhosts(fdt);

  // 相机抖动
  CAM.position.set(0, CAM_Y, CAM_Z);
  if (G.shake > 0.001) {
    CAM.position.x += (Math.random() - 0.5) * G.shake * 2;
    CAM.position.y += (Math.random() - 0.5) * G.shake * 2;
  }
  CAM.lookAt(0, 0.96, -0.3);

  REND.render(SCENE, CAM);

  /* 落台抓帧：在离屏渲染器上补拍，不动主画布（见 captureShot 的注释）。
   * 放在主 render 之后只是为了让「球压在对方台面」这个状态已经更新完。 */
  if (G.shotReq) { captureShot(G.shotReq); G.shotReq = null; }
}

/* 抓帧机位。游戏是第一视角固定机位，直接截三张图会长得一模一样，
 * 拼到海报上等于贴了三张同样的照片。所以抓帧时另起一个戏剧化机位在离屏画布上补拍，
 * 三个角度轮流用——海报要的就是"夸张"。主画布全程不动，玩家看不到任何切换。 */
/* 用「方位角 / 仰角 / 距离」参数化，而不是手写坐标。
 * 距离必须逐个机位单独给：仰角越大，2.74m 的台长在屏幕上越接近纵向铺开，
 * 同一个距离在低机位够用、在俯拍就会把台子顶出画面（实测 NDC 到 1.47）。
 * 判据也不是"整张台入画"——海报真正要交代的是球落在对方半台的哪里，
 * 所以取景以「对方半台完整 + 落点在画面内」为准。 */
const SHOT_CAMS = [
  { az: 62, el: 16, d: 2.10 },   // 低机位斜视：贴着台面看落点
  { az: 26, el: 36, d: 2.45 },   // 越肩斜俯：从持拍手后上方望过去
  { az: 0,  el: 66, d: 2.15 }    // 正俯拍：球台与落点一目了然
];
/* 瞄准「对方半台的中心」而不是球台中心：海报要交代的是球落在对方台面哪里，
 * 瞄台心会让镜头后退、落点缩成一个小点，还会把近端推到镜头正下方挤出画面。 */
const SHOT_TARGET = [0, 0.76, -T.halfL * 0.5];
let SHOT_IDX = 0;

function shotCamPos(az, el, d) {
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  return [SHOT_TARGET[0] + d * Math.cos(e) * Math.sin(a),
          SHOT_TARGET[1] + d * Math.sin(e),
          SHOT_TARGET[2] + d * Math.cos(e) * Math.cos(a)];
}

/* ===== 抓帧用离屏渲染器 =====
 * 为什么必须是离屏：旧实现直接在**主渲染器**上临时换机位补渲染一帧，
 * 渲染完再把机位还原。但那一帧已经写进默认帧缓冲，浏览器下一次合成
 * 就会把它合成上屏 —— 玩家看到画面「闪」成了俯拍/斜视全景，再瞬间切回第一视角。
 * 这是用户明确反馈的 bug，靠「还原得够快」是治不好的：只要用主渲染器渲染，
 * 就必然有一次非第一视角的画面被上屏。
 * 离屏渲染器有独立的 canvas 与帧缓冲，主画布全程碰都不碰，
 * 「闪一下非第一视角」从根上不可能发生。 */
let SHOT_REND = null, SHOT_CAM = null, SHOT_CV = null;
const SHOT_W = 640, SHOT_H = 400;      // 16:10，与机位标定时的画幅一致
let SHOT_DEAD = false;                 // 离屏不可用（WebGL 上下文耗尽等），别再反复重建

function shotRenderer() {
  if (SHOT_REND || SHOT_DEAD) return SHOT_REND;
  if (typeof THREE === "undefined") return null;
  try {
    SHOT_CV = document.createElement("canvas");
    SHOT_CV.width = SHOT_W; SHOT_CV.height = SHOT_H;
    SHOT_REND = new THREE.WebGLRenderer({ canvas: SHOT_CV, antialias: true,
                                          preserveDrawingBuffer: true });
    SHOT_REND.setPixelRatio(1);
    SHOT_REND.setSize(SHOT_W, SHOT_H, false);
    SHOT_REND.shadowMap.enabled = true;
    SHOT_REND.shadowMap.type = THREE.PCFSoftShadowMap;
    /* 机位是离线标定到「对方半台完整入画」的，标定时画幅是 16:10。
     * 这里固定 16:10（而不是跟随窗口比例），海报三格取景才不会随窗口大小变。 */
    SHOT_CAM = new THREE.PerspectiveCamera(40, SHOT_W / SHOT_H, 0.05, 60);
    return SHOT_REND;
  } catch (e) { SHOT_DEAD = true; SHOT_REND = null; return null; }
}

/* 抓帧：在离屏画布上补拍一帧 640×400 再编码，三张图合计只有几百 KB */
function captureShot(req) {
  try {
    /* 离屏渲染器建不出来就跳过这张图：宁可海报少一格，也绝不退回主画布闪一下 */
    if (!shotRenderer() || !SCENE) return;
    const preset = SHOT_CAMS[SHOT_IDX++ % SHOT_CAMS.length];
    const cp = shotCamPos(preset.az, preset.el, preset.d);
    SHOT_CAM.position.set(cp[0], cp[1], cp[2]);
    SHOT_CAM.lookAt(SHOT_TARGET[0], SHOT_TARGET[1], SHOT_TARGET[2]);
    SHOT_CAM.updateMatrixWorld(true);
    SHOT_REND.render(SCENE, SHOT_CAM);
    let ndc = [0, 0];
    try {
      const v = new THREE.Vector3(G.ball.x, G.ball.y, G.ball.z).project(SHOT_CAM);
      ndc = [v.x, v.y];
    } catch (e) {}
    const url = SHOT_CV.toDataURL("image/jpeg", 0.72);
    /* ndc 是「落点在补拍那一帧的屏幕坐标」，海报据此画落点标记。 */
    G.shots.push({ url: url, gain: req.gain, rally: req.rally, name: req.name, ndc: ndc });
    // 只留分值最高的 3 张；同分则保留后打出的（越往后难度越高，含金量更大）
    G.shots.sort((a, b) => (b.gain - a.gain) || (b.rally - a.rally));
    if (G.shots.length > 3) G.shots.length = 3;
  } catch (e) { /* 抓帧失败不影响对局 */ }
}

/* ===== 球拍运动痕迹 =====
 * 第一视角下挥拍要「看得出挥过」，但不能抢戏：薄圆片 + 加法混合 + 上限 0.15 的不透明度，
 * 0.28s 内淡出。采样只在挥拍真正入画后进行，拍子没出现就没有痕迹。 */
const GHOST_LIFE = 0.28;
function sampleGhost(r) {
  const q = G.ghosts;
  const last = q[q.length - 1];
  if (last && Math.hypot(r.position.x - last.x, r.position.y - last.y, r.position.z - last.z) < 0.018) return;
  q.push({ x: r.position.x, y: r.position.y, z: r.position.z,
           rx: r.rotation.x, ry: r.rotation.y, rz: r.rotation.z, age: 0 });
  if (q.length > OBJ.ghosts.length) q.shift();
}
function renderGhosts(fdt) {
  const q = G.ghosts, n = OBJ.ghosts.length;
  for (let i = q.length - 1; i >= 0; i--) {
    q[i].age += fdt;
    if (q[i].age > GHOST_LIFE) q.splice(i, 1);
  }
  for (let i = 0; i < n; i++) {
    const m = OBJ.ghosts[i], g = q[i];
    if (!g) { m.visible = false; continue; }
    m.visible = true;
    m.position.set(g.x, g.y, g.z);
    m.rotation.set(g.rx, g.ry, g.rz);
    const k = Math.max(0, 1 - g.age / GHOST_LIFE);      // 剩余寿命
    const w = (i + 1) / Math.max(3, q.length);          // 越新越亮
    m.material.opacity = 0.15 * k * k * w;
    m.scale.setScalar(0.72 + 0.28 * w);
  }
}

/* 时机环与击球点标记的显示条件：来球飞行中、尚未击球、且已进入可击球区域 */
function showRing0() {
  return G.phase === "incoming" && !G.hitDone && G.ball.z > 0.1;
}

function updatePaddle() {
  const P = G.paddle;
  const r = P.side < 0 ? OBJ.racket : OBJ.racketL;      // 反手从右下、正手从左下入画
  const other = P.side < 0 ? OBJ.racketL : OBJ.racket;
  if (other) other.visible = false;
  if (!r) return;
  if (P.anim < 0) { r.visible = false; return; }
  /* 「松手 → 入画」延迟：拖快球来不及摆拍，用上一拍的延时兜底。
   * 落地时若拍子还没走完，前推段插值出的位置正好就在击球点附近，不会出现"球拍失踪"。 */
  if (P.pend > 0) { P.pend = Math.max(0, P.pend - FDT); r.visible = false; return; }
  r.visible = true;
  /* 入画点原来放在 (side*0.34, 0.95, 1.66)。相机在 (0,1.84,2.72)、FOV 40°，
   * 那个位置投影到 NDC 的 y ≈ -0.83，也就是屏幕最底边——球拍确实渲染了，
   * 但只占屏高约 5%，贴边又贴底，玩家根本注意不到，观感就是"球拍没出现"。
   * 整体上抬 z 也拉近，让球拍在中下偏右/左的"演出区"里明显可见。 */
  /* 入画点原来放在 (side*0.34, 0.95, 1.66)。相机在 (0,1.84,2.72)、FOV 40°，
   * 那个位置投影到 NDC 的 y ≈ -0.83，也就是屏幕最底边——球拍确实渲染了，
   * 但只占屏高约 5%，贴边又贴底，玩家根本注意不到，观感就是"球拍没出现"。
   * 现在抬到中下区的"演出区"：既明显可见，又不会大幅遮挡来球与台面。
   * z 也不能压太近（曾经到 0.86，刀身糊满半个屏幕），1.15 左右透视尺度才像真球拍。 */
  const t = P.anim, side = P.side, act = P.action;
  const wide = act === "拨" ? 1.55 : 1.0;          // 横拉幅度更大
  const start  = { x: side * 0.36, y: 1.10, z: 1.72 };   // 画面中下（入画点）
  const prep   = { x: side * 0.30, y: 1.20, z: 1.42 };   // 手腕内收
  const hit    = { x: P.hx * 0.62 + side * 0.10, y: Math.max(0.98, P.hy + 0.05), z: 1.15 };  // 前推到击球点
  const out    = { x: side * 0.42 * wide, y: 1.26, z: 1.02 };  // 外展收拍

  /* 三段式：入画内收(0~0.22) → 前推到击球点(0.22~0.62) → 外展收拍(0.62~1)。
   * 关键：全程时长由 P.dur 决定（默认 0.34s），而前推段的结束点 ≈ 松手后 0.21s，
   * 正好压在球拍刚入画的那一刻——玩家松手后几乎立刻就能看到拍子穿过击球点，
   * 不会再有"球都比完了，拍子才慢悠悠飘过来"的脱节感。 */
  let p, rz, rx;
  if (t < 0.22) {                                   // 手腕内收
    const k = t / 0.22;
    p = lerp3(start, prep, k);
    rz = side * (0.85 - 0.30 * k); rx = -0.55 + 0.30 * k;
  } else if (t < 0.62) {                            // 前推（加速段）
    const k = (t - 0.22) / 0.40;
    const e = k * k * (3 - 2 * k);                  // smoothstep：中段更快，更"发力"
    p = lerp3(prep, hit, e);
    rz = side * (0.55 - 0.50 * e); rx = -0.25 - 0.30 * e;
  } else {                                          // 外展
    const k = (t - 0.62) / 0.38;
    p = lerp3(hit, out, k);
    rz = side * (0.05 - 0.70 * k * wide); rx = -0.55 + 0.25 * k;
  }
  r.position.set(p.x, p.y, p.z);
  r.rotation.set(rx + G.paddleAngle * 0.45, 0, rz);
  /* 近大远小由透视自然给出，这里给一点点整体放大让它够醒目。
   * 曾试过 1.35×，结果刀身在击球点糊满大半个屏幕像"玩具拍怼脸"，回调到 1.0。
   * scale 只影响视觉体量，不参与任何判定。 */
  r.scale.setScalar(1.0);
  sampleGhost(r);          // 采集这一帧的拍面位置，形成挥拍残影
}
function lerp3(a, b, k) {
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
}

/* ==================== 10. HUD 与流程 ==================== */
function updateHUD() {
  UI.uiRally.textContent = G.rally;
  UI.uiBest.textContent = G.best;
  UI.uiLevel.textContent = G.level + (G.level >= MAX_LEVEL ? " · 满" : "");

  // 来球类型：高难度档加入"假动作"——延后才显示
  let name = G.spinName;
  if (G.phase === "incoming" && G.level >= 4 && G.predHitT > 0) {
    if ((G.gt - G.serveT) < G.predHitT * 0.35) name = "？";
  }
  UI.uiType.textContent = G.assist ? name : "—";
  UI.uiType.style.color = G.spinColor;
  UI.uiTypeSub.textContent = G.assist ? "辅助提示已开启" : "辅助已关闭，靠弧线判断";

  UI.uiMode.textContent = G.backhand ? "反手" : "正手";
  UI.uiAssist.textContent = G.assist ? "辅助 开" : "辅助 关";
  const pa = G.paddleAngle;
  UI.barMark.style.left = (50 + pa * 46) + "%";
  UI.barTxt.textContent = pa < -0.25 ? "压拍 " + pa.toFixed(2)
                        : pa > 0.25 ? "亮拍 +" + pa.toFixed(2) : "拍面中立";

  if (UI.uiScore) UI.uiScore.textContent = G.score;
  if (UI.uiStreak) UI.uiStreak.textContent = G.goodStreak > 0 ? "连准 " + G.goodStreak : "";

  UI.msg.textContent = G.msgT > 0 ? G.msg : "";
  UI.msg.style.color = G.msgColor;
  UI.msgSub.textContent = G.msgT > 0 ? G.msgSub : "";
  UI.msgSub.style.color = G.msgColor;
  syncTouchCtl();                       // 触屏控制簇按钮态随暂停/辅助/正反手变化（Task 7）
}

/* ===== 本地纪录系统（纯前端，无账号、无服务器） =====
 * 「跨局目标」是留存的结构性缺口 —— 原来只存一个 best 数字，玩家没有
 * 任何「我正在变强」的证据。这套纪录把时间视野从「这一局」拉长到「第 10 局」。
 *
 * 数据契约（结构改动必须同步 _smoke.js 的断言）：
 *   fpp_mode     "practice" | "challenge"
 *   fpp_records  {
 *                  best:  { practice:N, challenge:N },   每模式最佳回球数
 *                  score: { practice:N, challenge:N },   每模式最佳得分
 *                  level: { "1":N ... "8":N },           每档最佳（仅挑战模式）
 *                  history: [ {rally,score,level,mode,good,ts} ]  按 score 降序，最多 10 条
 *                }
 *   fpp_best / fpp_best_score  旧版单值。首次启动迁移进 fpp_records 后不再写入，
 *                              但**保留不删** —— 万一玩家回退到旧版本，纪录还在。
 *
 * 所有读写都包 try/catch：隐私模式会直接禁掉 localStorage，内容也可能被用户
 * 手改坏。任一情况都不该让游戏起不来 —— 这是本地存储最容易踩的坑。 */
const HISTORY_MAX = 10;
const REC_KEY = "fpp_records";
const MODE_KEY = "fpp_mode";

function lsJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return fallback;
    return JSON.parse(raw);
  } catch (e) { return fallback; }
}
function lsWrite(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}
/* 数字兜底：非数字 / 负数 / NaN / Infinity 一律归 0，避免脏数据把纪录算成 NaN */
function safeNum(v) {
  return (typeof v === "number" && isFinite(v) && v > 0) ? Math.floor(v) : 0;
}
function emptyRecords() {
  return { best: { practice: 0, challenge: 0 },
           score: { practice: 0, challenge: 0 },
           level: {}, history: [] };
}
function validRec(r) {
  return !!r && typeof r === "object" && isFinite(r.score) && isFinite(r.rally);
}
function loadRecords() {
  const d = emptyRecords();
  const r = lsJson(REC_KEY, null);
  if (!r || typeof r !== "object") return d;
  /* 逐字段兜底：任一项类型不对就退回默认值，而不是让整套纪录瘫痪 */
  if (r.best && typeof r.best === "object") {
    d.best.practice = safeNum(r.best.practice);
    d.best.challenge = safeNum(r.best.challenge);
  }
  if (r.score && typeof r.score === "object") {
    d.score.practice = safeNum(r.score.practice);
    d.score.challenge = safeNum(r.score.challenge);
  }
  if (r.level && typeof r.level === "object") {
    for (const k in r.level) {
      if (Object.prototype.hasOwnProperty.call(r.level, k) && safeNum(r.level[k]) > 0) {
        d.level[k] = safeNum(r.level[k]);
      }
    }
  }
  if (Array.isArray(r.history)) {
    d.history = r.history.filter(validRec).sort(byScoreDesc).slice(0, HISTORY_MAX)
                       .map(function (x) {
                         return { rally: safeNum(x.rally), score: safeNum(x.score),
                                  level: safeNum(x.level) || 1,
                                  mode: x.mode === "challenge" ? "challenge" : "practice",
                                  good: safeNum(x.good), ts: safeNum(x.ts) || 0 };
                       });
  }
  return d;
}
function byScoreDesc(a, b) { return b.score - a.score; }
function saveRecords(r) { lsWrite(REC_KEY, r); }

/* 旧版单值迁移：老玩家攒下的 fpp_best / fpp_best_score 不能丢。
 * 旧版没有模式概念 → 统一当作练习模式纪录（练习模式是默认模式，语义一致）。 */
function migrateLegacy() {
  try {
    if (localStorage.getItem(REC_KEY) !== null) return false;   // 已是新结构
    const ob = safeNum(parseInt(localStorage.getItem("fpp_best") || "0", 10));
    const os = safeNum(parseInt(localStorage.getItem("fpp_best_score") || "0", 10));
    if (!ob && !os) return false;
    const r = emptyRecords();
    r.best.practice = ob; r.score.practice = os;
    saveRecords(r);
    return true;
  } catch (e) { return false; }
}

/* 模式：练习（辅助提示开、不计榜）/ 挑战（无辅助、计榜）。见 setMode。 */
function loadMode() {
  try { return localStorage.getItem(MODE_KEY) === "challenge" ? "challenge" : "practice"; }
  catch (e) { return "practice"; }
}
function saveMode(m) { try { localStorage.setItem(MODE_KEY, m); } catch (e) {} }
function modeKey() { return G.mode === "challenge" ? "challenge" : "practice"; }

/* 当前模式的最佳纪录。G.best 是运行期镜像，存盘走 saveBest()。 */
function loadBest() { return loadRecords().best[modeKey()] || 0; }
function saveBest() {
  const r = loadRecords();
  r.best[modeKey()] = G.best;
  saveRecords(r);
}
function loadBestScore() { return loadRecords().score[modeKey()] || 0; }
function saveBestScore(v) {
  const r = loadRecords();
  r.score[modeKey()] = v;
  saveRecords(r);
}

/* 一局结束：更新最佳、每档最佳、并入历史榜。返回写入后的完整纪录，供结束页渲染。 */
function commitResult(rec) {
  const r = loadRecords();
  const m = rec.mode === "challenge" ? "challenge" : "practice";
  if (rec.rally > r.best[m]) r.best[m] = rec.rally;
  if (rec.score > r.score[m]) r.score[m] = rec.score;
  /* 历史榜只收挑战模式成绩 —— 练习模式开着辅助提示（且可随时开关），
   * 成绩没有可比性。这条规则是排行榜可信度的前提，也是竞品排行榜
   * 普遍失去玩家信任的反面教材（Ping Pong Fury 的「装备碾压」同源问题）。
   * 练习模式仍单独维护自己的最佳值，只是不进榜。 */
  if (m === "challenge") {
    const k = String(rec.level);
    if (!r.level[k] || rec.rally > r.level[k]) r.level[k] = rec.rally;
    const h = r.history.concat([rec]);
    h.sort(byScoreDesc);
    r.history = h.slice(0, HISTORY_MAX);
  }
  saveRecords(r);
  return r;
}

/* 清空全部纪录（仅调试/测试用，界面未暴露入口） */
function clearRecords() {
  try { localStorage.removeItem(REC_KEY); localStorage.removeItem("fpp_best");
        localStorage.removeItem("fpp_best_score"); } catch (e) {}
}

/* 切换模式。两个模式的差异**刻意只有一处**：辅助提示。
 *   练习模式 → 辅助默认开（H 仍可关）、成绩不计榜、不影响个人最佳
 *   挑战模式 → 辅助强制关（H 无效）、成绩计入历史榜与每档最佳
 *
 * 为什么不在难度 / 球速 / 来球池上做区分：一旦区分，两者就变成「两个游戏」，
 * 榜单与失败统计失去可比性，玩家也无法在练习中积累可迁移到挑战的经验。
 * 双模式存在的意义是「给新手一条低门槛路径，但不降低高门槛路径的标准」——
 * 这是避免「为留人而降难度」那条转嫁负担陷阱的机制设计。 */
function setMode(m) {
  G.mode = m === "challenge" ? "challenge" : "practice";
  G.assist = (G.mode === "practice");
  saveMode(G.mode);
  G.best = loadBest();
  G.prevBestScore = loadBestScore();
  syncModeUI();
}
function isRanked() { return G.mode === "challenge"; }

function restart() {
  G.running = true; G.paused = false;
  G.rally = 0; G.level = 1; G.gt = 0; G.msgT = 0; G.msg = ""; G.msgSub = "";
  G.msgPri = 0; G.msgHold = 0; G.msgQueue.length = 0;   // 清掉上一局排队的提示
  hideSettle();
  G.paddleAngle = 0; G.trail.length = 0;
  G.score = 0; G.goodStreak = 0; G.landErr = null; G.pending = null; G.cheerT = 0;
  G.paddle.anim = -1; G.paddle.pend = 0; G.mark = null;
  G.shots = []; G.shotReq = null; G.ghosts.length = 0;
  G.statSpinTotal = 0; G.statSpinHit = 0; G.statErrSum = 0; G.statErrN = 0; G.statMaxSpeed = 0;
  G.failTotal = 0; G.failStats = {}; G.goodTotal = 0;   // 本局失败归因与精准拍数清零
  G.best = loadBest();                        // 按当前模式取最佳（模式可能刚被切换）
  G.bestAtStart = G.best;                     // 快照：用来算「距个人最佳还差 N 球」
  G.prevBestScore = loadBestScore();          // 「上次成绩」= 上一局的得分纪录
  UI.startScreen.classList.add("hidden");
  UI.endScreen.classList.add("hidden");
  UI.pauseScreen.classList.add("hidden");
  serve();
}
function togglePause() {
  if (!G.running) return;
  G.paused = !G.paused;
  if (G.paused) UI.pauseScreen.classList.remove("hidden");
  else UI.pauseScreen.classList.add("hidden");
}
function gameOver(reason) {
  G.running = false; G.phase = "over";
  hideSettle();                                    // 结束页接管，撤掉结算动画
  UI.endReason.textContent = reason || "";
  UI.uiFinal.textContent = G.rally;
  if (UI.uiScore2) UI.uiScore2.textContent = G.score;

  /* 只有挑战模式算「破纪录」：练习模式的成绩不具备可比性（见 commitResult），
   * 在练习模式里弹「新纪录」等于自欺，还会让海报的价值贬值。 */
  const ranked = isRanked();
  const isNew = ranked && G.score > G.prevBestScore;
  if (UI.uiPrevBest) UI.uiPrevBest.textContent = G.prevBestScore;
  if (UI.newBadge) UI.newBadge.classList.toggle("on", isNew);

  /* 先落库再渲染 —— renderBoard 要读「写入后」的榜单才能标出本局名次 */
  const rec = { rally: G.rally, score: G.score, level: G.level,
                mode: G.mode, good: G.goodTotal, ts: Date.now() };
  const recs = commitResult(rec);
  G.records = recs;
  if (isNew) { saveBestScore(G.score); G.prevBestScore = G.score; }

  renderModeTag();
  renderGap();
  renderFailBreakdown();
  renderBoard(rec, recs);

  UI.endTip.textContent = ranked
    ? (G.rally >= 10 ? "挑战模式已无提示 —— 这个成绩是真实水平，再来一局试试"
       : G.rally >= 5 ? "记住：上旋压拍、下旋亮拍、侧旋反向补"
       : "看不清旋转就先回练习模式开着辅助提示熟悉几局")
    : (G.rally >= 10 ? "手感不错，关掉辅助提示（H）试试挑战模式"
       : G.rally >= 5 ? "记住：上旋压拍、下旋亮拍、侧旋反向补"
       : "看不清旋转就先开着辅助提示，注意球上的旋转箭头方向");
  UI.endScreen.classList.remove("hidden");
  if (UI.posterBtn) UI.posterBtn.style.display = G.shots.length ? "" : "none";
  /* 破纪录才自动亮海报：取本局分值最高的三次落台瞬间。
   * 晚 0.4s 弹出，让玩家先看到结算数字，再看高光回放。 */
  if (isNew && G.shots.length) setTimeout(openPoster, 400);
}

/* ===== 结束页的三块新信息（模式标签 / 进步幅度 / 失败构成 / 历史榜） ===== */

/* 本局所属模式。挑战模式必须显式告诉玩家「这局是计榜的」，
 * 否则榜单出现新条目时玩家会莫名其妙。 */
function renderModeTag() {
  const el = UI.endMode; if (!el) return;
  el.textContent = isRanked() ? "挑战模式 · 计入排行榜" : "练习模式 · 不计入排行榜";
  el.className = "modeTag " + (isRanked() ? "ranked" : "practice");
}

/* 「距个人最佳还差 N 球」—— 把「我到底有没有进步」变成一个具体数字。
 * G.best 会在打出新纪录的瞬间就被刷新（HUD 要实时显示），到结束页时已无从
 * 判断本局是否破纪录，所以用开局快照 G.bestAtStart 做对比。 */
function renderGap() {
  const el = UI.endGap; if (!el) return;
  const base = G.bestAtStart, cur = G.rally;
  if (base <= 0) {
    el.innerHTML = "本模式首个纪录：<b>" + cur + "</b> 拍";
    el.classList.add("isNew");
  } else if (cur > base) {
    el.innerHTML = "已刷新本模式最佳　<b>+" + (cur - base) + "</b> 拍（原 " + base + " 拍）";
    el.classList.add("isNew");
  } else if (cur === base) {
    el.innerHTML = "追平本模式最佳　<b>" + base + "</b> 拍";
    el.classList.remove("isNew");
  } else {
    el.innerHTML = "距本模式最佳还差　<b>" + (base - cur) + "</b> 拍（最佳 " + base + " 拍）";
    el.classList.remove("isNew");
  }
}

/* 本局失败构成：把「系统知道但玩家看不到」的信息摊开。
 * 玩家原来只知道「我输了」，不知道「我反复栽在同一类问题上」——
 * 这是跨 14 款竞品的最高频差评（判定存疑 / 不知道错在哪），
 * 也是本产品已有的物理内核与五类失败归因真正该变现的地方。 */
function renderFailBreakdown() {
  const wrap = UI.failWrap, list = UI.failList, main = UI.failMain;
  if (!wrap || !list) return;
  const rows = [];
  for (let i = 0; i < FAIL_BUCKETS.length; i++) {
    const n = G.failStats[FAIL_BUCKETS[i]] || 0;
    if (n > 0) rows.push({ k: FAIL_BUCKETS[i], n: n });
  }
  if (!rows.length) { wrap.style.display = "none"; return; }   // 无数据时不渲染空块
  wrap.style.display = "";
  rows.sort(function (a, b) { return b.n - a.n; });
  const total = rows.reduce(function (s, r) { return s + r.n; }, 0);
  if (main) {
    main.innerHTML = "本局主要问题：<b>" + rows[0].k + "</b>"
      + (total > 1 ? "　（" + rows[0].n + "/" + total + "）" : "");
  }
  let html = "";
  for (let i = 0; i < rows.length; i++) {
    const pct = Math.round(rows[i].n / total * 100);
    html += '<div class="fbRow' + (i === 0 ? " isTop" : "") + '">'
          + '<span class="fbName">' + rows[i].k + '</span>'
          + '<span class="fbBar"><i style="width:' + pct + '%"></i></span>'
          + '<span class="fbNum num">' + rows[i].n + ' 次</span>'
          + '</div>';
  }
  list.innerHTML = html;
}

/* 历史前十（仅挑战模式）。本局在榜内则高亮。
 * 无历史时整块不渲染 —— 宁可不显示，也不要给玩家一张空表。 */
function renderBoard(rec, recs) {
  const wrap = UI.boardWrap, list = UI.boardList;
  if (!wrap || !list) return;
  if (!isRanked()) {
    /* 练习模式不列榜，改为一句引导：这是「邀请玩家进挑战模式」的最低成本做法，
     * 比让玩家自己在两个模式之间猜要好。 */
    wrap.style.display = "";
    if (UI.boardTitle) UI.boardTitle.textContent = "练习模式不计入排行榜";
    list.innerHTML = '<div class="boardEmpty">辅助提示可以看清旋转，'
      + '但成绩不进榜。<br>熟悉球路后切到 <b>挑战模式</b>，看看你能排第几。</div>';
    return;
  }
  const h = (recs && recs.history) || [];
  if (!h.length) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  if (UI.boardTitle) UI.boardTitle.textContent = "挑战模式 · 历史前十局";
  let html = "";
  for (let i = 0; i < h.length; i++) {
    const e = h[i];
    const isCur = e.ts === rec.ts;                // 本局（ts 由 Date.now() 生成，唯一）
    html += '<div class="bdRow' + (isCur ? " isCur" : "") + '">'
          + '<span class="bdRank num">' + (i + 1) + '</span>'
          + '<span class="bdMain num">' + e.score + ' 分</span>'
          + '<span class="bdSub">' + e.rally + ' 拍 · ' + e.good + ' 准 · ' + e.level + ' 档</span>'
          + '<span class="bdTime">' + fmtStamp(e.ts) + '</span>'
          + '</div>';
  }
  list.innerHTML = html;
}
function fmtStamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = function (n) { return (n < 10 ? "0" : "") + n; };
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ===== 分享海报（方案A 技术统计板） ===== */
function posterData() {
  const d = new Date();
  const p = n => (n < 10 ? "0" : "") + n;
  return {
    shots: G.shots.slice(0, 3),
    rally: G.rally, score: G.score, prevBest: G.prevBestScore,
    /* 练习模式不上「新纪录」章 —— 海报会被分享出去，标了就是虚假宣传 */
    isNew: isRanked() && G.score > 0 && G.score >= G.prevBestScore,
    mode: G.mode,
    spinRate: G.statSpinTotal ? Math.round(G.statSpinHit / G.statSpinTotal * 100) : null,
    spinHit: G.statSpinHit, spinTotal: G.statSpinTotal,
    accCm: G.statErrN ? (G.statErrSum / G.statErrN * 100) : null,
    maxKmh: G.statMaxSpeed ? G.statMaxSpeed * 3.6 : null,
    url: GAME_URL,
    dateStr: d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes())
  };
}
function openPoster() {
  if (!window.POSTER || !UI.posterCv) return;
  UI.endScreen.classList.add("hidden");
  UI.posterScreen.classList.remove("hidden");
  POSTER.show(UI.posterCv, posterData());
}

/* ==================== 11. 启动 ==================== */
/* Logo 注入：HTML 里只留 <span data-logo="62"> 占位，形状由 poster.js 统一产出，
 * 保证界面（开始页 / 结束页 / 左上品牌行）与海报的 logo 永远一致。 */
function injectLogos() {
  if (!window.POSTER) return;
  const nodes = document.querySelectorAll("[data-logo]");
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    n.innerHTML = POSTER.logoSvg(parseInt(n.getAttribute("data-logo"), 10) || 48);
  }
}
/* 二维码不在这里加载：矩阵已内联进 poster.js，同步绘制。
 * 这里刻意不留任何「异步补图」的钩子——那正是海报出现空白框的根源。 */

/* 模式卡片：点选只切换，不直接开局 —— 让玩家先读完两个模式的差异说明。
 * 最后按「开始对局」才真正进局（见 restart）。 */
function bindModeCards() {
  if (UI.modePractice) UI.modePractice.addEventListener("click", function () { setMode("practice"); });
  if (UI.modeChallenge) UI.modeChallenge.addEventListener("click", function () { setMode("challenge"); });
}

function boot() {
  bindUI();
  injectLogos();
  migrateLegacy();                     // 旧版单值纪录 → 新结构（只跑一次，无旧数据则跳过）
  loadPrefs();                         // 音量 / 静音 / 练习模式下的辅助提示偏好
  /* loadMode + setMode 必须在 loadPrefs 之后：setMode 会按模式决定 G.assist
   * 并覆盖掉刚读出的偏好（挑战模式恒为 false）。顺序反了，挑战模式就会
   * 带着辅助提示开局 —— 榜单立刻失去可比性。 */
  setMode(loadMode());
  G.bestAtStart = G.best;
  bindModeCards();
  syncSoundUI();
  syncUiToggle();
  if (typeof THREE === "undefined") {
    THREE_OK = false;
    UI.errScreen.classList.remove("hidden");
    UI.errMsg.textContent = "three.js 未能加载，请确认 vendor/three.min.js 存在。";
    return;
  }
  try { buildScene(); }
  catch (e) {
    THREE_OK = false;
    UI.errScreen.classList.remove("hidden");
    UI.errMsg.textContent = (e && e.message) || String(e);
    return;
  }
  setupInput();
  setupTouchControls();                 // 触屏控制簇：仅粗指针下显示（Task 7）
  applySupportGate();                   // P2：初始设备/方向门控（引导层显隐）
  requestAnimationFrame(loop);
}
boot();
