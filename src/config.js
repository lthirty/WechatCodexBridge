import fs from "node:fs";
import path from "node:path";

export function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, "config.json");
  const examplePath = path.join(projectRoot, "config.example.json");
  const target = fs.existsSync(configPath) ? configPath : examplePath;
  const config = JSON.parse(fs.readFileSync(target, "utf8"));
  config.projectRoot = projectRoot;
  config.configPath = target;
  config.statePath = resolveProjectPath(projectRoot, config.statePath);
  config.backupDir = resolveProjectPath(projectRoot, config.backupDir);
  config.logDir = resolveProjectPath(projectRoot, config.logDir);
  fs.mkdirSync(path.dirname(config.statePath), { recursive: true });
  fs.mkdirSync(config.backupDir, { recursive: true });
  fs.mkdirSync(config.logDir, { recursive: true });
  return config;
}

function resolveProjectPath(projectRoot, value) {
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}
