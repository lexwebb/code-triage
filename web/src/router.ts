// Simple history-based router that syncs app state with the URL.
// URL format: /:owner/:repo/pull/:number?file=path/to/file
// Root / = all repos, no PR selected
// /:owner/:repo = filter to repo, no PR selected

export interface RouteState {
  repo: string | null;
  prNumber: number | null;
  file: string | null;
  ticketId: string | null;
}

export function parseRoute(url: string = window.location.pathname + window.location.search): RouteState {
  const [pathname, search] = url.split("?");
  const params = new URLSearchParams(search ?? "");
  const segments = pathname.split("/").filter(Boolean);

  let repo: string | null = null;
  let prNumber: number | null = null;
  const file = params.get("file");

  if (segments.length >= 2) {
    repo = `${segments[0]}/${segments[1]}`;
  }

  if (segments.length >= 4 && segments[2] === "pull") {
    const num = parseInt(segments[3], 10);
    if (!isNaN(num)) prNumber = num;
  }

  let ticketId: string | null = null;
  if (segments.length >= 2 && segments[0] === "tickets") {
    ticketId = decodeURIComponent(segments[1]!);
  }

  return { repo, prNumber, file, ticketId };
}

export function buildPath(state: RouteState): string {
  if (state.ticketId) {
    return `/tickets/${encodeURIComponent(state.ticketId)}`;
  }

  let path = "/";

  if (state.repo) {
    path = `/${state.repo}`;
    if (state.prNumber !== null) {
      path += `/pull/${state.prNumber}`;
    }
  }

  if (state.file) {
    path += `?file=${encodeURIComponent(state.file)}`;
  }

  return path;
}

export function pushRoute(state: RouteState): void {
  const path = buildPath(state);
  if (path !== window.location.pathname + window.location.search) {
    window.history.pushState(state, "", path);
  }
}

export function replaceRoute(state: RouteState): void {
  const path = buildPath(state);
  window.history.replaceState(state, "", path);
}
