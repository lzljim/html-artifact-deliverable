import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  buildDashboardUrl,
  buildFeishuBody,
  extractFirstArtifactUrl,
  handlePromptCapture,
  handleStopNotification,
  signFeishuWebhook
} from "../scripts/codex-hooks/feishu-hook-lib.mjs";

let tempRoot;

function baseEnv(extra = {}) {
  return {
    CODEX_HOOK_STATE_DIR: path.join(tempRoot, "state"),
    CODEX_HOOK_LOG_FILE: path.join(tempRoot, "logs", "feishu.log"),
    ...extra
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

describe("codex Feishu hooks", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-hooks-test-"));
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, {
        recursive: true,
        force: true
      });
    }
  });

  it("captures prompt state by session and turn", async () => {
    const env = baseEnv();
    const result = await handlePromptCapture({
      rawInput: JSON.stringify({
        session_id: "session/1",
        turn_id: "turn:2",
        prompt: "实现 hook 通知"
      }),
      env,
      now: new Date("2026-05-20T00:00:00.000Z")
    });

    assert.equal(result.continue, true);
    assert.equal(result.captured, true);

    const state = await readJson(path.join(env.CODEX_HOOK_STATE_DIR, "session_1_turn_2.json"));
    assert.equal(state.session_id, "session/1");
    assert.equal(state.turn_id, "turn:2");
    assert.equal(state.prompt, "实现 hook 通知");
    assert.equal(state.captured_at, "2026-05-20T00:00:00.000Z");

    const latest = await readJson(path.join(env.CODEX_HOOK_STATE_DIR, "session_1_latest.json"));
    assert.equal(latest.prompt, "实现 hook 通知");
  });

  it("builds dry-run notification from captured prompt without calling Feishu", async () => {
    const env = baseEnv({
      CODEX_HOOK_DRY_RUN: "1",
      HTML_ARTIFACT_SERVER_URL: "http://127.0.0.1:8787/",
      HTML_ARTIFACT_SERVER_TOKEN: "local-token"
    });
    await handlePromptCapture({
      rawInput: JSON.stringify({
        session_id: "session-1",
        turn_id: "turn-1",
        prompt: "整理个人工作台"
      }),
      env
    });

    const result = await handleStopNotification({
      rawInput: JSON.stringify({
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "C:\\work\\repo",
        model: "gpt-5",
        permission_mode: "never",
        last_assistant_message: "已发布到 http://127.0.0.1:8787/artifacts/work-hub?token=abc"
      }),
      env,
      fetchImpl: async () => {
        throw new Error("dry-run should not send a webhook");
      }
    });

    assert.equal(result.continue, true);
    assert.equal(result.dryRun, true);
    assert.match(result.text, /任务: 整理个人工作台/);
    assert.match(result.text, /artifact: http:\/\/127\.0\.0\.1:8787\/artifacts\/work-hub\?token=abc/);
    assert.match(result.text, /dashboard: http:\/\/127\.0\.0\.1:8787\/\?token=local-token/);
  });

  it("signs Feishu webhook payloads", () => {
    assert.equal(signFeishuWebhook("1700000000", "secret"), "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=");

    const body = buildFeishuBody({
      text: "Codex 任务完成",
      env: {
        FEISHU_WEBHOOK_SECRET: "secret"
      },
      timestamp: "1700000000"
    });
    assert.equal(body.msg_type, "text");
    assert.equal(body.timestamp, "1700000000");
    assert.equal(body.sign, "fiWS2+gh28DOydAv7hzONH/mDn9+b1Y4Y5ivXWXy8vA=");
    assert.doesNotMatch(JSON.stringify(body), /FEISHU_WEBHOOK_SECRET|secret/);
  });

  it("formats artifact and dashboard links", () => {
    assert.equal(
      extractFirstArtifactUrl("详情见 [artifact](http://127.0.0.1:8787/artifacts/demo?token=t)。"),
      "http://127.0.0.1:8787/artifacts/demo?token=t"
    );
    assert.equal(
      buildDashboardUrl({
        serverUrl: "http://192.168.7.20:8787/?view=home",
        token: "share token"
      }),
      "http://192.168.7.20:8787/?view=home&token=share+token"
    );
  });

  it("fails open when webhook or JSON input is missing", async () => {
    const env = baseEnv();
    const missingWebhook = await handleStopNotification({
      rawInput: JSON.stringify({
        session_id: "session-1",
        turn_id: "turn-1",
        prompt: "无 webhook 也不阻塞"
      }),
      env,
      fetchImpl: async () => {
        throw new Error("missing webhook should not send");
      }
    });
    assert.equal(missingWebhook.continue, true);
    assert.equal(missingWebhook.sent, false);

    const badJson = await handleStopNotification({
      rawInput: "{bad json",
      env: baseEnv({
        CODEX_HOOK_DRY_RUN: "1"
      })
    });
    assert.equal(badJson.continue, true);
    assert.equal(badJson.dryRun, true);
  });

  it("sends webhook without leaking secrets into payload text", async () => {
    const calls = [];
    const result = await handleStopNotification({
      rawInput: JSON.stringify({
        session_id: "session-2",
        turn_id: "turn-2",
        prompt: "发送飞书通知",
        last_assistant_message: "完成"
      }),
      env: baseEnv({
        FEISHU_WEBHOOK_URL: "https://open.feishu.cn/mock",
        FEISHU_WEBHOOK_SECRET: "secret-value"
      }),
      fetchImpl: async (url, options) => {
        calls.push({
          url,
          options
        });
        return {
          ok: true,
          status: 200,
          text: async () => "{\"StatusCode\":0}"
        };
      }
    });

    assert.equal(result.continue, true);
    assert.equal(result.sent, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://open.feishu.cn/mock");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.msg_type, "text");
    assert.equal(typeof body.sign, "string");
    assert.doesNotMatch(body.content.text, /secret-value|https:\/\/open\.feishu\.cn\/mock/);
  });
});
