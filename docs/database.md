# 数据库配置与脚本表操作

部署时选择一个主数据库：D1（默认）或 PostgreSQL。账号、会话、任务、执行历史、旧版脚本存储和业务表一起使用所选数据库。Workers KV 仍使用 `SCRIPT_KV`，脚本执行仍使用 Cloudflare Dynamic Workers。

切换配置不会复制已有数据。已有 D1 实例切换 PostgreSQL 前，需要单独迁移数据；不要直接对已有业务库应用初始迁移。

## D1

`apps/api/wrangler.toml` 设置 `DB_PROVIDER = "d1"`，通过 `DB` binding 连接。

新环境按 `development.md` 的顺序初始化 0001–0006。已经完成 0001–0005 的环境只运行新增迁移：

```bash
pnpm db:migrate:local:0006
# 生产数据库对应：pnpm db:migrate:remote:0006
pnpm dev
```

生产配置好 `BETTER_AUTH_SECRET`、D1 database id、KV namespace id 后运行 `pnpm deploy`。

## PostgreSQL

`apps/api/wrangler.postgres.toml` 设置 `DB_PROVIDER = "postgres"`，不需要 D1 binding。

1. 创建空 PostgreSQL 数据库。
2. 在 `.dev.vars` 添加 `DATABASE_URL`，保留 `BETTER_AUTH_SECRET`。
3. 将同一连接串通过环境变量传给迁移命令（迁移脚本不读取 `.dev.vars`）：

```bash
DATABASE_URL='postgres://user:password@localhost:5432/opencron' pnpm db:migrate:postgres
pnpm dev:postgres
```

迁移来自 `migrations/postgres/`。脚本使用事务、迁移校验和及 advisory lock，可重复执行；已应用迁移被修改时会拒绝继续。生产环境使用数据库服务商要求的 TLS 配置，例如连接串中的 `sslmode=verify-full`，不关闭证书校验。

部署前为同一 Worker 配置认证 Secret、数据库连接串和 KV namespace id：

```bash
pnpm --filter @opencron/api exec wrangler secret put BETTER_AUTH_SECRET --config wrangler.postgres.toml
pnpm --filter @opencron/api exec wrangler secret put DATABASE_URL --config wrangler.postgres.toml
pnpm deploy:postgres
```

两个部署命令都会先使用对应的 Vite 配置构建，再部署 `dist/opencron/wrangler.json`，包含生成的前端 Assets 配置。

### 使用 Hyperdrive

可以用 `HYPERDRIVE` binding 替代运行时的 `DATABASE_URL`。在 PostgreSQL 配置中取消注释 `[[hyperdrive]]` 并填写真实 id，同时从 `secrets.required` 移除 `DATABASE_URL`。连接选择顺序为 `HYPERDRIVE.connectionString`、`DATABASE_URL`。

为主数据库关闭 Hyperdrive query caching，保证登录失效、调度状态和写后读的实时性。迁移仍使用直连的 `DATABASE_URL`。应用和认证连接在当前请求/调用内使用并关闭，不会把活跃连接跨请求缓存。

## 脚本表操作：env.db

两种数据库使用相同接口。目前内置一张示例业务表 `products`：

| 字段 | 类型 | 默认值 |
| --- | --- | --- |
| id | number，只读 | 数据库自增 |
| name | string，必填 | — |
| price | number | 0 |
| available | boolean | true |

```js
export default {
  async fetch(request, env) {
    const product = await env.db.insert("products", {
      name: "Coffee", price: 20, available: true,
    });

    const rows = await env.db.select("products", {
      where: { available: true }, limit: 100,
    });

    const updated = await env.db.update("products", {
      where: { id: product.id }, set: { price: 25 },
    });

    const result = await env.db.delete("products", {
      where: { id: product.id },
    });

    return Response.json({ product, rows, updated, deleted: result.deleted });
  },
};
```

- `insert(table, data)` 返回新行；`select` 和 `update` 返回行数组；`delete` 返回 `{ deleted }`。
- `where` 支持列相等比较，多个条件按 AND 合并。当前列均非空，不接受 null。
- `select` 默认取 100 行，按 id 升序，`limit` 必须为 1–200 的整数。
- `update`、`delete` 必须提供非空 `where`，`update.set` 也必须非空。
- 只允许有限数值，单个字符串最大 100 KB；未知字段、只读字段写入和未知表都会被拒绝。
- 宿主自动注入当前用户和任务的范围条件；脚本不能设置、查询或修改所有者字段，也不能访问账号、任务等系统表。
- 表名和列名来自宿主 allowlist；所有数据值使用绑定参数。脚本不会拿到连接串、原生数据库 binding、SQL 执行器或建表权限。

### 添加自己的业务表

1. 在 `apps/api/src/script-tables.ts` 的 `scriptTables` 注册公开表名、物理表名和列定义。
2. 分别新增 D1 和 PostgreSQL 迁移，创建对应实体表。必须包含 `owner_user_id`、`job_id`，并建立范围索引；删除用户/任务时通过外键级联删除。
3. 为自增 id、boolean（两种后端实体表均使用 0/1）、默认值和非空约束保持一致语义。
4. 执行目标数据库迁移后部署。只新增 PostgreSQL SQL 或只修改 allowlist 都不足以完成双后端支持。

旧脚本的 `env.D1.get/put/delete/list` 和 `env.DB.get/put/delete/list` 继续工作，也跟随部署所选数据库；`env.KV` 保持原来的隔离存储接口。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm build:postgres
DATABASE_URL='postgres://user:password@localhost:5432/opencron_test' pnpm test:postgres
SMOKE_BASE_URL=http://127.0.0.1:5174 pnpm test:smoke
```

`test:postgres` 验证真实 PostgreSQL 参数绑定、时间戳数字类型及 batch 提交/回滚，要求数据库名以 `_test` 结尾。`test:smoke` 对独立的本地 Wrangler 实例验证注册、登录、任务 API、真实 Dynamic Worker 表 CRUD、旧接口及用户/任务隔离。该测试会创建测试账号和任务，应使用单独的本地测试数据库。
