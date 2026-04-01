import { z } from "zod";
import { githubIssuePollingCursorSchema } from "./evidence.js";

const githubRepoRefSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/);

export const operatorRepoCreateRequestSchema = z.object({
  repo: githubRepoRefSchema
});

export const operatorRepoListResponseSchema = z.object({
  repos: z.array(githubIssuePollingCursorSchema),
  total: z.number().int().min(0)
});

export const operatorRepoMutationResponseSchema = z.object({
  repo: githubIssuePollingCursorSchema,
  created: z.boolean()
});

export const operatorRepoDeleteResponseSchema = z.object({
  repo: githubRepoRefSchema,
  deleted: z.literal(true)
});

export type OperatorRepoCreateRequest = z.infer<
  typeof operatorRepoCreateRequestSchema
>;
export type OperatorRepoListResponse = z.infer<
  typeof operatorRepoListResponseSchema
>;
export type OperatorRepoMutationResponse = z.infer<
  typeof operatorRepoMutationResponseSchema
>;
export type OperatorRepoDeleteResponse = z.infer<
  typeof operatorRepoDeleteResponseSchema
>;
