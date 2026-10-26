/**
 * bmob.js v2 —— 排行榜后端（Bmob 云 + 本地降级）
 * ------------------------------------------------------------
 * 本版针对线上故障（控制台报 "HTTP: 400"、面板显示"云端暂不可用"）做了修复。
 *
 * 【故障根因】
 *   Bmob 对"鉴权失败"统一返回 HTTP 400 + {"error":"unauthorized"}
 *   （已用 curl 实测：占位符 AppID、32 位假 AppID、完全不带头，三种情况全部是 400）。
 *   也就是说 400 不等于"参数写错"，绝大多数情况是"密钥没生效"。
 *   原代码里应用密钥常量仍是占位符字符串（CONFIG 区那两个默认值），
 *   而 isConfigured() 只判断"非空"，于是占位符被当成了合法配置：
 *     isConfigured() → true → 走云端 → 400 → 每次进面板都降级。
 *
 * 【本版修复】
 *   1. isConfigured() 改为"格式校验"：长度 < 24 或形如 BMOB_xxx 的占位符直接判为未配置，
 *      不再发起注定失败的请求，UI 能明确显示"云端未配置"而不是含糊的"云端暂不可用"。
 *   2. 错误落地：解析 Bmob 响应体，暴露 getLastError() / diagnose()，
 *      并把错误归类为 config / auth / network / http，UI 可按类给文案。
 *   3. 修正 source 状态机：原代码 merged 分支只改了返回值、没改内部 source，
 *      getSource() 与 top() 返回值会不一致。
 *   4. 密钥支持运行时注入 window.__MAZE_BMOB__（配合 CI 生成 config.js），
 *      也保留直接改常量的方式，两种部署都不冲突。
 *   5. 本地榜同名玩家只保留最佳成绩；云端+本地合并时按 (名字, 用时, 难度) 去重。
 *   6. 用户名清洗（trim / 截断 / 去控制字符），避免脏数据把榜单排版撑破。
 *   7. 删除从未被调用的 SDK 加载逻辑（全程走 REST），只留一个兼容用的空实现。
 *
 * 【三级降级（答辩要点保持不变）】
 *   1) Bmob 云端 REST 读写
 *   2) 云端失败 → localStorage 本地榜，玩家无感知
 *   3) UI 小字标注真实数据来源，不假装成功
 */

const BmobRank = (function () {
  'use strict';

  // ==================== 配置区（改这里即可上线） ====================
  const INJECTED = (typeof window !== 'undefined' && window.__MAZE_BMOB__) || {};

  const CONFIG = {
    // 应用域名：2016 年前创建的老应用可能是 https://api.bmob.cn，新应用用 bmobcloud
    API_BASE: INJECTED.base || 'https://api.bmobcloud.com',
    // CI 注入优先，其次读这里写死的常量
    APPLICATION_ID: INJECTED.appId || 'BMOB_APP_ID',
    REST_API_KEY: INJECTED.restKey || 'BMOB_REST_KEY',
    TABLE: 'rank',
    // 请求超时（毫秒），超时即降级，避免演示时长时间等待
    TIMEOUT: 6000,
    // 本地榜存储键
    LS_KEY: 'maze_local_rank_v1',
    // 排行榜展示条数：云端 limit 与本地榜上限都用它
    TOP_N: 80,
    // 本地榜最多保留条数（展示 50 条，留 4 倍余量足够）
    MAX_LOCAL: 200,
    // 用户名最大长度
    NAME_MAX: 16
  };
  // ================================================================

  let source = 'local';       // 'cloud' | 'merged' | 'local'
  let lastError = null;       // { phase, kind, status, message }

  /** 占位符 / 半填状态识别：长度不足或形如 BMOB_xxx 一律视为未配置 */
  function looksLikeRealKey(v) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    if (s.length < 24) return false;
    if (/^BMOB_/i.test(s)) return false;
    if (/^(your|xxx|test|todo)/i.test(s)) return false;
    return true;
  }

  /** 是否已配置云端（本版核心修复点：不再被占位符骗过） */
  function isConfigured() {
    return looksLikeRealKey(CONFIG.APPLICATION_ID) && looksLikeRealKey(CONFIG.REST_API_KEY);
  }

  /** 获取当前数据源，供 UI 显示 */
  function getSource() {
    return source;
  }

  /** 最近一次失败的结构化信息，供 UI / 答辩现场排查 */
  function getLastError() {
    return lastError;
  }

  /** 一行式诊断快照，可直接 console.log(BmobRank.diagnose()) */
  function diagnose() {
    return {
      configured: isConfigured(),
      apiBase: CONFIG.API_BASE,
      appIdTail: looksLikeRealKey(CONFIG.APPLICATION_ID)
        ? '***' + String(CONFIG.APPLICATION_ID).slice(-4) : '(未配置/占位符)',
      source: source,
      lastError: lastError
    };
  }

  /** 错误 → 给用户看的短语 */
  function describe(err) {
    if (!err) return null;
    if (err.kind === 'config') return '云端未配置';
    if (err.kind === 'auth') return '云端鉴权失败(400)';
    if (err.kind === 'network') return '云端连不通';
    return '云端异常(' + (err.status || '?') + ')';
  }

  // ---------------- 网络层 ----------------

  /** 带超时的 fetch */
  async function fetchWithTimeout(url, options, timeout = CONFIG.TIMEOUT) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      return await fetch(url, Object.assign({ signal: ctrl.signal, cache: 'no-store' }, options));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 统一请求封装：把 Bmob 的 { error: 'unauthorized' } 之类解析成结构化错误
   * @returns {Promise<object>} 响应 JSON（可能是空对象）
   */
  async function request(path, options) {
    const url = CONFIG.API_BASE + path;
    const headers = Object.assign({
      'X-Bmob-Application-Id': CONFIG.APPLICATION_ID,
      'X-Bmob-REST-API-Key': CONFIG.REST_API_KEY
    }, (options && options.headers) || {});

    let res;
    try {
      res = await fetchWithTimeout(url, Object.assign({}, options, { headers: headers }));
    } catch (e) {
      const err = new Error(e && e.name === 'AbortError'
        ? '请求超时 ' + CONFIG.TIMEOUT + 'ms'
        : '网络不可达: ' + (e && e.message));
      err.kind = 'network';
      throw err;
    }

    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 200) }; }
    }

    if (!res.ok) {
      const bmobError = body && (body.error || body.message);
      const err = new Error('HTTP ' + res.status + (bmobError ? ' ' + bmobError : ''));
      err.status = res.status;
      // Bmob 鉴权失败固定是 400 unauthorized，单独归类，便于 UI 给准确文案
      err.kind = res.status === 400 ? 'auth' : (res.status === 401 || res.status === 403 ? 'auth' : 'http');
      err.bmobError = bmobError || null;
      throw err;
    }
    return body || {};
  }

  /**
   * 兼容旧调用：v1 里 main.js 可能调用过 loadSDK()
   * 本版全程走 REST，不需要 SDK，保留空实现避免报错
   */
  function loadSDK() {
    return Promise.resolve(true);
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
      localStorage.setItem(CONFIG.LS_KEY, JSON.stringify(list.slice(0, CONFIG.MAX_LOCAL)));
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
    // 同名玩家只保留最好成绩，否则本地榜会被同一个人的多次尝试刷满
    const sameName = (r) => r.username === newRec.username && r.size === newRec.size;
    const prevBest = list.filter(sameName).sort(byTimeAsc)[0];

    // 既有成绩更快：保留原记录，不打乱队伍
    if (prevBest && prevBest.time <= newRec.time) return prevBest;

    const kept = list.filter((r) => !sameName(r));
    kept.push(newRec);
    kept.sort(byTimeAsc);
    localWrite(kept);
    return newRec;
  }

  function byTimeAsc(a, b) {
    return a.time - b.time;
  }

  function localTop(n, size) {
    let list = localRead().slice();
    if (size) list = list.filter((r) => r.size === size);
    list.sort(byTimeAsc);
    return list.slice(0, n);
  }

  // ---------------- 云端读写（REST API） ----------------

  function normalize(r) {
    return {
      username: r.username,
      time: Number(r.time),
      size: r.size,
      createAt: r.createdAt || r.createAt || null,
      _local: false
    };
  }

  /**
   * 提交成绩
   * Bmob REST：POST /1/classes/<表名>，鉴权头 X-Bmob-Application-Id / X-Bmob-REST-API-Key
   */
  async function cloudSubmit(record) {
    const body = await request('/1/classes/' + CONFIG.TABLE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: record.username,
        time: record.time,
        size: record.size
      })
    });
    return normalize(Object.assign({}, record, { createdAt: body.createdAt, objectId: body.objectId }));
  }

  /**
   * 查询 Top N
   *   order=time            → 按 time 升序（越快越前）
   *   limit=n               → 取前 n（Bmob 单次上限 1000）
   *   where={"size":"简单"} → 按难度过滤
   */
  async function cloudTop(n, size) {
    let path = '/1/classes/' + CONFIG.TABLE + '?order=time&limit=' + n;
    if (size) {
      path += '&where=' + encodeURIComponent(JSON.stringify({ size: size }));
    }
    const data = await request(path, { method: 'GET' });
    return (data.results || []).map(normalize);
  }

  // ---------------- 对外统一接口 ----------------

  /** 用户名清洗：去控制字符、trim、截断 */
  function cleanName(raw) {
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!s) s = '匿名逃生者';
    if (s.length > CONFIG.NAME_MAX) s = s.slice(0, CONFIG.NAME_MAX);
    return s;
  }

  function sanitize(record) {
    const time = Number(record && record.time);
    return {
      username: cleanName(record && record.username),
      time: isFinite(time) && time > 0 ? Math.round(time * 100) / 100 : 0,
      size: record && record.size ? String(record.size) : ''
    };
  }

  function mergeDedupe(a, b) {
    const seen = new Set();
    const out = [];
    a.concat(b).forEach((r) => {
      const k = r.username + '|' + r.time + '|' + r.size;
      if (seen.has(k)) return;
      seen.add(k);
      out.push(r);
    });
    out.sort(byTimeAsc);
    return out;
  }

  /**
   * 提交成绩：先试云端，失败落本地
   * @returns {Promise<{ok:boolean, source:'cloud'|'local', record:object, reason:string|null}>}
   */
  async function submit(rawRecord) {
    const record = sanitize(rawRecord);

    if (isConfigured()) {
      try {
        const created = await cloudSubmit(record);
        source = 'cloud';
        lastError = null;
        return { ok: true, source: 'cloud', record: created, reason: null };
      } catch (e) {
        lastError = { phase: 'submit', kind: e.kind, status: e.status || null, message: e.message };
        console.warn('[Bmob] 提交失败，降级到本地榜：', e.message);
      }
    } else {
      lastError = { phase: 'submit', kind: 'config', status: null, message: '云端密钥未注入（占位符）' };
    }

    source = 'local';
    const rec = localSubmit(record);
    return { ok: true, source: 'local', record: rec, reason: describe(lastError) };
  }

  /**
   * 读取排行榜
   * @param {number} n 取前 n 名
   * @param {string} [size] 难度筛选，空则全部
   * @returns {Promise<{ok:boolean, source:'cloud'|'merged'|'local', list:Array, reason:string|null}>}
   */
  async function top(n, size) {
    n = Math.min(Math.max(parseInt(n, 10) || CONFIG.TOP_N, 1), 1000);
    size = size || '';

    if (isConfigured()) {
      try {
        const list = await cloudTop(n, size);
        lastError = null;

        // 云端不足 n 条且本地有数据时合并展示，避免演示时"榜是空的"
        if (list.length < n) {
          const local = localTop(n, size);
          if (local.length) {
            const merged = mergeDedupe(list, local).slice(0, n);
            if (merged.length > list.length) {
              source = 'merged';                       // v1 的 bug：这里漏赋值
              return { ok: true, source: 'merged', list: merged, reason: null };
            }
          }
        }

        source = 'cloud';
        return { ok: true, source: 'cloud', list: list, reason: null };
      } catch (e) {
        lastError = { phase: 'top', kind: e.kind, status: e.status || null, message: e.message };
        console.warn('[Bmob] 查询失败，降级到本地榜：', e.message);
      }
    } else {
      lastError = { phase: 'top', kind: 'config', status: null, message: '云端密钥未注入（占位符）' };
      console.warn('[Bmob] 未配置有效密钥，直接使用本地榜');
    }

    source = 'local';
    return { ok: true, source: 'local', list: localTop(n, size), reason: describe(lastError) };
  }

  return {
    submit: submit,
    top: top,
    isConfigured: isConfigured,
    getSource: getSource,
    getLastError: getLastError,
    diagnose: diagnose,
    loadSDK: loadSDK,
    CONFIG: CONFIG
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BmobRank };
}
