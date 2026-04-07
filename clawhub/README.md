# RedDwarf ClawHub Skills

This directory contains the ClawHub-published versions of RedDwarf's governance
skills. Each skill is self-contained with its own SOUL, IDENTITY, and AGENTS
context so it can function standalone in any OpenClaw workspace without requiring
a full RedDwarf deployment.

## Published Skills

| Skill | ClawHub ID | Description |
|-------|-----------|-------------|
| `reddwarf-architect-planning` | `reddwarf/architect-planning` | Holly's issue-to-architecture-plan skill |
| `reddwarf-developer-implementation` | `reddwarf/developer-implementation` | Lister's plan implementation skill |
| `reddwarf-code-review` | `reddwarf/code-review` | Kryten's architecture conformance review skill |
| `reddwarf-validation` | `reddwarf/validation` | Kryten's bounded validation check skill |

## Usage

To install a RedDwarf governance skill into any OpenClaw workspace:

```
openclaw skills install reddwarf/architect-planning
```

Or search for RedDwarf skills from Holly's planning session:

```
openclaw skills search "architecture planning"
```

## Feature Flag

Dynamic skill discovery in Holly's planning phase is controlled by:

```
REDDWARF_CLAWHUB_ENABLED=false
```

When enabled, Holly can search ClawHub for framework-specific skills during
planning and install them into the current session workspace. Only skills from
verified publishers or the curated allowlist are installed.
