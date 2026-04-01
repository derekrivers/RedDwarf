import { z } from "zod";
import { isoDateTimeSchema } from "./enums.js";
import { operatorSecretKeySchema } from "./operator-secrets.js";

export const operatorUiPathFieldSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
  description: z.string().min(1),
  source: z.enum(["env", "default"])
});

export const operatorUiSecretFieldSchema = z.object({
  key: operatorSecretKeySchema,
  description: z.string().min(1),
  restartRequired: z.boolean(),
  present: z.boolean(),
  maskedValue: z.string().nullable()
});

export const operatorUiOpenClawStatusSchema = z.object({
  baseUrl: z.string().url(),
  reachable: z.boolean(),
  checkedAt: isoDateTimeSchema,
  statusCode: z.number().int().positive().nullable(),
  message: z.string().nullable()
});

export const operatorUiBootstrapResponseSchema = z.object({
  appVersion: z.string().min(1),
  uptimeSeconds: z.number().nonnegative(),
  sessionTier: z.literal("operator"),
  paths: z.array(operatorUiPathFieldSchema),
  secrets: z.array(operatorUiSecretFieldSchema),
  openClaw: operatorUiOpenClawStatusSchema
});

export type OperatorUiPathField = z.infer<typeof operatorUiPathFieldSchema>;
export type OperatorUiSecretField = z.infer<typeof operatorUiSecretFieldSchema>;
export type OperatorUiOpenClawStatus = z.infer<typeof operatorUiOpenClawStatusSchema>;
export type OperatorUiBootstrapResponse = z.infer<
  typeof operatorUiBootstrapResponseSchema
>;
