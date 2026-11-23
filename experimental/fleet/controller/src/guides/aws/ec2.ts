import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DescribeInstancesCommand, EC2Client, type Instance as Ec2Instance } from "@aws-sdk/client-ec2";
import { DescribeInstanceInformationCommand, GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { fromIni, fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { attempt, errorText, fail, ok, type Outcome } from "../../outcome.js";
import type { AwsCredentials } from "../../types.js";
import { reveal, type SecretStore } from "../../vault.js";
import type { Arch, AwsPort, Ec2Host, Instance } from "./port.js";
import { awsProfiles } from "./profiles.js";

type AwsCredentialIdentityProvider = ReturnType<typeof fromNodeProviderChain>;

const readText = (path: string): Promise<string> => readFile(path, "utf8").catch(() => "");

const errorName = (e: unknown): string => (e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "");

const credentialsProvider = async (vault: SecretStore, creds: AwsCredentials): Promise<Outcome<AwsCredentialIdentityProvider>> => {
  switch (creds.kind) {
    case "default":
      return ok(fromNodeProviderChain());
    case "profile":
      return ok(fromIni({ profile: creds.profile }));
    case "keys": {
      const accessKeyId = await reveal(vault, creds.accessKeyId);
      if (!accessKeyId.ok) return accessKeyId;
      const secretAccessKey = await reveal(vault, creds.secretAccessKey);
      if (!secretAccessKey.ok) return secretAccessKey;
      return ok(() => Promise.resolve({ accessKeyId: accessKeyId.value, secretAccessKey: secretAccessKey.value }));
    }
  }
};

const tag = (i: Ec2Instance, key: string): string => i.Tags?.find((t) => t.Key === key)?.Value ?? "";

const archOf = (value: string | undefined): Arch => (value === "arm64" ? "arm64" : "x86_64");

const sdkHost = (region: string, credentials: AwsCredentialIdentityProvider): Ec2Host => {
  const ec2 = new EC2Client({ region, credentials });
  const ssm = new SSMClient({ region, credentials });
  const sts = new STSClient({ region, credentials });

  const onlineIds = async (ids: string[]): Promise<Set<string>> => {
    if (ids.length === 0) return new Set();
    const info = await ssm.send(new DescribeInstanceInformationCommand({ Filters: [{ Key: "InstanceIds", Values: ids }] }));
    return new Set((info.InstanceInformationList ?? []).filter((i) => i.PingStatus === "Online").map((i) => i.InstanceId ?? ""));
  };

  const running = async (): Promise<Ec2Instance[]> => {
    const res = await ec2.send(new DescribeInstancesCommand({ Filters: [{ Name: "instance-state-name", Values: ["running"] }] }));
    return (res.Reservations ?? []).flatMap((r) => r.Instances ?? []);
  };

  return {
    whoAmI: () =>
      attempt(async () => {
        const id = await sts.send(new GetCallerIdentityCommand({}));
        return { account: id.Account ?? "?", arn: id.Arn ?? "?" };
      }),

    canUseEc2: async () => {
      try {
        await ec2.send(new DescribeInstancesCommand({ DryRun: true, MaxResults: 5 }));
        return ok(undefined);
      } catch (e) {
        return errorName(e) === "DryRunOperation" ? ok(undefined) : fail(`EC2 access denied: ${errorText(e)}`);
      }
    },

    instances: () =>
      attempt(async () => {
        const found = await running();
        const online = await onlineIds(found.map((i) => i.InstanceId ?? ""));
        return found.map(
          (i): Instance => ({ id: i.InstanceId ?? "", name: tag(i, "Name"), type: i.InstanceType ?? "", arch: archOf(i.Architecture), ssmOnline: online.has(i.InstanceId ?? "") }),
        );
      }),

    sendScript: (instanceId, script) =>
      attempt(async () => {
        const res = await ssm.send(
          new SendCommandCommand({ InstanceIds: [instanceId], DocumentName: "AWS-RunShellScript", Parameters: { commands: script.split("\n") }, TimeoutSeconds: 900 }),
        );
        return res.Command!.CommandId!;
      }),

    scriptResult: async (instanceId, commandId) => {
      try {
        const res = await ssm.send(new GetCommandInvocationCommand({ InstanceId: instanceId, CommandId: commandId }));
        const status = res.Status ?? "Pending";
        const done = !["Pending", "InProgress", "Delayed"].includes(status);
        return ok({ done, ok: status === "Success", output: `${res.StandardOutputContent ?? ""}\n${res.StandardErrorContent ?? ""}` });
      } catch (e) {
        return errorName(e) === "InvocationDoesNotExist" ? ok({ done: false, ok: false, output: "" }) : fail(errorText(e));
      }
    },
  };
};

export const sdkAwsPort = (vault: SecretStore): AwsPort => ({
  profiles: async () => {
    const dir = join(homedir(), ".aws");
    const [config, credentials] = await Promise.all([
      readText(process.env.AWS_CONFIG_FILE ?? join(dir, "config")),
      readText(process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(dir, "credentials")),
    ]);
    return awsProfiles(config, credentials);
  },
  host: async (creds, region) => {
    const provider = await credentialsProvider(vault, creds);
    return provider.ok ? ok(sdkHost(region, provider.value)) : provider;
  },
});
