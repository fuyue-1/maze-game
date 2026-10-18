/**
 * iso.js —— 等距 2.5D 投影与渲染层
 * ------------------------------------------------------------
 * 纯数学部分（project / unproject / layoutIso）独立可测，不依赖 DOM；
 * 绘制部分（drawIso）读取与 2D 版完全相同的 state，因此游戏逻辑零改动。
 *
 * 为什么选 2:1 等距（dimetric）：
 *   1. 像素级整数倍率，墙体边缘不糊，低成本高质感
 *   2. 斜 45° 俯视约 30°，能同时看到地面、墙顶、墙的两个立面 → 立刻有体积感
 *   3. 世界坐标 → 屏幕坐标是纯线性变换，深度排序只需按 (x+y) 从小到大画
 *
 * 坐标约定：
 *   世界坐标 (wx, wy) 以"格"为单位，格子左上角为整数点。
 *   屏幕坐标 X = (wx - wy) * TW/2，Y = (wx + wy) * TH/2，TW:TH = 2:1。
 *   墙高 h 沿屏幕 Y 轴负方向抬升（Y -= h）。
 */

const Iso = (function () {
  'use strict';

  // 标准 2:1 等距的宽高比
  const RATIO = 0.5;

  /**
   * 世界坐标 → 屏幕坐标（未含镜头平移）
   * @param {number} wx 世界 X（格）
   * @param {number} wy 世界 Y（格）
   * @param {number} h  离地高度（像素）
   * @param {object} cam { tw, th, ox, oy }
   */
  function project(wx, wy, h, cam) {
    return {
      x: cam.ox + (wx - wy) * (cam.tw / 2),
      y: cam.oy + (wx + wy) * (cam.th / 2) - (h || 0)
    };
  }

  /**
   * 屏幕坐标 → 世界坐标（俯视平面，h = 0）
   * 用于鼠标点击拾取（点小地图/点格子测试）。
   */
  function unproject(sx, sy, cam) {
    const dx = (sx - cam.ox) / (cam.tw / 2);
    const dy = (sy - cam.oy) / (cam.th / 2);
    return { x: (dx + dy) / 2, y: (dy - dx) / 2 };
  }

  /**
   * 计算镜头参数
   * ------------------------------------------------------------
   * 等距投影后迷宫包围盒是菱形：
   *   宽 = (w + h) * tw/2
   *   高 = (w + h) * th/2 + 墙高像素 + 角色高度
   * 支持两种策略：
   *   fit    —— 整图装进画布（小迷宫/桌面宽屏），格子尽量大
   *   follow —— 固定格子尺寸并跟随玩家（大迷宫/手机），保证可读性
   */
  function layoutIso(maze, viewW, viewH, opts) {
    const o = opts || {};
    const wallH = o.wallH || 1.3;
    const padX = o.padX != null ? o.padX : 0.05;
    const padY = o.padY != null ? o.padY : 0.08;
    const minCell = o.minCell || 26;   // 低于这个尺寸就改用跟随模式

    const diag = maze.w + maze.h;

    const twByWidth = (viewW * (1 - padX * 2)) / diag;
    const twByHeight = (viewH * (1 - padY * 2)) / (diag * RATIO / 2 + wallH);
    const fitTw = Math.floor(Math.min(twByWidth, twByHeight));

    let mode = 'fit';
    let tw = fitTw;

    if (fitTw < minCell) {
      // 整图装不下且格子太小 → 跟随模式，格子固定为舒适尺寸
      mode = 'follow';
      tw = Math.max(minCell, Math.min(56, Math.floor(viewW / 9)));
    }

    const th = tw * RATIO;
    const cam = { tw, th, ox: 0, oy: 0, wallH, mode, viewW, viewH };

    if (mode === 'fit') {
      const leftX = project(0, maze.h, 0, cam).x;
      const rightX = project(maze.w, 0, 0, cam).x;
      const topY = project(0, 0, wallH * tw + tw * 0.8, cam).y;
      const botY = project(maze.w, maze.h, 0, cam).y;

      cam.ox = (viewW - (rightX - leftX)) / 2 - leftX;
      cam.oy = (viewH - (botY - topY)) / 2 - topY;
    } else {
      // 跟随模式：把玩家格子放在画面中心略偏下
      cam.ox = 0;
      cam.oy = 0;
      cam.targetOx = 0;
      cam.targetOy = 0;
    }

    cam.cellW = tw;
    cam.cellH = th;
    return cam;
  }

  /**
   * 让镜头平滑跟随玩家（仅 follow 模式生效）
   * 用指数平滑而不是线性插值：帧率无关且不会过冲。
   */
  function followCamera(cam, px, py, dt) {
    if (!cam || cam.mode !== 'follow') return;
    // 玩家在屏幕上的目标位置：水平居中，垂直偏下 8%（留出前方视野）
    const want = project(px + 0.5, py + 0.5, 0, { tw: cam.tw, th: cam.th, ox: 0, oy: 0 });
    const tx = cam.viewW / 2 - want.x;
    const ty = cam.viewH * 0.56 - want.y;

    const k = 1 - Math.pow(0.0015, Math.min(dt, 0.1));  // 平滑系数
    cam.ox += (tx - cam.ox) * k;
    cam.oy += (ty - cam.oy) * k;
  }

  // ==================== 以下为绘制部分（浏览器环境） ====================

  let canvas = null;
  let ctx = null;
  let cam = null;
  let cachedMaze = null;
  let PALETTE = null;
  let clock = 0;

  const dprOf = () => Math.min(window.devicePixelRatio || 1, 2);

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d', { alpha: false });
    resize();
  }

  function resize() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = dprOf();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
  }

  function layout(maze) {
    if (!canvas || !maze) return;
    cachedMaze = maze;
    const rect = canvas.getBoundingClientRect();
    cam = layoutIso(maze, rect.width, rect.height);
  }

  function applyTheme(palette) {
    if (palette) PALETTE = Object.assign({}, PALETTE || {}, palette);
  }

  // ---- 形状辅助 ----

  // 菱形（格子顶面）
  function diamond(g, wx, wy, h, inset) {
    const i = inset || 0;
    const a = project(wx + i, wy + i, h, cam);
    const b = project(wx + 1 - i, wy + i, h, cam);
    const c = project(wx + 1 - i, wy + 1 - i, h, cam);
    const d = project(wx + i, wy + 1 - i, h, cam);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.lineTo(c.x, c.y);
    g.lineTo(d.x, d.y);
    g.closePath();
  }

  // 立方体（墙体）：三个可见面
  function cubeFaces(wx, wy, wh) {
    const H = wh * cam.cellW;
    const top = [
      project(wx, wy, H, cam),
      project(wx + 1, wy, H, cam),
      project(wx + 1, wy + 1, H, cam),
      project(wx, wy + 1, H, cam)
    ];
    // 左前面：朝屏幕左下（y+ 方向的面）
    const left = [
      project(wx, wy + 1, H, cam),
      project(wx + 1, wy + 1, H, cam),
      project(wx + 1, wy + 1, 0, cam),
      project(wx, wy + 1, 0, cam)
    ];
    // 右前面：朝屏幕右下（x+ 方向的面）
    const right = [
      project(wx + 1, wy, H, cam),
      project(wx + 1, wy + 1, H, cam),
      project(wx + 1, wy + 1, 0, cam),
      project(wx + 1, wy, 0, cam)
    ];
    return { top, left, right };
  }

  function fillPoly(g, pts, style) {
    g.fillStyle = style;
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.closePath();
    g.fill();
  }

  function shade(hex, k) {
    // 简单的明暗调整：k < 1 变暗，k > 1 变亮
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * k)));
    const g2 = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * k)));
    const b = Math.max(0, Math.min(255, Math.round((n & 255) * k)));
    return 'rgb(' + r + ',' + g2 + ',' + b + ')';
  }

  function isVisible(state, x, y) {
    if (!state.visibleSet) return true;
    return state.visibleSet.has(x + ',' + y);
  }

  function dim(state, x, y) {
    // 已探索但当前不可见 → 记忆层，压暗
    if (isVisible(state, x, y)) return 1;
    if (state.explored && state.explored.has(x, y)) return 0.42;
    return 0;
  }

  /**
   * 路径提示（技能）—— 2.5D 版
   * ------------------------------------------------------------
   * 等距视角下"一条粗线"会很生硬，所以改成一串沿路径铺设的菱形地砖，
   * 天然贴合斜视地面；再逐格画一条贯穿相邻菱形中心的光带，
   * 让整条路连成一体，视觉上像"地面上亮起一条引路石"。
   *
   * 关键点：这里不做可见性判断。路径本身就是技能给的信息，
   * 因为未探索而画不出来，技能就失去意义了。
   */
  function drawHintPath(state) {
    const path = state.hintPath;
    if (!path || path.length < 2 || !(state.hintT > 0)) return;

    // 出现淡入（前 0.35s）+ 结束淡出（最后 0.7s）
    const elapsed = HINT_DURATION_ISO - state.hintT;
    let alpha = Math.min(1, state.hintT / 0.7);
    if (elapsed < 0.35) alpha *= Math.max(0, elapsed) / 0.35;
    alpha = Math.max(0, Math.min(1, alpha));

    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 420);
    const n = path.length;

    ctx.save();

    // ---- 1. 贯穿相邻中心的光带（先画，菱形压在上面） ----
    ctx.globalAlpha = alpha * (0.42 + pulse * 0.16);
    ctx.strokeStyle = '#FFD98A';
    ctx.lineWidth = Math.max(2, cam.cellW * 0.16);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const c = project(path[i].x + 0.5, path[i].y + 0.5, 1, cam);
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();

    // ---- 2. 逐格菱形地砖 ----
    const inset = 0.24;
    for (let i = 0; i < n; i++) {
      const c = path[i];
      const isStart = i === 0;
      const isEnd = i === n - 1;

      // 越靠近玩家越亮，远端稍弱，形成"路径从脚下延伸出去"的层次
      const near = Math.max(0.55, 1 - i / Math.max(6, n * 1.6));
      ctx.globalAlpha = alpha * near * (isStart ? 0.95 : isEnd ? 0.95 : 0.68);

      diamond(ctx, c.x, c.y, 1.5, inset);
      ctx.fillStyle = isEnd ? '#FFD166' : isStart ? '#FFE9B0' : '#FFD98A';
      ctx.fill();

      ctx.globalAlpha = alpha * near * 0.9;
      ctx.strokeStyle = 'rgba(201,138,46,0.85)';
      ctx.lineWidth = Math.max(1, cam.cellW * 0.035);
      ctx.stroke();
    }

    // ---- 3. 出口端的小箭头：贴在最后一个菱形上，指明"就在这" ----
    const last = path[n - 1];
    const prev = path[n - 2];
    const a = project(last.x + 0.5, last.y + 0.5, 1, cam);
    const b = project(prev.x + 0.5, prev.y + 0.5, 1, cam);
    const ang = Math.atan2(a.y - b.y, a.x - b.x);
    const s = cam.cellW * 0.28;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#B8802A';
    ctx.beginPath();
    ctx.moveTo(a.x + Math.cos(ang) * s, a.y + Math.sin(ang) * s);
    ctx.lineTo(a.x + Math.cos(ang + 2.4) * s, a.y + Math.sin(ang + 2.4) * s);
    ctx.lineTo(a.x + Math.cos(ang - 2.4) * s, a.y + Math.sin(ang - 2.4) * s);
    ctx.closePath();
    ctx.fill();

    // ---- 4. 一层极淡的地面光晕，把整条路"点亮" ----
    ctx.globalAlpha = alpha * 0.14;
    ctx.strokeStyle = '#FFF3D1';
    ctx.lineWidth = Math.max(6, cam.cellW * 0.62);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const c = project(path[i].x + 0.5, path[i].y + 0.5, 0, cam);
      if (i === 0) ctx.moveTo(c.x, c.y);
      else ctx.lineTo(c.x, c.y);
    }
    ctx.stroke();

    ctx.restore();
  }

  const HINT_DURATION_ISO = 6;   // 与 game.js 的 HINT_DURATION 保持一致

  function draw(state, dt) {
    if (!ctx || !state.maze) return;
    if (!cam) layout(state.maze);
    clock += dt;

    const maze = state.maze;
    const rect = canvas.getBoundingClientRect();
    const P = PALETTE || {};

    // 跟随模式：先更新镜头，再做任何投影
    if (cam.mode === 'follow') {
      followCamera(cam, state.player.renderX, state.player.renderY, dt);
    }
    // 视口裁切半径（格），比屏幕对角线大一点就够了
    const cull = Math.ceil((Math.max(rect.width, rect.height) / cam.tw)) + cam.wallH + 3;

    ctx.fillStyle = P.bg || '#d9cfba';
    ctx.fillRect(0, 0, rect.width, rect.height);

    const floorCol = P.floor || '#b8ab90';
    const floorAlt = P.floorAlt || '#c2b69c';
    const wallTop = P.wallTop || '#e8dcc4';
    const wallSide = P.wallSide || '#c4b49a';

    const pcx = state.player.renderX;
    const pcy = state.player.renderY;

    // 路径提示沿途格子的快速查表：即使未探索也给一层淡地板，
    // 否则金色菱形会"悬浮"在迷雾上，缺少地面参照
    const hintSet = (state.hintPath && state.hintT > 0)
      ? new Set(state.hintPath.map((c) => c.x + ',' + c.y))
      : null;

    // ---------- 1. 地面 ----------
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (maze.grid[y][x] === 1) continue;
        if (Math.abs(x - pcx) + Math.abs(y - pcy) > cull) continue;
        let d = dim(state, x, y);
        if (d <= 0 && hintSet && hintSet.has(x + ',' + y)) d = 0.34;
        if (d <= 0) continue;
        ctx.globalAlpha = d;
        diamond(ctx, x, y, 0, 0);
        ctx.fillStyle = (x + y) % 2 === 0 ? floorCol : floorAlt;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    // ---------- 2. 轨迹 ----------
    if (state.trail && state.trail.length) {
      const s = Math.max(0, state.trail.length - 40);
      for (let i = s; i < state.trail.length; i++) {
        const t = state.trail[i];
        const d = dim(state, t.x, t.y);
        if (d <= 0) continue;
        ctx.globalAlpha = d * 0.6;
        diamond(ctx, t.x, t.y, 0, 0.3);
        ctx.fillStyle = P.trailCore || 'rgba(255,217,138,0.55)';
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // ---------- 2.5 路径提示：贴地铺在走廊上 ----------
    // 必须在墙之前画：等距视角下路径是"地面标记"，
    // 若画在墙之后，会像贴在墙面上一样穿帮。
    // 同时不调用 dim()：路径沿途的格子即使还没探索到也要画出来，
    // 否则提示会被"未探索"挡掉大半（这正是玩家抱怨"提示看不到"的原因）。
    drawHintPath(state);

    // ---------- 3. 出口 ----------
    const endD = dim(state, maze.end.x, maze.end.y);
    if (endD > 0) {
      const c = project(maze.end.x + 0.5, maze.end.y + 0.5, 0, cam);
      ctx.save();
      ctx.globalAlpha = endD;
      // 竖直光柱：即使在斜视角下也能一眼锁定出口位置
      const beamH = cam.cellW * 2.6;
      const beamW = cam.cellW * 0.22;
      const beam = ctx.createLinearGradient(c.x, c.y - beamH, c.x, c.y);
      beam.addColorStop(0, 'rgba(56,232,176,0)');
      beam.addColorStop(1, 'rgba(56,232,176,0.5)');
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(c.x - beamW, c.y);
      ctx.lineTo(c.x - beamW * 0.4, c.y - beamH);
      ctx.lineTo(c.x + beamW * 0.4, c.y - beamH);
      ctx.lineTo(c.x + beamW, c.y);
      ctx.closePath();
      ctx.fill();
      Sprites.drawPortal(ctx, c.x, c.y, cam.cellW * 1.15, { time: clock });
      ctx.restore();
    }

    // ---------- 3.5 起点标记（淡青色菱形框） ----------
    if (dim(state, maze.start.x, maze.start.y) > 0) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = 'rgba(120,200,255,0.8)';
      ctx.lineWidth = 1.5;
      diamond(ctx, maze.start.x, maze.start.y, 0, 0.12);
      ctx.stroke();
      ctx.restore();
    }

    // ---------- 4. 墙 + 角色，按 (x+y) 深度排序 ----------
    // 排序规则：等距投影下，(x+y) 越小越靠后（屏幕上越靠上）
    const items = [];
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (maze.grid[y][x] !== 1) continue;
        if (Math.abs(x - pcx) + Math.abs(y - pcy) > cull) continue;
        // 只要紧邻有已探索/可见的格子，这堵墙就要画；
        // 路径提示沿途的墙也画（半透明），否则走廊两侧全空，路径失去"在迷宫里"的感觉
        const near = Math.max(
          dim(state, x, y),
          dim(state, x, y - 1),
          dim(state, x, y + 1),
          dim(state, x - 1, y),
          dim(state, x + 1, y)
        );
        const nearHint = hintSet && (
          hintSet.has(x + ',' + y) ||
          hintSet.has(x + ',' + (y - 1)) ||
          hintSet.has(x + ',' + (y + 1)) ||
          hintSet.has((x - 1) + ',' + y) ||
          hintSet.has((x + 1) + ',' + y)
        ) ? 0.34 : 0;
        const d = Math.max(near, nearHint);
        if (d <= 0) continue;
        items.push({ k: x + y, x, y, type: 'wall', d });
      }
    }

    const p = state.player;
    items.push({ k: Math.round(p.renderX) + Math.round(p.renderY) + 0.5, type: 'player' });

    if (state.monsters) {
      for (const m of state.monsters) {
        if (!isVisible(state, Math.round(m.renderX), Math.round(m.renderY))) continue;
        items.push({ k: Math.round(m.renderX) + Math.round(m.renderY) + 0.5, type: 'monster', m });
      }
    }

    // ---------- 4. 墙 + 角色，按深度排序 ----------
    // 等距投影下 (x+y) 越小越靠后；同一深度墙先画、角色后画
    items.sort((a, b) => (a.k - b.k) || (a.type === 'wall' ? -1 : 1));

    // 玩家格子在等距视角下可能被南/东侧高墙挡住 → 把玩家抬到深度最后
    // 但保留正确遮挡关系：把玩家格子周边 3 格内的墙排在玩家之前绘制
    const pKey = Math.round(p.renderX) + Math.round(p.renderY);
    for (const it of items) {
      if (it.type === 'wall' && Math.abs(it.x - p.renderX) + Math.abs(it.y - p.renderY) <= 2) {
        it.k = Math.min(it.k, pKey - 0.6);   // 近身墙提前画，不挡角色
      }
    }
    items.sort((a, b) => (a.k - b.k) || (a.type === 'wall' ? -1 : 1));

    for (const it of items) {
      if (it.type === 'wall') {
        drawWall(it, wallTop, wallSide);
      } else if (it.type === 'player') {
        drawPlayer(state);
      } else {
        drawMonster(state, it.m);
      }
    }

    // ---------- 5. 死路提示 ----------
    drawDeadEndFlash(state);

    // ---------- 6. 暗角 ----------
    drawVignette(rect);

    // ---------- 7. 头顶迷雾（只压暗未知区域的整体氛围） ----------
    drawAura(state, rect);
  }

  function drawWall(it, wallTop, wallSide) {
    const f = cubeFaces(it.x, it.y, cam.wallH, cam);
    ctx.globalAlpha = it.d;

    // 高对比三面：顶面明显亮、两侧面明显暗，轮廓加浅色描边
    // 让"墙是墙、路是路"一眼可辨
    fillPoly(ctx, f.top, shade(wallTop, 1.35));
    fillPoly(ctx, f.left, shade(wallSide, 0.62));
    fillPoly(ctx, f.right, shade(wallSide, 0.92));

    // 顶面描边：在暗背景上勾出墙体边界，斜视时可读性大幅提升
    ctx.strokeStyle = 'rgba(160,190,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(f.top[0].x, f.top[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(f.top[i].x, f.top[i].y);
    ctx.closePath();
    ctx.stroke();

    ctx.globalAlpha = 1;
  }

  function drawPlayer(state) {
    const p = state.player;
    const c = project(p.renderX + 0.5, p.renderY + 0.5, 0, cam);

    // 玩家轮廓微光：角色被墙挡住时也能看清自己的位置
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = 'rgba(255,217,138,0.55)';
    ctx.lineWidth = 1.5;
    diamond(ctx, p.renderX, p.renderY, 0, 0.08);
    ctx.stroke();
    ctx.restore();

    // 地面投影（椭圆，让角色"站"在地上）
    ctx.save();
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + cam.cellH * 0.06, cam.cellW * 0.26, cam.cellH * 0.26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 暖色光晕
    const glowR = cam.cellW * 0.95;
    const g = ctx.createRadialGradient(c.x, c.y - cam.cellW * 0.3, 0, c.x, c.y - cam.cellW * 0.3, glowR);
    g.addColorStop(0, 'rgba(255,238,200,0.42)');
    g.addColorStop(1, 'rgba(255,183,94,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c.x, c.y - cam.cellW * 0.3, glowR, 0, Math.PI * 2);
    ctx.fill();

    let scared = 0;
    if (state.monsters) {
      let minD = Infinity;
      for (const m of state.monsters) {
        const d = Math.hypot(m.renderX - p.renderX, m.renderY - p.renderY);
        if (d < minD) minD = d;
      }
      scared = minD < 3 ? Math.min(1, (3 - minD) / 2.4) : 0;
    }

    // 角色按 2:1 压扁一点，符合俯视透视
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(1, 0.92);
    if (state.stealthT > 0) ctx.globalAlpha = 0.3;   // 隐身中半透明
    Sprites.drawDragon(ctx, 0, -cam.cellW * 0.42, cam.cellW * 0.78, {
      dir: p.dir, walk: state.walkPhase || 0, scared
    });
    ctx.restore();
  }

  function drawMonster(state, m) {
    const c = project(m.renderX + 0.5, m.renderY + 0.5, 0, cam);
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + cam.cellH * 0.05, cam.cellW * 0.2, cam.cellH * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.scale(1, 0.92);
    Sprites.drawMonster(ctx, 0, -cam.cellW * 0.36, cam.cellW * 0.7, {
      walk: state.walkPhase || 0, seed: m.seed
    });
    ctx.restore();
  }

  function drawDeadEndFlash(state) {
    if (!state.deadEndFlash || !state.deadEndFlashPos) return;
    const t = state.deadEndFlash / 1.4;
    const pos = state.deadEndFlashPos;
    const c = project(pos.x + 0.5, pos.y + 0.5, cam.cellW * 0.05, cam);

    ctx.save();
    ctx.globalAlpha = Math.min(1, t * 1.6);

    const prog = 1 - t;
    const rx = cam.cellW * (0.4 + prog * 1.1);
    // 椭圆环，贴合等距地面
    ctx.strokeStyle = 'rgba(255,77,109,' + (0.62 * t).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1.5, cam.cellW * 0.05 * t);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, rx, rx * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();

    const s = cam.cellW * 0.24;
    ctx.strokeStyle = 'rgba(255,77,109,' + (0.95 * t).toFixed(3) + ')';
    ctx.lineWidth = Math.max(2, cam.cellW * 0.075);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(c.x - s, c.y - s * 0.6);
    ctx.lineTo(c.x + s, c.y + s * 0.6);
    ctx.moveTo(c.x + s, c.y - s * 0.6);
    ctx.lineTo(c.x - s, c.y + s * 0.6);
    ctx.stroke();

    ctx.restore();
  }

  function drawVignette(rect) {
    if (!vignetteCanvas) {
      vignetteCanvas = document.createElement('canvas');
      const dpr = dprOf();
      vignetteCanvas.width = Math.floor(rect.width * dpr);
      vignetteCanvas.height = Math.floor(rect.height * dpr);
      const v = vignetteCanvas.getContext('2d');
      v.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const r = Math.hypot(cx, cy);
      const g = v.createRadialGradient(cx, cy, r * 0.42, cx, cy, r);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(90,78,58,0.24)');
      v.fillStyle = g;
      v.fillRect(0, 0, rect.width, rect.height);
    }
    const dpr = dprOf();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(vignetteCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  let vignetteCanvas = null;

  /**
   * 光环迷雾：以玩家为中心压暗远处
   * 2.5D 不再需要逐格擦洞（地面/墙已经按可见性 alpha 处理），
   * 只用一层径向渐变收拢注意力，成本极低。
   */
  function drawAura(state, rect) {
    if (!auraCanvas) auraCanvas = document.createElement('canvas');
    const dpr = dprOf();
    const w = Math.floor(rect.width * dpr);
    const h = Math.floor(rect.height * dpr);
    if (auraCanvas.width !== w || auraCanvas.height !== h) {
      auraCanvas.width = w;
      auraCanvas.height = h;
    }
    const a = auraCanvas.getContext('2d');
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.clearRect(0, 0, w, h);
    a.setTransform(dpr, 0, 0, dpr, 0, 0);

    const c = project(state.player.renderX + 0.5, state.player.renderY + 0.5, 0, cam);
    const R = (state.viewRadius + 2.2) * cam.cellW;
    const g = a.createRadialGradient(c.x, c.y, R * 0.45, c.x, c.y, R);
    g.addColorStop(0, 'rgba(120,105,80,0)');
    g.addColorStop(0.7, 'rgba(120,105,80,0.10)');
    g.addColorStop(1, 'rgba(120,105,80,0.22)');
    a.fillStyle = g;
    a.fillRect(0, 0, rect.width, rect.height);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(auraCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  let auraCanvas = null;

  function onResize() {
    resize();
    if (cachedMaze) layout(cachedMaze);
  }

  return {
    RATIO, project, unproject, layoutIso,
    init, draw, layout, onResize, applyTheme,
    get cam() { return cam; }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { project: Iso.project, unproject: Iso.unproject, layoutIso: Iso.layoutIso, RATIO: Iso.RATIO };
}
