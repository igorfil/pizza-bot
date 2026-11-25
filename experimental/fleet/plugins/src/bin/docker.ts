import path from "node:path";
import { dockerHarness } from "../docker.js";
import { serve } from "../protocol.js";
import { commandFrom, pluginDir } from "./here.js";

await serve(dockerHarness(process.env.DOCKER_AGENTS_DIR ?? path.join(pluginDir(import.meta.url), "agents"), commandFrom(process.env.DOCKER, "docker")));
