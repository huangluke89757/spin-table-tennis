"use strict";
/* 分享海报：方案A —— 技术统计板
 * 全 Canvas 手绘（不依赖 DOM 截图库、不依赖网络），绘制完成即可 toBlob 下载。
 * 视觉要素与游戏一致：#0a0e15 底 / #ffb454 强调 / #7ee0a8 成功 / #ff7b72 失败。
 * 「球拍运动痕迹」在这里被夸张化：多道变宽笔迹 + 沿轨迹排布的半透明拍影。 */
var POSTER = (function () {
  var W = 900, H = 1360, S = 2;          // 逻辑尺寸 / 导出倍率（1800×2720）
  var TAU = Math.PI * 2;
  var LASTERR = "";                       // 绘制异常留存，便于排查

  /* ===== 二维码（内联矩阵，同步绘制） =====
   * 这里刻意不加载任何图片文件。原先用 <img src="vendor/qr.png"> 有两重坑：
   *   1) file:// 下算跨域，画进 canvas 会污染画布，点「保存图片」抛 SecurityError；
   *   2) 图片是异步加载的，只要文件缺失或慢于海报弹出，就静默降级成占位空框
   *      ——线上少传一个 vendor/qr.js 就出现过整块白框。
   * 现在把二维码矩阵直接内联进来（29×29 位 → base64 144 字符），
   * 只要海报画得出来，二维码就一定在。改网址重跑 _qr.py 会重写下面这段。 */
  var QR_N = 29;
  var QR_B64 = "/mpj/BcBEG6mJrt1a7XbpMEuwS9VB/qqr+AZRwCC1sZyhkiFn/dIgUtleoR6mrDyFf/MPq03jrZGRT7dUGdKLN3yvEdzQlUJC6yc+4BfvGP5PWuQTqMSui2f1dBM626Rff0ED0rf78VuAA==";
  var QR_MODS = null;

  function qrModules() {
    if (QR_MODS) return QR_MODS;
    var raw = "";
    try { raw = atob(QR_B64); } catch (e) { raw = ""; }
    var n = QR_N * QR_N, bits = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var byte = raw.charCodeAt(i >> 3) || 0;
      bits[i] = (byte >> (7 - (i & 7))) & 1;
    }
    QR_MODS = bits;
    return bits;
  }

  /* 在 (x,y) 处画 size×size 的二维码。quiet 为静默区宽度（模块数），
   * 二维码标准要求至少 4 模块的静默区，否则扫码器找不到定位图案。 */
  function drawQR(ctx, x, y, size, quiet) {
    var m = qrModules();
    var q = quiet === undefined ? 2 : quiet;
    var total = QR_N + q * 2;
    var cell = size / total;
    ctx.save();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = "#000000";
    for (var r = 0; r < QR_N; r++) {
      for (var c = 0; c < QR_N; c++) {
        if (!m[r * QR_N + c]) continue;
        // 用 ceil 而非精确值：避免相邻模块间出现亚像素缝隙（缩放后像虚线）
        var px = x + (q + c) * cell, py = y + (q + r) * cell;
        ctx.fillRect(px, py, Math.ceil(cell), Math.ceil(cell));
      }
    }
    ctx.restore();
  }

  var COL = {
    bg: "#0a0e15", panel: "rgba(255,255,255,0.045)",
    line: "rgba(255,255,255,0.10)", fg: "#e6edf3", fg2: "#c9d1d9",
    muted: "#8b949e", dim: "#6e7681",
    accent: "#ffb454", accentHi: "#ffc36e", ok: "#7ee0a8", bad: "#ff7b72",
    cool: "#4cb8ff"
  };

  function f(size, w) { return (w || 500) + " " + size + "px system-ui, -apple-system, \"Microsoft YaHei\", \"PingFang SC\", sans-serif"; }

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /* 变宽笔迹：沿二次贝塞尔生成上下边界的多边形，一次性 fill + 渐变，
   * 避免逐段 stroke 的圆头叠加出现"串珠"。 */
  function ribbon(ctx, x0, y0, cx, cy, x1, y1, w0, w1, c0, c1) {
    var N = 56, up = [], dn = [], i, t, mt, x, y, dx, dy, L, nx, ny, w;
    for (i = 0; i <= N; i++) {
      t = i / N; mt = 1 - t;
      x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
      y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
      dx = 2 * mt * (cx - x0) + 2 * t * (x1 - cx);
      dy = 2 * mt * (cy - y0) + 2 * t * (y1 - cy);
      L = Math.hypot(dx, dy) || 1;
      nx = -dy / L; ny = dx / L;
      w = (w0 + (w1 - w0) * t) / 2;
      up.push([x + nx * w, y + ny * w]);
      dn.push([x - nx * w, y - ny * w]);
    }
    ctx.beginPath();
    ctx.moveTo(up[0][0], up[0][1]);
    for (i = 1; i <= N; i++) ctx.lineTo(up[i][0], up[i][1]);
    for (i = N; i >= 0; i--) ctx.lineTo(dn[i][0], dn[i][1]);
    ctx.closePath();
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    ctx.fillStyle = g; ctx.fill();
  }

  function bez(x0, y0, cx, cy, x1, y1, t) {
    var mt = 1 - t;
    return {
      x: mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
      y: mt * mt * y0 + 2 * mt * t * cy + t * t * y1,
      a: Math.atan2(2 * mt * (cy - y0) + 2 * t * (y1 - cy), 2 * mt * (cx - x0) + 2 * t * (x1 - cx))
    };
  }

  /* 夸张版运动痕迹：沿轨迹排布的半透明拍影，越靠后越淡越小 */
  function ghostRackets(ctx, x0, y0, cx, cy, x1, y1, n, color) {
    for (var k = 0; k < n; k++) {
      var t = 0.10 + (k / (n - 1)) * 0.78;
      var p = bez(x0, y0, cx, cy, x1, y1, t);
      var sc = 1 - 0.42 * t;
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.a);
      ctx.globalAlpha = 0.11 * (1 - t) + 0.015;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(0, 0, 74 * sc, 52 * sc, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /* ===== Logo：旋转的球（中心白球 + 上下两道旋转弧 + 箭头） ===== */
  function drawLogo(ctx, cx, cy, R, o) {
    o = o || {};
    var c1 = o.c1 || COL.accent, ball = o.ball || "#ffffff", seam = o.seam || "#b9c0ca";
    var lw = R * 0.155;
    ctx.save();
    ctx.lineCap = "round";
    // 上弧（主）
    ctx.strokeStyle = c1; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI * 1.06, Math.PI * 1.94); ctx.stroke();
    // 下弧（副，略淡）
    ctx.strokeStyle = o.c2 || "rgba(255,180,84,0.45)";
    ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI * 0.06, Math.PI * 0.94); ctx.stroke();
    // 箭头：上弧末端顺时针、下弧末端逆时针
    arrow(ctx, cx + Math.cos(Math.PI * 1.94) * R, cy + Math.sin(Math.PI * 1.94) * R, -0.55, R * 0.30, c1);
    arrow(ctx, cx + Math.cos(Math.PI * 0.94) * R, cy + Math.sin(Math.PI * 0.94) * R, Math.PI + 0.55, R * 0.26, o.c2 || "rgba(255,180,84,0.6)");
    // 球
    ctx.fillStyle = ball;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.47, 0, TAU); ctx.fill();
    // 接缝
    ctx.strokeStyle = seam; ctx.lineWidth = R * 0.055;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.30, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke();
    ctx.restore();
  }
  function arrow(ctx, x, y, ang, s, color) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(s, 0); ctx.lineTo(-s * 0.55, -s * 0.72); ctx.lineTo(-s * 0.55, s * 0.72);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  /* 供 HTML 复用的内联 SVG（与 Canvas 版同一形状） */
  function logoSvg(size) {
    size = size || 64;
    var R = 32, cx = 32, cy = 32;
    function pt(a) { return (cx + Math.cos(a) * R).toFixed(2) + " " + (cy + Math.sin(a) * R).toFixed(2); }
    var a1s = Math.PI * 1.06, a1e = Math.PI * 1.94;
    var a2s = Math.PI * 0.06, a2e = Math.PI * 0.94;
    var d1 = "M" + pt(a1s) + " A" + R + " " + R + " 0 0 1 " + pt(a1e);
    var d2 = "M" + pt(a2s) + " A" + R + " " + R + " 0 0 1 " + pt(a2e);
    var seam = "M" + (cx + Math.cos(Math.PI * 0.15) * R * 0.30).toFixed(2) + " " +
               (cy + Math.sin(Math.PI * 0.15) * R * 0.30).toFixed(2) +
               " A" + (R * 0.30).toFixed(2) + " " + (R * 0.30).toFixed(2) + " 0 0 1 " +
               (cx + Math.cos(Math.PI * 0.85) * R * 0.30).toFixed(2) + " " +
               (cy + Math.sin(Math.PI * 0.85) * R * 0.30).toFixed(2);
    var tri = function (a, s, fill) {
      var x = cx + Math.cos(a * Math.PI) * R, y = cy + Math.sin(a * Math.PI) * R;
      var ang = (a === 1.94) ? -0.55 : Math.PI + 0.55;
      var cos = Math.cos(ang), sin = Math.sin(ang);
      var p = [[s, 0], [-s * 0.55, -s * 0.72], [-s * 0.55, s * 0.72]].map(function (q) {
        return (x + q[0] * cos - q[1] * sin).toFixed(2) + "," + (y + q[0] * sin + q[1] * cos).toFixed(2);
      });
      return '<polygon points="' + p.join(" ") + '" fill="' + fill + '"/>';
    };
    return '<svg class="logo-svg" width="' + size + '" height="' + size + '" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="' + d1 + '" fill="none" stroke="#ffb454" stroke-width="' + (R * 0.155 * 2) + '" stroke-linecap="round"/>' +
      '<path d="' + d2 + '" fill="none" stroke="rgba(255,180,84,0.45)" stroke-width="' + (R * 0.155 * 2) + '" stroke-linecap="round"/>' +
      tri(1.94, R * 0.30, "#ffb454") + tri(0.94, R * 0.26, "rgba(255,180,84,0.6)") +
      '<circle cx="32" cy="32" r="' + (R * 0.47) + '" fill="#ffffff"/>' +
      '<path d="' + seam + '" fill="none" stroke="#b9c0ca" stroke-width="' + (R * 0.055 * 2) + '" stroke-linecap="round"/>' +
      '</svg>';
  }

  function loadImgs(list) {
    return Promise.all(list.map(function (u) {
      return new Promise(function (res) {
        if (!u) return res(null);
        var i = new Image();
        i.onload = function () { res(i); };
        i.onerror = function () { res(null); };
        i.src = u;
      });
    }));
  }

  /* ==================== 主绘制 ==================== */
  function render(cv, d) {
    var shots = d.shots || [];
    var imgs = d.imgs || [null, null, null];
    cv.width = W * S; cv.height = H * S;
    var ctx = cv.getContext("2d");
    ctx.setTransform(S, 0, 0, S, 0, 0);
    ctx.textBaseline = "alphabetic";

    /* --- 背景 --- */
    ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
    var rg = ctx.createRadialGradient(W * 0.50, 300, 30, W * 0.50, 300, 700);
    rg.addColorStop(0, "rgba(255,180,84,0.11)");
    rg.addColorStop(1, "rgba(255,180,84,0)");
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);

    /* --- 夸张的运动痕迹（背景层） ---
     * 不透明度压在 0.20 以下：再高一点，琥珀色大面积覆盖深蓝底会把整张海报
     * 染成褐橄榄色，底色就"脏"了。痕迹要看得出来，但不能抢走底色。 */
    ribbon(ctx, -80, 1180, 300, 640, 980, 210, 74, 6, "rgba(255,180,84,0.19)", "rgba(255,180,84,0.015)");
    ribbon(ctx, 1010, 980, 520, 720, -60, 470, 58, 5, "rgba(76,184,255,0.15)", "rgba(76,184,255,0.015)");
    ribbon(ctx, -60, 330, 420, 210, 960, 560, 34, 7, "rgba(255,180,84,0.10)", "rgba(255,180,84,0.008)");
    ribbon(ctx, 960, 150, 520, 90, 40, 300, 26, 5, "rgba(126,224,168,0.09)", "rgba(126,224,168,0)");
    ghostRackets(ctx, -80, 1180, 300, 640, 980, 210, 6, "#ffd9a0");
    ghostRackets(ctx, 1010, 980, 520, 720, -60, 470, 5, "#a8d8ff");

    /* --- 顶部品牌区 --- */
    drawLogo(ctx, 92, 92, 46);
    ctx.fillStyle = COL.fg; ctx.font = f(50, 700);
    ctx.fillText("旋转乒乓", 158, 88);
    ctx.fillStyle = COL.muted; ctx.font = f(14, 400);
    ctx.fillText("S P I N   T A B L E   T E N N I S", 160, 116);
    ctx.fillStyle = COL.dim; ctx.font = f(13, 400);
    ctx.fillText("第一视角 · 判断旋转 · 调整拍面 · 一击回球", 160, 138);

    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(48, 176); ctx.lineTo(W - 48, 176); ctx.stroke();

    /* --- 战绩区 --- */
    ctx.fillStyle = COL.muted; ctx.font = f(15, 400);
    ctx.fillText("本局连续回球", 48, 214);
    ctx.fillStyle = COL.accent; ctx.font = f(104, 700);
    var rn = String(d.rally || 0);
    ctx.fillText(rn, 46, 316);
    var rw = ctx.measureText(rn).width;
    ctx.fillStyle = COL.fg2; ctx.font = f(24, 500);
    ctx.fillText("拍", 46 + rw + 12, 316);

    ctx.textAlign = "right";
    ctx.fillStyle = COL.muted; ctx.font = f(15, 400);
    ctx.fillText("本局得分", W - 48, 214);
    ctx.fillStyle = COL.ok; ctx.font = f(64, 700);
    ctx.fillText(String(d.score || 0), W - 48, 300);
    ctx.fillStyle = COL.dim; ctx.font = f(13, 400);
    ctx.fillText("上次最佳 " + (d.prevBest || 0) + " 分", W - 48, 326);
    ctx.textAlign = "left";

    /* 新纪录徽章 */
    if (d.isNew) {
      var bx = 46 + rw + 74, by = 240, bw = 224, bh = 44;
      rr(ctx, bx, by, bw, bh, 22);
      var bg2 = ctx.createLinearGradient(bx, by, bx + bw, by);
      bg2.addColorStop(0, "rgba(255,180,84,0.95)"); bg2.addColorStop(1, "rgba(255,140,60,0.95)");
      ctx.fillStyle = bg2; ctx.fill();
      ctx.fillStyle = "#1a1207"; ctx.font = f(19, 700);
      ctx.fillText("新纪录 NEW RECORD", bx + 20, by + 29);
    }

    /* --- 高光三连拍 --- */
    ctx.fillStyle = COL.fg; ctx.font = f(19, 600);
    ctx.fillText("高光三连拍", 48, 400);
    ctx.fillStyle = COL.muted; ctx.font = f(12.5, 400);
    ctx.fillText("本局分值最高的三次落台瞬间　·　三个机位", 48, 422);

    var sw = 272, sh = 196, gap = 10, sx = 48, sy = 436;
    for (var i = 0; i < 3; i++) {
      var x = sx + i * (sw + gap);
      ctx.save();
      rr(ctx, x, sy, sw, sh, 10); ctx.clip();
      ctx.fillStyle = "#101722"; ctx.fillRect(x, sy, sw, sh);
      var im = imgs[i];
      if (im) {
        /* cover 裁切：三张原图已是三个不同机位（低机位 / 越肩 / 俯拍），
         * 只需保证不变形，不必再放大。
         * 补拍帧由俯拍机位给出，整体比第一视角暗一档，这里提亮补偿。 */
        var sc2 = Math.max(sw / im.width, sh / im.height);
        var dw2 = im.width * sc2, dh2 = im.height * sc2;
        ctx.filter = "brightness(1.16) contrast(1.06) saturate(1.05)";
        ctx.drawImage(im, x + (sw - dw2) / 2, sy + (sh - dh2) / 2, dw2, dh2);
        ctx.filter = "none";
      } else {
        ctx.strokeStyle = "rgba(255,255,255,0.10)"; ctx.setLineDash([6, 6]); ctx.lineWidth = 1;
        rr(ctx, x + 8, sy + 8, sw - 16, sh - 16, 8); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = COL.dim; ctx.font = f(14, 400); ctx.textAlign = "center";
        ctx.fillText("本局尚无落台记录", x + sw / 2, sy + sh / 2 + 5);
        ctx.textAlign = "left";
      }
      var gg = ctx.createLinearGradient(0, sy + sh - 66, 0, sy + sh);
      gg.addColorStop(0, "rgba(10,14,21,0)"); gg.addColorStop(1, "rgba(10,14,21,0.90)");
      ctx.fillStyle = gg; ctx.fillRect(x, sy + sh - 66, sw, 66);
      ctx.restore();
      ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
      rr(ctx, x, sy, sw, sh, 10); ctx.stroke();

      var s = shots[i];
      if (s) {
        /* 落点标记：把「球落在对手台面」这件事在图上点出来。
         * 没有它，三张特写仍然只是三张球台。 */
        var nx = Math.max(0.10, Math.min(0.90, 0.5 + (s.ndc ? s.ndc[0] : 0) * 0.5));
        var ny = Math.max(0.12, Math.min(0.88, 0.5 - (s.ndc ? s.ndc[1] : 0) * 0.5));
        var mx = x + nx * sw, my = sy + ny * sh;
        ctx.strokeStyle = "rgba(255,180,84,0.95)"; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(mx, my, 9, 0, TAU); ctx.stroke();
        ctx.fillStyle = COL.accent;
        ctx.beginPath(); ctx.arc(mx, my, 3.2, 0, TAU); ctx.fill();

        ctx.fillStyle = COL.fg; ctx.font = f(15, 600);
        ctx.fillText("第 " + s.rally + " 拍", x + 12, sy + sh - 24);
        ctx.fillStyle = COL.accent; ctx.font = f(15, 700);
        ctx.fillText("+" + s.gain + " 分", x + 82, sy + sh - 24);
        ctx.fillStyle = COL.dim; ctx.font = f(11.5, 400);
        ctx.fillText(s.name || "", x + 12, sy + sh - 7);
      }
    }

    /* --- 三项指标卡 --- */
    var cy0 = 666, cw = 272, ch = 176;
    var cards = [
      { k: "旋转球接发率", v: d.spinRate === null ? "—" : d.spinRate + "%",
        u: d.spinRate === null ? "本局没遇到旋转球" : "接住 " + d.spinHit + " / 来 " + d.spinTotal + " 个",
        c: COL.accent },
      { k: "落点精度", v: d.accCm === null ? "—" : (Math.round(d.accCm * 10) / 10) + " cm",
        u: "平均偏离理想落点", c: COL.ok },
      { k: "最快回球", v: d.maxKmh === null ? "—" : (Math.round(d.maxKmh * 10) / 10) + " km/h",
        u: "本局最高出手速度", c: COL.cool }
    ];
    for (var j = 0; j < 3; j++) {
      var cxx = 48 + j * (cw + gap), cd = cards[j];
      ctx.fillStyle = COL.panel;
      rr(ctx, cxx, cy0, cw, ch, 14); ctx.fill();
      ctx.strokeStyle = COL.line; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = cd.c; ctx.fillRect(cxx + 18, cy0 + 20, 30, 3);
      ctx.fillStyle = COL.muted; ctx.font = f(13.5, 400);
      ctx.fillText(cd.k, cxx + 18, cy0 + 52);
      ctx.fillStyle = cd.c; ctx.font = f(44, 700);
      ctx.fillText(cd.v, cxx + 18, cy0 + 108);
      ctx.fillStyle = COL.dim; ctx.font = f(11.5, 400);
      ctx.fillText(cd.u, cxx + 18, cy0 + 140);
    }

    /* --- 中部主视觉：夸张轨迹 + 旋转的球 --- */
    var my0 = 900;
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(48, my0 - 32); ctx.lineTo(W - 48, my0 - 32); ctx.stroke();
    drawLogo(ctx, W * 0.5, my0 + 96, 72,
             { c1: "rgba(255,180,84,0.90)", ball: "rgba(255,255,255,0.94)", seam: "#9aa3ad" });
    ctx.textAlign = "center";
    ctx.fillStyle = COL.fg; ctx.font = f(23, 600);
    ctx.fillText(d.isNew ? "这一局，你刷新了自己的纪录" : "再来一局，把纪录往上推", W * 0.5, my0 + 214);
    ctx.fillStyle = COL.dim; ctx.font = f(12.5, 400);
    ctx.fillText("第一视角 · 判断旋转 · 调整拍面 · 一击回球", W * 0.5, my0 + 240);
    ctx.textAlign = "left";

    /* --- 底部二维码区 --- */
    var qy = 1190, qs = 150;
    drawQR(ctx, 48, qy, qs, 2);
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    rr(ctx, 48, qy, qs, qs, 12); ctx.stroke();
    var tx = 48 + qs + 28;
    ctx.fillStyle = COL.fg; ctx.font = f(22, 600);
    ctx.fillText("扫码来战", tx, qy + 40);
    ctx.fillStyle = COL.muted; ctx.font = f(13.5, 400);
    ctx.fillText("用微信 / 手机相机扫码，直接开打", tx, qy + 68);
    ctx.fillStyle = COL.dim; ctx.font = f(12, 400);
    ctx.fillText("成绩以连续回球数计，回球越多球速与旋转越强", tx, qy + 94);
    ctx.fillText("每局约 1/4 是旋转球，其余是慢速好接球", tx, qy + 116);
    ctx.fillStyle = "rgba(110,118,129,0.75)"; ctx.font = f(11, 400);
    ctx.fillText(d.url || "", tx, qy + 140);

    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(48, 1358); ctx.lineTo(W - 48, 1358); ctx.stroke();
    ctx.fillStyle = COL.dim; ctx.font = f(11.5, 400);
    ctx.fillText("旋转乒乓 · 第一视角", 48, 1382);
    ctx.textAlign = "right";
    ctx.fillText(d.dateStr || "", W - 48, 1382);
    ctx.textAlign = "left";
  }

  function show(cv, d) {
    return loadImgs((d.shots || []).map(function (s) { return s.url; })).then(function (imgs) {
      d.imgs = imgs;
      try { render(cv, d); } catch (e) { LASTERR = (e && e.stack) || String(e); return false; }
      cv.style.width = "auto"; cv.style.height = "100%";
      cv.style.maxWidth = "100%"; cv.style.maxHeight = "100%";
      return true;
    });
  }

  function save(cv, name) {
    var a = document.createElement("a");
    if (cv.toBlob) {
      cv.toBlob(function (b) {
        a.href = URL.createObjectURL(b);
        a.download = name;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      }, "image/png");
    } else {
      a.href = cv.toDataURL("image/png"); a.download = name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
    }
  }

  return {
    show: show, save: save, logoSvg: logoSvg, render: render, lastErr: function () { return LASTERR; },
    qrModules: qrModules, qrN: QR_N,
    size: { w: W, h: H, s: S }
  };
})();
