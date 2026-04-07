/**
 * Maps pipeline phases to Red Dwarf crew personas for the activity feed.
 * Each crew member "owns" the phases that match their character's role.
 */

export interface CrewPersona {
  name: string;
  role: string;
  initial: string;
  accentColor: string;
  accentBg: string;
}

const holly: CrewPersona = {
  name: "Holly",
  role: "Architect",
  initial: "H",
  accentColor: "#206bc4",
  accentBg: "rgba(32, 107, 196, 0.15)"
};

const rimmer: CrewPersona = {
  name: "Rimmer",
  role: "Coordinator",
  initial: "R",
  accentColor: "#d63939",
  accentBg: "rgba(214, 57, 57, 0.15)"
};

const lister: CrewPersona = {
  name: "Lister",
  role: "Developer",
  initial: "L",
  accentColor: "#2fb344",
  accentBg: "rgba(47, 179, 68, 0.15)"
};

const kryten: CrewPersona = {
  name: "Kryten",
  role: "Validator",
  initial: "K",
  accentColor: "#ae3ec9",
  accentBg: "rgba(174, 62, 201, 0.15)"
};

const cat: CrewPersona = {
  name: "Cat",
  role: "Reviewer",
  initial: "C",
  accentColor: "#f76707",
  accentBg: "rgba(247, 103, 7, 0.15)"
};

const phasePersonaMap: Record<string, CrewPersona> = {
  intake: rimmer,
  eligibility: holly,
  planning: holly,
  policy_gate: rimmer,
  development: lister,
  architecture_review: kryten,
  validation: kryten,
  review: cat,
  scm: lister,
  archive: cat
};

/** Resolve the crew persona for a given pipeline phase. Defaults to Holly. */
export function getCrewPersona(phase: string): CrewPersona {
  return phasePersonaMap[phase] ?? holly;
}

/** Resolve the crew persona for an agentId from evidence metadata. */
export function getCrewPersonaByAgentId(agentId: string): CrewPersona {
  if (agentId.includes("coordinator")) return rimmer;
  if (agentId.includes("analyst")) return holly;
  if (agentId.includes("arch-reviewer")) return kryten;
  if (agentId.includes("validator")) return kryten;
  if (agentId.includes("developer")) return lister;
  return holly;
}
