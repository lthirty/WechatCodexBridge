export class WechatClient {
  constructor(config) {
    this.config = config;
  }

  async sendText(sessionId, text) {
    this.assertAllowedSession(sessionId);
    if (this.config.dryRun || this.config.weclaw?.mode === "dry-run") {
      return { dryRun: true, sessionId, text };
    }
    return this.post("/api/send", { to: sessionId, text });
  }

  async sendFile(sessionId, filePath) {
    this.assertAllowedSession(sessionId);
    if (this.config.dryRun || this.config.weclaw?.mode === "dry-run") {
      return { dryRun: true, sessionId, filePath };
    }
    return this.post("/api/send", { to: sessionId, file: filePath });
  }

  async post(route, body) {
    const base = this.config.weclaw.apiBase.replace(/\/$/, "");
    const response = await fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`weclaw request failed: ${response.status} ${await response.text()}`);
    }
    return response.json().catch(() => ({ ok: true }));
  }

  assertAllowedSession(sessionId) {
    const allowed = this.config.weclaw?.allowedSessionIds || [];
    if (allowed.length > 0 && !allowed.includes(sessionId)) {
      throw new Error(`wechat session is not allowed: ${sessionId}`);
    }
  }
}
