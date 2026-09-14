/**
 * Static answers for app-server methods the original Desktop renderer needs at
 * startup but which the Windows follower bus does not expose. The Desktop
 * keeps the real configuration; these values only let the renderer boot.
 */
type ModelEntry = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  isDefault: boolean;
};

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
  ultra: "Maximum reasoning with automatic task delegation",
};

const MODELS: ModelEntry[] = [
  {
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    description: "Our most capable model for complex, demanding work.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: true,
  },
  {
    id: "gpt-5.6-sol",
    model: "gpt-5.6-sol",
    displayName: "GPT-5.6-Sol",
    description: "Reliable agentic workhorse for everyday tasks.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "low",
    inputModalities: ["text", "image"],
    isDefault: false,
  },
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    description: "Balanced agentic coding model for everyday work.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: false,
  },
  {
    id: "gpt-5.6-luna",
    model: "gpt-5.6-luna",
    displayName: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: false,
  },
  {
    id: "gpt-5.5",
    model: "gpt-5.5",
    displayName: "GPT-5.5",
    description: "Proven previous-generation model for coding and general work.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: false,
  },
  {
    id: "gpt-5.3-codex-spark",
    model: "gpt-5.3-codex-spark",
    displayName: "GPT-5.3-Codex-Spark",
    description: "Ultra-fast coding model.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
    inputModalities: ["text"],
    isDefault: false,
  },
];

export function defaultModelList(extraModelIds: string[] = []): any {
  const data = MODELS.map((m) => ({
    id: m.id,
    model: m.model,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: m.displayName,
    description: m.description,
    modelSpecialty: null,
    hidden: m.hidden,
    supportedReasoningEfforts: m.supportedReasoningEfforts.map((effort) => ({
      reasoningEffort: effort,
      description: EFFORT_DESCRIPTIONS[effort] ?? "",
    })),
    defaultReasoningEffort: m.defaultReasoningEffort,
    inputModalities: m.inputModalities,
    supportsPersonality: false,
    multiAgentVersion: "v2",
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: m.isDefault,
  }));
  const base = data[0]!;
  for (const id of extraModelIds)
    if (typeof id === "string" && id && !data.some((m) => m.id === id))
      data.push({
        ...base,
        id,
        model: id,
        displayName: id,
        description: "Model selected in Codex Desktop.",
        hidden: false,
        isDefault: false,
      });
  return { data, nextCursor: null };
}

export function defaultConfig(model: string | null): any {
  return {
    config: {
      model: model ?? "gpt-6-astra",
      review_model: null,
      model_context_window: null,
      model_auto_compact_token_limit: null,
      model_provider: null,
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: [],
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
      forced_chatgpt_workspace_id: null,
      forced_login_method: null,
      web_search: null,
      tools: null,
      instructions: null,
      developer_instructions: null,
      model_reasoning_effort: "medium",
      model_reasoning_summary: "concise",
      model_verbosity: null,
      service_tier: null,
      analytics: null,
      apps: null,
      browser_use: null,
      computer_use: null,
      desktop: null,
      skills: null,
      plugins: {},
      marketplaces: {},
      mcp_servers: {},
      model_providers: {},
      projects: {},
      profiles: {},
      profile: null,
      features: {},
      windows: null,
      notify: null,
      hooks: null,
      history: null,
      tui: null,
      personality: null,
      memories: null,
      goals: null,
      agents: null,
      orchestrator: null,
      realtime: null,
      notice: null,
      otel: null,
      audio: null,
      feedback: null,
      permissions: null,
      default_permissions: null,
      project_root_markers: [".git"],
      chatgpt_base_url: null,
      openai_base_url: null,
      check_for_update_on_startup: false,
      show_raw_agent_reasoning: false,
      hide_agent_reasoning: false,
      include_apps_instructions: true,
      include_environment_context: true,
      include_collaboration_mode_instructions: true,
      include_permissions_instructions: true,
    },
    origins: {},
  };
}

export const PERMISSION_PROFILES = {
  data: [
    { id: ":read-only", description: null, allowed: true },
    { id: ":workspace", description: null, allowed: true },
    { id: ":danger-full-access", description: null, allowed: true },
  ],
  nextCursor: null,
};

export const COLLABORATION_MODES = {
  data: [
    { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
    { name: "Default", mode: "default", model: null, reasoning_effort: null },
  ],
};
