import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { RunEvent } from "@reddwarf/contracts";
import type { DashboardApiClient, RunDetailResponse } from "../types/dashboard";
import { getCrewPersona, type CrewPersona } from "../lib/crew-personas";

interface FeedMessage {
  eventId: string;
  persona: CrewPersona;
  message: string;
  detail: string | null;
  status: string | null;
  phase: string;
  level: string;
  timestamp: Date;
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);

  if (diffSeconds < 10) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

function statusDot(status: string | null): string {
  switch (status) {
    case "done":
      return "bg-green";
    case "active":
      return "bg-blue";
    case "failed":
      return "bg-red";
    case "skipped":
      return "bg-secondary";
    default:
      return "";
  }
}

function eventToMessage(event: RunEvent): FeedMessage {
  const persona = getCrewPersona(event.phase);
  const status =
    typeof event.data["status"] === "string" ? event.data["status"] : null;
  const detail =
    typeof event.data["detail"] === "string" ? event.data["detail"] : null;

  return {
    eventId: event.eventId,
    persona,
    message: event.message,
    detail,
    status,
    phase: event.phase,
    level: event.level,
    timestamp: new Date(event.createdAt)
  };
}

function CrewAvatar(props: { persona: CrewPersona }) {
  const { persona } = props;

  return (
    <div
      className="crew-feed-avatar"
      style={{
        backgroundColor: persona.accentBg,
        color: persona.accentColor,
        borderColor: persona.accentColor
      }}
    >
      <img
        alt={persona.name}
        className="crew-feed-avatar-img"
        src={persona.avatar}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
          (e.currentTarget.nextElementSibling as HTMLElement).style.display = "";
        }}
      />
      <span className="crew-feed-avatar-fallback" style={{ display: "none" }}>
        {persona.initial}
      </span>
    </div>
  );
}

function FeedMessageBubble(props: { message: FeedMessage }) {
  const { message } = props;

  return (
    <div className="crew-feed-message">
      <CrewAvatar persona={message.persona} />
      <div className="crew-feed-body">
        <div className="d-flex align-items-center gap-2 mb-1">
          <span
            className="fw-bold"
            style={{ color: message.persona.accentColor }}
          >
            {message.persona.name}
          </span>
          <span className="text-secondary" style={{ fontSize: "0.75rem" }}>
            {message.persona.role}
          </span>
          <span
            className="text-secondary ms-auto"
            style={{ fontSize: "0.6875rem" }}
          >
            {formatRelativeTime(message.timestamp)}
          </span>
        </div>
        <div className="crew-feed-text">
          {message.status ? (
            <span
              className={`crew-feed-status-dot ${statusDot(message.status)}`}
            />
          ) : null}
          {message.message}
        </div>
        {message.detail ? (
          <div className="crew-feed-detail">{message.detail}</div>
        ) : null}
      </div>
    </div>
  );
}

export function CrewFeedPanel(props: { apiClient: DashboardApiClient }) {
  const { apiClient } = props;

  const runsQuery = useQuery({
    queryKey: ["crew-feed-runs"],
    queryFn: () => apiClient.getPipelineRuns({ limit: 10 }),
    refetchInterval: 10000
  });

  const recentRunIds = useMemo(() => {
    const runs = runsQuery.data?.runs ?? [];
    return runs.slice(0, 5).map((run) => run.runId);
  }, [runsQuery.data?.runs]);

  const detailQueries = useQueries({
    queries: recentRunIds.map((runId) => ({
      queryKey: ["crew-feed-detail", runId],
      queryFn: () => apiClient.getRunDetail(runId),
      refetchInterval: 8000,
      staleTime: 5000
    }))
  });

  const feedMessages = useMemo(() => {
    const messages: FeedMessage[] = [];

    detailQueries.forEach((query) => {
      const detail: RunDetailResponse | undefined = query.data;
      if (!detail) return;

      detail.events.forEach((event) => {
        if (
          event.code === "AGENT_PROGRESS_ITEM" ||
          event.code === "PHASE_RUNNING" ||
          event.code === "PHASE_PASSED" ||
          event.code === "PHASE_FAILED" ||
          event.code === "PHASE_BLOCKED" ||
          event.code === "WORKSPACE_PROVISIONED" ||
          event.code === "BRANCH_CREATED" ||
          event.code === "PULL_REQUEST_CREATED" ||
          event.code === "OPENCLAW_DISPATCH" ||
          event.code === "PIPELINE_STARTED" ||
          event.code === "PIPELINE_COMPLETED"
        ) {
          messages.push(eventToMessage(event));
        }
      });
    });

    messages.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return messages.slice(0, 30);
  }, [detailQueries]);

  const isLoading =
    runsQuery.isLoading ||
    (recentRunIds.length > 0 && detailQueries.every((q) => q.isLoading));

  return (
    <div className="card crew-feed-card">
      <div className="card-header">
        <h3 className="card-title d-flex align-items-center gap-2">
          <span
            className="status-dot status-dot-animated bg-green"
            style={{ width: 8, height: 8 }}
          />
          Crew Feed
        </h3>
        <span className="card-subtitle text-secondary">
          Live updates from the crew
        </span>
      </div>
      <div className="crew-feed-scroll">
        {isLoading ? (
          <div className="empty py-4">
            <div className="spinner-border text-red" role="status" />
            <p className="empty-title mt-2">Tuning in to the crew...</p>
          </div>
        ) : feedMessages.length === 0 ? (
          <div className="empty py-4">
            <p className="empty-title">No crew activity yet.</p>
            <p className="empty-subtitle text-secondary">
              Updates will appear here when agents start working.
            </p>
          </div>
        ) : (
          feedMessages.map((message) => (
            <FeedMessageBubble key={message.eventId} message={message} />
          ))
        )}
      </div>
    </div>
  );
}
