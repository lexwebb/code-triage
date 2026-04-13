import { useEffect, useRef } from "react";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.min.css";
import type { ReviewComment } from "../types";
import Comment from "./Comment";

interface DiffViewProps {
  patch: string;
  filename: string;
  comments: ReviewComment[];
}

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  oldLine: number | null;
  newLine: number | null;
}

function parsePatch(patch: string): DiffLine[] {
  const lines = patch.split("\n");
  const result: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      result.push({ type: "header", content: line, oldLine: null, newLine: null });
    } else if (line.startsWith("+")) {
      result.push({ type: "add", content: line.slice(1), oldLine: null, newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      result.push({ type: "remove", content: line.slice(1), oldLine, newLine: null });
      oldLine++;
    } else {
      result.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
      oldLine++;
      newLine++;
    }
  }

  return result;
}

function getLanguage(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    css: "css", html: "html", json: "json", yaml: "yaml", yml: "yaml",
    md: "markdown", sh: "bash", sql: "sql", swift: "swift", kt: "kotlin",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
  };
  return ext ? map[ext] : undefined;
}

export default function DiffView({ patch, filename, comments }: DiffViewProps) {
  const codeRef = useRef<HTMLTableElement>(null);
  const diffLines = parsePatch(patch);
  const language = getLanguage(filename);

  const commentsByLine: Record<number, ReviewComment[]> = {};
  for (const c of comments) {
    if (!commentsByLine[c.line]) commentsByLine[c.line] = [];
    commentsByLine[c.line].push(c);
  }

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.querySelectorAll("code[data-highlight]").forEach((el) => {
        hljs.highlightElement(el as HTMLElement);
      });
    }
  }, [patch, filename]);

  if (!patch) {
    return <div className="text-gray-500 text-sm p-4">No diff available for this file.</div>;
  }

  return (
    <div className="font-mono text-xs">
      <div className="sticky top-0 bg-gray-900 border-b border-gray-800 px-4 py-2 text-sm text-gray-300">
        {filename}
      </div>
      <table ref={codeRef} className="w-full border-collapse">
        <tbody>
          {diffLines.map((line, i) => {
            if (line.type === "header") {
              return (
                <tr key={i} className="bg-blue-500/10">
                  <td colSpan={3} className="px-4 py-1 text-blue-400 select-none">
                    {line.content}
                  </td>
                </tr>
              );
            }

            const bgClass =
              line.type === "add"
                ? "bg-green-500/10"
                : line.type === "remove"
                  ? "bg-red-500/10"
                  : "";

            const textClass =
              line.type === "add"
                ? "text-green-300"
                : line.type === "remove"
                  ? "text-red-300"
                  : "text-gray-300";

            const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

            const lineNum = line.newLine ?? line.oldLine ?? 0;
            const lineComments = lineNum ? commentsByLine[lineNum] || [] : [];

            return (
              <tr key={i} className={bgClass}>
                <td className="w-12 text-right pr-2 text-gray-600 select-none align-top">
                  {line.oldLine ?? ""}
                </td>
                <td className="w-12 text-right pr-2 text-gray-600 select-none align-top">
                  {line.newLine ?? ""}
                </td>
                <td className={`pl-4 pr-4 whitespace-pre ${textClass}`}>
                  <span className="select-none text-gray-600 mr-2">{prefix}</span>
                  <code data-highlight className={language ? `language-${language}` : ""}>
                    {line.content}
                  </code>
                  {lineComments.map((comment) => (
                    <Comment key={comment.id} comment={comment} />
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
