import { Pizza, Puzzle, SquareTerminal } from "lucide-react";
import type { FleetAgent, FleetRunner } from "./fleet-types.js";
import { isBuiltin } from "./fleet-view-model.js";

const iconSrc = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** A plugin's own icon; as an <img>, a script inside the SVG can't run. Without one, a puzzle piece. */
export function PluginIcon({ runner, pluginId, size = 14 }: { runner: FleetRunner; pluginId: string; size?: number }) {
  const svg = runner.pluginIcons?.[pluginId];
  return svg ? <img src={iconSrc(svg)} width={size} height={size} alt="" /> : <Puzzle size={size} aria-hidden="true" />;
}

const typeName = (agent: FleetAgent, runner: FleetRunner): string => {
  if (isBuiltin(agent)) return "Pizza Bot";
  if (!agent.harness) return "Own command";
  return runner.plugins?.find((p) => p.id === agent.harness)?.name ?? agent.harness;
};

/** What kind of agent this is: Pizza Bot, its plugin's icon, or its own command. */
export function AgentTypeIcon({ agent, runner, size = 14 }: { agent: FleetAgent; runner: FleetRunner; size?: number }) {
  const name = typeName(agent, runner);
  const builtin = isBuiltin(agent);
  return (
    <span className={`fleet-agent-type${builtin ? " pizza" : ""}`} role="img" aria-label={name} title={name}>
      {builtin ? (
        <Pizza size={size} aria-hidden="true" />
      ) : agent.harness ? (
        <PluginIcon runner={runner} pluginId={agent.harness} size={size} />
      ) : (
        <SquareTerminal size={size} aria-hidden="true" />
      )}
    </span>
  );
}
