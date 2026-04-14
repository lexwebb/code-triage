# Diff View Upgrade: `react-diff-view`

**Date:** 2026-04-14
**Status:** Draft

## Problem

The current [DiffView.tsx](../../../web/src/components/DiffView.tsx) uses a custom patch parser with `highlight.js` applied per-line via `hljs.highlightElement()`. This breaks multi-line syntax highlighting (strings spanning lines, template literals, JSX blocks) and produces inconsistent coloring. The inline comment widget is a `<tr>` table-row hack, and there is no side-by-side view option.

## Solution

Replace the custom diff rendering with [`react-diff-view`](https://github.com/otakustay/react-diff-view), a mature library (~970 GitHub stars, last published Mar 2026) purpose-built for GitHub-style code review UIs.

## Goals

1. **Fix syntax highlighting** -- cross-line tokenization via refractor (Prism-based AST)
2. **Proper inline comment widgets** -- first-class `widgets` prop replaces table-row hack
3. **Side-by-side view** -- global toggle between unified and split view via `viewType` prop

## Dependencies

**Add:**
- `react-diff-view` -- diff rendering components (`Diff`, `Hunk`, `parseDiff`, `tokenize`, `getChangeKey`)
- `refractor` -- Prism-based syntax tokenizer for cross-line highlighting
- A dark Prism CSS theme (e.g. `prism-one-dark` or equivalent)

**Remove from DiffView.tsx:**
- `highlight.js` import and `hljs.highlightElement()` calls
- `highlight.js/styles/github-dark.min.css` import

**Unchanged:**
- `highlight.js` remains in the project bundle -- `Comment.tsx` uses it via `rehype-highlight` for markdown code blocks

## Data Flow

No changes to backend, API, or existing store fields. The existing `PullFile.patch` (unified diff string from GitHub) feeds directly into `parseDiff()`:

```
file.patch
  → parseDiff(patch, { nearbySequences: "zip" })
  → [{ hunks, oldPath, newPath }]
  → <Diff hunks={hunks} viewType={viewType}>
       {hunks => hunks.map(hunk => <Hunk key={hunk.content} hunk={hunk} />)}
     </Diff>
```

The `nearbySequences: "zip"` option pairs nearby deletions with additions for better split-view line correspondence.

## Component Changes

### DiffView.tsx -- rewrite internals

The component keeps the same default export and integrates with the same store selectors. Internal rendering changes:

**Patch parsing:**
- Remove custom `parsePatch()` function
- Use `parseDiff()` from react-diff-view. Since `file.patch` is a single-file patch without the `diff --git` header, prepend a minimal header before parsing:
  ```ts
  const diffText = `diff --git a/${file.filename} b/${file.filename}\n--- a/${file.filename}\n+++ b/${file.filename}\n${file.patch}`;
  const [parsed] = parseDiff(diffText, { nearbySequences: "zip" });
  ```

**Rendering:**
- Replace `<table>` with `<Diff>` and `<Hunk>` components
- `viewType` prop driven by new store field `diffViewType`

**Syntax highlighting:**
- Use `tokenize()` from react-diff-view with refractor
- Reuse existing `getLanguage()` map to resolve filename → language
- Tokenize hunks and pass result as `tokens` prop to `<Diff>`
- Wrap in `useMemo` keyed on `[hunks, language]`

**Inline comments (widgets):**
- Build a `widgets` object: `Record<string, ReactElement>`
- For each line that has comments or is being commented on, compute the change key via `getChangeKey(change)` and map it to the `<Comment>` / `<InlineCommentBox>` elements
- Pass `widgets` prop to `<Diff>`

**Line click handlers:**
- Use `gutterEvents` prop on `<Hunk>`: `{ onClick: ({change}) => { ... } }`
- The `change` object has `type` (`"insert"`, `"delete"`, `"normal"`), `lineNumber` (for insert), `oldLineNumber`/`newLineNumber` (for normal), providing both line and side
- Map: `type === "delete"` → side `"LEFT"`, otherwise → side `"RIGHT"`; use the appropriate line number field
- Call `setCommentingLine({ line, side })` as before

**Sticky file header:**
- Keep existing sticky header bar
- Add a unified/split toggle button group to the right side

### Remove

- `parsePatch()` function
- `DiffLine` interface
- `hljs` import and `useEffect` that calls `hljs.highlightElement()`
- The manual `<table>` / `<tr>` / `<td>` diff rendering
- `highlight.js/styles/github-dark.min.css` import

### Keep unchanged

- `InlineCommentBox` component (internal logic stays the same; only its mounting point changes from a `<tr>` to a widget)
- `getLanguage()` helper (reused for refractor language detection)

## Store Changes

### PrDetailSlice

Add two fields:

```ts
// in PrDetailSlice interface
diffViewType: "unified" | "split";
setDiffViewType: (type: "unified" | "split") => void;
```

Default: `"unified"` (preserves current behavior).

### No other store changes

All existing fields (`commentingLine`, `commentBody`, `commentSubmitting`, `setCommentingLine`, `setCommentBody`, `submitInlineComment`, `selectedFile`, `files`, `comments`) remain unchanged.

## Styling

### Base styles
Import `react-diff-view/style/index.css` as the base stylesheet.

### Dark theme overrides
Create a CSS file (or add to existing styles) with CSS custom property overrides to match the current dark palette:

```css
.diff-view-dark {
  --diff-background-color: transparent;
  --diff-text-color: #d1d5db;                          /* gray-300 */
  --diff-code-insert-background-color: rgba(34, 197, 94, 0.1);   /* green-500/10 */
  --diff-code-delete-background-color: rgba(239, 68, 68, 0.1);   /* red-500/10 */
  --diff-code-insert-text-color: #86efac;               /* green-300 */
  --diff-code-delete-text-color: #fca5a5;               /* red-300 */
  --diff-gutter-insert-background-color: rgba(34, 197, 94, 0.15);
  --diff-gutter-delete-background-color: rgba(239, 68, 68, 0.15);
  --diff-gutter-color: #6b7280;                          /* gray-500 */
  --diff-hunk-header-background-color: rgba(59, 130, 246, 0.1);  /* blue-500/10 */
  --diff-hunk-header-color: #60a5fa;                     /* blue-400 */
  --diff-selection-background-color: rgba(59, 130, 246, 0.3);
}
```

Wrap the `<Diff>` component in a `<div className="diff-view-dark">`.

### Syntax theme
Import a dark Prism theme CSS file for token colors. Tune if needed to ensure diff background colors don't clash with token colors.

## Toggle UI

A small button group in the sticky file header, right-aligned:

```
┌─────────────────────────────────────────────────────────┐
│ src/components/DiffView.tsx              [Unified][Split]│
└─────────────────────────────────────────────────────────┘
```

Uses existing `Button` component with `variant` toggling for active state. Calls `setDiffViewType()` on click.

## InlineCommentBox Mounting

**Before:** Rendered as an extra `<tr>` after the target line row, keyed by `commentingLine.line + commentingLine.side`.

**After:** Included in the `widgets` object keyed by `getChangeKey(change)` for the target change. react-diff-view renders it below the corresponding line automatically.

The `commentingLine` store state maps to a change key:
- Find the change in the parsed hunks where the line number and side match
- Compute `getChangeKey(change)`
- Add `<InlineCommentBox onCancel={...} />` to the widgets object at that key

## Existing line-level comments

Same approach as InlineCommentBox. For each comment in `fileComments`:
- Find the matching change in the parsed hunks by line number
- Compute `getChangeKey(change)`
- Render `<Comment>` components inside the widget for that key
- If both existing comments and the InlineCommentBox target the same line, combine them in a single widget fragment

## Files Touched

| File | Change |
|------|--------|
| `web/package.json` | Add `react-diff-view`, `refractor` |
| `web/src/components/DiffView.tsx` | Rewrite internals |
| `web/src/store/types.ts` | Add `diffViewType`, `setDiffViewType` |
| `web/src/store/prDetailSlice.ts` | Implement `diffViewType` field and action |
| `web/src/styles/diff-dark.css` (new) | Dark theme CSS custom property overrides |

## What stays the same

- `Comment.tsx` -- untouched
- `FileList.tsx` -- untouched
- `App.tsx` -- untouched
- Backend / API -- untouched
- Store shape for comments, files, selectedFile, commentingLine, commentBody, commentSubmitting -- untouched
- `submitInlineComment` API call -- untouched
