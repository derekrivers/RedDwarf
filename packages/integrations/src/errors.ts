export class V1MutationDisabledError extends Error {
  public readonly action: string;

  constructor(action: string) {
    super(`${action} is disabled in RedDwarf v1 and requires human approval.`);
    this.name = "V1MutationDisabledError";
    this.action = action;
  }
}
