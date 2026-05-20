#!/usr/bin/env node
import { handleStopNotification, readStdin } from "./feishu-hook-lib.mjs";

const result = await handleStopNotification({
  rawInput: await readStdin()
});

process.stdout.write(`${JSON.stringify(result)}\n`);
