/** Build `https://github.com/{owner}/{repo}/pull/{n}` from full name `owner/repo`. */
export function githubPullRequestUrl(repoFull: string, number: number): string | null {
  const idx = repoFull.indexOf("/");
  if (idx <= 0) return null;
  const owner = repoFull.slice(0, idx);
  const repo = repoFull.slice(idx + 1);
  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}
