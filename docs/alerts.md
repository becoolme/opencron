# Alert channels

When a run fails, scheduled or started by hand, OpenCron sends an alert to the **alert channels** of its job. A channel
is a destination saved once in a workspace: a webhook, a Slack or Discord incoming webhook, a Lark or DingTalk bot, or
a Telegram bot. Each job picks the channels it reports to.

## Channels

Owners and admins add, change, test and delete channels on the **Alert channels** page. Members see the list and pick
channels on their jobs. A workspace has at most 50 channels; a job uses at most 20.

| Type | Settings |
| --- | --- |
| `http` | `url` (`http://` or `https://`), optional `headers`. The alert is a JSON `POST`. |
| `slack`, `discord` | `url`: the incoming webhook URL (`https://`). |
| `lark`, `dingtalk` | `url`: the bot webhook URL (`https://`), optional `sign_secret` when the bot signs requests. |
| `telegram` | `bot_token`, `chat_id`. |

A channel belongs to the whole workspace, or to one project. A project's channel can be used only by that project's
jobs. Limiting a channel to a project takes it off the jobs of the other projects. Deleting a project deletes its
channels.

A channel that is turned off keeps its jobs but sends nothing until it is turned on again. **Test** sends a sample
alert, so you can check a channel without waiting for a job to fail. **Add to all jobs** adds the channel to every job
that can use it, skipping jobs that already have 20 channels.

## Default channels

A channel marked **Add to new jobs by default** is ticked on every new job, in the app and through the API when a job
is created without `channel_ids`. You can untick it on the job. Changing the default later does not change existing
jobs; use **Add to all jobs** for that.

## Secrets in settings

Channel settings hold webhook URLs and tokens. They are stored encrypted with `BETTER_AUTH_SECRET` and are never
returned in full: URLs are cut to their origin and the last four characters, header values and signing secrets show as
`***`, and a bot token shows its last four characters. The chat id is shown as it is.

When you change a channel, a field left empty or sent back as it was shown keeps the saved value. Send
`"sign_secret": null` to stop signing. If `BETTER_AUTH_SECRET` changes, saved settings can no longer be read and have to
be entered again.

## API

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/channels` | `{channels, types}`: the channels the caller can see, with masked `config` and `job_count`. |
| `GET` | `/api/channels/:id` | `{channel}`. |
| `POST` | `/api/channels` | `{"type", "name", "config", "project_id"?, "enabled"?, "auto_enable"?}` creates a channel. Owners and admins. |
| `PATCH` | `/api/channels/:id` | Changes `name`, `config`, `project_id`, `enabled` or `auto_enable`. The type cannot change. Owners and admins. |
| `DELETE` | `/api/channels/:id` | Deletes the channel and takes it off its jobs. Owners and admins. |
| `POST` | `/api/channels/:id/test` | Sends a sample alert; returns `{ok, error}`. Owners and admins. |
| `POST` | `/api/channels/:id/apply-to-all` | Adds the channel to every job that can use it; returns `{added}`. Owners and admins. |

`project_id` is `null` for a workspace-wide channel. An API key limited to some projects can only create and change
channels of those projects.

Jobs carry `channel_ids`. Sending it replaces the job's list; `[]` turns alerts off; leaving it out on create uses the
default channels, and on update keeps the list.

### From `notify_targets`

Jobs used to carry their alert targets inline in `notify_targets`. That field is gone: a request that sends it gets
`400`. Create the channel once and send its id instead:

```bash
# before
curl -X POST https://cron.example.com/api/jobs -H "Authorization: Bearer oc_..." -H "content-type: application/json" \
  -d '{"name": "Ping", "cron": "*/5 * * * *", "url": "https://example.com/health",
       "notify_targets": [{"type": "slack", "url": "https://hooks.slack.com/services/..."}]}'

# after
curl -X POST https://cron.example.com/api/channels -H "Authorization: Bearer oc_..." -H "content-type: application/json" \
  -d '{"type": "slack", "name": "Ops", "config": {"url": "https://hooks.slack.com/services/..."}}'
# → {"channel": {"id": "ch_...", ...}}
curl -X POST https://cron.example.com/api/jobs -H "Authorization: Bearer oc_..." -H "content-type: application/json" \
  -d '{"name": "Ping", "cron": "*/5 * * * *", "url": "https://example.com/health", "channel_ids": ["ch_..."]}'
```

The MCP server has `list_channels`, and its job tools take `channel_ids`.

## Upgrading

Run migration `0011` (D1) or `pnpm db:migrate:postgres` (PostgreSQL, migration `0007`). On the first scheduler tick
afterwards, the targets saved on existing jobs move into channels: identical targets in a workspace become one channel,
named after its type, for the whole workspace and not a default. The jobs keep alerting where they did. Rename the new
channels on the Alert channels page.
