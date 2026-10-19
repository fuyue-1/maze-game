/**
 * main.js —— UI 编排层
 * ------------------------------------------------------------
 * 职责：把 Game 状态机 / Renderer / BmobRank 三块粘合起来，
 * 处理 DOM 事件、弹窗切换、排行榜渲染、localStorage 最高分。
 * 这一层不含任何算法，只做"翻译"：把游戏事件翻译成界面变化。
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const BEST_KEY_PREFIX = 'maze_best_';

  // 排行榜展示条数：单一来源，避免"云端取 30、界面写 Top 10"这种不一致
  const TOP_N = (typeof BmobRank !== 'undefined' && BmobRank.CONFIG && BmobRank.CONFIG.TOP_N) || 30;

  // 当前选中的难度
  let currentDiff = 'normal';
  // 本局结果缓存（提交成绩时用）
  let lastResult = null;
  // 排行榜当前筛选
  let rankFilter = '';
  // 是否已提交（避免重复提交）
  let submitted = false;
  // 结算弹窗延时器（重新开始时必须清掉，否则会把旧弹窗弹到新局上）
  let resultTimer = null;

  /** 清理待弹出的结算弹窗 */
  function clearResultTimer() {
    if (resultTimer) {
      clearTimeout(resultTimer);
      resultTimer = null;
    }
  }

  // ==================== 工具函数 ====================

  /** 秒 → 00:00.0 */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const d = Math.floor((sec * 10) % 10);
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + d;
  }

  /** 秒 → 纯数值（保留 2 位） */
  function fmtSec(sec) {
    return (Math.round(sec * 100) / 100).toFixed(2);
  }

  function show(el) { if (el) el.classList.remove('hidden'); }
  function hide(el) { if (el) el.classList.add('hidden'); }

  let toastTimer = null;
  function toast(msg, ms = 2000) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /** 昵称模板（首次进入给个默认值，降低提交门槛） */
  function randomNick() {
    const a = ['迷路的', '深夜的', '勇敢的', '饥饿的', '沉默的', '幸运的'];
    const b = ['小蜜蜂', '旅人', '矿工', '猫头鹰', '探险家', '幽灵'];
    return a[Math.floor(Math.random() * a.length)] + b[Math.floor(Math.random() * b.length)];
  }

  // ==================== 视角说明（每个维度一段玩法） ====================

  /**
   * 三种视角各自的读法。
   * 放在数据里而不是写死在 HTML：
   *   1. 开始页 / 外观面板 / 说明弹窗三处共用同一份文案，改一处即全改
   *   2. 技能可用性（hasHint）跟游戏逻辑保持单一来源，避免"说明说能用、实际不能用"
   */
  const VIEW_GUIDES = {
    '2d': {
      name: '2D 俯视',
      tag: '▦ 2D 俯视',
      brief: '整张迷宫平铺在屏幕上，方向与按键完全一致，迷路时最不容易看反。',
      hasHint: true,
      points: [
        '键盘上下左右 = 迷宫上下左右，不用换算',
        '迷雾只遮未探索区，走过的路会留暗影',
        '路线提示最好用：整条解能一次看全'
      ]
    },
    'iso': {
      name: '2.5D 等距',
      tag: '◈ 2.5D 等距',
      brief: '斜 45° 俯视，墙壁有高度。屏幕左上 = 迷宫左上，两个斜向就是两个键的组合。',
      hasHint: true,
      points: [
        '往屏幕左上走 = 同时按 W + A',
        '远处会被高墙挡住，注意墙后的岔口',
        '路线提示可用：地上会铺出金色引路石'
      ]
    },
    '3d': {
      name: '3D 立体',
      tag: '◆ 3D 立体',
      brief: '真实第一人称高度的俯视，屏幕永远"上北下南"，镜头不跟随转动，方向键就是地图方向。',
      hasHint: false,
      points: [
        '视角低，只能看清身前几格，靠小地图辨向',
        '适合追求沉浸感和紧张感',
        '此视角不提供路线提示（远处路径必被墙遮住）'
      ]
    }
  };

  function guideOf(mode) {
    return VIEW_GUIDES[mode] || VIEW_GUIDES['2d'];
  }

  /** 开始页的极简一行说明 */
  function renderStartGuide(mode) {
    const g = guideOf(mode);
    const tag = $('start-vg-tag');
    const txt = $('start-vg-text');
    if (tag) tag.textContent = g.tag;
    if (txt) txt.textContent = g.brief;
  }

  /** 外观面板里的详细说明（标题 + 技能可用性 + 要点列表） */
  function renderCustomGuide(mode) {
    const g = guideOf(mode);
    const tag = $('custom-vg-tag');
    const skill = $('custom-vg-skill');
    const list = $('custom-vg-list');
    if (tag) tag.textContent = g.tag;
    if (skill) {
      skill.textContent = g.hasHint ? '路线提示：可用' : '路线提示：此视角不可用';
      skill.className = 'vg-skill' + (g.hasHint ? '' : ' is-off');
    }
    if (list) {
      list.innerHTML = g.points.map((p) => '<li>' + p + '</li>').join('');
    }
  }

  // ==================== 本地最高分 ====================

  function getBest(diffKey) {
    try {
      const v = localStorage.getItem(BEST_KEY_PREFIX + diffKey);
      return v ? parseFloat(v) : null;
    } catch (e) {
      return null;
    }
  }

  /** @returns {boolean} 是否刷新记录 */
  function updateBest(diffKey, timeSec) {
    const prev = getBest(diffKey);
    if (prev === null || timeSec < prev) {
      try {
        localStorage.setItem(BEST_KEY_PREFIX + diffKey, String(timeSec));
      } catch (e) { /* 忽略 */ }
      return true;
    }
    return false;
  }

  // ==================== 界面切换 ====================

  function hideAllOverlays() {
    ['overlay-start', 'overlay-pause', 'overlay-win', 'overlay-lose'].forEach((id) => hide($(id)));
  }

  function goHome() {
    hideAllOverlays();
    $('minimap-wrap').classList.add('hidden');
    $('btn-stealth').classList.add('hidden');
    $('btn-hint').classList.add('hidden');
    show($('overlay-start'));
    $('hud-time').textContent = '00:00.0';
    $('hud-moves').textContent = '0';
    $('hud-diff').textContent = Game.DIFFICULTY[currentDiff].name;
    // 回首页时把技能倒计时一起清掉，避免下次开局按钮还显示"18s"
    updateSkillUI();
  }

  function startGame() {
    submitted = false;
    lastResult = null;
    clearResultTimer();
    hideAllOverlays();
    $('input-username').value = '';
    $('submit-status').textContent = '';
    $('submit-status').className = 'submit-status';

    Game.start(currentDiff);
    // 新迷宫的静态层已由 Game 触发 layout 重建，
    // 这里再同步一次主题，确保换过主题后新局用的是最新配色
    Themes.apply();

    // 显示小地图并按其迷宫尺寸重排
    $('minimap-wrap').classList.remove('hidden');
    Minimap.layout(Game.getState().maze);

    $('hud-diff').textContent = Game.DIFFICULTY[currentDiff].name;
    $('hud-time').textContent = '00:00.0';
    $('hud-moves').textContent = '0';
    $('btn-submit').disabled = false;
    $('btn-submit').textContent = '提交成绩';
    $('btn-stealth').classList.remove('hidden');
    // 路线提示按钮：3D 视角下也显示，但标为不可用（点了会解释原因）
    $('btn-hint').classList.remove('hidden');
    updateSkillUI();
  }

  // ==================== 排行榜渲染 ====================

  async function renderRank(size) {
    rankFilter = size || '';
    $('rank-list').innerHTML = '<div class="rank-empty">加载中…</div>';
    $('rank-source').textContent = '';
    $('rank-scope').textContent = 'Top ' + TOP_N;

    // 标签选中态
    document.querySelectorAll('#rank-tabs .tab').forEach((t) => {
      t.classList.toggle('is-active', t.dataset.size === rankFilter);
    });

    let res;
    try {
      res = await BmobRank.top(TOP_N, rankFilter);
    } catch (e) {
      res = { ok: false, source: 'local', list: [] };
    }

    const list = res.list || [];

    if (list.length === 0) {
      $('rank-list').innerHTML =
        '<div class="rank-empty">还没有人上榜<br>成为第一个逃出迷宫的人</div>';
    } else {
      $('rank-list').innerHTML = list.map((r, i) => {
        const name = escapeHtml(r.username || '匿名');
        const diff = escapeHtml(r.size || '-');
        const t = typeof r.time === 'number' ? fmtSec(r.time) + 's' : '-';
        const me = r.username === $('input-username').value.trim() ? ' is-me' : '';
        return (
          '<div class="rank-row' + me + '" style="animation-delay:' + (i * 0.035) + 's">' +
            '<span class="rank-no">' + (i + 1) + '</span>' +
            '<span class="rank-name">' + name + '</span>' +
            '<span class="rank-diff">' + diff + '</span>' +
            '<span class="rank-time">' + t + '</span>' +
          '</div>'
        );
      }).join('');
    }

    // 数据来源标注：诚实地告诉用户这是云端还是本地
    if (res.source === 'cloud') {
      $('rank-source').textContent = '数据来源：Bmob 云端数据库';
    } else if (res.source === 'merged') {
      $('rank-source').textContent = '云端暂无记录，以下为本机成绩';
    } else {
      $('rank-source').textContent = BmobRank.isConfigured()
        ? '云端暂不可用，当前显示本机成绩（已自动降级）'
        : '当前为本机成绩 · 配置 Bmob 密钥后可同步到云端';
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ==================== 成绩提交 ====================

  async function submitScore() {
    if (!lastResult || submitted) return;

    const input = $('input-username');
    const name = input.value.trim();
    const status = $('submit-status');

    if (name.length === 0) {
      status.textContent = '请先输入昵称';
      status.className = 'submit-status err';
      input.focus();
      return;
    }
    if (name.length > 12) {
      status.textContent = '昵称最多 12 个字符';
      status.className = 'submit-status err';
      return;
    }

    const btn = $('btn-submit');
    btn.disabled = true;
    btn.textContent = '提交中…';
    status.textContent = '';
    status.className = 'submit-status';

    try {
      const res = await BmobRank.submit({
        username: name,
        time: lastResult.time,
        size: lastResult.difficulty
      });

      submitted = true;
      if (res.source === 'cloud') {
        status.textContent = '✓ 已提交到云端排行榜';
        status.className = 'submit-status ok';
        toast('成绩已上榜');
      } else {
        status.textContent = '✓ 已记录到本机（云端暂不可用）';
        status.className = 'submit-status ok';
        toast('成绩已保存到本机');
      }
      btn.textContent = '已提交';

      // 记住昵称，下次免输入
      try { localStorage.setItem('maze_nick', name); } catch (e) {}

      // 提示是否进了前 10
      const top = await BmobRank.top(TOP_N, lastResult.difficulty);
      const rank = top.list.findIndex((r) => r.username === name && Math.abs(r.time - lastResult.time) < 0.011);
      if (rank >= 0) {
        status.textContent += ' · 当前第 ' + (rank + 1) + ' 名';
      } else if (top.list.length >= TOP_N) {
        // 榜单已满且没找到自己 —— 明确告诉玩家名次，别让人以为提交丢了
        status.textContent += ' · 暂未进入前 ' + TOP_N + ' 名';
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '提交成绩';
      status.textContent = '提交失败：' + (e.message || '网络异常');
      status.className = 'submit-status err';
    }
  }

  // ==================== 外观设置面板 ====================

  let previewRaf = 0;
  let previewClock = 0;
  let previewLast = 0;

  /**
   * 构建外观面板：皮肤卡片 + 主题卡片
   * 卡片内容全部由 Themes 的数据驱动，加新皮肤/主题不用改这里
   */
  function buildCustomPanel() {
    const skinGrid = $('skin-grid');
    const themeGrid = $('theme-grid');
    const cur = Themes.get();

    // ---- 角色外形 ----
    skinGrid.innerHTML = Object.values(Themes.SKINS).map((sk) => `
      <button class="skin-card${sk.id === cur.skin ? ' is-active' : ''}" data-skin="${sk.id}">
        <span class="swatch-duo">
          <i style="background:${sk.swatch[0]}"></i>
          <i style="background:${sk.swatch[1]}"></i>
        </span>
        <span class="skin-info">
          <span class="skin-name">${sk.name}</span>
          <span class="skin-desc">${sk.desc}</span>
        </span>
      </button>
    `).join('');

    // ---- 场景主题 ----
    themeGrid.innerHTML = Object.values(Themes.SCENE_THEMES).map((th) => `
      <button class="theme-card${th.id === cur.theme ? ' is-active' : ''}" data-theme="${th.id}">
        <span class="swatch-duo">
          <i style="background:${th.swatch[0]}"></i>
          <i style="background:${th.swatch[1]}"></i>
        </span>
        <span class="skin-info">
          <span class="skin-name">${th.name}</span>
          <span class="skin-desc">${th.desc}</span>
        </span>
      </button>
    `).join('');

    // ---- 视角 ----
    markActive('view-switch', 'data-view', cur.view || 'iso');
    renderCustomGuide(cur.view || 'iso');
    renderStartGuide(cur.view || 'iso');
  }

  function markActive(group, attr, value) {
    document.querySelectorAll(`#${group} .is-active`).forEach((el) => el.classList.remove('is-active'));
    const el = document.querySelector(`#${group} [${attr}="${value}"]`);
    if (el) el.classList.add('is-active');
  }

  /**
   * 预览画布：画一只正在呼吸/摆尾的小萌龙
   * 用独立 rAF 循环，只在面板打开时运行，关闭即停止（省电）
   */
  function drawPreview(dt) {
    const cv = $('preview-canvas');
    if (!cv) return;
    const c = cv.getContext('2d');
    const W = cv.width;
    const H = cv.height;

    previewClock += dt;

    // 背景：取当前主题的地板色，营造"在迷宫里"的感觉
    const pal = Themes.getTheme().palette;
    c.fillStyle = pal.bg;
    c.fillRect(0, 0, W, H);

    // 简易地砖背景
    const tile = 60;
    for (let y = 0; y < H / tile + 1; y++) {
      for (let x = 0; x < W / tile + 1; x++) {
        c.fillStyle = (x + y) % 2 === 0 ? pal.floor : pal.floorAlt;
        c.fillRect(x * tile, y * tile, tile, tile);
      }
    }

    // 地面上放一块石墙示意
    c.fillStyle = pal.wallSide;
    c.fillRect(0, 0, tile * 3, tile);
    c.fillStyle = pal.wallTop;
    c.fillRect(0, 0, tile * 3, tile * 0.3);

    // 角色呼吸 + 摇摆
    const breathe = Math.sin(previewClock * 2) * 0.5 + 0.5;
    Sprites.drawDragon(c, W * 0.5, H * 0.56, H * 0.92, {
      dir: { x: 1, y: 0 },
      walk: (previewClock * 0.42) % 1,
      scared: 0
    });

    // 更新文字标签
    const lbl = $('preview-label');
    if (lbl) {
      const sk = Themes.getSkin();
      const th = Themes.getTheme();
      lbl.textContent = sk.name + ' · ' + th.name;
    }
  }

  function startPreview() {
    stopPreview();
    previewLast = performance.now();
    const loop = (now) => {
      const dt = Math.min(0.05, (now - previewLast) / 1000);
      previewLast = now;
      drawPreview(dt);
      previewRaf = requestAnimationFrame(loop);
    };
    previewRaf = requestAnimationFrame(loop);
  }

  function stopPreview() {
    if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
  }

  function openCustom() {
    if (Game.getState().phase === 'playing') Game.pause();
    buildCustomPanel();
    show($('modal-custom'));
    // 等面板完成布局再启动预览，否则 canvas 尺寸为 0
    requestAnimationFrame(() => startPreview());
  }

  function closeCustom() {
    hide($('modal-custom'));
    stopPreview();
  }

  // ==================== 事件绑定 ====================

  function bindEvents() {
    // ---- 难度选择 ----
    $('diff-group').addEventListener('click', (e) => {
      const card = e.target.closest('.diff-card');
      if (!card) return;
      currentDiff = card.dataset.diff;
      document.querySelectorAll('.diff-card').forEach((c) => {
        c.classList.toggle('is-active', c === card);
      });
      $('hud-diff').textContent = Game.DIFFICULTY[currentDiff].name;
    });

    // ---- 开始 ----
    $('btn-start').addEventListener('click', startGame);

    // ---- 暂停 ----
    $('btn-pause').addEventListener('click', () => {
      const st = Game.getState();
      if (st.phase === 'idle' || st.phase === 'win' || st.phase === 'lose') {
        toast('请先开始游戏');
        return;
      }
      Game.togglePause();
    });

    $('btn-resume').addEventListener('click', () => {
      Game.resume();
      hide($('overlay-pause'));
    });

    $('btn-restart').addEventListener('click', startGame);
    $('btn-again').addEventListener('click', startGame);
    $('btn-retry').addEventListener('click', startGame);
    $('btn-back-home').addEventListener('click', goHome);
    $('btn-home-win').addEventListener('click', goHome);

    // ---- 排行榜 ----
    $('btn-rank').addEventListener('click', () => {
      // 打开时暂停游戏，避免玩家在看榜时被怪物抓
      if (Game.getState().phase === 'playing') Game.pause();
      show($('modal-rank'));
      renderRank(rankFilter);
    });

    $('btn-view-rank').addEventListener('click', () => {
      show($('modal-rank'));
      if (lastResult) renderRank(lastResult.difficulty);
      else renderRank('');
    });

    $('rank-tabs').addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      renderRank(tab.dataset.size);
    });

    // ---- 说明 ----
    $('btn-help').addEventListener('click', () => {
      if (Game.getState().phase === 'playing') Game.pause();
      show($('modal-help'));
    });

    // ---- 关闭弹窗（点遮罩或 × ）----
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => {
        const which = el.dataset.close;
        hide($('modal-' + which));
      });
    });

    // ---- 虚拟方向键（触屏）：按住连走 ----
    // 隐身技能按钮：点击触发（手机端主要入口）
    $('btn-stealth').addEventListener('click', () => {
      if (!Game.activateStealth()) {
        const info = Game.stealthInfo();
        if (info.cd > 0) toast('冷却中 · 还剩 ' + info.cd + ' 秒', 1000);
      }
    });

    // 路线提示按钮
    $('btn-hint').addEventListener('click', tryHint);

    const DIR_VECS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const dpad = $('dpad');
    if (dpad) {
      let repeatTimer = null;
      let activeBtn = null;

      const stopRepeat = () => {
        if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
        if (activeBtn) { activeBtn.classList.remove('is-pressing'); activeBtn = null; }
      };

      dpad.addEventListener('pointerdown', (e) => {
        const btn = e.target.closest('.dpad-btn');
        if (!btn) return;
        e.preventDefault();
        stopRepeat();

        const dir = btn.dataset.dir;
        const [dx, dy] = DIR_VECS[dir];
        activeBtn = btn;
        btn.classList.add('is-pressing');

        // 按下立即走一步，长按每 140ms 连走
        Game.move(dx, dy);
        repeatTimer = setInterval(() => Game.move(dx, dy), 140);
      });

      // 抬起 / 划出 / 取消都要停
      ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => {
        dpad.addEventListener(ev, stopRepeat);
      });
      // 页面失焦兜底
      window.addEventListener('blur', stopRepeat);
    }

    // ---- 外观设置 ----
    $('btn-custom').addEventListener('click', openCustom);
    $('btn-custom-start').addEventListener('click', openCustom);

    $('skin-grid').addEventListener('click', (e) => {
      const card = e.target.closest('[data-skin]');
      if (!card) return;
      Themes.setSkin(card.dataset.skin);
      markActive('skin-grid', 'data-skin', card.dataset.skin);
      toast('已切换：' + Themes.getSkin().name, 1200);
    });

    $('theme-grid').addEventListener('click', (e) => {
      const card = e.target.closest('[data-theme]');
      if (!card) return;
      Themes.setTheme(card.dataset.theme);
      markActive('theme-grid', 'data-theme', card.dataset.theme);
      toast('已切换场景：' + Themes.getTheme().name, 1200);
    });

    $('view-switch').addEventListener('click', (e) => {
      const card = e.target.closest('[data-view]');
      if (!card) return;
      const v = card.dataset.view;
      Themes.setView(v);
      const actual = Game.getViewMode();
      if (actual !== v) {
        toast('当前设备不支持 3D（WebGL 不可用），已使用 2D', 2200);
        Themes.setView(actual);
      } else {
        const names = { '2d': '2D 俯视', 'iso': '2.5D 等距', '3d': '3D 立体' };
        toast('已切换：' + names[v], 1200);
      }
      const nowView = Game.getViewMode();
      markActive('view-switch', 'data-view', nowView);
      // 切视角立即刷新说明与技能可用性，不用等下一帧 tick
      renderCustomGuide(nowView);
      renderStartGuide(nowView);
      updateSkillUI();
    });

    $('btn-reset-look').addEventListener('click', () => {
      Themes.setTheme('midnight');   // 默认主题：午夜蓝
      Themes.setSkin('yogurt');      // 默认角色：奶黄龙
      Themes.setView('2d');          // 默认视角：2D 俯视
      buildCustomPanel();
      renderStartGuide('2d');
      updateSkillUI();
      toast('已恢复默认外观');
    });

    // 关闭外观面板时停止预览循环
    document.querySelectorAll('#modal-custom [data-close]').forEach((el) => {
      el.addEventListener('click', closeCustom);
    });

    // ---- 提交成绩 ----
    $('btn-submit').addEventListener('click', submitScore);
    $('input-username').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitScore();
      e.stopPropagation();
    });

    // 昵称输入框：Game.bindInput 里已有 isTyping() 判断，
    // 聚焦时方向键/空格都交给输入框，不会误触发移动或隐身。
    // （这里不再设置 __mazeInputFocused —— 那个标记没有消费方，属于历史遗留）
  }

  // ==================== 游戏回调 ====================

  /**
   * 技能按钮状态
   * ------------------------------------------------------------
   * 两种技能共用同一套视觉三态：
   *   就绪    —— 正常显示按键提示（空格 / Q）
   *   生效中  —— is-active，呼吸光，右侧显示剩余秒数
   *   冷却中  —— is-cd，灰暗，右侧显示剩余秒数
   * 路线提示多一个"不可用"态（3D 视角），显示灰化的 ✕。
   * 每 tick 调一次，只是几个 DOM 写，60fps 无压力。
   */
  function updateSkillUI() {
    // ---- 隐身 ----
    const sBtn = $('btn-stealth');
    if (sBtn) {
      const s = Game.stealthInfo();
      sBtn.classList.toggle('is-active', s.active);
      sBtn.classList.toggle('is-cd', !s.active && s.cd > 0);
      sBtn.querySelector('.stealth-key').textContent =
        s.active ? s.remain + 's' : (s.cd > 0 ? s.cd + 's' : '空格');
    }

    // ---- 路线提示 ----
    const hBtn = $('btn-hint');
    if (hBtn) {
      const h = Game.hintInfo();
      const off = !h.allowed;
      hBtn.classList.toggle('is-off', off);
      hBtn.classList.toggle('is-active', !off && h.active);
      hBtn.classList.toggle('is-cd', !off && !h.active && h.cd > 0);
      hBtn.querySelector('.stealth-key').textContent = off
        ? '不可用'
        : h.active ? h.remain + 's' : (h.cd > 0 ? h.cd + 's' : 'Q');      hBtn.title = off
        ? '3D 视角不支持路线提示，切到 2D 或 2.5D 即可使用'
        : '高亮通往出口的路线，冷却 30 秒（Q）';
    }
  }

  /** 点击路线提示按钮 */
  function tryHint() {
    const r = Game.revealPath();
    if (r.ok) return;
    if (r.reason === 'view') {
      toast('3D 视角不支持路线提示，切到 2D 或 2.5D', 2000);
    } else if (r.reason === 'cooldown') {
      toast('路线提示冷却中 · 还剩 ' + Game.hintInfo().cd + ' 秒', 1200);
    } else if (r.reason === 'idle') {
      toast('请先开始游戏', 1200);
    }
  }

  function setupGameCallbacks() {
    // 小地图先初始化，Game.init 之后的循环才能调用 Minimap.draw
    Minimap.init($('minimap-canvas'));

    Game.init($('game-canvas'), {
      onTick: (elapsed, moves) => {
        $('hud-time').textContent = fmtTime(elapsed);
        $('hud-moves').textContent = String(moves);
        updateSkillUI();
      },

      onStealth: (on) => {
        if (on) toast('隐身 5 秒 · 怪物看不见你', 1500);
        else toast('隐身结束', 1000);
      },

      onStealthReady: () => {
        toast('隐身技能已就绪（空格）', 1400);
      },

      onHint: ({ steps }) => {
        toast('路线已标出 · 距出口 ' + steps + ' 步', 1800);
      },

      onHintReady: () => {
        toast('路线提示已就绪（Q）', 1400);
      },

      onStateChange: (phase) => {
        if (phase === 'paused') {
          show($('overlay-pause'));
          $('pause-icon').textContent = '▶';
        } else if (phase === 'playing') {
          hide($('overlay-pause'));
          $('pause-icon').textContent = '❚❚';
          // 方向键只在真正操作时出现：开始页/结算页盖着它很碍眼
          $('dpad').classList.remove('hidden');
        } else {
          $('dpad').classList.add('hidden');
        }
      },

      onWin: (result) => {
        lastResult = result;

        const isBest = updateBest(result.difficultyKey, result.time);
        const best = getBest(result.difficultyKey);

        $('win-time').textContent = fmtSec(result.time);
        $('win-moves').textContent = String(result.moves);
        $('win-diff').textContent = result.difficulty;

        if (isBest) {
          $('win-title').textContent = '刷新纪录';
          $('best-line').textContent = '★ 新纪录！';
        } else {
          $('win-title').textContent = '成功逃脱';
          $('best-line').textContent = best !== null ? '本机最佳：' + fmtSec(best) + ' 秒' : '';
        }

        // 预填昵称
        let nick = '';
        try { nick = localStorage.getItem('maze_nick') || ''; } catch (e) {}
        $('input-username').value = nick || randomNick();

        clearResultTimer();
        resultTimer = setTimeout(() => {
          resultTimer = null;
          // 只有当游戏确实还停在 win 状态时才弹，防止已被"再来一局"覆盖
          if (Game.getState().phase === 'win') show($('overlay-win'));
        }, 260);
      },

      onDeadEnd: () => {
        // 首次踩到某个死路：轻提示 + 小地图红叉
        // 用 toast 而不是弹窗，不能打断操作
        toast('死路 · 已在小地图标记', 1600);
      },

      onLose: (result) => {
        lastResult = result;
        $('lose-time').textContent = fmtSec(result.time);
        $('lose-moves').textContent = String(result.moves);

        const lines = [
          '它们在黑暗中找到了你。',
          '再快一步就好了。',
          '这次的路线记下来了吗？'
        ];
        $('lose-desc').textContent = lines[Math.floor(Math.random() * lines.length)];

        clearResultTimer();
        resultTimer = setTimeout(() => {
          resultTimer = null;
          if (Game.getState().phase === 'lose') show($('overlay-lose'));
        }, 320);
      }
    });
  }

  // ==================== 启动 ====================

  function boot() {
    setupGameCallbacks();
    bindEvents();
    goHome();

    // 读取并应用上次保存的外观设置（必须在 Renderer.init 之后）
    Themes.load();
    Themes.apply();
    // 视角模式需在主题之后单独下发（apply 只管配色）
    if (Game.setViewMode) Game.setViewMode(Themes.getView());
    buildCustomPanel();

    // 说明文案按"实际生效的视角"渲染（3D 初始化失败时会回退 2D）
    // 并且要重新 markActive：buildCustomPanel 用的是"用户选的"视角，
    // 若该视角实际不可用（无 WebGL），卡片高亮会和真实状态对不上
    const realView = Game.getViewMode();
    markActive('view-switch', 'data-view', realView);
    renderStartGuide(realView);
    renderCustomGuide(realView);
    updateSkillUI();

    // 排行榜读写走的是 Bmob REST API（原生 fetch），不需要加载 SDK。
    // 这里不再预热 SDK：省掉一个几百 KB 的外部请求，
    // 断网/CDN 被墙时也不会在控制台留下误导性的加载失败。
    if (BmobRank.isConfigured()) {
      console.log('%c排行榜：Bmob 云端已配置（' + BmobRank.CONFIG.TOP_N + ' 条）',
        'color:#38e8b0;font-size:12px');
    }

    // 首次尺寸校准：等字体/布局稳定后再测一次画布尺寸
    setTimeout(() => Renderer.onResize(), 120);

    console.log('%c迷宫逃生', 'color:#38e8b0;font-size:18px;font-weight:700');
    console.log('%c迭代DFS生成 · BFS寻路 · 局部BFS+Bresenham视野', 'color:#64748f;font-size:12px');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
