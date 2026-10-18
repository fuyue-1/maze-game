/**
 * render.js —— Canvas 渲染层
 * ------------------------------------------------------------
 * 只负责"把状态画出来"，不含任何游戏规则判断。
 * 角色绘制委托给 sprites.js，本文件负责场景：墙体、光照、迷雾、暗角。
 *
 * 视觉升级要点：
 *   1. 墙体不再是无脑方块：顶部高光 + 底部投影 + 棱边，形成体积感
 *   2. 迷雾是多层径向渐变，边缘自然过渡，不是一刀切的黑色
 *   3. 玩家暖黄光晕、怪物冷紫光晕，冷暖对比强化威胁感
 *   4. 地板棋盘格 + 极淡网格线，避免大片纯色显得廉价
 *
 * 性能要点：
 *   1. 迷宫墙体预渲染到离屏 canvas（staticLayer），每帧只 drawImage 一次
 *   2. 迷雾/暗角层复用离屏 canvas，避免每帧新建
 *   3. 角色用 path 绘制，无贴图加载
 */

const Renderer = (function () {
  'use strict';

  // 主题色板：可被 Themes.applyTheme 整体替换（不能是 const 字面量锁死）
  let PALETTE = {
    bg: '#d9cfba',
    wallTop: '#8A7355',
    wallSide: '#4A3C2A',
    wallEdge: '#A58A64',
    wallShadow: '#171008',
    floor: '#241C10',
    floorAlt: '#2A2114',
    floorLine: 'rgba(228,180,100,0.05)',
    fog: 'rgba(196,186,166,1)',
    explored: 'rgba(168,158,138,0.42)',
    trail: 'rgba(255,217,138,0.20)',
    trailCore: 'rgba(255,217,138,0.55)'
  };

  /**
   * 应用场景主题
   * 换色后必须重建静态层（墙体和地板是预渲染的），
   * 同时清掉暗角缓存，否则会出现"新墙体 + 旧暗角"的割裂感。
   */
  function applyTheme(palette) {
    if (!palette) return;
    PALETTE = Object.assign({}, PALETTE, palette);
    staticDirty = true;
    vignetteCanvas = null;
    if (cachedMaze) {
      buildStaticLayer();
      staticDirty = false;
    }
  }

  let canvas = null;
  let ctx = null;
  let staticLayer = null;
  let fogCanvas = null;
  let vignetteCanvas = null;
  let staticDirty = true;

  let cellSize = 16;
  let offsetX = 0;
  let offsetY = 0;
  let cachedMaze = null;

  let clock = 0;

  // ---- 视角模式：'2d' 俯视 / 'iso' 等距 2.5D / '3d' 真 3D ----
  // 由 Game 调用 setViewMode 切换，渲染入口 draw() 自动分发。
  let viewMode = '2d';
  let isoReady = false;
  let threeReady = false;

  function setViewMode(mode) {
    if (mode !== '2d' && mode !== 'iso' && mode !== '3d') return;

    // 真 3D 初始化失败（无 WebGL）时自动退回 2D
    if (mode === '3d') {
      if (typeof Iso3D !== 'undefined' && Iso3D.isSupported()) {
        if (!threeReady) threeReady = Iso3D.init(canvas);
        if (!threeReady) mode = '2d';
      } else {
        mode = '2d';
      }
    }

    if (mode === 'iso' && typeof Iso !== 'undefined' && !isoReady) {
      Iso.init(canvas);
      isoReady = true;
    }

    viewMode = mode;

    // 3D 用的是独立叠加 canvas，切走时必须隐藏，否则会盖住 2D 画面
    if (typeof Iso3D !== 'undefined' && Iso3D.setVisible) {
      Iso3D.setVisible(mode === '3d');
    }

    staticDirty = true;
    vignetteCanvas = null;
    fogCanvas = null;
    if (cachedMaze) layout(cachedMaze);
  }

  function getViewMode() { return viewMode; }

  const dprOf = () => Math.min(window.devicePixelRatio || 1, 2);

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d', { alpha: false });
    staticLayer = document.createElement('canvas');
    staticDirty = true;
    resize();
    if (viewMode === 'iso' && typeof Iso !== 'undefined') {
      Iso.init(canvas);
      isoReady = true;
    }
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = dprOf();

    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    staticDirty = true;
    vignetteCanvas = null;
    fogCanvas = null;
  }

  function layout(maze) {
    if (!canvas || !maze) return;
    cachedMaze = maze;

    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    if (viewMode === 'iso' && isoReady) {
      Iso.layout(maze);
      return;
    }
    if (viewMode === '3d' && threeReady) {
      Iso3D.build(maze, null);
      Iso3D.resize();
      return;
    }

    cellSize = Math.max(4, Math.floor(Math.min(W / maze.w, H / maze.h)));

    const mazeW = cellSize * maze.w;
    const mazeH = cellSize * maze.h;
    offsetX = Math.floor((W - mazeW) / 2);
    offsetY = Math.floor((H - mazeH) / 2);

    buildStaticLayer();
    staticDirty = false;
  }

  /**
   * 预渲染迷宫
   * 每块墙三层：侧壁（暗）、顶面（亮）、棱边（更亮）+ 地板投影。
   * 这是让 2D 方块看起来像"立体石墙"的关键手法，成本是一次性预渲染。
   */
  function buildStaticLayer() {
    if (!cachedMaze) return;
    const maze = cachedMaze;
    const dpr = dprOf();
    const rect = canvas.getBoundingClientRect();

    staticLayer.width = Math.floor(rect.width * dpr);
    staticLayer.height = Math.floor(rect.height * dpr);

    const g = staticLayer.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;

    g.fillStyle = PALETTE.bg;
    g.fillRect(0, 0, rect.width, rect.height);

    const cs = cellSize;

    // ---- 地板棋盘格 ----
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (maze.grid[y][x] === 1) continue;
        g.fillStyle = (x + y) % 2 === 0 ? PALETTE.floor : PALETTE.floorAlt;
        g.fillRect(offsetX + x * cs, offsetY + y * cs, cs, cs);
      }
    }

    // ---- 淡网格线 ----
    if (cs >= 10) {
      g.strokeStyle = PALETTE.floorLine;
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= maze.w; x++) {
        g.moveTo(offsetX + x * cs + 0.5, offsetY);
        g.lineTo(offsetX + x * cs + 0.5, offsetY + maze.h * cs);
      }
      for (let y = 0; y <= maze.h; y++) {
        g.moveTo(offsetX, offsetY + y * cs + 0.5);
        g.lineTo(offsetX + maze.w * cs, offsetY + y * cs + 0.5);
      }
      g.stroke();
    }

    // ---- 墙体 ----
    const topH = Math.max(2, cs * 0.30);
    const edgeH = Math.max(1, cs * 0.055);
    const shadowH = Math.max(1, cs * 0.16);

    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (maze.grid[y][x] !== 1) continue;
        const wx = offsetX + x * cs;
        const wy = offsetY + y * cs;

        g.fillStyle = PALETTE.wallSide;
        g.fillRect(wx, wy, cs, cs);

        g.fillStyle = PALETTE.wallTop;
        g.fillRect(wx, wy, cs, topH);

        g.fillStyle = PALETTE.wallEdge;
        g.fillRect(wx, wy + topH, cs, edgeH);

        // 只在墙下方是地板时画投影
        if (y + 1 < maze.h && maze.grid[y + 1][x] === 0) {
          g.fillStyle = PALETTE.wallShadow;
          g.fillRect(wx, wy + cs, cs, shadowH);
        }
      }
    }
  }

  const px = (gx) => offsetX + gx * cellSize;
  const py = (gy) => offsetY + gy * cellSize;
  const cPx = (gx) => offsetX + (gx + 0.5) * cellSize;
  const cPy = (gy) => offsetY + (gy + 0.5) * cellSize;

  // 视口裁切：等距模式下镜头跟随玩家，画布外的东西不用画
  function inView(state, x, y) {
    // 2D 全图可见，无需裁切
    return true;
  }

  function draw(state, dt) {
    if (!ctx || !state.maze) return;

    // ---- 真 3D 分支：交给 iso3d.js ----
    if (viewMode === '3d' && threeReady) {
      if (!Iso3D.draw(state, dt)) {
        // 运行中 WebGL 掉线 → 降级
        viewMode = '2d';
      }
      return;
    }

    // ---- 等距 2.5D 分支：完全交给 iso.js ----
    if (viewMode === 'iso' && isoReady) {
      Iso.draw(state, dt);
      return;
    }

    clock += dt;

    const maze = state.maze;
    const rect = canvas.getBoundingClientRect();
    if (staticDirty) layout(maze);

    const dpr = dprOf();

    // 1. 静态地层
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 2. 出口
    const endVisible = isVisible(state, maze.end.x, maze.end.y);
    if (endVisible) {
      Sprites.drawPortal(ctx, cPx(maze.end.x), cPy(maze.end.y), cellSize, { time: clock });
    } else if (state.explored && state.explored.has(maze.end.x, maze.end.y)) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      Sprites.drawPortal(ctx, cPx(maze.end.x), cPy(maze.end.y), cellSize, { time: clock });
      ctx.restore();
    }

    // 3. 轨迹
    drawTrail(state);

    // 3.5 路径提示（技能）：画在迷雾之下，只照亮沿途格子
    drawHintPath(state, rect);

    // 4. 迷雾
    drawFog(state, rect);

    // 5. 怪物
    drawMonsters(state);

    // 6. 玩家
    drawPlayer(state);

    // 7. 死路提示（红色 ✕ 渐隐 + 外扩圆环）
    drawDeadEndFlash(state);

    // 8. 暗角
    drawVignette(rect);
  }

  /**
   * 路径提示（技能）—— 2D 版
   * ------------------------------------------------------------
   * 绘制顺序很关键：路径画在迷雾**之前**，然后由迷雾层单独为路径格子"挖洞"，
   * 这样效果就等于"提示把这条路照亮了"，而未探索的墙体依旧被雾盖住——
   * 既给出了方向，又保留了迷宫的神秘感（不会一瞬间全图泄露）。
   *
   * 视觉语言：
   *   淡金色通道带 → 沿路径逐格铺一条圆角带子，而不是一条细线，
   *   这样在窄走廊里也够醒目；再叠一层流动的虚线做"前进方向"指示。
   */
  function drawHintPath(state, rect) {
    const path = state.hintPath;
    if (!path || path.length < 2 || !(state.hintT > 0)) return;

    // 出现淡入（前 0.2s）+ 结束淡出（最后 0.8s）
    const elapsed = HINT_DURATION_2D - state.hintT;
    let alpha = Math.min(1, state.hintT / 0.8);
    if (elapsed < 0.2) alpha *= Math.max(0, elapsed) / 0.2;
    alpha = Math.max(0, Math.min(1, alpha));

    const n = path.length;
    const band = cellSize * 0.44;   // 通道带宽度

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    // ---- 外发光：一层宽而淡的金色，让路径在浅色地板上也能浮出来 ----
    ctx.globalAlpha = alpha * 0.30;
    ctx.strokeStyle = '#FFCF6E';
    ctx.lineWidth = band * 1.9;
    strokePath(path);
    ctx.stroke();

    // ---- 主通道带 ----
    ctx.globalAlpha = alpha * 0.52;
    ctx.strokeStyle = '#FFD98A';
    ctx.lineWidth = band;
    strokePath(path);
    ctx.stroke();

    // ---- 中心细亮线（提高硬边清晰度）----
    ctx.globalAlpha = alpha * 0.85;
    ctx.strokeStyle = '#FFF6DC';
    ctx.lineWidth = Math.max(1.5, cellSize * 0.09);
    strokePath(path);
    ctx.stroke();

    // ---- 流动虚线：脉冲沿路径向出口方向跑，指示"往这边走" ----
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = '#C98A2E';
    ctx.lineWidth = Math.max(1.5, cellSize * 0.1);
    ctx.setLineDash([cellSize * 0.22, cellSize * 0.52]);
    ctx.lineDashOffset = -(performance.now() / 26) % 1000;
    strokePath(path);
    ctx.stroke();
    ctx.setLineDash([]);

    // ---- 拐点圆点：每个转弯处点一个小圆，标出"这里要拐" ----
    ctx.globalAlpha = alpha * 0.75;
    ctx.fillStyle = '#C98A2E';
    for (let i = 1; i < n - 1; i++) {
      const prev = path[i - 1], cur = path[i], next = path[i + 1];
      const turn = (cur.x - prev.x) * (next.y - cur.y) - (cur.y - prev.y) * (next.x - cur.x);
      if (turn === 0) continue;   // 直行不标
      ctx.beginPath();
      ctx.arc(cPx(cur.x), cPy(cur.y), Math.max(1.6, cellSize * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- 起点标：一个小圆环，说明"这条路从这算起" ----
    if (state.hintFrom) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.strokeStyle = '#C98A2E';
      ctx.lineWidth = Math.max(1.5, cellSize * 0.08);
      ctx.beginPath();
      ctx.arc(cPx(state.hintFrom.x), cPy(state.hintFrom.y), cellSize * 0.28, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ---- 终点箭头：指向出口的最后一段画一个三角 ----
    const last = path[n - 1];
    const prev = path[n - 2];
    const ang = Math.atan2(cPy(last.y) - cPy(prev.y), cPx(last.x) - cPx(prev.x));
    const tip = cellSize * 0.30;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#FFD166';
    ctx.beginPath();
    ctx.moveTo(cPx(last.x) + Math.cos(ang) * tip, cPy(last.y) + Math.sin(ang) * tip);
    ctx.lineTo(cPx(last.x) + Math.cos(ang + 2.5) * tip, cPy(last.y) + Math.sin(ang + 2.5) * tip);
    ctx.lineTo(cPx(last.x) + Math.cos(ang - 2.5) * tip, cPy(last.y) + Math.sin(ang - 2.5) * tip);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  /** 把格子数组串成一条折线路径（不含 beginPath 之外的额外状态） */
  function strokePath(path) {
    ctx.beginPath();
    ctx.moveTo(cPx(path[0].x), cPy(path[0].y));
    for (let i = 1; i < path.length; i++) ctx.lineTo(cPx(path[i].x), cPy(path[i].y));
  }

  const HINT_FADE_IN = 0.2;
  const HINT_DURATION_2D = 6;   // 与 game.js 的 HINT_DURATION 保持一致

  function isVisible(state, x, y) {
    if (!state.visibleSet) return true;
    return state.visibleSet.has(x + ',' + y);
  }

  function drawTrail(state) {
    if (!state.trail || state.trail.length < 2) return;
    const n = state.trail.length;
    const start = Math.max(0, n - 40);

    ctx.save();
    for (let i = start; i < n - 1; i++) {
      const t = state.trail[i];
      if (!isVisible(state, t.x, t.y)) continue;
      const alpha = Math.max(0, 0.34 * (1 - (n - 1 - i) / 40));
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = PALETTE.trail;
      ctx.beginPath();
      ctx.arc(cPx(t.x), cPy(t.y), cellSize * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }
    const last = state.trail[n - 1];
    if (isVisible(state, last.x, last.y)) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = PALETTE.trailCore;
      ctx.beginPath();
      ctx.arc(cPx(last.x), cPy(last.y), cellSize * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * 迷雾：记忆层 → 纯黑层挖洞 → 贴回
   * 挖洞用 destination-out 合成模式，这样黑洞与可见区之间有渐变，
   * 而不是硬边界。
   */
  function drawFog(state, rect) {
    const maze = state.maze;

    // ---- 记忆层 ----
    if (state.explored) {
      ctx.save();
      ctx.fillStyle = PALETTE.explored;
      for (let y = 0; y < maze.h; y++) {
        for (let x = 0; x < maze.w; x++) {
          if (!state.explored.has(x, y)) continue;
          if (isVisible(state, x, y)) continue;
          ctx.fillRect(px(x), py(y), cellSize + 0.5, cellSize + 0.5);
        }
      }
      ctx.restore();
    }

    // ---- 纯黑 + 挖洞 ----
    const fc = ensureFogCanvas(rect);
    const fctx = fc.getContext('2d');
    const dpr = dprOf();

    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, fc.width, fc.height);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.imageSmoothingEnabled = true;

    fctx.fillStyle = PALETTE.fog;
    fctx.fillRect(0, 0, rect.width, rect.height);

    const pcx = cPx(state.player.renderX);
    const pcy = cPy(state.player.renderY);

    fctx.globalCompositeOperation = 'destination-out';

    // 主光斑
    const R = (state.viewRadius + 1.1) * cellSize;
    const grad = fctx.createRadialGradient(pcx, pcy, 0, pcx, pcy, R);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.55, 'rgba(0,0,0,1)');
    grad.addColorStop(0.78, 'rgba(0,0,0,0.82)');
    grad.addColorStop(0.92, 'rgba(0,0,0,0.34)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    fctx.fillStyle = grad;
    fctx.beginPath();
    fctx.arc(pcx, pcy, R, 0, Math.PI * 2);
    fctx.fill();

    // 逐格擦亮（走廊尽头也照亮，按距离衰减）
    if (state.visibleSet) {
      for (const key of state.visibleSet) {
        const comma = key.indexOf(',');
        const gx = +key.slice(0, comma);
        const gy = +key.slice(comma + 1);
        const d = Math.hypot(gx - state.player.renderX, gy - state.player.renderY);
        const a = Math.max(0, 1 - d / (state.viewRadius + 1.6));
        if (a <= 0.02) continue;

        const cx2 = cPx(gx);
        const cy2 = cPy(gy);
        const r = cellSize * 1.05;
        const g2 = fctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, r);
        g2.addColorStop(0, 'rgba(0,0,0,' + (a * 0.98).toFixed(3) + ')');
        g2.addColorStop(0.7, 'rgba(0,0,0,' + (a * 0.8).toFixed(3) + ')');
        g2.addColorStop(1, 'rgba(0,0,0,0)');
        fctx.fillStyle = g2;
        fctx.beginPath();
        fctx.arc(cx2, cy2, r, 0, Math.PI * 2);
        fctx.fill();
      }
    }

    fctx.globalCompositeOperation = 'source-over';

    // ---- 路径提示：为沿途格子单独挖洞 ----
    // HINT 优先级高于常规视野：即使格子没被"看见"，也要露出一点，
    // 否则 2D 全图模式下路径会被大片雾吃掉，技能等于没效果。
    if (state.hintPath && state.hintT > 0) {
      const path = state.hintPath;
      const fade = Math.min(1, state.hintT / 0.6);   // 结束前淡出
      fctx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < path.length; i++) {
        const c = path[i];
        const cx2 = cPx(c.x);
        const cy2 = cPy(c.y);
        const r = cellSize * 1.15;
        const a = (i === 0 ? 0.9 : 0.62) * fade;
        const g3 = fctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, r);
        g3.addColorStop(0, 'rgba(0,0,0,' + a.toFixed(3) + ')');
        g3.addColorStop(0.62, 'rgba(0,0,0,' + (a * 0.72).toFixed(3) + ')');
        g3.addColorStop(1, 'rgba(0,0,0,0)');
        fctx.fillStyle = g3;
        fctx.beginPath();
        fctx.arc(cx2, cy2, r, 0, Math.PI * 2);
        fctx.fill();
      }
      fctx.globalCompositeOperation = 'source-over';
    }

    // 设备像素 1:1 贴回（不能用 CSS 尺寸，否则高分屏只贴左上角）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(fc, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function ensureFogCanvas(rect) {
    const dpr = dprOf();
    const w = Math.floor(rect.width * dpr);
    const h = Math.floor(rect.height * dpr);
    if (!fogCanvas) fogCanvas = document.createElement('canvas');
    if (fogCanvas.width !== w || fogCanvas.height !== h) {
      fogCanvas.width = w;
      fogCanvas.height = h;
    }
    return fogCanvas;
  }

  function drawPlayer(state) {
    const p = state.player;
    const cx = offsetX + (p.renderX + 0.5) * cellSize;
    const cy = offsetY + (p.renderY + 0.5) * cellSize;

    // 暖色光晕
    const glowR = cellSize * 1.5;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    g.addColorStop(0, 'rgba(255,217,138,0.30)');
    g.addColorStop(0.55, 'rgba(255,183,94,0.10)');
    g.addColorStop(1, 'rgba(255,183,94,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    const walk = state.walkPhase || 0;

    // 隐身中：角色半透明
    const ghost = state.stealthT > 0;

    // 紧张度：怪物越近表情越慌
    let scared = 0;
    if (state.monsters) {
      let minD = Infinity;
      for (const m of state.monsters) {
        const d = Math.hypot(m.renderX - p.renderX, m.renderY - p.renderY);
        if (d < minD) minD = d;
      }
      scared = minD < 3 ? Math.min(1, (3 - minD) / 2.4) : 0;
    }

    if (ghost) ctx.globalAlpha = 0.3;
    Sprites.drawDragon(ctx, cx, cy, cellSize, { dir: p.dir, walk, scared });
    ctx.globalAlpha = 1;
  }

  function drawMonsters(state) {
    if (!state.monsters) return;
    const walk = state.walkPhase || 0;
    for (const m of state.monsters) {
      if (!isVisible(state, Math.round(m.renderX), Math.round(m.renderY))) continue;
      const cx = offsetX + (m.renderX + 0.5) * cellSize;
      const cy = offsetY + (m.renderY + 0.5) * cellSize;
      Sprites.drawMonster(ctx, cx, cy, cellSize, { walk, seed: m.seed });
    }
  }

  /**
   * 死路提示动画
   * ------------------------------------------------------------
   * 玩家刚踩进死胡同时：
   *   - 在格子上画红色 ✕
   *   - 一圈红色光环向外扩散
   *   - 整体随 deadEndFlash 从 1 淡出到 0
   * 为什么用"渐隐"而不是"闪现"：
   *   闪现会打断沉浸感；渐隐像一个"刚刚发现"的轻提示，不突兀。
   */
  function drawDeadEndFlash(state) {
    if (!state.deadEndFlash || !state.deadEndFlashPos) return;
    const t = state.deadEndFlash / 1.4;   // 1 → 0
    const pos = state.deadEndFlashPos;
    const cx = cPx(pos.x);
    const cy = cPy(pos.y);

    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 1.6);

    // 扩散圆环：1 - t 从 0 到 1
    const prog = 1 - t;
    const ringR = cellSize * (0.35 + prog * 1.3);
    ctx.strokeStyle = 'rgba(255,77,109,' + (0.65 * t).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1.5, cellSize * 0.07 * t);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.stroke();

    // 红色 ✕
    const s = cellSize * 0.3;
    ctx.strokeStyle = 'rgba(255,77,109,' + (0.95 * t).toFixed(3) + ')';
    ctx.lineWidth = Math.max(2, cellSize * 0.1);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - s, cy - s);
    ctx.lineTo(cx + s, cy + s);
    ctx.moveTo(cx + s, cy - s);
    ctx.lineTo(cx - s, cy + s);
    ctx.stroke();

    ctx.restore();
  }

  function drawVignette(rect) {
    if (!vignetteCanvas) {
      const dpr = dprOf();
      vignetteCanvas = document.createElement('canvas');
      vignetteCanvas.width = Math.floor(rect.width * dpr);
      vignetteCanvas.height = Math.floor(rect.height * dpr);
      const v = vignetteCanvas.getContext('2d');
      v.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const r = Math.hypot(cx, cy);
      const g = v.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(70,60,45,0.26)');
      v.fillStyle = g;
      v.fillRect(0, 0, rect.width, rect.height);
    }
    const dpr = dprOf();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(vignetteCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function onResize() {
    resize();
    if (viewMode === '3d' && threeReady && typeof Iso3D !== 'undefined') {
      Iso3D.resize();
    }
    if (cachedMaze) layout(cachedMaze);
  }

  return {
    init, draw, layout, onResize, applyTheme,
    setViewMode, getViewMode,
    get PALETTE() { return PALETTE; },
    get cellSize() { return cellSize; },
    get iso() { return (typeof Iso !== 'undefined') ? Iso : null; },
    get three() { return (typeof Iso3D !== 'undefined') ? Iso3D : null; }
  };
})();
