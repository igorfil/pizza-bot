import type { Outcome } from "../../outcome.js";
import type { AwsCredentials } from "../../types.js";

export type AwsProfile = { name: string; region: string | null };

export type Arch = "arm64" | "x86_64";

export type Instance = { id: string; name: string; type: string; arch: Arch; ssmOnline: boolean };

/** What the AWS guide needs from one account and region. */
export interface Ec2Host {
  whoAmI(): Promise<Outcome<{ account: string; arn: string }>>;
  canUseEc2(): Promise<Outcome<void>>;
  /** Regions enabled for the account; opt-in regions not turned on are left out. */
  regions(): Promise<Outcome<string[]>>;
  instances(): Promise<Outcome<Instance[]>>;
  sendScript(instanceId: string, script: string): Promise<Outcome<string>>;
  scriptResult(instanceId: string, commandId: string): Promise<Outcome<{ done: boolean; ok: boolean; output: string }>>;
}

export interface AwsPort {
  profiles(): Promise<AwsProfile[]>;
  host(credentials: AwsCredentials, region: string): Promise<Outcome<Ec2Host>>;
}
