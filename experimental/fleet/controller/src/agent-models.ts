/** Models offered when creating an agent: Bedrock US cross-region inference profiles. */
export const AGENT_MODELS: readonly { id: string; label: string }[] = [
  { id: "us.anthropic.claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "us.anthropic.claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "us.anthropic.claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "us.openai.gpt-6.1-terra", label: "GPT-6.1 Terra" },
  { id: "us.amazon.nova-2-lite-v1:0", label: "Amazon Nova 2 Lite" },
];
