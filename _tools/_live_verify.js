/* 线上端到端验证：直接从线上地址加载页面，走完真实流程，确认二维码画进海报。
 * 为什么要单独跑这一遍：本地 file:// 测试全绿，线上却曾因漏传文件出现白框。
 * 唯一可信的验证是「打开线上地址，看画布上有没有二维码」。
 *
 * 注意 CDN 缓存传播：部署后各边缘节点回源时间不一致，会出现「同一时刻
 * 一个节点是新版、另一个还是旧版」。所以这里重试若干次，并把「重试后成功」
 * 与「始终失败」区分开——前者是缓存还没铺开，后者才是真的坏了。
 * 运行： NODE_PATH=<playwright node_modules> node _live_verify.js */
const { chromium } = require("playwright");


const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;
/* 必须测「用户真实访问的地址」= 分享链接的根路径 `/`。
 * 踩过的坑：CDN 把 `/` 与 `/index.html` 当**两个独立的缓存条目**，
 * 两者回源时间可以差很久。之前测 /index.html 一直报旧版，
 * 而根路径其实早就是新版了 —— 白折腾了一轮排查。 */
const URL = "https://spin-pingpong.app.workbuddy.host/";
const TRIES = 4;

async function once() {
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [], bad = [];
  p.on("pageerror", e => errs.push("PAGEERROR: " + e.message));
  p.on("console", m => { if (m.type() === "error") errs.push("CONSOLE: " + m.text()); });
  p.on("response", r => { if (r.status() >= 400) bad.push(r.status() + " " + r.url()); });

  await p.goto(URL, { waitUntil: "load", timeout: 45000 });
  await p.waitForTimeout(1800);
  await p.evaluate(() => {
    G.shots = [];
    [[14, 9], [11, 16], [9, 27]].forEach(q => {
      G.shotReq = { gain: q[0], rally: q[1], name: "上旋" };
      captureShot(G.shotReq);
    });
  });
  await p.waitForTimeout(400);
  const opened = await p.evaluate(() => { try { openPoster(); return true; } catch (e) { return e.message; } });
  await p.waitForTimeout(1200);

  const res = await p.evaluate(() => {
    const c = document.getElementById("posterCv");
    let taint = "";
    try {
      const g = c.getContext("2d");
      const d = g.getImageData(0, 0, c.width, c.height).data;
      if (!window.POSTER || typeof POSTER.qrModules !== "function") {
        return { stale: "poster.js 还是旧版（无 qrModules）" };
      }
      const N = POSTER.qrN, exp = POSTER.qrModules();
      const qx = 48, qy = 1190, qs = 150, quiet = 2, S = 2;
      const cell = qs / (N + quiet * 2);
      let hit = 0;
      for (let r = 0; r < N; r++) for (let col = 0; col < N; col++) {
        const px = Math.round((qx + (quiet + col + 0.5) * cell) * S);
        const py = Math.round((qy + (quiet + r + 0.5) * cell) * S);
        const o = (py * c.width + px) * 4;
        if (((d[o] + d[o + 1] + d[o + 2]) / 3 < 128) === !!exp[r * N + col]) hit++;
      }
      return { cv: c.width + "x" + c.height, hit: hit, total: N * N, ratio: +(hit / (N * N)).toFixed(4) };
    } catch (e) { taint = e.name + ": " + e.message; }
    return { taint: taint };
  });

  /* 辅助面板：线上版本必须真的带这套 DOM 与逻辑。
   * 只看 index.html 有没有字符串不够——要真的点一下，看类有没有切。
   * 显隐类挂在 #hud 上（ui-collapsed），这样左下拍面栏与右下辅助区一起收放。 */
  const aux = await p.evaluate(() => {
    const hud = document.getElementById("hud");
    const btn = document.getElementById("btnUiToggle");
    if (!hud || !btn) return { missing: true };
    const before = hud.classList.contains("ui-collapsed");
    btn.click();
    const after = hud.classList.contains("ui-collapsed");
    /* 关键：收起时左下拍面栏必须真的不可见（用户核心诉求），不能只切类 */
    const faceHidden = getComputedStyle(document.getElementById("hudFace")).display === "none";
    const cfgKept = getComputedStyle(document.getElementById("hudCfg")).display !== "none";
    btn.click();                                  // 还原
    const faceBack = getComputedStyle(document.getElementById("hudFace")).display !== "none";
    return { before: before, after: after, faceHidden: faceHidden,
             cfgKept: cfgKept, faceBack: faceBack,
             keys: !!document.getElementById("hudKeys"),
             cfg: !!document.getElementById("hudCfg"),
             endBtn: !!document.getElementById("btnUiToggle2") };
  });

  if (res.ratio === 1 && !res.taint && !bad.length && !errs.length) {
    const full = await p.evaluate(() => document.getElementById("posterCv").toDataURL("image/png").split(",")[1]);
    require("fs").writeFileSync(ROOT + "\\_shots\\11_live_poster.png", Buffer.from(full, "base64"));
  }
  const feats = await probeFeatures(p);
  await b.close();
  return { res: res, bad: bad, errs: errs, opened: opened, aux: aux, feats: feats };
}

/* 本轮六项改动的线上特征探针。
 * 为什么要在线上再验一遍：本地 file:// 全绿只证明"源代码对"，
 * 证明不了"部署产物对"。CDN 各节点回源不一致，完全可能出现
 * "新 index.html + 旧 game.js" 的组合 —— 那样本地测试毫无意义。 */
async function probeFeatures(p) {
  return await p.evaluate(() => {
    const out = {};

    /* ① 离屏抓帧：最能说明问题的验证不是"SHOT_REND 存在"，
     * 而是「抓一帧，主渲染器一次都不能被调用」——
     * 这正是"闪一下非第一视角球桌"的根因。给 REND.render 装计数钩子，
     * 同步块内跑 captureShot（主循环 rAF 插不进来），计数必须保持 0。 */
    try {
      let calls = 0;
      const orig = REND.render;
      REND.render = function () { calls++; return orig.apply(this, arguments); };
      const nShots = G.shots.length;
      captureShot({ gain: 14, rally: 9, name: "上旋" });
      G.shots.length = nShots;                       // 还原，别影响后续判断
      REND.render = orig;
      const gl = REND.getContext();
      out.shot = {
        mainRenderCalls: calls,
        ownCanvas: !!SHOT_REND && SHOT_REND.domElement !== REND.domElement,
        ownCam: !!SHOT_CAM && SHOT_CAM !== CAM,
        mainPDB: !!(gl && gl.getContextAttributes() &&
                    gl.getContextAttributes().preserveDrawingBuffer),
      };
    } catch (e) { out.shot = { err: e.message }; }

    /* ② 球网 ITTF 三层结构：按几何参数在场景里认领，不靠对象名 */
    const nw = 1.83, near = (a, b, t) => Math.abs(a - b) < t;
    const net = { mesh: 0, tape: 0, shade: 0, posts: 0, shadows: 0 };
    SCENE.traverse(o => {
      const g = o.geometry, mt = o.material;
      if (!g || !g.parameters || !mt) return;
      const q = g.parameters;
      if (q.width == null || !near(q.width, nw, 0.06)) return;
      if (mt.map && near(q.height, 0.1525, 0.012)) net.mesh++;            // 网纱
      else if (near(q.height, 0.017, 0.004) && mt.color && mt.color.getHex() > 0xd00000)
        net.tape++;                                                        // 白网带
      else if (near(q.height, 0.008, 0.003) && mt.color && mt.color.getHex() < 0x203830)
        net.shade++;                                                       // 带下暗缝
      else if (o.rotation.x < -1.5 && mt.transparent && mt.opacity < 0.6)
        net.shadows++;                                                     // 网根接地影
    });
    SCENE.traverse(o => {                                                  // 网柱
      const q = o.geometry && o.geometry.parameters;
      if (q && near(q.width || 0, 0.024, 0.004) && near(q.height || 0, 0.227, 0.02)) net.posts++;
    });
    out.net = net;

    /* ③ 球拍真实尺寸（换算成 mm 报出来，跟实物比） */
    out.racket = (typeof RKT === "object") ? {
      bladeDia: Math.round(RKT.bladeR * 2 * 1000),
      handleL: Math.round(RKT.handleL * 1000),
      oval: RKT.oval,
      foreL: Math.round(RKT.foreL * 1000),
    } : null;

    /* ④ 品牌行：左上存在、左下不存在、logo 真被注入 */
    const bn = document.querySelector("#hudBrand .bn");
    out.brand = {
      hasBrand: !!document.getElementById("hudBrand"),
      noOldLogo: !document.getElementById("hudLogo"),
      injected: !!document.querySelector("#hudBrand svg, #hudBrand canvas, #hudBrand img"),
      name: bn ? bn.textContent : "",
    };

    /* ⑤ 结算中动画：DOM + 乒乓球元素 + 函数就位 + **样式真的到位**
     * 最后一条很关键：版本戳只覆盖三个 JS 文件，CSS 改动不会让脚本 URL 变化。
     * 于是完全可能出现「CDN 返回旧 index.html」而脚本全是新的 ——
     * 这时改在 HTML 里的样式（如底衬）就是旧的。所以必须真读计算样式，不能只查 DOM。 */
    const st = document.getElementById("settle");
    if (st) st.classList.add("on");              // 默认 display:none，先点亮再读计算样式
    const bg = st ? getComputedStyle(st).backgroundColor : "";
    out.settle = {
      el: !!st,
      fn: typeof showSettle === "function",
      ball: !!(st && st.querySelector(".ball")),
      shadow: !!(st && st.querySelector(".shadow")),
      backdrop: /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0?\.\d+/.test(bg),  // 半透明底衬
      radius: st ? getComputedStyle(st).borderRadius : "",
      /* 结算窗口时长（本轮由 2.5s 减半到 1.25s）。这条是「CSS 改动有没有上到线」
       * 最直接的判据 —— 版本戳只覆盖 JS，HTML 里的秒数变了不会换 URL，
       * 所以必须实地读出来，不能靠「我改过所以一定是新的」。
       * 优先读 showSettle() 注入的 CSS 变量（运行时真值），
       * 读不到再退到 #settle 上的声明值。 */
      wait: (st && st.style.getPropertyValue("--settle-wait").trim()) ||
            (st ? getComputedStyle(st).getPropertyValue("--settle-wait").trim() : ""),
      /* 进度条必须读变量而不是写死秒数：写死的话改了 SETTLE_WAIT 进度条还走老时长 */
      barUsesVar: (() => {
        if (!st) return false;
        const bar = st.querySelector(".bar i");
        if (!bar) return false;
        /* 计算样式里 animationDuration 会解析成实际秒数（如 "1.25s"），
         * 拿它跟 wait 比对，能同时验「读了变量」且「解析结果正确」。 */
        return getComputedStyle(bar).animationDuration;
      })(),
    };
    /* ⑥ 本轮新增：右上角外链 / 双模式 / 失败归因 / 纪录系统
     * 同样必须读**线上实际产物**：版本戳只覆盖三个 JS 文件，index.html 的改动
     * 不会换 URL，CDN 完全可能继续发旧 HTML —— 那样新功能在线上根本不存在。 */
    const tl = document.getElementById("topLinks");
    const gh = document.getElementById("ghLink");
    const tt = gh ? gh.querySelector(".tt") : null;
    out.links = {
      wrap: !!tl,
      ghHref: gh ? gh.href : "",
      tip: tt ? tt.textContent : "",
      /* 入口必须在 #hud **之外**：#hud 有 z-index:5，会形成层叠上下文，
       * 子元素无论多高的 z-index 都跳不出去，会被开始页浮层（z-index:20）盖住，
       * 而第一次打开游戏的人恰恰停在开始页。 */
      outsideHud: !!tl && !!document.getElementById("hud") &&
                  !document.getElementById("hud").contains(tl),
      zIndex: tl ? parseInt(getComputedStyle(tl).zIndex, 10) || 0 : 0,
    };
    out.modes = {
      cards: document.querySelectorAll(".modeCard").length,
      hasPractice: !!document.getElementById("modePractice"),
      hasChallenge: !!document.getElementById("modeChallenge"),
      /* 点一下挑战卡片，G.mode 与 G.assist 都要跟着变（点完复原，不干扰后续） */
      afterClick: (() => {
        const c = document.getElementById("modeChallenge");
        const p = document.getElementById("modePractice");
        if (!c || !p) return null;
        c.click();
        const r = { mode: G.mode, assist: G.assist };
        p.click();                                 // 复原为练习模式
        return r;
      })(),
    };
    out.diag = {
      endMode: !!document.getElementById("endMode"),
      endGap: !!document.getElementById("endGap"),
      failWrap: !!document.getElementById("failWrap"),
      failList: !!document.getElementById("failList"),
      boardWrap: !!document.getElementById("boardWrap"),
      boardList: !!document.getElementById("boardList"),
      classify: typeof classifyFail === "function"
        ? classifyFail("出界", "吃旋转！上旋球要压拍") : null,
      /* 纪录系统串起来跑一次真流程：写一局 → 读回来校验 → 清干净 */
      roundTrip: (() => {
        if (typeof clearRecords !== "function" || typeof commitResult !== "function") return null;
        clearRecords();
        commitResult({ rally: 11, score: 77, level: 2, mode: "challenge", good: 5, ts: 1 });
        const r = loadRecords();
        const ok = r.history.length === 1 && r.best.challenge === 11 && r.score.challenge === 77;
        clearRecords();
        return ok;
      })(),
    };
    return out;
  });
}

/* 判据：每条都要求线上产物真的带本轮改动 */
function judgeFeatures(f) {
  const s = f.shot, n = f.net, r = f.racket, b = f.brand, st = f.settle;
  const lk = f.links || {}, md = f.modes || {}, dg = f.diag || {};
  const items = [
    ["离屏抓帧：抓帧期间主渲染器调用次数为 0", !!s && s.mainRenderCalls === 0,
     s && !s.err ? "mainRender calls=" + s.mainRenderCalls : (s && s.err) || "探针失败"],
    ["离屏抓帧：独立 canvas 与专用相机", !!s && s.ownCanvas && s.ownCam,
     s && !s.err ? "ownCanvas=" + s.ownCanvas + " ownCam=" + s.ownCam : "-"],
    ["主渲染器未开 preserveDrawingBuffer", !!s && s.mainPDB === false, s && !s.err ? "PDB=" + s.mainPDB : "-"],
    ["球网：网纱 + 白网带 + 带下暗缝", n.mesh >= 1 && n.tape >= 1 && n.shade >= 1,
     "mesh=" + n.mesh + " tape=" + n.tape + " shade=" + n.shade],
    ["球网：两根网柱 + 网根接地影", n.posts === 2 && n.shadows === 2,
     "posts=" + n.posts + " shadows=" + n.shadows],
    ["球拍：拍面≈152mm / 柄≈95mm / 椭圆 1.02",
     r && r.bladeDia >= 150 && r.bladeDia <= 154 && r.handleL >= 93 && r.handleL <= 97 && r.oval > 1,
     r ? "拍面 " + r.bladeDia + "mm 柄 " + r.handleL + "mm oval " + r.oval : "RKT 不可读"],
    ["品牌行在左上，左下角水印已移除", b.hasBrand && b.noOldLogo && b.injected,
     "hudBrand=" + b.hasBrand + " 旧水印=" + !b.noOldLogo + " 名称=「" + b.name + "」"],
    ["结算中动画含乒乓球元素（球 + 影子）", st.el && st.fn && st.ball && st.shadow,
     "settle=" + st.el + " showSettle=" + st.fn + " ball=" + st.ball + " shadow=" + st.shadow],
    ["结算层底衬样式已到位（CDN 没返回旧 index.html）", st.backdrop,
     "background=" + (st.backdrop ? "半透明 ✓" : "缺失 ✗") + " radius=" + st.radius],
    ["结算窗口已减半到 1.25s（CSS 改动真的上了线）", /^1\.25s$/.test(st.wait || ""),
     "线上 --settle-wait=" + (st.wait || "（读不到）") + "（期望 1.25s，原 2.5s）"],
    ["进度条时长读 CSS 变量、与结算窗口一致", /^1\.25s$/.test(st.barUsesVar || ""),
     "线上 stBar animation-duration=" + (st.barUsesVar || "（读不到）") + "（期望 1.25s，与 --settle-wait 同源）"],

    /* ---- 本轮新增：右上角入口 / 双模式 / 失败归因 / 纪录系统 ---- */
    ["右上角 GitHub 入口指向本项目仓库（CDN 没返回旧 index.html）",
     lk.wrap && lk.ghHref === "https://github.com/huangluke89757/spin-table-tennis",
     "href=" + (lk.ghHref || "缺失")],
    ["GitHub 入口带「给项目点个 Star」提示文案",
     (lk.tip || "").indexOf("Star") >= 0, "tooltip=「" + (lk.tip || "缺失") + "」"],
    ["外链入口在 #hud 之外且层级高于浮层（开始页也看得见）",
     lk.outsideHud && lk.zIndex > 20,
     "outsideHud=" + lk.outsideHud + "　z-index=" + lk.zIndex],
    ["开始页有模式二选一卡片（练习 / 挑战）",
     md.cards === 2 && md.hasPractice && md.hasChallenge, "卡片 " + md.cards + " 张"],
    ["选挑战模式后强制关闭辅助（线上真实行为，非仅 DOM 存在）",
     !!md.afterClick && md.afterClick.mode === "challenge" && md.afterClick.assist === false,
     md.afterClick ? ("mode=" + md.afterClick.mode + "　assist=" + md.afterClick.assist)
                   : "点击无响应"],
    ["结束页新信息容器齐备（模式标签 / 距最佳 / 失败构成 / 历史榜）",
     dg.endMode && dg.endGap && dg.failWrap && dg.failList && dg.boardWrap && dg.boardList,
     "endMode=" + dg.endMode + " endGap=" + dg.endGap + " failList=" + dg.failList
     + " boardList=" + dg.boardList],
    ["失败归因函数在线上可用且归类正确",
     dg.classify === "吃旋转",
     "classifyFail('出界','吃旋转！上旋球要压拍') = " + dg.classify],
    ["纪录系统线上读写往返正确（写 1 局 → 读回历史与最佳）",
     dg.roundTrip === true, "commitResult → loadRecords → 校验 " + dg.roundTrip],
  ];
  const bad = items.filter(i => !i[1]);
  items.forEach(i => console.log("   " + (i[1] ? "PASS" : "FAIL") + "  " + i[0] + "　→ " + i[2]));
  return bad.length === 0;
}

(async () => {
  let last = null, okAt = 0;
  for (let i = 1; i <= TRIES; i++) {
    last = await once();
    /* 判据只看「用户实际看到的结果」：二维码有没有画出来。
     * 不把 404 一律算失败——旧版 game.js 会去请求已废弃的 vendor/qr.png，
     * 那个 404 是无害的：新版 poster.js 用内联矩阵同步绘制，不依赖它。
     * （这正好是内联改造的收益：二维码不再受 game.js 版本影响。）
     * 真正的失败只有一种：poster.js 还是旧版 → 二维码没画出来 → 白框。 */
    const qrOk = last.res.ratio === 1 && !last.res.taint;
    const stale = !!last.res.stale;
    const harmless404 = last.bad.every(u => /vendor\/qr\.(png|js)/.test(u));
    const otherBad = last.bad.filter(u => !/vendor\/qr\.(png|js)/.test(u));
    const ax = last.aux || {};
    const auxOk = !ax.missing && ax.before === false && ax.after === true &&
                  ax.keys && ax.cfg && ax.endBtn &&
                  ax.faceHidden && ax.cfgKept && ax.faceBack;

    console.log("第 " + i + " 次: " + (qrOk && auxOk ? "PASS" : "FAIL")
      + (qrOk ? " 二维码 " + last.res.hit + "/" + last.res.total
              : " " + (last.res.taint || last.res.stale || "二维码未画出"))
      + "  |  辅助面板 " + (ax.missing ? "DOM 缺失（旧版 index.html）"
          : (auxOk ? "开关可切（" + ax.before + "→" + ax.after + "，拍面栏同收放 " + ax.faceHidden + "）"
                   : "异常 " + JSON.stringify(ax)))
      + (stale ? "  [poster.js 为 CDN 旧缓存]" : "")
      + (last.bad.length ? "  | 404: " + last.bad.length + " 项" + (harmless404 ? "（已废弃的 qr.png，无害）" : "") : "")
      + (otherBad.length ? "  | 其他缺失: " + otherBad.join(" ") : ""));

    /* 本轮六项改动的线上特征（只在二维码那关过了才有意义 —— 旧版产物验不出新特征） */
    const featOk = qrOk ? judgeFeatures(last.feats || {}) : false;

    if (qrOk && auxOk && featOk && !otherBad.length && !last.errs.length) { okAt = i; break; }
    if (i < TRIES) await new Promise(r => setTimeout(r, 6000));
  }

  const good = okAt > 0;
  console.log("");
  console.log("线上地址    :", URL);
  console.log("结论        :", good
    ? (okAt === 1 ? "PASS 线上产物含全部已交付改动（离屏抓帧零主渲染 + 球网 ITTF + 球拍真实尺寸 + 品牌行 + 结算动画 / 1.25s 窗口 + 双模式 + 失败归因 + 历史榜 + GitHub 入口）"
                  : "PASS 线上正常（第 " + okAt + " 次成功 —— 前几次命中了 CDN 旧缓存节点，非代码问题）")
    : "FAIL 连续 " + TRIES + " 次均失败，需排查");
  process.exit(good ? 0 : 1);
})();
