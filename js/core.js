/*!
 * core.js —— 从 HTML-Base 服务端移植的纯逻辑层
 * 对应原仓库：
 *   server/utils/shortId.js    → generateShortId
 *   server/utils/filename.js   → sanitizeRelPath
 *   server/utils/entryFile.js  → detectEntryFile
 *   server/config.js           → ALLOWED / BLOCKED 扩展名白名单
 *   server/services/reviewService.js → RULES（8 条静态审查规则）
 * 全部改为浏览器端执行：审查在上传前完成，不合规的文件根本不会离开本机。
 */
(function (global) {
  'use strict';

  /* ============ 短 ID（对应 shortId.js，原用 nanoid） ============ */
  var ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

  function generateShortId(len) {
    len = len || 8;
    var out = '';
    var buf = new Uint32Array(len);
    crypto.getRandomValues(buf);
    for (var i = 0; i < len; i++) out += ALPHABET[buf[i] % ALPHABET.length];
    return out;
  }

  /* ============ 扩展名白名单（对应 config.js） ============ */
  var ALLOWED_EXTENSIONS = new Set([
    '.html', '.htm', '.md', '.txt', '.csv', '.json', '.xml', '.svg',
    '.css', '.js', '.mjs', '.map', '.wasm',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif',
    '.woff', '.woff2', '.ttf', '.eot', '.otf'
  ]);

  var BLOCKED_EXTENSIONS = new Set([
    '.exe', '.sh', '.bat', '.cmd', '.com', '.msi', '.scr',
    '.php', '.phtml', '.jsp', '.jspx', '.asp', '.aspx',
    '.py', '.rb', '.pl', '.cgi', '.dll', '.so'
  ]);

  var TEXT_EXTENSIONS = new Set([
    '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt', '.md', '.csv'
  ]);

  var LIMITS = {
    maxFileSize: 50 * 1024 * 1024,     // 单文件 50MB（原 config.storage.maxFileSize）
    maxProjectSize: 200 * 1024 * 1024, // 单项目 200MB
    maxFileCount: 500
  };

  function getExtension(p) {
    var m = String(p).toLowerCase().match(/(\.[a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  /* ============ 相对路径清洗（对应 filename.js sanitizeRelPath） ============
     浏览器端不存在 latin1 误码问题，故省去 fixOriginalName；
     路径穿越防护（..）必须保留。 */
  function sanitizeRelPath(name) {
    if (!name) return null;
    var segments = String(name).replace(/\\/g, '/').split('/');
    var safe = [];
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') return null;      // 路径穿越，丢弃该文件
      safe.push(seg);
    }
    return safe.length ? safe.join('/') : null;
  }

  /* ============ 入口文件识别（对应 entryFile.js，逻辑原样保留） ============
     index.html → index/readme.md → 全项目唯一文档 → 否则交给目录索引 */
  function detectEntryFile(files) {
    var htmlFiles = files.filter(function (f) { return /\.(html?|htm)$/i.test(f.relPath); });
    var mdFiles   = files.filter(function (f) { return /\.md$/i.test(f.relPath); });

    var indexHtml = htmlFiles.find(function (f) { return /(^|\/)index\.html?$/i.test(f.relPath); });
    if (indexHtml) return indexHtml.relPath;

    var indexMd = mdFiles.find(function (f) { return /(^|\/)(index|readme)\.md$/i.test(f.relPath); });
    if (indexMd) return indexMd.relPath;

    if (htmlFiles.length + mdFiles.length === 1) {
      return (htmlFiles[0] || mdFiles[0]).relPath;
    }
    return null;   // 0 个或多个 → 目录索引
  }

  /* ============ 安全审查规则（对应 reviewService.js RULES） ============ */
  var RULES = [
    {
      id: 'EXT_BLOCKED',
      description: '禁止的文件扩展名',
      severity: 'blocked',
      test: function (content, relPath) {
        var ext = getExtension(relPath);
        if (BLOCKED_EXTENSIONS.has(ext)) {
          return { hit: true, detail: '文件 ' + relPath + ' 使用了禁止的扩展名 ' + ext };
        }
        return { hit: false };
      }
    },
    {
      id: 'EXTERNAL_SCRIPT',
      description: '引用外部域名的 script 标签',
      severity: 'warning',
      test: function (content, relPath) {
        var ext = getExtension(relPath);
        if (ext !== '.html' && ext !== '.htm') return { hit: false };
        var m = content.match(/<script[^>]+src\s*=\s*["']https?:\/\/[^"']+["']/gi);
        if (m && m.length) {
          return { hit: true, detail: relPath + ' 引用了外部脚本: ' + m[0].slice(0, 120) };
        }
        return { hit: false };
      }
    },
    {
      id: 'EVAL_USAGE',
      description: '使用 eval / new Function 动态执行',
      severity: 'warning',
      test: function (content, relPath) {
        var ext = getExtension(relPath);
        if (['.html', '.htm', '.js', '.mjs'].indexOf(ext) === -1) return { hit: false };
        var m = content.match(/\beval\s*\(|new\s+Function\s*\(/g);
        if (m && m.length) {
          return { hit: true, detail: relPath + ' 包含 ' + m.length + ' 处 eval/Function 调用' };
        }
        return { hit: false };
      }
    },
    {
      id: 'COOKIE_STEAL',
      description: '疑似窃取 Cookie 并外发',
      severity: 'blocked',
      test: function (content, relPath) {
        var ext = getExtension(relPath);
        if (['.html', '.htm', '.js', '.mjs'].indexOf(ext) === -1) return { hit: false };
        var hasCookie = /document\.cookie/.test(content);
        var hasExfil  = /fetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new\s+Image\s*\(\s*\)\s*\.src/.test(content);
        if (hasCookie && hasExfil) {
          return { hit: true, detail: relPath + ' 读取 document.cookie 并存在外发请求' };
        }
        return { hit: false };
      }
    },
    {
      id: 'PHISHING_FORM',
      description: '疑似钓鱼表单（外部 action + 密码字段）',
      severity: 'blocked',
      test: function (content, relPath) {
        var ext = getExtension(relPath);
        if (ext !== '.html' && ext !== '.htm') return { hit: false };
        var hasExternalForm = /<form[^>]+action\s*=\s*["']https?:\/\/[^"']+["']/i.test(content);
        var hasPassword     = /type\s*=\s*["']password["']/i.test(content);
        if (hasExternalForm && hasPassword) {
          return { hit: true, detail: relPath + ' 包含指向外部的密码提交表单' };
        }
        return { hit: false };
      }
    },
    {
      id: 'HIDDEN_IFRAME',
      description: '隐藏 iframe（可能用于钓鱼/挖矿）',
      severity: 'blocked',
      test: function (content, relPath) {
        var ext = getExtension(relPath);
        if (ext !== '.html' && ext !== '.htm') return { hit: false };
        var re = /<iframe[^>]*(?:display\s*:\s*none|width\s*[:=]\s*["']?0|height\s*[:=]\s*["']?0|visibility\s*:\s*hidden|opacity\s*:\s*0)[^>]*>/gi;
        var m = content.match(re);
        if (m && m.length) {
          return { hit: true, detail: relPath + ' 包含 ' + m.length + ' 个隐藏 iframe' };
        }
        return { hit: false };
      }
    },
    {
      id: 'KEYLOGGER',
      description: '疑似键盘记录器',
      severity: 'blocked',
      test: function (content, relPath) {
        var ext = getExtension(relPath);
        if (['.html', '.htm', '.js', '.mjs'].indexOf(ext) === -1) return { hit: false };
        var hasKey   = /addEventListener\s*\(\s*["']key(?:down|up|press)["']/.test(content);
        var hasExfil = /fetch\s*\(|XMLHttpRequest|navigator\.sendBeacon/.test(content);
        if (hasKey && hasExfil) {
          return { hit: true, detail: relPath + ' 监听键盘事件并存在外发请求' };
        }
        return { hit: false };
      }
    },
    {
      id: 'CRYPTO_MINER',
      description: '疑似加密货币挖矿脚本',
      severity: 'blocked',
      test: function (content, relPath) {
        if (/coinhive|cryptonight|coinimp|webminepool|stratum\+tcp|minerd|cpuminer/i.test(content)) {
          return { hit: true, detail: relPath + ' 包含挖矿相关特征字符串' };
        }
        return { hit: false };
      }
    }
  ];

  /**
   * 审查一批文件（对应 reviewService.reviewProject，改为上传前执行）
   * @param {Array<{relPath:string, file:File}>} items
   * @param {(done:number,total:number)=>void} [onProgress]
   * @returns {Promise<{passed:boolean, logs:Array}>}
   */
  async function reviewFiles(items, onProgress) {
    var logs = [];
    var blocked = false;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var ext = getExtension(it.relPath);

      // 扩展名规则：不需要读内容，命中即阻断该文件
      var extResult = RULES[0].test('', it.relPath);
      if (extResult.hit) {
        logs.push({ rule_id: 'EXT_BLOCKED', severity: 'blocked', detail: extResult.detail });
        blocked = true;
        if (onProgress) onProgress(i + 1, items.length);
        continue;
      }

      // 非文本文件跳过内容检测
      if (!TEXT_EXTENSIONS.has(ext)) {
        if (onProgress) onProgress(i + 1, items.length);
        continue;
      }

      var content;
      try {
        content = await it.file.text();
      } catch (e) {
        if (onProgress) onProgress(i + 1, items.length);
        continue;
      }
      if (content.length > 512000) content = content.slice(0, 512000);  // 只检测前 500KB

      for (var r = 1; r < RULES.length; r++) {
        var rule = RULES[r];
        var res = rule.test(content, it.relPath);
        if (res.hit) {
          logs.push({ rule_id: rule.id, severity: rule.severity, detail: res.detail });
          if (rule.severity === 'blocked') blocked = true;
        }
      }
      if (onProgress) onProgress(i + 1, items.length);
    }

    return { passed: !blocked, logs: logs };
  }

  /** 上传前的体积/数量/白名单校验，返回 {accepted, rejected} */
  function validateFiles(items) {
    var accepted = [], rejected = [], total = 0;

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var rel = sanitizeRelPath(it.relPath);
      if (!rel) {
        rejected.push({ relPath: it.relPath, reason: '非法路径（含 .. 或为空）' });
        continue;
      }
      var ext = getExtension(rel);
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        rejected.push({ relPath: rel, reason: '不支持的类型 ' + (ext || '（无扩展名）') });
        continue;
      }
      if (it.file.size > LIMITS.maxFileSize) {
        rejected.push({ relPath: rel, reason: '超过单文件上限 ' + (LIMITS.maxFileSize / 1048576) + 'MB' });
        continue;
      }
      total += it.file.size;
      accepted.push({ relPath: rel, file: it.file });
    }

    var fatal = null;
    if (accepted.length > LIMITS.maxFileCount) {
      fatal = '文件数 ' + accepted.length + ' 超过上限 ' + LIMITS.maxFileCount;
    } else if (total > LIMITS.maxProjectSize) {
      fatal = '项目总大小 ' + (total / 1048576).toFixed(1) + 'MB 超过上限 ' + (LIMITS.maxProjectSize / 1048576) + 'MB';
    }

    return { accepted: accepted, rejected: rejected, totalSize: total, fatal: fatal };
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  global.HBCore = {
    generateShortId: generateShortId,
    sanitizeRelPath: sanitizeRelPath,
    detectEntryFile: detectEntryFile,
    getExtension: getExtension,
    reviewFiles: reviewFiles,
    validateFiles: validateFiles,
    formatSize: formatSize,
    RULES: RULES,
    LIMITS: LIMITS,
    ALLOWED_EXTENSIONS: ALLOWED_EXTENSIONS,
    BLOCKED_EXTENSIONS: BLOCKED_EXTENSIONS
  };
})(typeof window !== 'undefined' ? window : globalThis);
