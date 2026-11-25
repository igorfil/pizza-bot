import os from "node:os";
import path from "node:path";
import { claudeCodeHarness } from "../claude-code.js";
import { serve } from "../protocol.js";
import { commandFrom, pluginDir } from "./here.js";

// In the home folder: on EC2 the plugin folder belongs to root, and the runner's user can't write there.
const state = process.env.CLAUDE_CODE_STATE ?? path.join(os.homedir(), ".local", "state", "fleet-claude-code", "sessions.json");

await serve(claudeCodeHarness(process.env.CLAUDE_CODE_AGENTS_DIR ?? path.join(pluginDir(import.meta.url), "agents"), commandFrom(process.env.CLAUDE, "claude"), state));
