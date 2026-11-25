import path from "node:path";
import { serve } from "../protocol.js";
import { pythonHarness } from "../python.js";
import { pluginDir } from "./here.js";

await serve(pythonHarness(process.env.PYTHON_AGENTS_DIR ?? path.join(pluginDir(import.meta.url), "agents")));
