# OpenCron 本地开发与调试

部署时可选择 D1 或 PostgreSQL，详见 [数据库配置与脚本表操作](./database.md)。

## 技术栈

当前项目使用 **Hono + Vite + Vue**，没有引入 Astro：

- Hono 负责 Cloudflare Worker 内的 `/api/*` 接口和 Better Auth 路由。
- Better Auth 提供邮箱密码注册、登录、退出和 Cookie Session。
- Vue 3 单文件组件负责管理后台 SPA。
- Vite 与 Cloudflare Vite 插件负责前后端开发、构建和 Worker 运行时集成。
- Tailwind CSS 4 与 CodeMirror 6 作为本地依赖参与构建。
- Cloudflare Worker Assets 提供构建后的 HTML、CSS 和 JavaScript。
- D1 存储用户、会话、任务、执行记录和脚本任务的隔离存储。
- Cloudflare Dynamic Workers 执行用户脚本任务。

Astro 更适合官网、文档、SEO 或以静态内容为主的页面。当前管理端是高交互 SPA，增加 Astro 不会带来明显收益。

## 安装与初始化

全新本地数据库按顺序执行：

```bash
pnpm install
pnpm db:init:local
pnpm db:migrate:local:0002
pnpm db:migrate:local:0003
pnpm db:migrate:local:0004
pnpm db:migrate:local:0005
pnpm db:migrate:local:0006
```

如果本地已经执行过前面的迁移，只执行尚未执行的编号。每个脚本是一次性迁移，不要重复执行。

复制 `apps/api/.dev.vars.example` 为已被 Git 忽略的 `apps/api/.dev.vars`，并替换其中的本地认证 Secret：

```dotenv
BETTER_AUTH_SECRET=至少-32-字符的本地随机字符串
```

项目不再有默认账号和默认密码。首次打开页面后，点击 **Create account** 注册即可；Better Auth 当前要求密码至少 8 个字符。迁移前已有但没有 owner 的任务，会在迁移后的第一个账号注册时归属给该账号。

## 启动开发服务器

```bash
pnpm dev
```

默认地址是 <http://localhost:5173/>。Vite 同时启动 Vue HMR 和本地 workerd：

- 页面和静态资源由 Vite / Worker Assets 提供。
- `/api/auth/*` 由 Better Auth 处理，其余 `/api/*` 需要有效 Session。
- D1、Dynamic Worker Loader 和其他绑定使用本地模拟环境。
- Worker 调试入口是 <http://localhost:5173/__debug>。

如果安装或升级依赖后页面一直空白，而 `pnpm typecheck` 没有错误，先完全停止旧的 Vite 进程再重新运行 `pnpm dev`。Vite 的旧依赖优化状态不会总能通过 HMR 自愈。

## 登录注册与 API 调试

浏览器注册成功后会获得 HttpOnly Session Cookie，任务和执行历史只对当前用户可见。退出后该 Session 会立即失效。

命令行调试可以使用 Cookie jar：

```bash
cookie_jar="$(mktemp)"

curl -c "$cookie_jar" \
  -H "content-type: application/json" \
  -H "origin: http://localhost:5173" \
  --data '{"email":"you@example.com","password":"your-password"}' \
  http://localhost:5173/api/auth/sign-in/email

curl -b "$cookie_jar" http://localhost:5173/api/jobs
```

不要提交 Cookie jar、`.dev.vars` 或真实密码。

## 本地执行 Cron

`pnpm dev` 不会等待真实的每分钟云端 Cron，但可以直接触发 `scheduled()`：

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?format=json"
```

也可以显式传入 cron 表达式和模拟时间：

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&format=json"
```

只有 `enabled = true` 且 `next_run_at` 已到期的任务会被调度器执行。测试某个任务时，登录管理端后点击 **Run** 更直接，它会调用 `POST /api/jobs/:id/run`。

## Dynamic Worker 调试

推荐 smoke test：

1. 注册或登录后新建 `script` 类型任务。
2. 保留默认 module Worker 脚本，保存后点击 **Run**。
3. 展开任务历史，确认状态为 `200`，响应包含任务名。
4. 需要断点时打开 `/__debug`，在 `apps/api/src/script-runner.ts` 检查 Loader、RPC storage binding 和响应。

Dynamic Worker 默认没有外网访问，不会获得 `BETTER_AUTH_SECRET`、原始 D1、原始 KV 或 Worker Loader。父 Worker 只提供绑定到“当前用户 + 当前任务”的 RPC 能力。

### D1 脚本记录表

`env.D1` 只能操作 `script_records`。脚本不提供表名或 SQL，也不能执行 DDL。每条记录只有脚本可控的 `key` 和 string 类型 `data`；`owner_user_id`、`job_id` 和时间戳由父 Worker 管理：

```js
const previous = await env.D1.get("counter");
const count = Number(previous?.data ?? "0") + 1;
const saved = await env.D1.put("counter", String(count));
const records = await env.D1.list("count", 100);
await env.D1.delete("counter");
```

接口说明：

- `get(key)`：返回 `{ key, data, created_at, updated_at }` 或 `null`。
- `put(key, data)`：新增或更新 string 数据；单条最大 100 KB。
- `delete(key)`：删除当前任务的键。
- `list(prefix?, limit?)`：按 key 排序返回记录，limit 为 1–200。
- key 长度为 1–256 个 UTF-8 字节。

`env.DB` 仍保留为旧版 D1 键值接口，供已有脚本兼容；新脚本应使用 `env.D1`。

### KV 沙盒

`env.KV` 使用真实 Workers KV，但物理 key 会自动添加用户和任务前缀。脚本无法看到或覆盖其他沙盒的前缀：

```js
await env.KV.put("cached-result", "ready", { expirationTtl: 3600 });
const cached = await env.KV.get("cached-result");
const page = await env.KV.list("cached-", 100);
await env.KV.delete("cached-result");
```

KV 同样只接受最大 100 KB 的 string，单页最多 200 个 key；可选 TTL 为 60 秒到一年。KV 是最终一致存储，不应用于锁、原子计数器或立即跨地域可见的状态，这些数据应使用 `env.D1`。

以上边界避免脚本读取其他用户任务、Better Auth 表、原生 binding 或管理端认证 Secret。因为 `globalOutbound` 为 `null`，脚本中的全局 `fetch()` 和 `connect()` 也会被阻止；需要访问外部接口时使用 URL 类型任务，或后续增加明确的域名 allowlist gateway。

## 验证与部署

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm preview
```

首次发布认证和脚本沙盒版本前，先执行远端迁移、配置生产 Secret，并创建 KV namespace：

```bash
pnpm db:migrate:remote:0004
pnpm db:migrate:remote:0005
pnpm db:migrate:remote:0006
pnpm --filter @opencron/api exec wrangler secret put BETTER_AUTH_SECRET
pnpm --filter @opencron/api exec wrangler kv namespace create SCRIPT_KV
```

把 KV 创建命令返回的 namespace `id` 添加到 `apps/api/wrangler.toml` 的 `SCRIPT_KV` 配置，然后部署：

```bash
pnpm deploy
```

本地开发使用独立的模拟 KV，不需要生产 ID。不要把本地 `.dev.vars` 的值用于生产；`apps/api/wrangler.toml` 已将 `BETTER_AUTH_SECRET` 声明为必需 Secret。

部署域名通过 `APP_URL` 和 `[[routes]]` 配置（见 [部署](./deploy.md)）。`assets.run_worker_first = ["/api/*"]` 保证 API 先进入 Hono，其余导航请求按 SPA 规则返回 `index.html`。
