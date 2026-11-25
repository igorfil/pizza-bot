import { serve } from "../protocol.js";
import { pythonHarness } from "../python.js";
import { agentsDir } from "./here.js";

await serve(pythonHarness(agentsDir(import.meta.url)));
