import { describe, expect, test } from "vitest";
import { installScript, parseBedrock } from "./aws/install.js";
import { awsProfiles, parseIni } from "./aws/profiles.js";

describe("AWS profiles", () => {
  const config = `
[default]
region = us-west-2

[profile dev]
region=eu-central-1
sso_session = corp
# a comment
[sso-session corp]
sso_region = us-east-1
`;
  const credentials = `
[default]
aws_access_key_id = AKIA
[legacy]
aws_access_key_id = AKIB
`;

  test("reads profiles from config and credentials, default first, without duplicates", () => {
    expect(awsProfiles(config, credentials)).toEqual([
      { name: "default", region: "us-west-2" },
      { name: "dev", region: "eu-central-1" },
      { name: "legacy", region: null },
    ]);
  });

  test("sections that are not profiles are skipped", () => {
    expect(awsProfiles("[sso-session corp]\nsso_region = x\n", "").map((p) => p.name)).toEqual([]);
  });

  test("missing files mean no profiles", () => {
    expect(awsProfiles("", "")).toEqual([]);
  });

  test("parses key = value pairs with or without spaces", () => {
    expect(parseIni("[a]\nx=1\ny = 2\n").get("a")).toEqual({ x: "1", y: "2" });
  });
});

describe("install script", () => {
  const script = installScript({
    release: "https://github.com/o/r/releases/download/fleet-runner-v1",
    arch: "x86_64",
    token: "abc123",
    name: "ec2",
    region: "eu-west-1",
    port: 9000,
  });

  test("matches the expected bootstrap", () => {
    expect(script).toMatchSnapshot();
  });

  test("fails fast", () => {
    expect(script.split("\n")[1]).toBe("set -euo pipefail");
  });

  test("binds the runner to localhost only", () => {
    expect(script).toContain("RUNNER_BIND=127.0.0.1:9000");
  });

  test("installs the built-in engine for the instance's architecture and runs created agents on it", () => {
    const lines = script.split("\n");
    expect([
      lines.some((l) => l.startsWith("curl") && l.includes("fleet-engine-x64-linux.tar.gz")),
      lines.includes("RUNNER_HARNESS_PIZZA_BOT=/opt/fleet-engine/node/bin/node /opt/fleet-engine/fleet-agent/main.js"),
    ]).toEqual([true, true]);
  });
});

describe("Bedrock check", () => {
  test("a refused or unknown model isn't usable; a rejected request still proves access", () => {
    const out = "FLEET_BEDROCK a ok\nFLEET_BEDROCK b AccessDeniedException\nFLEET_BEDROCK c ValidationException\nFLEET_BEDROCK d ResourceNotFoundException\nnoise\n";
    expect(parseBedrock(out)).toEqual({
      usable: ["a", "c"],
      refused: [
        { model: "b", reason: "AccessDeniedException" },
        { model: "d", reason: "ResourceNotFoundException" },
      ],
    });
  });
});
