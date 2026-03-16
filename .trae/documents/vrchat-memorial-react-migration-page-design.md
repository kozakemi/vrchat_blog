# 页面设计文档（Desktop-first）

## 全局样式（Design Tokens）
- 字体：
  - Primary: Nunito
  - CJK Fallback: Noto Sans SC
  - Fallback: sans-serif
- 颜色（来自现有首页样式）：
  - Background: `#3d5159`
  - Accent/Border: `#5ba8a0`
  - Text Primary: `#e8f0ef`
  - Text Secondary: `#c8dedd`, `#9abfbb`, `#7aada8`
  - Logo Invert: `#ffffff`
- 圆角：6px（小按钮/标签），10px（主要按钮/Logo 框）
- 阴影：文本阴影 `0 2px 12px rgba(0,0,0,0.25)`（用于 Welcome 文案）
- 动效：
  - 页面入场：fadeIn（0.8s，opacity + translateY）
  - Hover：按钮背景与边框颜色渐变（0.2s）

## 页面：首页

### Layout
- 主布局：Flexbox（`body` 作为居中容器，水平/垂直居中）。
- 分层：使用 `position: fixed` 放置顶部栏与右侧竖排标签；主内容区在中心。
- 间距：以固定像素为主（保持与现有静态页一致）。

### Meta Information
- Title：Those Days · VRChat Memorial
- Meta:
  - charset: UTF-8
  - viewport: width=device-width, initial-scale=1.0
- Open Graph：本次迁移不新增（保持现状；如未来需要再补充）。

### Page Structure
1. 顶部栏（固定定位、居中）
2. 右侧 Early Access 标签（固定定位、垂直居中）
3. 中央主内容（纵向堆叠）：Welcome 文案 → Logo 气泡 → Login with 文案 → 两个登录按钮 → OR 文案 → Create Account 按钮
4. 背景：body 基色 + before 伪元素 radial gradients 叠加

### Sections & Components

#### 1) Top Bar / About Us
- 结构：容器 `.top-bar` + 按钮 `.btn-about`
- 视觉：透明背景、描边、圆角、浅色文本
- 交互：保持“不可点击/默认光标”（与现有静态页一致）。

#### 2) Side Tag / Early Access
- 结构：`.early-access` + `.early-access-inner`
- 视觉：竖排文字（writing-mode: vertical-rl），描边与强调色
- 交互：纯展示，无点击。

#### 3) Main Content
- 结构：`.main`（column + center）
- 入场动画：fadeIn（0.8s）

##### 3.1 Welcome Text
- 文案：Welcome to the world of
- 视觉：大字号、粗体、浅色、轻微 text-shadow

##### 3.2 Logo Bubble
- 结构：`.logo-bubble` -> `.logo-box`（THOSE + DAYS）
- DAYS 背景为白色块，文字为背景色反转
- 气泡三角：`.logo-bubble::after`

##### 3.3 Login Label
- 文案：Login with
- 视觉：小字号、次级色

##### 3.4 Login Buttons Row
- 布局：横向排列（gap 固定），两枚大按钮同高同宽
- 按钮 A（现实旅人）：
  - 类型：链接（`<a>`）
  - 行为：新标签打开 `https://www.kozakemi.top`
  - Hover：背景加亮、边框变亮
- 按钮 B（VRC住民）：
  - 类型：按钮（`<button>`）
  - 行为：保持“不可点击/默认光标”

##### 3.5 OR Label
- 文案：OR
- 视觉：小字号、强调字距（letter-spacing）

##### 3.6 Create Account Button
- 结构：文案 + 箭头
- 行为：保持“不可点击/默认光标”（与现有静态页一致）
- Hover：背景/边框/文字强调色变化；箭头向右轻移

### Responsive Behavior（在不改变桌面视觉前提下）
- ≤ 480px：按钮行允许换行或改为纵向堆叠（保持可读性与可点击面积）。
- 高度较小屏幕：主内容区允许轻微上移或缩小纵向间距，但不改变元素相对顺序。
