import type { AwsProfile } from "./port.js";

type Sections = Map<string, Record<string, string>>;

/** Minimal INI reader: `[section]` headers and `key = value` lines; comments start with # or ;. */
export const parseIni = (text: string): Sections =>
  text.split(/\r?\n/).reduce<{ sections: Sections; current: string | null }>(
    ({ sections, current }, raw) => {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) return { sections, current };
      const header = /^\[(.+)\]$/.exec(line);
      if (header) {
        const name = header[1]!.trim();
        if (!sections.has(name)) sections.set(name, {});
        return { sections, current: name };
      }
      const kv = /^([^=]+)=(.*)$/.exec(line);
      if (kv && current) sections.get(current)![kv[1]!.trim()] = kv[2]!.trim();
      return { sections, current };
    },
    { sections: new Map(), current: null },
  ).sections;

/** In ~/.aws/config profiles are `[profile x]` (except `[default]`); in ~/.aws/credentials they're `[x]`. */
const configProfileName = (section: string): string | null =>
  section === "default" ? "default" : section.startsWith("profile ") ? section.slice("profile ".length).trim() : null;

export const awsProfiles = (configText: string, credentialsText: string): AwsProfile[] => {
  const fromConfig = [...parseIni(configText)].flatMap(([section, values]): AwsProfile[] => {
    const name = configProfileName(section);
    return name ? [{ name, region: values.region ?? null }] : [];
  });
  const known = new Set(fromConfig.map((p) => p.name));
  const fromCredentials = [...parseIni(credentialsText).keys()].filter((n) => !known.has(n)).map((name) => ({ name, region: null }));
  return [...fromConfig, ...fromCredentials].sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : a.name.localeCompare(b.name)));
};
