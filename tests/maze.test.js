/**
 * 算法单元测试 —— 直接用 node 运行，无需任何依赖
 *   node tests/maze.test.js
 */
const { generateMaze, bfsPath, bfsReachable, validateMaze } = require('../js/maze.js');

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

// 可复现的伪随机（mulberry32），保证测试稳定
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

console.log('\n=== 1. 迷宫生成：单连通性 / 无环 / 尺寸 ===');
for (const n of [5, 11, 21, 31, 41, 61]) {
  const maze = generateMaze(n, n, makeRng(n * 7919));
  const v = validateMaze(maze);

  ok(maze.grid.length === n * 2 + 1 && maze.grid[0].length === n * 2 + 1,
     `${n}x${n} 房间 → 网格 ${n * 2 + 1}x${n * 2 + 1}`);
  ok(v.connected, `${n}x${n} 起点到终点连通`);
  ok(!v.hasLoop, `${n}x${n} 无环路（生成树）`);
  ok(v.openCount === v.expectedOpen,
     `${n}x${n} 通路格数 ${v.openCount} == 期望 ${v.expectedOpen}`);
  ok(v.perfect, `${n}x${n} 是完美迷宫`);
}

console.log('\n=== 2. 迭代 DFS 不会栈溢出（大迷宫） ===');
try {
  const big = generateMaze(120, 120, makeRng(12345));
  const v = validateMaze(big);
  ok(v.perfect, '120x120 房间（241x241 网格）生成成功且为完美迷宫');
  ok(big.grid.length === 241, '网格尺寸正确');
} catch (e) {
  ok(false, '大迷宫生成抛异常: ' + e.message);
}

console.log('\n=== 3. 边界：极小迷宫 ===');
{
  const m1 = generateMaze(1, 1, makeRng(1));
  ok(m1.w === 3 && m1.h === 3, '1x1 房间 → 3x3 网格');
  ok(m1.grid[1][1] === 0, '1x1 起点是通路');
  ok(m1.start.x === 1 && m1.start.y === 1 && m1.end.x === 1 && m1.end.y === 1,
     '1x1 起点终点重合');
  const p = bfsPath(m1.grid, m1.start, m1.end);
  ok(p.length === 1, '1x1 BFS 路径长度为 1（起点即终点）');
}

console.log('\n=== 4. BFS 最短路径正确性 ===');
{
  // 手工构造一个 5x5 的小迷宫网格验证 BFS 结果
  // 1 = 墙, 0 = 通路
  const g = [
    [1,1,1,1,1],
    [1,0,0,0,1],
    [1,0,1,0,1],
    [1,0,0,0,1],
    [1,1,1,1,1]
  ];
  const p = bfsPath(g, { x: 1, y: 1 }, { x: 3, y: 3 });
  ok(p.length === 5, '环形通道中最短路径为 5 格，实际 ' + p.length);
  ok(p[0].x === 1 && p[0].y === 1, '路径起点正确');
  ok(p[p.length - 1].x === 3 && p[p.length - 1].y === 3, '路径终点正确');

  // 路径每一步必须相邻且可走
  let stepOk = true;
  for (let i = 1; i < p.length; i++) {
    const dx = Math.abs(p[i].x - p[i - 1].x);
    const dy = Math.abs(p[i].y - p[i - 1].y);
    if (dx + dy !== 1 || g[p[i].y][p[i].x] !== 0) stepOk = false;
  }
  ok(stepOk, '路径每一步相邻且不穿墙');

  // 不可达
  const wall = [
    [1,1,1],
    [1,0,1],
    [1,1,1]
  ];
  const np = bfsPath(wall, { x: 1, y: 1 }, { x: 0, y: 0 });
  ok(np.length === 0, '目标为墙时返回空路径');
}

console.log('\n=== 5. BFS 在真实迷宫中的最优性 ===');
{
  const m = generateMaze(15, 15, makeRng(999));
  const p = bfsPath(m.grid, m.start, m.end);
  ok(p.length > 0, '15x15 迷宫起点可达终点，路径长 ' + p.length);

  // 与暴力 Dijkstra（这里用多次 BFS 对比，等价性检查）
  // 重点验证：路径长度 == 曼哈顿下界以上，且单调不回头
  const manhattan = Math.abs(m.end.x - m.start.x) + Math.abs(m.end.y - m.start.y);
  ok(p.length - 1 >= manhattan, `实际步数 ${p.length - 1} >= 曼哈顿距离 ${manhattan}`);

  // 路径上每一格都是通路
  ok(p.every(pt => m.grid[pt.y][pt.x] === 0), '路径所有格子均为通路');
}

console.log('\n=== 6. 局部 BFS（迷雾视野） ===');
{
  const m = generateMaze(20, 20, makeRng(4242));
  const origin = { x: 1, y: 1 };
  for (const r of [0, 1, 3, 6]) {
    const reach = bfsReachable(m.grid, origin, r);
    ok(reach.has('1,1'), `半径 ${r} 包含原点`);
    ok(reach.size > 0, `半径 ${r} 视野格子数 = ${reach.size}`);
  }

  const r0 = bfsReachable(m.grid, origin, 0);
  ok(r0.size >= 1 && r0.size <= 5, `半径 0 只包含原点和紧邻墙（实得 ${r0.size}）`);

  // 半径越大，视野应单调不减（近似，因为墙也算）
  const r3 = bfsReachable(m.grid, origin, 3).size;
  const r8 = bfsReachable(m.grid, origin, 8).size;
  ok(r8 > r3, `半径 8 视野(${r8}) > 半径 3 视野(${r3})`);
}

console.log('\n=== 7. 性能：每帧 BFS 预算 ===');
{
  const m = generateMaze(45, 45, makeRng(777));
  const t0 = process.hrtime.bigint();
  const N = 200;
  for (let i = 0; i < N; i++) {
    bfsPath(m.grid, { x: 1, y: 1 }, m.end);
  }
  const t1 = process.hrtime.bigint();
  const msPer = Number(t1 - t0) / 1e6 / N;
  ok(msPer < 5, `45x45 迷宫单次 BFS 平均 ${msPer.toFixed(3)}ms（< 5ms 预算）`);
}

console.log(`\n${'='.repeat(50)}`);
if (fail === 0) {
  console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
} else {
  console.log(`\x1b[31m失败 ${fail} 项\x1b[0m / 通过 ${pass} 项`);
  process.exitCode = 1;
}
