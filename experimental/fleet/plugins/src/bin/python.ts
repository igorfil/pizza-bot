import { serve } from "../protocol.js";
import { pythonHarness } from "../python.js";
import { agentDirs } from "./here.js";

await serve(pythonHarness(agentDirs(import.meta.url, process.env.PYTHON_AGENTS_DIR)));
