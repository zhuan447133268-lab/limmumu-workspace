/*!
 * upload.js —— 拖拽读取层
 * 原样保留原仓库 public/js/upload.js 的 readEntries 实现（含那个关键的同步取顶层 entry 的坑）。
 * 白名单过滤挪到 core.js 的 validateFiles，这里只负责把拖入的东西变成 [{file, relPath}]。
 */
(function (global) {
  'use strict';

  var HBUpload = {
    /**
     * 递归读取拖入的文件/文件夹。
     * 关键：必须在同步阶段取完所有顶层 entry —— DataTransferItemList 在事件处理函数
     * 让出事件循环（第一次 await）后会被浏览器清空，否则会出现"文件夹只读到第一个文件"。
     */
    async readEntries(dataTransferItems) {
      // ① 同步捕获所有顶层 entry
      var topEntries = [];
      for (var i = 0; i < dataTransferItems.length; i++) {
        var item = dataTransferItems[i];
        if (item.kind !== 'file') continue;
        var entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
        if (entry) {
          topEntries.push(entry);
        } else {
          var file = item.getAsFile();
          if (file) topEntries.push({ __plainFile: file });
        }
      }

      var files = [];

      async function readFile(fileEntry, basePath) {
        var file = await new Promise(function (resolve, reject) { fileEntry.file(resolve, reject); });
        files.push({ file: file, relPath: basePath + fileEntry.name });
      }

      async function readDir(dirEntry, basePath) {
        var reader = dirEntry.createReader();
        var all = [];
        // readEntries 每次最多返回一批，需反复调用直到返回空数组
        while (true) {
          var batch = await new Promise(function (resolve, reject) { reader.readEntries(resolve, reject); });
          if (!batch.length) break;
          all.push.apply(all, batch);
        }
        var dirPath = basePath + dirEntry.name + '/';
        for (var k = 0; k < all.length; k++) {
          var child = all[k];
          if (child.isFile) await readFile(child, dirPath);
          else if (child.isDirectory) await readDir(child, dirPath);
        }
      }

      // ② 异步递归（此时顶层 entry 已全部握在手里，不受清单清空影响）
      for (var j = 0; j < topEntries.length; j++) {
        var e = topEntries[j];
        if (e.__plainFile) {
          files.push({ file: e.__plainFile, relPath: e.__plainFile.name });
        } else if (e.isFile) {
          await readFile(e, '');
        } else if (e.isDirectory) {
          await readDir(e, '');
        }
      }

      return files;
    },

    /** <input type="file"> 的结果转成统一结构；webkitdirectory 时用 webkitRelativePath */
    fromInput(fileList) {
      return Array.prototype.map.call(fileList, function (f) {
        return { file: f, relPath: f.webkitRelativePath || f.name };
      });
    }
  };

  global.HBUpload = HBUpload;
})(typeof window !== 'undefined' ? window : globalThis);
