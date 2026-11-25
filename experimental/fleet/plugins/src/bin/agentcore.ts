import path from "node:path";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { agentCoreHarness } from "../agentcore.js";
import { serve } from "../protocol.js";
import { pluginDir } from "./here.js";

const clients = new Map<string, BedrockAgentCoreClient>();
const client = (region: string): BedrockAgentCoreClient => {
  const existing = clients.get(region);
  if (existing) return existing;
  const made = new BedrockAgentCoreClient({ region });
  clients.set(region, made);
  return made;
};

const hasCredentials = (): Promise<boolean> =>
  client(process.env.AWS_REGION ?? "us-east-1")
    .config.credentials()
    .then(
      () => true,
      () => false,
    );

await serve(agentCoreHarness(process.env.AGENTCORE_AGENTS_DIR ?? path.join(pluginDir(import.meta.url), "agents"), client, hasCredentials));
