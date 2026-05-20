import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function codexContinue(extra = {}) {
  return {
    continue: true,
    ...extra
  };
}

export async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

export function parsePayload(rawInput) {
  if (!rawInput || !rawInput.trim()) {
    return {
      payload: null,
      error: null
    };
  }

  try {
    const parsed = JSON.parse(rawInput);
    return {
      payload: parsed && typeof parsed === "object" ? parsed : null,
      error: null
    };
  }
  catch (error) {
    return {
      payload: null,
      error
    };
  }
}

export function getHookValue(payload, name, defaultValue = "") {
  if (!payload || typeof payload !== "object" || payload[name] == null) {
    return defaultValue;
  }

  return String(payload[name]);
}

export function getStateDir(env = process.env) {
  return env.CODEX_HOOK_STATE_DIR || path.join(os.homedir(), ".codex", "hooks", "state");
}

export function getLogFile(env = process.env) {
  return env.CODEX_HOOK_LOG_FILE || path.join(os.homedir(), ".codex", "hooks", "feishu_hook.log");
}

export function isDryRun(env = process.env) {
  return env.CODEX_HOOK_DRY_RUN === "1" || env.CODEX_HOOK_DRY_RUN === "true";
}

export function safeFilePart(value) {
  const safe = String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return safe.trim() || "unknown";
}

export async function writeHookLog({ event, message, level = "INFO", env = process.env }) {
  try {
    const logFile = getLogFile(env);
    await fs.mkdir(path.dirname(logFile), {
      recursive: true
    });
    const timestamp = new Date().toISOString();
    await fs.appendFile(logFile, `[${timestamp}][${level}][${event}] ${message}\n`, "utf8");
  }
  catch {
  }
}

export async function writePromptState({ payload, env = process.env, now = new Date() }) {
  const sessionId = getHookValue(payload, "session_id", "unknown-session");
  const turnId = getHookValue(payload, "turn_id", "unknown-turn");
  const prompt = getHookValue(payload, "prompt");

  if (!prompt.trim()) {
    return {
      captured: false,
      reason: "missing-prompt",
      sessionId,
      turnId
    };
  }

  const stateDir = getStateDir(env);
  await fs.mkdir(stateDir, {
    recursive: true
  });

  const state = {
    session_id: sessionId,
    turn_id: turnId,
    prompt,
    captured_at: now.toISOString()
  };
  const json = `${JSON.stringify(state, null, 2)}\n`;
  const sessionPart = safeFilePart(sessionId);
  const turnPart = safeFilePart(turnId);

  await fs.writeFile(path.join(stateDir, `${sessionPart}_${turnPart}.json`), json, "utf8");
  await fs.writeFile(path.join(stateDir, `${sessionPart}_latest.json`), json, "utf8");

  return {
    captured: true,
    sessionId,
    turnId,
    promptLength: prompt.length
  };
}

export async function readCapturedPrompt({ sessionId, turnId, env = process.env }) {
  const stateDir = getStateDir(env);
  const sessionPart = safeFilePart(sessionId);
  const turnPart = safeFilePart(turnId);
  const candidates = [
    path.join(stateDir, `${sessionPart}_${turnPart}.json`),
    path.join(stateDir, `${sessionPart}_latest.json`)
  ];

  for (const candidate of candidates) {
    try {
      const state = JSON.parse(await fs.readFile(candidate, "utf8"));
      const prompt = getHookValue(state, "prompt");
      if (prompt.trim()) {
        return prompt;
      }
    }
    catch {
    }
  }

  return "";
}

export function singleLineSummary(value, maxLength) {
  if (!value || maxLength <= 0) {
    return "";
  }

  const summary = String(value).replace(/\s+/g, " ").trim();
  if (summary.length > maxLength) {
    return `${summary.slice(0, maxLength)}...`;
  }

  return summary;
}

export function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length > maxLength) {
    return `${text.slice(0, maxLength)}...`;
  }
  return text;
}

export function signFeishuWebhook(timestamp, secret) {
  const key = `${timestamp}\n${secret}`;
  return crypto.createHmac("sha256", key).update("").digest("base64");
}

export function extractFirstArtifactUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s<>"'）)]+\/artifacts\/[^\s<>"'）)]+/i);
  if (!match) {
    return "";
  }

  return match[0].replace(/[.,;，。；]+$/u, "");
}

export function buildDashboardUrl({ serverUrl = "", token = "" } = {}) {
  if (!serverUrl.trim()) {
    return "";
  }

  try {
    const url = new URL(serverUrl);
    if (token.trim()) {
      url.searchParams.set("token", token);
    }
    return url.toString();
  }
  catch {
    if (!token.trim()) {
      return serverUrl;
    }
    const separator = serverUrl.includes("?") ? "&" : "?";
    return `${serverUrl}${separator}token=${encodeURIComponent(token)}`;
  }
}

export function buildFeishuText({ payload, task, env = process.env } = {}) {
  const sessionId = getHookValue(payload, "session_id", "unknown-session");
  const turnId = getHookValue(payload, "turn_id", "unknown-turn");
  const cwd = getHookValue(payload, "cwd", "unknown-cwd");
  const model = getHookValue(payload, "model", "unknown-model");
  const permissionMode = getHookValue(payload, "permission_mode", "unknown-permission");
  const lastAssistantMessage = truncateText(getHookValue(payload, "last_assistant_message"), 900) || "(no assistant message captured)";
  const taskSummary = singleLineSummary(task, 260) || "(未捕获到本轮任务)";
  const artifactUrl = extractFirstArtifactUrl(lastAssistantMessage);
  const dashboardUrl = buildDashboardUrl({
    serverUrl: env.HTML_ARTIFACT_SERVER_URL || "",
    token: env.HTML_ARTIFACT_SERVER_TOKEN || ""
  });

  const links = [];
  if (artifactUrl) {
    links.push(`artifact: ${artifactUrl}`);
  }
  if (dashboardUrl) {
    links.push(`dashboard: ${dashboardUrl}`);
  }

  return `Codex 任务完成

任务: ${taskSummary}

cwd: ${cwd}
model: ${model}
permission: ${permissionMode}
session: ${sessionId}
turn: ${turnId}
${links.length ? `\n${links.join("\n")}\n` : ""}
结果摘要:
${lastAssistantMessage}`;
}

export function buildFeishuBody({ text, env = process.env, timestamp = Math.floor(Date.now() / 1000).toString() }) {
  const body = {
    msg_type: "text",
    content: {
      text
    }
  };
  const secret = env.FEISHU_WEBHOOK_SECRET || "";
  if (secret.trim()) {
    body.timestamp = timestamp;
    body.sign = signFeishuWebhook(timestamp, secret);
  }
  return body;
}

export async function handlePromptCapture({ rawInput, env = process.env, now = new Date() }) {
  try {
    const { payload, error } = parsePayload(rawInput);
    if (error) {
      await writeHookLog({
        event: "UserPromptSubmit",
        level: "ERROR",
        message: `Capture failed to parse stdin JSON: ${error.message}`,
        env
      });
      return codexContinue({
        captured: false
      });
    }
    if (!payload) {
      await writeHookLog({
        event: "UserPromptSubmit",
        level: "WARN",
        message: "Skipped because stdin was empty.",
        env
      });
      return codexContinue({
        captured: false
      });
    }

    const result = await writePromptState({
      payload,
      env,
      now
    });
    if (result.captured) {
      await writeHookLog({
        event: "UserPromptSubmit",
        message: `Captured prompt. session=${result.sessionId} turn=${result.turnId} promptLength=${result.promptLength}`,
        env
      });
    }
    else {
      await writeHookLog({
        event: "UserPromptSubmit",
        level: "WARN",
        message: `Skipped because payload did not include prompt. session=${result.sessionId} turn=${result.turnId}`,
        env
      });
    }

    return codexContinue({
      captured: result.captured
    });
  }
  catch (error) {
    await writeHookLog({
      event: "UserPromptSubmit",
      level: "ERROR",
      message: `Capture failed: ${error.message}`,
      env
    });
    return codexContinue({
      captured: false
    });
  }
}

export async function handleStopNotification({ rawInput, env = process.env, fetchImpl = globalThis.fetch }) {
  try {
    const { payload, error } = parsePayload(rawInput);
    if (error) {
      await writeHookLog({
        event: "Stop",
        level: "WARN",
        message: `Could not parse stdin JSON: ${error.message}`,
        env
      });
    }

    const sessionId = getHookValue(payload, "session_id", "unknown-session");
    const turnId = getHookValue(payload, "turn_id", "unknown-turn");
    let task = getHookValue(payload, "prompt");
    if (!task.trim()) {
      task = await readCapturedPrompt({
        sessionId,
        turnId,
        env
      });
    }

    if (!task.trim()) {
      await writeHookLog({
        event: "Stop",
        level: "WARN",
        message: `No captured task found. session=${sessionId} turn=${turnId}`,
        env
      });
    }

    const text = buildFeishuText({
      payload,
      task,
      env
    });

    if (isDryRun(env)) {
      await writeHookLog({
        event: "Stop",
        message: `Dry run built Feishu notification. session=${sessionId} turn=${turnId}`,
        env
      });
      return codexContinue({
        dryRun: true,
        text
      });
    }

    const webhookUrl = env.FEISHU_WEBHOOK_URL || "";
    if (!webhookUrl.trim()) {
      await writeHookLog({
        event: "Stop",
        level: "ERROR",
        message: "Skipped sending because FEISHU_WEBHOOK_URL was empty.",
        env
      });
      return codexContinue({
        sent: false
      });
    }

    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available in this Node.js runtime");
    }

    const body = buildFeishuBody({
      text,
      env
    });
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body)
    });
    const responseText = typeof response.text === "function" ? await response.text() : "";
    if (response.ok === false) {
      throw new Error(`Feishu webhook returned HTTP ${response.status}: ${responseText}`);
    }

    await writeHookLog({
      event: "Stop",
      message: `Sent Feishu notification. session=${sessionId} turn=${turnId} status=${response.status || "unknown"}`,
      env
    });
    return codexContinue({
      sent: true
    });
  }
  catch (error) {
    await writeHookLog({
      event: "Stop",
      level: "ERROR",
      message: `Stop notification failed: ${error.message}`,
      env
    });
    return codexContinue({
      sent: false
    });
  }
}
