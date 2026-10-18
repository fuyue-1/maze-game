/**
 * minimap.js —— 右上角小地图
 * ------------------------------------------------------------
 * 设计考量（针对"看不到周围/不知道往哪走"的体验问题）：
 *
 *   1. 只画"已探索"区域 —— 不破坏迷雾的紧张感，玩家还是得自己去探
 *   2. 已探索的死路用红色 ✕ 永久标记 —— 走过一次就不用再踩
 *   3. 出口用金色菱形，即使不在视野内也显示（知道方向就有目标感）
 *   4. 怪物只在"当前视野内"才显示红点 —— 不给作弊式的全图透视
 *   5. 半透明悬浮，不遮挡主画面
 *
 * 性能：小地图尺寸固定（约 150px），每帧重绘成本 << 1ms。
 * 直接读 ExploredMap 的 Uint8Array，不遍历对象。
 */

const Minimap = (function () {
  'use strict';

  const SIZE = 148;          // CSS 像素尺寸
  const PADDING = 10;        // 内边距
  const OPACITY = 0.86;

  let canvas = null;
  let ctx = null;
  let dpr = 1;
  let cell = 4;              // 每个迷宫格在小地图上的像素
  let ox = 0, oy = 0;
  let cachedW = 0, cachedH = 0;

  const COLORS = {
    bg: 'rgba(252, 248, 238, 0.92)',
    border: 'rgba(180, 150, 100, 0.55)',
    exploredFloor: 'rgba(200, 186, 158, 0.9)',
    exploredWall: 'rgba(150, 132, 104, 0.9)',
    currentPath: 'rgba(217, 160, 74, 0.5)',
    player: '#C98A2E',
    playerRing: 'rgba(201, 138, 46, 0.4)',
    exit: '#FFD166',
    deadEnd: '#D9534F',
    monster: '#D9534F'
  };

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d');
    resize();
  }

  function resize() {
    if (!canvas) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(SIZE * dpr);
    canvas.height = Math.floor(SIZE * dpr);
    canvas.style.width = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** 根据迷宫尺寸算单个格子的像素大小，保证小地图始终撑满且比例正确 */
  function layout(maze) {
    if (!maze) return;
    cachedW = maze.w;
    cachedH = maze.h;
    const inner = SIZE - PADDING * 2;
    cell = Math.max(1.5, Math.min(inner / maze.w, inner / maze.h));
    ox = (SIZE - cell * maze.w) / 2;
    oy = (SIZE - cell * maze.h) / 2;
  }

  /**
   * 绘制小地图
   * @param {object} state 游戏状态
   */
  function draw(state) {
    if (!ctx || !state.maze) return;
    const maze = state.maze;
    if (state.maze.w !== cachedW) layout(maze);

    const size = SIZE;
    ctx.clearRect(0, 0, size, size);

    // ---- 底板 ----
    ctx.save();
    roundRect(ctx, 0, 0, size, size, 12);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    roundRect(ctx, 0, 0, size, size, 12);
    ctx.clip();

    const ex = state.explored;
    if (!ex) { ctx.restore(); return; }

    // ---- 已探索区域 ----
    // 只画探索过的格子，未探索的保持底板黑（视觉上就是"未知"）
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (!ex.has(x, y)) continue;
        const isWall = maze.grid[y][x] === 1;
        ctx.fillStyle = isWall ? COLORS.exploredWall : COLORS.exploredFloor;
        ctx.fillRect(ox + x * cell, oy + y * cell, cell + 0.4, cell + 0.4);
      }
    }

    // ---- 玩家轨迹（最近 30 步，让玩家看清自己怎么走的）----
    if (state.trail && state.trail.length > 1) {
      const n = state.trail.length;
      const start = Math.max(0, n - 30);
      ctx.strokeStyle = COLORS.currentPath;
      ctx.lineWidth = Math.max(1.2, cell * 0.42);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = start; i < n; i++) {
        const t = state.trail[i];
        const px = ox + (t.x + 0.5) * cell;
        const py = oy + (t.y + 0.5) * cell;
        if (i === start) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // ---- 已发现的死路：红色 ✕ ----
    if (state.foundDeadEnds && state.foundDeadEnds.size > 0) {
      const s = Math.max(2.4, cell * 0.62);
      ctx.strokeStyle = COLORS.deadEnd;
      ctx.lineWidth = Math.max(1, cell * 0.28);
      ctx.lineCap = 'round';
      for (const key of state.foundDeadEnds) {
        const comma = key.indexOf(',');
        const gx = +key.slice(0, comma);
        const gy = +key.slice(comma + 1);
        const cx = ox + (gx + 0.5) * cell;
        const cy = oy + (gy + 0.5) * cell;
        ctx.beginPath();
        ctx.moveTo(cx - s, cy - s);
        ctx.lineTo(cx + s, cy + s);
        ctx.moveTo(cx + s, cy - s);
        ctx.lineTo(cx - s, cy + s);
        ctx.stroke();
      }
    }

    // ---- 出口：金色菱形（不管是否探索到都显示，给玩家目标感）----
    {
      const gx = maze.end.x;
      const gy = maze.end.y;
      const cx = ox + (gx + 0.5) * cell;
      const cy = oy + (gy + 0.5) * cell;
      const r = Math.max(3.2, cell * 0.75);
      const pulse = 0.65 + 0.35 * Math.sin(performance.now() / 320);

      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.fillStyle = COLORS.exit;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // ---- 怪物：仅当前视野内显示（不做全图透视）----
    // 追击状态加一圈脉冲红环，让你一眼看出"它锁定我了"
    if (state.monsters && state.visibleSet) {
      for (const m of state.monsters) {
        const gx = Math.round(m.renderX);
        const gy = Math.round(m.renderY);
        if (!state.visibleSet.has(gx + ',' + gy)) continue;
        const cx = ox + (gx + 0.5) * cell;
        const cy = oy + (gy + 0.5) * cell;

        if (m.mood === 'chase') {
          const pulse = 1 + Math.sin((m.seed || 0) + performance.now() / 240) * 0.35;
          ctx.strokeStyle = 'rgba(217, 83, 79, 0.65)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, Math.max(3, cell * 0.75) * pulse, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = m.mood === 'chase'
          ? COLORS.monster
          : 'rgba(217, 83, 79, 0.65)';
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(2, cell * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- 玩家 ----
    {
      const p = state.player;
      const cx = ox + (p.renderX + 0.5) * cell;
      const cy = oy + (p.renderY + 0.5) * cell;
      const r = Math.max(2.6, cell * 0.55);

      // 光晕
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3);
      g.addColorStop(0, COLORS.playerRing);
      g.addColorStop(1, 'rgba(255,217,138,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = COLORS.player;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = 'rgba(10,14,23,0.8)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.restore();
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function onResize() { resize(); }

  return { init, draw, layout, onResize, SIZE };
})();
