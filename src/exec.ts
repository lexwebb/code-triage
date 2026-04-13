import { execFile as execFileCb } from "child_process";

interface ExecOptions {
  cwd?: string;
  timeout?: number;
  input?: string;
}

export function execAsync(cmd: string, args: string[], options: ExecOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFileCb(cmd, args, {
      encoding: "utf-8",
      timeout: options.timeout ?? 30000,
      cwd: options.cwd,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${stderr?.slice(0, 500) || err.message}`));
      } else {
        resolve(stdout);
      }
    });

    if (options.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

export async function ghAsync<T>(endpoint: string): Promise<T> {
  const result = await execAsync("gh", ["api", endpoint, "--paginate"], { timeout: 30000 });
  return JSON.parse(result) as T;
}

export async function ghGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const payload = JSON.stringify({ query, variables });
  const result = await execAsync("gh", ["api", "graphql", "--input", "-"], {
    timeout: 30000,
    input: payload,
  });
  return JSON.parse(result) as T;
}
