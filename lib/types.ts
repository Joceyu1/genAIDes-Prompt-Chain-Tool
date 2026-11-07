import type { GenerationProvider } from "./model-catalog";

export type StepKind = "text" | "image";
export type ChainStep = {
  id: string;
  chain_id: string;
  name: string;
  prompt: string;
  kind: StepKind;
  model: string;
  position: number;
  created_at?: string;
  updated_at?: string;
  role?: string;
  model_id?: string | null;
  model_label?: string;
  model_provider?: GenerationProvider;
  generation_ready?: boolean;
};
export type PromptChain = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "active";
  created_at: string;
  updated_at: string;
  source?: string;
  steps: ChainStep[];
};
export type RunOutput = {
  step_id: string;
  step_name: string;
  kind: StepKind;
  content: string;
  image_path?: string;
};
export type ChainRun = {
  id: string;
  chain_id: string;
  status: "running" | "completed" | "failed";
  input: string;
  outputs: RunOutput[];
  error: string | null;
  created_at: string;
};
export type SessionUser = { id: string; email: string };
