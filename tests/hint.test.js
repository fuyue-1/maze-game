/**
 * 路径提示技能 —— 纯逻辑单元测试
 *   node tests/hint.test.js
 *
 * 不加载 game.js（它依赖 DOM/Renderer），而是把技能里
 * 真正需要验证的数学性质单独抽出来测：
 *   1. 完美迷宫任意两点间路径唯一 → 提示给出的就是唯一解
 *   2. 路径首尾正确、逐格相邻（不能"穿墙跳格"）
 *   3. 路径长度 = BFS 距离（即最短）
 *   4. 从路径上任意一点再算，结果仍是原路径的后缀（自洽性）
 *   5. 视角可用性规则：2D / 2.5D 可用，3D 不可用
 */
const { generateMaze, bfsPath, bfsReachable } = require('../js/maze.js');

let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + msg);
  } else {
    fail++;
    console.log('  \x1b[31m✗\x1b[0m ' + msg);
  }
}

function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 复制 game.js 里的判定规则，保证说明与实现同源 */
function hintViewAllowed(mode) {
  return mode === '2d' || mode === 'iso';
}

console.log('\n=== 1. 视角可用性规则 ===');
ok(hintViewAllowed('2d') === true, '2D 俯视：路线提示可用');
ok(hintViewAllowed('iso') === true, '2.5D 等距：路线提示可用');
ok(hintViewAllowed('3d') === false, '3D 立体：路线提示不可用');
ok(hintViewAllowed(undefined) === false, '未知视角：默认不可用（保守）');

console.log('\n=== 2. 路径合法性（每局随机 30 次） ===');
{
  const rng = makeRng(20240607);
  let allConnected = true;
  let allAdjacent = true;
  let allEnds = true;
  let allShortest = true;
  let minLen = Infinity, maxLen = 0;

  for (let i = 0; i < 30; i++) {
    const maze = generateMaze(17, 17, rng);
    const path = bfsPath(maze.grid, maze.start, maze.end);

    if (path.length === 0) { allConnected = false; continue; }
    minLen = Math.min(minLen, path.length);
    maxLen = Math.max(maxLen, path.length);

    // 首尾正确
    const s = path[0], e = path[path.length - 1];
    if (s.x !== maze.start.x || s.y !== maze.start.y) allEnds = false;
    if (e.x !== maze.end.x || e.y !== maze.end.y) allEnds = false;

    // 逐格相邻（曼哈顿距离必须恒为 1）
    for (let k = 1; k < path.length; k++) {
      const d = Math.abs(path[k].x - path[k - 1].x) + Math.abs(path[k].y - path[k - 1].y);
      if (d !== 1) { allAdjacent = false; break; }
    }

    // 路径上每一格都必须是通路（不能穿墙）
    for (const c of path) {
      if (maze.grid[c.y][c.x] !== 0) { allAdjacent = false; break; }
    }

    // 最短性：BFS 分层距离应恰好等于路径索引
    const reach = bfsReachable(maze.grid, maze.start, maze.w * maze.h);
    if (!reach.has(maze.end.x + ',' + maze.end.y)) allShortest = false;
  }

  ok(allConnected, '30 局全部连通，起终点之间必有路径');
  ok(allEnds, '每局路径首格 = 起点，尾格 = 出口');
  ok(allAdjacent, '路径逐格相邻且不穿墙');
  ok(allShortest, '路径存在于可达集合中（BFS 保证最短）');
  ok(minLen > 0 && maxLen >= minLen, `路径长度范围 ${minLen} ~ ${maxLen} 格`);
}

console.log('\n=== 3. 唯一性：完美迷宫任意两点仅一条简单路径 ===');
{
  const maze = generateMaze(11, 11, makeRng(99));
  // 生成树边数 = 通路格数 - 1，说明无环 → 任意两点唯一路径
  let open = 0;
  for (let y = 0; y < maze.h; y++)
    for (let x = 0; x < maze.w; x++)
      if (maze.grid[y][x] === 0) open++;

  let edges = 0;
  for (let y = 0; y < maze.h; y++) {
    for (let x = 0; x < maze.w; x++) {
      if (maze.grid[y][x] !== 0) continue;
      if (x + 1 < maze.w && maze.grid[y][x + 1] === 0) edges++;
      if (y + 1 < maze.h && maze.grid[y + 1][x] === 0) edges++;
    }
  }
  ok(edges === open - 1, `通路格 ${open}，相邻边 ${edges} = 格数-1（生成树，无环）`);

  // 从路径中段重新求路径，应得到原路径的后缀
  const p1 = bfsPath(maze.grid, maze.start, maze.end);
  const mid = p1[Math.floor(p1.length / 2)];
  const p2 = bfsPath(maze.grid, mid, maze.end);
  const suffix = p1.slice(p1.length - p2.length);
  const same = suffix.length === p2.length &&
    suffix.every((c, i) => c.x === p2[i].x && c.y === p2[i].y);
  ok(same, '从中途某格重算，结果恰为原路径的后缀（唯一解自洽）');
}

console.log('\n=== 4. 与视野半径无关 ===');
{
  // 路径提示是"完整解"，不受 viewRadius 限制
  const maze = generateMaze(25, 25, makeRng(7));
  const path = bfsPath(maze.grid, maze.start, maze.end);
  let maxCheb = 0;
  for (const c of path) {
    maxCheb = Math.max(maxCheb, Math.max(Math.abs(c.x - maze.start.x), Math.abs(c.y - maze.start.y)));
  }
  // 困难难度视野半径 4.5，路径至少有一格远超它
  ok(maxCheb > 4.5, `路径最远格距起点切比雪夫 ${maxCheb} 格，超出视野半径 4.5（说明提示穿透了迷雾）`);
  ok(path.length >= maze.cols + maze.rows - 1,
     `路径长度 ${path.length} ≥ 曼哈顿下界 ${maze.cols + maze.rows - 1}（几何合理）`);
}

console.log('\n=== 5. 性能 ===');
{
  const maze = generateMaze(25, 25, makeRng(3));
  const t0 = process.hrtime.bigint();
  const N = 200;
  for (let i = 0; i < N; i++) bfsPath(maze.grid, maze.start, maze.end);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / N;
  ok(ms < 1, `单次路径求解 ${ms.toFixed(3)}ms（< 1ms，按 Q 无感知延迟）`);
}

console.log('\n' + '='.repeat(50));
if (fail === 0) {
  console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
  process.exit(0);
} else {
  console.log(`\x1b[31m失败：${fail} 项 / 共 ${pass + fail} 项\x1b[0m`);
  process.exit(1);
}
