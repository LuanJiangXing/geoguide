# resolve-link: maps.app.goo.gl 短链接解析失败

**状态:** 待修复  
**发现日期:** 2026-07-27

## 问题

用户提交 Google Maps 短链接 `https://maps.app.goo.gl/HyJmqzoHVyRgJZ9YA`，
调用 `/api/resolve-link` 解析 4-5 次均失败，返回：
> Cannot resolve this Google Maps link. Please provide a valid Street View URL with visible coordinates.

## 根因

`api/_lib/turso.js` 中 `resolveStreetview()` 的 `fetch` 调用有两个问题：

### 1. 缺少 User-Agent 头部

```js
// api/_lib/turso.js:170
var resp = await fetch(link, { method: 'GET', redirect: 'follow' });
```

Node.js `fetch` 默认发送 `User-Agent: node`（或 undici 内置 UA）。Google 识别为非浏览器请求后，
不返回正常的 HTTP 302 重定向，而是返回 consent 页面或 CAPTCHA 页面。`redirect: 'follow'`
会跟随到这些页面的 URL（不含 `@lat,lng` 坐标），正则匹配失败。

### 2. 无超时控制 + 静默吞错

```js
// api/_lib/turso.js:183
} catch(e) { /* resolution failed, return defaults */ }
```

- `fetch` 无 `AbortController` 超时，慢速网络下会一直等到 Vercel 函数 10 秒超时
- `catch` 块不记录任何日志，真正的错误原因完全不可见
- 最终返回 `{lat:0, lng:0}`，API 层返回 400 通用错误，用户无法判断原因

### 验证

从本地用普通浏览器 fetch 和 `curl` 分别测试同一链接：

- **curl（默认 UA）**：获得 302 → `www.google.com/maps/@45.1698697,-122.7510798,...`，解析成功
- **Node.js fetch（无自定义 UA / 直连）**：`ETIMEDOUT`，连接 Google IP 失败
- Vercel 环境：网络可达但 Google 根据 UA 判断为爬虫，返回非预期页面

## 影响范围

- 所有通过 `maps.app.goo.gl` 短链接提交的 Street View 链接
- 所有通过旧域名 `goo.gl` 的短链接（走同一个分支）
- 直接粘贴含 `@lat,lng` 的完整 URL 不受影响（走快速路径，不触发 fetch）

## 推荐修复

`resolveStreetview()` 中：

1. 给 `fetch` 添加浏览器 User-Agent
2. 加 8 秒 `AbortController` 超时
3. `catch` 块使用 `console.error` 记录原始错误
