/**
 * audio.js —— 背景音乐 + 怪物音效（WebAudio 全实时合成，零音频文件）
 * ------------------------------------------------------------
 * 分两层，同时播放、互相让位：
 *
 *   BGM 层（全篇都有，首页就响）
 *     · 轻快的 D 调五声音阶旋律 + 低音 + 柔和鼓点，104 BPM
 *     · 旋律上扬但留白多，昂扬而不压迫
 *     · 怪物靠近时自动压低（ducking），把空间让给紧张层
 *     · 胜利 / 失败时短暂停掉 BGM，放一段收尾乐句
 *
 *   Tension 层（怪物进入 5 格才出现）
 *     · 心跳（越近越快越响）、偶发抓挠
 *     · 左右声道跟随怪物方位
 *
 * 为什么全用合成器：
 *   1. 单文件版要内联资源，几百 KB 音频会拖慢首屏；
 *   2. 旋律要随状态无缝切换（首页→游戏→紧张→结算），
 *      实时合成才能做渐变交叉，录音做不到；
 *   3. 无版权素材风险。
 *
 * 浏览器限制：AudioContext 必须由用户手势创建，
 * 所以页面上第一次点击/触摸就 unlock()，而不是等点"开始游戏"。
 */

const Sfx = (function () {
  'use strict';

  const HEAR_RADIUS = 5;          // 听觉半径（格）
  const BPM = 104;
  const BEAT = 60 / BPM;          // 一拍 ≈ 0.577s
  const STEP = BEAT / 2;          // 八分音符步长

  // ==================== 乐谱 ====================
  // D 大调五声音阶（D E F# A B）：没有半音，听感明媚开阔，
  // 用来避开小调/减和弦带来的悬疑、压抑感。
  const N = {
    D4: 293.66, E4: 329.63, Fs4: 369.99, A4: 440.00, B4: 493.88,
    D5: 587.33, E5: 659.25, Fs5: 739.99, A5: 880.00,
    D3: 146.83, E3: 164.81, Fs3: 185.00, A3: 220.00, B3: 246.94
  };

  /*
   * 旋律：每个音 [音名, 时值(八分音符), 力度]
   * 共 4 句 8 小节循环：
   *   1 句 从 D5 冲到 A5，昂扬（开局动机）
   *   2 句 回落留白，不至于一直吊在高处
   *   3 句 高音区重复动机，推进感
   *   4 句 落到主音收束，循环衔接自然
   */
  const MELODY = [
    ['D5', 2], ['E5', 2], ['Fs5', 4], ['E5', 2], ['D5', 2], ['A4', 4],
    ['B4', 2], ['A4', 2], ['Fs4', 4], ['E4', 2], ['Fs4', 2], ['D4', 4],
    ['D5', 2], ['Fs5', 2], ['A5', 4], ['Fs5', 2], ['E5', 2], ['D5', 4],
    ['B4', 2], ['D5', 2], ['A4', 4], ['Fs4', 4], ['D4', 4]
  ];

  // 低音根音：每 2 小节换一次，稳定不抢旋律
  const BASS = ['D3', 'A3', 'B3', 'D3', 'D3', 'Fs3', 'E3', 'D3'];

  // 胜利 / 失败短乐句
  const WIN_LICK = [['D5', 2], ['Fs5', 2], ['A5', 4], ['D5', 8]];
  const LOSE_LICK = [['A4', 2], ['Fs4', 2], ['E4', 2], ['D4', 8]];

  // ==================== 状态 ====================
  let ctx = null;
  let master = null;          // 总输出（静音开关作用在这）
  let musicBus = null;        // BGM 总线
  let musicGain = null;       // BGM 音量（紧张时压低）
  let sfxBus = null;          // 音效总线（心跳/抓挠，不跟着 duck）
  let panner = null;

  let enabled = true;
  let started = false;
  let supported = true;
  let intensity = 0;          // 0~1 紧张度

  // 音序器
  let stepIndex = 0;          // 0~15，每 16 步 = 2 小节
  let nextNoteTime = 0;
  let seqTimer = 0;
  let eighths = 0;            // 总八分音符计数（算小节用）
  let melodyIdx = 0;          // MELODY 游标
  let melodyLeft = 0;         // 当前音还剩几个八分音符

  // 心跳 / 抓挠
  let lastBeat = 0;
  let scratchTimer = 0;

  // 段落：'menu' | 'play' | 'pause' | 'win' | 'lose'
  let mode = 'menu';
  let stingUntil = 0;

  const LS_KEY = 'maze_sound_on';

  function readPref() {
    try { if (localStorage.getItem(LS_KEY) === '0') enabled = false; } catch (e) { /* 忽略 */ }
  }
  readPref();

  function isOn() { return enabled && supported; }

  // ==================== 初始化 ====================

  /**
   * 创建音频链路并开始首页旋律。必须在用户手势里调用。
   * 幂等：重复调用只是 resume。
   */
  function unlock() {
    if (!supported) return false;
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) { supported = false; return false; }
        ctx = new AC();
        buildChain();
        started = true;          // buildChain 之后才置位，update() 靠它判断链路是否就绪
        startSequencer();
        // 首页音量：0.42。先淡入 2s，避免"啪"地出现
        fadeMusic(0.42, 2.0);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    } catch (e) {
      console.warn('[Sfx] 音频初始化失败', e);
      supported = false;
      return false;
    }
  }

  function buildChain() {
    master = ctx.createGain();
    master.gain.value = enabled ? 0.9 : 0;
    master.connect(ctx.destination);

    // musicBus → musicGain → master
    // sfxBus  → panner    → master
    musicBus = ctx.createGain();
    musicGain = ctx.createGain();
    musicGain.gain.value = 0;
    musicBus.connect(musicGain);
    musicGain.connect(master);

    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.9;

    if (ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.connect(master);
      sfxBus.connect(panner);
    } else {
      sfxBus.connect(master);
    }
  }

  // ==================== 音色 ====================

  /**
   * 拨弦/铃音：三角波 + 低通 + 快速衰减
   * 用三角波而不是正弦：正弦太"电子"，三角波带点木质感，
   * 接近八音盒/钢片琴，跟 Q 版小龙的气质对得上。
   */
  function pluck(freq, when, dur, vel, bus) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, when);
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(freq * 3.4, when);
    lp.Q.value = 0.7;

    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vel, when + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);

    osc.connect(lp); lp.connect(g); g.connect(bus || musicBus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  /** 低音：正弦长音，很轻 */
  function bass(freq, when, dur, vel) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vel, when + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
    osc.connect(g); g.connect(musicBus);
    osc.start(when);
    osc.stop(when + dur + 0.05);
  }

  /** 噪声缓冲（鼓点/沙锤共用，只建一次） */
  let noiseBuf = null;
  function noiseBuffer() {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 1.2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  /** 柔和手鼓：噪声 + 低通，不刺耳 */
  function softDrum(when, vel) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const g = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    bp.frequency.value = 420;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vel, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0006, when + 0.16);
    src.connect(bp); bp.connect(g); g.connect(musicBus);
    src.start(when); src.stop(when + 0.2);
  }

  /** 沙锤：高通噪声，极轻 */
  function hat(when, vel) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer();
    const g = ctx.createGain();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5400;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vel, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0004, when + 0.07);
    src.connect(hp); hp.connect(g); g.connect(musicBus);
    src.start(when); src.stop(when + 0.1);
  }

  // ==================== 音序器 ====================

  /**
   * 提前调度，而不是 setTimeout 里直接发声：
   * setTimeout 精度约 10ms 且会被主线程卡顿拖慢，
   * 把音符排进 AudioContext 时间轴，节奏才稳定。
   * 每 80ms 检查一次，把未来 250ms 内的音符一次性排好。
   */
  function startSequencer() {
    if (seqTimer) return;
    nextNoteTime = ctx.currentTime + 0.08;
    // 起点对齐主音，避免从句子中间开始
    melodyIdx = 0;
    melodyLeft = 0;
    seqTimer = setInterval(schedule, 80);
  }

  function schedule() {
    if (!ctx || ctx.state !== 'running') return;
    const horizon = ctx.currentTime + 0.25;
    while (nextNoteTime < horizon) {
      playStep(stepIndex, nextNoteTime);
      nextNoteTime += STEP;
      stepIndex = (stepIndex + 1) % 16;
      if (stepIndex === 0) eighths += 16;
    }
  }

  function playStep(step, when) {
    // 结算乐句期间：BGM 静默，让乐句清晰
    if (mode === 'win' || mode === 'lose') return;

    const onMenu = mode === 'menu';
    const quiet = mode === 'pause';

    // ---- 旋律 ----
    // 每 2 个八分音符（= 一拍）检查一次，是否该换音
    if (step % 2 === 0) {
      if (melodyLeft <= 0) {
        const note = MELODY[melodyIdx % MELODY.length];
        melodyIdx++;
        melodyLeft = note[1];        // 时值（八分音符数）
        const freq = N[note[0]];
        if (freq) {
          // 力度跟着时值走：长音更响一点，短音更轻，避免"哒哒哒"像机关枪
          const vel = 0.15 * (note[2] || 1) * (note[1] >= 4 ? 1.15 : 0.92);
          pluck(freq, when, Math.min(1.6, BEAT * note[1] * 1.05), vel);
        }
      }
      melodyLeft -= 2;
    }

    // ---- 低音：每 2 小节换一个根音 ----
    if (step === 0 && eighths % 32 === 0) {
      const idx = Math.floor(eighths / 32) % BASS.length;
      const bf = N[BASS[idx]];
      if (bf && !quiet) bass(bf, when, BEAT * 3.4, onMenu ? 0.085 : 0.11);
    }

    // ---- 鼓点：游戏中才有，首页保持干净 ----
    if (!onMenu && !quiet) {
      if (step === 0) softDrum(when, 0.10);
      if (step === 8) softDrum(when, 0.07);
      if (step % 4 === 2) hat(when, 0.016);
    } else if (onMenu) {
      // 首页只留极轻沙锤，有一点点"活着"的感觉
      if (step % 8 === 4) hat(when, 0.013);
    }
  }

  // ==================== 音量 ====================

  function fadeMusic(v, time) {
    if (!musicGain || !ctx) return;
    musicGain.gain.setTargetAtTime(v, ctx.currentTime, time);
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(LS_KEY, enabled ? '1' : '0'); } catch (e) { /* 忽略 */ }
    if (master && ctx) {
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(enabled ? 0.9 : 0, ctx.currentTime, 0.06);
    }
    return enabled;
  }

  function toggle() {
    if (!ctx) unlock();
    return setEnabled(!enabled);
  }

  // ==================== 每帧更新 ====================

  function update(state, dt) {
    if (!started || !ctx) return;

    const phase = state && state.phase;

    // ---- 段落判定 ----
    const prev = mode;
    if (phase === 'win') mode = 'win';
    else if (phase === 'lose') mode = 'lose';
    else if (phase === 'paused') mode = 'pause';
    else if (phase === 'playing') mode = 'play';
    else mode = 'menu';

    if (mode !== prev) onModeChange(prev, mode);

    // 结算乐句放完，自动回到首页旋律
    if ((mode === 'win' || mode === 'lose') && ctx.currentTime > stingUntil) {
      mode = 'menu';
      fadeMusic(0.42, 1.2);
    }

    // ---- 紧张度 ----
    const canTense = phase === 'playing' && !(state.stealthT > 0);
    if (!canTense || !state.monsters || !state.monsters.length) {
      intensity = 0;
      fadeMusic(mode === 'menu' ? 0.42 : 0.34, 0.5);
      return;
    }

    const p = state.player;
    let nearest = null, nd = Infinity;
    for (const m of state.monsters) {
      const d = Math.hypot(m.renderX - p.renderX, m.renderY - p.renderY);
      if (d < nd) { nd = d; nearest = m; }
    }
    if (!nearest || nd > HEAR_RADIUS) {
      intensity = 0;
      fadeMusic(mode === 'menu' ? 0.42 : 0.34, 0.5);
      return;
    }

    // 距离 → 紧张度：平方太"贴脸才响"，纯线性近端又太满，
    // 取 0.85 次方，近端留出层次、远端仍能察觉：
    //   5格 0 / 4格 0.26 / 3格 0.46 / 2格 0.65 / 1格 0.83
    const t = 1 - nd / HEAR_RADIUS;
    intensity = Math.pow(t, 0.85);

    // ---- BGM 让位：越紧张音乐越轻 ----
    fadeMusic(0.34 * (1 - intensity * 0.62), 0.35);

    // ---- 左右声道 ----
    if (panner) {
      const dx = nearest.renderX - p.renderX;
      const dy = nearest.renderY - p.renderY;
      const len = Math.hypot(dx, dy) || 1;
      // 叉积 → 怪物在玩家哪只手边；取反换算成"屏幕左右"
      const cross = (p.dir.x * dy - p.dir.y * dx) / len;
      panner.pan.setTargetAtTime(
        Math.max(-1, Math.min(1, -cross * 0.85)), ctx.currentTime, 0.15
      );
    }

    // ---- 心跳 ----
    const now = ctx.currentTime;
    const period = 0.95 - intensity * 0.63;
    if (now - lastBeat >= period) {
      lastBeat = now;
      beat(0.32 + intensity * 0.3);
    }

    // ---- 抓挠 ----
    scratchTimer -= dt;
    if (scratchTimer <= 0) {
      scratchTimer = (1.7 - intensity * 1.2) * (0.7 + Math.random() * 0.6);
      if (intensity > 0.2) scratch();
    }
  }

  function onModeChange(from, to) {
    if (to === 'menu') fadeMusic(0.42, 1.4);
    else if (to === 'play') fadeMusic(0.34, 0.9);
    else if (to === 'pause') fadeMusic(0.16, 0.5);
    else if (to === 'win') { fadeMusic(0.0, 0.25); playLick(WIN_LICK, 0.26); }
    else if (to === 'lose') { fadeMusic(0.0, 0.25); playLick(LOSE_LICK, 0.22); }
  }

  /** 收尾乐句（不循环），走高八度叠加让结尾更亮 */
  function playLick(notes, vel) {
    if (!ctx) return;
    let t = ctx.currentTime + 0.05;
    let total = 0;
    notes.forEach(([name, len]) => {
      const dur = len * STEP;
      pluck(N[name], t, Math.max(0.3, dur * 1.1), vel, sfxBus);
      t += dur;
      total += dur;
    });
    stingUntil = ctx.currentTime + total + 1.0;
  }

  /** 单次心跳 */
  function beat(vel) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(88, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.18);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
    osc.connect(g); g.connect(sfxBus);
    osc.start(now); osc.stop(now + 0.3);
  }

  /** 抓挠 */
  function scratch() {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const f = ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(260 + Math.random() * 120, now);
    osc.frequency.exponentialRampToValueAtTime(90, now + 0.14);
    f.type = 'bandpass';
    f.frequency.value = 900;
    f.Q.value = 2.2;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.09, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(f); f.connect(g); g.connect(sfxBus);
    osc.start(now); osc.stop(now + 0.18);
  }

  /** 兼容旧调用点（main.js 的 onWin/onLose） */
  function sting(kind) {
    if (!started || !enabled || !ctx) return;
    if (kind === 'win') playLick(WIN_LICK, 0.24);
    else playLick(LOSE_LICK, 0.2);
  }

  return {
    unlock, update, toggle, setEnabled, isOn, sting,
    HEAR_RADIUS,
    get intensity() { return intensity; },
    get mode() { return mode; }
  };
})();
