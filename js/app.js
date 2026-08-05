/*!
 * app.js —— 静态版主逻辑
 *
 * 与原仓库 public/js/app.js 的对应关系：
 *   api.getMe / logout        → 删除（无 CAS，纯本地令牌）
 *   api.listProjects/listDirs → HBStore.loadMeta 后在内存里筛
 *   api.uploadFiles           → HBCore 审查 + HBStore.commitBatch
 *   api.setVisibility         → 删除（GitHub Pages 是全公开的，做三级可见性是自欺欺人）
 *   访问计数 access_count      → 删除（静态站点统计不了）
 *   api.setExpires            → 保留，降级为"软过期"（s.html 拦截提示，文件仍在仓库里）
 * 其余交互（拖拽、目录、面包屑、搜索、标签、多选、批量删除）逐条保留。
 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  /* ===================== DOM ===================== */
  var dropZone = $('#dropZone');
  var fileInput = $('#fileInput');
  var dirInput = $('#dirInput');
  var selectBtn = $('#selectBtn');
  var selectDirBtn = $('#selectDirBtn');
  var expireSelect = $('#expireSelect');
  var uploadProgress = $('#uploadProgress');
  var progressFill = $('#progressFill');
  var progressText = $('#progressText');
  var fileListBody = $('#fileListBody');
  var emptyState = $('#emptyState');
  var checkAll = $('#checkAll');
  var batchDeleteBtn = $('#batchDeleteBtn');
  var copyAllBtn = $('#copyAllBtn');
  var newDirBtn = $('#newDirBtn');
  var projectCount = $('#projectCount');
  var toastEl = $('#toast');
  var searchInput = $('#searchInput');
  var tagFilters = $('#tagFilters');
  var breadcrumb = $('#breadcrumb');
  var targetDirPath = $('#targetDirPath');
  var repoChip = $('#repoChip');
  var settingsBtn = $('#settingsBtn');

  var setupModal = $('#setupModal');
  var cfgOwner = $('#cfgOwner');
  var cfgRepo = $('#cfgRepo');
  var cfgBranch = $('#cfgBranch');
  var cfgToken = $('#cfgToken');
  var cfgStatus = $('#cfgStatus');
  var cfgSave = $('#cfgSave');
  var cfgTest = $('#cfgTest');
  var cfgClose = $('#cfgClose');

  var urlModal = $('#urlModal');
  var urlInput = $('#urlInput');
  var urlCopyBtn = $('#urlCopyBtn');
  var urlModalClose = $('#urlModalClose');
  var shareTitle = $('#shareTitle');
  var shareStatus = $('#shareStatus');
  var directRow = $('#directRow');
  var directInput = $('#directInput');
  var directCopyBtn = $('#directCopyBtn');
  var expireSegmented = $('#expireSegmented');
  var tagInput = $('#tagInput');
  var tagSaveBtn = $('#tagSaveBtn');
  var qrWrap = $('#qrWrap');
  var qrCap = $('#qrCap');

  var dirModal = $('#dirModal');
  var dirNameInput = $('#dirNameInput');
  var dirCancel = $('#dirCancel');
  var dirCreate = $('#dirCreate');

  var confirmModal = $('#confirmModal');
  var confirmText = $('#confirmText');
  var confirmCancel = $('#confirmCancel');
  var confirmOk = $('#confirmOk');

  var reviewModal = $('#reviewModal');
  var reviewTitle = $('#reviewTitle');
  var reviewList = $('#reviewList');
  var reviewCancel = $('#reviewCancel');
  var reviewGo = $('#reviewGo');

  /* ===================== 状态 ===================== */
  var CFG_KEY = 'hb.cfg.v1';
  var cfg = { owner: '', repo: '', branch: 'main', token: '' };
  var meta = { version: 1, dirs: [], projects: [] };
  var currentDirId = null;
  var currentPath = [];
  var currentProjects = [];
  var currentDirs = [];
  var activeTag = '';
  var searchTimer = null;
  var confirmResolve = null;
  var reviewResolve = null;
  var shareProject = null;
  var busy = false;

  // 站点根：把当前页面的目录取出来，s.html / f/ 都挂在同级
  var BASE = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');

  /* ===================== 小工具 ===================== */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove('show'); }, 3200);
  }
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function showConfirm(msg) {
    return new Promise(function (resolve) {
      confirmResolve = resolve;
      confirmText.textContent = msg;
      confirmModal.hidden = false;
    });
  }
  confirmCancel.onclick = function () { confirmModal.hidden = true; if (confirmResolve) confirmResolve(false); };
  confirmOk.onclick = function () { confirmModal.hidden = true; if (confirmResolve) confirmResolve(true); };
  confirmModal.onclick = function (e) { if (e.target === confirmModal) confirmCancel.onclick(); };

  function encodePath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/');
  }
  function shareUrl(p) { return BASE + 's.html#' + encodeURIComponent(p.shortId); }
  function directUrl(p) {
    if (!p.entryFile) return '';
    return BASE + 'f/' + encodeURIComponent(p.storageId) + '/' + encodePath(p.entryFile);
  }
  function nowIso() { return new Date().toISOString(); }

  /* ===================== 配置 ===================== */
  function loadCfg() {
    try {
      var raw = localStorage.getItem(CFG_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        cfg.owner = o.owner || '';
        cfg.repo = o.repo || '';
        cfg.branch = o.branch || 'main';
        cfg.token = o.token || '';
      }
    } catch (e) { /* 坏数据当没配 */ }
    // 部署在 <owner>.github.io/<repo>/ 上时，自动猜一次仓库信息，省得手填
    if (!cfg.owner || !cfg.repo) {
      var m = location.hostname.match(/^([\w-]+)\.github\.io$/i);
      if (m) {
        if (!cfg.owner) cfg.owner = m[1];
        if (!cfg.repo) {
          var seg = location.pathname.split('/').filter(Boolean);
          cfg.repo = seg.length ? seg[0] : m[1] + '.github.io';
        }
      }
    }
  }
  function saveCfg() {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  }
  function cfgReady() { return !!(cfg.owner && cfg.repo && cfg.branch && cfg.token); }

  function renderRepoChip() {
    if (cfgReady()) {
      repoChip.textContent = '📦 ' + cfg.owner + '/' + cfg.repo + ' · ' + cfg.branch;
      repoChip.classList.remove('unset');
      repoChip.title = '当前仓库：' + cfg.owner + '/' + cfg.repo + '（分支 ' + cfg.branch + '）';
    } else {
      repoChip.textContent = '⚠️ 未配置仓库';
      repoChip.classList.add('unset');
      repoChip.title = '点击右侧「设置」填写 GitHub 仓库与访问令牌';
    }
    dropZone.classList.toggle('disabled', !cfgReady());
  }

  function openSetup() {
    cfgOwner.value = cfg.owner;
    cfgRepo.value = cfg.repo;
    cfgBranch.value = cfg.branch || 'main';
    cfgToken.value = cfg.token;
    setStatus('', '');
    setupModal.hidden = false;
    setTimeout(function () { (cfg.owner ? cfgToken : cfgOwner).focus(); }, 50);
  }
  function closeSetup() { setupModal.hidden = true; }
  function setStatus(msg, kind) {
    cfgStatus.textContent = msg;
    cfgStatus.className = 'cfg-status ' + (kind || 'info');
    cfgStatus.hidden = !msg;
  }
  function readCfgForm() {
    return {
      owner: cfgOwner.value.trim().replace(/^@/, ''),
      repo: cfgRepo.value.trim().replace(/\.git$/, ''),
      branch: cfgBranch.value.trim() || 'main',
      token: cfgToken.value.trim()
    };
  }

  settingsBtn.onclick = openSetup;
  repoChip.onclick = openSetup;
  cfgClose.onclick = closeSetup;
  setupModal.onclick = function (e) { if (e.target === setupModal && cfgReady()) closeSetup(); };

  cfgTest.onclick = async function () {
    var c = readCfgForm();
    if (!c.owner || !c.repo || !c.token) { setStatus('用户名 / 仓库名 / 令牌都要填。', 'err'); return; }
    cfgTest.disabled = true;
    setStatus('正在连接 GitHub…', 'info');
    try {
      var info = await HBStore.verify(c);
      var lines = ['✅ 连接成功。默认分支 ' + info.defaultBranch + '。'];
      if (info.defaultBranch !== c.branch) {
        lines.push('⚠️ 你填的分支是 ' + c.branch + '，与默认分支不同，确认无误再保存。');
      }
      if (info.private) {
        lines.push('⚠️ 这是私有仓库。GitHub Pages 对私有仓库需要付费方案，免费账号请改成公开仓库。');
      }
      lines.push(info.pagesUrl
        ? '🌐 Pages 已开启：' + info.pagesUrl
        : '⚠️ 该仓库还没开启 Pages。去 Settings → Pages，Source 选 Deploy from a branch。');
      setStatus(lines.join('\n'), info.private ? 'err' : 'ok');
      cfgStatus.style.whiteSpace = 'pre-line';
    } catch (err) {
      setStatus('❌ ' + err.message, 'err');
    } finally {
      cfgTest.disabled = false;
    }
  };

  cfgSave.onclick = async function () {
    var c = readCfgForm();
    if (!c.owner || !c.repo || !c.token) { setStatus('用户名 / 仓库名 / 令牌都要填。', 'err'); return; }
    cfg = c;
    saveCfg();
    renderRepoChip();
    closeSetup();
    toast('配置已保存');
    await refresh();
  };

  /* ===================== 数据 ===================== */
  async function refresh() {
    if (!cfgReady()) { renderList([], []); return; }
    try {
      meta = await HBStore.loadMeta(cfg);
      normalizeMeta();
      renderView();
    } catch (err) {
      toast(err.message);
    }
  }

  function normalizeMeta() {
    if (!Array.isArray(meta.projects)) meta.projects = [];
    if (!Array.isArray(meta.dirs)) meta.dirs = [];
    meta.projects.forEach(function (p) {
      if (!p.storages || !p.storages.length) p.storages = [p.storageId || p.shortId];
      if (!p.storageId) p.storageId = p.storages[p.storages.length - 1];
      if (!p.tags) p.tags = [];
      if (!p.files) p.files = [];
      if (!p.version) p.version = 1;
    });
    // 当前目录如果被别处删掉了，退回根目录
    if (currentDirId && !meta.dirs.some(function (d) { return d.id === currentDirId; })) {
      currentDirId = null;
    }
  }

  function dirPathOf(id) {
    var path = [], guard = 0;
    while (id && guard++ < 64) {
      var d = meta.dirs.find(function (x) { return x.id === id; });
      if (!d) break;
      path.unshift({ id: d.id, name: d.name });
      id = d.parentId;
    }
    return path;
  }
  function childDirs(parentId) {
    return meta.dirs
      .filter(function (d) { return (d.parentId || null) === (parentId || null); })
      .sort(function (a, b) { return a.name.localeCompare(b.name, 'zh'); });
  }
  function projectsIn(dirId) {
    return meta.projects.filter(function (p) { return (p.dirId || null) === (dirId || null); });
  }
  function isSearching() { return !!(searchInput.value.trim() || activeTag); }

  function renderView() {
    if (isSearching()) {
      var kw = searchInput.value.trim().toLowerCase();
      currentProjects = meta.projects.filter(function (p) {
        var okKw = !kw || (p.name || '').toLowerCase().indexOf(kw) >= 0 ||
                   (p.entryFile || '').toLowerCase().indexOf(kw) >= 0;
        var okTag = !activeTag || (p.tags || []).indexOf(activeTag) >= 0;
        return okKw && okTag;
      });
      currentDirs = [];
      renderBreadcrumb(true);
    } else {
      currentPath = dirPathOf(currentDirId);
      currentDirs = childDirs(currentDirId);
      currentProjects = projectsIn(currentDirId);
      renderBreadcrumb(false);
    }
    currentProjects = currentProjects.slice().sort(function (a, b) {
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
    renderList(currentProjects, currentDirs);
    renderTags();
    updateTargetDir();
  }

  function renderTags() {
    var counts = {};
    meta.projects.forEach(function (p) {
      (p.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var names = Object.keys(counts).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
    tagFilters.innerHTML = names.map(function (t) {
      return '<button class="tag-filter-btn' + (activeTag === t ? ' active' : '') +
             '" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + ' (' + counts[t] + ')</button>';
    }).join('');
  }

  function updateTargetDir() {
    var label = currentPath.length ? '📂 ' + currentPath.map(function (p) { return p.name; }).join(' / ') : '📂 根目录';
    targetDirPath.textContent = label;
    targetDirPath.title = '上传将保存到：' + (currentPath.length ? currentPath.map(function (p) { return p.name; }).join(' / ') : '根目录');
  }

  function renderBreadcrumb(searching) {
    if (searching) {
      breadcrumb.innerHTML = '<span class="crumb current">🔍 搜索结果（全部目录）</span>';
      return;
    }
    var html = '<button class="crumb ' + (currentPath.length === 0 ? 'current' : '') + '" data-dir-id="">🏠 根目录</button>';
    currentPath.forEach(function (seg, i) {
      var isCurrent = i === currentPath.length - 1;
      html += '<span class="crumb-sep">/</span>';
      html += '<button class="crumb ' + (isCurrent ? 'current' : '') + '" data-dir-id="' + escapeHtml(seg.id) + '">' + escapeHtml(seg.name) + '</button>';
    });
    breadcrumb.innerHTML = html;
  }

  breadcrumb.addEventListener('click', function (e) {
    var btn = e.target.closest('.crumb');
    if (!btn || btn.classList.contains('current')) return;
    currentDirId = btn.dataset.dirId || null;
    searchInput.value = '';
    activeTag = '';
    renderView();
  });

  /* ===================== 渲染：图标与行 ===================== */
  var EXT_ICON = {
    html: { label: 'HTML', light: '#fbe3d0', corner: '#e8864a', dark: '#b3541e' },
    htm:  { label: 'HTML', light: '#fbe3d0', corner: '#e8864a', dark: '#b3541e' },
    md:   { label: 'MD',   light: '#dbe7fb', corner: '#5b8def', dark: '#2f5fc4' },
    txt:  { label: 'TXT',  light: '#ece5d8', corner: '#a89a86', dark: '#6e6152' },
    css:  { label: 'CSS',  light: '#d8e8f9', corner: '#4a90d9', dark: '#2c6cab' },
    js:   { label: 'JS',   light: '#faeec6', corner: '#e8b83c', dark: '#a37416' },
    mjs:  { label: 'JS',   light: '#faeec6', corner: '#e8b83c', dark: '#a37416' },
    json: { label: 'JSON', light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    svg:  { label: 'SVG',  light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    png:  { label: 'PNG',  light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    jpg:  { label: 'JPG',  light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    jpeg: { label: 'JPEG', light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    gif:  { label: 'GIF',  light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    webp: { label: 'WEBP', light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    ico:  { label: 'ICO',  light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    avif: { label: 'AVIF', light: '#d9f0e2', corner: '#5cb98a', dark: '#2e8e63' },
    woff: { label: 'FONT', light: '#e8def5', corner: '#9a7fd1', dark: '#6a4fb3' },
    woff2:{ label: 'FONT', light: '#e8def5', corner: '#9a7fd1', dark: '#6a4fb3' },
    ttf:  { label: 'FONT', light: '#e8def5', corner: '#9a7fd1', dark: '#6a4fb3' },
    eot:  { label: 'FONT', light: '#e8def5', corner: '#9a7fd1', dark: '#6a4fb3' },
    otf:  { label: 'FONT', light: '#e8def5', corner: '#9a7fd1', dark: '#6a4fb3' },
    _default: { label: 'FILE', light: '#ece5d8', corner: '#a89a86', dark: '#6e6152' }
  };
  function docIcon(label, light, corner, dark) {
    var fs = label.length > 3 ? 6.5 : 8;
    return '<svg class="file-doc" width="32" height="38" viewBox="0 0 32 38" aria-hidden="true">' +
      '<path d="M4 5.5 Q4 3 6.5 3 H20 L28 11.5 V32.5 Q28 35 25.5 35 H6.5 Q4 35 4 32.5 Z" fill="' + light + '"/>' +
      '<path d="M20 3 L28 11.5 H22 Q20 11.5 20 9.5 Z" fill="' + corner + '"/>' +
      '<text x="16" y="26.5" text-anchor="middle" font-size="' + fs + '" font-weight="900" fill="' + dark + '">' + label + '</text>' +
      '</svg>';
  }
  function folderIcon() {
    return '<svg class="file-folder" width="38" height="33" viewBox="0 0 38 33" aria-hidden="true">' +
      '<path d="M3 8 Q3 5 6 5 H14 L17.5 9 H32 Q35 9 35 12 V27 Q35 30 32 30 H6 Q3 30 3 27 Z" fill="#d9a52e"/>' +
      '<path d="M3 13.5 Q3 11.5 5 11.5 H33 Q35 11.5 35 13.5 V27 Q35 30 32 30 H6 Q3 30 3 27 Z" fill="#f3cd6b"/>' +
      '</svg>';
  }
  function isFolderProject(p) {
    return p.fileCount > 1 || String(p.files[0] && p.files[0].p || '').indexOf('/') >= 0;
  }
  function displayName(p) {
    if (isFolderProject(p)) return p.name;
    var src = (p.files[0] && p.files[0].p) || p.entryFile || '';
    return src ? src.split('/').pop() : p.name;
  }
  function fileIcon(p) {
    if (isFolderProject(p)) return folderIcon();
    var src = (p.files[0] && p.files[0].p) || p.entryFile || '';
    var i = src.lastIndexOf('.');
    var ext = i >= 0 ? src.slice(i + 1).toLowerCase() : '';
    var t = EXT_ICON[ext] || EXT_ICON._default;
    return docIcon(t.label, t.light, t.corner, t.dark);
  }
  function formatTime(dateStr) {
    var diff = Date.now() - new Date(dateStr).getTime();
    var min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + ' 分钟前';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + ' 小时前';
    var day = Math.floor(hr / 24);
    if (day < 30) return day + ' 天前';
    return new Date(dateStr).toLocaleDateString('zh-CN');
  }
  function formatExpiry(expiresAt) {
    if (!expiresAt) return '';
    var days = Math.ceil((new Date(expiresAt) - Date.now()) / 86400000);
    if (days <= 0) return '<span class="expire-tag expired">已过期</span>';
    if (days <= 3) return '<span class="expire-tag soon">' + days + '天后过期</span>';
    return '<span class="expire-tag">' + days + '天</span>';
  }
  function warnBadge(p) {
    var n = p.review && p.review.warnings || 0;
    return n ? '<span class="status-badge status-pending"><span class="status-dot"></span>' + n + ' 条提醒</span>' : '';
  }
  function tagsHtml(tags) {
    if (!tags || !tags.length) return '';
    return tags.map(function (t) { return '<span class="tag-chip">' + escapeHtml(t) + '</span>'; }).join('');
  }
  var TRASH_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

  function dirRowHtml(dir, i) {
    return '<tr class="dir-row" style="animation-delay:' + Math.min(i, 12) * 35 + 'ms">' +
      '<td class="col-check"></td>' +
      '<td class="col-name"><div class="name-cell"><div class="file-icon">' + folderIcon() + '</div>' +
      '<div class="name-text"><div class="name-row">' +
      '<a class="file-name dir-link" data-dir-id="' + escapeHtml(dir.id) + '">' + escapeHtml(dir.name) + '</a>' +
      '</div></div></div></td>' +
      '<td class="col-size">—</td>' +
      '<td class="col-time">' + formatTime(dir.createdAt) + '</td>' +
      '<td class="col-actions"><div class="actions-cell">' +
      '<button class="btn-icon danger" title="删除目录" data-action="deldir" data-id="' + escapeHtml(dir.id) + '">' + TRASH_SVG + '</button>' +
      '</div></td></tr>';
  }

  function projectRowHtml(p, i) {
    var url = shareUrl(p);
    var countHtml = isFolderProject(p) ? '<span>' + p.fileCount + ' 个文件</span>' : '';
    var entryHtml = p.entryFile ? '' : '<span>目录索引</span>';
    return '<tr style="animation-delay:' + Math.min(i, 12) * 35 + 'ms">' +
      '<td class="col-check"><input type="checkbox" class="row-check" data-id="' + escapeHtml(p.shortId) + '"></td>' +
      '<td class="col-name"><div class="name-cell"><div class="file-icon">' + fileIcon(p) + '</div>' +
      '<div class="name-text"><div class="name-row">' +
      '<a class="file-name" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(displayName(p)) + '</a>' +
      formatExpiry(p.expiresAt) +
      (p.version > 1 ? '<span class="version-badge">v' + p.version + '</span>' : '') +
      '</div><div class="file-meta">' + countHtml + entryHtml + warnBadge(p) + tagsHtml(p.tags) + '</div>' +
      '</div></div></td>' +
      '<td class="col-size">' + HBCore.formatSize(p.totalSize) + '</td>' +
      '<td class="col-time">' + formatTime(p.createdAt) + '</td>' +
      '<td class="col-actions"><div class="actions-cell">' +
      '<button class="btn-link" data-action="share" data-id="' + escapeHtml(p.shortId) + '">分享</button>' +
      '<button class="btn-icon" title="覆盖上传新版本" data-action="reupload" data-id="' + escapeHtml(p.shortId) + '">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg></button>' +
      '<button class="btn-icon danger" title="删除" data-action="delete" data-id="' + escapeHtml(p.shortId) + '">' + TRASH_SVG + '</button>' +
      '</div></td></tr>';
  }

  function renderList(projects, dirs) {
    projectCount.textContent = projects.length;
    var hasContent = projects.length > 0 || dirs.length > 0;
    emptyState.hidden = hasContent;
    document.querySelector('.table-wrap').style.display = hasContent ? '' : 'none';

    var html = '';
    dirs.forEach(function (d, i) { html += dirRowHtml(d, i); });
    projects.forEach(function (p, i) { html += projectRowHtml(p, i + dirs.length); });
    fileListBody.innerHTML = html;

    checkAll.checked = false;
    updateBatchUI();
  }

  /* ===================== 多选 ===================== */
  function getChecked() {
    return Array.prototype.map.call(document.querySelectorAll('.row-check:checked'), function (el) { return el.dataset.id; });
  }
  function updateBatchUI() {
    var n = getChecked().length;
    copyAllBtn.hidden = n === 0;
    batchDeleteBtn.hidden = n === 0;
    if (n > 0) {
      copyAllBtn.textContent = '复制所选链接 (' + n + ')';
      batchDeleteBtn.textContent = '删除所选 (' + n + ')';
    }
  }
  fileListBody.addEventListener('change', function (e) {
    if (e.target.classList.contains('row-check')) {
      updateBatchUI();
      var all = document.querySelectorAll('.row-check');
      checkAll.checked = all.length > 0 && Array.prototype.every.call(all, function (c) { return c.checked; });
    }
  });
  checkAll.addEventListener('change', function () {
    Array.prototype.forEach.call(document.querySelectorAll('.row-check'), function (c) { c.checked = checkAll.checked; });
    updateBatchUI();
  });

  /* ===================== 提交封装 ===================== */
  function setBusy(on, text) {
    busy = on;
    uploadProgress.hidden = !on;
    if (on) {
      progressFill.style.width = '0%';
      progressText.textContent = text || '处理中…';
    }
  }
  function progressCb(phase, done, total) {
    var pct = total ? Math.round(done / total * 100) : 0;
    progressFill.style.width = pct + '%';
    progressText.textContent = phase + ' ' + done + '/' + total;
  }
  async function commit(opts, label) {
    setBusy(true, label);
    try {
      var r = await HBStore.commitBatch(cfg, opts, progressCb);
      progressFill.style.width = '100%';
      progressText.textContent = '完成';
      setTimeout(function () { setBusy(false); }, 500);
      return r;
    } catch (err) {
      setBusy(false);
      throw err;
    }
  }

  function uniqueShortId() {
    var id, guard = 0;
    do {
      id = HBCore.generateShortId(8);
      guard++;
    } while (guard < 50 && meta.projects.some(function (p) { return p.shortId === id || (p.storages || []).indexOf(id) >= 0; }));
    return id;
  }

  /* ===================== 审查报告 ===================== */
  function showReview(logs, fatal) {
    reviewTitle.textContent = fatal ? '⛔ 已拦截，未上传' : '⚠️ 发现 ' + logs.length + ' 条风险提醒';
    reviewList.innerHTML = logs.map(function (l) {
      return '<div class="review-item">' +
        '<span class="review-sev ' + l.severity + '">' + (l.severity === 'blocked' ? '拦截' : '提醒') + '</span>' +
        '<span class="review-detail">' + escapeHtml(l.detail) +
        '<span class="review-rule">' + escapeHtml(l.rule_id) + '</span></span></div>';
    }).join('');
    reviewGo.hidden = !!fatal;
    reviewCancel.textContent = fatal ? '知道了' : '取消上传';
    reviewModal.hidden = false;
    return new Promise(function (resolve) { reviewResolve = resolve; });
  }
  reviewCancel.onclick = function () { reviewModal.hidden = true; if (reviewResolve) reviewResolve(false); };
  reviewGo.onclick = function () { reviewModal.hidden = true; if (reviewResolve) reviewResolve(true); };

  /* ===================== 上传 ===================== */
  var reuploadTarget = null;   // 非空表示这次是覆盖上传

  async function handleUpload(rawItems) {
    if (busy) { toast('还有任务在跑，等一下'); return; }
    if (!cfgReady()) { openSetup(); return; }
    if (!rawItems.length) return;

    var v = HBCore.validateFiles(rawItems);
    if (v.fatal) { toast(v.fatal); reuploadTarget = null; return; }
    if (!v.accepted.length) {
      toast('没有支持的文件类型（只收网页与文本类文件及其配套资源）');
      reuploadTarget = null;
      return;
    }
    if (v.rejected.length) toast('已跳过 ' + v.rejected.length + ' 个不支持的文件');

    // 安全审查：在本机做，不合规的文件根本不会离开这台电脑
    setBusy(true, '安全审查…');
    var rv;
    try {
      rv = await HBCore.reviewFiles(v.accepted, function (d, t) { progressCb('安全审查', d, t); });
    } catch (err) {
      setBusy(false); toast('审查失败：' + err.message); reuploadTarget = null; return;
    }
    setBusy(false);

    var blocked = rv.logs.filter(function (l) { return l.severity === 'blocked'; });
    if (blocked.length) {
      await showReview(rv.logs, true);
      reuploadTarget = null;
      return;
    }
    if (rv.logs.length) {
      var go = await showReview(rv.logs, false);
      if (!go) { reuploadTarget = null; return; }
    }

    try {
      if (reuploadTarget) await doReupload(v, rv);
      else await doCreate(v, rv);
    } catch (err) {
      toast(err.message);
    } finally {
      reuploadTarget = null;
    }
  }

  function fileEntries(accepted) {
    return accepted.map(function (a) { return { p: a.relPath, s: a.file.size }; });
  }

  async function doCreate(v, rv) {
    meta = await HBStore.loadMeta(cfg);
    normalizeMeta();

    var shortId = uniqueShortId();
    var first = v.accepted[0].relPath;
    var name = first.indexOf('/') >= 0 ? first.split('/')[0] : first.replace(/\.[^./]+$/, '');
    var days = parseInt(expireSelect.value, 10);
    var project = {
      id: shortId,
      shortId: shortId,
      dirId: currentDirId,
      name: name,
      entryFile: HBCore.detectEntryFile(v.accepted),
      storageId: shortId,
      storages: [shortId],
      version: 1,
      totalSize: v.totalSize,
      fileCount: v.accepted.length,
      files: fileEntries(v.accepted),
      tags: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
      review: { status: 'passed', warnings: rv.logs.length }
    };
    meta.projects.unshift(project);

    await commit({
      message: 'upload: ' + name + ' (' + shortId + ')',
      files: v.accepted,
      prefix: HBStore.FILES_ROOT + '/' + shortId,
      meta: meta
    }, '上传中…');

    renderView();
    toast('上传成功，Pages 部署约需 10~60 秒');
    openShare(project);
  }

  async function doReupload(v, rv) {
    var targetId = reuploadTarget;
    meta = await HBStore.loadMeta(cfg);
    normalizeMeta();
    var p = meta.projects.find(function (x) { return x.shortId === targetId; });
    if (!p) { toast('项目已不存在'); return; }

    var newStorage = uniqueShortId();
    p.storages.push(newStorage);
    p.storageId = newStorage;
    p.version = (p.version || 1) + 1;
    p.entryFile = HBCore.detectEntryFile(v.accepted);
    p.totalSize = v.totalSize;
    p.fileCount = v.accepted.length;
    p.files = fileEntries(v.accepted);
    p.updatedAt = nowIso();
    p.review = { status: 'passed', warnings: rv.logs.length };

    await commit({
      message: 'update: ' + p.name + ' → v' + p.version + ' (' + p.shortId + ')',
      files: v.accepted,
      prefix: HBStore.FILES_ROOT + '/' + newStorage,
      meta: meta
    }, '上传新版本…');

    renderView();
    toast('已更新到 v' + p.version + '，短链不变');
    openShare(p);
  }

  /* ===================== 行操作 ===================== */
  fileListBody.addEventListener('click', async function (e) {
    var dirLink = e.target.closest('.dir-link');
    if (dirLink) { currentDirId = dirLink.dataset.dirId; renderView(); return; }

    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.dataset.action;
    var id = btn.dataset.id;

    if (action === 'share') {
      var p = meta.projects.find(function (x) { return x.shortId === id; });
      if (p) openShare(p);
      return;
    }
    if (action === 'reupload') {
      if (busy) { toast('还有任务在跑，等一下'); return; }
      reuploadTarget = id;
      toast('选择新版本的文件（短链不变）');
      fileInput.click();
      return;
    }
    if (action === 'delete') {
      if (busy) { toast('还有任务在跑，等一下'); return; }
      if (!await showConfirm('确定要删除这个项目吗？仓库里的文件会一并移除。')) return;
      try { await deleteProjects([id]); } catch (err) { toast(err.message); }
      return;
    }
    if (action === 'deldir') {
      if (busy) { toast('还有任务在跑，等一下'); return; }
      var dir = meta.dirs.find(function (d) { return d.id === id; });
      if (!dir) return;
      if (!await showConfirm('确定要删除目录「' + dir.name + '」吗？其中的子目录和项目将一并删除。')) return;
      try { await deleteDir(id); } catch (err) { toast(err.message); }
    }
  });

  async function deleteProjects(ids) {
    meta = await HBStore.loadMeta(cfg);
    normalizeMeta();
    var targets = meta.projects.filter(function (p) { return ids.indexOf(p.shortId) >= 0; });
    if (!targets.length) { toast('项目已不存在'); renderView(); return; }

    var storages = [];
    targets.forEach(function (p) { storages = storages.concat(p.storages || [p.storageId]); });

    setBusy(true, '清点文件…');
    var paths;
    try { paths = await HBStore.listProjectFiles(cfg, storages); }
    catch (err) { setBusy(false); throw err; }
    setBusy(false);

    meta.projects = meta.projects.filter(function (p) { return ids.indexOf(p.shortId) < 0; });
    await commit({
      message: 'delete: ' + targets.map(function (p) { return p.name; }).join(', '),
      meta: meta,
      deletePaths: paths
    }, '删除中…');

    renderView();
    toast('已删除 ' + targets.length + ' 个项目');
  }

  async function deleteDir(rootId) {
    meta = await HBStore.loadMeta(cfg);
    normalizeMeta();

    // 收集该目录及其所有后代
    var kill = [rootId];
    for (var i = 0; i < kill.length; i++) {
      meta.dirs.forEach(function (d) {
        if (d.parentId === kill[i] && kill.indexOf(d.id) < 0) kill.push(d.id);
      });
    }
    var doomed = meta.projects.filter(function (p) { return kill.indexOf(p.dirId) >= 0; });
    var storages = [];
    doomed.forEach(function (p) { storages = storages.concat(p.storages || [p.storageId]); });

    var paths = [];
    if (storages.length) {
      setBusy(true, '清点文件…');
      try { paths = await HBStore.listProjectFiles(cfg, storages); }
      catch (err) { setBusy(false); throw err; }
      setBusy(false);
    }

    meta.dirs = meta.dirs.filter(function (d) { return kill.indexOf(d.id) < 0; });
    meta.projects = meta.projects.filter(function (p) { return kill.indexOf(p.dirId) < 0; });

    await commit({
      message: 'delete dir (' + kill.length + ' dirs, ' + doomed.length + ' projects)',
      meta: meta,
      deletePaths: paths
    }, '删除中…');

    if (kill.indexOf(currentDirId) >= 0) currentDirId = null;
    renderView();
    toast('已删除 ' + kill.length + ' 个目录、' + doomed.length + ' 个项目');
  }

  copyAllBtn.addEventListener('click', async function () {
    var ids = getChecked();
    if (!ids.length) return;
    var urls = ids.map(function (id) {
      var p = meta.projects.find(function (x) { return x.shortId === id; });
      return p ? shareUrl(p) : '';
    }).filter(Boolean).join('\n');
    await copyText(urls);
    toast('已复制 ' + ids.length + ' 个链接');
  });

  batchDeleteBtn.addEventListener('click', async function () {
    if (busy) { toast('还有任务在跑，等一下'); return; }
    var ids = getChecked();
    if (!ids.length) return;
    if (!await showConfirm('确定要删除选中的 ' + ids.length + ' 个项目吗？')) return;
    try { await deleteProjects(ids); } catch (err) { toast(err.message); }
  });

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e2) { /* 复制不了就算了 */ }
      document.body.removeChild(ta);
    }
  }

  /* ===================== 搜索 + 标签 ===================== */
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderView, 250);
  });
  tagFilters.addEventListener('click', function (e) {
    var btn = e.target.closest('.tag-filter-btn');
    if (!btn) return;
    activeTag = activeTag === btn.dataset.tag ? '' : btn.dataset.tag;
    renderView();
  });

  /* ===================== 新建目录 ===================== */
  newDirBtn.onclick = function () {
    if (!cfgReady()) { openSetup(); return; }
    dirNameInput.value = '';
    dirModal.hidden = false;
    setTimeout(function () { dirNameInput.focus(); }, 50);
  };
  function closeDirModal() { dirModal.hidden = true; }
  dirCancel.onclick = closeDirModal;
  dirModal.onclick = function (e) { if (e.target === dirModal) closeDirModal(); };

  async function submitNewDir() {
    var name = dirNameInput.value.trim().slice(0, 64);
    if (!name) { toast('请输入目录名称'); return; }
    if (busy) { toast('还有任务在跑，等一下'); return; }
    closeDirModal();
    try {
      meta = await HBStore.loadMeta(cfg);
      normalizeMeta();
      var dup = meta.dirs.some(function (d) { return (d.parentId || null) === (currentDirId || null) && d.name === name; });
      if (dup) { toast('同级目录下已有同名目录'); return; }
      meta.dirs.push({ id: 'd' + HBCore.generateShortId(7), name: name, parentId: currentDirId, createdAt: nowIso() });
      await commit({ message: 'mkdir: ' + name, meta: meta }, '创建目录…');
      renderView();
      toast('目录已创建');
    } catch (err) { toast(err.message); }
  }
  dirCreate.onclick = submitNewDir;
  dirNameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitNewDir(); });

  /* ===================== 分享面板 ===================== */
  function expiryText(expiresAt) {
    if (!expiresAt) return '永久有效';
    var days = Math.ceil((new Date(expiresAt) - Date.now()) / 86400000);
    return days <= 0 ? '已过期' : days + ' 天后过期';
  }
  function expiryPreset(expiresAt) {
    if (!expiresAt) return '';
    var days = Math.ceil((new Date(expiresAt) - Date.now()) / 86400000);
    return [1, 7, 30, 90].indexOf(days) >= 0 ? String(days) : '__none__';
  }
  function markSeg(container, key, value) {
    Array.prototype.forEach.call(container.children, function (btn) {
      btn.classList.toggle('active', String(btn.dataset[key]) === String(value));
    });
  }
  function openShare(p) {
    shareProject = p;
    shareTitle.textContent = '分享 · ' + displayName(p);
    urlInput.value = shareUrl(p);
    var direct = directUrl(p);
    directRow.hidden = !direct;
    directInput.value = direct;
    markSeg(expireSegmented, 'exp', expiryPreset(p.expiresAt));
    tagInput.value = (p.tags || []).join(', ');
    shareStatus.textContent = 'v' + (p.version || 1) + ' · ' + p.fileCount + ' 个文件 · ' + expiryText(p.expiresAt);
    // 短链才是主角：上传后自动弹出并选中，可直接复制。二维码仅作手机扫码的可选项。
    try {
      qrWrap.innerHTML = window.MiniQR ? MiniQR.toSVG(urlInput.value, { scale: 4, quiet: 3 }) : '';
      qrWrap.hidden = !qrWrap.innerHTML;
      qrCap.hidden = qrWrap.hidden;
    } catch (e) {
      qrWrap.innerHTML = ''; qrWrap.hidden = true; qrCap.hidden = true;   // 链接过长生成不了，不影响复制
    }
    urlModal.hidden = false;
    setTimeout(function () { urlInput.focus(); urlInput.select(); }, 50);
  }
  function closeShare() { urlModal.hidden = true; shareProject = null; }
  urlModalClose.onclick = closeShare;
  urlModal.onclick = function (e) { if (e.target === urlModal) closeShare(); };
  urlCopyBtn.onclick = async function () { await copyText(urlInput.value); toast('短链已复制'); };
  directCopyBtn.onclick = async function () { await copyText(directInput.value); toast('直链已复制'); };

  expireSegmented.addEventListener('click', async function (e) {
    var btn = e.target.closest('.seg-btn');
    if (!btn || !shareProject || busy) return;
    var exp = btn.dataset.exp;
    var targetId = shareProject.shortId;
    try {
      meta = await HBStore.loadMeta(cfg);
      normalizeMeta();
      var p = meta.projects.find(function (x) { return x.shortId === targetId; });
      if (!p) { toast('项目已不存在'); return; }
      p.expiresAt = exp === '' ? null : new Date(Date.now() + parseInt(exp, 10) * 86400000).toISOString();
      p.updatedAt = nowIso();
      await commit({ message: 'set expiry: ' + p.name, meta: meta }, '保存中…');
      shareProject = p;
      markSeg(expireSegmented, 'exp', exp);
      shareStatus.textContent = 'v' + (p.version || 1) + ' · ' + p.fileCount + ' 个文件 · ' + expiryText(p.expiresAt);
      renderView();
      toast(exp === '' ? '已设为永久有效' : '已设为 ' + exp + ' 天后过期');
    } catch (err) { toast(err.message); }
  });

  tagSaveBtn.onclick = async function () {
    if (!shareProject || busy) return;
    var targetId = shareProject.shortId;
    var tags = tagInput.value.split(/[,，]/).map(function (t) { return t.trim().slice(0, 64); }).filter(Boolean);
    try {
      meta = await HBStore.loadMeta(cfg);
      normalizeMeta();
      var p = meta.projects.find(function (x) { return x.shortId === targetId; });
      if (!p) { toast('项目已不存在'); return; }
      p.tags = tags;
      p.updatedAt = nowIso();
      await commit({ message: 'set tags: ' + p.name, meta: meta }, '保存中…');
      shareProject = p;
      renderView();
      toast('标签已保存');
    } catch (err) { toast(err.message); }
  };

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!reviewModal.hidden) reviewCancel.onclick();
    else if (!urlModal.hidden) closeShare();
    else if (!dirModal.hidden) closeDirModal();
    else if (!setupModal.hidden && cfgReady()) closeSetup();
  });

  /* ===================== 拖拽 / 选择 ===================== */
  dropZone.addEventListener('dragover', function (e) { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', function (e) { e.preventDefault(); dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', async function (e) {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (!e.dataTransfer.items || !e.dataTransfer.items.length) return;
    handleUpload(await HBUpload.readEntries(e.dataTransfer.items));
  });
  dropZone.addEventListener('click', function () { if (cfgReady()) fileInput.click(); else openSetup(); });
  selectBtn.addEventListener('click', function () { if (cfgReady()) fileInput.click(); else openSetup(); });
  selectDirBtn.addEventListener('click', function () { if (cfgReady()) dirInput.click(); else openSetup(); });
  fileInput.addEventListener('change', function () {
    var items = HBUpload.fromInput(fileInput.files);
    fileInput.value = '';
    handleUpload(items);
  });
  dirInput.addEventListener('change', function () {
    var items = HBUpload.fromInput(dirInput.files);
    dirInput.value = '';
    handleUpload(items);
  });

  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });

  /* ===================== 启动 ===================== */
  loadCfg();
  renderRepoChip();
  renderList([], []);
  if (!cfgReady()) openSetup();
  else refresh();
})();
