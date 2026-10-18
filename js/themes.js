/**
 * themes.js —— 场景主题 + 角色外观配置
 * ------------------------------------------------------------
 * 设计目标：把"长什么样"从"怎么画"里彻底剥离。
 *
 *   themes.js      只放数据：几套配色、几个角色外观
 *   render.js      只认 PALETTE 对象，不硬编码颜色
 *   sprites.js     只认 DRAGON 配置对象，不硬编码颜色/体型
 *
 * 好处：加一套主题 = 加一个对象，不改任何绘制代码。
 * 这也是答辩时可以讲的分层设计。
 */

const Themes = (function () {
  'use strict';

  // ==================== 场景主题 ====================
  // 每套主题定义：背景、墙体三色、地板两色、轨迹色
  const SCENE_THEMES = {
    daylight: {
      id: 'daylight',
      name: '晴石庭院',
      desc: '明亮浅石，暖阳柔和（默认）',
      swatch: ['#e8dcc4', '#c4b49a', '#a89878'],
      palette: {
        bg: '#d9cfba',
        wallTop: '#e8dcc4',
        wallSide: '#c4b49a',
        wallEdge: '#f5ecd8',
        wallShadow: '#a89878',
        floor: '#b8ab90',
        floorAlt: '#c2b69c',
        floorLine: 'rgba(120,100,70,0.10)',
        trail: 'rgba(255,244,214,0.34)',
        trailCore: 'rgba(255,248,226,0.78)',
        fog: 'rgba(214,205,186,1)',
        explored: 'rgba(150,140,120,0.34)'
      }
    },
    dungeon: {
      id: 'dungeon',
      name: '石砌地牢',
      desc: '真实石墙 + 火把暖光',
      swatch: ['#8a7355', '#4a3c2a', '#241c10'],
      palette: {
        bg: '#0e0b07',
        wallTop: '#8a7355',
        wallSide: '#4a3c2a',
        wallEdge: '#a58a64',
        wallShadow: '#171008',
        floor: '#241c10',
        floorAlt: '#2a2114',
        floorLine: 'rgba(228,180,100,0.05)',
        trail: 'rgba(255,200,110,0.22)',
        trailCore: 'rgba(255,200,110,0.6)'
      }
    },
    midnight: {
      id: 'midnight',
      name: '午夜蓝',
      desc: '默认冷调，最耐看',
      swatch: ['#2A3A57', '#1A2538', '#0E1523'],
      palette: {
        bg: '#070a11',
        wallTop: '#2A3A57',
        wallSide: '#1A2538',
        wallEdge: '#3C5075',
        wallShadow: '#0D131F',
        floor: '#0E1523',
        floorAlt: '#111A2A',
        floorLine: 'rgba(56,232,176,0.045)',
        trail: 'rgba(255,217,138,0.20)',
        trailCore: 'rgba(255,217,138,0.55)'
      }
    },
    moss: {
      id: 'moss',
      name: '苔藓森林',
      desc: '深绿石壁，幽静',
      swatch: ['#2C4A3A', '#182B22', '#0C1712'],
      palette: {
        bg: '#050b08',
        wallTop: '#2C4A3A',
        wallSide: '#182B22',
        wallEdge: '#3F6B52',
        wallShadow: '#08120D',
        floor: '#0C1712',
        floorAlt: '#0F1D17',
        floorLine: 'rgba(126,230,166,0.04)',
        trail: 'rgba(190,255,200,0.18)',
        trailCore: 'rgba(190,255,200,0.5)'
      }
    },
    crimson: {
      id: 'crimson',
      name: '赤色遗迹',
      desc: '暗红岩壁，压迫感强',
      swatch: ['#4A2A2E', '#2B181B', '#160C0E'],
      palette: {
        bg: '#0a0507',
        wallTop: '#4A2A2E',
        wallSide: '#2B181B',
        wallEdge: '#6B3D42',
        wallShadow: '#12080A',
        floor: '#160C0E',
        floorAlt: '#1B1012',
        floorLine: 'rgba(255,140,140,0.04)',
        trail: 'rgba(255,200,170,0.18)',
        trailCore: 'rgba(255,200,170,0.5)'
      }
    },
    ink: {
      id: 'ink',
      name: '水墨',
      desc: '灰阶极简，素雅',
      swatch: ['#3A3A3A', '#232323', '#101010'],
      palette: {
        bg: '#080808',
        wallTop: '#3A3A3A',
        wallSide: '#232323',
        wallEdge: '#575757',
        wallShadow: '#0D0D0D',
        floor: '#101010',
        floorAlt: '#141414',
        floorLine: 'rgba(255,255,255,0.035)',
        trail: 'rgba(230,230,230,0.16)',
        trailCore: 'rgba(230,230,230,0.45)'
      }
    }
  };

  // ==================== 角色外观 ====================
  // body/bodyDark/bodyLight/belly/accent 决定整体气质
  // 另外带体型参数，让不同外观不只是换个色
  const SKINS = {
    yogurt: {
      id: 'yogurt',
      name: '奶黄龙',
      desc: '经典款',
      swatch: ['#FFD98A', '#F5B942'],
      body: '#FFD98A',
      bodyDark: '#F5B942',
      bodyLight: '#FFF3D1',
      belly: '#FFF6E0',
      accent: '#FF9F43',
      outline: '#8A5A22',
      blush: 'rgba(255,138,138,0.55)',
      // 体型微调：1.0 为基准
      headScale: 1.0,
      hornStyle: 'short'
    },
    mint: {
      id: 'mint',
      name: '薄荷龙',
      desc: '清爽青绿',
      swatch: ['#A8F0D6', '#4ECBA4'],
      body: '#A8F0D6',
      bodyDark: '#4ECBA4',
      bodyLight: '#E4FFF6',
      belly: '#F0FFF9',
      accent: '#3FB894',
      outline: '#2A5B4C',
      blush: 'rgba(255,150,170,0.45)',
      headScale: 1.0,
      hornStyle: 'short'
    },
    sakura: {
      id: 'sakura',
      name: '樱花龙',
      desc: '粉嫩可爱',
      swatch: ['#FFC8DC', '#F58FB3'],
      body: '#FFC8DC',
      bodyDark: '#F58FB3',
      bodyLight: '#FFEEF4',
      belly: '#FFF7FA',
      accent: '#F06A9C',
      outline: '#7D3F55',
      blush: 'rgba(255,110,150,0.5)',
      headScale: 1.04,
      hornStyle: 'short'
    },
    shadow: {
      id: 'shadow',
      name: '夜行龙',
      desc: '暗紫夜行',
      swatch: ['#A99BFF', '#6C55D6'],
      body: '#A99BFF',
      bodyDark: '#6C55D6',
      bodyLight: '#D9D1FF',
      belly: '#EDE9FF',
      accent: '#8E7BFF',
      outline: '#3A2B6B',
      blush: 'rgba(255,140,200,0.45)',
      headScale: 1.0,
      hornStyle: 'long'
    },
    ember: {
      id: 'ember',
      name: '熔岩龙',
      desc: '橙红火焰',
      swatch: ['#FFB27A', '#F2683C'],
      body: '#FFB27A',
      bodyDark: '#F2683C',
      bodyLight: '#FFE2CB',
      belly: '#FFF4EC',
      accent: '#E8502A',
      outline: '#7A3018',
      blush: 'rgba(255,120,90,0.45)',
      headScale: 1.0,
      hornStyle: 'long'
    },
    frost: {
      id: 'frost',
      name: '冰霜龙',
      desc: '浅蓝冰晶',
      swatch: ['#BFE4FF', '#71B8EE'],
      body: '#BFE4FF',
      bodyDark: '#71B8EE',
      bodyLight: '#EAF7FF',
      belly: '#F6FCFF',
      accent: '#55A6E0',
      outline: '#2E5675',
      blush: 'rgba(255,150,180,0.4)',
      headScale: 1.0,
      hornStyle: 'short'
    }
  };

  // ==================== 状态 ====================
  const LS_KEY = 'maze_settings_v1';

  let current = {
    theme: 'daylight',
    skin: 'yogurt',
    view: '2d'          // '2d' 俯视 / 'iso' 等距 2.5D / '3d' 真 3D
  };

  const listeners = [];

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (SCENE_THEMES[obj.theme]) current.theme = obj.theme;
        if (SKINS[obj.skin]) current.skin = obj.skin;
        if (obj.view === '2d' || obj.view === 'iso' || obj.view === '3d') current.view = obj.view;
      }
    } catch (e) { /* 忽略 */ }
    return current;
  }

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(current));
    } catch (e) { /* 忽略 */ }
  }

  function onChange(fn) { listeners.push(fn); }
  function emit() {
    for (const fn of listeners) {
      try { fn(current); } catch (e) { console.warn(e); }
    }
  }

  function setTheme(id) {
    if (!SCENE_THEMES[id]) return;
    current.theme = id;
    save();
    apply();
    emit();
  }

  function setSkin(id) {
    if (!SKINS[id]) return;
    current.skin = id;
    save();
    apply();
    emit();
  }

  function setView(mode) {
    if (mode !== '2d' && mode !== 'iso' && mode !== '3d') return;
    current.view = mode;
    save();
    if (typeof Game !== 'undefined' && Game.setViewMode) Game.setViewMode(mode);
    emit();
  }

  function getView() { return current.view; }

  function getTheme() { return SCENE_THEMES[current.theme]; }
  function getSkin() { return SKINS[current.skin]; }
  function get() { return { ...current }; }

  /**
   * 把当前配置推给渲染层与角色层
   * 注意顺序：先给 Sprites 换肤，再让 Renderer 换色并重建静态层
   */
  function apply() {
    if (typeof Sprites !== 'undefined' && Sprites.applySkin) {
      Sprites.applySkin(getSkin());
    }
    if (typeof Renderer !== 'undefined' && Renderer.applyTheme) {
      Renderer.applyTheme(getTheme().palette);
    }
  }

  return {
    SCENE_THEMES, SKINS,
    load, save, apply,
    setTheme, setSkin, setView, getView, getTheme, getSkin, get,
    onChange
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Themes };
}
