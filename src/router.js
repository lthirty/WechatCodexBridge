import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { assertAllowedPath } from "./security.js";
import { findLatestFiles } from "./file-finder.js";
import { findCodexThread, listCodexThreads } from "./codex-index.js";

export class Router {
  constructor({ config, store, codexRunner, wechatClient }) {
    this.config = config;
    this.store = store;
    this.codexRunner = codexRunner;
    this.wechatClient = wechatClient;
  }

  async handleWechatMessage(payload) {
    const sessionId = required(payload.sessionId, "sessionId");
    const text = required(payload.text, "text").trim();
    const session = this.store.ensureSession(sessionId, payload.displayName);

    if (text.startsWith("/")) {
      return this.handleCommand(session, text);
    }
    const imageShortcut = this.tryLatestImageShortcut(session, text);
    if (imageShortcut) {
      return imageShortcut;
    }
    return this.askTarget(session, null, text);
  }

  async handleCommand(session, text) {
    const [command, ...rest] = splitCommand(text);
    switch (command.toLowerCase()) {
      case "/help":
        return this.reply(session.id, helpText());
      case "/bind":
        return this.bind(session, rest);
      case "/ent":
      case "/enter":
      case "/use":
        return this.enter(session, rest);
      case "/list":
      case "/ls":
      case "/targets":
        return this.list(session);
      case "/status":
        return this.status(session);
      case "/ask":
        return this.ask(session, rest);
      case "/sendlast":
        return this.sendLast(session, rest);
      case "/unbind":
        return this.unbind(session, rest);
      case "/exit":
        return this.exit(session);
      default:
        return this.reply(session.id, `未知命令：${command}\n\n${helpText()}`);
    }
  }

  async bind(session, args) {
    if (args.length < 3) {
      return this.reply(session.id, "用法：/bind <alias> <cwd> <thread_id> [output_dir]");
    }
    const [alias, cwdRaw, threadId, outputDirRaw] = args;
    const cwd = assertAllowedPath(this.config, cwdRaw);
    const outputDir = assertAllowedPath(this.config, outputDirRaw || cwd);
    this.store.bindTarget(session.id, {
      alias,
      projectName: alias,
      cwd,
      threadId,
      outputDir
    });
    this.store.save("bind");
    return this.reply(session.id, `[${alias}] 已绑定\ncwd: ${cwd}\nthread: ${threadId}\noutput: ${outputDir}`);
  }

  async enter(session, args) {
    const query = args.join(" ").trim();
    if (!query) {
      return this.reply(session.id, "用法：/ent <项目名/线程名>");
    }
    const thread = findCodexThread(query);
    if (!thread) {
      return this.reply(session.id, `没有找到 Codex 线程：${query}\n先使用 /list 查看。`);
    }
    this.store.bindTarget(session.id, thread);
    this.store.setActiveTarget(session.id, thread.alias);
    this.store.save("enter");
    const target = this.store.getActiveTarget(session.id);
    return this.reply(session.id, [
      `已进入 Codex 线程：${target.alias}`,
      `之后文件传输助手中的普通消息会通过 Codex CLI resume 发送到该线程。`,
      `cwd: ${target.cwd}`,
      `thread: ${target.threadId}`
    ].join("\n"));
  }

  async list(session) {
    const targets = listCodexThreads();
    if (!targets.length) {
      return this.reply(session.id, "没有找到 Codex App 线程索引。");
    }
    const activeTarget = this.store.getActiveTarget(session.id);
    return this.reply(session.id, formatThreadTree(targets, activeTarget));
  }

  async status(session) {
    const target = this.store.getActiveTarget(session.id);
    if (!target) {
      return this.reply(session.id, "当前没有进入任何线程。先使用 /list 或 /ls 查看，再使用 /ent <项目名/线程名> 进入。");
    }
    return this.reply(session.id, [
      `session: ${session.id}`,
      `active: ${target.alias}`,
      `cwd: ${target.cwd}`,
      `thread: ${target.threadId || "(new)"}`,
      `output: ${target.outputDir}`
    ].join("\n"));
  }

  async ask(session, args) {
    if (args.length < 2) {
      return this.reply(session.id, "用法：/ask <alias> <message>");
    }
    const [alias, ...messageParts] = args;
    return this.askTarget(session, alias, messageParts.join(" "));
  }

  async askTarget(session, alias, message) {
    const target = alias
      ? this.store.getTargetForSession(session.id, alias)
      : this.store.getActiveTarget(session.id);
    if (!target) {
      return this.reply(session.id, "没有找到可用目标。先使用 /list 或 /ls 查看，再使用 /ent <项目名/线程名> 进入。");
    }
    const jobId = crypto.randomUUID();
    const now = Date.now();
    this.store.addJob({
      id: jobId,
      wechatSessionId: session.id,
      targetId: target.id,
      message,
      status: "queued",
      createdAt: now,
      updatedAt: now
    });
    this.store.save("job_queued");
    await this.reply(session.id, `[${target.alias}] 已入队：${jobId}`);
    try {
      this.store.updateJob(jobId, { status: "running" });
      this.store.save("job_running");
      scheduleCodexThreadOpen(target, 1500);
      const result = await this.codexRunner.enqueue(target, message);
      this.store.updateJob(jobId, { status: "completed", result });
      this.store.save("job_completed");
      openCodexThread(target);
      return this.reply(session.id, `[${target.alias}] 完成\n${result}`);
    } catch (error) {
      this.store.updateJob(jobId, { status: "failed", result: error.message });
      this.store.save("job_failed");
      return this.reply(session.id, `[${target.alias}] 失败\n${error.message}`);
    }
  }

  async sendLast(session, args) {
    const count = Math.min(
      Number.parseInt(args[0] || "5", 10),
      this.config.defaults.maxSendFiles
    );
    const target = this.store.getActiveTarget(session.id);
    if (!target) {
      return this.reply(session.id, "当前没有激活目标。");
    }
    const outputDir = assertAllowedPath(this.config, target.outputDir);
    const files = findLatestFiles(outputDir, this.config.defaults.imageExtensions, count);
    if (!files.length) {
      return this.reply(session.id, `[${target.alias}] 没有找到可回传图片：${outputDir}`);
    }
    for (const file of files) {
      await this.wechatClient.sendFile(session.id, file.path);
    }
    return this.reply(session.id, [
      `[${target.alias}] 已准备回传 ${files.length} 个文件`,
      ...files.map((file) => fileToMarkdown(file.path))
    ].join("\n"));
  }

  tryLatestImageShortcut(session, text) {
    if (!isLatestImageRequest(text)) {
      return null;
    }
    const target = this.store.getActiveTarget(session.id);
    if (!target) {
      return null;
    }
    const count = Math.min(extractImageCount(text), this.config.defaults.maxSendFiles);
    const roots = imageRootsForTarget(target);
    const selected = [];
    for (const root of roots) {
      for (const file of findLatestFiles(root, this.config.defaults.imageExtensions, count)) {
        if (!selected.some((existing) => existing.path === file.path)) {
          selected.push(file);
        }
        if (selected.length >= count) {
          break;
        }
      }
      if (selected.length >= count) {
        break;
      }
    }
    if (!selected.length) {
      return this.reply(session.id, `[${target.alias}] 没有找到最近生成的图片。可用 /sendlast 1 指定回传当前项目目录里的最近图片。`);
    }
    return this.reply(session.id, [
      `[${target.alias}] 回传最近 ${selected.length} 张图片`,
      ...selected.map((file) => fileToMarkdown(file.path))
    ].join("\n"));
  }

  async unbind(session, args) {
    const alias = args[0];
    if (!alias) {
      return this.reply(session.id, "用法：/unbind <alias>");
    }
    this.store.unbindTarget(session.id, alias);
    this.store.save("unbind");
    return this.reply(session.id, `已解绑：${alias}`);
  }

  async exit(session) {
    const previous = this.store.clearActiveTarget(session.id);
    this.store.save("exit");
    if (!previous) {
      return this.reply(session.id, "当前没有进入任何线程。");
    }
    return this.reply(session.id, [
      `已退出线程映射：${previous.alias}`,
      "文件传输助手已回到控制模式；普通消息不会再发送到 Codex 线程。",
      "再次进入可使用：/ent <项目名/线程名>"
    ].join("\n"));
  }

  async reply(sessionId, text) {
    await this.wechatClient.sendText(sessionId, text);
    return { ok: true, reply: text };
  }
}

function required(value, name) {
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return String(value);
}

function splitCommand(text) {
  return text.match(/"[^"]+"|'[^']+'|\S+/g)?.map((part) => {
    if ((part.startsWith("\"") && part.endsWith("\"")) || (part.startsWith("'") && part.endsWith("'"))) {
      return part.slice(1, -1);
    }
    return part;
  }) || [];
}

function helpText() {
  return [
    "命令：",
    "/list",
    "/ls",
    "/ent <项目名/线程名>",
    "/exit",
    "/status",
    "/bind <alias> <cwd> <thread_id> [output_dir]",
    "/ask <alias> <message>",
    "/sendlast <n>",
    "/unbind <alias>",
    "",
    "兼容旧命令：/targets = /list，/use = /ent"
  ].join("\n");
}

function formatThreadTree(targets, activeTarget) {
  const groups = groupTargetsByProject(targets);
  for (const group of groups.values()) {
    group.hasActive = group.targets.some((target) => isActiveTarget(target, activeTarget));
  }
  const sortedGroups = [...groups.values()].sort((a, b) => {
    const activeDiff = Number(b.hasActive) - Number(a.hasActive);
    if (activeDiff) return activeDiff;
    const pinnedDiff = Number(b.pinned) - Number(a.pinned);
    if (pinnedDiff) return pinnedDiff;
    const orderDiff = a.order - b.order;
    if (orderDiff) return orderDiff;
    return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
  });

  const lines = ["Codex 项目/线程"];
  for (let groupIndex = 0; groupIndex < sortedGroups.length; groupIndex += 1) {
    const group = sortedGroups[groupIndex];
    if (groupIndex > 0) {
      lines.push("");
    }
    const projectPrefix = group.hasActive ? "当前 " : group.pinned ? "置顶 " : "";
    lines.push(`${projectPrefix}${group.name}`);

    const threads = group.targets.sort((a, b) => {
      const activeDiff = Number(isActiveTarget(b, activeTarget)) - Number(isActiveTarget(a, activeTarget));
      if (activeDiff) return activeDiff;
      const pinnedDiff = Number(b.threadPinned) - Number(a.threadPinned);
      if (pinnedDiff) return pinnedDiff;
      return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
    });
    for (let index = 0; index < threads.length; index += 1) {
      const target = threads[index];
      const branch = index === threads.length - 1 ? "└─" : "├─";
      const active = isActiveTarget(target, activeTarget) ? "当前 " : "";
      const pinned = target.threadPinned ? "置顶 " : "";
      lines.push(`${branch} ${active}${pinned}${target.threadName}`);
    }
  }
  lines.push("", "进入线程：/ent 项目名/线程名");
  return lines.join("\n");
}

function groupTargetsByProject(targets) {
  const groups = new Map();
  for (const target of targets) {
    const key = target.projectKey || target.projectName || "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        name: target.projectName || "未命名项目",
        pinned: Boolean(target.projectPinned),
        order: target.projectOrder ?? Number.MAX_SAFE_INTEGER,
        projectless: Boolean(target.projectless),
        updatedAt: target.updatedAt,
        hasActive: false,
        targets: []
      });
    }
    const group = groups.get(key);
    group.pinned ||= Boolean(target.projectPinned);
    group.updatedAt = maxDate(group.updatedAt, target.updatedAt);
    group.targets.push(target);
  }
  return groups;
}

function maxDate(left, right) {
  return Date.parse(left || 0) >= Date.parse(right || 0) ? left : right;
}

function isActiveTarget(target, activeTarget) {
  return Boolean(activeTarget) && target.alias === activeTarget.alias;
}

function isLatestImageRequest(text) {
  return /(?:发|发送|传|回传).{0,8}(?:图|图片|照片|截图)/.test(text)
    || /(?:图|图片|照片|截图).{0,8}(?:过来|给我|回传)/.test(text);
}

function extractImageCount(text) {
  const match = text.match(/(\d+)\s*张/);
  if (!match) {
    return 1;
  }
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function imageRootsForTarget(target) {
  const roots = [];
  if (target.threadId) {
    roots.push(path.join(os.homedir(), ".codex", "generated_images", target.threadId));
  }
  if (target.outputDir) {
    roots.push(target.outputDir);
  }
  return roots;
}

function fileToMarkdown(filePath) {
  return `![${path.basename(filePath)}](${filePath.replaceAll("\\", "/")})`;
}

function scheduleCodexThreadOpen(target, delayMs) {
  if (!target.threadId) {
    return;
  }
  setTimeout(() => openCodexThread(target), delayMs).unref();
}

function openCodexThread(target) {
  if (!target.threadId || process.platform !== "win32") {
    return;
  }
  const url = `codex://threads/${target.threadId}`;
  const child = spawn(
    "cmd.exe",
    ["/d", "/c", "start", "", url],
    { windowsHide: true, detached: true, stdio: "ignore" }
  );
  child.unref();
}
