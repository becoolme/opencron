# Contributing

Thanks for helping. Bug reports, fixes and docs are all welcome.

## Setup

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # set BETTER_AUTH_SECRET
pnpm db:init:local                                 # then db:migrate:local:0002 … 0006
pnpm dev                                           # http://localhost:5173
```

You need Node 22+ and pnpm. See [docs/development.md](docs/development.md).

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:docker   # when you change the Docker deployment; needs Docker
```

- Keep changes focused; one concern per pull request.
- Add or update tests for the code you change.
- Follow the rules in [AGENTS.md](AGENTS.md), in particular for the packages shared with OpenUptime.
- Open an issue first for anything large, so we can agree on the approach.

## Security

Do not file vulnerabilities as public issues; use "Report a vulnerability" on the repository's Security tab.

## License

By contributing you agree that your contribution is released under the [MIT license](LICENSE).
