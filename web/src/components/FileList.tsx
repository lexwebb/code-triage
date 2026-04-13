import type { PullFile, ReviewComment } from "../types";

interface FileListProps {
  files: PullFile[];
  selectedFile: string | null;
  onSelectFile: (filename: string) => void;
  comments: ReviewComment[];
}

export default function FileList({ files, selectedFile, onSelectFile, comments }: FileListProps) {
  const commentsByFile: Record<string, number> = {};
  for (const c of comments) {
    commentsByFile[c.path] = (commentsByFile[c.path] || 0) + 1;
  }

  return (
    <div className="border-b border-gray-800">
      <div className="px-6 py-2 text-xs text-gray-500 uppercase tracking-wide">
        Files changed ({files.length})
      </div>
      <div className="max-h-48 overflow-y-auto">
        {files.map((file) => (
          <button
            key={file.filename}
            onClick={() => onSelectFile(file.filename)}
            className={`w-full text-left px-6 py-1.5 text-sm hover:bg-gray-800/50 flex items-center justify-between ${
              selectedFile === file.filename ? "bg-gray-800/70 text-white" : "text-gray-300"
            }`}
          >
            <span className="font-mono text-xs truncate">{file.filename}</span>
            <span className="flex items-center gap-2 shrink-0 ml-2">
              {(commentsByFile[file.filename] ?? 0) > 0 && (
                <span className="text-xs text-yellow-400">
                  {commentsByFile[file.filename]} 💬
                </span>
              )}
              <span className="text-green-400 text-xs">+{file.additions}</span>
              <span className="text-red-400 text-xs">-{file.deletions}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
