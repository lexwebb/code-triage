# Open in IDE — Design Spec

## Problem

When reviewing PR comments in Code Triage, users see a file path and line number but have no quick way to jump to that location in their local editor. They must manually navigate to the file. Adding an "Open in IDE" button next to the existing GitHub link removes this friction.

## Design

### IDE preference in settings

Add a `preferredEditor` field to config (`~/.code-triage/config.json`). Default: `"vscode"`.

Supported editors and their URI schemes:

| Key | Label | URI format |
|-----|-------|-----------|
| `vscode` | VS Code | `vscode://file/{abs_path}:{line}` |
| `cursor` | Cursor | `cursor://file/{abs_path}:{line}` |
| `webstorm` | WebStorm | `jetbrains://webstorm/navigate/reference?path={abs_path}&line={line}` |
| `idea` | IntelliJ IDEA | `jetbrains://idea/navigate/reference?path={abs_path}&line={line}` |
| `zed` | Zed | `zed://file/{abs_path}:{line}` |
| `sublime` | Sublime Text | `subl://open?url=file://{abs_path}&line={line}` |

### Thread header button

A small link (styled like the existing "GH" link) appears next to it in the thread header row. Label: the short editor name (e.g. "VS Code", "Cursor"). Clicking it opens the URI scheme link — the OS routes it to the installed IDE, which opens the file at the correct line.

Hidden when:
- No `localPath` is found for the repo (not cloned locally)

### Data flow

1. `App.tsx` looks up `localPath` from the `repos` array using `selectedPR.repo`
2. Passes `repoLocalPath` prop to `CommentThreads`
3. `CommentThreads` passes it to `ThreadItem`
4. `ThreadItem` constructs the URI from `repoLocalPath + "/" + comment.path` and `comment.line`, using the user's `preferredEditor` setting
5. The editor preference comes from the config API response, which `App.tsx` already fetches

### Settings UI

Add an "Editor" dropdown to `SettingsView.tsx` in the general settings section. Lists all supported editors. Persists via the existing `POST /api/config` endpoint.

## Files to change

1. **`src/config.ts`** — add `preferredEditor` to config type and defaults
2. **`src/api.ts`** — expose `preferredEditor` in `AppConfigPayload` response
3. **`web/src/api.ts`** — add `preferredEditor` to `AppConfigPayload` interface
4. **`web/src/components/CommentThreads.tsx`** — add IDE link to thread header, accept `repoLocalPath` and `preferredEditor` props
5. **`web/src/components/SettingsView.tsx`** — add editor dropdown
6. **`web/src/App.tsx`** — look up `localPath` from repos, pass to `CommentThreads`

## Out of scope

- IDE detection (unreliable from browser)
- Multiple simultaneous editors
- Neovim/terminal editors (no standard URI scheme)
