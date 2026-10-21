// ==UserScript==
// @name         贴吧美化 · 用户与关键词屏蔽
// @namespace    https://tieba.baidu.com/
// @version      1.3.0
// @description  屏蔽百度贴吧指定用户/关键词：主题贴直接隐藏，回复折叠提示；支持备注、名单管理、CSV 导入导出、默认最新发帖排序。
// @author       黑渊玄
// @match        https://tieba.baidu.com/f*
// @match        https://tieba.baidu.com/p/*
// @match        http://tieba.baidu.com/f*
// @match        http://tieba.baidu.com/p/*
// @icon         https://tieba.baidu.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   * 贴吧美化 · 用户 / 关键词屏蔽
   * -------------------------------------------------------------------------
   * 1. 论坛列表页：命中用户或关键词的主题贴直接从 DOM 中隐藏；
   * 2. 帖子详情（/p/xxx）：命中用户的楼层折叠为一行提示，可选择展示；
   * 3. 备注会以全角括号显示在回复用户名右侧；
   * 4. 所有数据保存在油猴存储中，可通过 CSV 导出 / 导入实现跨电脑同步；
   * 5. 可开启“默认最新发帖排序”，进入贴吧时自动切换到“最新”；
   * 6. 设置面板从页面右上角头像旁的「贴吧美化」按钮展开。
   * ========================================================================= */

  const VERSION = '1.3.0';
  const STORE_KEY = 'tbq.store.v1';
  const MAX_NAME = 40;
  const MAX_REASON = 80;
  const SCAN_DELAY = 120;

  const canGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  /* ------------------------------ 存储 ------------------------------ */

  function storeGet(key, fallback) {
    try {
      if (canGM) return GM_getValue(key, fallback);
      const raw = window.localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      if (canGM) GM_setValue(key, value);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 存储失败时保持内存状态可用 */
    }
  }

  /* --------------------------- 文本与数据工具 --------------------------- */

  function toText(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fold(value) {
    return toText(value).toLowerCase();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function sanitizeEntries(list, key) {
    const out = [];
    const seen = new Set();
    if (!Array.isArray(list)) return out;
    for (const item of list) {
      const raw = typeof item === 'string' ? item : item && item[key];
      if (typeof raw !== 'string') continue;
      const name = toText(raw).slice(0, MAX_NAME * 2);
      if (!name) continue;
      const folded = fold(name);
      if (seen.has(folded)) continue;
      seen.add(folded);
      out.push({
        [key]: name,
        reason: toText(item && item.reason).slice(0, MAX_REASON * 2),
        at: Number(item && item.at) || 0
      });
    }
    return out;
  }

  const state = {
    users: [],
    keywords: [],
    latestSort: true
  };

  (function loadState() {
    let raw = storeGet(STORE_KEY, null);
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (e) { raw = null; }
    }
    const data = raw && typeof raw === 'object' ? raw : {};
    state.users = sanitizeEntries(data.users, 'name');
    state.keywords = sanitizeEntries(data.keywords, 'word');
    state.latestSort = data.latestSort !== false;
  })();

  let userIndex = new Map();
  let keywordIndex = [];

  function reindex() {
    userIndex = new Map();
    state.users.forEach(function (user) {
      userIndex.set(fold(user.name), user);
    });
    keywordIndex = state.keywords
      .map(function (keyword) {
        return { word: keyword.word, reason: keyword.reason, key: fold(keyword.word) };
      })
      .filter(function (keyword) { return keyword.key; })
      .sort(function (a, b) { return b.key.length - a.key.length; });
  }

  reindex();

  function saveState() {
    storeSet(STORE_KEY, state);
    reindex();
  }

  function findBlockedUser(candidates) {
    for (const candidate of candidates) {
      const key = fold(candidate);
      if (!key) continue;
      const hit = userIndex.get(key);
      if (hit) return hit;
    }
    return null;
  }

  function findBlockedKeyword(text) {
    const target = fold(text);
    if (!target) return null;
    for (const keyword of keywordIndex) {
      if (target.indexOf(keyword.key) !== -1) return keyword;
    }
    return null;
  }

  // 新版信息流里用户名可能是纯文本，用卡片头部文字兜底匹配
  function findBlockedUserInText(text) {
    const target = fold(text);
    if (!target) return null;
    for (const [key, user] of userIndex) {
      if (key.length < 2) continue;
      if (target.indexOf(key) !== -1) return user;
    }
    return null;
  }

  /* --------------------------- 页面判定 --------------------------- */

  function isForumPage() {
    return /^\/f(\/|$)/.test(location.pathname);
  }

  function isThreadPage() {
    return /^\/p\/\d+/.test(location.pathname);
  }

  function forumKeyword() {
    try {
      return new URL(location.href).searchParams.get('kw') || '';
    } catch (e) {
      return '';
    }
  }

  /* --------------------- 默认“最新发帖”排序（尽早跳转） --------------------- */

  const LATEST_GUARD_KEY = 'tbq.latest.guard';

  function withLatestGuard(fn) {
    let last = 0;
    try {
      last = Number(window.sessionStorage.getItem(LATEST_GUARD_KEY)) || 0;
    } catch (e) { /* ignore */ }
    if (last && Date.now() - last < 4000) return false;
    try {
      window.sessionStorage.setItem(LATEST_GUARD_KEY, String(Date.now()));
    } catch (e) { /* ignore */ }
    fn();
    return true;
  }

  function findLatestTabLink() {
    const anchors = document.querySelectorAll('a[href*="tab="]');
    for (const anchor of anchors) {
      const text = (anchor.textContent || '').replace(/\s+/g, '');
      if (text === '最新' || text === '最新发帖' || text === '最新回复') return anchor;
      if (text.indexOf('最新') === 0 && text.length <= 6) return anchor;
    }
    return null;
  }

  (function redirectToLatestEarly() {
    if (!state.latestSort || !isForumPage() || !forumKeyword()) return;
    let url;
    try {
      url = new URL(location.href);
    } catch (e) {
      return;
    }
    if (url.searchParams.get('tab')) return;
    withLatestGuard(function () {
      url.searchParams.set('tab', 'new');
      location.replace(url.toString());
    });
  })();

  // 若站点实际使用的“最新”参数与 tab=new 不同，则以页面中的“最新”链接为准修正一次。
  function fixLatestFromDom() {
    if (!state.latestSort || !isForumPage() || !forumKeyword()) return;
    let here;
    try {
      here = new URL(location.href);
    } catch (e) {
      return;
    }
    const tab = here.searchParams.get('tab');
    if (tab && tab !== 'new') return; // 用户主动选择了精品等其他排序，尊重
    const link = findLatestTabLink();
    if (!link) return;
    let target;
    try {
      target = new URL(link.getAttribute('href'), location.href);
    } catch (e) {
      return;
    }
    const targetTab = target.searchParams.get('tab');
    if (!targetTab || targetTab === tab) return;
    if (target.toString() === location.href) return;
    withLatestGuard(function () {
      location.replace(target.toString());
    });
  }

  function goLatestNow() {
    if (!isForumPage() || !forumKeyword()) return;
    let url;
    try {
      url = new URL(location.href);
    } catch (e) {
      return;
    }
    if (url.searchParams.get('tab')) return;
    const link = findLatestTabLink();
    if (link) {
      try {
        location.href = new URL(link.getAttribute('href'), location.href).toString();
        return;
      } catch (e) { /* ignore */ }
    }
    url.searchParams.set('tab', 'new');
    location.href = url.toString();
  }

  /* ------------------- 新版“最新 / 发布”自动切换 ------------------- */

  let latestSignature = '';
  let latestTabDone = false;
  let latestSortDone = false;
  let latestStartAt = 0;
  let latestDeadline = 0;

  function resetLatestView(signature) {
    latestSignature = signature;
    latestTabDone = false;
    latestSortDone = false;
    latestStartAt = Date.now() + 700;
    latestDeadline = Date.now() + 20000;
  }

  function isBlueish(color) {
    const match = String(color || '').match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (!match) return false;
    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    return blue >= 150 && blue > red + 25 && blue > green + 15;
  }

  function isLatestTabActive(element) {
    let node = element;
    for (let i = 0; i < 4 && node; i += 1) {
      const className = typeof node.className === 'string' ? node.className : '';
      if (/(^|[-_ ])(active|current|selected|curr|focus|on)([-_ ]|$)/i.test(className)) return true;
      if (node.getAttribute) {
        const aria = node.getAttribute('aria-selected') || node.getAttribute('aria-current') || node.getAttribute('aria-pressed');
        if (aria === 'true' || aria === 'page') return true;
      }
      try {
        const style = getComputedStyle(node);
        if (isBlueish(style.color) || isBlueish(style.borderBottomColor) || isBlueish(style.backgroundColor)) {
          return true;
        }
      } catch (e) { /* ignore */ }
      node = node.parentElement;
    }
    return false;
  }

  function findLatestTabElement() {
    let best = null;
    let bestScore = -1;
    let bestTop = Infinity;
    const nodes = document.querySelectorAll('a, button, [role="tab"], [tabindex], div, span, li');

    for (const element of nodes) {
      if (element.children.length > 2) continue;
      const text = (element.textContent || '').replace(/\s+/g, '');
      let base = 0;
      if (text === '最新发布') base = 3;
      else if (text === '最新发帖') base = 2;
      else if (text === '最新') base = 1;
      if (!base) continue;

      const rect = element.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10 || rect.top < 0 || rect.top > 360) continue;
      if (element.closest && element.closest('.tbq-host')) continue;

      let score = base;
      let parent = element;
      for (let i = 0; i < 3 && parent; i += 1) {
        const className = String(parent.className || '').toLowerCase();
        if (className.indexOf('tab') !== -1 || className.indexOf('nav') !== -1) {
          score += 2;
          break;
        }
        parent = parent.parentElement;
      }
      if (element.tagName === 'A' || element.tagName === 'BUTTON' || element.getAttribute('role') === 'tab') {
        score += 1;
      }

      if (score > bestScore || (score === bestScore && rect.top < bestTop)) {
        bestScore = score;
        bestTop = rect.top;
        best = element.closest('a, button, [role="tab"], [tabindex]') || element;
      }
    }
    return best;
  }

  function findPublishSortElement() {
    const labels = [];
    document.querySelectorAll('div, span, p, h3, h4').forEach(function (element) {
      if (!element.children.length && (element.textContent || '').trim() === '看贴排序') {
        labels.push(element);
      }
    });

    function findPublishIn(box) {
      if (!box) return null;
      const leaves = box.querySelectorAll('button, a, div, span, li');
      for (const leaf of leaves) {
        if (leaf.children.length) continue;
        if ((leaf.textContent || '').trim() !== '发布') continue;
        const rect = leaf.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        return leaf.closest('button, a, [role="button"], [tabindex]') || leaf;
      }
      return null;
    }

    for (const label of labels) {
      let box = label.parentElement;
      for (let i = 0; i < 3 && box; i += 1) {
        const hit = findPublishIn(box);
        if (hit) return hit;
        box = box.parentElement;
      }
    }

    // 兜底：顶部区域中与“回复”相邻的“发布”
    const fallback = [];
    document.querySelectorAll('button, a, div, span').forEach(function (element) {
      if (element.children.length) return;
      if ((element.textContent || '').trim() !== '发布') return;
      const rect = element.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.top < 0 || rect.top > 520) return;

      let box = element.parentElement;
      let hasReply = false;
      for (let i = 0; i < 3 && box; i += 1) {
        if ((box.innerText || '').indexOf('回复') !== -1) hasReply = true;
        box = box.parentElement;
      }
      if (hasReply) fallback.push(element.closest('button, a, [role="button"], [tabindex]') || element);
    });
    return fallback[0] || null;
  }

  function isPublishSortActive(element) {
    let node = element;
    for (let i = 0; i < 3 && node; i += 1) {
      const className = typeof node.className === 'string' ? node.className : '';
      if (/(^|[-_ ])(active|current|selected|checked|on)([-_ ]|$)/i.test(className)) return true;
      if (node.getAttribute) {
        const aria = node.getAttribute('aria-pressed') || node.getAttribute('aria-selected');
        if (aria === 'true') return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function clickLatestElement(element, key) {
    const storeKey = 'tbq.latest-' + key;
    let raw = '';
    try { raw = sessionStorage.getItem(storeKey) || ''; } catch (e) { /* ignore */ }
    const parts = raw.split('|');
    if (parts[0] === latestSignature && Date.now() - (Number(parts[1]) || 0) < 8000) return;
    try { sessionStorage.setItem(storeKey, latestSignature + '|' + Date.now()); } catch (e) { /* ignore */ }
    try { element.click(); } catch (e) { /* ignore */ }
  }

  function ensureLatestView() {
    if (!state.latestSort || !isForumPage() || !forumKeyword()) return;

    const signature = location.pathname + '|' + forumKeyword();
    if (signature !== latestSignature) resetLatestView(signature);
    if (latestTabDone && latestSortDone) return;
    if (Date.now() < latestStartAt) return;

    let urlTab = '';
    try { urlTab = new URL(location.href).searchParams.get('tab') || ''; } catch (e) { /* ignore */ }
    if (urlTab && urlTab !== 'new') {
      latestTabDone = true;
      latestSortDone = true;
      return;
    }

    if (document.querySelector('#thread_list, ul.threadlist_bright, .j_threadlist_bright')) {
      latestTabDone = true;
      latestSortDone = true;
      return;
    }

    if (Date.now() > latestDeadline) {
      latestTabDone = true;
      latestSortDone = true;
      return;
    }

    if (!latestTabDone) {
      const tab = findLatestTabElement();
      if (tab) {
        latestTabDone = true;
        if (!isLatestTabActive(tab)) {
          clickLatestElement(tab, 'tab');
          // 切换标签后内容区会重新渲染，稍后再选择“发布”
          window.setTimeout(ensureLatestView, 900);
          return;
        }
      }
    }

    if (latestTabDone && !latestSortDone) {
      const publish = findPublishSortElement();
      if (publish) {
        latestSortDone = true;
        if (!isPublishSortActive(publish)) clickLatestElement(publish, 'sort');
      }
    }
  }

  /* ------------------------------ 页面样式 ------------------------------ */

  const LIGHT_CSS = [
    '.tbq-hide{display:none!important}',
    '.tbq-hidden-content{display:none!important}',
    '.tbq-trigger{all:unset;box-sizing:border-box;display:inline-flex!important;align-items:center;gap:4px;height:26px;padding:0 10px!important;margin-left:8px!important;border-radius:13px!important;background:linear-gradient(135deg,#5b7cff,#4e6ef2)!important;color:#fff!important;font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif!important;letter-spacing:.2px;cursor:pointer!important;vertical-align:middle;box-shadow:0 2px 8px rgba(78,110,242,.3)!important;position:relative;z-index:1000;white-space:nowrap;transition:transform .15s ease,box-shadow .15s ease;user-select:none}',
    '.tbq-trigger:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(78,110,242,.4)!important}',
    '.tbq-trigger.is-active{background:linear-gradient(135deg,#3f5ee8,#3550d8)!important}',
    '.tbq-trigger svg{display:block;flex:0 0 auto}',
    '.tbq-trigger span{display:inline-block;line-height:1}',
    '.tbq-trigger--fixed{position:fixed!important;top:62px!important;right:16px!important;margin:0!important;z-index:2147482000!important}',
    '.tbq-reason{font:400 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif!important;color:#98a2b3!important;margin-left:2px;word-break:break-all}',
    '.tbq-notice{display:flex!important;align-items:center!important;flex-wrap:wrap;gap:8px!important;margin:10px 0 12px!important;padding:7px 12px!important;border:1px dashed #b9c6ff!important;background:#f6f8ff!important;border-radius:8px!important;color:#5b6472!important;font:400 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif!important;text-align:left!important;box-sizing:border-box!important;box-shadow:none!important}',
    '.tbq-notice__icon{display:inline-flex;align-items:center;color:#7b8ff5;flex:0 0 auto}',
    '.tbq-notice__text{color:#3d4657!important;flex:0 1 auto}',
    '.tbq-notice__btns{display:inline-flex;gap:6px;margin-left:auto;flex:0 0 auto}',
    '.tbq-notice button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 10px;border-radius:6px;border:1px solid #d5dced;background:#fff;color:#4a5568;font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;transition:border-color .15s ease,color .15s ease,background .15s ease}',
    '.tbq-notice button:hover{border-color:#a9b8e8;color:#3550d8}',
    '.tbq-notice button[data-tbq-act="show"]{background:#4e6ef2;border-color:#4e6ef2;color:#fff}',
    '.tbq-notice button[data-tbq-act="show"]:hover{background:#3f5ee8;border-color:#3f5ee8;color:#fff}',
    '.tbq-notice--kept .tbq-notice__icon{opacity:.5}'
  ].join('');

  let stylesAdded = false;

  function addPageStyles() {
    if (stylesAdded) return;
    stylesAdded = true;
    try {
      if (typeof GM_addStyle === 'function') {
        GM_addStyle(LIGHT_CSS);
        return;
      }
    } catch (e) { /* fallback */ }
    const style = document.createElement('style');
    style.id = 'tbq-style';
    style.textContent = LIGHT_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------ 扫描状态 ------------------------------ */

  const hiddenThreads = new Set();
  const collapsedPosts = new Map();
  let stats = { threads: 0, posts: 0 };
  let scanning = false;

  function updateStatsUI() {
    if (!ui || !ui.stats) return;
    ui.stats.textContent = '本次已屏蔽 ' + stats.threads + ' 主题 / ' + stats.posts + ' 回复';
  }

  /* ------------------------------ DOM 读取 ------------------------------ */

  function readDataField(element) {
    if (!element) return null;
    const raw = element.getAttribute('data-field');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) { /* 继续尝试解码实体 */ }
    try {
      return JSON.parse(
        raw
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
      );
    } catch (e) {
      return null;
    }
  }

  function authorsFromField(field) {
    const out = [];
    if (!field || typeof field !== 'object') return out;
    if (typeof field.author_name === 'string') out.push(field.author_name);
    if (typeof field.user_name === 'string') out.push(field.user_name);
    if (typeof field.name_show === 'string') out.push(field.name_show);
    const author = field.author;
    if (author && typeof author === 'object') {
      if (typeof author.name_show === 'string') out.push(author.name_show);
      if (typeof author.user_name === 'string') out.push(author.user_name);
      if (typeof author.name === 'string') out.push(author.name);
    }
    return out;
  }

  function collectNames(field, authorElement) {
    const names = authorsFromField(field);
    if (authorElement) {
      names.push(authorElement.textContent);
      names.push(authorElement.getAttribute('title'));
      names.push(authorElement.getAttribute('data-name'));
    }
    return names;
  }

  function threadRoots() {
    const roots = document.querySelectorAll(
      '#thread_list, ul.threadlist_bright, ul.j_threadlist_bright, .threadlist_bright'
    );
    if (roots.length) return Array.from(roots);
    return Array.from(document.querySelectorAll('ul')).filter(function (ul) {
      return ul.querySelector('li.j_thread_list, li[data-field] .threadlist_title');
    });
  }

  function getThreadTitle(item) {
    const element = item.querySelector('.threadlist_title a, a.j_th_tit, .threadlist_title');
    if (!element) return '';
    return element.getAttribute('title') || element.textContent || '';
  }

  function getThreadAuthorElement(item) {
    return item.querySelector(
      '.frs-author-name, .threadlist_author a.j_user_card, .tb_icon_author a, .threadlist_author a'
    );
  }

  /* ------------------------------ 论坛列表 ------------------------------ */

  function scanForum() {
    const seen = new Set();
    threadRoots().forEach(function (root) {
      Array.from(root.children).forEach(function (item) {
        if (!item || item.tagName !== 'LI' || seen.has(item)) return;
        seen.add(item);
        if (item.dataset.tbqState) return;

        const field = readDataField(item) || {};
        const authorElement = getThreadAuthorElement(item);
        const names = collectNames(field, authorElement);
        const blockedUser = findBlockedUser(names);
        const title = getThreadTitle(item);
        const blockedKeyword = blockedUser ? null : findBlockedKeyword(title);

        if (!blockedUser && !blockedKeyword) {
          item.dataset.tbqState = 'ok';
          return;
        }

        item.dataset.tbqState = blockedUser ? 'user' : 'keyword';
        item.classList.add('tbq-hide');
        hiddenThreads.add(item);
        stats.threads += 1;
      });
    });
  }

  /* --------------------- 论坛列表（新版信息流） --------------------- */

  function threadIdsIn(element) {
    const ids = new Set();
    element.querySelectorAll('a[href*="/p/"]').forEach(function (anchor) {
      const match = (anchor.getAttribute('href') || '').match(/\/p\/(\d+)/);
      if (match) ids.add(match[1]);
    });
    return ids;
  }

  function findFeedCard(link) {
    const selfMatch = (link.getAttribute('href') || '').match(/\/p\/(\d+)/);
    const selfId = selfMatch ? selfMatch[1] : '';
    let element = link;
    let best = null;
    let depth = 0;

    while (element && element !== document.body && depth < 14) {
      depth += 1;
      const ids = threadIdsIn(element);
      if (selfId) ids.add(selfId);
      if (ids.size > 1) break;

      const rect = element.getBoundingClientRect();
      const text = (element.innerText || '').trim();
      const isHuge = element.children.length > 2 && rect.height > window.innerHeight * 0.95;
      if (ids.size === 1 && !isHuge && rect.width >= 260 && text.length >= 30 && text.length <= 8000) {
        best = element;
      }
      element = element.parentElement;
    }
    return best;
  }

  // 没有 /p/ 链接时的兜底：从作者头像/昵称找到卡片容器
  function findCardFromAuthor(link) {
    const linkRect = link.getBoundingClientRect();
    if (linkRect.top + window.scrollY < 120) return null;

    let element = link;
    let best = null;
    let depth = 0;
    while (element && element !== document.body && depth < 12) {
      depth += 1;
      // 出现第二个主题链接说明已经到了信息流容器，不能再往上
      if (threadIdsIn(element).size > 1) break;

      const text = (element.innerText || '').trim();
      if (text.length > 3000) break;

      const rect = element.getBoundingClientRect();
      const shareCount = (text.match(/分享/g) || []).length;
      if (shareCount > 1) break;
      if (shareCount === 1 && rect.width >= 260 && text.length >= 20) {
        best = element;
        break;
      }
      if (rect.width >= 260 && text.length >= 20) best = element;
      element = element.parentElement;
    }
    return best;
  }

  function processFeedCard(card) {
    if (!card || card.dataset.tbqFeedState) return;
    const text = (card.innerText || '').trim();
    if (!text) return;
    const names = [];
    card.querySelectorAll('a[href*="/home/main"]').forEach(function (anchor) {
      const name = (anchor.textContent || '').trim();
      if (name) names.push(name);
      const image = anchor.querySelector('img');
      if (image && image.getAttribute('alt')) names.push(image.getAttribute('alt'));
    });

    // 卡片头部前几行通常依次是：用户名、等级、发布时间、关注
    const head = text.split('\n').slice(0, 5).join(' ');
    const blockedUser = findBlockedUser(names) || findBlockedUserInText(head);
    const blockedKeyword = blockedUser ? null : findBlockedKeyword(text.slice(0, 2000));

    if (!blockedUser && !blockedKeyword) return;

    card.dataset.tbqFeedState = blockedUser ? 'user' : 'keyword';
    card.classList.add('tbq-hide');
    hiddenThreads.add(card);
    stats.threads += 1;
  }

  function scanFeedCards() {
    // 老版列表已经由 scanForum 处理
    if (document.querySelector('#thread_list, ul.threadlist_bright, .j_threadlist_bright')) return;

    const cards = new Set();
    document.querySelectorAll('a[href*="/p/"]').forEach(function (anchor) {
      if (!/\/p\/\d+/.test(anchor.getAttribute('href') || '')) return;
      const card = findFeedCard(anchor);
      if (card) cards.add(card);
    });

    // 新版页面可能只把作者链接到个人主页，主题链接用 JS 打开，这里按作者链接兜底
    if (!cards.size) {
      document.querySelectorAll('a[href*="/home/main"]').forEach(function (anchor) {
        const card = findCardFromAuthor(anchor);
        if (card) cards.add(card);
      });
    }

    // 连作者链接都没有时，直接按用户名文本找卡片
    if (!cards.size && userIndex.size) {
      document.querySelectorAll('span, a, div, p').forEach(function (node) {
        if (node.children.length) return;
        const text = fold(node.textContent);
        if (!text || text.length > 40 || !userIndex.has(text)) return;
        const card = findCardFromAuthor(node);
        if (card && (card.innerText || '').indexOf('关注') !== -1) cards.add(card);
      });
    }

    cards.forEach(processFeedCard);
  }

  /* ------------------------------ 帖子详情 ------------------------------ */

  function getPostAuthorElement(post) {
    return (
      post.querySelector('.p_author_name') ||
      post.querySelector('.p_author .j_user_card') ||
      post.querySelector('.p_author a[href*="/home/main"]') ||
      post.querySelector('.p_author a')
    );
  }

  function collapsePost(container, content, user, kind) {
    if (!container || !content || container.dataset.tbqCollapsed) return;
    container.dataset.tbqCollapsed = '1';
    container.classList.add('tbq-collapsed');

    const nameElement =
      kind === 'lzl'
        ? container.querySelector('.lzl_p_author, .lzl_pull_author a, .lzl_p_author_name')
        : getPostAuthorElement(container);

    let reasonElement = null;
    if (user.reason && nameElement && nameElement.parentNode) {
      const parent = nameElement.parentNode;
      if (!parent.querySelector('.tbq-reason')) {
        reasonElement = document.createElement('span');
        reasonElement.className = 'tbq-reason';
        reasonElement.textContent = '（' + user.reason + '）';
        nameElement.insertAdjacentElement('afterend', reasonElement);
      }
    }

    const notice = document.createElement('div');
    notice.className = 'tbq-notice';
    notice.setAttribute('role', 'note');

    const icon = document.createElement('span');
    icon.className = 'tbq-notice__icon';
    icon.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5.4c0 4.2 2.9 8.2 7 9.6 4.1-1.4 7-5.4 7-9.6V6l-7-3Z"/><path d="m9.4 12.1 1.8 1.8 3.5-3.6"/></svg>';

    const text = document.createElement('span');
    text.className = 'tbq-notice__text';
    text.textContent = kind === 'lzl' ? '已屏蔽用户评论，是否展示内容' : '已屏蔽用户发帖，是否展示内容';

    const buttons = document.createElement('span');
    buttons.className = 'tbq-notice__btns';

    const showButton = document.createElement('button');
    showButton.type = 'button';
    showButton.dataset.tbqAct = 'show';
    showButton.textContent = '展示';

    const keepButton = document.createElement('button');
    keepButton.type = 'button';
    keepButton.dataset.tbqAct = 'keep';
    keepButton.textContent = '不展示';

    buttons.appendChild(showButton);
    buttons.appendChild(keepButton);
    notice.appendChild(icon);
    notice.appendChild(text);
    notice.appendChild(buttons);

    content.classList.add('tbq-hidden-content');
    content.parentNode.insertBefore(notice, content);

    collapsedPosts.set(container, {
      notice: notice,
      content: content,
      reasonElement: reasonElement,
      user: user
    });
    stats.posts += 1;
  }

  function processPost(post) {
    if (!post || post.nodeType !== 1 || post.dataset.tbqCollapsed) return;
    const field = readDataField(post);
    const authorElement = getPostAuthorElement(post);
    const names = collectNames(field, authorElement);
    const blockedUser = findBlockedUser(names);
    if (!blockedUser) return;

    const content =
      post.querySelector('.d_post_content.j_d_post_content') ||
      post.querySelector('.d_post_content') ||
      post.querySelector('.p_content');
    if (!content) return;
    collapsePost(post, content, blockedUser, 'post');
  }

  function processComment(comment) {
    if (!comment || comment.dataset.tbqCollapsed) return;
    const field = readDataField(comment);
    const authorElement = comment.querySelector('.lzl_p_author, .lzl_pull_author a, .lzl_p_author_name');
    const names = collectNames(field, authorElement);
    const blockedUser = findBlockedUser(names);
    if (!blockedUser) return;

    const content =
      comment.querySelector('.lzl_content_main') || comment.querySelector('.lzl_cnt');
    if (!content) return;
    collapsePost(comment, content, blockedUser, 'lzl');
  }

  function scanThread() {
    document.querySelectorAll('.l_post, .j_l_post').forEach(processPost);
    document.querySelectorAll('.lzl_single_post').forEach(processComment);
  }

  /* ------------------------------ 扫描和重置 ------------------------------ */

  function scanPage() {
    if (scanning || !document.body) return;
    scanning = true;
    try {
      if (isForumPage()) {
        scanForum();
        scanFeedCards();
      }
      if (isThreadPage()) scanThread();
    } catch (error) {
      console.warn('[贴吧美化] 扫描页面失败：', error);
    }
    scanning = false;
    updateStatsUI();
    ensureLatestView();
  }

  function resetPage() {
    hiddenThreads.forEach(function (item) {
      item.classList.remove('tbq-hide');
      delete item.dataset.tbqState;
    });
    hiddenThreads.clear();

    collapsedPosts.forEach(function (record) {
      if (record.notice && record.notice.parentNode) record.notice.remove();
      if (record.content) record.content.classList.remove('tbq-hidden-content');
      if (record.reasonElement && record.reasonElement.parentNode) record.reasonElement.remove();
      if (record.container) {
        delete record.container.dataset.tbqCollapsed;
        record.container.classList.remove('tbq-collapsed');
      }
    });
    collapsedPosts.clear();

    document.querySelectorAll('.tbq-notice').forEach(function (node) { node.remove(); });
    document.querySelectorAll('.tbq-hidden-content').forEach(function (node) {
      node.classList.remove('tbq-hidden-content');
    });
    document.querySelectorAll('.tbq-reason').forEach(function (node) { node.remove(); });
    document.querySelectorAll('[data-tbq-collapsed]').forEach(function (node) {
      delete node.dataset.tbqCollapsed;
    });
    document.querySelectorAll('[data-tbq-feed-state]').forEach(function (node) {
      delete node.dataset.tbqFeedState;
    });

    stats = { threads: 0, posts: 0 };
    updateStatsUI();
  }

  function reapply() {
    resetPage();
    scanPage();
  }

  /* ------------------------------ 折叠提示交互 ------------------------------ */

  function onNoticeClick(event) {
    const button = event.target && event.target.closest ? event.target.closest('[data-tbq-act]') : null;
    if (!button) return;
    const notice = button.closest('.tbq-notice');
    if (!notice) return;
    event.preventDefault();
    event.stopPropagation();

    const container = notice.closest('[data-tbq-collapsed]');
    const record = container && collapsedPosts.get(container);
    if (!record) return;

    if (button.dataset.tbqAct === 'show') {
      record.content.classList.remove('tbq-hidden-content');
      notice.remove();
      record.notice = null;
    } else {
      notice.classList.add('tbq-notice--kept');
      const textNode = notice.querySelector('.tbq-notice__text');
      if (textNode) textNode.textContent = '已屏蔽用户发帖';
      button.remove();
    }
  }

  /* ------------------------------ 设置面板 ------------------------------ */

  const PANEL_CSS = `
    *{box-sizing:border-box}
    .tbq-panel{position:relative;width:min(384px,calc(100vw - 24px));max-height:78vh;display:flex;flex-direction:column;background:#fff;border:1px solid #e5e8f0;border-radius:14px;box-shadow:0 18px 50px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.06);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;color:#1f2329;line-height:1.5;opacity:0;transform:translateY(-6px) scale(.985);transition:opacity .16s ease,transform .16s ease}
    .tbq-panel.is-open{opacity:1;transform:none}
    .tbq-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;background:linear-gradient(180deg,#f7f9ff,#fff);border-bottom:1px solid #eef1f7;flex:0 0 auto}
    .tbq-brand{display:flex;align-items:center;gap:9px;min-width:0}
    .tbq-brand__icon{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#5b7cff,#4e6ef2);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 10px rgba(78,110,242,.28);flex:0 0 auto}
    .tbq-brand__text{display:flex;flex-direction:column;min-width:0}
    .tbq-brand__text b{font-size:14px;font-weight:600;letter-spacing:.2px;color:#1f2329}
    .tbq-brand__text small{font-size:11px;color:#8a94a6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tbq-close{all:unset;width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#8a94a6;cursor:pointer;font-size:13px;line-height:1;flex:0 0 auto}
    .tbq-close:hover{background:#f0f2f7;color:#1f2329}
    .tbq-body{padding:4px 14px 2px;overflow:auto;overscroll-behavior:contain;flex:1 1 auto;min-height:0}
    .tbq-body::-webkit-scrollbar{width:8px}
    .tbq-body::-webkit-scrollbar-thumb{background:#dfe3ea;border-radius:4px}
    .tbq-sec{padding:11px 0;border-bottom:1px dashed #eef1f7}
    .tbq-sec:last-child{border-bottom:0}
    .tbq-sec__head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
    .tbq-sec__head h3{font-size:12.5px;font-weight:600;color:#3d4657;margin:0;display:flex;align-items:center;gap:6px;letter-spacing:.2px}
    .tbq-sec__head h3::before{content:'';width:3px;height:12px;border-radius:2px;background:#4e6ef2}
    .tbq-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#eef1ff;color:#4e6ef2;font-size:11px;font-weight:600;display:inline-flex;align-items:center;justify-content:center}
    .tbq-form{display:flex;gap:6px;margin-bottom:6px}
    .tbq-input{all:unset;box-sizing:border-box;display:block;width:100%;height:32px;padding:0 10px;border:1px solid #dfe3ea;border-radius:8px;background:#fff;color:#1f2329;font:400 12.5px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;transition:border-color .15s ease,box-shadow .15s ease}
    .tbq-input::placeholder{color:#aab2c0}
    .tbq-input:focus{border-color:#8ba1f7;box-shadow:0 0 0 3px rgba(78,110,242,.12)}
    .tbq-form .tbq-input{flex:1 1 auto;min-width:0}
    .tbq-input--full{height:30px}
    .tbq-btn{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border-radius:8px;border:1px solid #dfe3ea;background:#fff;color:#3d4657;font:500 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;cursor:pointer;white-space:nowrap;transition:background .15s ease,border-color .15s ease,color .15s ease;flex:0 0 auto}
    .tbq-btn:hover{border-color:#b9c6ff;background:#f7f9ff;color:#3550d8}
    .tbq-btn--primary{background:#4e6ef2;border-color:#4e6ef2;color:#fff;box-shadow:0 2px 8px rgba(78,110,242,.25)}
    .tbq-btn--primary:hover{background:#3f5ee8;border-color:#3f5ee8;color:#fff}
    .tbq-manage-entry{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:1px solid #e6eaf2;border-radius:10px;background:linear-gradient(180deg,#fbfcff,#f7f9ff);cursor:pointer;transition:border-color .15s ease,box-shadow .15s ease}
    .tbq-manage-entry:hover{border-color:#c7d3ff;box-shadow:0 2px 10px rgba(78,110,242,.08)}
    .tbq-manage-entry__icon{width:28px;height:28px;border-radius:8px;background:#eef1ff;color:#4e6ef2;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
    .tbq-manage-entry__text{flex:1 1 auto;min-width:0;text-align:left}
    .tbq-manage-entry__text b{display:block;font-size:12.5px;font-weight:600;color:#2b3445}
    .tbq-manage-entry__text small{display:block;font-size:11px;color:#98a2b3;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .tbq-manage-entry__count{min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#4e6ef2;color:#fff;font:600 11px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto}
    .tbq-manage-entry__arrow{color:#b6bdca;font-size:16px;line-height:1;flex:0 0 auto}
    .tbq-manage{padding:2px 0 4px}
    .tbq-manage__bar{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0 10px;background:#fff}
    .tbq-back{all:unset;display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border-radius:6px;color:#4e6ef2;font-size:12px;cursor:pointer}
    .tbq-back:hover{background:#eef1ff}
    .tbq-manage__total{font-size:11px;color:#98a2b3}
    .tbq-manage__title{font-size:12.5px;font-weight:600;color:#1f2329;letter-spacing:.2px}
    .tbq-manage__sec{padding:10px 0 12px;border-bottom:1px dashed #eef1f7}
    .tbq-manage__sec:last-of-type{border-bottom:0}
    .tbq-manage__sec header{display:flex;align-items:center;gap:6px;margin-bottom:8px}
    .tbq-manage__sec h4{margin:0;font-size:12.5px;font-weight:600;color:#3d4657}
    .tbq-table{border:1px solid #e9edf4;border-radius:8px;overflow:auto;max-height:196px;background:#fff}
    .tbq-table::-webkit-scrollbar{width:7px;height:7px}
    .tbq-table::-webkit-scrollbar-thumb{background:#e2e6ee;border-radius:4px}
    .tbq-tr{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) 42px;align-items:center;gap:6px;padding:0 8px;min-height:33px;border-bottom:1px solid #f1f3f8;font-size:12px}
    .tbq-tr:last-child{border-bottom:0}
    .tbq-tr--head{position:sticky;top:0;z-index:1;min-height:30px;background:#f7f8fc;color:#8a94a6;font-size:11px;font-weight:600}
    .tbq-tr--head span:last-child{text-align:right}
    .tbq-td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3d4657}
    .tbq-td--name{font-weight:600;color:#2b3445}
    .tbq-td--reason{color:#8a94a6}
    .tbq-td-del{all:unset;justify-self:end;padding:2px 5px;border-radius:5px;color:#e5484d;font-size:11px;cursor:pointer;white-space:nowrap}
    .tbq-td-del:hover{background:#feecec}
    .tbq-empty{padding:14px 8px;text-align:center;color:#aab2c0;font-size:12px}
    .tbq-add-link{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:28px;margin-top:8px;padding:0 12px;border:1px solid #dfe3ea;border-radius:6px;background:#fff;color:#4e6ef2;font-size:12px;cursor:pointer;transition:border-color .15s ease,background .15s ease}
    .tbq-add-link:hover{border-color:#b9c6ff;background:#f7f9ff}
    .tbq-sec--row{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .tbq-rowtext b{display:block;font-size:12.5px;font-weight:600;color:#3d4657}
    .tbq-rowtext small{display:block;font-size:11px;color:#8a94a6;margin-top:2px}
    .tbq-switch{position:relative;display:inline-flex;flex:0 0 auto;width:36px;height:20px;cursor:pointer}
    .tbq-switch input{position:absolute;opacity:0;width:0;height:0}
    .tbq-switch i{width:100%;height:100%;border-radius:10px;background:#dfe3ea;transition:background .18s ease;position:relative;display:block}
    .tbq-switch i::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(15,23,42,.18);transition:transform .18s ease}
    .tbq-switch input:checked + i{background:#4e6ef2}
    .tbq-switch input:checked + i::after{transform:translateX(16px)}
    .tbq-actions{display:flex;gap:8px}
    .tbq-actions .tbq-btn{flex:1 1 0}
    .tbq-note{margin:8px 0 0;font-size:11px;color:#98a2b3;line-height:1.5}
    .tbq-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 14px;border-top:1px solid #eef1f7;background:#fafbfd;color:#98a2b3;font-size:11px;flex:0 0 auto}
    .tbq-ver{color:#b6bdca}
    .tbq-toast{position:absolute;left:50%;bottom:44px;transform:translate(-50%,8px);max-width:calc(100% - 28px);padding:6px 12px;border-radius:8px;background:rgba(31,35,41,.92);color:#fff;font-size:12px;line-height:1.5;opacity:0;pointer-events:none;transition:opacity .18s ease,transform .18s ease;text-align:center;z-index:5}
    .tbq-toast.is-show{opacity:1;transform:translate(-50%,0)}
    .tbq-toast[data-type="err"]{background:rgba(197,42,48,.95)}
    .tbq-view[hidden]{display:none}
    .tbq-about{display:flex;flex-direction:column;align-items:center;text-align:center;padding:18px 6px 12px}
    .tbq-about__logo{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,#5b7cff,#4e6ef2);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(78,110,242,.3)}
    .tbq-about h4{margin:10px 0 0;font-size:16px;font-weight:600;color:#1f2329;letter-spacing:.3px}
    .tbq-about__ver{margin:2px 0 0;font-size:11px;color:#aab2c0}
    .tbq-about__author{margin:14px 0 0;display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:999px;background:#f5f7ff;border:1px solid #e3e9ff;font-size:12px;color:#6b7280}
    .tbq-about__author b{color:#3550d8;font-size:13px;font-weight:600;letter-spacing:.6px}
    .tbq-about__desc{margin:14px 0 0;font-size:12px;line-height:1.7;color:#6b7280}
    .tbq-about__meta{width:100%;margin:16px 0 0;padding-top:12px;border-top:1px dashed #eef1f7;display:flex;flex-direction:column;gap:8px;text-align:left}
    .tbq-about__row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:#8a94a6}
    .tbq-about__row b{color:#3d4657;font-weight:600}
    .tbq-about__tip{margin:12px 0 0;font-size:11px;line-height:1.6;color:#aab2c0}
    .tbq-btn--block{width:100%;margin-top:16px}
    .tbq-foot__right{display:inline-flex;align-items:center;gap:6px}
    .tbq-about-link{all:unset;color:#4e6ef2;font-size:11px;cursor:pointer;padding:2px 5px;border-radius:4px;white-space:nowrap}
    .tbq-about-link:hover{background:#eef1ff}
    .tbq-panel.is-about [data-stats]{visibility:hidden}
    .tbq-panel.is-about .tbq-about-link{display:none}
    .tbq-panel.is-manage [data-stats]{visibility:hidden}
  `;

  const PANEL_HTML = `
    <div class="tbq-panel" role="dialog" aria-label="贴吧美化设置" aria-hidden="true">
      <div class="tbq-head">
        <div class="tbq-brand">
          <span class="tbq-brand__icon">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5.4c0 4.2 2.9 8.2 7 9.6 4.1-1.4 7-5.4 7-9.6V6l-7-3Z"/><path d="m9.4 12.1 1.8 1.8 3.5-3.6"/></svg>
          </span>
          <span class="tbq-brand__text"><b>贴吧美化</b><small>屏蔽用户 · 关键词 · 排序</small></span>
        </div>
        <button type="button" class="tbq-close" data-act="close" aria-label="关闭">✕</button>
      </div>
      <div class="tbq-body">
        <div class="tbq-view" data-view="main">
        <section class="tbq-sec">
          <div class="tbq-sec__head"><h3>屏蔽用户</h3><span class="tbq-badge" data-count="users">0</span></div>
          <div class="tbq-form">
            <input class="tbq-input" type="text" data-input="user-name" placeholder="输入要屏蔽的用户名" maxlength="40" autocomplete="off" spellcheck="false">
            <button type="button" class="tbq-btn tbq-btn--primary" data-act="add-user">添加</button>
          </div>
          <input class="tbq-input tbq-input--full" type="text" data-input="user-reason" placeholder="备注 / 屏蔽原因（可选，会显示在回复用户名右侧）" maxlength="80" autocomplete="off">
        </section>
        <section class="tbq-sec">
          <div class="tbq-sec__head"><h3>屏蔽关键词</h3><span class="tbq-badge" data-count="keywords">0</span></div>
          <div class="tbq-form">
            <input class="tbq-input" type="text" data-input="keyword" placeholder="输入要屏蔽的关键词" maxlength="40" autocomplete="off" spellcheck="false">
            <button type="button" class="tbq-btn tbq-btn--primary" data-act="add-keyword">添加</button>
          </div>
          <input class="tbq-input tbq-input--full" type="text" data-input="keyword-reason" placeholder="备注 / 屏蔽原因（可选）" maxlength="80" autocomplete="off">
        </section>
        <section class="tbq-sec">
          <button type="button" class="tbq-manage-entry" data-act="manage">
            <span class="tbq-manage-entry__icon">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>
            </span>
            <span class="tbq-manage-entry__text"><b>名单管理</b><small>查看或移除已屏蔽的用户与关键词</small></span>
            <span class="tbq-manage-entry__count" data-count-total>0</span>
            <span class="tbq-manage-entry__arrow">›</span>
          </button>
        </section>
        <section class="tbq-sec tbq-sec--row">
          <div class="tbq-rowtext"><b>默认最新发帖排序</b><small>打开贴吧时自动切到“最新”</small></div>
          <label class="tbq-switch"><input type="checkbox" data-act="latest" aria-label="默认最新发帖排序"><i></i></label>
        </section>
        <section class="tbq-sec">
          <div class="tbq-sec__head"><h3>数据同步</h3><span class="tbq-badge" style="background:#f2f4f8;color:#8a94a6">CSV</span></div>
          <div class="tbq-actions">
            <button type="button" class="tbq-btn" data-act="export">导出 CSV</button>
            <button type="button" class="tbq-btn" data-act="import">导入 CSV</button>
            <input type="file" accept=".csv,text/csv" data-input="csv" hidden>
          </div>
          <p class="tbq-note">导出的文件包含全部屏蔽用户与关键词，可在另一台电脑导入；导入只合并、不会清空现有列表。</p>
        </section>
        </div>
        <div class="tbq-view tbq-view--about" data-view="about" hidden>
          <div class="tbq-about">
            <span class="tbq-about__logo">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5.4c0 4.2 2.9 8.2 7 9.6 4.1-1.4 7-5.4 7-9.6V6l-7-3Z"/><path d="m9.4 12.1 1.8 1.8 3.5-3.6"/></svg>
            </span>
            <h4>贴吧美化</h4>
            <p class="tbq-about__ver">版本 v${VERSION}</p>
            <div class="tbq-about__author"><span>作者</span><b>黑渊玄</b></div>
            <p class="tbq-about__desc">屏蔽指定用户与关键词：主题贴直接隐藏，回复折叠提示；支持备注、CSV 导入导出与默认最新发帖排序。</p>
            <div class="tbq-about__meta">
              <div class="tbq-about__row"><span>运行环境</span><b>Chrome · Tampermonkey</b></div>
              <div class="tbq-about__row"><span>数据存储</span><b>本机油猴存储</b></div>
              <div class="tbq-about__row"><span>跨设备同步</span><b>CSV 导入 / 导出</b></div>
            </div>
            <p class="tbq-about__tip">所有屏蔽数据仅在本机处理，不会上传到任何服务器。</p>
            <button type="button" class="tbq-btn tbq-btn--block" data-act="back">返回设置</button>
          </div>
        </div>
        <div class="tbq-view tbq-view--manage" data-view="manage" hidden>
          <div class="tbq-manage">
            <div class="tbq-manage__bar">
              <button type="button" class="tbq-back" data-act="back">‹ 返回</button>
              <span class="tbq-manage__title">名单管理</span>
              <span class="tbq-manage__total" data-manage-total>共 0 项</span>
            </div>
            <section class="tbq-manage__sec">
              <header><h4>屏蔽用户</h4><span class="tbq-badge" data-count-manage="users">0</span></header>
              <div class="tbq-table" data-table="users"></div>
              <button type="button" class="tbq-add-link" data-act="add-user-link">＋ 添加用户</button>
            </section>
            <section class="tbq-manage__sec">
              <header><h4>屏蔽关键词</h4><span class="tbq-badge" data-count-manage="keywords">0</span></header>
              <div class="tbq-table" data-table="keywords"></div>
              <button type="button" class="tbq-add-link" data-act="add-keyword-link">＋ 添加关键词</button>
            </section>
          </div>
        </div>
      </div>
      <div class="tbq-foot">
        <span data-stats>本次已屏蔽 0 主题 / 0 回复</span>
        <span class="tbq-foot__right">
          <button type="button" class="tbq-about-link" data-act="about">关于插件</button>
          <span class="tbq-ver">v${VERSION}</span>
        </span>
      </div>
      <div class="tbq-toast" data-toast></div>
    </div>
  `;

  let panelHost = null;
  let panelRoot = null;
  let panelOpen = false;
  let triggerEl = null;
  let ui = null;
  let toastTimer = 0;

  function createTrigger() {
    if (triggerEl && triggerEl.isConnected) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tbq-trigger';
    button.title = '贴吧美化：屏蔽用户 / 关键词';
    button.setAttribute('aria-expanded', 'false');
    button.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 5 6v5.4c0 4.2 2.9 8.2 7 9.6 4.1-1.4 7-5.4 7-9.6V6l-7-3Z"/><path d="m9.4 12.1 1.8 1.8 3.5-3.6"/></svg><span>贴吧美化</span>';
    button.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      togglePanel();
    });
    triggerEl = button;
    if (document.body) document.body.appendChild(button);
    button.classList.add('tbq-trigger--fixed');
  }

  function findAvatarIn(scope) {
    if (!scope) return null;
    const direct = scope.querySelector('.u_avatar, a.u_avatar, img.user_head');
    if (direct) return direct;
    const links = scope.querySelectorAll('a[href*="home/main"]');
    for (const link of links) {
      if (link.querySelector('img')) return link;
    }
    for (const link of links) {
      const text = (link.textContent || '').trim();
      const rect = link.getBoundingClientRect();
      if (text && text.length <= 12 && rect.top < 160 && rect.width > 0) return link;
    }
    return null;
  }

  function findAvatar() {
    const scope = document.querySelector(
      '.head, #head, .head_inner, .u_menu_item, .tb_header, .top-bar, .navbar'
    );
    if (scope) {
      const hit = findAvatarIn(scope);
      if (hit) return hit;
    }
    // 没有匹配到头部容器时，只在页面顶部区域寻找头像，避免误伤帖子里的作者头像
    const links = document.querySelectorAll('a[href*="home/main"]');
    for (const link of links) {
      const rect = link.getBoundingClientRect();
      if (rect.top < 130 && rect.width > 0 && link.querySelector('img')) return link;
    }
    return null;
  }

  function placeTrigger() {
    if (!triggerEl || !document.body) return;
    if (!triggerEl.isConnected) {
      document.body.appendChild(triggerEl);
      triggerEl.classList.add('tbq-trigger--fixed');
    }
    const avatar = findAvatar();
    if (avatar) {
      const anchor = avatar.closest('a') || avatar;
      if (anchor && anchor.parentNode && !anchor.contains(triggerEl)) {
        if (triggerEl.previousElementSibling !== anchor) {
          anchor.insertAdjacentElement('afterend', triggerEl);
        }
        triggerEl.classList.remove('tbq-trigger--fixed');
        if (panelOpen) positionPanel();
        return;
      }
    }
    triggerEl.classList.add('tbq-trigger--fixed');
  }

  function createPanel() {
    if (panelHost && panelHost.isConnected) return;
    if (!document.body) return;

    panelHost = document.createElement('div');
    panelHost.className = 'tbq-host';
    panelHost.style.cssText = 'position:fixed;z-index:2147483000;display:none;';
    panelRoot = panelHost.attachShadow({ mode: 'open' });
    panelRoot.innerHTML = '<style>' + PANEL_CSS + '</style>' + PANEL_HTML;
    document.body.appendChild(panelHost);

    ui = {
      panel: panelRoot.querySelector('.tbq-panel'),
      toast: panelRoot.querySelector('[data-toast]'),
      stats: panelRoot.querySelector('[data-stats]'),
      latest: panelRoot.querySelector('[data-act="latest"]'),
      fileInput: panelRoot.querySelector('[data-input="csv"]'),
      aboutLink: panelRoot.querySelector('.tbq-about-link'),
      views: {
        main: panelRoot.querySelector('[data-view="main"]'),
        about: panelRoot.querySelector('[data-view="about"]'),
        manage: panelRoot.querySelector('[data-view="manage"]')
      },
      counts: {
        users: panelRoot.querySelector('[data-count="users"]'),
        keywords: panelRoot.querySelector('[data-count="keywords"]')
      },
      manageCounts: {
        users: panelRoot.querySelector('[data-count-manage="users"]'),
        keywords: panelRoot.querySelector('[data-count-manage="keywords"]')
      },
      totalCount: panelRoot.querySelector('[data-count-total]'),
      manageTotal: panelRoot.querySelector('[data-manage-total]'),
      tables: {
        users: panelRoot.querySelector('[data-table="users"]'),
        keywords: panelRoot.querySelector('[data-table="keywords"]')
      },
      inputs: {
        userName: panelRoot.querySelector('[data-input="user-name"]'),
        userReason: panelRoot.querySelector('[data-input="user-reason"]'),
        keyword: panelRoot.querySelector('[data-input="keyword"]'),
        keywordReason: panelRoot.querySelector('[data-input="keyword-reason"]')
      }
    };

    bindPanelEvents();
    renderLists();
    syncLatestCheckbox();
    updateStatsUI();
  }

  function bindPanelEvents() {
    panelRoot.addEventListener('click', onPanelClick);

    ui.inputs.userName.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addUser(); }
    });
    ui.inputs.userReason.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addUser(); }
    });
    ui.inputs.keyword.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addKeyword(); }
    });
    ui.inputs.keywordReason.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addKeyword(); }
    });

    ui.latest.addEventListener('change', function () {
      state.latestSort = ui.latest.checked;
      saveState();
      toast(state.latestSort ? '已开启默认最新排序' : '已关闭默认最新排序');
      if (state.latestSort) {
        goLatestNow();
        resetLatestView(location.pathname + '|' + forumKeyword());
        window.setTimeout(ensureLatestView, 800);
      }
    });

    ui.fileInput.addEventListener('change', function () {
      const file = ui.fileInput.files && ui.fileInput.files[0];
      if (!file) return;
      readFileText(file)
        .then(function (text) {
          importCsvText(text);
        })
        .catch(function () {
          toast('导入失败：无法读取文件', 'err');
        })
        .then(function () {
          ui.fileInput.value = '';
        });
    });
  }

  function onPanelClick(event) {
    const actionElement = event.target && event.target.closest ? event.target.closest('[data-act]') : null;
    if (!actionElement) return;
    const action = actionElement.dataset.act;

    if (action === 'close') {
      closePanel();
    } else if (action === 'about') {
      showView(ui.views.about.hidden ? 'about' : 'main');
    } else if (action === 'manage') {
      showView('manage');
    } else if (action === 'add-user-link') {
      showView('main');
      window.setTimeout(function () { ui.inputs.userName.focus({ preventScroll: true }); }, 30);
    } else if (action === 'add-keyword-link') {
      showView('main');
      window.setTimeout(function () { ui.inputs.keyword.focus({ preventScroll: true }); }, 30);
    } else if (action === 'back') {
      showView('main');
    } else if (action === 'add-user') {
      addUser();
    } else if (action === 'add-keyword') {
      addKeyword();
    } else if (action === 'del-user') {
      removeEntry('user', actionElement.dataset.value);
    } else if (action === 'del-keyword') {
      removeEntry('keyword', actionElement.dataset.value);
    } else if (action === 'export') {
      exportCsv();
    } else if (action === 'import') {
      ui.fileInput.click();
    }
  }

  function renderLists() {
    if (!ui) return;
    renderTable('users', state.users, 'name', 'user');
    renderTable('keywords', state.keywords, 'word', 'keyword');
  }

  function updateManageTotals() {
    const total = state.users.length + state.keywords.length;
    if (ui.totalCount) ui.totalCount.textContent = String(total);
    if (ui.manageTotal) ui.manageTotal.textContent = '共 ' + total + ' 项';
  }

  function renderTable(kind, entries, key, actionSuffix) {
    const table = ui.tables[kind];
    if (!table) return;
    table.textContent = '';

    const head = document.createElement('div');
    head.className = 'tbq-tr tbq-tr--head';
    const labels = kind === 'users' ? ['用户名', '备注', '操作'] : ['关键词', '备注', '操作'];
    labels.forEach(function (label) {
      const cell = document.createElement('span');
      cell.textContent = label;
      head.appendChild(cell);
    });
    table.appendChild(head);

    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'tbq-empty';
      empty.textContent = kind === 'users' ? '暂无屏蔽用户' : '暂无屏蔽关键词';
      table.appendChild(empty);
    } else {
      entries.forEach(function (entry) {
        const row = document.createElement('div');
        row.className = 'tbq-tr';

        const name = document.createElement('span');
        name.className = 'tbq-td tbq-td--name';
        name.textContent = entry[key];
        name.title = entry[key];

        const reason = document.createElement('span');
        reason.className = 'tbq-td tbq-td--reason';
        reason.textContent = entry.reason || '—';
        reason.title = entry.reason || '';

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'tbq-td-del';
        remove.textContent = '移除';
        remove.dataset.act = actionSuffix === 'user' ? 'del-user' : 'del-keyword';
        remove.dataset.value = entry[key];

        row.appendChild(name);
        row.appendChild(reason);
        row.appendChild(remove);
        table.appendChild(row);
      });
    }

    if (ui.counts[kind]) ui.counts[kind].textContent = String(entries.length);
    if (ui.manageCounts[kind]) ui.manageCounts[kind].textContent = String(entries.length);
    updateManageTotals();
  }

  function showView(name) {
    if (!ui) return;
    const about = name === 'about';
    const manage = name === 'manage';
    ui.views.main.hidden = about || manage;
    ui.views.about.hidden = !about;
    ui.views.manage.hidden = !manage;
    ui.panel.classList.toggle('is-about', about);
    ui.panel.classList.toggle('is-manage', manage);
    if (ui.aboutLink) ui.aboutLink.textContent = about ? '返回设置' : '关于插件';
    if (manage) renderLists();
    const body = panelRoot.querySelector('.tbq-body');
    if (body) body.scrollTop = 0;
  }

  function syncLatestCheckbox() {
    if (ui && ui.latest) ui.latest.checked = !!state.latestSort;
  }

  function toast(message, type) {
    if (!ui || !ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.dataset.type = type || 'ok';
    ui.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      ui.toast.classList.remove('is-show');
    }, 2200);
  }

  function openPanel() {
    createPanel();
    createTrigger();
    if (!panelHost || !ui) return;
    panelOpen = true;
    renderLists();
    syncLatestCheckbox();
    showView('main');
    updateStatsUI();
    panelHost.style.display = 'block';
    positionPanel();
    ui.panel.setAttribute('aria-hidden', 'false');
    triggerEl.classList.add('is-active');
    triggerEl.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () {
      ui.panel.classList.add('is-open');
      positionPanel();
    });
    window.setTimeout(function () {
      if (panelOpen && ui.inputs.userName) ui.inputs.userName.focus({ preventScroll: true });
    }, 80);
  }

  function closePanel() {
    if (!panelOpen || !ui) return;
    panelOpen = false;
    ui.panel.classList.remove('is-open');
    ui.panel.setAttribute('aria-hidden', 'true');
    if (triggerEl) {
      triggerEl.classList.remove('is-active');
      triggerEl.setAttribute('aria-expanded', 'false');
    }
    window.setTimeout(function () {
      if (!panelOpen && panelHost) panelHost.style.display = 'none';
    }, 170);
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
  }

  function positionPanel() {
    if (!panelOpen || !ui || !triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const margin = 12;
    const width = Math.min(384, window.innerWidth - margin * 2);
    let right = window.innerWidth - rect.right;
    right = Math.max(margin, Math.min(right, window.innerWidth - width - margin));
    let top = Math.max(margin, rect.bottom + 8);
    const available = window.innerHeight - top - margin;
    if (available < 260) {
      top = Math.max(margin, window.innerHeight - 300);
    }
    panelHost.style.top = Math.round(top) + 'px';
    panelHost.style.right = Math.round(right) + 'px';
    ui.panel.style.maxHeight = Math.max(220, window.innerHeight - top - margin) + 'px';
  }

  /* ------------------------------ 增删改 ------------------------------ */

  function addUser() {
    if (!ui) return;
    const name = toText(ui.inputs.userName.value).slice(0, MAX_NAME);
    const reason = toText(ui.inputs.userReason.value).slice(0, MAX_REASON);
    if (!name) {
      toast('请输入要屏蔽的用户名', 'err');
      ui.inputs.userName.focus();
      return;
    }
    const key = fold(name);
    const existing = state.users.find(function (user) { return fold(user.name) === key; });
    if (existing) {
      existing.reason = reason;
      saveState();
      renderLists();
      reapply();
      toast('已在列表中，已更新备注');
    } else {
      state.users.push({ name: name, reason: reason, at: Date.now() });
      saveState();
      renderLists();
      reapply();
      toast('已屏蔽用户「' + name + '」');
    }
    ui.inputs.userName.value = '';
    ui.inputs.userReason.value = '';
    ui.inputs.userName.focus();
  }

  function addKeyword() {
    if (!ui) return;
    const word = toText(ui.inputs.keyword.value).slice(0, MAX_NAME);
    const reason = toText(ui.inputs.keywordReason.value).slice(0, MAX_REASON);
    if (!word) {
      toast('请输入要屏蔽的关键词', 'err');
      ui.inputs.keyword.focus();
      return;
    }
    const key = fold(word);
    const existing = state.keywords.find(function (keyword) { return fold(keyword.word) === key; });
    if (existing) {
      existing.reason = reason;
      saveState();
      renderLists();
      reapply();
      toast('已在列表中，已更新备注');
    } else {
      state.keywords.push({ word: word, reason: reason, at: Date.now() });
      saveState();
      renderLists();
      reapply();
      toast('已屏蔽关键词「' + word + '」');
    }
    ui.inputs.keyword.value = '';
    ui.inputs.keywordReason.value = '';
    ui.inputs.keyword.focus();
  }

  function removeEntry(kind, value) {
    const key = kind === 'user' ? 'name' : 'word';
    const list = kind === 'user' ? state.users : state.keywords;
    const index = list.findIndex(function (entry) { return fold(entry[key]) === fold(value); });
    if (index < 0) return;
    const removed = list.splice(index, 1)[0];
    saveState();
    renderLists();
    reapply();
    toast('已移除「' + removed[key] + '」');
  }

  /* ------------------------------ CSV ------------------------------ */

  function csvCell(value) {
    const text = String(value == null ? '' : value);
    if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function exportCsv() {
    const rows = [['类型', '名称', '备注']];
    state.users.forEach(function (user) { rows.push(['用户', user.name, user.reason || '']); });
    state.keywords.forEach(function (keyword) { rows.push(['关键词', keyword.word, keyword.reason || '']); });
    const content = '\uFEFF' + rows.map(function (row) {
      return row.map(csvCell).join(',');
    }).join('\r\n') + '\r\n';

    const now = new Date();
    const filename =
      '贴吧屏蔽列表_' + now.getFullYear() + pad2(now.getMonth() + 1) + pad2(now.getDate()) +
      '_' + pad2(now.getHours()) + pad2(now.getMinutes()) + '.csv';

    const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
      link.remove();
    }, 1500);

    toast('已导出 ' + (state.users.length + state.keywords.length) + ' 条屏蔽数据');
  }

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (inQuotes) {
        if (char === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        row.push(field);
        field = '';
      } else if (char === '\n') {
        row.push(field);
        field = '';
        rows.push(row);
        row = [];
      } else if (char !== '\r') {
        field += char;
      }
    }

    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }

    return rows.filter(function (cells) {
      return cells.some(function (cell) { return String(cell).trim() !== ''; });
    });
  }

  function isHeaderRow(row) {
    if (!row || !row.length) return false;
    const first = String(row[0] || '').trim().toLowerCase();
    return first === '类型' || first === 'type';
  }

  function importCsvText(text) {
    const rows = parseCsv(String(text || '').replace(/^\uFEFF/, ''));
    if (!rows.length) {
      toast('CSV 内容为空', 'err');
      return;
    }

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const start = isHeaderRow(rows[0]) ? 1 : 0;

    for (let index = start; index < rows.length; index += 1) {
      const row = rows[index];
      const type = String(row[0] || '').trim().toLowerCase();
      const value = toText(row[1]).slice(0, MAX_NAME);
      const reason = toText(row[2]).slice(0, MAX_REASON);

      let target = null;
      let key = '';
      if (/^(用户|用户名|user|u|1)$/.test(type)) {
        target = state.users;
        key = 'name';
      } else if (/^(关键词|关键字|keyword|kw|k|2)$/.test(type)) {
        target = state.keywords;
        key = 'word';
      } else {
        skipped += 1;
        continue;
      }

      if (!value) {
        skipped += 1;
        continue;
      }

      const folded = fold(value);
      const existing = target.find(function (entry) { return fold(entry[key]) === folded; });
      if (existing) {
        if (reason && existing.reason !== reason) {
          existing.reason = reason;
          updated += 1;
        } else {
          skipped += 1;
        }
      } else {
        target.push({ [key]: value, reason: reason, at: Date.now() });
        added += 1;
      }
    }

    if (!added && !updated) {
      toast('没有可导入的新数据', 'err');
      return;
    }

    saveState();
    renderLists();
    syncLatestCheckbox();
    reapply();
    toast('导入完成：新增 ' + added + ' 条，更新 ' + updated + ' 条' + (skipped ? '，忽略 ' + skipped + ' 条' : ''));
  }

  function readFileText(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        const buffer = reader.result;
        let text = '';
        try {
          text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
        } catch (e) {
          text = '';
        }
        if (!text || text.indexOf('\uFFFD') !== -1) {
          try {
            text = new TextDecoder('gbk').decode(buffer);
          } catch (e) { /* 保持 utf-8 结果 */ }
        }
        resolve(text.replace(/^\uFEFF/, ''));
      };
      reader.onerror = function () {
        reject(reader.error || new Error('read error'));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ------------------------------ 启动 ------------------------------ */

  let scanTimer = 0;

  function scheduleScan(delay) {
    if (scanTimer) return;
    scanTimer = window.setTimeout(function () {
      scanTimer = 0;
      if (!document.body) return;
      placeTrigger();
      scanPage();
    }, typeof delay === 'number' ? delay : SCAN_DELAY);
  }

  function observePage() {
    if (!document.body) return;
    const observer = new MutationObserver(function (mutations) {
      for (const mutation of mutations) {
        if (mutation.type === 'childList' && (mutation.addedNodes.length || mutation.removedNodes.length)) {
          scheduleScan();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    if (!document.body) return;
    addPageStyles();
    createTrigger();
    createPanel();
    placeTrigger();
    fixLatestFromDom();
    scanPage();
    observePage();

    window.addEventListener('resize', function () {
      if (panelOpen) positionPanel();
    });

    document.addEventListener('click', onNoticeClick, true);
    document.addEventListener('click', function (event) {
      if (!panelOpen) return;
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.indexOf(panelHost) !== -1 || path.indexOf(triggerEl) !== -1) return;
      closePanel();
    }, true);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !panelOpen) return;
      if (ui && ui.views && (!ui.views.about.hidden || !ui.views.manage.hidden)) showView('main');
      else closePanel();
    });

    // 贴吧头部有时会异步渲染，补两次挂载与扫描
    window.setTimeout(function () { placeTrigger(); scanPage(); }, 1200);
    window.setTimeout(function () { placeTrigger(); scanPage(); }, 3500);
    window.setTimeout(function () { ensureLatestView(); }, 6500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
