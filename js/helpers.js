/**
 * helpers.js —— 死路检测与路径规划辅助
 * ------------------------------------------------------------
 * 死路（dead end）在完美迷宫里的严格定义：
 *   一条走廊的终点，只有一个相邻通路格的格子。
 *
 * 注意区分两种"死路"：
 *   1. 死胡同（cul-de-sac）：该格只有 1 个出口，走进去必然要原路返回
 *   2. 隐式死路：该格有 2 个出口，但两个出口都通向同一个已探索区域
 *      （即走廊的一个"凹"形），走进去也会绕回来
 *
 * 本模块只检测 1（严格死路），因为 2 需要全局连通分析，
 * 成本高且对小地图标注意义不大。
 *
 * 为什么用"度数"而不是 DFS 回溯：
 *   完美迷宫是一棵树，叶子节点 = 度数 1 的节点 = 死路。
 *   直接数相邻通路格数量，O(4) 复杂度，比 DFS 快几个数量级。
 */

const Helpers = (function () {
  'use strict';

  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  /**
   * 判断某格是否为死路（只有一个出口）
   * @param {number[][]} grid
   * @param {number} x
   * @param {number} y
   * @param {{x:number,y:number}} [exclude] 排除这个相邻格（即"来路"），
   *        用于判断"沿某方向走进来后，是否已无路可走"
   * @returns {boolean}
   */
  function isDeadEnd(grid, x, y, exclude) {
    if (grid[y] === undefined || grid[y][x] !== 0) return false;

    let exits = 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (grid[ny] === undefined || grid[ny][nx] !== 0) continue;
      // 排除来路后，数剩余出口
      if (exclude && nx === exclude.x && ny === exclude.y) continue;
      exits++;
    }
    return exits === 0;
  }

  /**
   * 严格意义的死胡同：整格只有 1 个相邻通路（不含来路排除）
   * 这是全图扫描用的判定
   */
  function isCulDeSac(grid, x, y) {
    if (grid[y] === undefined || grid[y][x] !== 0) return false;
    let exits = 0;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (grid[ny] === undefined || grid[ny][nx] !== 0) continue;
      exits++;
      if (exits > 1) return false;
    }
    return exits <= 1;
  }

  /**
   * 检测玩家当前所在格是否刚刚走进一条死路
   * 判定：当前格除"来路"外没有其它出口
   * @param {number[][]} grid
   * @param {{x:number,y:number}} player 当前格
   * @param {{x:number,y:number}} prev 上一格（来路）
   * @returns {boolean}
   */
  function isDeadEndAt(grid, player, prev) {
    // 玩家站在某格、且该格除来路外无其它出口 → 走进死胡同了
    if (!prev) return isCulDeSac(grid, player.x, player.y);
    return isDeadEnd(grid, player.x, player.y, prev);
  }

  /**
   * 全图扫描所有死路格子（用于开局建立索引）
   * @returns {Set<string>} "x,y" 集合
   */
  function scanDeadEnds(grid) {
    const set = new Set();
    const h = grid.length;
    const w = grid[0].length;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (grid[y][x] !== 0) continue;
        if (isCulDeSac(grid, x, y)) set.add(x + ',' + y);
      }
    }
    return set;
  }

  /**
   * 从起点出发，找最近的死路（用于小地图"建议方向"）
   * BFS 层序搜索，返回第一个命中的死路及其距离
   * @returns {{x:number,y:number,dist:number}|null}
   */
  function nearestDeadEnd(grid, from, deadEnds) {
    const h = grid.length;
    const w = grid[0].length;
    const seen = new Uint8Array(w * h);
    const q = [{ x: from.x, y: from.y, d: 0 }];
    seen[from.y * w + from.x] = 1;
    let head = 0;

    while (head < q.length) {
      const cur = q[head++];
      const key = cur.x + ',' + cur.y;
      if (deadEnds.has(key) && cur.d > 0) {
        return { x: cur.x, y: cur.y, dist: cur.d };
      }
      for (const [dx, dy] of DIRS) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        if (grid[ny][nx] !== 0) continue;
        const idx = ny * w + nx;
        if (seen[idx]) continue;
        seen[idx] = 1;
        q.push({ x: nx, y: ny, d: cur.d + 1 });
      }
    }
    return null;
  }

  /**
   * 计算某格到终点的"大致方向"（用于小地图箭头）
   * 用曼哈顿方向而非真实路径，避免每帧 BFS
   */
  function roughDirection(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return {
      x: Math.abs(dx) < 2 ? 0 : (dx > 0 ? 1 : -1),
      y: Math.abs(dy) < 2 ? 0 : (dy > 0 ? 1 : -1),
      manhattan: Math.abs(dx) + Math.abs(dy)
    };
  }

  return {
    isDeadEnd,
    isCulDeSac,
    isDeadEndAt,
    scanDeadEnds,
    nearestDeadEnd,
    roughDirection
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Helpers };
}
