import { dockerHarness } from "../docker.js";
import { serve } from "../protocol.js";
import { agentDirs, commandFrom } from "./here.js";

await serve(dockerHarness(agentDirs(import.meta.url, process.env.DOCKER_AGENTS_DIR), commandFrom(process.env.DOCKER, "docker")));
