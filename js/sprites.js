/**
 * sprites.js —— 角色绘制模块（原创 Q 版小萌龙）
 * ------------------------------------------------------------
 * 为什么单独拆一个文件：
 *   render.js 已经负责"场景"（迷宫、迷雾、光效），角色是"会动的东西"，
 *   两者的改动频率完全不同（换角色皮肤 vs 改迷宫配色）。
 *   拆开后换皮只改本文件，不动场景代码。
 *
 * 关于版权：
 *   角色完全原创绘制，不参考任何商业 IP 的造型比例与配色，
 *   避免竞赛作品/公开展示时的侵权风险。
 *
 * 绘制约定：
 *   所有绘制函数接收 (ctx, cx, cy, size, opts)，
 *   (cx, cy) 是角色中心像素坐标，size 是格子的像素边长。
 *   所有细节尺寸都按 size 比例缩放，因此任意格子大小都清晰。
 */

const Sprites = (function () {
  'use strict';

  // ---- 小萌龙配色（默认奶黄，可被 Themes.applySkin 覆盖）----
  const DRAGON = {
    body: '#FFD98A',        // 奶黄主色
    bodyDark: '#F5B942',    // 阴影
    bodyLight: '#FFF3D1',   // 高光
    belly: '#FFF6E0',       // 肚皮
    accent: '#FF9F43',      // 橙（角/背刺）
    outline: '#8A5A22',     // 描边，深棕比纯黑更柔和
    eye: '#3A2A18',
    eyeWhite: '#FFFFFF',
    blush: 'rgba(255,138,138,0.55)',
    shadow: 'rgba(0,0,0,0.28)',
    // 体型参数
    headScale: 1.0,
    hornStyle: 'short'
  };

  /**
   * 应用外观皮肤（由 Themes 调用）
   * 只改颜色与体型参数，不动绘制代码 —— 加新皮肤无需改这里
   */
  function applySkin(skin) {
    if (!skin) return;
    ['body', 'bodyDark', 'bodyLight', 'belly', 'accent', 'outline', 'blush']
      .forEach((k) => {
        if (skin[k]) DRAGON[k] = skin[k];
      });
    DRAGON.headScale = skin.headScale || 1.0;
    DRAGON.hornStyle = skin.hornStyle || 'short';
  }

  // ---- 怪物配色（暗紫 + 荧光青，与奶黄形成强对比）----
  const MONSTER = {
    body: '#7B5CFF',
    bodyDark: '#4B32B8',
    glow: 'rgba(123,92,255,0.45)',
    eye: '#E8FBFF',
    eyeCore: '#20E3FF',
    spike: '#B49BFF'
  };

  /**
   * 绘制地面阴影（所有角色的共同前置）
   */
  function drawShadow(ctx, cx, cy, size, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = DRAGON.shadow;
    ctx.beginPath();
    ctx.ellipse(cx, cy + size * 0.28, size * 0.29, size * 0.11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * 小萌龙（玩家）
   * ------------------------------------------------------------
   * 结构自下而上：尾巴 → 身体 → 肚皮 → 手 → 脚 → 背刺 → 头 → 角 → 五官
   * 朝向 dir: {x, y}，用于左右翻转与眼睛偏移
   * walk: 0~1 的步态相位，驱动身体上下摆动与脚部错位
   * scared: 0~1，被怪物逼近时眼睛放大、嘴巴变"O"
   */
  function drawDragon(ctx, cx, cy, size, opts = {}) {
    const dir = opts.dir || { x: 1, y: 0 };
    const walk = opts.walk || 0;
    const scared = opts.scared || 0;
    const s = size;

    const bob = Math.sin(walk * Math.PI * 2) * s * 0.03;
    const faceLeft = dir.x < 0;

    drawShadow(ctx, cx, cy + s * 0.30, s, 0.9);

    ctx.save();
    ctx.translate(cx, cy + bob);
    if (faceLeft) ctx.scale(-1, 1);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // ============ 比例（Q 版二头身） ============
    // 头：大圆 R=0.27s，中心 (0,-0.13s)；身体：椭圆 R=0.20s，中心 (0,+0.13s)
    const bodyR = s * 0.20;
    const headR = s * 0.27 * (DRAGON.headScale || 1);
    const bodyY = s * 0.13;
    const headY = -s * 0.13;

    // ---------- 尾巴 ----------
    ctx.strokeStyle = DRAGON.outline;
    ctx.lineWidth = s * 0.062;
    ctx.beginPath();
    ctx.moveTo(-bodyR * 0.5, bodyY + bodyR * 0.55);
    ctx.quadraticCurveTo(-bodyR * 1.5, bodyY + bodyR * 0.9, -bodyR * 1.55, bodyY + bodyR * 0.25);
    ctx.stroke();
    ctx.strokeStyle = DRAGON.body;
    ctx.lineWidth = s * 0.040;
    ctx.beginPath();
    ctx.moveTo(-bodyR * 0.5, bodyY + bodyR * 0.55);
    ctx.quadraticCurveTo(-bodyR * 1.5, bodyY + bodyR * 0.9, -bodyR * 1.55, bodyY + bodyR * 0.25);
    ctx.stroke();
    ctx.fillStyle = DRAGON.accent;
    ctx.beginPath();
    ctx.moveTo(-bodyR * 1.5, bodyY + bodyR * 0.2);
    ctx.lineTo(-bodyR * 1.95, bodyY + bodyR * 0.05);
    ctx.lineTo(-bodyR * 1.42, bodyY - bodyR * 0.05);
    ctx.closePath();
    ctx.fill();

    // ---------- 脚 ----------
    const stepL = Math.sin(walk * Math.PI * 2) * s * 0.045;
    const stepR = -stepL;
    ctx.fillStyle = DRAGON.bodyDark;
    ctx.strokeStyle = DRAGON.outline;
    ctx.lineWidth = s * 0.02;
    [[-bodyR * 0.45, stepL], [bodyR * 0.4, stepR]].forEach(([fx, off]) => {
      ctx.beginPath();
      ctx.ellipse(fx, bodyY + bodyR * 0.95 + off, s * 0.07, s * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });

    // ---------- 身体 ----------
    const bodyGrad = ctx.createRadialGradient(-bodyR * 0.3, bodyY - bodyR * 0.4, bodyR * 0.2,
                                              0, bodyY, bodyR * 1.25);
    bodyGrad.addColorStop(0, DRAGON.bodyLight);
    bodyGrad.addColorStop(0.6, DRAGON.body);
    bodyGrad.addColorStop(1, DRAGON.bodyDark);
    ctx.fillStyle = bodyGrad;
    ctx.strokeStyle = DRAGON.outline;
    ctx.lineWidth = s * 0.024;
    ctx.beginPath();
    ctx.ellipse(0, bodyY, bodyR, bodyR * 1.02, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 背刺
    ctx.fillStyle = DRAGON.accent;
    ctx.strokeStyle = DRAGON.outline;
    ctx.lineWidth = s * 0.016;
    [[-0.95, -0.35], [-1.12, 0.05]].forEach(([nx, ny]) => {
      const bx = bodyR * nx, by = bodyY + bodyR * ny;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - s * 0.07, by - s * 0.02);
      ctx.lineTo(bx - s * 0.02, by + s * 0.05);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    // 肚皮
    ctx.fillStyle = DRAGON.belly;
    ctx.beginPath();
    ctx.ellipse(0, bodyY + bodyR * 0.32, bodyR * 0.62, bodyR * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();

    // 小手
    ctx.strokeStyle = DRAGON.outline;
    ctx.lineWidth = s * 0.055;
    ctx.beginPath();
    ctx.moveTo(bodyR * 0.85, bodyY - bodyR * 0.1);
    ctx.lineTo(bodyR * 1.12, bodyY + bodyR * 0.25);
    ctx.stroke();
    ctx.strokeStyle = DRAGON.body;
    ctx.lineWidth = s * 0.036;
    ctx.beginPath();
    ctx.moveTo(bodyR * 0.85, bodyY - bodyR * 0.1);
    ctx.lineTo(bodyR * 1.12, bodyY + bodyR * 0.25);
    ctx.stroke();

    // ---------- 头 ----------
    const headGrad = ctx.createRadialGradient(-headR * 0.35, headY - headR * 0.45, headR * 0.25,
                                              0, headY, headR * 1.2);
    headGrad.addColorStop(0, DRAGON.bodyLight);
    headGrad.addColorStop(0.6, DRAGON.body);
    headGrad.addColorStop(1, DRAGON.bodyDark);
    ctx.fillStyle = headGrad;
    ctx.strokeStyle = DRAGON.outline;
    ctx.lineWidth = s * 0.024;
    ctx.beginPath();
    ctx.ellipse(0, headY, headR, headR * 0.96, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // ---------- 角 ----------
    // 两种造型：short（短圆角）/ long（细长尖角）
    ctx.fillStyle = DRAGON.accent;
    ctx.strokeStyle = DRAGON.outline;
    ctx.lineWidth = s * 0.018;
    const hornLong = DRAGON.hornStyle === 'long';
    const hornH = hornLong ? s * 0.155 : s * 0.1;
    const hornW = hornLong ? s * 0.028 : s * 0.045;
    [-0.5, 0.42].forEach((ox) => {
      const bx = headR * ox;
      const by = headY - headR * 0.78;
      ctx.beginPath();
      ctx.moveTo(bx - hornW, by + s * 0.03);
      ctx.quadraticCurveTo(bx - hornW * 0.3, by - hornH * 0.7, bx + (hornLong ? s * 0.02 : s * 0.03), by - hornH);
      ctx.quadraticCurveTo(bx + hornW * 1.1, by - hornH * 0.3, bx + hornW, by + s * 0.03);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    });

    // ---------- 眼睛 ----------
    const eyeR = s * (0.058 + scared * 0.02);
    const eyeY = headY + headR * 0.05;
    const eyeDX = headR * 0.36;
    const lookX = dir.x >= 0 ? s * 0.014 : 0;
    const lookY = dir.y * s * 0.012;

    [-1, 1].forEach((sx) => {
      const ex = sx * eyeDX;
      ctx.fillStyle = DRAGON.eyeWhite;
      ctx.beginPath();
      ctx.ellipse(ex + lookX, eyeY + lookY, eyeR, eyeR * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = DRAGON.eye;
      ctx.beginPath();
      ctx.ellipse(ex + lookX, eyeY + lookY + eyeR * 0.08, eyeR * 0.72, eyeR * 0.86, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = DRAGON.eyeWhite;
      ctx.beginPath();
      ctx.arc(ex + lookX - eyeR * 0.26, eyeY + lookY - eyeR * 0.34, eyeR * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + lookX + eyeR * 0.3, eyeY + lookY + eyeR * 0.32, eyeR * 0.14, 0, Math.PI * 2);
      ctx.fill();
    });

    // ---------- 腮红 ----------
    ctx.fillStyle = DRAGON.blush;
    [-1, 1].forEach((sx) => {
      ctx.beginPath();
      ctx.ellipse(sx * headR * 0.72, eyeY + headR * 0.38, eyeR * 0.66, eyeR * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // ---------- 嘴 ----------
    ctx.strokeStyle = DRAGON.eye;
    ctx.lineWidth = s * 0.02;
    if (scared > 0.5) {
      ctx.fillStyle = DRAGON.eye;
      ctx.beginPath();
      ctx.ellipse(lookX, eyeY + headR * 0.52, s * 0.034, s * 0.044, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(lookX, eyeY + headR * 0.38, s * 0.05, 0.2 * Math.PI, 0.8 * Math.PI);
      ctx.stroke();
    }

    ctx.restore();
  }



  /**
   * 怪物（暗影小怪）
   * ------------------------------------------------------------
   * 设计思路：与玩家形成"暖 vs 冷"的强对比。
   * 半透明拖影 + 荧光眼，在黑暗里一眼能认出是威胁。
   */
  function drawMonster(ctx, cx, cy, size, opts = {}) {
    const walk = opts.walk || 0;
    const seed = opts.seed || 0;
    const s = size;
    const pulse = 0.5 + 0.5 * Math.sin(walk * Math.PI * 2 + seed);

    drawShadow(ctx, cx, cy + s * 0.02, s, 0.8);

    ctx.save();
    ctx.translate(cx, cy + Math.sin(walk * Math.PI * 2 + seed) * s * 0.03);

    // 外发光
    const glowR = s * (0.42 + pulse * 0.06);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR * 1.7);
    glow.addColorStop(0, 'rgba(123,92,255,0.55)');
    glow.addColorStop(0.6, 'rgba(123,92,255,0.18)');
    glow.addColorStop(1, 'rgba(123,92,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, glowR * 1.7, 0, Math.PI * 2);
    ctx.fill();

    // 本体：不规则球形，带 6 根尖刺
    const r = s * 0.27;
    const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.1, 0, 0, r * 1.15);
    grad.addColorStop(0, '#9B80FF');
    grad.addColorStop(0.65, MONSTER.body);
    grad.addColorStop(1, MONSTER.bodyDark);
    ctx.fillStyle = grad;

    const spikes = 7;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const ang = (Math.PI * i) / spikes - Math.PI / 2;
      const isSpike = i % 2 === 0;
      const rr = isSpike ? r * (1.22 + pulse * 0.1) : r * 0.9;
      const x = Math.cos(ang) * rr;
      const y = Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    // 荧光眼（两只，竖瞳）
    const eyeDX = r * 0.34;
    const eyeDY = -r * 0.08;
    [-1, 1].forEach((sx) => {
      ctx.fillStyle = MONSTER.eye;
      ctx.beginPath();
      ctx.ellipse(sx * eyeDX, eyeDY, r * 0.2, r * 0.25, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = MONSTER.eyeCore;
      ctx.beginPath();
      ctx.ellipse(sx * eyeDX, eyeDY, r * 0.1, r * 0.19, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // 眼睛外发光
    ctx.shadowColor = MONSTER.eyeCore;
    ctx.shadowBlur = s * 0.25;
    [-1, 1].forEach((sx) => {
      ctx.fillStyle = 'rgba(32,227,255,0.7)';
      ctx.beginPath();
      ctx.arc(sx * eyeDX, eyeDY, r * 0.09, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  /**
   * 出口（吐司形的传送门）
   * ------------------------------------------------------------
   * 设计：金色拱门 + 向上飘的光粒，远远就能认出"这是目标"
   */
  function drawPortal(ctx, cx, cy, size, opts = {}) {
    const t = opts.time || 0;
    const s = size;
    const pulse = 0.5 + 0.5 * Math.sin(t * 3);

    ctx.save();
    ctx.translate(cx, cy);

    // 外圈光晕
    const R = s * (0.46 + pulse * 0.05);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.9);
    glow.addColorStop(0, 'rgba(255,209,102,0.75)');
    glow.addColorStop(0.5, 'rgba(255,209,102,0.22)');
    glow.addColorStop(1, 'rgba(255,209,102,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.9, 0, Math.PI * 2);
    ctx.fill();

    // 拱门形状（上圆下方）
    ctx.fillStyle = 'rgba(255,209,102,0.92)';
    ctx.beginPath();
    const w = s * 0.3;
    const h = s * 0.4;
    ctx.moveTo(-w, h * 0.7);
    ctx.lineTo(-w, -h * 0.1);
    ctx.arc(0, -h * 0.1, w, Math.PI, 0);
    ctx.lineTo(w, h * 0.7);
    ctx.closePath();
    ctx.fill();

    // 门内深色
    ctx.fillStyle = 'rgba(58,38,8,0.82)';
    ctx.beginPath();
    const w2 = w * 0.62;
    const h2 = h * 0.86;
    ctx.moveTo(-w2, h * 0.7);
    ctx.lineTo(-w2, -h * 0.05);
    ctx.arc(0, -h * 0.05, w2, Math.PI, 0);
    ctx.lineTo(w2, h * 0.7);
    ctx.closePath();
    ctx.fill();

    // 上升光粒
    for (let i = 0; i < 3; i++) {
      const ph = (t * 0.7 + i / 3) % 1;
      const py = h * 0.6 - ph * h * 1.5;
      const px = Math.sin((t + i) * 2.2) * w * 0.5;
      ctx.globalAlpha = (1 - ph) * 0.9;
      ctx.fillStyle = '#FFE9A8';
      ctx.beginPath();
      ctx.arc(px, py, s * 0.028 * (1 - ph * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  return { drawDragon, drawMonster, drawPortal, drawShadow, applySkin, DRAGON, MONSTER };
})();
