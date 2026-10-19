/**
 * game.js —— 游戏主逻辑（状态机 / 循环 / 输入 / 怪物 AI）
 * ------------------------------------------------------------
 * 状态机：
 *   idle ──开始──> playing ──到达出口──> win
 *                     │
 *                     └──被怪物抓到──> lose
 *   pause 可从 playing 进入（ESC）
 *
 * 主循环：
 *   requestAnimationFrame + 固定时间步长的"逻辑更新"，渲染每帧一次。
 *   为什么区分逻辑更新和渲染：
 *     怪物移动速度用 格/秒 表示，若直接按帧累加，120Hz 屏幕上怪物会快一倍。
 *     用 dt（真实帧间隔，秒）驱动，无论多少帧率速度都一致。
 */

const Game = (function () {
  'use strict';

  // ==================== 难度配置 ====================
  const DIFFICULTY = {
    easy: {
      key: 'easy',
      label: '简易',
      cols: 11,
      rows: 11,
      monsters: 1,
      monsterSpeed: 1.6,   // 格/秒
      viewRadius: 6.5,
      // name 会写进排行榜的 size 字段，必须与界面文案、以及 Bmob 表里
      // 已有的历史数据保持一致（表里现存记录用的是"简单"），
      // 否则筛选"简易"会把旧成绩全部筛掉
      name: '简单'
    },
    normal: {
      key: 'normal',
      label: '中等',
      cols: 17,
      rows: 17,
      monsters: 2,
      monsterSpeed: 2.2,
      viewRadius: 5.5,
      name: '中等'
    },
    hard: {
      key: 'hard',
      label: '困难',
      cols: 25,
      rows: 25,
      monsters: 3,
      monsterSpeed: 2.9,
      viewRadius: 4.5,
      name: '困难'
    }
  };

  // ==================== 状态 ====================
  let state = {
    phase: 'idle',          // idle | playing | win | lose | paused
    maze: null,
    difficulty: DIFFICULTY.normal,
    player: { x: 1, y: 1, renderX: 1, renderY: 1, dir: { x: 1, y: 0 }, moveT: 0, fromX: 1, fromY: 1 },
    monsters: [],
    explored: null,
    visibleSet: null,
    viewRadius: 5.5,
    trail: [],
    // 步态相位：玩家每走一格 +1，渲染层用 sin(walkPhase*2π) 做身体摆动
    walkPhase: 0,
    // 已发现的死路（小地图红叉标记）
    foundDeadEnds: new Set(),
    // 全图死路索引（开局扫描一次）
    allDeadEnds: new Set(),
    // 刚踩到新死路时的高亮效果（剩余时间，秒）
    deadEndFlash: 0,
    deadEndFlashPos: null,
    startTime: 0,
    elapsed: 0,
    moves: 0,
    pausedAt: 0,
    // ---- 隐身技能 ----
    // stealthT > 0：隐身剩余秒数（怪物看不见你）
    // stealthCd > 0：冷却剩余秒数（20s 一轮）
    stealthT: 0,
    stealthCd: 0,
    stealthReadyShown: false,
    // ---- 路径提示技能（仅 2D / 2.5D 可见） ----
    // hintT > 0：路径高亮剩余秒数
    // hintCd > 0：冷却剩余秒数（30s 一轮）
    // hintPath：从"按下技能那一刻的所在格"到出口的完整最短路
    // hintFrom：起点格（用于在旧路径上标出"你的出发点"）
    hintT: 0,
    hintCd: 0,
    hintPath: null,
    hintFrom: null,
    hintReadyShown: false
  };

  // 输入缓冲：记录方向键按住状态
  const keys = { up: false, down: false, left: false, right: false };
  let lastFrame = 0;
  let rafId = 0;

  // 玩家移动动画参数
  const PLAYER_MOVE_DURATION = 0.11; // 秒 / 格

  // 回调
  let callbacks = {
    onWin: null,
    onLose: null,
    onTick: null,
    onStateChange: null,
    // 踩到新死路时触发（用于 UI 提示）
    onDeadEnd: null,
    // 路径提示：onHint 成功触发 / onHintReady 冷却结束 / onHintBlocked 冷却中被点
    onHint: null,
    onHintReady: null,
    onHintBlocked: null
  };

  // ==================== 初始化 ====================

  function init(canvasEl, opts = {}) {
    callbacks = Object.assign(callbacks, opts);
    Renderer.init(canvasEl);
    window.addEventListener('resize', () => Renderer.onResize());
    bindInput();
  }

  /** 切换视角：'iso'（等距 2.5D，默认）或 '2d'（俯视） */
  function setViewMode(mode) {
    Renderer.setViewMode(mode);
    if (state.maze) Renderer.layout(state.maze);
  }

  function getViewMode() {
    return Renderer.getViewMode();
  }

  function setDifficulty(key) {
    if (DIFFICULTY[key]) state.difficulty = DIFFICULTY[key];
  }

  // ==================== 开局 ====================

  function start(difficultyKey) {
    if (difficultyKey) setDifficulty(difficultyKey);
    const cfg = state.difficulty;

    const maze = generateMaze(cfg.cols, cfg.rows);
    const explored = new ExploredMap(maze.w, maze.h);

    state.maze = maze;
    state.phase = 'playing';
    state.player = {
      x: maze.start.x, y: maze.start.y,
      renderX: maze.start.x, renderY: maze.start.y,
      dir: { x: 1, y: 0 },
      moveT: 0, fromX: maze.start.x, fromY: maze.start.y
    };
    state.explored = explored;
    state.viewRadius = cfg.viewRadius;
    state.trail = [{ x: maze.start.x, y: maze.start.y }];
    state.startTime = performance.now();
    state.elapsed = 0;
    state.moves = 0;

    // 死路索引：开局全图扫描一次（O(W×H)，几毫秒），
    // 后续只在玩家踩到死路时查表，不做重复计算
    state.allDeadEnds = Helpers.scanDeadEnds(maze.grid);
    state.foundDeadEnds = new Set();
    state.deadEndFlash = 0;
    // 隐身技能开局重置为可用
    state.stealthT = 0;
    state.stealthCd = 0;
    state.stealthReadyShown = false;
    // 路径提示技能同样重置
    state.hintT = 0;
    state.hintCd = 0;
    state.hintPath = null;
    state.hintFrom = null;
    state.hintReadyShown = false;
    state.deadEndFlashPos = null;

    // 生成怪物：放在离玩家足够远的随机通路格上
    state.monsters = spawnMonsters(maze, cfg.monsters, cfg.monsterSpeed);

    // 初始视野
    updateVisibility();

    Renderer.layout(maze);
    lastFrame = performance.now();

    if (!rafId) loop(lastFrame);
    notifyState();
  }

  /**
   * 生成怪物
   * 距离约束：与玩家的 BFS 距离不小于迷宫周长的 40%，
   * 避免开局怪物就在眼前，玩家没有反应时间。
   */
  function spawnMonsters(maze, count, speed) {
    const openCells = [];
    for (let y = 1; y < maze.h - 1; y++) {
      for (let x = 1; x < maze.w - 1; x++) {
        if (maze.grid[y][x] === 0) openCells.push({ x, y });
      }
    }

    const minDist = Math.floor((maze.cols + maze.rows) * 0.35);
    const result = [];
    let guard = 0;

    while (result.length < count && guard++ < 500) {
      const c = openCells[Math.floor(Math.random() * openCells.length)];
      if (c.x === maze.start.x && c.y === maze.start.y) continue;
      if (c.x === maze.end.x && c.y === maze.end.y) continue;
      const d = bfsPath(maze.grid, maze.start, c);
      if (d.length === 0 || d.length < minDist) continue;
      if (result.some((m) => m.x === c.x && m.y === c.y)) continue;

      result.push({
        x: c.x, y: c.y,
        renderX: c.x, renderY: c.y,
        fromX: c.x, fromY: c.y,
        moveT: 0,
        speed: speed * (0.92 + Math.random() * 0.16), // 轻微速度差异，避免同步
        seed: Math.random() * 6.28,
        path: [],
        repathTimer: 0,
        // ---- 感知状态 ----
        // 'idle'    ：没发现玩家，在原地/附近游荡
        // 'chase'   ：看得见玩家，直扑真实位置
        // 'search'  ：刚丢失视线，去"最后看到玩家的位置"找
        mood: 'idle',
        lastKnown: null,      // 最后一次看见玩家的格子
        searchTimer: 0,       // 到达最后已知位置后还剩多少搜索时间
        wanderGoal: null      // 游荡目标格
      });
    }

    // 极端情况（小迷宫放不下）兜底：放到最远的可走格
    if (result.length === 0) {
      let best = null, bestD = -1;
      for (const c of openCells) {
        const d = bfsPath(maze.grid, maze.start, c).length;
        if (d > bestD) { bestD = d; best = c; }
      }
      if (best) {
        result.push({
          x: best.x, y: best.y, renderX: best.x, renderY: best.y,
          fromX: best.x, fromY: best.y, moveT: 0,
          speed, seed: 0, path: [], repathTimer: 0,
          mood: 'idle', lastKnown: null, searchTimer: 0, wanderGoal: null
        });
      }
    }
    return result;
  }

  // ==================== 输入 ====================

  function bindInput() {
    const keyMap = {
      ArrowUp: 'up', KeyW: 'up', w: 'up', W: 'up',
      ArrowDown: 'down', KeyS: 'down', s: 'down', S: 'down',
      ArrowLeft: 'left', KeyA: 'left', a: 'left', A: 'left',
      ArrowRight: 'right', KeyD: 'right', d: 'right', D: 'right'
    };

    // 输入框聚焦时（比如填昵称），方向键应该移动光标而不是操控角色
    function isTyping() {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    }

    window.addEventListener('keydown', (e) => {
      if (isTyping()) return;

      // 空格 / ESC 处理
      if (e.code === 'Escape') {
        if (state.phase === 'playing') pause();
        else if (state.phase === 'paused') resume();
        e.preventDefault();
        return;
      }

      // 空格触发隐身
      if (e.code === 'Space') {
        e.preventDefault();
        activateStealth();
        return;
      }

      // Q / Tab 触发路径提示（Tab 太容易误触浏览器焦点，只留 Q 与 H）
      if (e.code === 'KeyQ' || e.code === 'KeyH') {
        e.preventDefault();
        if (state.phase === 'playing') {
          const r = revealPath();
          if (!r.ok && r.reason === 'cooldown' && callbacks.onHintBlocked) {
            callbacks.onHintBlocked(state.hintCd);
          }
        }
        return;
      }

      const dir = keyMap[e.key] || keyMap[e.code];
      if (!dir) return;

      // 防止方向键滚动页面
      e.preventDefault();

      if (state.phase === 'playing') {
        keys[dir] = true;
        // 按下即响应，不等下一帧，手感更跟手
        tryStepByKey(dir);
      }
    });

    window.addEventListener('keyup', (e) => {
      const dir = keyMap[e.key] || keyMap[e.code];
      if (dir) keys[dir] = false;
    });

    // 失焦时清空按键，避免"黏键"
    window.addEventListener('blur', () => {
      keys.up = keys.down = keys.left = keys.right = false;
    });

    // 触摸/滑动支持（移动端可玩）
    // 注意：绑在 document 上而不是 #game-canvas ——
    // 3D 视角有独立的 .gfx3d-layer 叠在主画布上方（z-index:2），
    // 绑画布的话所有触摸都会被 3D 层截走，手机上 3D 就"滑不动"了。
    // 因此统一在 document 收手势，但排除按钮/弹窗等 UI 区域。
    let touchStart = null;
    const isUITouch = (target) =>
      target && target.closest &&
      target.closest('.dpad, .star-fab, .hud, .topbar, button, .btn, .modal, .overlay, input, .minimap-wrap, a');

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { touchStart = null; return; }  // 多指不管
      const t = e.changedTouches[0];
      if (isUITouch(e.target)) { touchStart = null; return; }
      touchStart = { x: t.clientX, y: t.clientY };
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      if (!touchStart) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;

      if (Math.abs(dx) > Math.abs(dy)) {
        state.player.dir = { x: dx > 0 ? 1 : -1, y: 0 };
        tryMove(dx > 0 ? 1 : -1, 0);
      } else {
        state.player.dir = { x: 0, y: dy > 0 ? 1 : -1 };
        tryMove(0, dy > 0 ? 1 : -1);
      }
    }, { passive: true });
    // 手指滑出屏幕外也要复位
    document.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });
  }

  const KEY_DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  function tryStepByKey(dirName) {
    const d = KEY_DIRS[dirName];
    state.player.dir = { x: d.x, y: d.y };
    tryMove(d.x, d.y);
  }

  /**
   * 尝试移动一格
   * @returns {boolean} 是否移动成功
   */
  function tryMove(dx, dy) {
    if (state.phase !== 'playing') return false;
    const p = state.player;
    const nx = p.x + dx;
    const ny = p.y + dy;
    const maze = state.maze;

    // 边界与墙碰撞
    if (nx < 0 || nx >= maze.w || ny < 0 || ny >= maze.h) return false;
    if (maze.grid[ny][nx] === 1) return false;

    // 记录移动起点，用于渲染插值
    p.fromX = p.x;
    p.fromY = p.y;
    p.x = nx;
    p.y = ny;
    p.moveT = 0;
    state.moves++;

    // 记录轨迹（去重：同一格不重复记录）
    const lastT = state.trail[state.trail.length - 1];
    if (!lastT || lastT.x !== nx || lastT.y !== ny) {
      state.trail.push({ x: nx, y: ny });
    }

    // ---- 死路检测 ----
    // 判定：站在新格子时，除"来路"外没有其它出口 → 走进死胡同
    // 命中后标记到 foundDeadEnds，小地图画红叉，主画面闪一下提示
    const prevPos = { x: p.fromX, y: p.fromY };
    if (Helpers.isDeadEndAt(maze.grid, { x: nx, y: ny }, prevPos)) {
      const key = nx + ',' + ny;
      if (!state.foundDeadEnds.has(key)) {
        state.foundDeadEnds.add(key);
        state.deadEndFlash = 1.4;              // 高亮 1.4 秒
        state.deadEndFlashPos = { x: nx, y: ny };
        if (callbacks.onDeadEnd) callbacks.onDeadEnd({ x: nx, y: ny });
      }
    }

    updateVisibility();
    checkWin();
    return true;
  }

  // ==================== 视野 ====================

  function updateVisibility() {
    const maze = state.maze;
    const p = state.player;
    const R = state.viewRadius;

    const reachable = bfsReachable(maze.grid, { x: p.x, y: p.y }, Math.ceil(R) + 1);
    const fov = computeFOV(maze.grid, { x: p.x, y: p.y }, R, reachable);

    state.visibleSet = fov.visible;
    if (state.explored) {
      state.explored.markAll(fov.visible);
    }
  }

  // ==================== 胜负判定 ====================

  function checkWin() {
    const p = state.player;
    const e = state.maze.end;
    if (p.x === e.x && p.y === e.y) {
      state.phase = 'win';
      clearSkills();      // 结算画面不该还留着隐身/路径高亮
      const seconds = state.elapsed;
      if (callbacks.onWin) {
        callbacks.onWin({
          time: Math.round(seconds * 100) / 100,
          difficulty: state.difficulty.name,
          difficultyKey: state.difficulty.key,
          moves: state.moves
        });
      }
      notifyState();
    }
  }

  function checkLose(monster) {
    if (state.phase !== 'playing') return;
    state.phase = 'lose';
    clearSkills();      // 同上：失败画面保留路径高亮会很突兀
    if (callbacks.onLose) {
      callbacks.onLose({
        time: Math.round(state.elapsed * 100) / 100,
        difficulty: state.difficulty.name,
        difficultyKey: state.difficulty.key,
        moves: state.moves
      });
    }
    notifyState();
  }

  function notifyState() {
    if (callbacks.onStateChange) callbacks.onStateChange(state.phase);
  }

  /**
   * 清空两个技能的生效状态
   * 只在胜负结算时调用：倒计时不重置（否则下一局会白送一次冷却），
   * 但画面上的高亮必须立刻消失，否则结算面板背后还拖着一条金线。
   */
  function clearSkills() {
    state.hintT = 0;
    state.hintPath = null;
    state.hintFrom = null;
    state.stealthT = 0;
  }

  // ==================== 暂停 / 继续 ====================

  function pause() {
    if (state.phase !== 'playing') return;
    state.phase = 'paused';
    state.pausedAt = performance.now();
    notifyState();
  }

  function resume() {
    if (state.phase !== 'paused') return;
    // 补偿暂停期间的时间，避免通关计时把暂停时长算进去
    state.startTime += performance.now() - state.pausedAt;
    state.phase = 'playing';
    lastFrame = performance.now();
    notifyState();
  }

  function togglePause() {
    if (state.phase === 'playing') pause();
    else if (state.phase === 'paused') resume();
  }

  // ==================== 主循环 ====================

  function loop(now) {
    rafId = requestAnimationFrame(loop);

    let dt = (now - lastFrame) / 1000;
    lastFrame = now;

    // 标签页切回来时 dt 可能很大，钳制避免怪物瞬移
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;

    if (state.phase === 'playing') {
      state.elapsed = (now - state.startTime) / 1000;
      updatePlayerAnim(dt);
      updateMonsters(dt);
      updateStealth(dt);
      updateHint(dt);
      checkMonsterCollision();
      if (callbacks.onTick) callbacks.onTick(state.elapsed, state.moves);
    } else {
      // 非游戏中也要推进插值，避免角色卡在半格
      updatePlayerAnim(dt);
    }

    // 死路高亮衰减（与暂停无关，始终走）
    if (state.deadEndFlash > 0) {
      state.deadEndFlash = Math.max(0, state.deadEndFlash - dt);
      if (state.deadEndFlash === 0) state.deadEndFlashPos = null;
    }

    Renderer.draw(state, dt);
    if (Minimap) Minimap.draw(state);
  }

  /** 玩家移动插值：让格子间的移动看起来是滑动的 */
  function updatePlayerAnim(dt) {
    const p = state.player;
    if (p.moveT < 1) {
      p.moveT = Math.min(1, p.moveT + dt / PLAYER_MOVE_DURATION);
      const t = easeOutQuad(p.moveT);
      p.renderX = p.fromX + (p.x - p.fromX) * t;
      p.renderY = p.fromY + (p.y - p.fromY) * t;
      // 步态：移动过程中持续推进，停下后缓慢归位
      state.walkPhase = (state.walkPhase + dt * 5.2) % 1;
    } else {
      p.renderX = p.x;
      p.renderY = p.y;
    }
  }

  const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

  /**
   * 怪物 AI 更新
   * ------------------------------------------------------------
   * 算法：每帧对每个怪物做一次 BFS，得到从怪物到玩家的最短路径，
   * 然后沿路径走下一步。
   *
   * 为什么不用 A*：
   *   完美迷宫没有环，任意两点间只有一条路径，BFS 与 A* 结果完全一致。
   *   地图最大 51x51=2601 格，BFS 单次 < 0.1ms，3 只怪物每帧 0.3ms，
   *   远低于 16.7ms 的帧预算。A* 的优先队列与启发式维护反而增加复杂度。
   *
   * 优化：repathTimer
   *   怪物每 0.25 秒重算一次路径（而不是每帧），并把路径缓存下来逐步消费。
   *   这样 3 只怪物的 BFS 从 180 次/秒 降到 12 次/秒。
   */
  /** 怪物感知参数：不同难度给不同"视力" */
  const SENSE = {
    easy:   { range: 4.5, memory: 2.2 },   // 记忆 2.2 秒后彻底忘记
    normal: { range: 6.0, memory: 3.0 },
    hard:   { range: 8.0, memory: 4.0 }
  };

  function senseCfg() {
    return SENSE[state.difficulty.key] || SENSE.normal;
  }

  // ==================== 隐身技能 ====================

  const STEALTH_DURATION = 5;   // 隐身持续 5 秒
  const STEALTH_COOLDOWN = 20;  // 冷却 20 秒

  /** 触发隐身：冷却中或已在隐身时返回 false */
  function activateStealth() {
    if (state.phase !== 'playing') return false;
    if (state.stealthT > 0 || state.stealthCd > 0) return false;

    state.stealthT = STEALTH_DURATION;
    state.stealthCd = STEALTH_COOLDOWN;
    state.stealthReadyShown = false;

    // 隐身瞬间所有正在追击的怪物立刻失明 → 转入搜索
    for (const m of state.monsters) {
      if (m.mood === 'chase') m.mood = 'search';
    }

    if (callbacks.onStealth) callbacks.onStealth(true);
    return true;
  }

  /** 每帧推进隐身计时 */
  function updateStealth(dt) {
    if (state.stealthT > 0) {
      state.stealthT -= dt;
      if (state.stealthT <= 0) {
        state.stealthT = 0;
        if (callbacks.onStealth) callbacks.onStealth(false);  // 隐身结束
      }
    }
    if (state.stealthCd > 0) {
      state.stealthCd -= dt;
      if (state.stealthCd <= 0) {
        state.stealthCd = 0;
        // 冷却转好只提示一次
        if (!state.stealthReadyShown) {
          state.stealthReadyShown = true;
          if (callbacks.onStealthReady) callbacks.onStealthReady();
        }
      }
    }
  }

  /** 供 UI 查询：{ active, remain, cd } */
  function stealthInfo() {
    return {
      active: state.stealthT > 0,
      remain: Math.ceil(state.stealthT),
      cd: Math.ceil(state.stealthCd),
      ready: state.stealthT <= 0 && state.stealthCd <= 0
    };
  }

  // ==================== 路径提示技能 ====================

  const HINT_DURATION = 6;    // 路径高亮 6 秒
  const HINT_COOLDOWN = 30;   // 冷却 30 秒
  // 冷却判定容差：小于这个值就当作已经冷却完毕。
  // 否则会出现"按钮显示 Q（就绪），按下去却报冷却中"的矛盾。
  const HINT_CD_EPS = 0.05;

  /**
   * 路径提示是否在当前视角可用
   * ------------------------------------------------------------
   * 只在 2D 俯视 和 2.5D 等距 下开放：
   *   2D  ：全图平铺，整条路径能一次看全，信息价值最高
   *   2.5D：斜视立体，路径贴地绘制，能看清"往哪个方向拐"
   *   3D  ：视角离地只有一点点，远处路径会被墙完全挡住，
   *         给了也没用，反而让玩家以为"技能坏了" —— 所以直接禁用
   */
  function hintViewAllowed(mode) {
    const v = mode || getViewMode();
    return v === '2d' || v === 'iso';
  }

  /**
   * 触发路径提示
   * ------------------------------------------------------------
   * 复用 bfsPath：完美迷宫（生成树）从任意格到出口只有唯一一条简单路径，
   * 所以 BFS 求出的就是唯一解，不存在"另一条更短的"。
   * 路径在触发瞬间算一次并缓存，之后玩家走动不重算 ——
   *   "提示的是按下那一刻的路"在语义上更清晰，成本也最低（一次 BFS < 0.1ms）。
   * @returns {{ok:boolean, reason?:string}}
   */
  function revealPath() {
    if (state.phase !== 'playing') return { ok: false, reason: 'idle' };
    if (!hintViewAllowed()) return { ok: false, reason: 'view' };
    if (state.hintT > 0 || state.hintCd > HINT_CD_EPS) return { ok: false, reason: 'cooldown' };

    const p = state.player;
    const path = bfsPath(state.maze.grid, { x: p.x, y: p.y }, state.maze.end);
    if (!path || path.length === 0) return { ok: false, reason: 'nopath' };

    state.hintPath = path;
    state.hintFrom = { x: p.x, y: p.y };
    state.hintT = HINT_DURATION;
    state.hintCd = HINT_COOLDOWN;
    state.hintReadyShown = false;

    if (callbacks.onHint) callbacks.onHint({ steps: Math.max(0, path.length - 1) });
    return { ok: true, steps: path.length - 1 };
  }

  /** 每帧推进路径提示计时 */
  function updateHint(dt) {
    if (state.hintT > 0) {
      state.hintT -= dt;
      if (state.hintT <= 0) {
        state.hintT = 0;
        state.hintPath = null;
        state.hintFrom = null;
      }
    }
    if (state.hintCd > 0) {
      state.hintCd -= dt;
      if (state.hintCd <= 0) {
        state.hintCd = 0;
        if (!state.hintReadyShown) {
          state.hintReadyShown = true;
          if (callbacks.onHintReady) callbacks.onHintReady();
        }
      }
    }
  }

  /**
   * 供 UI 查询：{ active, remain, cd, ready, allowed, steps }
   * allowed 反了当前视角是否支持，按钮据此显示为禁用态+提示
   * 注意 cd 用 Math.ceil：冷却剩 0.2 秒时显示 1s，比显示 0s（却还不能用）更符合直觉。
   * 剩余不足 0.05 秒就视为 0，避免出现"显示 0s 但点了没反应"。
   */
  function hintInfo() {
    return {
      active: state.hintT > 0,
      remain: Math.ceil(state.hintT),
      cd: state.hintCd > 0.05 ? Math.ceil(state.hintCd) : 0,
      ready: state.hintT <= 0 && state.hintCd <= 0,
      allowed: hintViewAllowed(),
      steps: state.hintPath ? Math.max(0, state.hintPath.length - 1) : 0
    };
  }

  /**
   * 怪物能否看见玩家
   * 两个条件同时满足才算看见：
   *   1. 直线距离在视力范围内（欧氏距离，不是 BFS 距离）
   *   2. 视线没被墙挡住（复用 los.js 的 Bresenham 通视检测）
   * 这就是"躲到拐角后面怪物就看不见你"的实现基础。
   */
  function canSeePlayer(m, p) {
    // 隐身期间：无论多近、视线多通畅，怪物一律看不见
    if (state.stealthT > 0) return false;
    const cfg = senseCfg();
    const dx = p.x - m.x;
    const dy = p.y - m.y;
    if (dx * dx + dy * dy > cfg.range * cfg.range) return false;
    return hasLineOfSight(state.maze.grid, m.x, m.y, p.x, p.y);
  }

  /** 在怪物周围找一个随机可达格当游荡目标 */
  function pickWanderGoal(m, maze) {
    for (let i = 0; i < 24; i++) {
      const x = m.x + Math.round((Math.random() - 0.5) * 12);
      const y = m.y + Math.round((Math.random() - 0.5) * 12);
      if (x < 1 || x >= maze.w - 1 || y < 1 || y >= maze.h - 1) continue;
      if (maze.grid[y][x] !== 0) continue;
      return { x, y };
    }
    return null;
  }

  /**
   * 怪物 AI
   * ------------------------------------------------------------
   * 有限状态机，三态：
   *   chase  看见玩家 → 每 0.25s 重算到玩家真实位置的最短路
   *   search 丢失视线 → 去"最后看见玩家的格子"；到了原地找一会儿
   *   idle   从没发现或彻底忘记 → 在附近随机游荡
   *
   * 为什么加这套感知：
   *   原来是全图 BFS 直达玩家，等于开挂，玩家躲到拐角毫无意义。
   *   改成视线驱动后，"绕拐角摆脱追击"成为真实可行的策略。
   */
  function updateMonsters(dt) {
    const maze = state.maze;
    const p = state.player;
    const cfg = senseCfg();

    for (const m of state.monsters) {
      // ---------- 1. 感知更新 ----------
      const sees = canSeePlayer(m, p);
      if (sees) {
        m.mood = 'chase';
        m.lastKnown = { x: p.x, y: p.y };
        m.searchTimer = cfg.memory;   // 每次看见都重置记忆
      } else if (m.mood === 'chase') {
        // 刚丢失视线：记忆还在，转为搜索最后已知位置
        m.mood = 'search';
      }

      // ---------- 2. 决定目标 ----------
      let goal = null;
      if (m.mood === 'chase') {
        goal = { x: p.x, y: p.y };
      } else if (m.mood === 'search') {
        m.searchTimer -= dt;
        const atLast = m.lastKnown && m.x === m.lastKnown.x && m.y === m.lastKnown.y;
        if (m.searchTimer <= 0) {
          // 记忆耗尽 → 放弃
          m.mood = 'idle';
          m.lastKnown = null;
          m.path = [];
          m.wanderGoal = null;
        } else if (atLast) {
          // 已到达最后已知位置，就地徘徊（随机小目标）
          if (!m.wanderGoal) m.wanderGoal = pickWanderGoal(m, maze);
          goal = m.wanderGoal;
        } else {
          goal = m.lastKnown;
        }
      } else {
        // idle：慢速游荡
        if (!m.wanderGoal || (m.x === m.wanderGoal.x && m.y === m.wanderGoal.y)) {
          m.wanderGoal = pickWanderGoal(m, maze);
        }
        goal = m.wanderGoal;
      }

      // ---------- 3. 路径重算 ----------
      m.repathTimer -= dt;
      if (m.repathTimer <= 0 || !m.path || m.path.length === 0) {
        m.repathTimer = 0.25;
        if (goal && (goal.x !== m.x || goal.y !== m.y)) {
          const path = bfsPath(maze.grid, { x: m.x, y: m.y }, goal);
          m.path = path.length > 1 ? path.slice(1) : [];
        } else {
          m.path = [];
        }
      }

      // ---------- 4. 速度：非追击状态明显更慢 ----------
      // 这样玩家甩掉怪物后有一段相对安全的喘息期
      let spd = m.speed;
      if (m.mood === 'search') spd *= 0.72;
      else if (m.mood === 'idle') spd *= 0.5;

      m.travel = (m.travel || 0) + dt * spd;

      while (m.travel >= 1 && m.path.length > 0) {
        m.travel -= 1;
        const next = m.path.shift();
        m.fromX = m.x;
        m.fromY = m.y;
        m.x = next.x;
        m.y = next.y;
      }
      if (m.path.length === 0) m.travel = 0;

      const t = easeOutQuad(Math.min(1, Math.max(0, m.travel)));
      m.renderX = m.fromX + (m.x - m.fromX) * t;
      m.renderY = m.fromY + (m.y - m.fromY) * t;
    }
  }

  /**
   * 碰撞检测
   * ------------------------------------------------------------
   * 三层判定，从严格到宽松：
   *   1. 逻辑同格 —— 怪物已经踩到玩家头上，必死
   *   2. 位置交换 —— 玩家和怪物对向擦身而过（一帧内交叉），也算撞上
   *   3. 渲染距离 —— 用插值后的小数坐标算欧氏距离，
   *      阈值 0.62 格：可容忍"擦肩而过"的紧张感，但贴脸必中
   */
  function checkMonsterCollision() {
    const p = state.player;

    // 隐身期间：怪物既看不见你、也抓不到你。
    // 直接 return，不做任何失败判定（贴着怪物走也安全）。
    if (state.stealthT > 0) return;

    for (const m of state.monsters) {
      // 1. 同格
      if (m.x === p.x && m.y === p.y) {
        checkLose(m);
        return;
      }
      // 2. 对向交换
      if (m.x === p.fromX && m.y === p.fromY && m.fromX === p.x && m.fromY === p.y) {
        checkLose(m);
        return;
      }
      // 3. 渲染距离
      const d = Math.hypot(m.renderX - p.renderX, m.renderY - p.renderY);
      if (d < 0.62) {
        checkLose(m);
        return;
      }
    }
  }

  // ==================== 卡死救援 ====================

  /**
   * 玩家有时会被怪物逼到死角，此时需要"重置位置"而非直接失败。
   * 功能：把玩家传回起点（不加惩罚，但计时继续）。
   */
  function rescueBackToStart() {
    if (state.phase !== 'playing') return;
    const s = state.maze.start;
    const p = state.player;
    p.x = s.x; p.y = s.y;
    p.fromX = s.x; p.fromY = s.y;
    p.renderX = s.x; p.renderY = s.y;
    p.moveT = 1;
    updateVisibility();
  }

  // ==================== 对外接口 ====================

  function getState() { return state; }

  function stop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    state.phase = 'idle';
  }

  return {
    init, start, stop,
    pause, resume, togglePause,
    getState, rescueBackToStart,
    setViewMode, getViewMode,
    activateStealth, stealthInfo,
    revealPath, hintInfo, hintViewAllowed,
    /** 供虚拟方向键调用：dx/dy 为单位方向，失败返回 false */
    move: tryMove,
    DIFFICULTY
  };
})();
