/**
 * 视线追踪测试
 *   node tests/los.test.js
 */
const { hasLineOfSight, computeFOV, ExploredMap } = require('../js/los.js');
const { generateMaze, bfsReachable } = require('../js/maze.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + msg); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + msg); }
}
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log('\n=== 1. Bresenham 通视判定 ===');
{
  // 直线走廊，中间无墙
  const open = [
    [1,1,1,1,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,0,0,0,1],
    [1,1,1,1,1]
  ];
  ok(hasLineOfSight(open, 1, 1, 3, 1), '同一行水平通视');
  ok(hasLineOfSight(open, 1, 1, 1, 3), '同一列垂直通视');
  ok(hasLineOfSight(open, 1, 1, 3, 3), '对角线通视');

  // 中间有墙
  const blocked = [
    [1,1,1,1,1],
    [1,0,0,0,1],
    [1,0,1,0,1],
    [1,0,0,0,1],
    [1,1,1,1,1]
  ];
  ok(!hasLineOfSight(blocked, 1, 1, 3, 3), '对角线中间隔墙 → 不通视');
  ok(hasLineOfSight(blocked, 1, 1, 1, 0), '墙格本身可以被"看到"（终点不阻挡）');

  // 起点=终点
  ok(hasLineOfSight(open, 2, 2, 2, 2), '起点等于终点 → 通视');
}

console.log('\n=== 2. 真实迷宫：隔墙不可见 ===');
{
  const m = generateMaze(20, 20, makeRng(2024));

  // 找到一对"几何距离很近、但隔着墙"的格子，验证确实被遮挡
  let blockedPairs = 0, totalPairs = 0;
  for (let y = 1; y < m.h - 1; y++) {
    for (let x = 1; x < m.w - 1; x++) {
      if (m.grid[y][x] !== 0) continue;
      // 检查 (x,y) 与其右侧两格 (x+2,y) 的关系
      if (x + 2 < m.w && m.grid[y][x + 2] === 0) {
        totalPairs++;
        if (!hasLineOfSight(m.grid, x, y, x + 2, y)) blockedPairs++;
      }
    }
  }
  ok(blockedPairs > 0,
     `存在被墙遮挡的近邻格子：${blockedPairs}/${totalPairs} 对（说明迷雾不会被墙穿透）`);
}

console.log('\n=== 3. computeFOV 视野收敛 ===');
{
  const m = generateMaze(25, 25, makeRng(555));
  for (const r of [2, 4, 6, 10]) {
    const reach = bfsReachable(m.grid, m.start, r + 2);
    const fov = computeFOV(m.grid, m.start, r, reach);
    ok(fov.count > 0, `半径 ${r} 可见格子数 = ${fov.count}`);
    ok(fov.visible.has(m.start.x + ',' + m.start.y), `半径 ${r} 包含玩家自身`);
  }

  // 半径越大可见格子应越多
  const r1 = computeFOV(m.grid, m.start, 3, bfsReachable(m.grid, m.start, 5)).count;
  const r2 = computeFOV(m.grid, m.start, 8, bfsReachable(m.grid, m.start, 10)).count;
  ok(r2 > r1, `视野半径增大时可见范围扩大：${r1} → ${r2}`);

  // 可见格子必须在半径内
  const R = 6;
  const fov = computeFOV(m.grid, m.start, R, bfsReachable(m.grid, m.start, R + 2));
  let allInRange = true;
  for (const key of fov.visible) {
    const [x, y] = key.split(',').map(Number);
    const dx = x - m.start.x, dy = y - m.start.y;
    if (dx * dx + dy * dy > R * R) allInRange = false;
  }
  ok(allInRange, `半径 ${R} 内所有可见格子都在欧氏距离约束内`);
}

console.log('\n=== 4. ExploredMap 记忆层 ===');
{
  const em = new ExploredMap(10, 10);
  ok(em.exploredCount === 0, '初始为空');
  em.markAll(new Set(['1,1', '2,1', '3,1']));
  ok(em.exploredCount === 3, '标记 3 格后计数为 3');
  ok(em.has(2, 1), '已标记格里 has() 返回 true');
  ok(!em.has(5, 5), '未标记格返回 false');
  ok(!em.has(-1, 0) && !em.has(100, 100), '越界坐标安全返回 false');
  em.reset();
  ok(em.exploredCount === 0, 'reset 后清空');
}

console.log('\n=== 5. 性能：FOV 每帧开销 ===');
{
  const m = generateMaze(40, 40, makeRng(888));
  const R = 7;
  const t0 = process.hrtime.bigint();
  const N = 300;
  for (let i = 0; i < N; i++) {
    const reach = bfsReachable(m.grid, m.start, R + 1);
    computeFOV(m.grid, m.start, R, reach);
  }
  const t1 = process.hrtime.bigint();
  const msPer = Number(t1 - t0) / 1e6 / N;
  ok(msPer < 8, `40x40 迷宫 FOV 单次 ${msPer.toFixed(3)}ms（< 8ms）`);
}

console.log(`\n${'='.repeat(50)}`);
if (fail === 0) console.log(`\x1b[32m全部通过：${pass} 项\x1b[0m`);
else { console.log(`\x1b[31m失败 ${fail} 项\x1b[0m / 通过 ${pass} 项`); process.exitCode = 1; }
