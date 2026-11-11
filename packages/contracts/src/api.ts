import { z } from "zod";
import { AgentStatusSchema, ProviderIdSchema } from "./enums";

const id = z.string().min(1).max(64);

export const SignupSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(100),
  organizationName: z.string().trim().min(1).max(100),
});
export const LoginSchema = z.object({ email: z.email().max(254), password: z.string().min(1).max(200) });

export const AgentCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.string().trim().min(1).max(200),
  instructions: z.string().max(20_000).default(""),
  provider: ProviderIdSchema,
  model: z.string().trim().min(1).max(100),
  allowedTools: z.array(z.string().min(1).max(64)).max(32).default([]),
  maxIterations: z.number().int().min(1).max(50).default(8),
  maxRunCostUsd: z.number().min(0).max(100).default(1),
  maxRunTokens: z.number().int().min(1000).max(2_000_000).nullable().default(null),
  status: AgentStatusSchema.default("active"),
  skillIds: z.array(id).max(20).default([]),
});
export type AgentCreate = z.infer<typeof AgentCreateSchema>;
export const AgentUpdateSchema = AgentCreateSchema.partial();
export type AgentUpdate = z.infer<typeof AgentUpdateSchema>;

export const TaskCreateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("single"),
    agentId: id,
    title: z.string().trim().min(1).max(200),
    instruction: z.string().trim().min(1).max(20_000),
  }),
  z.object({
    kind: z.literal("pipeline"),
    title: z.string().trim().min(1).max(200),
    instruction: z.string().trim().min(1).max(20_000),
    steps: z
      .array(z.object({ agentId: id, instruction: z.string().trim().min(1).max(20_000) }))
      .length(2, "Milestone 1 pipelines have exactly two sequential steps"),
  }),
]);
export type TaskCreate = z.infer<typeof TaskCreateSchema>;

export const ChatMessageCreateSchema = z.object({ content: z.string().trim().min(1).max(20_000) });
export const ConversationCreateSchema = z.object({ title: z.string().trim().max(200).optional() });

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(2000).optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const SkillCreateSchema = z.object({
  name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "lowercase letters, digits and dashes"),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(20_000),
});

export const WorkspaceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  defaultProvider: ProviderIdSchema.nullable().optional(),
  defaultModel: z.string().max(100).nullable().optional(),
});

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export interface ProviderInfo {
  id: string;
  label: string;
  configured: boolean;
  isMock: boolean;
  models: { id: string; label: string; inputPerMTok: number; outputPerMTok: number }[];
}
