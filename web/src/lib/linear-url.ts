/**
 * Browser URL for a Linear issue.
 * Prefer the URL from the API (`providerUrl`); otherwise `https://linear.app/issue/{identifier}`
 * (Linear redirects to the workspace URL when logged in).
 */
export function linearIssueBrowserUrl(args: {
  providerUrl?: string | null | undefined;
  identifier: string;
}): string | null {
  const direct = args.providerUrl?.trim();
  if (direct) return direct;
  const id = args.identifier.trim();
  if (!id) return null;
  return `https://linear.app/issue/${encodeURIComponent(id)}`;
}
