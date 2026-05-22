import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

    if (this.config.codex?.mode === "resume") {
      const command = this.config.codex.command || "codex";
      const outputFile = path.join(os.tmpdir(), `wcb-codex-last-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
      const args = [
        "exec",
        "resume",
        target.threadId,
        message,
        "--all",
        "--skip-git-repo-check",
        "--json",
        "--output-last-message",
        outputFile
      ];
      const output = await runProcess(command, args, target.cwd, { outputFile });
      return readTextFile(outputFile) || extractCodexLastMessage(output) || output;
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

function extractCodexLastMessage(output) {
  let lastMessage = "";
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      const message = extractMessageFromEvent(event);
      if (message) {
        lastMessage = message;
      }
    } catch {
      continue;
    }
  }
  return lastMessage.trim();
}

function extractMessageFromEvent(event) {
  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    return event.item.text || "";
  }
  if (event.type === "event_msg" && event.payload?.type === "agent_message") {
    return event.payload.message || "";
  }
  if (event.type === "response_item" && event.payload?.type === "message") {
    return (event.payload.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text)
      .join("\n");
  }
  return "";
}

function runProcess(command, args, cwd, options = {}) {
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
      const fileOutput = readTextFile(options.outputFile);
      if (code !== 0) {
        const parsed = extractCodexLastMessage(stdout);
        if (fileOutput || parsed) {
          resolve(fileOutput || parsed);
          return;
        }
        reject(new Error(`codex exited with ${code}\n${summarizeCodexError(stderr)}`));
        return;
      }
      resolve(fileOutput || stdout.trim() || stderr.trim() || "(no output)");
    });
  });
}

function readTextFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return "";
  }
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function summarizeCodexError(stderr) {
  const text = String(stderr || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) {
    return "(no stderr)";
  }
  const important = [
    /remote plugin sync request .*? failed with status \d+ [A-Za-z]+/i,
    /Auth required.*?(?= \d{4}-\d{2}-\d{2}|$)/i,
    /Missing or invalid access token/i,
    /unknown feature key in config: [^\s]+/i
  ];
  for (const pattern of important) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return text.slice(0, 800);
}
