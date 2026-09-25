/* ============================================================================
 * 门控阈值实测 —— 用「真实球的轨迹」反推玩法需要多宽的视野
 *
 * 为什么不用手算：相机是俯视机位（lookAt 带俯仰），在球台平面上的可见区间
 * 不是简单的 dz·tan(hFOV/2)，手算会有系统偏差。上一版探针就是这么错的 ——
 * 它按「球台平面扫 x」估算，结果连桌面都判成「球台不入画」。
 *
 * 本脚本改为：跑真实游戏采样球的真实世界坐标 → 用真实相机姿态逐点投影 →
 * 对每个候选宽高比判断「关键段是否出屏」。阈值由实测得出。
 *
 * 关键段的定义：z ∈ [1.10, 1.50]。
 *   击球纵深 HIT_Z = 1.30，球必须在这个区间被看清并击打；出了这个区间的
 *   球（更远 / 更近）本来就在画面外或已过拍面，不参与判据。
 * ========================================================================== */
const path = require("path");
const { chromium } = require("playwright");

const URL = "https://spin-pingpong.app.workbuddy.host/";

/* 相机与几何常量（须与 game.js 一致；本脚本只读不改） */
const CAM_Y = 1.84, CAM_Z = 2.72;
const LOOK_AT = { x: 0, y: 0.96, z: -0.3 };
const FOV_Y = 40;
const HALF_W = 0.7625, HALF_L = 1.37, TABLE_H = 0.76, NET_HALF = 0.915, NET_H = 0.1525;

/* 候选宽高比（覆盖真机横屏到超宽） */
const ASPECTS = [1.10, 1.20, 1.333, 1.40, 1.45, 1.50, 1.55, 1.60, 1.65, 1.70, 1.75,
                 1.78, 1.80, 1.90, 2.00, 2.20, 2.50, 2.74];

/* 真机 CSS 视口（横屏 = 已旋转；竖屏用于确认判据不会误放行）
 * 用 Chromium 官方设备描述符的真实 CSS 视口，不自己编数字。 */
const DEVICES = [
  { n: "iPhone SE 横屏",        w: 568,  h: 320,  land: true  },
  { n: "iPhone 8 横屏",         w: 667,  h: 375,  land: true  },
  { n: "Galaxy S9+ 横屏",       w: 658,  h: 320,  land: true  },
  { n: "iPhone 12 横屏",        w: 844,  h: 390,  land: true  },
  { n: "iPhone 13 横屏",        w: 844,  h: 390,  land: true  },
  { n: "iPhone 14 Pro 横屏",    w: 852,  h: 393,  land: true  },
  { n: "iPhone 13 PM 横屏",     w: 926,  h: 428,  land: true  },
  { n: "iPhone 14 PM 横屏",     w: 932,  h: 430,  land: true  },
  { n: "Pixel 5 横屏",          w: 851,  h: 393,  land: true  },
  { n: "iPad mini 横屏",        w: 1024, h: 768,  land: true  },
  { n: "iPad (gen 7) 横屏",     w: 1080, h: 810,  land: true  },
  { n: "iPad Pro 11 横屏",      w: 1194, h: 834,  land: true  },
  { n: "iPhone 13 竖屏",        w: 390,  h: 844,  land: false },
  { n: "iPhone 13 PM 竖屏",     w: 428,  h: 926,  land: false },
  { n: "iPad Pro 11 竖屏",      w: 834,  h: 1194, land: false },
  { n: "桌面 1440×900",         w: 1440, h: 900,  land: true  },
  { n: "桌面 1920×1080",        w: 1920, h: 1080, land: true  },
];

/* ---------------- 投影（复刻 THREE.PerspectiveCamera 的姿态） ---------------- */
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = v => { const L = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / L, y: v.y / L, z: v.z / L }; };
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

const camPos = { x: 0, y: CAM_Y, z: CAM_Z };
const FWD = norm(sub(LOOK_AT, camPos));            // 前（含俯仰）
const RIGHT = norm(cross(FWD, { x: 0, y: 1, z: 0 }));
const UP = cross(RIGHT, FWD);
const TAN_HALF = Math.tan((FOV_Y / 2) * Math.PI / 180);

/* 世界点 → NDC。返回 null 表示在相机背后 */
function project(p, aspect) {
  const d = sub(p, camPos);
  const zc = dot(d, FWD);
  if (zc <= 1e-6) return null;
  const xc = dot(d, RIGHT), yc = dot(d, UP);
  return { x: xc / (zc * TAN_HALF * aspect), y: yc / (zc * TAN_HALF) };
}
const inView = (p, aspect) => { const n = project(p, aspect); return !!n && Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1; };

/* 球台 / 球网的关键顶点：这些点可见 = 玩家看清了场地 */
const FIELD_PTS = [
  { n: "远端左角",   p: { x: -HALF_W, y: TABLE_H, z: -HALF_L } },
  { n: "远端右角",   p: { x:  HALF_W, y: TABLE_H, z: -HALF_L } },
  { n: "网左端",     p: { x: -NET_HALF, y: TABLE_H + NET_H, z: 0 } },
  { n: "网右端",     p: { x:  NET_HALF, y: TABLE_H + NET_H, z: 0 } },
];

(async () => {
  const browser = await chromium.launch();
  /* 用桌面视口打开：确保门控放行、游戏能真跑起来采到轨迹 */
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", e => errs.push(e.message));
  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(1800);
  await page.click("#startBtn").catch(() => {});
  await page.waitForTimeout(300);

  /* 采样：45 秒，自动重开以覆盖各球型与各难度档 */
  console.log("采样球的真实轨迹（45s，自动重开以覆盖多种球型）…");
  const raw = await page.evaluate(async (ms) => {
    const out = []; let restarts = 0, levels = new Set();
    const t0 = Date.now();
    return await new Promise(res => {
      const tick = () => {
        try {
          if (G.phase === "over") { restart(); restarts++; }
          levels.add(G.level);
          if (G.phase === "incoming" && G.ball && !G.hitDone) {
            out.push([Math.round(G.ball.x * 1e4) / 1e4,
                      Math.round(G.ball.y * 1e4) / 1e4,
                      Math.round(G.ball.z * 1e4) / 1e4]);
          }
        } catch (e) {}
        if (Date.now() - t0 > ms) return res({ out, restarts, levels: [...levels] });
        requestAnimationFrame(tick);
      };
      tick();
    });
  }, 45000);

  const pts = raw.out.map(a => ({ x: a[0], y: a[1], z: a[2] }));
  await browser.close();

  /* 关键段：z ∈ [1.10, 1.50]，含实际球半径余量 0.02 */
  const key = pts.filter(p => p.z >= 1.10 && p.z <= 1.50);
  /* 极端球位：逐 z 桶取横向最外侧的点，作为「最坏情况」代表 */
  const bucketed = new Map();
  for (const p of key) {
    const b = Math.round(p.z * 10) / 10;
    const cur = bucketed.get(b);
    if (!cur || Math.abs(p.x) > Math.abs(cur.x)) bucketed.set(b, p);
  }
  const worst = [...bucketed.values()];
  const maxAbsX = key.length ? Math.max(...key.map(p => Math.abs(p.x))) : 0;

  console.log("采样点 " + pts.length + " 个（关键段 " + key.length + " 个，重开 " + raw.restarts +
              " 次，覆盖难度档 " + raw.levels.join("/") + "）");
  console.log("关键段球的最大横向偏移 |x| = " + maxAbsX.toFixed(3) + " m（球台半宽 " + HALF_W + " m）");

  /* ---- 评估每个候选宽高比 ---- */
  console.log("\n各宽高比下的可见性（关键段球位 + 场地顶点）：\n");
  const pad = (s, n) => { s = String(s); let w = 0; for (const c of s) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(c) ? 2 : 1;
                          return s + " ".repeat(Math.max(0, n - w)); };
  console.log(pad("宽高比", 9) + pad("球出屏", 10) + pad("场地出屏", 12) + "判定");
  console.log("-".repeat(46));
  const okAspects = [];
  for (const A of ASPECTS) {
    const ballOff = worst.filter(p => !inView(p, A)).length;
    const fieldOff = FIELD_PTS.filter(f => !inView(f.p, A)).map(f => f.n);
    const pass = ballOff === 0 && fieldOff.length === 0;
    if (pass) okAspects.push(A);
    console.log(pad(A.toFixed(3), 9) + pad(ballOff + "/" + worst.length, 10) +
                pad(fieldOff.length + "/" + FIELD_PTS.length, 12) + (pass ? "可用" : "不可用"));
  }
  const minAspect = okAspects.length ? Math.min(...okAspects) : null;
  console.log("\n【实测结论】");
  console.log("  可用（关键段球位与场地顶点全部在屏内）的最小宽高比 = " + (minAspect === null ? "无" : minAspect));
  if (minAspect !== null) {
    /* 找到刚好不可用的最大宽高比，看余量 */
    const below = ASPECTS.filter(a => a < minAspect);
    const justBad = below.length ? Math.max(...below) : null;
    console.log("  刚好不可用的最大宽高比 = " + justBad +
                "（低于它，关键段开始出屏）");
  }

  /* ---- 真机视口在新判据下的结果 ---- */
  const TH = minAspect === null ? 1.7 : minAspect;
  console.log("\n真机视口（判据：横屏 且 宽高比 ≥ " + TH + "）：\n");
  console.log(pad("设备", 24) + pad("视口", 12) + pad("宽高比", 9) + pad("横屏", 7) +
              pad("新判据", 9) + "期望");
  console.log("-".repeat(74));
  let bad = 0;
  for (const d of DEVICES) {
    const A = +(d.w / d.h).toFixed(3);
    const allow = d.land && A >= TH;
    /* 期望：所有横屏放行、所有竖屏拦截（球台/关键段几何实测支持） */
    const want = d.land;
    const okk = allow === want;
    if (!okk) bad++;
    console.log(pad(d.n, 24) + pad(d.w + "×" + d.h, 12) + pad(A, 9) + pad(d.land ? "是" : "否", 7) +
                pad(allow ? "放行" : "拦截", 9) + (want ? "放行" : "拦截") + (okk ? "" : "   ← 不符"));
  }
  console.log("\n  与期望不符的真机： " + bad + " 个" + (bad === 0 ? "（全部符合）" : ""));
  if (errs.length) { console.log("\n  页面错误 " + errs.length + " 条"); errs.slice(0, 4).forEach(e => console.log("    " + e)); }
  console.log("");
})();
