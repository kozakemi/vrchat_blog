# tools/fc-sign — OSS 临时签名服务（阿里云函数计算）

给前端换取 OSS 对象的**短时有效 URL**，让桶内对象不必公开可读。
相册页的清单与图片、管理页的清单回读都走这个服务。

## 1. 线上现状（2026-10-07 实测）

服务地址：`https://vrchat-oss-wdmpygkprb.cn-beijing.fcapp.run`（前端常量 `VITE_OSS_SIGN_ENDPOINT`）

| 请求 | 实测结果 | 结论 |
|---|---|---|
| `?file=albums/manifest.json` | `200 {"signedUrl":...,"expire_in":300}` | ✅ 现役能力 |
| `?file=<任意对象键>` | `200` 一律签发 | ⚠️ 无前缀白名单 |
| `?file=../keys/oss.json` | `400 {"error":"非法 file 参数"}` | ✅ 有基础路径穿越过滤 |
| `?put=1` / `?put=1&key=x` | `400 {"error":"缺少 file 参数"}` | ❌ PUT 参数已不被识别 |
| `?put=1&file=x`、`?file=x&method=PUT` | 与纯 GET 签名**逐字节相同** | ❌ 并非 PUT 签名 |
| `OPTIONS` 预检 | `204`，`Access-Control-Allow-Methods: GET,OPTIONS` | ❌ 触发器层面就没开 PUT |

响应头带 `X-Fc-Request-Id`，且 400/204 也带 CORS 头与 `Access-Control-Max-Age`，
说明 **CORS 由 HTTP 触发器的配置统一下发**，不是函数代码设置的。

**重要推论：开放 GET 签名不是漏洞，而是设计必需。** 相册页在浏览器里没有任何凭据，
必须能匿名把对象键换成临时 URL；机密性由 Zone key（AES-256-GCM）承担，没有 key
拿到密文也没用。真正需要守住的是**写入面**，而 PUT 签名目前已经被关掉。

## 2. 本目录文件

| 文件 | 作用 |
|---|---|
| `handler.mjs` | 函数代码，**零依赖**（只用 `node:crypto`），单文件即可部署 |
| `selftest.mjs` | 离线自测：校验分支 + 与 `ali-oss` 逐字节比对签名 + 真实 GET 打桶 |

相比线上版本，`handler.mjs` 加固了三点：

1. **对象键白名单**（默认只允许 `albums/` 前缀，可用 `ALLOWED_KEY_PREFIXES` 调整），
   拒绝 `..`、空路径段、前导 `/`、控制字符、超长键；
2. **零依赖**：自行实现 OSS Signature V1，不必在函数里安装 `ali-oss`；
3. **PUT 签名默认关闭**：要开启必须同时设置 `ALLOW_PUT_SIGN=1` 与 `PUT_TOKEN`，
   且用 `crypto.timingSafeEqual` 常数时间比对，避免重开「任意人可写」的写入面。

自测（需仓库根 `keys/oss.json`，该文件已被 `.gitignore` 忽略）：

```bash
node tools/fc-sign/selftest.mjs
# 期望输出结尾：======= 通过 21 / 失败 0 =======
```

自测会真实 GET 一次 OSS，但**不会产生任何写入**。PUT 签名只做本地计算，
与 `ali-oss` 的 `signatureUrl` 比对，用来证明签名实现正确。

## 3. 部署步骤

### 方式 A：控制台（适合单文件快速替换）

1. 进入 **函数计算 FC 控制台 → 函数 → 找到现有签名函数**（服务地址对应 `vrchat-oss-wdmpygkprb`）。
2. **配置 → 环境变量**，补齐：

   | 变量 | 必填 | 说明 |
   |---|---|---|
   | `OSS_ACCESS_KEY_ID` | ✅ | 建议用只授 `vrchat-png` 读权限的 RAM 子账号 |
   | `OSS_ACCESS_KEY_SECRET` | ✅ | |
   | `OSS_BUCKET_NAME` | ✅ | `vrchat-png` |
   | `OSS_ENDPOINT` | ✅ | `oss-cn-beijing.aliyuncs.com` |
   | `ALLOWED_KEY_PREFIXES` | 可选 | 默认 `albums/`；填 `-` 表示不限制（不建议） |
   | `ALLOW_PUT_SIGN` | 可选 | 默认关闭，见第 4 节 |
   | `PUT_TOKEN` | 可选 | 开启 PUT 时必填 |
   | `SIGN_EXPIRES_SEC` | 可选 | 默认 300，上限 3600 |

3. **代码**：把 `handler.mjs` 内容整体覆盖进去。运行时选 **Node.js 18+**，
   入口保持 `handler`（若控制台要求形如 `index.handler`，把文件命名为 `index.mjs`
   或按控制台提示填写模块名）。
4. **HTTP 触发器**：确认请求方法包含 `GET` 与 `OPTIONS`。
   若沿用「事件函数 + HTTP 触发器」，函数返回 `{statusCode, headers, body}` 即可；
   若你的函数是「HTTP 函数」形态（handler 收到 `(req, res)`），
   用文件末尾注释里的 `httpHandler` 包装替换。
5. 验证（部署后立刻可跑，不需要前端）：

   ```bash
   EP=https://vrchat-oss-wdmpygkprb.cn-beijing.fcapp.run
   curl -s "$EP?health=1"                       # 应返回 configured:true 与白名单
   curl -s "$EP?file=albums/manifest.json"      # 应返回 signedUrl + expire_in
   curl -s "$EP?file=VRChat/whatever.png"       # 应返回 400 非法 file 参数
   curl -s "$EP?put=1&file=albums/x.bin"        # 应返回 403 未开启 PUT 签名
   ```

   四项都符合预期，再让前端切换到新版本。

### 方式 B：Serverless Devs（适合纳入版本管理）

```bash
npm i -g @serverless-devs/s
s config add          # 配置阿里云 AK（建议用 RAM 子账号）
s deploy              # 需要有 s.yaml；本目录未附带，按控制台现有函数的配置生成
```

> 本目录只提供函数代码与自测，没有附带 `s.yaml`：现有函数的触发器/运行时配置
> 以控制台为准，直接照抄现有函数比从零生成更稳妥。

## 4. 如果要恢复 PUT 签名（让管理端不必在浏览器里贴 AccessKey）

**必须同时改三处，缺一处就会失败：**

1. `handler.mjs`：设置环境变量 `ALLOW_PUT_SIGN=1` + `PUT_TOKEN=<足够长的随机串>`。
   请求形如 `?put=1&file=<对象键>&token=<PUT_TOKEN>&content_type=<MIME>`。
2. **HTTP 触发器 → CORS**：`Access-Control-Allow-Methods` 增加 `PUT`
   （现在是 `GET,OPTIONS`，浏览器预检会直接拦掉 PUT）。
3. 前端 `src/lib/ossUpload.ts` 的 `resolvePutSignedUrl`：恢复「无 OSS 配置时请求签名服务」
   的分支，并把当前那条说明性报错换掉。

> ⚠️ 安全权衡：一旦开放 PUT 签名，**任何拿到该地址与 token 的人都能改 `albums/manifest.json`**。
> 若不希望把 token 放进前端（放进去就等于公开），更稳的做法是把「读清单 → 合并 → 写回」
> 整个逻辑搬到服务端串行执行，前端只提交新增条目。当前前端已加回读校验，但 OSS 单对象
> PUT 没有 CAS/乐观锁，两个标签页同时合并仍可能互相覆盖，校验只能发现、无法阻止。

## 5. 排错

| 现象 | 原因 |
|---|---|
| 前端报「签名URL路径包含 %2F」 | 签名服务把对象键里的 `/` 编码成了 `%2F`；本实现按段 `encodeURIComponent` |
| 签名 URL 指向 `localhost` | 签名服务返回了相对路径或当前站点绝对地址；前端 `resolveSignedUrlToAbsolute` 会纠回 Bucket 域名 |
| 上传 403 | PUT 的 `Content-Type` 与签名时不一致，或桶策略/CORS 未放行跨域 PUT |
| 清单 0 张但请求 200 | 返回的是 HTML（404 或 SPA index）而非 JSON；检查对象键与函数是否真的返回清单 |
| `?put=1` 返回 400「缺少 file 参数」 | 就是本文档第 1 节记录的历史行为：PUT 签名早已移除 |
