/**
 * maze.js —— 迷宫生成与寻路核心算法
 * ------------------------------------------------------------
 * 全部为纯函数/纯数据结构，不依赖 DOM，可在 Node 中直接测试。
 *
 * 迷宫表示法：
 *   使用 (2n+1) x (2n+1) 的二维网格。
 *   坐标为偶数的行列是"墙"，坐标为奇数的行列是"房间"。
 *   例：3x3 房间（n=3）对应 7x7 网格。
 *   打通两个相邻房间时，把两者中间的墙格置为 0。
 *
 *   0 = 通路   1 = 墙
 *   这种表示法的好处：墙本身就是数据，渲染时直接遍历画矩形即可。
 */

/**
 * 迭代式 DFS 生成单连通（perfect）迷宫
 * ------------------------------------------------------------
 * 为什么用迭代而不用递归：
 *   递归版 DFS 在 31x31 房间（63x63 网格）时递归深度最坏可达 DFS 路径长度，
 *   浏览器 JS 引擎给主线程的调用栈通常只有 1 万层左右，大迷宫容易 RangeError。
 *   迭代版用显式 stack 数组保存状态，内存占用在堆上，与调用栈无关，
 *   迷宫尺寸可以安全放大到 61x61 房间以上。
 *
 * 单连通性保证：
 *   每次只打通"当前房间 <-> 未访问房间"之间的一堵墙，且从不打通已访问房间之间的墙，
 *   因此生成结果是一棵生成树 —— 任意两点间有且仅有一条路径（无环、必连通）。
 *
 * @param {number} cols 房间列数（也是难度等级 N，最终网格为 (2N+1)^2）
 * @param {number} rows 房间行数
 * @param {Function} [rng] 随机数生成器，默认 Math.random，测试时可注入种子
 * @returns {{grid: number[][], cols: number, rows: number, w: number, h: number,
 *            start: {x:number,y:number}, end: {x:number,y:number}}}
 */
function generateMaze(cols, rows, rng = Math.random) {
  const w = cols * 2 + 1;
  const h = rows * 2 + 1;

  // 网格全部填墙
  const grid = [];
  for (let y = 0; y < h; y++) {
    grid.push(new Array(w).fill(1));
  }

  const visited = [];
  for (let y = 0; y < h; y++) {
    visited.push(new Array(w).fill(false));
  }

  // 起点固定为左上角第一个房间 (1,1)
  const startRoom = { x: 1, y: 1 };
  const stack = [startRoom];
  visited[startRoom.y][startRoom.x] = true;
  grid[startRoom.y][startRoom.x] = 0;

  // 四个方向的邻居偏移（跨两格，隔着一堵墙）
  const DIRS = [
    [0, -2], // 上
    [2, 0],  // 右
    [0, 2],  // 下
    [-2, 0]  // 左
  ];

  while (stack.length > 0) {
    const cur = stack[stack.length - 1];

    // 收集所有"未访问的相邻房间"
    const candidates = [];
    for (let d = 0; d < 4; d++) {
      const nx = cur.x + DIRS[d][0];
      const ny = cur.y + DIRS[d][1];
      if (nx > 0 && nx < w - 1 && ny > 0 && ny < h - 1 && !visited[ny][nx]) {
        candidates.push({ nx, ny });
      }
    }

    if (candidates.length === 0) {
      // 死路：回溯（出栈）
      stack.pop();
      continue;
    }

    // 随机挑一个邻居，打通中间的墙
    const pick = candidates[Math.floor(rng() * candidates.length)];
    const { nx, ny } = pick;

    // 中间墙格坐标
    const wallX = (cur.x + nx) / 2;
    const wallY = (cur.y + ny) / 2;
    grid[wallY][wallX] = 0;

    visited[ny][nx] = true;
    grid[ny][nx] = 0;
    stack.push({ x: nx, y: ny });
  }

  // 终点固定在右下角最后一个房间
  const endRoom = { x: w - 2, y: h - 2 };
  // 出口处封掉右/下边界外的墙是本来就有的，无需处理

  return {
    grid,
    cols,
    rows,
    w,
    h,
    start: startRoom,
    end: endRoom
  };
}

/**
 * BFS 求最短路径（可跨多格子，每步走一格，不能穿墙）
 * ------------------------------------------------------------
 * 用于：
 *   1. 怪物寻路 —— 每帧从怪物位置 BFS 到玩家位置
 *   2. 迷雾视野 —— 限定步数上限的局部 BFS 求可达范围
 *
 * 复杂度 O(V + E)。我们的网格最大约 123x123 = 15129 格，每格 4 条边，
 * 单次 BFS 约 6 万次操作，浏览器单帧预算 16.7ms 内可多次调用。
 *
 * @param {number[][]} grid 迷宫网格
 * @param {{x:number,y:number}} from 起点
 * @param {{x:number,y:number}} to 终点
 * @param {number} [maxSteps] 步数上限（用于迷雾局部搜索），Infinity 表示不限
 * @returns {{x:number,y:number}[]} 从 from 到 to 的路径（含首尾），不可达返回 []
 */
function bfsPath(grid, from, to, maxSteps = Infinity) {
  const h = grid.length;
  const w = grid[0].length;

  if (from.x === to.x && from.y === to.y) return [{ x: from.x, y: from.y }];
  if (grid[from.y]?.[from.x] !== 0 || grid[to.y]?.[to.x] !== 0) return [];

  // 用一维索引做 visited / parent，避免创建大量对象
  const total = w * h;
  const parent = new Int32Array(total).fill(-1);
  const dist = new Int32Array(total).fill(-1);

  const idx = (x, y) => y * w + x;
  const startIdx = idx(from.x, from.y);
  const goalIdx = idx(to.x, to.y);

  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  queue[tail++] = startIdx;
  dist[startIdx] = 0;

  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  let found = false;

  while (head < tail) {
    const curIdx = queue[head++];
    if (curIdx === goalIdx) {
      found = true;
      break;
    }
    if (dist[curIdx] >= maxSteps) continue;

    const cx = curIdx % w;
    const cy = (curIdx - cx) / w;

    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (grid[ny][nx] !== 0) continue;
      const nIdx = idx(nx, ny);
      if (dist[nIdx] !== -1) continue;

      dist[nIdx] = dist[curIdx] + 1;
      parent[nIdx] = curIdx;
      queue[tail++] = nIdx;
    }
  }

  if (!found) return [];

  // 从终点回溯还原路径
  const path = [];
  let cur = goalIdx;
  while (cur !== -1) {
    const cx = cur % w;
    const cy = (cur - cx) / w;
    path.push({ x: cx, y: cy });
    if (cur === startIdx) break;
    cur = parent[cur];
  }
  path.reverse();
  return path;
}

/**
 * 局部 BFS 求视野内可达的所有格子（迷雾用）
 * ------------------------------------------------------------
 * 以玩家为中心，在半径 radius 步内做 BFS，返回：
 *   - visible: Set<"x,y"> 被 BFS 走到的格子（即几何上可达）
 * 注意：这里只算"可达"，真正的遮挡由 los.js 的视线追踪负责。
 *
 * @param {number[][]} grid
 * @param {{x:number,y:number}} origin
 * @param {number} radius 视野半径（格数）
 * @returns {Set<string>} 形如 "x,y" 的键集合
 */
function bfsReachable(grid, origin, radius) {
  const h = grid.length;
  const w = grid[0].length;
  const reach = new Set();
  const key = (x, y) => x + ',' + y;

  if (grid[origin.y]?.[origin.x] !== 0) return reach;

  const dist = new Map();
  const queue = [{ x: origin.x, y: origin.y }];
  dist.set(key(origin.x, origin.y), 0);
  reach.add(key(origin.x, origin.y));

  const DX = [0, 1, 0, -1];
  const DY = [-1, 0, 1, 0];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist.get(key(cur.x, cur.y));
    if (d >= radius) continue;

    for (let i = 0; i < 4; i++) {
      const nx = cur.x + DX[i];
      const ny = cur.y + DY[i];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      if (grid[ny][nx] !== 0) {
        // 视野边缘的墙也要标记，否则墙会是黑的（视觉上不自然）
        reach.add(key(nx, ny));
        continue;
      }
      const k = key(nx, ny);
      if (dist.has(k)) continue;
      dist.set(k, d + 1);
      reach.add(k);
      queue.push({ x: nx, y: ny });
    }
  }

  return reach;
}

/**
 * 校验迷宫合法性（单元测试用）
 * 1. 起点终点必须可达（连通性）
 * 2. 通路格数量必须等于 房间数 + 打通墙数 = 2*c*r + (c*r - 1)
 * 3. 无 2x2 全通路区域（生成树不会产生环路）
 */
function validateMaze(maze) {
  const { grid, w, h, start, end, cols, rows } = maze;

  let openCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[y][x] === 0) openCount++;
    }
  }

  // 连通性
  const path = bfsPath(grid, start, end);
  const connected = path.length > 0;

  // 无环检测：通路格数 = 顶点数，边数 = 顶点数 - 1（树）
  // 等价于检查不存在 2x2 的全通路块
  let hasLoop = false;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      if (grid[y][x] === 0 && grid[y][x + 1] === 0 &&
          grid[y + 1][x] === 0 && grid[y + 1][x + 1] === 0) {
        hasLoop = true;
        break;
      }
    }
    if (hasLoop) break;
  }

  const expectedOpen = cols * rows + (cols * rows - 1);

  return {
    connected,
    hasLoop,
    openCount,
    expectedOpen,
    perfect: connected && !hasLoop && openCount === expectedOpen,
    pathLength: path.length
  };
}

// 同时兼容浏览器全局与 Node require
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { generateMaze, bfsPath, bfsReachable, validateMaze };
}
