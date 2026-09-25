/* 观众欢呼音质的客观验证：离线渲染真实 game.js 的音效 → PCM → 频谱分析
 *
 * 为什么必须做这一步：用户反馈"欢呼声是轰轰轰"。代码结构断言（"创建了振荡器"）
 * 不等于听感——参数错（共振峰增益太小、基频太低）照样是轰鸣。
 * 唯一可靠的办法是把真实代码渲染成 PCM，量它的客观声学特征。
 *
 * 渲染四段，用于定位"轰轰"到底出在哪一层：
 *   room_old  旧版球馆底噪（400Hz 低通噪声，loop 播放）← 疑似"轰轰轰"元凶
 *   room_new  新版球馆底噪（高通 220Hz 切掉低频轰鸣）
 *   voice_new 新版纯人声层（只跑 crowdVoice，不含掌声）← 验证"人声"本质
 *   voice_old 旧版"人声"层（带通噪声，无基频）
 *   cheer_new / cheer_old  完整欢呼（掌声 + 人声），用于整体对比
 *
 * 运行： NODE_PATH=<playwright node_modules> node _audio_spectrum.js
 */
const { chromium } = require("playwright");


const path = require("path");
const fs = require("fs");
/* 本脚本位于 _tools/：项目根在上一层。
 * ROOT 定位游戏本体与产物（game.js / index.html / _shots），TOOLS 定位同级脚本。 */
const ROOT = path.join(__dirname, "..");
const TOOLS = __dirname;

const GAME = fs.readFileSync(path.join(ROOT, "game.js"), "utf8");
const OUT = path.join(ROOT, "_shots");

/* 从源码里抽一个顶层函数声明（花括号配平）。抽真实代码，不复刻。 */
function extractFn(src, name) {
  const head = "function " + name + "(";
  const i = src.indexOf(head);
  if (i < 0) throw new Error("找不到函数 " + name);
  let j = src.indexOf("{", i), depth = 0, k = j;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { k++; break; } }
  }
  return src.slice(i, k);
}

const SRC_RAND = extractFn(GAME, "rand");
const SRC_VOICE = extractFn(GAME, "crowdVoice");
const SRC_CROWD = extractFn(GAME, "sfxCrowd");
console.log("已抽真实函数：rand / crowdVoice(" + SRC_VOICE.length + "B) / sfxCrowd(" + SRC_CROWD.length + "B)");

/* 底噪链的增益与滤波参数直接从 game.js 源码解析，避免渲染脚本与线上代码不同步——
 * 之前硬编码 0.012 而 game.js 已改成 0.006，量出来的就不是线上真实听感了。 */
const AUDIO_INIT = extractFn(GAME, "audioInit");
const HP_F = parseFloat((AUDIO_INIT.match(/hp\.frequency\.value\s*=\s*([\d.]+)/) || [0, 220])[1]);
const LP_F = parseFloat((AUDIO_INIT.match(/lp\.frequency\.value\s*=\s*([\d.]+)/) || [0, 2600])[1]);
const RG_G = parseFloat((AUDIO_INIT.match(/rg\.gain\.value\s*=\s*([\d.]+)/) || [0, 0.006])[1]);
const OLD_LP = 400, OLD_RG = 0.035;      // 旧版固定值（已从代码中移除，作为对照基线）
console.log("从 audioInit 解析底噪参数：新版 高通 " + HP_F + "Hz / 低通 " + LP_F +
            "Hz / 增益 " + RG_G + "　对照旧版 低通 " + OLD_LP + "Hz / 增益 " + OLD_RG);

/* 旧版"人声"层：13 条高 Q 带通噪声（480~980Hz 滑频）。
 * 用户听到的"轰轰"就来自这里 —— 480~980Hz 用窄带噪声实现，是"嗡嗡"频段而非人声基频。 */
const SRC_VOICE_OLD = `
function crowdVoiceOld() {
  const AC = SFX.ac, dur = 1.5, t0 = AC.currentTime;
  for (let i = 0; i < 13; i++) {
    const s = AC.createBufferSource(); s.buffer = SFX.noise;
    const f = AC.createBiquadFilter();
    const base = rand(480, 980);
    f.type = "bandpass"; f.Q.value = rand(5, 9);
    const t = t0 + rand(0, 0.20);
    f.frequency.setValueAtTime(base, t);
    f.frequency.linearRampToValueAtTime(base * rand(1.05, 1.35), t + dur * 0.55);
    f.frequency.linearRampToValueAtTime(base * rand(0.82, 1.0), t + dur);
    const g = AC.createGain();
    const amp = rand(0.018, 0.042);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + rand(0.06, 0.16));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * rand(0.70, 1.0));
    s.connect(f); f.connect(g); g.connect(SFX.master);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }
}
`;

/* 新版纯人声层：直接调 crowdVoice 若干条，不含掌声 —— 隔离出"人声"本身 */
const SRC_VOICE_ONLY = `
function crowdVoiceOnly() {
  const fBase = rand(140, 200);
  for (let i = 0; i < 24; i++) {
    const u = i / 24;
    crowdVoice(u * u * 0.7 + rand(0, 0.09), rand(0.9, 1.5), rand(0.014, 0.032), fBase * rand(0.72, 1.55));
  }
}
`;

(async () => {
  const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const p = await b.newPage();

  const res = await p.evaluate(async (payload) => {
    const SR = 48000, LEN = SR * 3;

    /* 用 OfflineAudioContext 渲染：不发声、可离线取 PCM。
     * 支持两种 mode：
     *   "loop"  —— 底噪，全程持续（模拟 loop 播放）
     *   "once"  —— 事件音，只在开头触发一次 */
    async function render(fnSrc, fnName, mode) {
      const oac = new OfflineAudioContext(1, LEN, SR);
      const noise = oac.createBuffer(1, LEN, SR);
      const nd = noise.getChannelData(0);
      for (let i = 0; i < LEN; i++) nd[i] = Math.random() * 2 - 1;

      const master = oac.createGain();
      master.gain.value = 1;
      master.connect(oac.destination);

      const SFX = { ac: oac, noise: noise, master: master, ready: true, mute: false,
                    crowdAt: 0, crowdKind: "", crowdFP: null };

      /* 底噪：复刻 audioInit 里的 room 节点链（新版高通 / 旧版纯低通） */
      if (mode === "loop") {
        const room = oac.createBufferSource(); room.buffer = noise; room.loop = true;
        if (fnName === "roomNew") {
          const hp = oac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = payload.hpF;
          const lp = oac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = payload.lpF;
          /* 参数由 Node 侧从 game.js 源码解析后传入，保证量的是线上真实听感 */
          const rg = oac.createGain(); rg.gain.value = payload.rgG;
          room.connect(hp); hp.connect(lp); lp.connect(rg); rg.connect(master);
        } else {
          const lp = oac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = payload.oldLp;
          const rg = oac.createGain(); rg.gain.value = payload.oldRg;
          room.connect(lp); lp.connect(rg); rg.connect(master);
        }
        room.start();
      } else {
        const body = payload.rand + "\n" + payload.voice + "\n" + fnSrc +
                     "\nreturn { go: " + fnName + " };";
        const api = new Function("SFX", body)(SFX);
        api.go();
      }
      const buf = await oac.startRendering();
      return Array.from(buf.getChannelData(0));
    }

    return {
      sr: SR,
      roomOld:  await render(payload.voiceOld, "roomOld",  "loop"),
      roomNew:  await render(payload.voice,    "roomNew",  "loop"),
      voiceOld: await render(payload.voiceOld, "crowdVoiceOld", "once"),
      voiceNew: await render(payload.voiceOnly, "crowdVoiceOnly", "once"),
      cheerOld: await render(payload.voiceOld, "crowdVoiceOld", "once"),
      cheerNew: await render(payload.crowd,    "sfxCrowd", "once")
    };
  }, { rand: SRC_RAND, voice: SRC_VOICE, voiceOld: SRC_VOICE_OLD,
       voiceOnly: SRC_VOICE_ONLY, crowd: SRC_CROWD,
       hpF: HP_F, lpF: LP_F, rgG: RG_G, oldLp: OLD_LP, oldRg: OLD_RG });

  await b.close();
  fs.writeFileSync(path.join(OUT, "cheer_spectrum.json"), JSON.stringify(res));
  console.log("PCM 已渲染 6 段（48kHz / 3s）：底噪×2、人声层×2、完整欢呼×2");
  console.log("→ _shots/cheer_spectrum.json");
})();
