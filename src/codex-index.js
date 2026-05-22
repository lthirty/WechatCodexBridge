import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function listCodexThreads(codexHome = path.join(os.homedir(), ".codex")) {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  if (!fs.existsSync(indexPath)) {
    return [];
  }
  const sidebar = readCodexSidebarState(codexHome);

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
      const cwd = meta?.cwd || sidebar.threadWorkspaceRootHints.get(row.id) || codexHome;
      const project = resolveProject(cwd, row.id, sidebar);
      return {
        id: row.id,
        alias: row.thread_name || row.id,
        projectKey: project.key,
        projectName: project.name,
        projectPath: project.path,
        projectPinned: project.pinned,
        projectOrder: project.order,
        projectless: project.projectless,
        threadId: row.id,
        threadName: row.thread_name || row.id,
        threadPinned: sidebar.pinnedThreadIds.has(row.id),
        cwd,
        outputDir: cwd,
        updatedAt: row.updated_at || null
      };
    })
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
}

export function listCodexProjects(codexHome = path.join(os.homedir(), ".codex")) {
  const sidebar = readCodexSidebarState(codexHome);
  return sidebar.projectOrder
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
  const empty = {
    pinnedProjectIds: new Set(),
    pinnedThreadIds: new Set(),
    projectlessThreadIds: new Set(),
    projectOrder: [],
    projectOrderMap: new Map(),
    threadWorkspaceRootHints: new Map()
  };
  if (!fs.existsSync(statePath)) {
    return empty;
  }

  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const projectOrder = Array.isArray(state["project-order"]) ? state["project-order"] : [];
    return {
      pinnedProjectIds: new Set((state["pinned-project-ids"] || []).map(normalizePath)),
      pinnedThreadIds: new Set(state["pinned-thread-ids"] || []),
      projectlessThreadIds: new Set(state["projectless-thread-ids"] || []),
      projectOrder,
      projectOrderMap: new Map(projectOrder.map((item, index) => [normalizePath(item), index])),
      threadWorkspaceRootHints: new Map(Object.entries(state["thread-workspace-root-hints"] || {}))
    };
  } catch {
    return empty;
  }
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
  const projectPath = sidebar.projectOrder
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
  return String(value || "").trim().toLowerCase();
}

function normalizePath(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/]+/g, "\\")
    .replace(/\\$/, "")
    .toLowerCase();
}

function isDriveRoot(normalizedPath) {
  return /^[a-z]:$/.test(normalizedPath);
}
