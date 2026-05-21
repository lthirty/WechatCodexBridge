import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function listCodexThreads(codexHome = path.join(os.homedir(), ".codex")) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const rows = fs.readFileSync(indexPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const latestByName = new Map();
  for (const row of rows) {
    const key = row.thread_name || row.id;
    const previous = latestByName.get(key);
    if (!previous || Date.parse(row.updated_at || 0) >= Date.parse(previous.updated_at || 0)) {
      latestByName.set(key, row);
    }
  }

  return [...latestByName.values()]
    .map((row) => {
      const meta = readSessionMeta(codexHome, row.id);
      return {
        id: row.id,
        alias: row.thread_name || row.id,
        projectName: row.thread_name || row.id,
        threadId: row.id,
        threadName: row.thread_name || row.id,
        cwd: meta?.cwd || codexHome,
        outputDir: meta?.cwd || codexHome,
        updatedAt: row.updated_at || null
      };
    })
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
}

export function findCodexThread(query, codexHome) {
  const normalized = normalize(query);
  const threads = listCodexThreads(codexHome);
  return threads.find((thread) => normalize(thread.threadName) === normalized)
    || threads.find((thread) => normalize(thread.id) === normalized)
    || threads.find((thread) => normalize(thread.threadName).includes(normalized));
}

function readSessionMeta(codexHome, sessionId) {
  const sessionsDir = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessionsDir)) {
    return null;
  }

  const file = findSessionFile(sessionsDir, sessionId);
  if (!file) {
    return null;
  }

  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    const row = JSON.parse(firstLine);
    return row.type === "session_meta" ? row.payload : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function findSessionFile(root, sessionId) {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) {
        return fullPath;
      }
    }
  }
  return null;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}
