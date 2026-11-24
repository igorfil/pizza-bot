/** Pizza Bot's skill library as the Fleet page sees it: agents get copies of these skills. */
import { createContext, useContext, useEffect, useState } from "react";
import { composeSkillMd } from "@pizza-bot/core";
import type { ApiClient } from "../../api-client.js";

export type LibrarySkill = { id: string; name: string; description: string; mcpServers: string[] };

export type SkillFilePayload = { path: string; content: string } | { path: string; content: string; encoding: "base64" };

export interface FleetSkillLibrary {
  list(): Promise<LibrarySkill[]>;
  /** Every file of the skill, `SKILL.md` first, ready to copy into an agent. */
  files(id: string): Promise<SkillFilePayload[]>;
}

/** `mcp:<server>:<tool>` refs name the MCP servers a skill needs. */
export const skillServers = (declaredTools: readonly string[]): string[] => [
  ...new Set(declaredTools.flatMap((ref) => /^mcp:([^:]+):/.exec(ref)?.[1] ?? [])),
];

export const skillLibraryFrom = (client: ApiClient): FleetSkillLibrary => ({
  list: async () =>
    (await client.listSkills()).skills
      .map((s) => ({ id: s.id, name: s.name, description: s.description, mcpServers: skillServers(s.declaredTools) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  files: async (id) => {
    const bundle = await client.getSkill(id);
    if (!bundle) throw new Error(`Pizza Bot has no skill ${id}`);
    const skillMd = composeSkillMd(bundle.id, bundle.description, bundle.body, bundle.declaredTools, bundle.interruptOn, bundle.name);
    return [
      { path: "SKILL.md", content: skillMd },
      ...bundle.files.map((f) => ({ path: f.path, content: f.content, ...(f.encoding ? { encoding: f.encoding } : {}) })),
    ];
  },
});

export const FleetSkillsContext = createContext<FleetSkillLibrary | null>(null);

export type SkillsState = { kind: "loading" } | { kind: "ready"; skills: LibrarySkill[] } | { kind: "failed"; error: string } | { kind: "none" };

/** Loads the library once per dialog; `none` when the page runs without Pizza Bot's API. */
export const useSkillLibrary = (): { library: FleetSkillLibrary | null; state: SkillsState } => {
  const library = useContext(FleetSkillsContext);
  const [state, setState] = useState<SkillsState>(library ? { kind: "loading" } : { kind: "none" });
  useEffect(() => {
    if (!library) return;
    let live = true;
    library.list().then(
      (skills) => live && setState({ kind: "ready", skills }),
      (e: unknown) => live && setState({ kind: "failed", error: e instanceof Error ? e.message : "couldn't load skills" }),
    );
    return () => {
      live = false;
    };
  }, [library]);
  return { library, state };
};
