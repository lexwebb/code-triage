# Comment Threads + Markdown Rendering Design Spec

## Overview

Two enhancements to the WebUI:
1. A comment threads panel above the file list that groups review comments into threaded conversations
2. GitHub-flavored markdown rendering for all comment bodies

## Comment Threads Panel (`web/src/components/CommentThreads.tsx`)

A new component placed between `PRDetail` and `FileList` in the main layout.

**Thread grouping logic:**
- Comments with `inReplyToId === null` are thread roots
- Comments whose `inReplyToId` matches a root comment's `id` are replies in that thread
- Threads are displayed in chronological order by the root comment's `createdAt`
- Within each thread, comments are ordered chronologically

**Thread display:**
- Each thread has a header showing the file path and line number (e.g., `src/auth.ts:15`)
- Clicking the file path selects that file in the FileList and scrolls to the diff view
- All comments in the thread are rendered below the header with author info and markdown body
- The section has a header "Review Threads (N)" and is collapsible (default expanded)

## Markdown Rendering

Replace plain text comment rendering with GitHub-flavored markdown.

**Dependencies to add to `web/package.json`:**
- `react-markdown` — renders markdown as React components
- `remark-gfm` — GitHub-flavored markdown plugin (tables, strikethrough, task lists, autolinks)
- `rehype-highlight` — syntax highlighting for fenced code blocks using highlight.js (already installed)

**Changes to `Comment.tsx`:**
- Replace `<div className="...whitespace-pre-wrap...">{comment.body}</div>` with `<ReactMarkdown>` component
- Configure with `remark-gfm` plugin and `rehype-highlight` plugin
- Style markdown elements with Tailwind classes via the `components` prop (prose-like styling for dark theme)

**Markdown features supported:**
- Fenced code blocks with syntax highlighting
- Inline code
- Tables
- Task lists (checkboxes)
- Strikethrough
- Links (open in new tab)
- Images
- Blockquotes
- Headers, bold, italic, lists

## Layout

```
PRDetail (header)
├── CommentThreads (new — collapsible, between header and file list)
│   ├── Thread 1: src/auth.ts:15
│   │   ├── Comment (root) — markdown rendered
│   │   └── Comment (reply) — markdown rendered
│   └── Thread 2: src/middleware.ts:42
│       └── Comment (root) — markdown rendered
├── FileList
└── DiffView (with inline comments also now markdown-rendered)
```

## Files Changed

- Create: `web/src/components/CommentThreads.tsx`
- Modify: `web/src/components/Comment.tsx` (add markdown rendering)
- Modify: `web/src/App.tsx` (add CommentThreads between PRDetail and FileList)
- Modify: `web/package.json` (add react-markdown, remark-gfm, rehype-highlight)

## Non-Goals

- No collapsing individual threads (just the whole section)
- No "resolve" or "reply" actions from the threads panel
- No filtering threads by status
