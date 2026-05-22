import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

export function listCodexThreads(codexHome = path.join(os.homedir(), ".codex")) {
  const sidebar = readCodexSidebarState(codexHome);
  const sessionRows = readSessionIndexRows(codexHome);
  const sessionIds = new Set(sessionRows.map((row) => row.id).filter(Boolean));
  const stateRows = readStateThreads(codexHome)
    .filter((row) => row.id && !sessionIds.has(row.id));

  const latestByKey = new Map();
  for (const row of [...sessionRows, ...stateRows]) {
    const meta = row.cwd ? null : readSessionMeta(codexHome, row.id);
    const cwd = cleanPath(row.cwd || meta?.cwd || sidebar.threadWorkspaceRootHints.get(row.id) || codexHome);
    const project = resolveProject(cwd, row.id, sidebar);
    const updatedAtMs = row.updatedAtMs || timestampMs(row.updated_at);
    const threadName = cleanDisplayText(row.thread_name || row.title || row.id);
    const thread = {
      id: row.id,
      alias: threadName,
      projectKey: project.key,
      projectName: project.name,
      projectPath: project.path,
      projectPinned: project.pinned,
      projectOrder: project.order,
      projectless: project.projectless,
      threadId: row.id,
      threadName,
      threadPinned: sidebar.pinnedThreadIds.has(row.id),
      cwd,
      outputDir: cwd,
      updatedAt: row.updated_at || isoFromMs(updatedAtMs),
      updatedAtMs
    };
    const key = [
      normalizePath(thread.cwd),
      normalize(thread.threadName),
      thread.id
    ].join("\0");
    const previous = latestByKey.get(key);
    if (!previous || thread.updatedAtMs >= previous.updatedAtMs) {
      latestByKey.set(key, thread);
    }
  }

  return [...latestByKey.values()]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

export function listCodexProjects(codexHome = path.join(os.homedir(), ".codex")) {
  const sidebar = readCodexSidebarState(codexHome);
  const stateProjectPaths = readStateThreads(codexHome)
    .map((row) => cleanPath(row.cwd))
    .filter(Boolean);
  const projectPaths = mergeProjectPaths([
    ...sidebar.projectOrder,
    ...sidebar.configProjectPaths,
    ...stateProjectPaths
  ]);
  return projectPaths
    .filter((projectPath) => !isDriveRoot(normalizePath(projectPath)))
    .map((projectPath) => {
      const normalizedProject = normalizePath(projectPath);
      return {
        key: normalizedProject,
        name: displayProjectName(projectPath),
        path: projectPath,
        pinned: sidebar.pinnedProjectIds.has(normalizedProject),
        order: sidebar.projectOrderMap.get(normalizedProject) ?? Number.MAX_SAFE_INTEGER
      };
    });
}

export function findCodexThread(query, codexHome) {
  const normalized = normalize(query);
  const threads = listCodexThreads(codexHome);
  const scoped = findScopedThread(threads, query);
  if (scoped) {
    return scoped;
  }
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

function readSessionIndexRows(codexHome) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  return fs.readFileSync(indexPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line);
        return [{
          id: row.id,
          thread_name: row.thread_name || row.id,
          updated_at: row.updated_at || null,
          updatedAtMs: timestampMs(row.updated_at)
        }];
      } catch {
        return [];
      }
    });
}

function readStateThreads(codexHome) {
  if (!DatabaseSync) {
    return [];
  }
  const dbPath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(dbPath)) {
    return [];
  }

  let db = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`
      SELECT
        id,
        cwd,
        title,
        preview,
        first_user_message,
        updated_at,
        updated_at_ms,
        created_at,
        created_at_ms
      FROM threads
      WHERE COALESCE(archived, 0) = 0
    `).all();
    return rows.map((row) => {
      const updatedAtMs = Number(row.updated_at_ms)
        || secondsToMs(row.updated_at)
        || Number(row.created_at_ms)
        || secondsToMs(row.created_at)
        || 0;
      return {
        id: row.id,
        cwd: cleanPath(row.cwd),
        thread_name: cleanDisplayText(row.title || row.preview || row.first_user_message || row.id),
        updated_at: isoFromMs(updatedAtMs),
        updatedAtMs
      };
    });
  } catch {
    return [];
  } finally {
    if (db) {
      db.close();
    }
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

function readCodexSidebarState(codexHome) {
  const statePath = path.join(codexHome, ".codex-global-state.json");
  const configProjectPaths = readConfigProjectPaths(codexHome);
  const empty = {
    pinnedProjectIds: new Set(),
    pinnedThreadIds: new Set(),
    projectlessThreadIds: new Set(),
    projectOrder: [],
    projectOrderMap: new Map(),
    configProjectPaths,
    allProjectPaths: configProjectPaths,
    threadWorkspaceRootHints: new Map()
  };
  if (!fs.existsSync(statePath)) {
    return empty;
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const projectOrder = Array.isArray(state["project-order"]) ? state["project-order"] : [];
    const allProjectPaths = mergeProjectPaths([...projectOrder, ...configProjectPaths]);
    return {
      pinnedProjectIds: new Set((state["pinned-project-ids"] || []).map(normalizePath)),
      pinnedThreadIds: new Set(state["pinned-thread-ids"] || []),
      projectlessThreadIds: new Set(state["projectless-thread-ids"] || []),
      projectOrder,
      projectOrderMap: new Map(projectOrder.map((item, index) => [normalizePath(item), index])),
      configProjectPaths,
      allProjectPaths,
      threadWorkspaceRootHints: new Map(Object.entries(state["thread-workspace-root-hints"] || {}))
    };
  } catch {
    return empty;
  }
}

function readConfigProjectPaths(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) {
    return [];
  }
  const text = fs.readFileSync(configPath, "utf8");
  const paths = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\[projects\.(?:"((?:\\.|[^"])*)"|'([^']*)')\]\s*$/);
    if (!match) {
      continue;
    }
    const projectPath = match[1]
      ? match[1].replace(/\\\\/g, "\\").replace(/\\"/g, "\"")
      : match[2];
    paths.push(cleanPath(projectPath));
  }
  return mergeProjectPaths(paths);
}

function resolveProject(cwd, threadId, sidebar) {
  if (sidebar.projectlessThreadIds.has(threadId)) {
    return {
      key: "__projectless__",
      name: "快速对话",
      path: null,
      pinned: false,
      order: -1,
      projectless: true
    };
  }

  const normalizedCwd = normalizePath(cwd);
  const projectPath = sidebar.allProjectPaths
    .filter((candidate) => {
      const normalized = normalizePath(candidate);
      if (isDriveRoot(normalized)) {
        return false;
      }
      return normalizedCwd === normalized || normalizedCwd.startsWith(`${normalized}\\`);
    })
    .sort((a, b) => normalizePath(b).length - normalizePath(a).length)[0] || cwd;
  const normalizedProject = normalizePath(projectPath);

  return {
    key: normalizedProject,
    name: displayProjectName(projectPath),
    path: projectPath,
    pinned: sidebar.pinnedProjectIds.has(normalizedProject),
    order: sidebar.projectOrderMap.get(normalizedProject) ?? Number.MAX_SAFE_INTEGER,
    projectless: false
  };
}

function cleanPath(value) {
  return String(value || "")
    .trim()
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+/g, "\\")
    .replace(/\\$/, "");
}

function cleanDisplayText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function displayProjectName(projectPath) {
  const trimmed = String(projectPath || "").replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed || "未命名项目";
}

function findScopedThread(threads, query) {
  const parts = String(query || "").split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const threadQuery = normalize(parts.at(-1));
  const projectQuery = normalize(parts.slice(0, -1).join("/"));
  return threads.find((thread) => {
    const projectMatches = normalize(thread.projectName) === projectQuery
      || normalize(thread.projectPath).endsWith(projectQuery)
      || normalize(thread.projectName).includes(projectQuery);
    return projectMatches && normalize(thread.threadName) === threadQuery;
  }) || threads.find((thread) => {
    const projectMatches = normalize(thread.projectName).includes(projectQuery)
      || normalize(thread.projectPath).includes(projectQuery);
    return projectMatches && normalize(thread.threadName).includes(threadQuery);
  });
}

function normalize(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:\.{3}|…)$/, "")
    .toLowerCase();
}

function normalizePath(value) {
  return cleanPath(value)
    .toLowerCase();
}

function isDriveRoot(normalizedPath) {
  return /^[a-z]:$/.test(normalizedPath);
}

function mergeProjectPaths(paths) {
  const result = new Map();
  for (const rawPath of paths) {
    const projectPath = cleanPath(rawPath);
    const key = normalizePath(projectPath);
    if (!projectPath || isDriveRoot(key) || result.has(key)) {
      continue;
    }
    result.set(key, projectPath);
  }
  return [...result.values()];
}

function timestampMs(value) {
  if (!value) {
    return 0;
  }
  if (typeof value === "number") {
    return value;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function secondsToMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number * 1000 : 0;
}

function isoFromMs(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}
