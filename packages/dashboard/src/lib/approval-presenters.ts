import type { ApprovalRequest, TaskPhase } from "@reddwarf/contracts";

interface ApprovalUiCopy {
  phaseLabel: string;
  reviewCtaLabel: string;
  reviewBadgeLabel: string | null;
  detailLead: string;
  approveHeading: string;
  approveDescription: string;
  approveButtonLabel: string;
  approveModalTitle: string;
  approveModalBody: string;
  rejectHeading: string;
  rejectDescription: string;
  rejectButtonLabel: string;
}

function fallbackPhaseLabel(phase: TaskPhase): string {
  return phase.replaceAll("_", " ");
}

export function getApprovalUiCopy(approval: ApprovalRequest): ApprovalUiCopy {
  if (approval.phase === "architecture_review") {
    return {
      phaseLabel: "Architecture review override",
      reviewCtaLabel: "Review Override",
      reviewBadgeLabel: "Override",
      detailLead:
        "Architecture review stopped this task for human review. Approving this request will continue the task at validation.",
      approveHeading: "Approve override",
      approveDescription:
        "Accept the architecture review override and let the task continue at validation.",
      approveButtonLabel: "Approve Override",
      approveModalTitle: "Approve architecture override?",
      approveModalBody:
        "This will accept the architecture review override and continue the task at validation.",
      rejectHeading: "Reject override",
      rejectDescription:
        "Keep the architecture review block in place and record why the task should not continue.",
      rejectButtonLabel: "Reject Override"
    };
  }

  return {
    phaseLabel: fallbackPhaseLabel(approval.phase),
    reviewCtaLabel: "Review",
    reviewBadgeLabel: null,
    detailLead: "Approving this request will allow the task to continue.",
    approveHeading: "Approve",
    approveDescription: "Allow the developer phase to proceed in OpenClaw.",
    approveButtonLabel: "Approve Run",
    approveModalTitle: "Approve this run?",
    approveModalBody:
      "Are you sure you want to approve this run? This will allow the developer phase to proceed in OpenClaw.",
    rejectHeading: "Reject",
    rejectDescription: "Provide a clear reason so the operator history stays auditable.",
    rejectButtonLabel: "Reject Run"
  };
}
