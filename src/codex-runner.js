import { spawn } from "node:child_process";

export class CodexRunner {
  constructor(config) {
    this.config = config;
    this.queues = new Map();
  }

  enqueue(target, message) {
    const previous = this.queues.get(target.id) || Promise.resolve();
    const current = previous.then(() => this.run(target, message));
    this.queues.set(target.id, current.catch(() => undefined));
    return current;
  }

  async run(target, message) {
    if (this.config.dryRun || this.config.codex?.mode === "dry-run") {
      return [
        `[${target.alias}] dry-run`,
        `cwd: ${target.cwd}`,
        `thread: ${target.threadId || "(new)"}`,
        `message: ${message}`
      ].join("\n");
    }

    const command = this.config.codex.command || "codex";
    const args = (this.config.codex.args || []).map((arg) => {
      return String(arg)
        .replaceAll("{cwd}", target.cwd)
        .replaceAll("{threadId}", target.threadId || "")
        .replaceAll("{message}", message);
    });
    return runProcess(command, args, target.cwd);
  }
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`codex exited with ${code}\n${stderr}`));
        return;
      }
      resolve(stdout.trim() || stderr.trim() || "(no output)");
    });
  });
}
