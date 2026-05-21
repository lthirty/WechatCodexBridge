import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Router } from "./router.js";
import { CodexRunner } from "./codex-runner.js";
import { WechatClient } from "./wechat-client.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = loadConfig(projectRoot);
const store = new Store(config);
const router = new Router({
  config,
  store,
  codexRunner: new CodexRunner(config),
  wechatClient: new WechatClient(config)
});

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, {
        ok: true,
        dryRun: config.dryRun,
        configPath: config.configPath
      });
    }
    if (request.method === "POST" && request.url === "/wechat/message") {
      const payload = await readJson(request);
      const result = await router.handleWechatMessage(payload);
      return sendJson(response, 200, result);
    }
    sendJson(response, 404, { ok: false, error: "not found" });
  } catch (error) {
    sendJson(response, 500, { ok: false, error: error.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`wechat-codex-bridge listening on http://${config.host}:${config.port}`);
  console.log(`dryRun=${config.dryRun}`);
});

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        request.destroy();
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}
