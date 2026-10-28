<div align="center">

# 🌍 GeoGuide

**面向地理发现与 GeoGuessr 竞技对战的社区共建交互式实战图鉴与知识库**

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-orange.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)
[![Platform](https://img.shields.io/badge/Platform-Vercel-black.svg)](https://vercel.com)
[![Database](https://img.shields.io/badge/Database-Turso%20LibSQL-00ED64.svg)](https://turso.tech)

[**English**](README.md) | [**简体中文**](README_zh.md)

</div>

---

## 📌 项目定位与解决的痛点

**GeoGuide** 是一个开源的交互式地理图鉴与 Meta 知识库平台，专为 **GeoGuessr 竞技选手、街景探索者与地理科普爱好者** 设计。

传统的 GeoGuessr 学习材料多为动辄上百页的 Google Docs、Notion 笔记或静态截图。当攻略里写着*“某国北部沿线常见红土与特定电杆”*时，玩家往往无法确切知道这个“北部”具体切在哪个地理纬度、沿哪条公路分布，也无法通过实景验证光照与季节差异。

**GeoGuide 的核心解法：将文字描述彻底转化为地图上可触碰、可验证的经纬对象：**
- 每一条地理特征（Meta）均以高精度**多边形（Polygon）**或**公路折线（Polyline）**精准勾勒在真实地图上；
- 点击任意区域，左侧展开精炼要点笔记与标签，右侧同屏联动**真实的 Google 360° 交互式街景**，并锁定作者推荐的最佳视线朝向（Heading）、仰角（Pitch）与视场角（FOV）。

---

## ✨ 核心特色与功能模块

- **🗺️ 全球宏观热力地图 (World Heatmap)**
  - 首页呈现矢量动态世界地图，直观反映各国家已收录的区域丰满度；
  - 鼠标悬停即时高亮并显示收录数量，支持领土联动（如中国地图联动台湾、香港、澳门高亮）。
- **📐 高精度矢量图层体系 (Geometry Layers)**
  - **彩色多边形 (Polygons)**：采用黄金比例色环着色，清晰界定土壤、植被过渡带或行政区域；
  - **公路折线 (Polylines)**：专为沿线特征（如公路反光标柱、护栏样式、路面虚线）定制的线条几何；
  - **聚散优化 (Dot Collapse)**：远景大比例尺下小区域自动聚拢为点标记，放大后平滑展为具体边界。
- **👁️ 街景联动与历史全景穿梭 (Street View Embed)**
  - 原生内嵌 Google Street View iframe，完整支持特定 `pano` 标识的历史街景捕获；
  - 零 Google Maps JavaScript API 配额消耗，无需担心高额账单。
- **🛡️ 开箱即用与零 Key 优雅降级 (Zero-Key Out-of-the-Box)**
  - 默认基于 **OpenStreetMap (CartoDB 瓦片)** 运行，**完全无需任何 API Key 即可 100% 正常缩放与浏览全站图鉴**；
  - 未配置 Google Key 时，街景区域提供清晰友好的自建 Key 指引，绝不会导致页面报错或死锁。
- **🤝 社区共建、投稿与审核体系 (Community Co-creation)**
  - 内置便捷的在线多边形与折线绘制工具，支持 **KML / GeoJSON 一键导入**；
  - 完善的审核后台队列（已通过、需修改、已拒绝三态流转）；
  - 社区勋章互动体系（🐐 GOAT、❤️ 喜欢、👍 实用）与动态 Canvas **贡献者星系画布**。
- **🔍 专属复习工具箱与深度分享 (Study Toolkit)**
  - **收藏夹工具栏**：支持按最新/最旧排序、按国家筛选（带条目统计）及实时关键词搜索；
  - **对比模式 (Compare Mode)**：同屏并排对比两处极易混淆的公路或地貌；
  - **深度分享直链**：支持一键复制精确直链（`/explore?country=...&region=...`），赛后直达街景同屏复盘；
  - **暗黑模式 (Dark Mode)**：全局支持羊皮纸质感浅色与极夜暗黑模式一键切换。

---

## 🏗️ 技术架构与技术栈

GeoGuide 坚持极轻量、快速加载的工程哲学，全站无重型前端打包工具绑架：

- **前端 (Frontend)**：原生 JavaScript (Vanilla ES6+)、[Leaflet.js](https://leafletjs.com/)、[Geoman](https://geoman.io/) 几何编辑器、CSS3 变量与 Flexbox/Grid。
- **后端服务 (Backend)**：部署在 [Vercel](https://vercel.com/) 上的 Serverless Functions (Node.js)。
- **边缘数据库 (Database)**：[Turso](https://turso.tech/) (基于 LibSQL / SQLite 的分布式边缘数据库)。
- **用户鉴权 (Auth)**：Discord OAuth2（可选，用于社区提交与身份标识）。
- **AI 辅助 (AI Translation)**：DeepSeek API（用于外语笔记的一键机翻）。

---

## 🚀 快速上手与本地运行

### 方式一：轻量静态快速预览（无需任何 API Key）

如果您只想本地快速预览 UI 界面与地图核心功能：

```bash
# 克隆公开仓库
git clone https://github.com/LuanJiangXing/geoguide.git
cd geoguide

# 使用任意静态服务器托管 public 目录
npx serve public
# 或者使用 Python 启动
python3 -m http.server 8080 --directory public
```

在浏览器打开 `http://localhost:8080` 即可浏览完整的前端地图与图层功能。

---

### 方式二：全栈完整开发环境（启用后端与街景）

如需体验完整的投稿提交、审核后台以及 360° 真实街景：

#### 1. 安装依赖
```bash
npm install
```

#### 2. 配置环境变量
复制环境配置模板：
```bash
cp .env.example .env.local
```

编辑 `.env.local` 填入您的凭据（按需配置）：
```bash
# Google Maps API Key（可选，用于街景嵌入）
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here

# Turso 数据库连接（可选，用于自建数据存储）
TURSO_URL=libsql://your-database-name.turso.io
TURSO_TOKEN=your_turso_auth_token_here

# 审核后台登录密码（/review.html）
admin_password=your_secure_password
```

> **提示**：Google Maps API Key 需在 [Google Cloud 控制台](https://console.cloud.google.com/) 免费启用 **Maps Embed API** 与 **Maps JavaScript API**。

#### 3. 构建与本地运行
```bash
# 根据环境变量生成前端 config.js
npm run build

# 使用 Vercel CLI 本地联调后端 API
npx vercel dev
```

---

## 📁 目录结构说明

```
geoguide/
  ├── api/                   # Vercel Serverless Functions 服务端接口
  │   ├── _lib/              # 数据库连接、安全 CSRF、OG 图片生成等工具库
  │   ├── submissions.js     # 地理数据查询接口
  │   ├── submit.js          # 地理数据提交通道
  │   ├── review.js          # 管理员审核与状态流转
  │   └── reactions.js       # 表情互动与收藏夹接口
  ├── public/                # 纯静态前端资源
  │   ├── index.html         # 首页（全球热力地图、热门轮播、星系排行）
  │   ├── explore.html       # 核心探索页（双栏笔记与街景漫游）
  │   ├── submit.html        # 投稿录入页（在线勾绘与 KML 导入）
  │   ├── profile.html       # 个人中心（收藏夹复盘与检索）
  │   ├── review.html        # 社区审核控制台
  │   ├── css/style.css      # 全站样式体系与暗黑模式适配
  │   └── js/                # 模块化纯原生 JavaScript 组件
  ├── scripts/               # 构建脚本、数据生成与自动化测试套件
  ├── .env.example           # 脱敏环境变量模板与注释说明
  └── LICENSE                # CC BY-NC-SA 4.0 非商业开源许可证
```

---

## 🤝 贡献与共建

欢迎来自全球各地的地理发现者与 GeoGuessr 爱好者共同维护：
- **提交问题或需求建议**：欢迎提交 [GitHub Issue](https://github.com/LuanJiangXing/geoguide/issues)；
- **代码或地图数据贡献**：欢迎发起 [Pull Request](https://github.com/LuanJiangXing/geoguide/pulls)。

---

## 📄 开源许可证

本项目基于 [知识共享 署名-非商业性使用-相同方式共享 4.0 国际许可协议 (CC BY-NC-SA 4.0)](LICENSE) 开源。

> **严格禁止任何形式的商业用途。** 仅供个人非商业性学习、研究与交流使用；任何非商业衍生修改必须保留原作者署名，并以相同方式共享。
