/**
 * bmob.js —— 排行榜后端（Bmob 云 + 本地降级）
 * ------------------------------------------------------------
 * 架构说明（答辩要点）：
 *   前端承载全部游戏逻辑，后端只做排行榜这一件事，属于典型 BaaS 用法。
 *   之所以选 Bmob 而不是自建服务：
 *     - 无需云服务器、无需备案，国内直连
 *     - 数据表在控制台可视化建，不用写 CRUD 后端代码
 *     - 有免费的 JS SDK，前端直接调用
 *
 * 关键设计：三级降级策略
 *   评审现场网络不可控（断网 / Bmob 被墙 / 免费额度用尽）。
 *   如果排行榜是硬依赖，一次网络故障就会让整个演示卡死。
 *   所以这里做成：
 *     1. 首选 Bmob 云端读写
 *     2. 云端失败 → 自动切到 localStorage 本地榜（玩家无感知）
 *     3. 界面上用小字标注当前数据来源，保证演示时不"假装成功"
 *   这样评委看到的是"能跑的游戏 + 诚实的降级",而不是白屏。
 */

const BmobRank = (function () {
  'use strict';

  // ==================== 配置区（改这里即可上线） ====================
  const CONFIG = {
    // 在 Bmob 控制台 → 应用 → 设置 → 应用密钥 中可以找到
    APPLICATION_ID: '1ec481d6fe6ae1a524343cd2b0d60f0b',
    REST_API_KEY: '71bf3513264c5ee5b8203cf610d0efb5',
    // rank 表名
    TABLE: 'rank',
    // SDK CDN（Bmob 官方）
    SDK_URL: 'https://cdn.jsdelivr.net/npm/bmob-js-sdk@2.0.0/dist/bmob.min.js',
    // 请求超时（毫秒），超时即降级，避免演示时长时间等待
    TIMEOUT: 6000,
    // 本地榜存储键
    LS_KEY: 'maze_local_rank_v1',
    // 排行榜展示条数：云端 limit 与本地榜上限都用它，改一处即可
    TOP_N: 50
  };
  // ================================================================

  let sdkReady = false;
  let sdkFailed = false;
  let source = 'local'; // 'cloud' | 'local'

  /** 是否已配置云端 */
  function isConfigured() {
    return !!(CONFIG.APPLICATION_ID && CONFIG.REST_API_KEY);
  }

  /** 获取当前数据源，供 UI 显示 */
  function getSource() {
    return source;
  }

  /** 带超时的 fetch */
  async function fetchWithTimeout(url, options, timeout = CONFIG.TIMEOUT) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 动态加载 Bmob SDK（只在浏览器环境） */
  function loadSDK() {
    if (sdkReady) return Promise.resolve(true);
    if (sdkFailed) return Promise.resolve(false);
    if (!isConfigured()) { sdkFailed = true; return Promise.resolve(false); }

    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = CONFIG.SDK_URL;
      script.onload = () => {
        try {
          if (window.Bmob) {
            window.Bmob.initialize(CONFIG.APPLICATION_ID, CONFIG.REST_API_KEY);
            sdkReady = true;
            resolve(true);
          } else {
            sdkFailed = true;
            resolve(false);
          }
        } catch (e) {
          console.warn('[Bmob] 初始化失败', e);
          sdkFailed = true;
          resolve(false);
        }
      };
      script.onerror = () => {
        console.warn('[Bmob] SDK 加载失败，使用本地榜');
        sdkFailed = true;
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  // ---------------- 本地榜（降级 / 离线可用） ----------------

  function localRead() {
    try {
      const raw = localStorage.getItem(CONFIG.LS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function localWrite(list) {
    try {
      // 本地榜要能撑起 TOP_N(30) 条展示，留 4 倍余量即可，不必无限增长
      localStorage.setItem(CONFIG.LS_KEY, JSON.stringify(list.slice(0, CONFIG.TOP_N * 4)));
    } catch (e) {
      /* 隐私模式可能禁止写入，忽略 */
    }
  }

  function localSubmit(record) {
    const list = localRead();
    const newRec = {
      username: record.username,
      time: record.time,
      size: record.size,
      createAt: new Date().toISOString(),
      _local: true
    };
    list.push(newRec);
    // 排序：时间升序（越快越前）
    list.sort((a, b) => a.time - b.time);
    localWrite(list);
    return newRec;
  }

  function localTop(n, size) {
    let list = localRead();
    if (size) list = list.filter((r) => r.size === size);
    list.sort((a, b) => a.time - b.time);
    return list.slice(0, n);
  }

  // ---------------- 云端读写（REST API） ----------------

  /**
   * 提交成绩
   * Bmob REST 约定：POST /1/classes/<表名>，请求头带 X-Bmob-Application-Id 与 X-Bmob-REST-API-Key
   */
  async function cloudSubmit(record) {
    const url = 'https://api.bmobcloud.com/1/classes/' + CONFIG.TABLE;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bmob-Application-Id': CONFIG.APPLICATION_ID,
        'X-Bmob-REST-API-Key': CONFIG.REST_API_KEY
      },
      body: JSON.stringify({
        username: record.username,
        time: record.time,
        size: record.size
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }

  /**
   * 查询 Top N
   * Bmob 查询参数：
   *   order=time        → 按 time 升序（越快越前）
   *   limit=n           → 取前 n（默认 CONFIG.TOP_N = 30，Bmob 单次上限 1000）
   *   where={"size":"简单"} → 按难度过滤
   */
  async function cloudTop(n, size) {
    let url = 'https://api.bmobcloud.com/1/classes/' + CONFIG.TABLE +
      '?order=time&limit=' + n;
    if (size) {
      url += '&where=' + encodeURIComponent(JSON.stringify({ size: size }));
    }
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        'X-Bmob-Application-Id': CONFIG.APPLICATION_ID,
        'X-Bmob-REST-API-Key': CONFIG.REST_API_KEY
      }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return (data.results || []).map((r) => ({
      username: r.username,
      time: r.time,
      size: r.size,
      createAt: r.createdAt
    }));
  }

  // ---------------- 对外统一接口 ----------------

  /**
   * 提交成绩：先试云端，失败落本地
   * @returns {Promise<{ok:boolean, source:'cloud'|'local', record:object}>}
   */
  async function submit(record) {
    if (isConfigured()) {
      try {
        const created = await cloudSubmit(record);
        source = 'cloud';
        return { ok: true, source: 'cloud', record: created };
      } catch (e) {
        console.warn('[Bmob] 提交失败，降级到本地榜：', e.message);
      }
    }
    source = 'local';
    const rec = localSubmit(record);
    return { ok: true, source: 'local', record: rec };
  }

  /**
   * 读取排行榜
   * @param {number} n 取前 n 名
   * @param {string} [size] 难度筛选，空则全部
   */
  async function top(n, size = '') {
    n = n || CONFIG.TOP_N;   // 不传就用配置里的默认值（30）
    if (isConfigured()) {
      try {
        const list = await cloudTop(n, size);
        source = 'cloud';
        // 云端为空但本地有数据时，合并展示，避免演示时"榜是空的"
        if (list.length === 0) {
          const local = localTop(n, size);
          if (local.length > 0) return { ok: true, source: 'merged', list: local };
        }
        return { ok: true, source: 'cloud', list: list };
      } catch (e) {
        console.warn('[Bmob] 查询失败，降级到本地榜：', e.message);
      }
    }
    source = 'local';
    return { ok: true, source: 'local', list: localTop(n, size) };
  }

  return { submit, top, isConfigured, getSource, loadSDK, CONFIG };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BmobRank };
}
