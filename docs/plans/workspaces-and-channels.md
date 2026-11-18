# 设计：Workspace、Project 与告警渠道

状态：第一、二步已实现；草案（2026-11-17 已定：member 可编辑脚本任务、邀请用复制链接、`notify_targets` 直接替换、保留 project 层）。参照 OpenUptime 的同名模型，按 OpenCron 的体量裁剪。

## 现状

- 所有数据按 `owner_user_id` 归属到单个用户：`jobs`、`secrets`、`api_keys`、`script_storage`、`script_records`、`script_*` 业务表、KV 前缀。
- 没有组织、成员、邀请、角色，也没有项目分组。`MAX_JOBS_PER_ACCOUNT = 200` 按用户计。
- 告警目标是 `jobs.notify_targets`（JSON 数组，最多 10 个，类型 http / lark / telegram / dingtalk / slack / discord），每个任务各存一份，明文。`maybeNotify` 只在失败时发送，60 秒去重。
- 没有发件能力（无邮件服务）。

## 目标

1. 一个用户可以属于多个 workspace，在其中有 owner / admin / member 角色，可以邀请别人。
2. Workspace 下分 project，任务、渠道按 project 归类；有“全部项目”视图。
3. 告警渠道是独立对象：建一次，多个任务引用；改一处，全部生效。
4. 渠道可设为“默认”（`auto_enable`）：新建任务时自动勾选。
5. 老数据无损迁移，自托管升级不需要手工步骤。

不做：告警升级（escalation）、恢复通知、投递记录、状态页、计费。可以后续单独做。

## 数据模型

### Workspace 与成员

用 Better Auth 的 `organization` 插件，和 OpenUptime 一样，界面上叫 workspace：

- `organization`、`member`（role：`owner` / `admin` / `member`）、`invitation`；
- `session.activeOrganizationId` 记录当前 workspace。

### Project

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (organization_id, name)
);
```

每个 workspace 至少有一个 project（创建 workspace 时自动建 “Default”），最后一个不能删。删除 project 需先清空或移走其中的任务。

### 归属列

| 表 | 新增 | 说明 |
| --- | --- | --- |
| `jobs` | `organization_id`、`project_id` | `owner_user_id` 保留，含义改为“创建者”，永不改变 |
| `secrets` | `organization_id` | workspace 级，`UNIQUE (organization_id, name)` 替换按用户的唯一约束 |
| `api_keys` | `organization_id`、`project_ids`（JSON，空 = 全部项目） | 一个 key 只属于一个 workspace |

脚本存储（`script_storage`、`script_records`、`script_*` 表、KV）**不改**：它们以 `(owner_user_id, job_id)` 为键，`job_id` 全局唯一、`owner_user_id` 是不变的创建者，所以数据始终跟着任务走，移动任务到别的 project 也不丢。

### 告警渠道

```sql
CREATE TABLE alert_channels (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = 整个 workspace 可用
  type TEXT NOT NULL,              -- http | lark | telegram | dingtalk | slack | discord
  name TEXT NOT NULL,
  config TEXT NOT NULL,            -- AES-GCM 密文，和 secrets 同一把密钥
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_enable INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE job_channels (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, channel_id)
);
```

- 用关联表而不是 OpenUptime 的数组列：D1 没有数组类型，关联表在两种数据库上写法一致，删渠道时自动解除引用。
- `config` 里有 webhook 地址、bot token、签名密钥，加密存储；API 只返回打码后的值（如 `https://hooks.slack.com/…/abcd`），编辑时留空表示不改。
- 一个任务能引用的渠道：同 workspace 内 `project_id` 为空，或等于任务所在 project 的渠道。

## 请求作用域

在 `sessionAuthMiddleware` 之后解析：

- **workspace**：API key 取 key 自己的；会话取 `x-workspace-id` 请求头，否则 `activeOrganizationId`，否则用户的第一个 workspace。每次请求都核对当前成员身份（会话可能比成员关系活得久）。
- **project**：`x-project-id` 请求头或 `oc_project` cookie；值为 `all` 时是全部项目视图（只读列表，新建时必须指定 project）。受限 API key 只能访问 `project_ids` 中的项目。
- 所有查询从 `owner_user_id = ?` 改为 `organization_id = ?`（加 project 条件）。调度器不受影响，它本来就按到期时间扫全表。

### 角色权限

| 操作 | owner | admin | member |
| --- | --- | --- | --- |
| 查看任务、运行记录 | ✓ | ✓ | ✓ |
| 新建、编辑、运行、删除任务 | ✓ | ✓ | ✓ |
| 管理渠道、密钥、API key | ✓ | ✓ | — |
| 管理 project、成员与邀请 | ✓ | ✓ | — |
| 删除 workspace、转让 owner | ✓ | — | — |

member 可以新建和编辑脚本任务。脚本能读到注入的密钥，所以“密钥只有 admin 能管”只防误改，防不住读取：密钥页和邀请对话框都写明“成员可通过脚本读取本 workspace 的密钥”，文档同样说明。按任务授权密钥以后需要时再做。

## 默认渠道（auto_enable）

- 新建任务时：API 请求里没有 `channel_ids` 时，自动挂上当前 project 可用、`enabled` 且 `auto_enable` 的渠道；传了 `channel_ids`（包括空数组）就以传入为准。界面上新建表单默认勾好这些渠道。
- 把渠道设为默认只影响之后新建的任务，不回改已有任务；渠道页提供“应用到全部现有任务”按钮，二次确认后批量挂上。
- 禁用渠道（`enabled = 0`）时暂停发送，任务上的引用保留。

## 发送

`maybeNotify` 改为：读取任务关联且 `enabled` 的渠道，解密配置后交给现有的各类型适配器。失败才发、60 秒去重的逻辑不变。新增 `POST /api/channels/:id/test` 发一条测试消息。

## API 与 MCP

- `GET/POST /api/workspaces`，切换走 Better Auth 的 `organization.setActive`。
- `GET/POST/PATCH/DELETE /api/projects`。
- `GET/POST/PATCH/DELETE /api/channels`，`POST /api/channels/:id/test`，`POST /api/channels/:id/apply-to-all`。
- 成员与邀请走自建端点：`/api/workspaces`、`/api/members`、`/api/invitations`、`/api/invite/:id`（实现时决定，未挂载 Better Auth organization 插件；表结构沿用它的 `organization`、`member`、`invitation`）。
- 任务：新增 `project_id`、`channel_ids`；**`notify_targets` 直接移除**，不做兼容。请求里带 `notify_targets` 时返回 400，错误信息指向 `channel_ids` 和 `/api/channels`，避免客户端以为设置成功却收不到告警。返回体里不再有该字段。
- MCP：新增 `list_workspaces`、`list_projects`、`list_channels`；任务工具支持 `workspace` / `project` 选择，`notify_targets` 参数换成 `channel_ids`。
- 这是破坏性变更：changelog 的 `upgrade` 写明 API/MCP 客户端要改用 `channel_ids`，文档给出前后对照示例。

## 界面

- 顶栏：workspace 切换器（含“新建 workspace”）和 project 切换器（含“全部项目”）。
- 新页面 **告警渠道**：列表、新建/编辑（复用现有 `NotifyEditor` 的表单字段）、测试发送、启用开关、“默认”开关、应用到全部任务。
- 新页面 **成员**：成员与角色、邀请。没有邮件服务，邀请生成链接，由邀请人复制发出；`SIGNUP=closed` 时，持有效邀请的邮箱仍可注册。
- 设置里管理 project。
- 任务编辑：通知部分改为勾选渠道，旁边“新建渠道”就地创建。
- 四种语言的文案全部补齐。

## 数据迁移

一个 SQL 迁移（D1 与 Postgres 各一份），可重复执行、不需要手工步骤：

1. 为每个用户建个人 workspace：`id = 'ws_' || user.id`，名称 “{name} 的 workspace”，该用户为 owner；建 `Default` project：`id = 'pj_' || user.id`。
2. 回填 `jobs`、`secrets`、`api_keys` 的 `organization_id` / `project_id`；`owner_user_id` 为空的旧任务归第一个用户（和现有 `after` hook 的规则一致）。
3. 已有会话的 `activeOrganizationId` 设为本人的个人 workspace。

渠道迁移需要加密，SQL 做不了，放在启动时执行一次的 JS 步骤里（Worker 的第一次调度 tick 和 Node 启动时都会跑，用标记行保证只执行一次）：

4. 按 workspace 把所有任务的 `notify_targets` 展开，配置完全相同的合并为一个渠道，命名为“{类型} {序号}”；写 `job_channels`；`auto_enable` 全部为 0，保持现有行为。
5. 迁移完成后清空 `notify_targets`。代码从此不再读写这一列；物理删列放到下一个 schema 迁移，确保 JS 步骤已在所有实例上跑过。

## 分步交付

每一步一个 PR，schema PR 一次只合并一个：

1. **Workspace 与 project**：organization 插件、`projects` 表、归属列与回填、作用域中间件、所有查询改造、切换器、成员与邀请、project 管理、MCP 的 workspace/project 选择。changelog 写明升级会自动把每个账号转成个人 workspace。
2. **告警渠道**：`alert_channels`、`job_channels`、加密配置、渠道 API 与页面、默认渠道、`notify_targets` 迁移并从 API/MCP 移除、发送改造、MCP 渠道工具。
3. **Cloud（cloud 分支）**：任务上限从按账号改为按 workspace，按套餐区分。

两步都要：测试（权限矩阵、跨 workspace 隔离、API key 项目范围、迁移的幂等性、默认渠道选择规则、打码与“留空不改”）、`docs/workspaces.md` 和 `docs/alerts.md`、changelog 中英文、四种语言文案。

## 已定

1. member 可以编辑脚本任务，并在界面和文档中说明成员能通过脚本读到密钥。
2. 邀请用复制链接，不接邮件服务；Cloud 版以后需要再接。
3. `notify_targets` 直接替换为 `channel_ids`，旧字段返回 400，按破坏性变更写进 changelog。
4. 保留 project 层，和 OpenUptime 一致。
