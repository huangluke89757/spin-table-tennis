// 一键回归：语法 → 物理内核 → 完整冒烟（含音效链路）→ 真浏览器截图 → 海报与抓帧
// 运行： node _run_all.js
const { execFileSync } = require("child_process");
const path = require("path");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;
const NODE = process.execPath;
/* 子进程 cwd 必须是项目根，否则子脚本里的相对路径（_shots 等）会落到 _tools/ 下。 */
const CWD = ROOT;

function run(label, file, extraEnv, showTail, args) {
  process.stdout.write("\n=== " + label + " ===\n");
  try {
    const out = execFileSync(NODE, [path.join(TOOLS, file)].concat(args || []), {
      cwd: CWD, env: Object.assign({}, process.env, extraEnv || {}), encoding: "utf8"
    });
    const lines = out.trim().split("\n");
    console.log(showTail ? lines.slice(-showTail).join("\n") : out.trim());
    return true;
  } catch (e) {
    const txt = (e.stdout || "") + (e.stderr || "");
    console.log(txt.trim().split("\n").slice(-22).join("\n"));
    console.log("!!! " + label + " 失败（退出码 " + e.status + "）");
    return false;
  }
}

const WS = "C:/Users/Sxg/.workbuddy/binaries/node/workspace/node_modules";
const PY = "C:/Users/Sxg/.workbuddy/binaries/python/versions/3.13.12/python.exe";
const { execFileSync: exec2 } = require("child_process");

/* 二维码独立交叉验证：用 python qrcode 库重新编码，与 poster.js 内联矩阵逐位比对。
 * 为什么单独一关：_poster_shot.js 是拿 poster.js 的矩阵去比对画布，两边同源，
 * 常量写错会一起错。必须有独立信源才算验过。 */
function runPy(label, file) {
  process.stdout.write("\n=== " + label + " ===\n");
  try {
    const out = exec2(PY, [path.join(TOOLS, file)], { cwd: CWD, encoding: "utf8" });
    console.log(out.trim());
    return true;
  } catch (e) {
    console.log(((e.stdout || "") + (e.stderr || "")).trim().split("\n").slice(-12).join("\n"));
    console.log("!!! " + label + " 失败（退出码 " + e.status + "）");
    return false;
  }
}

let allOk = true;
allOk = run("1/14 语法检查", "_syntax.js") && allOk;
allOk = run("2/14 物理内核回归（含求解器性能）", "_phys_test.js", null, 6) && allOk;
/* 物理数值快照：优化热路径后必须逐位一致。
 * 为什么单独一关：K 系数是离线标定到 732/732 的，浮点末位差异在极端弹道上
 * 可能把"擦网上台"翻成"下网"。_phys_test 只覆盖代表性用例，这一关跑 4320 条弹道做逐位比对。 */
allOk = run("3/14 物理内核数值一致性（新旧实现逐位比对）", "_phys_perf.js", null, 5, ["--compare"]) && allOk;
allOk = run("4/14 完整冒烟（含音效链路）", "_smoke.js", null, 22) && allOk;
/* 移动端手势：静态契约（视口/touch-action/DOM）+ 运行时（双区/量纲/门控/几何）。
 * 为什么必须在本地回归里占一关：移动端改造的风险（触摸被 pointercancel 掐断、
 * 双区串扰、小屏量纲被放大、竖屏几何不成立）**全都不走桌面路径**，
 * 只靠桌面冒烟永远发现不了。真浏览器触摸链路另见 _touch_browser.js。 */
allOk = run("5/14 移动端手势（双区 · 量纲 · 设备门控）", "_touch.js", null, 8) && allOk;
allOk = run("6/14 真浏览器截图", "_shot.js", { NODE_PATH: WS }) && allOk;
allOk = run("7/14 海报 / 抓帧 / 残影 / 二维码", "_poster_shot.js", { NODE_PATH: WS }) && allOk;
allOk = runPy("8/14 二维码独立交叉验证", "_qr_verify.py") && allOk;
/* 底部辅助面板布局：重叠是「盒子在屏幕上的位置」问题，Node 桩量不出来，
 * 必须真浏览器量 getBoundingClientRect 两两求交。 */
allOk = run("9/14 辅助面板布局（多尺寸 · 不重叠 · 拍面栏同收放）", "_aux_shot.js", { NODE_PATH: WS }, 10) && allOk;
/* 观众欢呼声学验证：把真实 game.js 音效代码离线渲染成 PCM 做 FFT。
 * 为什么必须做：代码结构对（"创建了振荡器"）不等于听感对——
 * 用户反馈"轰轰轰"必须用频谱客观证明真的变了，而不是靠自我感觉。 */
allOk = run("10/14 观众欢呼声学验证（离线渲染 + FFT）", "_audio_spectrum.js", { NODE_PATH: WS }, 4) && allOk;
allOk = runPy("11/14 欢呼声频谱分析（逐层定位 + 新旧对照）", "_audio_spectrum.py") && allOk;
/* 真浏览器触摸链路：CDP 注入真实触摸序列，验 touch-action 生效（无 pointercancel）、
 * 双区手势真的把球打回去。与 _touch.js 的分工：那一关验逻辑与契约（快、可在 CI 跑），
 * 这一关验浏览器真实触摸行为（慢、需 Chromium）。 */
allOk = run("12/14 真浏览器触摸链路（CDP 注入）", "_touch_browser.js", { NODE_PATH: WS }, 12) && allOk;

/* 线上端到端验证只在显式要求时跑：它会真的访问线上地址。
 * 为什么需要它：本地 file:// 全绿、线上却曾因漏传 vendor/qr.js 出现白框。
 * 本地测试无法证明「部署后的站点是好的」，只有打开线上地址看画布才算。 */
if (process.argv.indexOf("--live") >= 0) {
  allOk = run("13/14 线上端到端验证（访问线上地址）", "_live_verify.js", { NODE_PATH: WS }, 8) && allOk;
  /* 线上移动端手势：本关与上一关的分工是「产物正确」→「产物上的新功能可用」。
   * 上一关验的是历史功能（离屏抓帧 / 球网 / 双模式…），一条都没覆盖移动端改造；
   * 而移动端这次横跨 index.html（CSS / DOM / viewport meta）与 game.js（量纲 / 门控 / 手势），
   * 正是 CDN 新旧错配的高危区。最硬的一条证据是直接在线上页面调 measureDrag，
   * 比对触摸与鼠标两套阈值 —— 版本戳只能证明 URL 变了，这一条能证明**内容**变了。 */
  allOk = run("14/14 线上移动端手势（平板横屏触摸 / 竖屏拦截 / 桌面零回归）", "_live_touch.js",
              { NODE_PATH: WS }, 8) && allOk;
} else {
  console.log("\n=== 13/14 线上端到端验证 ===\n跳过（加 --live 参数可跑：node _run_all.js --live）");
  console.log("\n=== 14/14 线上移动端手势 ===\n跳过（加 --live 参数可跑：node _run_all.js --live）");
}

console.log((allOk ? "全部通过" : "存在失败项，见上方输出"));
process.exit(allOk ? 0 : 1);
