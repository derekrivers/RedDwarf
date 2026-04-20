import { z } from "zod";
import { isoDateTimeSchema, jsonValueSchema } from "./enums.js";
import { projectSpecSchema } from "./planning.js";

/**
 * Project Mode — Direct ProjectSpec injection contract.
 *
 * Accepts a pre-built ProjectSpec plus Context-side provenance and
 * deposits the project into the same pending_approval state that a
 * Project Mode planning run reaches. See also feature 96 (direct task
 * injection) for the task-level analogue.
 */

export const translationNoteKindSchema = z.enum([
  "dropped",
  "inferred",
  "downgraded",
  "grouped",
  "coerced"
]);

export const translationNoteSeveritySchema = z.enum(["info", "warning"]);

export const translationNoteSchema = z.object({
  kind: translationNoteKindSchema,
  canonicalPath: z.string().min(1),
  projectSpecPath: z.string().min(1).nullable(),
  reason: z.string().min(1),
  severity: translationNoteSeveritySchema
});

export const projectInjectionProvenanceSchema = z.object({
  context_spec_id: z.string().min(1),
  context_version: z.number().int().nonnegative(),
  adapter_version: z.string().min(1),
  target_schema_version: z.string().min(1),
  translation_notes: z.array(translationNoteSchema).default([])
});

export const projectInjectionRequestSchema = z.object({
  projectSpec: projectSpecSchema,
  provenance: projectInjectionProvenanceSchema
});

export const projectInjectionResponseSchema = z.object({
  project_id: z.string().min(1),
  state: z.string().min(1),
  provenance_id: z.string().min(1),
  deduplicated: z.boolean(),
  metadata: z.record(jsonValueSchema).optional()
});

export const projectSpecProvenanceSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  context_spec_id: z.string().min(1),
  context_version: z.number().int().nonnegative(),
  adapter_version: z.string().min(1),
  target_schema_version: z.string().min(1),
  injected_at: isoDateTimeSchema,
  injected_by: z.string().min(1).nullable(),
  translation_notes: z.array(translationNoteSchema)
});

export type TranslationNote = z.infer<typeof translationNoteSchema>;
export type TranslationNoteKind = z.infer<typeof translationNoteKindSchema>;
export type ProjectInjectionProvenance = z.infer<
  typeof projectInjectionProvenanceSchema
>;
export type ProjectInjectionRequest = z.infer<typeof projectInjectionRequestSchema>;
export type ProjectInjectionResponse = z.infer<typeof projectInjectionResponseSchema>;
export type ProjectSpecProvenance = z.infer<typeof projectSpecProvenanceSchema>;
