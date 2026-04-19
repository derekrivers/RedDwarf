import { z } from "zod";
import { capabilitySchema, riskClassSchema } from "./enums.js";

// Feature 187 — Task playbooks.
//
// A playbook is a small, reusable bundle that captures the typical shape of
// a recurring task class — "bump a dependency", "add a new endpoint", "ship
// a docs update". Intake matches an issue's labels against the catalogue to
// pick a playbook, then stuffs the playbook id and hints into the planning
// task's metadata so Holly sees them as additional context (not as an
// override of policy).
//
// v1 keeps the schema deliberately minimal so a playbook stays
// human-editable. Validator rules and reviewer rubrics ship as free-form
// hint arrays for now; future revisions can promote them to typed structures
// once we know which patterns actually pay off.

export const playbookIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: "Playbook ids must be lowercase kebab-case identifiers."
  });

export const playbookSchema = z.object({
  id: playbookIdSchema,
  /** Human-readable name shown in the dashboard and prompts. */
  name: z.string().min(1).max(120),
  /** One- or two-sentence summary of when this playbook applies. */
  description: z.string().min(1).max(500),
  /** Labels that, when present on a GitHub issue, opt the task into this
   * playbook. Compared case-insensitively against `candidate.labels`. */
  matchLabels: z.array(z.string().min(1)).default([]),
  /** Suggested risk class — operators can override at submission time. */
  riskClass: riskClassSchema,
  /** Path globs (or literal paths) the architect should expect the work to
   * land within. Surfaced to Holly as guidance, not enforcement. */
  allowedPaths: z.array(z.string().min(1)).default([]),
  /** Capabilities the playbook ordinarily expects to be granted. */
  requiredCapabilities: z.array(capabilitySchema).default([]),
  /** Free-form bullet list shown to the architect prompt as additional
   * context — invariants, references, "look at file X first", etc. */
  architectHints: z.array(z.string().min(1)).default([]),
  /** Validator-side rules the developer should respect; surfaced in the
   * Validator agent prompt as supplementary guidance. */
  validatorRules: z.array(z.string().min(1)).default([]),
  /** Reviewer-side rubric points; consumed by the architecture-reviewer
   * agent in a future revision. */
  reviewerRubric: z.array(z.string().min(1)).default([])
});

export const playbookCatalogueSchema = z.array(playbookSchema);

export type Playbook = z.infer<typeof playbookSchema>;
export type PlaybookCatalogue = z.infer<typeof playbookCatalogueSchema>;
