/*!
 * 精简二维码生成器 —— QR Code Model 2 / Byte mode / ECC-L / 版本 1~10
 * 零依赖，纯 JS。最大可编码 271 字节，足够放 URL。
 * 输出：布尔矩阵 matrix[y][x]，true = 深色模块。
 */
(function (global) {
  'use strict';

  /* ---------------- GF(256) 有限域 ---------------- */
  var EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var ng = new Array(g.length + 1);
      for (var k = 0; k < ng.length; k++) ng[k] = 0;
      for (var j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= gmul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  function rsEncode(data, ecLen) {
    var g = rsGenPoly(ecLen);
    var res = new Array(ecLen);
    for (var i = 0; i < ecLen; i++) res[i] = 0;
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ res[0];
      res.shift(); res.push(0);
      if (factor !== 0) for (var j = 0; j < ecLen; j++) res[j] ^= gmul(g[j + 1], factor);
    }
    return res;
  }

  /* ---------------- 版本参数表（ECC-L，版本 1~10） ----------------
     [每块纠错码字数, [[块数, 每块数据码字数], ...]] */
  var RS_L = {
    1:  [7,  [[1, 19]]],
    2:  [10, [[1, 34]]],
    3:  [15, [[1, 55]]],
    4:  [20, [[1, 80]]],
    5:  [26, [[1, 108]]],
    6:  [18, [[2, 68]]],
    7:  [20, [[2, 78]]],
    8:  [24, [[2, 97]]],
    9:  [30, [[2, 116]]],
    10: [18, [[2, 68], [2, 69]]]
  };

  /* 对齐图案中心坐标 */
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function dataCapacity(ver) {
    var spec = RS_L[ver], total = 0;
    for (var i = 0; i < spec[1].length; i++) total += spec[1][i][0] * spec[1][i][1];
    return total;
  }

  /* Byte mode 字符计数指示符位数：版本 1~9 = 8bit，10~26 = 16bit */
  function countBits(ver) { return ver < 10 ? 8 : 16; }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 10; v++) {
      var avail = dataCapacity(v) * 8 - 4 - countBits(v);
      if (byteLen * 8 <= avail) return v;
    }
    return -1;
  }

  /* ---------------- 位流构造 ---------------- */
  function buildCodewords(bytes, ver) {
    var bits = [];
    function push(val, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    push(0x4, 4);                      // Byte mode
    push(bytes.length, countBits(ver));
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);

    var capBits = dataCapacity(ver) * 8;
    // 终止符
    var term = Math.min(4, capBits - bits.length);
    for (var t = 0; t < term; t++) bits.push(0);
    // 补齐到字节边界
    while (bits.length % 8 !== 0) bits.push(0);
    // 填充码字 0xEC / 0x11 交替
    var pad = [0xEC, 0x11], pi = 0;
    while (bits.length < capBits) { push(pad[pi], 8); pi ^= 1; }

    var cw = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      cw.push(v);
    }
    return cw;
  }

  /* 分块 + 纠错 + 交错 */
  function interleave(cw, ver) {
    var spec = RS_L[ver], ecLen = spec[0], groups = spec[1];
    var dataBlocks = [], ecBlocks = [], off = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      for (var n = 0; n < groups[gi][0]; n++) {
        var sz = groups[gi][1];
        var blk = cw.slice(off, off + sz); off += sz;
        dataBlocks.push(blk);
        ecBlocks.push(rsEncode(blk, ecLen));
      }
    }
    var out = [], maxData = 0, i, j;
    for (i = 0; i < dataBlocks.length; i++) maxData = Math.max(maxData, dataBlocks[i].length);
    for (i = 0; i < maxData; i++)
      for (j = 0; j < dataBlocks.length; j++)
        if (i < dataBlocks[j].length) out.push(dataBlocks[j][i]);
    for (i = 0; i < ecLen; i++)
      for (j = 0; j < ecBlocks.length; j++) out.push(ecBlocks[j][i]);
    return out;
  }

  /* ---------------- 矩阵构建 ---------------- */
  function makeMatrix(ver) {
    var size = ver * 4 + 17;
    var m = [], fn = [], y, x;
    for (y = 0; y < size; y++) {
      m.push(new Array(size).fill(0));
      fn.push(new Array(size).fill(false));
    }
    function setFn(px, py, v) {
      if (px < 0 || py < 0 || px >= size || py >= size) return;
      m[py][px] = v; fn[py][px] = true;
    }
    // 定位图案 + 分隔符
    function finder(cx, cy) {
      for (var dy = -1; dy <= 7; dy++) for (var dx = -1; dx <= 7; dx++) {
        var px = cx + dx, py = cy + dy;
        var d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFn(px, py, (d !== 2 && d <= 3) ? 1 : 0);
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    // 定时图案
    for (var i = 8; i < size - 8; i++) {
      var v = (i % 2 === 0) ? 1 : 0;
      setFn(i, 6, v); setFn(6, i, v);
    }

    // 对齐图案
    var pos = ALIGN[ver];
    for (var a = 0; a < pos.length; a++) for (var b = 0; b < pos.length; b++) {
      var ax = pos[a], ay = pos[b];
      // 跳过与定位图案重叠的三处
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) {
        var dd = Math.max(Math.abs(dx2), Math.abs(dy2));
        setFn(ax + dx2, ay + dy2, dd !== 1 ? 1 : 0);
      }
    }

    // 固定深色模块
    setFn(8, size - 8, 1);

    // 预留格式信息区（必须跳过索引 6，那里是定时图案，不属于格式信息）
    for (var f = 0; f <= 8; f++) {
      if (f === 6) continue;
      setFn(8, f, 0);  // 第 8 列，第 f 行
      setFn(f, 8, 0);  // 第 8 行，第 f 列
    }
    for (var f2 = 0; f2 < 8; f2++) {
      setFn(size - 1 - f2, 8, 0);  // 右上：第 8 行
      setFn(8, size - 1 - f2, 0);  // 左下：第 8 列
    }

    // 版本信息（版本 >= 7）
    if (ver >= 7) {
      var rem = ver;
      for (var r = 0; r < 12; r++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1F25);
      var vb = (ver << 12) | rem;
      for (var k = 0; k < 18; k++) {
        var bit = (vb >>> k) & 1;
        var rr = Math.floor(k / 3), cc = k % 3;
        setFn(rr, size - 11 + cc, bit);
        setFn(size - 11 + cc, rr, bit);
      }
    }
    return { m: m, fn: fn, size: size };
  }

  /* 数据填充：之字形，从右下角向上 */
  function placeData(grid, cw) {
    var m = grid.m, fn = grid.fn, size = grid.size;
    var bitIdx = 0, total = cw.length * 8;
    function nextBit() {
      if (bitIdx >= total) return 0;
      var b = (cw[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1;
      bitIdx++; return b;
    }
    var upward = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // 跳过定时列
      for (var vert = 0; vert < size; vert++) {
        var y = upward ? (size - 1 - vert) : vert;
        for (var c = 0; c < 2; c++) {
          var x = right - c;
          if (fn[y][x]) continue;
          m[y][x] = nextBit();
        }
      }
      upward = !upward;
    }
  }

  var MASKS = [
    function (y, x) { return (y + x) % 2 === 0; },
    function (y) { return y % 2 === 0; },
    function (y, x) { return x % 3 === 0; },
    function (y, x) { return (y + x) % 3 === 0; },
    function (y, x) { return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; },
    function (y, x) { return ((y * x) % 2) + ((y * x) % 3) === 0; },
    function (y, x) { return (((y * x) % 2) + ((y * x) % 3)) % 2 === 0; },
    function (y, x) { return (((y + x) % 2) + ((y * x) % 3)) % 2 === 0; }
  ];

  function applyFormat(grid, mask) {
    var size = grid.size, m = grid.m;
    var data = (1 << 3) | mask;              // ECC-L = 0b01
    var rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
    var bitsVal = (((data << 10) | rem) ^ 0x5412) & 0x7FFF;

    for (var k = 0; k < 15; k++) {
      var bit = (bitsVal >>> k) & 1;
      // 第一副本：左上角
      if (k < 6) m[k][8] = bit;              // 第 8 列，第 0~5 行
      else if (k === 6) m[7][8] = bit;       // 第 8 列，第 7 行（跳过第 6 行定时）
      else if (k === 7) m[8][8] = bit;       // 交点
      else if (k === 8) m[8][7] = bit;       // 第 8 行，第 7 列
      else m[8][14 - k] = bit;               // 第 8 行，第 5~0 列
      // 第二副本：右上（横）+ 左下（纵）
      if (k < 8) m[8][size - 1 - k] = bit;
      else m[size - 15 + k][8] = bit;
    }
    m[size - 8][8] = 1; // 固定深色模块
  }

  function penalty(m, size) {
    var score = 0, y, x, i, run, dark = 0;
    // 规则1：连续同色 5+
    for (y = 0; y < size; y++) {
      run = 1;
      for (x = 1; x < size; x++) {
        if (m[y][x] === m[y][x - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    for (x = 0; x < size; x++) {
      run = 1;
      for (y = 1; y < size; y++) {
        if (m[y][x] === m[y - 1][x]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    // 规则2：2x2 同色块
    for (y = 0; y < size - 1; y++) for (x = 0; x < size - 1; x++) {
      var v = m[y][x];
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
    }
    // 规则3：1:1:3:1:1 图案
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    function match(arr, off, pat) {
      for (var q = 0; q < 11; q++) if (arr[off + q] !== pat[q]) return false;
      return true;
    }
    for (y = 0; y < size; y++) {
      var row = m[y];
      for (x = 0; x + 11 <= size; x++) {
        if (match(row, x, pat1) || match(row, x, pat2)) score += 40;
      }
    }
    for (x = 0; x < size; x++) {
      var col = [];
      for (y = 0; y < size; y++) col.push(m[y][x]);
      for (y = 0; y + 11 <= size; y++) {
        if (match(col, y, pat1) || match(col, y, pat2)) score += 40;
      }
    }
    // 规则4：深色比例
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) if (m[y][x]) dark++;
    var pct = dark * 100 / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function clone(m) { return m.map(function (r) { return r.slice(); }); }

  /** 生成二维码矩阵。text 为字符串（UTF-8 编码）。返回 {size, matrix} 或抛错 */
  function generate(text) {
    var bytes = [];
    var utf8 = unescape(encodeURIComponent(text));
    for (var i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i) & 0xff);

    var ver = pickVersion(bytes.length);
    if (ver < 0) throw new Error('内容过长（' + bytes.length + ' 字节），二维码最多承载 271 字节');

    var cw = interleave(buildCodewords(bytes, ver), ver);
    var grid = makeMatrix(ver);
    placeData(grid, cw);

    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mk = 0; mk < 8; mk++) {
      var trial = { m: clone(grid.m), fn: grid.fn, size: grid.size };
      for (var y = 0; y < grid.size; y++) for (var x = 0; x < grid.size; x++) {
        if (!grid.fn[y][x] && MASKS[mk](y, x)) trial.m[y][x] ^= 1;
      }
      applyFormat(trial, mk);
      var sc = penalty(trial.m, grid.size);
      if (sc < bestScore) { bestScore = sc; best = trial.m; bestMask = mk; }
    }
    return { size: grid.size, matrix: best, version: ver, mask: bestMask };
  }

  /** 渲染为 SVG 字符串 */
  function toSVG(text, opts) {
    opts = opts || {};
    var scale = opts.scale || 4, quiet = opts.quiet == null ? 4 : opts.quiet;
    var r = generate(text);
    var dim = (r.size + quiet * 2) * scale;
    var path = '';
    for (var y = 0; y < r.size; y++) for (var x = 0; x < r.size; x++) {
      if (r.matrix[y][x]) {
        path += 'M' + ((x + quiet) * scale) + ' ' + ((y + quiet) * scale) + 'h' + scale + 'v' + scale + 'h-' + scale + 'z';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
      '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
      '<path d="' + path + '" fill="#111111"/></svg>';
  }

  global.MiniQR = { generate: generate, toSVG: toSVG, maxBytes: 271 };
})(typeof window !== 'undefined' ? window : globalThis);
