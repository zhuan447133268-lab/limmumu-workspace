/*!
 * store.js —— GitHub 存储层，替代原仓库的 Express + MySQL + 本地磁盘
 *
 * 原架构                          改造后
 * ─────────────────────────────  ────────────────────────────────────────
 * MySQL projects/files/dirs 表    data/projects.json（仓库内的元数据文件）
 * ./storage/<shortId>/ 磁盘目录    仓库内 f/<shortId>/ 目录
 * multer 上传                     Git Data API（blob → tree → commit → ref）
 * express-session + CAS          Personal Access Token（存 localStorage）
 *
 * 核心：整批文件走 Git Data API 只产生 1 个 commit。
 * 若逐个走 contents API，一个 50 文件的课件会刷出 50 条提交记录，历史不可读。
 */
(function (global) {
  'use strict';

  var API = 'https://api.github.com';
  var META_PATH = 'data/projects.json';
  var FILES_ROOT = 'f';

  function headers(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /** 统一请求：把 GitHub 的错误翻译成人话 */
  async function req(cfg, method, url, body) {
    var opt = { method: method, headers: headers(cfg.token) };
    if (body !== undefined) {
      opt.headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers);
      opt.body = JSON.stringify(body);
    }
    var res = await fetch(url, opt);
    if (!res.ok) {
      var msg = '';
      try { var j = await res.json(); msg = j.message || ''; } catch (e) {}
      throw new Error(translate(res.status, msg, res));
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function translate(status, msg, res) {
    if (status === 401) return '令牌无效或已过期（401）。请重新生成 Personal Access Token。';
    if (status === 403) {
      if (res && res.headers.get('x-ratelimit-remaining') === '0') {
        return 'GitHub API 频率限制已用尽（403）。等待一小时后重试。';
      }
      return '权限不足（403）。确认令牌的 Repository permissions → Contents 设为 Read and write，且勾选了目标仓库。';
    }
    if (status === 404) return '仓库、分支或路径不存在（404）。核对用户名/仓库名拼写，以及分支是 main 还是 master。';
    if (status === 409) return '仓库为空（409）。请先在 GitHub 上创建任意一个文件（如 README），让仓库有第一次提交。';
    if (status === 422) return '提交被拒绝（422）：' + msg;
    return 'GitHub API 错误 ' + status + (msg ? '：' + msg : '');
  }

  /* ---------- base64 ---------- */
  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(new Error('读取文件失败：' + file.name)); };
      r.readAsDataURL(file);
    });
  }
  function textToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  function base64ToText(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------- 并发限流：GitHub 对突发请求敏感，固定 4 路 ---------- */
  async function pool(items, limit, worker, onEach) {
    var out = new Array(items.length);
    var idx = 0, done = 0;
    async function run() {
      while (idx < items.length) {
        var i = idx++;
        out[i] = await worker(items[i], i);
        done++;
        if (onEach) onEach(done, items.length);
      }
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(run());
    await Promise.all(runners);
    return out;
  }

  /* ---------- 元数据（相当于原来的 MySQL） ---------- */
  var EMPTY_META = { version: 1, dirs: [], projects: [] };

  async function loadMeta(cfg) {
    var url = API + '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' +
              META_PATH + '?ref=' + encodeURIComponent(cfg.branch);
    var res = await fetch(url, { headers: headers(cfg.token) });
    if (res.status === 404) return JSON.parse(JSON.stringify(EMPTY_META));
    if (!res.ok) {
      var msg = ''; try { msg = (await res.json()).message || ''; } catch (e) {}
      throw new Error(translate(res.status, msg, res));
    }
    var j = await res.json();
    try {
      var meta = JSON.parse(base64ToText(j.content));
      if (!meta.projects) meta.projects = [];
      if (!meta.dirs) meta.dirs = [];
      return meta;
    } catch (e) {
      throw new Error('data/projects.json 解析失败，文件可能被手工改坏了。');
    }
  }

  /* ---------- 一次提交：写入若干文件 + 更新元数据 + 删除若干路径 ---------- */
  /**
   * @param {object} cfg   {owner, repo, branch, token}
   * @param {object} opts  {message, files:[{relPath,file}], prefix, meta, deletePaths:[]}
   * @param {function} onProgress (phase, done, total)
   */
  async function commitBatch(cfg, opts, onProgress) {
    var base = API + '/repos/' + cfg.owner + '/' + cfg.repo;
    var report = function (p, d, t) { if (onProgress) onProgress(p, d, t); };

    // 1. 当前分支 HEAD
    report('定位分支', 0, 1);
    var ref = await req(cfg, 'GET', base + '/git/ref/heads/' + encodeURIComponent(cfg.branch));
    var headSha = ref.object.sha;
    var headCommit = await req(cfg, 'GET', base + '/git/commits/' + headSha);
    var baseTree = headCommit.tree.sha;
    report('定位分支', 1, 1);

    // 2. 上传 blob（并发 4 路）
    var files = opts.files || [];
    var blobs = [];
    if (files.length) {
      report('上传文件', 0, files.length);
      blobs = await pool(files, 4, async function (item) {
        var b64 = await fileToBase64(item.file);
        var r = await req(cfg, 'POST', base + '/git/blobs', { content: b64, encoding: 'base64' });
        return { path: (opts.prefix ? opts.prefix + '/' : '') + item.relPath, sha: r.sha };
      }, function (d, t) { report('上传文件', d, t); });
    }

    // 3. 组装 tree
    var tree = blobs.map(function (b) {
      return { path: b.path, mode: '100644', type: 'blob', sha: b.sha };
    });

    if (opts.meta) {
      var metaJson = JSON.stringify(opts.meta, null, 2);
      var metaBlob = await req(cfg, 'POST', base + '/git/blobs', {
        content: textToBase64(metaJson), encoding: 'base64'
      });
      tree.push({ path: META_PATH, mode: '100644', type: 'blob', sha: metaBlob.sha });
    }

    // 删除：sha 为 null 即从 base_tree 中移除
    (opts.deletePaths || []).forEach(function (p) {
      tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
    });

    if (!tree.length) return { changed: false };

    // 4. 建 tree → 建 commit → 移动 ref（整批只有 1 个 commit）
    report('生成提交', 0, 3);
    var newTree = await req(cfg, 'POST', base + '/git/trees', { base_tree: baseTree, tree: tree });
    report('生成提交', 1, 3);
    var commit = await req(cfg, 'POST', base + '/git/commits', {
      message: opts.message || 'update', tree: newTree.sha, parents: [headSha]
    });
    report('生成提交', 2, 3);
    await req(cfg, 'PATCH', base + '/git/refs/heads/' + encodeURIComponent(cfg.branch), { sha: commit.sha });
    report('生成提交', 3, 3);

    return { changed: true, commit: commit.sha };
  }

  /**
   * 列出若干存储目录下的全部文件路径（删除项目时用）。
   * 一个项目可能有多个版本目录（每次覆盖上传换一个 storageId），所以收一组前缀。
   * @param {string|string[]} storageIds
   */
  async function listProjectFiles(cfg, storageIds) {
    var ids = Array.isArray(storageIds) ? storageIds : [storageIds];
    var prefixes = ids.filter(Boolean).map(function (id) { return FILES_ROOT + '/' + id + '/'; });
    if (!prefixes.length) return [];

    var base = API + '/repos/' + cfg.owner + '/' + cfg.repo;
    var ref = await req(cfg, 'GET', base + '/git/ref/heads/' + encodeURIComponent(cfg.branch));
    var commit = await req(cfg, 'GET', base + '/git/commits/' + ref.object.sha);
    var tree = await req(cfg, 'GET', base + '/git/trees/' + commit.tree.sha + '?recursive=1');
    return (tree.tree || [])
      .filter(function (n) {
        if (n.type !== 'blob') return false;
        for (var i = 0; i < prefixes.length; i++) {
          if (n.path.indexOf(prefixes[i]) === 0) return true;
        }
        return false;
      })
      .map(function (n) { return n.path; });
  }

  /** 校验配置是否可用：返回仓库信息与 Pages 地址 */
  async function verify(cfg) {
    var repo = await req(cfg, 'GET', API + '/repos/' + cfg.owner + '/' + cfg.repo);
    var pages = null;
    try { pages = await req(cfg, 'GET', API + '/repos/' + cfg.owner + '/' + cfg.repo + '/pages'); }
    catch (e) { /* 未开启 Pages，不算错误 */ }
    return {
      private: repo.private,
      defaultBranch: repo.default_branch,
      pagesUrl: pages && pages.html_url ? pages.html_url : null,
      pagesStatus: pages ? pages.status : null
    };
  }

  global.HBStore = {
    loadMeta: loadMeta,
    commitBatch: commitBatch,
    listProjectFiles: listProjectFiles,
    verify: verify,
    textToBase64: textToBase64,
    base64ToText: base64ToText,
    META_PATH: META_PATH,
    FILES_ROOT: FILES_ROOT
  };
})(typeof window !== 'undefined' ? window : globalThis);
