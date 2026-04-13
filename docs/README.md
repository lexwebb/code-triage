# Code Triage documentation

This folder describes how **Code Triage** is put together, what the main features do, and why common design choices were made. For install and day-to-day commands, see the [project README](../README.md).

## Guides

| Document | Contents |
|----------|----------|
| [Architecture](./architecture.md) | Processes, modules, request flow, GitHub and Claude integration |
| [Features and rationale](./features-and-rationale.md) | Product capabilities and the problems they solve |
| [HTTP API](./http-api.md) | REST endpoints the web UI and tools use |
| [Config, state, and worktrees](./config-and-state.md) | `~/.code-triage` files, comment keys, fix jobs, `.cr-worktrees` |
| [Implementation plan](./implementation-plan.md) | Prioritized backlog of enhancements (solo, local-first) |

## Internal design notes

The `superpowers/` subtree holds dated plans and specs from earlier design iterations. The guides above are written to match the **current** code; use `superpowers/` for historical context only.
