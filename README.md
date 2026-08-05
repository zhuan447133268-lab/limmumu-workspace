# HTML → 可分享链接（GitHub Pages 自托管版）

把本地 HTML（含整个文件夹）拖进去，直接生成可在手机/任意设备打开的可分享链接。
基于 `git.oceghome.com/aiproject/file` 改造为**纯静态、可自部署到 GitHub Pages** 的版本——**无需统一身份认证、无需服务器、无需数据库**。

链接是主角：上传完成即弹出并自动选中，可直接复制；二维码仅为「手机扫码」可选项，不是前置门槛。

---

## 核心流程

1. 浏览器打开部署好的 `index.html`（GitHub Pages 地址）。
2. 首次使用点右上角「设置」，填入你的 GitHub 仓库信息 + Token，保存并「测试连接」。
3. 把 HTML 文件或文件夹拖进左侧虚线框（也可点「选择文件 / 选择文件夹」）。
4. 通过安全审查后自动上传，**弹窗里直接给出短链**——点「复制」即可分享。
5. 对方打开短链（`s.html#<短码>`）即可看页面；若是 Markdown 会自动渲染。

> 链接格式：`https://<你>.github.io/<仓库>/s.html#<短码>`
> 直链（兼容性最好，不走 JS 跳转）：`https://<你>.github.io/<仓库>/f/<storageId>/index.html`

---

## 部署步骤（一次性）

### 1. 建仓库并放代码
- 在 GitHub 新建一个**公开**仓库（如 `html-share`）。
- 把本目录全部文件推上去（`index.html` `s.html` `404.html` `css/` `js/` `data/` `.nojekyll`）。

### 2. 开启 GitHub Pages
- 仓库 `Settings → Pages → Build and deployment → Source` 选 **Deploy from a branch**。
- Branch 选 `main` / `root`，保存。约 1 分钟内生效。

### 3. 生成 Token
- `GitHub → Settings → Developer settings → Personal access tokens → Fine-grained` 或 Classic。
- 权限需含 **Contents（读写）**（Fine-grained 选该仓库的 `Contents: Read and Write`）。
- 复制生成的 token。

### 4. 在工具里配置
- 打开 `index.html` → 右上「设置」：
  - Owner：你的 GitHub 用户名
  - Repo：仓库名（如 `html-share`）
  - Branch：`main`
  - Token：第 3 步复制的 token
- 点「测试连接」，显示「连接成功」即配置完毕。配置只存在浏览器 localStorage，不会上传。

---

## 与原仓库的差异（静态化改造）

**已移除（静态环境无法实现）：**
- 统一身份认证（CAS 登录/登出）—— 改为工具内配置 Token。
- 三级可见性（公开/组织/私有）—— GitHub Pages 天然全公开。
- 访问次数统计 —— 无后端，无法计数。

**已降级：**
- 过期：改为「软过期」。到点后短链页面显示过期提示，但文件仍留在仓库，需彻底删除请用「删除」按钮。
- 多版本覆盖：每次覆盖生成新版本目录，短链不变，可回看历史版本。

**保留并强化：**
- 拖拽上传（文件 / 文件夹，保留递归读取）。
- 安全审查规则（XSS / 危险协议 / 外链等）在浏览器端执行。
- Markdown 客户端渲染 + 相对路径重写。
- 二维码生成（零依赖，`qr.js`）—— 仅作可选便利。

---

## 文件结构

```
index.html        主页面（上传 + 管理）
s.html            短链路由页（目录索引 / Markdown 渲染 / 过期拦截 / 错误处理）
404.html          兜底：/s/<短码> 形式也重定向到 s.html#
css/style.css     animal-island 视觉风格
js/core.js        校验 + 安全审查规则
js/markdown.js    Markdown 渲染
js/store.js       GitHub Data API（blob→tree→commit→ref 单提交上传）
js/upload.js      拖拽读取（含文件夹递归）
js/qr.js          零依赖二维码
js/app.js         主逻辑编排
data/projects.json  元数据（项目清单，替代 MySQL）
.nojekyll         禁用 Jekyll，确保 f/ 与 data/ 正常服务
```

---

## 常见问题

- **上传后打不开链接？** GitHub Pages 部署需 10~60 秒，等一会再试；确认仓库是 public。
- **想换 GitHub 账号？** 右上「设置」重填即可，不影响已上传内容。
- **token 泄露？** 在 GitHub 撤销该 token，重新生成一个再填。
- **国内访问慢？** 本工具已用系统字体栈替代 Google Fonts；若 Pages 本身慢，可挂 CDN 或换 Gitee Pages。
