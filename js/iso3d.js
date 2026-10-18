/**
 * iso3d.js —— 真 3D 渲染层（Three.js）
 * ------------------------------------------------------------
 * 设计目标：与现有 2D / 2.5D 完全并存，三种视角共用同一份 state。
 *
 * 关键决策：
 *   1. 用 WebGLRenderer + PerspectiveCamera，斜俯视 45° 跟随玩家
 *   2. 墙体和地板用 InstancedMesh —— 一个 draw call 画完整张迷宫，
 *      比逐格 Mesh 快一个数量级（25×25 迷宫 625 个实例仍只 1 次调用）
 *   3. 迷雾不用后处理：靠 scene.fog + 只点亮视野内的格子，
 *      成本几乎为零，手机上也能跑
 *   4. 角色用基础几何体组合（球+圆柱+圆锥），不加载任何模型文件
 *
 * 性能兜底：WebGL 不可用时 render() 返回 false，上层自动降级到 2D。
 */

const Iso3D = (function () {
  'use strict';

  let renderer = null;
  let scene = null;
  let camera = null;
  let canvas = null;

  let floorMesh = null;    // InstancedMesh：地板
  let wallMesh = null;     // InstancedMesh：墙体
  let floorDummy = null;
  let wallDummy = null;

  let playerGroup = null;
  let monsterGroups = [];
  let portalGroup = null;

  let mazeRef = null;
  let camAngle = 0;        // 相机水平角（跟随玩家朝向平滑）
  let clock = 0;
  let ready = false;
  let available = true;

  const CELL = 1;          // 一格 = 1 世界单位
  const WALL_H = 1.6;      // 墙高

  function isSupported() {
    if (!available) return false;
    if (typeof THREE === 'undefined') return false;
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) {
      return false;
    }
  }

  function init(el) {
    if (!isSupported()) { available = false; return false; }

    // 关键：同一个 canvas 一旦拿过 2D 上下文，就再也拿不到 WebGL 上下文。
    // 所以 3D 用自己的 canvas，叠在原 canvas 上方，切到 2D 时隐藏。
    canvas = document.createElement('canvas');
    canvas.className = 'gfx3d-layer';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;z-index:2;';
    const host = el.parentElement || document.body;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(canvas);

    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance'
      });
    } catch (e) {
      console.warn('[Iso3D] WebGL 初始化失败，降级到 2D', e);
      available = false;
      if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
      canvas = null;
      return false;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    resize();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xd9cfba);
    scene.fog = new THREE.Fog(0xd9cfba, 4, 13);

    camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);

    // ---- 光照：环境光打底 + 跟随玩家的暖色点光 ----
    const amb = new THREE.AmbientLight(0xfff4e0, 1.5);
    scene.add(amb);

    const hemi = new THREE.HemisphereLight(0xfff8ec, 0xbfae92, 1.1);
    scene.add(hemi);

    keyLight = new THREE.PointLight(0xfff0c8, 1.6, 14, 1.0);
    scene.add(keyLight);

    monsterLight = new THREE.PointLight(0xff4d6d, 1.4, 6, 1.5);
    scene.add(monsterLight);

    ready = true;
    return true;
  }

  /** 显示/隐藏 3D 图层（切到 2D 时必须隐藏，否则会盖住画面） */
  function setVisible(v) {
    if (canvas) canvas.style.display = v ? 'block' : 'none';
  }

  let keyLight = null;
  let monsterLight = null;

  function resize() {
    if (!renderer || !canvas) return;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    if (camera) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  const matFloorA = () => new THREE.MeshLambertMaterial({ color: 0x1a2437 });
  const matFloorB = () => new THREE.MeshLambertMaterial({ color: 0x16202f });
  const matWallTop = () => new THREE.MeshLambertMaterial({ color: 0x3c5075 });
  const matWallSide = () => new THREE.MeshLambertMaterial({ color: 0x222e44 });

  /**
   * 构建迷宫几何体
   * 用 InstancedMesh：所有地板是一个 mesh，所有墙是一个 mesh
   */
  function build(maze, palette) {
    if (!ready) return;
    mazeRef = maze;

    // 清空旧对象
    if (floorMesh) { scene.remove(floorMesh); floorMesh.geometry.dispose(); floorMesh = null; }
    if (wallMesh) { scene.remove(wallMesh); wallMesh.geometry.dispose(); wallMesh = null; }
    if (playerGroup) { scene.remove(playerGroup); playerGroup = null; }
    for (const g of monsterGroups) scene.remove(g);
    monsterGroups = [];
    if (portalGroup) { scene.remove(portalGroup); portalGroup = null; }

    const floors = [];
    const walls = [];
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (maze.grid[y][x] === 1) walls.push([x, y]);
        else floors.push([x, y]);
      }
    }

    // ---- 地板 ----
    const fGeo = new THREE.BoxGeometry(CELL * 0.98, 0.1, CELL * 0.98);
    const fMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9c9280 });
    floorMesh = new THREE.InstancedMesh(fGeo, fMat, floors.length);
    floorMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const d = new THREE.Object3D();
    floors.forEach(([x, y], i) => {
      d.position.set(x, -0.05, y);
      d.updateMatrix();
      floorMesh.setMatrixAt(i, d.matrix);
      // 棋盘格明暗
      const c = new THREE.Color((x + y) % 2 === 0 ? 0xb8ab90 : 0xc2b69c);
      floorMesh.setColorAt(i, c);
    });
    floorMesh.instanceColor.needsUpdate = true;
    scene.add(floorMesh);

    // ---- 墙体 ----
    const wGeo = new THREE.BoxGeometry(CELL, WALL_H, CELL);
    const wMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xa89c84 });
    wallMesh = new THREE.InstancedMesh(wGeo, wMat, walls.length);
    wallMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    walls.forEach(([x, y], i) => {
      d.position.set(x, WALL_H / 2, y);
      d.updateMatrix();
      wallMesh.setMatrixAt(i, d.matrix);
      // 轻微色差，避免整片墙死板
      const v = 0.9 + ((x * 7 + y * 13) % 5) * 0.045;
      wallMesh.setColorAt(i, new THREE.Color(0xe8dcc4).multiplyScalar(v));
    });
    wallMesh.instanceColor.needsUpdate = true;
    scene.add(wallMesh);

    // ---- 玩家：小球身体 + 头 + 两只角 + 尾巴 ----
    playerGroup = buildDragon3D(0xffd98a, 0xffb75e);
    scene.add(playerGroup);

    // ---- 出口：发光圆柱 ----
    portalGroup = new THREE.Group();
    const ringGeo = new THREE.TorusGeometry(0.34, 0.06, 8, 24);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    portalGroup.add(ring);

    const pillarGeo = new THREE.CylinderGeometry(0.24, 0.24, 2.4, 16, 1, true);
    const pillarMat = new THREE.MeshBasicMaterial({
      color: 0xffd166, transparent: true, opacity: 0.24, side: THREE.DoubleSide
    });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.y = 1.2;
    portalGroup.add(pillar);

    portalGroup.position.set(maze.end.x, 0, maze.end.y);
    scene.add(portalGroup);

    // ---- 怪物 ----
    for (const m of (maze.monsterSeed || [])) { /* 占位 */ }

    resize();
  }

  /** 用基础几何体拼一只 Q 版小龙 */
  function buildDragon3D(bodyColor, accentColor) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: bodyColor });
    const accentMat = new THREE.MeshLambertMaterial({ color: accentColor });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 12), bodyMat);
    body.position.y = 0.2;
    body.scale.set(1, 0.92, 1);
    g.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 14), bodyMat);
    head.position.y = 0.52;
    g.add(head);

    // 眼睛
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x121a26 });
    for (const sx of [-0.1, 0.1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), eyeMat);
      eye.position.set(sx, 0.56, 0.22);
      g.add(eye);
    }

    // 角
    const hornMat = new THREE.MeshLambertMaterial({ color: accentColor });
    for (const sx of [-0.12, 0.12]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 8), hornMat);
      horn.position.set(sx, 0.74, 0);
      g.add(horn);
    }

    // 尾巴
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 8), accentMat);
    tail.position.set(0, 0.22, -0.26);
    tail.rotation.x = Math.PI / 2.4;
    g.add(tail);

    return g;
  }

  /** 怪物用暗紫色刺球表示 */
  function buildMonster3D() {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x4a2b5e, emissive: 0x1a0d26 });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), mat);
    core.position.y = 0.3;
    g.add(core);

    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff4d6d });
    for (const sx of [-0.08, 0.08]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), eyeMat);
      eye.position.set(sx, 0.34, 0.22);
      g.add(eye);
    }
    return g;
  }

  function syncMonsterCount(state) {
    if (!state.monsters) return;
    while (monsterGroups.length < state.monsters.length) {
      const g = buildMonster3D();
      monsterGroups.push(g);
      scene.add(g);
    }
    while (monsterGroups.length > state.monsters.length) {
      scene.remove(monsterGroups.pop());
    }
  }

  function draw(state, dt) {
    if (!ready || !scene) return false;
    clock += dt;

    if (!mazeRef || mazeRef !== state.maze) {
      build(state.maze, null);
      syncMonsterCount(state);
    }
    syncMonsterCount(state);

    const p = state.player;

    // ---- 相机：位置硬跟随，朝向恒定，零抖动 ----
    // 之前的问题：位置用插值 + 每帧 lookAt → 相机与目标始终有微小偏差，
    // 导致 rotation.x 在 -1.5696 / -1.5708 之间抖动，视觉上像画面在晃。
    // 现在：相机位置直接钉死在玩家头顶（不做插值），朝向一次性设定，
    // 每帧只更新位置，绝不重新 lookAt —— 画面绝对稳定。
    camera.position.set(p.renderX + 0.5, 10.5, p.renderY + 0.5 + 0.001);
    // 朝向固定：垂直向下俯视（-Y），上方向为世界 -Z（即屏幕上方 = 世界北）
    camera.rotation.set(-Math.PI / 2, 0, 0);
    camera.up.set(0, 0, -1);

    // ---- 玩家 ----
    if (playerGroup) {
      playerGroup.position.set(p.renderX + 0.5, 0, p.renderY + 0.5);
      playerGroup.rotation.y = Math.atan2(p.dir.x, p.dir.y);
      // 走路上下浮动
      const bob = Math.sin((state.walkPhase || 0) * Math.PI * 2) * 0.045;
      playerGroup.position.y = Math.abs(bob);

      // 隐身中：整体半透明（材质在 build 时已设 transparent）
      const ghost = state.stealthT > 0;
      playerGroup.traverse((o) => {
        if (o.isMesh && o.material) {
          o.material.transparent = true;
          o.material.opacity = ghost ? 0.28 : 1;
        }
      });
    }

    // ---- 点光跟随玩家 ----
    if (keyLight) {
      keyLight.position.set(p.renderX + 0.5, 1.9, p.renderY + 0.5);
      keyLight.distance = (state.viewRadius + 3) * 1.15;
    }

    // ---- 怪物 ----
    if (state.monsters) {
      let nearest = null, nd = 1e9;
      state.monsters.forEach((m, i) => {
        const g = monsterGroups[i];
        if (!g) return;
        g.position.set(m.renderX + 0.5, Math.abs(Math.sin(clock * 3 + m.seed)) * 0.08, m.renderY + 0.5);
        // 怪物不自转（原来 clock*1.2 会让画面里一直有东西在转）
        g.rotation.y = 0;
        const dd = Math.hypot(m.renderX - p.renderX, m.renderY - p.renderY);
        if (dd < nd) { nd = dd; nearest = m; }
      });
      if (monsterLight && nearest) {
        monsterLight.position.set(nearest.renderX + 0.5, 1.2, nearest.renderY + 0.5);
        monsterLight.intensity = nd < 7 ? 1.2 * Math.max(0.2, 1 - nd / 7) : 0;
      }
    }

    // ---- 出口脉动 ----
    if (portalGroup) {
      const s = 1 + Math.sin(clock * 2.4) * 0.12;
      portalGroup.scale.set(s, 1, s);
      portalGroup.rotation.y = clock * 0.7;
    }

    // ---- 雾随视野半径调整 ----
    if (scene.fog) {
      scene.fog.near = state.viewRadius * 0.9;
      scene.fog.far = state.viewRadius * 2.6 + 10;
    }

    renderer.render(scene, camera);
    return true;
  }

  function dispose() {
    ready = false;
    if (renderer) { renderer.dispose(); renderer = null; }
    scene = null; camera = null; mazeRef = null;
  }

  return {
    init, draw, build, resize, dispose, isSupported, setVisible,
    get ready() { return ready; },
    /** 调试用：暴露相机以便验证"是否旋转" */
    get camera() { return camera; }
  };
})();
