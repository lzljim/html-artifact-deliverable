#!/usr/bin/env node
import { handlePromptCapture, readStdin } from "./feishu-hook-lib.mjs";

const result = await handlePromptCapture({
  rawInput: await readStdin()
});

process.stdout.write(`${JSON.stringify(result)}\n`);
