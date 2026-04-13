import { spawn } from "node:child_process";

export type RunResult =
  | { ok: true; json: any; stdout: string; stderr: string }
  | { ok: false; error: string; stdout: string; stderr: string };

export async function runPythonMonitor(args: {
  pythonPath: string;
  scriptPath: string;
  env: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
}): Promise<RunResult> {
  const timeoutMs = args.timeoutMs ?? 12 * 60 * 1000;

  return await new Promise((resolve) => {
    const child = spawn(args.pythonPath, [args.scriptPath, "--json"], {
      env: { ...process.env, ...args.env },
      cwd: args.cwd,
    });

    let stdout = "";
    let stderr = "";

    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: `timeout after ${timeoutMs}ms`, stdout, stderr });
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("close", (code) => {
      clearTimeout(t);
      if (code !== 0) {
        resolve({ ok: false, error: `exit code ${code}`, stdout, stderr });
        return;
      }
      // monitor.py prints a lot; JSON is at the end when --json is passed.
      // Extract the last JSON object reliably by slicing from the last "\n{" to the end.
      let start = stdout.lastIndexOf("\n{");
      if (start === -1) start = stdout.lastIndexOf("{");
      if (start === -1) {
        resolve({ ok: false, error: "no json found in stdout", stdout, stderr });
        return;
      }
      const jsonText = stdout.slice(start).trim();
      try {
        const parsed = JSON.parse(jsonText);
        resolve({ ok: true, json: parsed, stdout, stderr });
      } catch (e: any) {
        resolve({ ok: false, error: `json parse failed: ${String(e?.message || e)}`, stdout, stderr });
      }
    });
  });
}
