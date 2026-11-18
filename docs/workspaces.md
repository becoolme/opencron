# Workspaces, projects and members

Jobs, secrets and API keys belong to a **workspace**, not to one account. Everyone who is a member of a workspace
sees the same jobs. Inside a workspace, **projects** group jobs: a workspace for a company might have one project per
service.

Every account gets a personal workspace with one project, `Default`, when it signs up. Upgrading an existing
deployment does the same for every account that already exists, and moves its jobs, secrets and API keys there.

## Switching workspaces

The menu at the top of the sidebar lists the workspaces you belong to, switches between them and creates new ones. An
account can own at most 20 workspaces. The app remembers the last workspace per session. If you leave or are
removed from every workspace, you get a new personal one the next time you open the app.

## Roles

| | Owner | Admin | Member |
| --- | --- | --- | --- |
| See jobs, runs and secret names | ✓ | ✓ | ✓ |
| Create, edit, run and delete jobs | ✓ | ✓ | ✓ |
| Create, change and delete secrets | ✓ | ✓ | |
| Create, change, test and delete alert channels | ✓ | ✓ | |
| Create and revoke API keys | ✓ | ✓ | |
| Rename the workspace, manage projects | ✓ | ✓ | |
| Invite people, change roles, remove members | ✓ | ✓ (not owners) | |
| Grant or take away the owner role | ✓ | | |
| Delete the workspace | ✓ | | |

Members can edit script jobs, and a script reads every secret of the workspace as an environment variable. A member
can therefore read secret values by writing a script that prints them. Invite only people you would trust with the
secrets.

A workspace always has at least one owner. The last owner cannot leave or be removed: make someone else owner first,
or delete the workspace. Deleting a workspace deletes its jobs, runs, secrets, alert channels and API keys and cannot be undone.

When someone leaves or is removed, the jobs they created stay in the workspace and their API keys for it are revoked
at once.

## Projects

Owners and admins add, rename and delete projects on the **Settings** page. A workspace has at most 50 projects and
always keeps at least one. A project that still holds jobs cannot be deleted: move or delete its jobs first. Deleting a project deletes the
alert channels limited to it.

The project picker in the sidebar narrows the job list and the runs to one project. When a workspace has more than one
project, the job form asks which project a job goes into; a job can be moved to another project later.

## Inviting people

On the **Members** page, an owner or admin enters an email address and a role (admin or member) and gets a link to
send themselves. No email goes out. The link:

- works for 7 days, or until it is used or withdrawn;
- can be accepted only by an account signed in with that email address;
- is replaced when a new invitation is made for the same address.

A workspace has at most 50 open invitations. The Members page lists them, with a button to copy each link again or to
withdraw it.

Someone without an account opens the link, signs up with the invited address, and lands back on the invitation. With
`SIGNUP = "closed"` (see [deploy.md](deploy.md)), sign-up stays open to any address with an open invitation, so you can
close sign-up and still invite people.

Members pick [alert channels](alerts.md) on their jobs; owners and admins set the channels up.

## API keys and projects

An API key belongs to the workspace it was created in and works only there. When a workspace has several projects, a
key can be limited to some of them: it then sees and changes only the jobs in those projects, and creates jobs only in
them. A key that is not limited works in every project, including ones added later.

A key acts with the role of the person who created it. It stops working when that person leaves the workspace.

## API

Requests from the app or with an API key run in one workspace:

| Header | |
| --- | --- |
| `x-workspace-id` | The workspace for a signed-in session. Without it, the session's current workspace. API keys ignore it and use their own workspace. |
| `x-project-id` | Limits the request to one project of the workspace. Missing or `all` means every project the caller can see. |

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/workspaces` | `{workspaces, current}`: the workspaces of the caller with their role. An API key sees only its own. |
| `POST` | `/api/workspaces` | `{"name": "..."}` creates a workspace with a `Default` project and switches to it. App only. |
| `POST` | `/api/workspaces/:id/activate` | Switch the session to this workspace. App only. |
| `PATCH` | `/api/workspaces/current` | `{"name": "..."}` renames the workspace. Owners and admins. |
| `DELETE` | `/api/workspaces/current` | Deletes the workspace and everything in it. Owners, app only. |
| `GET` | `/api/projects` | `{projects}`: the projects the caller can see. |
| `POST` | `/api/projects` | `{"name": "..."}` adds a project. Owners and admins. |
| `PATCH` | `/api/projects/:id` | `{"name": "..."}` renames a project. Owners and admins. |
| `DELETE` | `/api/projects/:id` | Deletes an empty project. Owners and admins. |
| `GET` | `/api/members` | `{members, role}`: the members and the caller's own role. |
| `PATCH` | `/api/members/:id` | `{"role": "owner" \| "admin" \| "member"}`. Owners and admins, app only. |
| `DELETE` | `/api/members/:id` | Remove a member, or leave with your own member id. App only. |
| `GET` | `/api/invitations` | `{invitations}`: the open invitations, each with its `url`. Owners and admins, app only. |
| `POST` | `/api/invitations` | `{"email": "...", "role": "admin" \| "member"}` returns `{invitation}` with its `url`. Owners and admins, app only. |
| `DELETE` | `/api/invitations/:id` | Withdraw an invitation. Owners and admins, app only. |
| `GET` | `/api/invite/:id` | The invitation as the invitee sees it, with its `state`. App only. |
| `POST` | `/api/invite/:id/accept` | Join the workspace. App only. |

"App only" endpoints need a signed-in session and refuse API keys with `403`.

Jobs carry a `project_id`. When creating a job, send `project_id`, or the `x-project-id` header; a workspace with one
project needs neither. `PATCH /api/jobs/:id` with another `project_id` moves the job.
