import fs from "node:fs";
import path from "node:path";

export function findLatestFiles(root, extensions, limit) {
  const normalized = new Set(extensions.map((item) => item.toLowerCase()));
  const results = [];
  walk(root, (filePath, stat) => {
    if (normalized.has(path.extname(filePath).toLowerCase())) {
      results.push({ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  });
  return results.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function walk(root, onFile) {
  if (!fs.existsSync(root)) {
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, onFile);
      continue;
    }
    if (entry.isFile()) {
      onFile(fullPath, fs.statSync(fullPath));
    }
  }
}
