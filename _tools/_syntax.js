// 语法检查：逐个文件过 node --check，确认无语法错误
// 运行： node _syntax.js
//
// 自动枚举而不是写死清单 —— 以前 FILES 是手写数组，新增脚本常常忘记加进来，
// 于是「语法全绿」其实只覆盖了一部分文件。现在两头都扫：
//   项目根  game.js / poster.js（游戏本体）
//   _tools/ 全部开发脚本
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;

function jsFilesIn(dir) {
  return fs.readdirSync(dir).filter(f => f.endsWith(".js")).sort();
}
const GAME = ["game.js", "poster.js"].filter(f => fs.existsSync(path.join(ROOT, f)));
const DEV = jsFilesIn(TOOLS).filter(f => f !== "_syntax.js");

let bad = 0, n = 0;
function check(dir, f) {
  n++;
  try {
    execFileSync(process.execPath, ["--check", path.join(dir, f)], { stdio: "pipe" });
    console.log("  OK    " + f);
  } catch (e) {
    bad++;
    console.log("  FAIL  " + f);
    console.log(String(e.stderr || e.message).split("\n").slice(0, 6).join("\n"));
  }
}
console.log("—— 游戏本体 ——");
GAME.forEach(f => check(ROOT, f));
console.log("—— 开发脚本（_tools/）——");
DEV.forEach(f => check(TOOLS, f));

console.log(bad ? "\n语法错误 " + bad + " 个（共检查 " + n + " 个文件）"
                : "\n全部文件语法通过（共 " + n + " 个）");
process.exit(bad ? 1 : 0);
