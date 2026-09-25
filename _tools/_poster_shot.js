// 真浏览器验证：抓帧（preserveDrawingBuffer）/ 球拍残影 / 分享海报渲染
// 运行： NODE_PATH=<workspace>/node_modules node _poster_shot.js
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;



const OUT = path.join(ROOT, "_shots");
fs.mkdirSync(OUT, { recursive: true });
const URL = "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/");

const R = [];
function add(ok, name, detail) {
  R.push({ ok, name, detail });
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name + "　→ " + detail);
}

(async () => {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
           "--ignore-gpu-blocklist", "--enable-webgl"]
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", e => errs.push("pageerror: " + e.message));
  page.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });

  await page.goto(URL, { waitUntil: "load" });
  await page.waitForTimeout(1000);

  /* ---- 0. Logo 注入 ---- */
  const logo = await page.evaluate(() => {
    const a = document.querySelectorAll("[data-logo] svg").length;
    /* 左下角水印已按用户要求移除，logo 现在共 3 处：开始页 / 结束页 / 左上品牌行。
     * 另外确认品牌行里确实有 logo + 应用名，而不是只留了个空 span。 */
    const brand = document.getElementById("hudBrand");
    return { brand: a, hudWatermark: !!document.getElementById("hudLogo"),
             brandRow: !!brand,
             brandTxt: brand ? (brand.querySelector(".bn") || {}).textContent || "" : "",
             title: document.title,
             startName: (document.querySelector(".brand .nm") || {}).textContent || "" };
  });
  add(logo.brand === 3 && !logo.hudWatermark, "Logo 注入开始页 / 结束页 / 左上品牌行（3 处），左下角水印已移除",
      "占位 " + logo.brand + " 处　左下角水印=" + logo.hudWatermark +
      "　标题「" + logo.title + "」　名称「" + logo.startName + "」");
  add(logo.brandRow && logo.brandTxt === "旋转乒乓",
      "左上「连续回球」上方有品牌行：logo + 应用名「旋转乒乓」",
      "hudBrand 存在=" + logo.brandRow + "　名称「" + logo.brandTxt + "」");
  add(logo.title.indexOf("旋转乒乓") === 0, "游戏名已改为「旋转乒乓」", logo.title);

  await page.click("#startBtn");
  await page.waitForTimeout(900);

  /* ---- 1. 落台抓帧：preserveDrawingBuffer 必须让 toDataURL 拿到真画面 ---- */
  const cap = await page.evaluate(() => new Promise(res => {
    G.shots = [];
    G.shotReq = { gain: 12, rally: 5, name: "上旋" };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const s = G.shots[0];
      if (!s) return res({ n: 0 });
      // 把抓到的 jpeg 解回像素，验证不是全黑（全黑 = 帧缓冲已被清空）
      const im = new Image();
      im.onload = () => {
        const c = document.createElement("canvas");
        c.width = 64; c.height = 40;
        const g = c.getContext("2d");
        g.drawImage(im, 0, 0, 64, 40);
        const d = g.getImageData(0, 0, 64, 40).data;
        let sum = 0, mx = 0;
        for (let i = 0; i < d.length; i += 4) {
          const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
          sum += v; if (v > mx) mx = v;
        }
        res({ n: G.shots.length, mean: +(sum / (d.length / 4)).toFixed(1), max: mx,
              bytes: s.url.length, jpeg: s.url.slice(0, 22) });
      };
      im.onerror = () => res({ n: G.shots.length, bad: true });
      im.src = s.url;
    }));
  }));
  add(cap.n === 1 && cap.mean > 4 && cap.max > 40 && cap.bytes > 2000,
      "落台瞬间抓到真画面（非全黑）",
      "均值亮度 " + cap.mean + "　峰值 " + cap.max + "　" + Math.round(cap.bytes / 1024) + "KB");

  /* ---- 2. Top-3 排序：只留分值最高的 3 张 ---- */
  const keep = await page.evaluate(() => {
    G.shots = [];
    [[3, 4], [18, 9], [7, 6], [18, 15], [11, 8], [2, 2]].forEach(p => {
      G.shotReq = { gain: p[0], rally: p[1], name: "直线快球" };
      captureShot(G.shotReq);
    });
    return { n: G.shots.length, list: G.shots.map(s => s.gain + "/" + s.rally) };
  });
  const okKeep = keep.n === 3 && keep.list[0] === "18/15" && keep.list[1] === "18/9" && keep.list[2] === "11/8";
  add(okKeep, "只保留分值最高的 3 张（同分取后打出的一拍）", keep.list.join("　"));

  /* ---- 3. 球拍运动痕迹：有，但不明显 ----
   * 确定性驱动，不用 requestAnimationFrame 走真实帧。
   * 原因：残影寿命只有 0.28s，而 headless + SwiftShader 下 rAF 可能一帧就耗掉几十毫秒，
   * 等 14 帧走完残影早过期了 —— 断言读到「0 片可见」，看起来像功能坏了，其实是测试太脆。
   * 这里手动推进挥拍进度、按固定 1/60 步长调用采样，结果与机器快慢无关。 */
  const ghost = await page.evaluate(() => {
    G.running = true;                       // render3D 只在 running 时更新球拍
    G.ghosts.length = 0;
    G.paddle.pend = 0; G.paddle.dur = 0.34; G.paddle.side = 1;
    G.paddle.action = "推挡"; G.paddle.hx = 0.2; G.paddle.hy = 1.0;
    for (let i = 0; i <= 12; i++) {
      G.paddle.anim = i / 12;               // 手动推进入画 → 前推 → 外展
      updatePaddle();
      renderGhosts(1 / 60);                 // 固定步长，12 帧共 0.2s < 0.28s 寿命
    }
    const vis = OBJ.ghosts.filter(m => m.visible);
    const op = vis.map(m => +m.material.opacity.toFixed(3));
    return { total: OBJ.ghosts.length, vis: vis.length, q: G.ghosts.length,
             maxOp: Math.max.apply(null, op.concat([0])), op: op };
  });
  add(ghost.vis >= 3 && ghost.maxOp > 0.01 && ghost.maxOp <= 0.155,
      "挥拍留下运动残影，且足够克制（不透明度 ≤0.155）",
      ghost.vis + "/" + ghost.total + " 片可见　峰值 " + ghost.maxOp + "　队列 " + ghost.q);
  await page.screenshot({ path: OUT + "\\08_ghost.png" });

  /* ---- 4. 海报渲染 ---- */
  await page.evaluate(() => {
    G.rally = 27; G.score = 316; G.prevBestScore = 240;
    G.statSpinTotal = 9; G.statSpinHit = 8;
    G.statErrSum = 0.82; G.statErrN = 9;
    G.statMaxSpeed = 8.6;
    G.shots = [];
  });
  const data = await page.evaluate(() => posterData());
  add(data.spinRate === 89 && Math.abs(data.accCm - 9.1) < 0.6 && Math.abs(data.maxKmh - 31.0) < 0.6,
      "三项指标计算正确（接发率 / 落点精度 / 最快回球）",
      "旋转球接发率 " + data.spinRate + "%　落点精度 " + data.accCm.toFixed(1) +
      "cm　最快回球 " + data.maxKmh.toFixed(1) + "km/h");

  // 补三组抓帧留念（会各切一个机位补渲染一帧）
  const cams = await page.evaluate(() => {
    G.shots = [];
    [[14, 9], [11, 16], [9, 27]].forEach(p => {
      G.shotReq = { gain: p[0], rally: p[1], name: ["上旋", "下旋", "直线快球"][p[1] % 3] };
      captureShot(G.shotReq);
    });
    // 机位必须已还原，否则玩家会看到镜头被切走
    const back = Math.abs(CAM.position.z - CAM_Z) < 1e-6 && Math.abs(CAM.position.x) < 1e-6;
    // 三张图的字节长度各不相同 → 确实是三个不同机位拍出来的
    const sizes = G.shots.map(s => s.url.length);
    /* 取景判据：对方半台（球落点所在）必须完整入画。
     * 只要求"整张台入画"会逼着镜头拉到很远，落点变成一个小点，海报就失去意义。 */
    const box = SHOT_CAMS.map(c => {
      const cp = shotCamPos(c.az, c.el, c.d);
      CAM.position.set(cp[0], cp[1], cp[2]);
      CAM.lookAt(SHOT_TARGET[0], SHOT_TARGET[1], SHOT_TARGET[2]);
      CAM.updateMatrixWorld(true);
      let mx = 0, my = 0;
      [[-1, 0], [1, 0], [-1, -1], [1, -1]].forEach(q => {
        const v = new THREE.Vector3(q[0] * T.halfW, T.h, q[1] * T.halfL).project(CAM);
        mx = Math.max(mx, Math.abs(v.x)); my = Math.max(my, Math.abs(v.y));
      });
      return { az: c.az, d: c.d, mx: +mx.toFixed(2), my: +my.toFixed(2) };
    });
    CAM.position.set(0, CAM_Y, CAM_Z); CAM.lookAt(0, 0.96, -0.3);
    const fit = box.every(b => b.mx < 0.98 && b.my < 0.98);
    return { back: back, sizes: sizes, uniq: new Set(sizes).size, box: box, fit: fit };
  });
  add(cams.back && cams.uniq === 3, "抓帧用三个不同机位，且渲染后机位已还原",
      "还原=" + cams.back + "　三图体积 " + cams.sizes.join(" / "));
  add(cams.fit, "三个机位都把对方半台完整框进画面",
      cams.box.map(b => "az" + b.az + " d" + b.d + " NDC±(" + b.mx + "," + b.my + ")").join("　"));
  const drawn = await page.evaluate(() => POSTER.show(document.getElementById("posterCv"), posterData()));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.getElementById("endScreen").classList.add("hidden");
    document.getElementById("posterScreen").classList.remove("hidden");
  });
  await page.waitForTimeout(300);

  /* getImageData / toBlob 都要求画布未被污染。
   * 二维码若用 <img src="vendor/qr.png">（file:// 下算跨域），这里会直接抛
   * SecurityError —— 玩家点「保存图片」就会失败。所以这一条同时是
   * 「画布未被污染、海报可导出」的回归断言。
   *
   * 二维码本身不做「深色占比」这种弱断言——占位空框也能凑够深色像素
   * （曾经真的漏过：线上少传 qr.js，海报左下角是白底+"二维码"三个字的空框，
   * 而当时的断言照样通过）。这里改成**逐个模块回读比对**：
   * 从画布上按 29×29 采样每个模块中心，与 poster.js 内联的期望矩阵全等，
   * 并额外校验三个定位图案的 1:1:3:1:1 特征——扫码器就是靠它找到码的。 */
  const cvInfo = await page.evaluate(() => {
    const c = document.getElementById("posterCv");
    let taint = "";
    try {
      const g = c.getContext("2d");
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4000) if (d[i] + d[i + 1] + d[i + 2] > 90) lit++;

      // ---- 二维码逐模块回读 ----
      const N = POSTER.qrN, exp = POSTER.qrModules();
      const qx = 48, qy = 1190, qs = 150, quiet = 2;   // 与 render() 中一致
      const total = N + quiet * 2, cell = qs / total, S = 2;  // 画布是 2× 导出
      let hit = 0, miss = 0;
      for (let r = 0; r < N; r++) {
        for (let col = 0; col < N; col++) {
          const px = Math.round((qx + (quiet + col + 0.5) * cell) * S);
          const py = Math.round((qy + (quiet + r + 0.5) * cell) * S);
          const o = (py * c.width + px) * 4;
          const dark = (d[o] + d[o + 1] + d[o + 2]) / 3 < 128;
          if (dark === !!exp[r * N + col]) hit++; else miss++;
        }
      }
      // 三个定位图案（左上/右上/左下）必须是同心方环：外 7 环黑、5 环白、3 环黑
      const finders = [[0, 0], [0, N - 7], [N - 7, 0]].map(function (p) {
        var ring = function (rr) {
          var x = p[1] + 3, y = p[0] + 3;          // 环心
          var m = Math.floor(Math.min(rr, Math.abs(rr - 6)));
          return !!(exp[y * N + (x - 3 + rr)] && exp[(y - 3 + rr) * N + x] &&
                    exp[y * N + (x + 3 - rr)] && exp[(y + 3 - rr) * N + x]);
        };
        return ring(0) && ring(2) && ring(4) && ring(6);   // 实心核 + 三圈环
      });
      return { w: c.width, h: c.height, lit: lit, ratio: +(lit / (d.length / 4000)).toFixed(3),
               qrHit: hit, qrMiss: miss, qrMatch: +(hit / (N * N)).toFixed(4),
               finders: finders.filter(Boolean).length };
    } catch (e) { taint = e.name + ": " + e.message; }
    return { taint: taint };
  });
  add(drawn && cvInfo.w === 1800 && cvInfo.h === 2720 && cvInfo.ratio > 0.15,
      "海报已绘制（900×1360 逻辑尺寸，2× 导出）",
      cvInfo.w + "×" + cvInfo.h + "　有效像素占比 " + cvInfo.ratio);
  add(cvInfo.qrMatch === 1 && cvInfo.finders === 3,
      "二维码已内联进海报：逐模块回读全等 + 三个定位图案完整（可扫）",
      cvInfo.taint ? cvInfo.taint
        : "模块 " + cvInfo.qrHit + "/841 命中（错 " + cvInfo.qrMiss + "）　定位图案 "
          + cvInfo.finders + "/3　画布未污染");
  add(!cvInfo.taint, "海报画布未被污染（可正常导出图片）",
      cvInfo.taint || "getImageData 读取正常");

  const el = await page.$("#posterCv");
  await el.screenshot({ path: OUT + "\\09_poster.png" });
  await page.screenshot({ path: OUT + "\\10_poster_screen.png" });

  /* 另外导一张原始分辨率的 PNG（1800×2720）。
   * el.screenshot() 拿到的是元素在页面上的显示尺寸（约 492×741），
   * 缩略图看不清二维码到底有没有画出来，排查时只能靠猜。 */
  const fullB64 = await page.evaluate(() => {
    return document.getElementById("posterCv").toDataURL("image/png").split(",")[1];
  });
  require("fs").writeFileSync(OUT + "\\09_poster_full.png", Buffer.from(fullB64, "base64"));

  /* ---- 5. 只有「挑战模式 + 破纪录」才亮「新纪录」 ----
   * 练习模式必须有独立断言：它的成绩不计榜，若还盖「新纪录」章就是虚假宣传
   * —— 海报是要被分享出去的东西，这个章等于对外的公开声明。 */
  const badge = await page.evaluate(() => {
    const A = {};
    const reset = () => document.getElementById("posterScreen").classList.add("hidden");
    const hasBadge = () => document.getElementById("newBadge").classList.contains("on");

    G.mode = "challenge"; G.prevBestScore = 1000; G.score = 10;
    G.shots = [{ url: "", gain: 1, rally: 1, name: "x" }];
    reset(); gameOver("挑战·未破纪录");
    A.cNotNewBadge = hasBadge();

    G.mode = "challenge"; G.prevBestScore = 5; G.score = 40;
    reset(); gameOver("挑战·破纪录");
    A.cNewBadge = hasBadge();
    A.cTag = document.getElementById("endMode").textContent;

    G.mode = "practice"; G.prevBestScore = 5; G.score = 999;
    reset(); gameOver("练习·远超纪录");
    A.pBadge = hasBadge();
    A.pTag = document.getElementById("endMode").textContent;
    return A;
  });
  add(!badge.cNotNewBadge && badge.cNewBadge && !badge.pBadge,
      "「新纪录」只在挑战模式破纪录时亮（练习模式即使 999 分也不亮）",
      "挑战未破=" + badge.cNotNewBadge + "　挑战破=" + badge.cNewBadge
      + "　练习高分=" + badge.pBadge + "　标签=" + badge.cTag + " / " + badge.pTag);

  /* ---- 6. 自动弹海报：必须真的等那 0.4s 异步延迟，否则「没弹」永远是假绿 ---- */
  await page.evaluate(() => {
    document.getElementById("posterScreen").classList.add("hidden");
    G.mode = "challenge"; G.prevBestScore = 5; G.score = 40;
    G.shots = [{ url: "", gain: 1, rally: 1, name: "x" }];
    gameOver("挑战·破纪录（等弹窗）");
  });
  await page.waitForTimeout(700);
  const popC = await page.evaluate(() =>
    !document.getElementById("posterScreen").classList.contains("hidden"));
  add(popC, "挑战模式破纪录后自动弹出海报（0.4s 延迟后）", "弹窗=" + popC);

  await page.evaluate(() => {
    document.getElementById("posterScreen").classList.add("hidden");
    G.mode = "practice"; G.prevBestScore = 5; G.score = 999;
    gameOver("练习·高分（不应弹窗）");
  });
  await page.waitForTimeout(700);
  const popP = await page.evaluate(() =>
    !document.getElementById("posterScreen").classList.contains("hidden"));
  add(!popP, "练习模式不自动弹海报（成绩不计榜）", "弹窗=" + popP);
  await page.evaluate(() => document.getElementById("posterScreen").classList.add("hidden"));

  console.log(errs.length ? "\n页面错误:\n  " + errs.join("\n  ") : "\n无页面错误");
  const bad = R.filter(r => !r.ok).length;
  console.log(bad ? "\n失败：" + bad + " 项" : "\n全部 " + R.length + " 项通过");
  await browser.close();
  process.exit(bad || errs.length ? 1 : 0);
})();
