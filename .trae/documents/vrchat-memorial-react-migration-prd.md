## 1. Product Overview

将现有 VRChat 纪念站从单一静态首页迁移为 React 项目，提供可用的本地开发与测试环境。
在保持现有首页视觉样式与跳转链接不变的前提下，保证可构建并兼容 GitHub Pages 部署。

## 2. Core Features

### 2.1 Feature Module

本产品（迁移后站点）的核心页面如下：

1. **首页**：保留现有视觉布局（顶部 About Us、右侧 Early Access 标签、主视觉标题与 Logo 气泡、登录按钮区、Create Account 按钮）；保留现有跳转链接与按钮交互表现；提供 React 本地开发可预览一致效果。

### 2.3 Page Details

| Page Name | Module Name        | Feature description                                                                                         |
| --------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| 首页        | 页面元信息              | 设置 title 为 “Those Days · VRChat Memorial”；设置 viewport 与 charset 以保持一致显示。                                    |
| 首页        | 字体与基础样式            | 加载 Nunito 与 Noto Sans SC 字体；应用全局 reset（margin/padding/box-sizing）；设置背景色与背景 radial-gradient 叠加效果。            |
| 首页        | 顶部栏（About Us）      | 显示顶部居中的 About Us 按钮；保持当前“不可点击/默认光标”表现与样式（边框、颜色、圆角、字号）。                                                      |
| 首页        | 侧边标签（Early Access） | 显示右侧垂直文字标签；保持 writing-mode、边框与颜色、固定定位与居中对齐。                                                                 |
| 首页        | 主内容区（居中布局）         | 以页面水平/垂直居中为主（flex）；加载淡入动画（opacity + translateY）；保持文本阴影与字号层级。                                                |
| 首页        | 标题与 Logo 气泡        | 渲染 “Welcome to the world of” 文案；渲染 THOSE/DAYS 双色 Logo 框与气泡三角；保持字号、字重、间距与边框。                                 |
| 首页        | 登录区按钮（现实旅人）        | 提供可点击链接按钮；跳转到 `https://www.kozakemi.top` 并在新标签打开（target=\_blank, rel=noopener noreferrer）；保持 hover 高亮与按钮尺寸。 |
| 首页        | 登录区按钮（VRC住民）       | 显示按钮并保持当前“不可点击/默认光标”表现与样式（与静态页一致）。                                                                          |
| 首页        | Create Account 按钮  | 显示 CREATE ACCOUNT 按钮与箭头；保持当前“不可点击/默认光标”表现与 hover 动效样式（颜色/边框/箭头位移）。                                          |

## 3. Core Process

* 访客流：访客打开首页 → 浏览主视觉与按钮区 → 点击“现实旅人”按钮（在新标签打开外部站点）→ 继续停留或关闭。

* 非功能性约束：迁移到 React 后，首页视觉（颜色、字号、间距、布局、hover、动画）与现有跳转链接保持一致；构建产物需可用于 GitHub Pages 静态托管。

```mermaid
graph TD
  A["首页"] --> B["外部站点（
```

