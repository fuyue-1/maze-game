/**
 * los.js —— 视线追踪（Line of Sight）
 * ------------------------------------------------------------
 * 迷雾为什么不能只画个圆：
 *   玩家在走廊里时，圆形视野会"穿墙"照亮隔壁房间，
 *   玩家能隔墙看到怪物 —— 这既不合理也不好玩。
 *
 * 本模块用 Bresenham 直线算法，从玩家中心向每个格子中心连一条线，
 * 若线上遇到墙格则判定不可见。配合 bfsReachable 的 步数上限，
 * 形成"距离 + 遮挡"双重约束的视野。
 *
 * 双缓冲可见集：
 *   为了性能，可见性计算不会每帧重算全部格子。采用：
 *   - 每帧重算玩家周围 radius 内的候选格子（约 300~1500 格）
 *   - 用 Uint8Array 按格子索引标记，避免 Set<string> 的哈希开销
 */

/**
 * Bresenham 视线检测：从 (x0,y0) 到 (x1,y1)，判断中间是否被墙阻挡
 * ------------------------------------------------------------
 * 起点格和终点格本身不参与阻挡判断（终点即使是墙也应该"被看到"）。
 *
 * @param {number[][]} grid
 * @param {number} x0 起点格 x（玩家所在格）
 * @param {number} y0 起点格 y
 * @param {number} x1 目标格 x
 * @param {number} y1 目标格 y
 * @returns {boolean} true 表示通视
 */
function hasLineOfSight(grid, x0, y0, x1, y1) {
  let dx = Math.abs(x1 - x0);
  let dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  let x = x0;
  let y = y0;

  // 上限保护：防止死循环
  let guard = dx + dy + 2;

  while (guard-- > 0) {
    if (x === x1 && y === y1) return true;

    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }

    // 到达终点即结束
    if (x === x1 && y === y1) return true;

    // 中途碰到墙 → 阻挡
    if (grid[y] !== undefined && grid[y][x] === 1) return false;
  }
  return false;
}

/**
 * 计算可见集合
 * ------------------------------------------------------------
 * 步骤：
 *   1. 局部 BFS 得到半径内"几何可达"的格子（避免对每个格子都做射线）
 *   2. 对每个可达格子做 Bresenham 通视检测
 *   3. 输出可见格子集合 + 可见的墙集合（墙要画出来，否则走廊边界是黑的）
 *
 * @param {number[][]} grid
 * @param {{x:number,y:number}} origin 玩家位置
 * @param {number} radius 视野半径（格）
 * @param {Set<string>} reachable bfsReachable 的结果（避免重复计算）
 * @returns {{visible: Set<string>, count: number}}
 */
function computeFOV(grid, origin, radius, reachable) {
  const visible = new Set();
  const h = grid.length;
  const w = grid[0].length;

  // 1. 玩家所在格及紧邻一圈总是可见（保证脚下不为黑）
  visible.add(origin.x + ',' + origin.y);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = origin.x + dx;
      const y = origin.y + dy;
      if (x >= 0 && x < w && y >= 0 && y < h) visible.add(x + ',' + y);
    }
  }

  if (!reachable || reachable.size === 0) {
    return { visible, count: visible.size };
  }

  // 2. 遍历候选格子，做通视检测
  for (const key of reachable) {
    const comma = key.indexOf(',');
    const x = +key.slice(0, comma);
    const y = +key.slice(comma + 1);

    // 距离裁剪（欧氏距离，让视野边缘自然收敛成圆形）
    const ddx = x - origin.x;
    const ddy = y - origin.y;
    if (ddx * ddx + ddy * ddy > radius * radius) continue;

    if (hasLineOfSight(grid, origin.x, origin.y, x, y)) {
      visible.add(key);
    }
  }

  return { visible, count: visible.size };
}

/**
 * 已探索区域记录（战争迷雾的"记忆"层）
 * ------------------------------------------------------------
 * 玩家走过的地方永久保留暗色轮廓，让玩家能回忆走过的路。
 * 用 Uint8Array 按 y*w+x 索引，内存占用 = w*h 字节（241x241 仅 58KB）。
 */
class ExploredMap {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h);
  }

  /** 把一批 "x,y" 键标记为已探索 */
  markAll(visibleSet) {
    for (const key of visibleSet) {
      const comma = key.indexOf(',');
      const x = +key.slice(0, comma);
      const y = +key.slice(comma + 1);
      if (x >= 0 && x < this.w && y >= 0 && y < this.h) {
        this.data[y * this.w + x] = 1;
      }
    }
  }

  has(x, y) {
    if (x < 0 || x >= this.w || y < 0 || y >= this.h) return false;
    return this.data[y * this.w + x] === 1;
  }

  reset() {
    this.data.fill(0);
  }

  get exploredCount() {
    let c = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i]) c++;
    return c;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { hasLineOfSight, computeFOV, ExploredMap };
}
