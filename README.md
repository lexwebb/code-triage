# cr-watch

Monitor CodeRabbit review comments on your open PRs and action them with Claude Code.

## Install

```bash
# From source
git clone <repo-url> && cd cr-watch
yarn install && yarn build
npm link  # makes `cr-watch` available globally
```

## Usage

```bash
cr-watch              # Start watching (polls every 5 min)
cr-watch --dry-run    # Preview without making changes
cr-watch --status     # Show current state
cr-watch --cleanup    # Remove all worktrees
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--interval <min>` | `5` | Polling interval in minutes |
| `--repo <owner/repo>` | auto-detect | Override repository |
| `--cleanup` | - | Remove worktrees and exit |
| `--dry-run` | - | Preview mode |
| `--status` | - | Show state and exit |

## How it works

1. Polls GitHub for CodeRabbit comments on your open PRs
2. For each new comment, Claude evaluates whether a code change is needed
3. **No code change**: Claude auto-replies on GitHub
4. **Already resolved**: Claude replies and resolves the thread
5. **Code change needed**: Prompts you, then applies fix in an isolated git worktree
6. You review the diff and confirm before pushing

## Requirements

- `gh` CLI (authenticated)
- `claude` CLI
- macOS (for notifications)
- Node.js 18+

## State

Comment state is stored at `~/.cr-watch/state.json`. Worktrees are created under `.cr-worktrees/` in the repo root.
