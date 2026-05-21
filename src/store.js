import fs from "node:fs";
import path from "node:path";

const initialState = {
  version: 1,
  sessions: {},
  targets: {},
  jobs: {}
};

export class Store {
  constructor(config) {
    this.config = config;
    this.state = this.load();
  }

  load() {
    if (!fs.existsSync(this.config.statePath)) {
      return structuredClone(initialState);
    }
    return JSON.parse(fs.readFileSync(this.config.statePath, "utf8"));
  }

  save(reason) {
    this.backup(reason);
    const tmpPath = `${this.config.statePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.config.statePath);
  }

  backup(reason) {
    if (!fs.existsSync(this.config.statePath)) {
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeReason = String(reason || "state").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
    const backupPath = path.join(this.config.backupDir, `state-${timestamp}-${safeReason}.json`);
    fs.copyFileSync(this.config.statePath, backupPath);
  }

  ensureSession(sessionId, displayName) {
    const now = Date.now();
    if (!this.state.sessions[sessionId]) {
      this.state.sessions[sessionId] = {
        id: sessionId,
        displayName: displayName || sessionId,
        activeTargetId: null,
        targetIds: [],
        createdAt: now,
        updatedAt: now
      };
      return this.state.sessions[sessionId];
    }
    const session = this.state.sessions[sessionId];
    session.displayName = displayName || session.displayName;
    session.updatedAt = now;
    return session;
  }

  bindTarget(sessionId, target) {
    const now = Date.now();
    const targetId = target.alias;
    this.state.targets[targetId] = {
      id: targetId,
      alias: target.alias,
      projectName: target.projectName || target.alias,
      cwd: target.cwd,
      threadId: target.threadId || null,
      outputDir: target.outputDir || target.cwd,
      status: "active",
      createdAt: this.state.targets[targetId]?.createdAt || now,
      updatedAt: now
    };
    const session = this.state.sessions[sessionId];
    if (!session.targetIds.includes(targetId)) {
      session.targetIds.push(targetId);
    }
    session.activeTargetId = targetId;
    session.updatedAt = now;
  }

  setActiveTarget(sessionId, alias) {
    const session = this.state.sessions[sessionId];
    if (!session || !this.state.targets[alias]) {
      throw new Error(`target not found: ${alias}`);
    }
    if (!session.targetIds.includes(alias)) {
      session.targetIds.push(alias);
    }
    session.activeTargetId = alias;
    session.updatedAt = Date.now();
  }

  clearActiveTarget(sessionId) {
    const session = this.state.sessions[sessionId];
    if (!session) {
      return null;
    }
    const previous = session.activeTargetId ? this.state.targets[session.activeTargetId] : null;
    session.activeTargetId = null;
    session.updatedAt = Date.now();
    return previous;
  }

  requireBoundTarget(sessionId, alias) {
    const session = this.state.sessions[sessionId];
    if (!session?.targetIds.includes(alias)) {
      throw new Error(`target not bound for this session: ${alias}`);
    }
    return this.state.targets[alias] || null;
  }

  unbindTarget(sessionId, alias) {
    const session = this.state.sessions[sessionId];
    if (!session) {
      return false;
    }
    session.targetIds = session.targetIds.filter((id) => id !== alias);
    if (session.activeTargetId === alias) {
      session.activeTargetId = session.targetIds[0] || null;
    }
    session.updatedAt = Date.now();
    return true;
  }

  getSessionTargets(sessionId) {
    const session = this.state.sessions[sessionId];
    if (!session) {
      return [];
    }
    return session.targetIds.map((id) => this.state.targets[id]).filter(Boolean);
  }

  getActiveTarget(sessionId) {
    const session = this.state.sessions[sessionId];
    if (!session?.activeTargetId) {
      return null;
    }
    return this.state.targets[session.activeTargetId] || null;
  }

  getTargetForSession(sessionId, alias) {
    const session = this.state.sessions[sessionId];
    if (!session?.targetIds.includes(alias)) {
      return null;
    }
    return this.state.targets[alias] || null;
  }

  addJob(job) {
    this.state.jobs[job.id] = job;
  }

  updateJob(jobId, patch) {
    this.state.jobs[jobId] = {
      ...this.state.jobs[jobId],
      ...patch,
      updatedAt: Date.now()
    };
  }
}
