import crypto from "node:crypto";
import path from "node:path";
import { assertAllowedPath } from "./security.js";
import { findLatestFiles } from "./file-finder.js";

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
      case "/targets":
        return this.targets(session);
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
    const alias = args[0];
    if (!alias) {
      return this.reply(session.id, "用法：/ent <项目名/线程名>");
    }
    this.store.setActiveTarget(session.id, alias);
    this.store.save("enter");
    const target = this.store.getActiveTarget(session.id);
    return this.reply(session.id, [
      `已进入线程映射：${alias}`,
      `之后文件传输助手中的普通消息会发送到该线程。`,
      `cwd: ${target.cwd}`,
      `thread: ${target.threadId || "(new)"}`
    ].join("\n"));
  }

  async targets(session) {
    const targets = this.store.getSessionTargets(session.id);
    if (!targets.length) {
      return this.reply(session.id, "当前微信会话还没有绑定任何 Codex 目标。");
    }
    const lines = targets.map((target) => {
      const active = target.id === session.activeTargetId ? "*" : "-";
      return `${active} ${target.alias} | ${target.cwd} | ${target.threadId || "(new)"}`;
    });
    return this.reply(session.id, lines.join("\n"));
  }

  async status(session) {
    const target = this.store.getActiveTarget(session.id);
    if (!target) {
      return this.reply(session.id, "当前没有进入任何线程。先使用 /list 查看，再使用 /ent <项目名/线程名> 进入。");
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
      return this.reply(session.id, "没有找到可用目标。先使用 /list 查看，再使用 /ent <项目名/线程名> 进入。");
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
      const result = await this.codexRunner.enqueue(target, message);
      this.store.updateJob(jobId, { status: "completed", result });
      this.store.save("job_completed");
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
    return this.reply(session.id, `[${target.alias}] 已准备回传 ${files.length} 个文件\n${files.map((file) => path.basename(file.path)).join("\n")}`);
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
