# Those Days · VRChat Memorial

> 欢迎来到“那些日子”——一个记录 VRChat 珍贵回忆的纪念站点。


## 📖 项目简介

这是一个关于 VRChat 经历与回忆的纪念网站。目前处于早期开发阶段，主要作为一个入口展示页。网站采用了独特的视觉设计，旨在营造一种怀旧与温馨的氛围。

### 当前功能

- **沉浸式首页**：包含动态背景与精美的 UI 设计。
- **双重身份入口**：
  - **现实旅人**：跳转至个人博客 (<https://www.kozakemi.top)。>
  - **VRC住民**：专为 VRChat 好友设计的入口（开发中）。
- **移动端适配**：响应式布局，支持不同设备访问。

## 🛠️ 技术栈

目前项目为静态页面，未来计划迁移至现代前端框架：

- **当前**：HTML5, CSS3 (Flexbox/Grid), GitHub Pages
- **计划**：React.js / Next.js
- **安全**：好友隐私数据将采用 AES-256-GCM 加密存储

## 🚀 部署

本项目使用 GitHub Actions 自动部署至 GitHub Pages。

- **分支**：`main`
- **自动构建**：每次 push 到 main 分支时自动触发构建与部署。

### 相册上传检查

上传使用浏览器直连 OSS。桶的 CORS 必须允许 `https://vrchat.kozakemi.top` 的 `PUT`
及 `Content-Type` 请求头；只允许 `GET` 时，读取相册正常但上传预检会返回 403。
GitHub Actions 只部署静态页面，不会更新 OSS CORS。

- `node tools/oss-upload-cors.mjs`：读取配置并检查线上 PUT 预检。
- `node tools/oss-upload-cors.mjs --apply`：先备份到已忽略的 `keys/`，保留原规则，补充站点上传规则。
- `node tools/album-upload-smoke.mjs --confirm-write`：实际测试加密、上传、清单合并、回读、解密，再还原清单并清理测试对象。测试期间避免其他管理员同时上传。

脚本使用本机 `keys/oss.json`，冒烟测试另需 `keys/kozakemi.admin.json`。
管理页可导入 OSS JSON 文件，也可粘贴后保存；凭据仅保存在当前标签页会话中，勿提交到仓库或构建产物。

OSS 桶完全为空时，相册会显示“暂无照片”。管理员首次点击上传时，程序先自动创建
`albums/manifest.json` 并回读验证，再写入 `albums/assets/<id>.bin` 并合并清单。
OSS 使用对象键前缀表示文件夹，写入文件时会自动形成目录，无需手动建立。
只有清单明确返回 404 才初始化；权限、网络或 JSON 解析错误会中止上传，避免覆盖已有数据。
运行 `npm run test:album-empty` 可在内存存储中验证空桶初始化和这些失败情况，不会访问生产 OSS。

## 📅 开发计划

- [x] 静态首页搭建
- [x] GitHub Pages 自动部署配置
- [ ] 使用 React 框架
- [ ] 实现 VRChat 好友专属登录/解密功能
- [ ] 增加相册与回忆录板块

## 📄 许可证与版权说明

### 1. 代码许可
本项目代码部分采用 [MIT License](LICENSE) 授权。您可以自由地使用、复制、修改、合并、出版发行、散布、再授权及贩售本软件的副本。

### 2. 资源版权
本项目中使用的**所有图片、音频及视频资源**（包括但不限于背景图、图标、照片等）**不适用**于 MIT 许可证。这些资源的版权归原作者所有，保留所有权利。未经明确书面许可，请勿擅自提取使用。

### 3. VRChat 免责声明
本项目部分界面设计灵感来源于 **VRChat**，旨在致敬该平台带来的美好回忆。
- 本项目与 VRChat Inc. 无任何官方关联。
- "VRChat" 是 VRChat Inc. 的注册商标。
- 本项目不主张任何关于 VRChat 品牌资产的权利，亦无意侵犯 VRChat 的版权或商标权。
- 如有任何侵权疑虑，请联系作者进行处理。
