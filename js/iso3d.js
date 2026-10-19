/**
 * iso3d.js —— 真 3D 渲染层（Three.js）
 * ------------------------------------------------------------
 * 设计目标：与现有 2D / 2.5D 完全并存，三种视角共用同一份 state。
 *
 * 关键决策：
 *   1. 用 WebGLRenderer + PerspectiveCamera，固定朝向俯视跟随玩家
 *   2. 墙体和地板用 InstancedMesh —— 一个 draw call 画完整张迷宫，
 *      比逐格 Mesh 快一个数量级（25×25 迷宫 625 个实例仍只 1 次调用）
 *   3. 迷雾不用后处理：靠 scene.fog + 跟随玩家的点光，成本几乎为零
 *   4. 角色用基础几何体组合（球+圆柱+圆锥），不加载任何模型文件
 *
 * 【本轮修复】主题 / 角色在 3D 下不生效
 *   原因：build(maze, palette) 收了 palette 参数却从未使用，
 *         墙/地板/背景/雾全部硬编码成 daylight 的色值；
 *         且 Themes.apply() 只把配色下发给了 Renderer，从未下发给 Iso3D。
 *   修复：
 *     1. 模块内缓存 PALETTE3D / SKIN3D，applyTheme / applySkin 可随时热更新
 *     2. 换主题无需重建几何：直接改 scene.background、fog、灯光、
 *        以及 InstancedMesh 的 instanceColor（零重建开销，切换即时生效）
 *     3. 墙体用「顶点色做明暗 + 实例色做主题色」两层相乘，
 *        因此只需单一材质就能做到顶面亮、侧面暗，且颜色仍完全跟随主题
 *     4. 灯光强度按主题亮度自适应：暗主题压低环境光，
 *        亮主题提亮，保证两种极端下都看得清
 */

const Iso3D = (function () {
  'use strict';

  let renderer = null;
  let scene = null;
  let camera = null;
  let canvas = null;

  let floorMesh = null;    // InstancedMesh：地板
  let wallMesh = null;     // InstancedMesh：墙体
  let floorMat = null;
  let wallMat = null;
  let floorCells = [];     // 换主题时重算颜色用，避免重新扫 grid
  let wallCells = [];

  let groundPlane = null;  // 迷宫外的地平，避免大片纯黑像"没渲染"
  let groundMat = null;

  let playerGroup = null;
  let playerMats = null;   // { body, accent } 换皮肤时直接改这两个材质
  let playerHorns = [];
  // 朝向容器：左手坐标系下「面向 -Z」= 模型正面朝前，
  // 朝向交给外层 group 的 rotation.y，尾巴/手脚的摆动只在容器内做，
  // 两者互不干扰（否则一摆动就把朝向拧歪）
  let playerBody = null;
  let playerTail = null;
  let playerArms = [];
  let playerLegs = [];
  let faceAngle = Math.PI / 2;   // 当前朝向（平滑插值后的值）
  let monsterGroups = [];
  let portalGroup = null;

  let mazeRef = null;
  let clock = 0;
  let ready = false;
  let available = true;

  const CELL = 1;          // 一格 = 1 世界单位
  const WALL_H = 1.6;      // 墙高

  // ==================== 主题 / 皮肤（可在 init 之前设置） ====================

  /**
   * 默认调色板：与 themes.js 的 midnight 一致。
   * 之所以在这里再写一份，是因为模块加载顺序上 Themes 可能还没 apply，
   * 而 3D 随时可能被初始化 —— 必须有一个安全兜底。
   */
  let PALETTE3D = {
    bg: '#070a11',
    wallTop: '#2A3A57',
    wallSide: '#1A2538',
    wallEdge: '#3C5075',
    wallShadow: '#0D131F',
    floor: '#0E1523',
    floorAlt: '#111A2A'
  };

  /** 默认角色皮肤：与 themes.js 的 yogurt 一致 */
  let SKIN3D = {
    body: '#FFD98A',
    bodyDark: '#F5B942',
    accent: '#FF9F43',
    hornStyle: 'short'
  };

  /** 解析 '#rrggbb' / 'rgb(...)' / 'rgba(...)' → THREE.Color */
  function parseColor(s, fallback) {
    const fb = new THREE.Color(fallback || 0x222222);
    if (!s) return fb;
    const str = String(s).trim();
    try {
      if (str.charAt(0) === '#') return new THREE.Color(str);
      const m = /rgba?\(([^)]+)\)/i.exec(str);
      if (m) {
        const p = m[1].split(',').map((v) => parseFloat(v.trim()));
        if (p.length >= 3 && isFinite(p[0])) {
          return new THREE.Color(p[0] / 255, p[1] / 255, p[2] / 255);
        }
        return fb;
      }
      return new THREE.Color(str);
    } catch (e) {
      return fb;
    }
  }

  /** 感知亮度（0~1），用于灯光强度自适应 */
  function luma(c) {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  }

  /**
   * 3D 反照率提亮
   * ------------------------------------------------------------
   * 为什么需要这一步：
   *   2D / 2.5D 是"无光照模型"——主题里的 floor 色 (#0E1523) 直接画出来
   *   就是玩家看到的最终颜色，所以它本来就是"暗的、留给迷雾的"。
   *   3D 走的是 Lambert 光照：最终亮度 = albedo × 光强。
   *   把同一个 #0E1523 当 albedo，无论怎么打光都只剩一片黑 —— 路根本看不见。
   *
   * 所以按主题亮度反推一个提亮系数：越暗的主题提得越多，
   * 用乘法而不是混白，这样色相（午夜蓝的蓝、苔藓的绿）不会被冲成灰。
   */
  function liftForLighting(color, bgLuma) {
    const t = Math.min(1, bgLuma / 0.6);
    const k = 1 + Math.pow(1 - t, 1.2) * 2.0;   // 亮主题 k≈1，暗主题 k≈2.6
    return color.multiplyScalar(k);
  }

  /**
   * 应用场景主题 —— 2D / 2.5D 的 applyTheme 由 render.js 转发调用
   * 未初始化时只缓存，init() 里会补应用一次，因此调用时机无所谓。
   */
  function applyTheme(palette) {
    if (!palette) return;
    PALETTE3D = Object.assign({}, PALETTE3D, palette);
    if (!ready || !scene) return;
    applySceneColors();
    recolorInstances();
  }

  /** 应用角色皮肤（身体 / 角 / 尾巴配色） */
  function applySkin(skin) {
    if (!skin) return;
    SKIN3D = Object.assign({}, SKIN3D, skin);
    if (!playerMats) return;   // 还没建角色 → build 时自然会用到新值

    const body = parseColor(SKIN3D.body, 0xffd98a);
    const accent = parseColor(SKIN3D.accent || SKIN3D.bodyDark, 0xff9f43);
    playerMats.body.color.copy(body);
    playerMats.accent.color.copy(accent);
    playerMats.body.needsUpdate = true;
    playerMats.accent.needsUpdate = true;
    if (playerMats.ring) {
      playerMats.ring.color.copy(body);
      playerMats.ring.needsUpdate = true;
    }

    // 角型：long 时把圆锥拉长，让"夜行龙 / 熔岩龙"不只是换个色
    const hs = SKIN3D.hornStyle === 'long' ? 1.7 : 1;
    for (const h of playerHorns) h.scale.set(1, hs, 1);
    // 四肢跟随 accent，否则换皮肤后手臂还是旧颜色
    if (playerMats.limbs) {
      playerMats.limbs.color.copy(accent);
      playerMats.limbs.needsUpdate = true;
    }
  }

  /** 背景 / 雾 / 灯光：跟随主题 */
  function applySceneColors() {
    const bg = parseColor(PALETTE3D.bg, 0x070a11);
    // fog 键只有部分主题提供（如 daylight 的 rgba(...)），没有就退回背景色
    const fogC = parseColor(PALETTE3D.fog || PALETTE3D.bg, bg.getHex());

    scene.background = bg;
    if (scene.fog) scene.fog.color.copy(fogC);

    // 灯光强度随主题亮度自适应：
    // 暗主题（午夜蓝）压低环境光 → 只有玩家身边亮，"黑暗迷宫"的味道才出来；
    // 亮主题（晴石庭院）提亮 → 整体通透明快，不压抑。
    const lum = luma(bg);
    if (ambient) ambient.intensity = 0.8 + lum * 0.75;
    if (hemi) hemi.intensity = 0.5 + lum * 0.6;

    // 半球光的上下色也跟随主题，暗主题冷、亮主题暖
    if (hemi) {
      hemi.color.copy(parseColor(PALETTE3D.wallEdge || PALETTE3D.wallTop, 0xfff8ec));
      hemi.groundColor.copy(parseColor(PALETTE3D.floor, 0xbfae92));
    }

    // 自发光：给暗主题一个"最低可见度"，避免无光处纯黑看不出地板轮廓
    const floorC = parseColor(PALETTE3D.floor, 0x0e1523);
    const sideC = parseColor(PALETTE3D.wallSide, 0x1a2538);
    if (floorMat) floorMat.emissive.copy(floorC).multiplyScalar(0.26);
    if (wallMat) wallMat.emissive.copy(sideC).multiplyScalar(0.22);

    // 迷宫外的地平：比地板再暗一档，既有底色又不抢主体
    if (groundMat) {
      groundMat.color.copy(liftForLighting(parseColor(PALETTE3D.floor, 0x0e1523), lum))
        .multiplyScalar(0.26);
    }
  }

  /** 只改实例颜色，不重建几何 —— 切主题零卡顿 */
  function recolorInstances() {
    if (!floorMesh || !wallMesh) return;

    const bgLuma = luma(parseColor(PALETTE3D.bg, 0x070a11));

    // 先取原始主题色，再按需提亮（clone 避免改坏 PALETTE3D 里的缓存值）
    const fa = liftForLighting(parseColor(PALETTE3D.floor, 0x0e1523), bgLuma);
    const fb = liftForLighting(parseColor(PALETTE3D.floorAlt || PALETTE3D.floor, 0x111a2a), bgLuma);
    const top = liftForLighting(parseColor(PALETTE3D.wallTop, 0x2a3a57), bgLuma);
    // 墙顶本就受光，再乘 1.0；侧面由顶点色压暗，不需要额外处理

    const tmp = new THREE.Color();
    floorCells.forEach(([x, y], i) => {
      tmp.copy((x + y) % 2 === 0 ? fa : fb);
      floorMesh.setColorAt(i, tmp);
    });
    if (floorMesh.instanceColor) floorMesh.instanceColor.needsUpdate = true;

    wallCells.forEach(([x, y], i) => {
      // 轻微色差，避免整片墙死板
      const v = 0.9 + ((x * 7 + y * 13) % 5) * 0.045;
      tmp.copy(top).multiplyScalar(v);
      wallMesh.setColorAt(i, tmp);
    });
    if (wallMesh.instanceColor) wallMesh.instanceColor.needsUpdate = true;
  }

  // ==================== 生命周期 ====================

  let ambient = null;
  let hemi = null;
  let keyLight = null;
  let monsterLight = null;

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
    // 背景 / 雾的具体颜色交给 applySceneColors 按当前主题填充
    scene.background = parseColor(PALETTE3D.bg, 0x070a11);
    scene.fog = new THREE.Fog(0x070a11, 4, 13);

    camera = new THREE.PerspectiveCamera(52, 1, 0.1, 120);

    // ---- 光照：环境光打底 + 跟随玩家的暖色点光 ----
    ambient = new THREE.AmbientLight(0xfff4e0, 1.5);
    scene.add(ambient);

    hemi = new THREE.HemisphereLight(0xfff8ec, 0xbfae92, 1.1);
    scene.add(hemi);

    keyLight = new THREE.PointLight(0xfff0c8, 1.6, 14, 1.0);
    scene.add(keyLight);

    monsterLight = new THREE.PointLight(0xff4d6d, 1.4, 6, 1.5);
    scene.add(monsterLight);

    ready = true;

    // init 之前若已换过主题 / 皮肤，在这里补应用
    applySceneColors();
    return true;
  }

  /** 显示/隐藏 3D 图层（切到 2D 时必须隐藏，否则会盖住画面） */
  function setVisible(v) {
    if (canvas) canvas.style.display = v ? 'block' : 'none';
  }

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

  /**
   * 给 BoxGeometry 烘焙「顶面亮、侧面暗」的顶点明暗
   * ------------------------------------------------------------
   * 为什么用顶点色而不是多个材质：
   *   InstancedMesh 只有一个材质槽，没法按面分配不同颜色；
   *   而顶点色会与 instanceColor 相乘 —— 于是 instanceColor 只管"主题色"，
   *   顶点色只管"明暗层次"，两者解耦，换主题时只需改前者。
   *
   * BoxGeometry 的面顺序固定为 px, nx, py, ny, pz, nz，每个面 4 个顶点：
   *   py(8~11) 是顶面 → 最亮；ny(12~15) 是底面 → 最暗。
   */
  function bakeFaceShading(geo) {
    const pos = geo.attributes.position;
    const n = pos.count;                 // BoxGeometry(1,1,1) 为 24
    const colors = new Float32Array(n * 3);
    const faceShade = [0.72, 0.52, 1.0, 0.34, 0.86, 0.62];  // px nx py ny pz nz
    for (let i = 0; i < n; i++) {
      const face = Math.floor(i / 4);
      const s = faceShade[face] != null ? faceShade[face] : 1;
      colors[i * 3] = s;
      colors[i * 3 + 1] = s;
      colors[i * 3 + 2] = s;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  /**
   * 构建迷宫几何体
   * 用 InstancedMesh：所有地板是一个 mesh，所有墙是一个 mesh
   */
  function build(maze) {
    if (!ready) return;
    mazeRef = maze;

    // 清空旧对象
    if (floorMesh) { scene.remove(floorMesh); floorMesh.geometry.dispose(); floorMesh = null; }
    if (wallMesh) { scene.remove(wallMesh); wallMesh.geometry.dispose(); wallMesh = null; }
    if (playerGroup) { scene.remove(playerGroup); playerGroup = null; }
    // 角色被重建时旧的尾巴/四肢引用要一起清掉，否则会指向上一个场景
    playerBody = null; playerTail = null; playerArms = []; playerLegs = [];
    for (const g of monsterGroups) scene.remove(g);
    monsterGroups = [];
    if (portalGroup) { scene.remove(portalGroup); portalGroup = null; }
    if (groundPlane) { scene.remove(groundPlane); groundPlane.geometry.dispose(); groundPlane = null; }

    floorCells = [];
    wallCells = [];
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (maze.grid[y][x] === 1) wallCells.push([x, y]);
        else floorCells.push([x, y]);
      }
    }

    // ---- 地平：铺满整个视野，让"迷宫之外"也是地面而不是虚空 ----
    groundMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
    groundPlane = new THREE.Mesh(new THREE.PlaneGeometry(maze.w + 80, maze.h + 80), groundMat);
    groundPlane.rotation.x = -Math.PI / 2;
    groundPlane.position.set(maze.w / 2, -0.16, maze.h / 2);
    scene.add(groundPlane);

    // ---- 地板 ----
    const fGeo = new THREE.BoxGeometry(CELL * 0.98, 0.1, CELL * 0.98);
    // color 保持白色：最终颜色 = material.color × vertexColor × instanceColor
    floorMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x000000 });
    floorMesh = new THREE.InstancedMesh(fGeo, floorMat, floorCells.length);
    floorMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const d = new THREE.Object3D();
    floorCells.forEach(([x, y], i) => {
      d.position.set(x, -0.05, y);
      d.updateMatrix();
      floorMesh.setMatrixAt(i, d.matrix);
    });
    scene.add(floorMesh);

    // ---- 墙体 ----
    const wGeo = new THREE.BoxGeometry(CELL, WALL_H, CELL);
    bakeFaceShading(wGeo);   // 顶面亮 / 侧面暗，明暗与主题色解耦
    wallMat = new THREE.MeshLambertMaterial({
      color: 0xffffff, emissive: 0x000000, vertexColors: true
    });
    wallMesh = new THREE.InstancedMesh(wGeo, wallMat, wallCells.length);
    wallMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    wallCells.forEach(([x, y], i) => {
      d.position.set(x, WALL_H / 2, y);
      d.updateMatrix();
      wallMesh.setMatrixAt(i, d.matrix);
    });
    scene.add(wallMesh);

    // 颜色（背景 / 雾 / 灯光 / 实例色）统一按当前主题填一次
    applySceneColors();
    recolorInstances();

    // ---- 玩家：小球身体 + 头 + 两只角 + 尾巴 ----
    playerGroup = buildDragon3D();
    // 俯视角下角色只有头顶可见，放大一点才看得清皮肤配色
    playerGroup.scale.set(1.3, 1.3, 1.3);
    scene.add(playerGroup);
    applySkin();           // 立刻套用当前皮肤

    // ---- 出口：发光圆柱（金色恒定，保证任何主题下都一眼可辨） ----
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

    resize();
  }

  /** 用基础几何体拼一只 Q 版小龙（颜色来自 SKIN3D） */
  function buildDragon3D() {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshLambertMaterial({ color: parseColor(SKIN3D.body, 0xffd98a) });
    const accentMat = new THREE.MeshLambertMaterial({
      color: parseColor(SKIN3D.accent || SKIN3D.bodyDark, 0xff9f43)
    });
    playerMats = { body: bodyMat, accent: accentMat };
    playerHorns = [];
    playerArms = [];
    playerLegs = [];

    // 脚下光环：固定俯视角下只能看到头顶，加一圈皮肤色光环，
    // 让"角色选择"在 3D 里也一眼可辨（同时强化"你在这里"的定位感）
    const ringMat = new THREE.MeshBasicMaterial({
      color: parseColor(SKIN3D.body, 0xffd98a),
      transparent: true, opacity: 0.55, side: THREE.DoubleSide
    });
    // 记录基准透明度：隐身逻辑会把材质 opacity 改成 0.28，
    // 恢复时必须回到 0.55 而不是 1（否则光环变实心，盖住地板）
    ringMat.userData.baseOpacity = 0.55;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.42, 24), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.035;
    g.add(ring);
    playerMats.ring = ringMat;

    // 躯干下面的容器：所有"会摆动"的部件都挂在 b 上，
    // 朝向只改 g.rotation.y，摆尾/摆臂只改 b 内部的 rotation
    const b = new THREE.Group();
    g.add(b);
    playerBody = b;

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 12), bodyMat);
    body.position.y = 0.2;
    body.scale.set(1, 0.92, 1);
    b.add(body);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 14), bodyMat);
    head.position.y = 0.52;
    b.add(head);

    // 眼睛（+Z 为正面）
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x121a26 });
    for (const sx of [-0.1, 0.1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), eyeMat);
      eye.position.set(sx, 0.56, 0.22);
      b.add(eye);
    }

    // 角
    for (const sx of [-0.12, 0.12]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 8), accentMat);
      horn.position.set(sx, 0.74, 0);
      b.add(horn);
      playerHorns.push(horn);
    }

    // ---- 尾巴：绕根部枢轴摆动 ----
    // 用一个空组当"关节"，尾巴网格在组内偏移，
    // 这样旋转 pivot 时尾巴是绕着屁股转，而不是绕自己中心转。
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.2, -0.18);
    b.add(tailPivot);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.34, 8), accentMat);
    tail.position.set(0, 0.02, -0.15);
    tail.rotation.x = -Math.PI / 2.15;   // 向后上方翘起
    tailPivot.add(tail);
    // 尾尖小球，摆动时更容易看出来
    const tailTip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), accentMat);
    tailTip.position.set(0, 0.085, -0.31);
    tailPivot.add(tailTip);
    playerTail = tailPivot;

    // ---- 四肢：走路时前后摆动，方向感更明确 ----
    const limbMat = new THREE.MeshLambertMaterial({
      color: parseColor(SKIN3D.accent || SKIN3D.bodyDark, 0xff9f43)
    });
    playerMats.limbs = limbMat;

    for (const sx of [-0.11, 0.11]) {
      const arm = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), limbMat);
      arm.position.set(sx, 0.18, 0.06);
      arm.userData.baseZ = arm.position.z;
      b.add(arm);
      playerArms.push(arm);
    }
    for (const sx of [-0.1, 0.1]) {
      const leg = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), limbMat);
      leg.position.set(sx, 0.045, -0.02);
      b.add(leg);
      playerLegs.push(leg);
    }

    return g;
  }

  /** 怪物用暗紫色刺球表示（保持高辨识度，不跟随主题） */
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
      build(state.maze);
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

      // ---- 朝向 ----
      // 模型眼睛在 +Z 面。世界坐标里 (dir.x, dir.y) 对应 (X, Z)。
      // 要让 +Z 转到 (dir.x, dir.y)，绕 Y 轴需要 atan2(dir.x, dir.y)。
      // 用最短弧插值，避免从右转左时绕一大圈（170° → 190° 要跨过 ±π）。
      const targetAngle = Math.atan2(p.dir.x, p.dir.y);
      let delta = targetAngle - faceAngle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      faceAngle += delta * Math.min(1, dt * 14);
      playerGroup.rotation.y = faceAngle;

      // 走路上下浮动
      const bob = Math.sin((state.walkPhase || 0) * Math.PI * 2) * 0.045;
      playerGroup.position.y = Math.abs(bob);

      // ---- 尾巴摆动 ----
      // 双频叠加：主摆动 + 略快的次级摆动，看起来不像机械钟摆。
      // 静止时也在轻微摆（尾巴不该是死的），移动时幅度更大。
      const moving = p.moveT < 1 ? 1 : 0;
      const t = clock;
      const sway = Math.sin(t * (moving ? 7.5 : 2.2)) * (moving ? 0.42 : 0.16)
                 + Math.sin(t * 3.1) * 0.07;
      if (playerTail) {
        playerTail.rotation.y = sway;
        playerTail.rotation.x = -0.12 + Math.sin(t * 2.4) * 0.06;
      }
      // 四肢前后摆动（与步态相位同步）
      const swing = Math.sin((state.walkPhase || 0) * Math.PI * 2) * (moving ? 0.1 : 0);
      playerArms.forEach((a, i) => { a.position.z = a.userData.baseZ + (i ? -swing : swing); });
      playerLegs.forEach((l, i) => { l.position.z = (i ? -swing : swing) * 1.4; });

      // 隐身中：整体半透明（光环回落到自己的基准透明度，不能一律设 1）
      const ghost = state.stealthT > 0;
      playerGroup.traverse((o) => {
        if (o.isMesh && o.material) {
          const base = (o.material.userData && o.material.userData.baseOpacity) || 1;
          o.material.transparent = true;
          o.material.opacity = ghost ? 0.28 : base;
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
    floorMesh = wallMesh = null;
    floorCells = wallCells = [];
  }

  return {
    init, draw, build, resize, dispose, isSupported, setVisible,
    applyTheme, applySkin,
    get ready() { return ready; },
    /** 调试用：暴露相机以便验证"是否旋转" */
    get camera() { return camera; },
    /** 调试用：暴露当前 3D 调色板，便于验证主题是否真的下发了 */
    get palette() { return PALETTE3D; },
    get skin() { return SKIN3D; }
  };
})();
