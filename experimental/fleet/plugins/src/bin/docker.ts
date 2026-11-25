import { dockerHarness } from "../docker.js";
import { serve } from "../protocol.js";
import { agentsDir, commandFrom } from "./here.js";

await serve(dockerHarness(agentsDir(import.meta.url), commandFrom(process.env.DOCKER, "docker")));
