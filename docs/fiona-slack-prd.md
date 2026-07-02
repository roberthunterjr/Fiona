# Fiona — Product Requirements Document

> **Status:** Living document — updated as the product evolves \
> **Owner:** Ed-Fi Alliance, AI Team \
> **Jira Project:** AI \
> **Repository:** `Ed-Fi-Alliance-OSS/Fiona` (monorepo)

## 1. Product Overview

Fiona is an AI-powered Slack assistant that helps the Ed-Fi community navigate
documentation, standards, APIs, and implementation guidance through natural
language conversation. She is available as a Slack bot via @-mentions in
channels, direct messages, and the Slack Assistant side panel.

### 1.1 Strategic Alignment

Fiona enables the Ed‑Fi Alliance’s 2026 strategy to scale data hubs and
market‑led integrations by turning authoritative standards, implementation
guidance, and best practices into an always‑available AI knowledge layer that
accelerates vendor onboarding, strengthens SEA execution, and keeps national
growth aligned to the Ed‑Fi Data Standard.

### 1.2 Product Description

> *AI Powered Ed-Fi Knowledge and Documentation Retrieval*
>
> Fiona is your AI companion designed to super-charge your navigation through
> Ed-Fi documentation, best practices and community resources. Get personalized
> guidance through Ed-Fi tools and resources using natural language.

### 1.3 Target Users

- Ed-Fi community members in Slack (educators, technologists, administrators),
  covering all market segments and geographies.
- Internal Ed-Fi Alliance staff

### 1.4 Design Principles

- **Meet users where they are** — Fiona lives inside Slack, not a separate tool.
- **Accuracy over speculation** — When unsure, Fiona says so rather than
  guessing.
- **Graceful degradation** — Optional subsystems (feedback storage, rate
  limiting) fail silently rather than blocking the user.
- **Provider flexibility** — The LLM backend is swappable without code changes.

## 2. Functional Requirements

### 2.1 Conversation Entry Points

| Entry Point         | Trigger                                                          | Slack Event                            |
| ------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| **Channel mention** | User types `@Fiona <question>` in any channel the bot has joined | `app_mention`                          |
| **Direct message**  | User sends a DM to Fiona                                         | `message.im` (via Assistant framework) |
| **Assistant panel** | User opens the Slack Assistant side panel                        | `assistant_thread_started`             |

All entry points funnel into the same LLM pipeline and produce streamed
responses.

#### 2.1.1 Empty Message Handling

When a user mentions Fiona with no text (or text that is only Slack mention
tokens like `<@U123>`), Fiona responds with a brief self-introduction rather
than sending an empty prompt to the LLM.

#### 2.1.2 Assistant Panel Behavior

- On thread start: sends a greeting ("Hi, how can I help?") and saves thread
  context.
- Suggested prompts are shown only in DMs (not when the panel is opened from
  within a channel).
- Context changes (user navigates to a different channel) are tracked and saved.

### 2.2 LLM Integration

Fiona calls the [Perplexity Sonar API](https://docs.perplexity.ai/) for grounded,
citation-backed responses. Authentication uses `PERPLEXITY_API_KEY`, injected via
environment variable.

#### 2.2.1 Streaming

All responses are streamed to Slack in real time using Slack's `chatStream` API.
Users see text appear progressively rather than waiting for a complete response.

#### 2.2.2 System Prompt

A default system prompt defines Fiona's persona, guidelines, and guardrails. It
can be overridden via the `SYSTEM_PROMPT` environment variable.

> **Known issue (AI-49):** This keyword routing operates on untrusted user input
> and should be reviewed for potential abuse.

#### 2.2.3 Citations (AI-58)

When Perplexity is used as the primary provider or invoked via the
`perplexity_search` tool, the API returns a list of source URLs alongside the
generated text. Fiona processes these to produce inline hyperlinks in the
streamed response.

**How it works:**

1. The system prompt instructs the LLM to place numeric citation markers
   (`[1]`, `[2]`, …) at the end of factual claims grounded in external sources.
2. As Perplexity streams its response, citation URLs are collected, normalized,
   deduplicated, and assigned stable 1-based indices.
3. Each `[n]` marker in the streamed text is replaced in real time with a Slack
   mrkdwn hyperlink: `<url|[n]>`.

No separate "Sources" block is appended to the message; citations appear only
as inline links within the answer text.

**Metadata lifecycle (strict consistency):**

To ensure citation indices in the text always correspond to real source URLs,
`callLLM` maintains a metadata envelope that advances through a state machine
before the stream is finalized:

| State                  | Meaning                                             |
| ---------------------- | --------------------------------------------------- |
| `streaming_text`       | Initial state; LLM is generating text               |
| `collecting_metadata`  | Citation URLs are being aggregated from Perplexity  |
| `ready_to_finalize`    | Metadata resolved; ready to close the stream        |
| `finalized`            | Stream closed; envelope is immutable                |
| `degraded_no_metadata` | Timeout expired before metadata arrived; no links   |

If the metadata does not arrive within `CITATION_METADATA_TIMEOUT_MS`
(default: 2 000 ms), the envelope transitions to `degraded_no_metadata` and
the response is finalized with plain `[n]` markers left as-is.

**Source normalization:**

- Only `http://` and `https://` URLs are accepted (blocks `javascript:`,
  `data:`, `vbscript:`).
- Duplicate URLs are dropped; first-seen ordering is preserved.
- Titles are derived from the URL path when no explicit title is provided.
- The source list is capped at `CITATION_MAX_SOURCES` (default: 10).

**Security hardening:**

- The `source_index_map` is created with `Object.create(null)` to prevent
  prototype pollution from external URL keys.
- mrkdwn special characters (including underscores) in evidence snippets are
  escaped before rendering.

**Citation policy env vars** (see also §7):

| Variable                       | Default | Purpose                                         |
| ------------------------------ | ------- | ----------------------------------------------- |
| `CITATION_RENDERING_ENABLED`   | `true` in non-prod, `false` when `NODE_ENV=production` | Master switch for inline link rendering |
| `CITATION_MAX_SOURCES`         | `10`    | Maximum sources normalised per response         |
| `CITATION_METADATA_TIMEOUT_MS` | `2000`  | Milliseconds to wait for citation metadata      |
| `CITATION_INCLUDE_EVIDENCE`    | `false` | Include evidence snippets (feature flag)        |

**Telemetry:** `citation-telemetry.js` records per-response metadata wait
durations and source counts (bounded arrays, capped at 1 000 entries) for
future observability dashboards.

> **Known issue (AI-93):** The `finalizedResponses` Set used for idempotency
> has no eviction strategy; it grows unbounded over time.

### 2.3 Tools

The LLM can invoke tools during a conversation. Tool calls are displayed to the
user as task status updates (in-progress, complete, error).

| Tool                | Purpose                                   | Parameters                               |
| ------------------- | ----------------------------------------- | ---------------------------------------- |
| `roll_dice`         | Random number generation / demonstrations | `sides` (default 6), `count` (default 1) |
| `perplexity_search` | Real-time web search via Perplexity Sonar | `query` (required)                       |

The `perplexity_search` tool is only registered when a Perplexity client is
configured and the primary provider is *not* Perplexity (since Perplexity
inherently searches the web).

Search results are filtered to configurable domains (default:
`www.ed-fi.org`, `docs.ed-fi.org`).

> **Known issue (AI-43):** Tool call execution uses unbounded recursion. If the
> LLM repeatedly requests tool calls, the stack could overflow.

### 2.4 Rate Limiting

A per-user sliding-window rate limiter prevents abuse.

| Parameter               | Default               | Env Var                   |
| ----------------------- | --------------------- | ------------------------- |
| Max requests per window | 20                    | `RATE_LIMIT_MAX_REQUESTS` |
| Window duration         | 1 hour (3,600,000 ms) | `RATE_LIMIT_WINDOW_MS`    |

- Setting `RATE_LIMIT_MAX_REQUESTS=0` disables rate limiting entirely.
- Rate limit state is stored in-memory and resets on process restart.
- When rate-limited, users see: *":no_entry: You've reached the request limit.
  Please wait X minute(s) before trying again."*

### 2.5 User Feedback

Each LLM response includes "Good Response" and "Bad Response" buttons. Clicking
a button opens a modal to collect optional (thumbs-up) or required (thumbs-down)
feedback reasons.

**Feedback workflow:**

1. User clicks "Good Response" or "Bad Response" on a Fiona message.
2. A Slack modal opens:
   - **Thumbs-up:** title "Thanks for your feedback!", reason input is optional
   - **Thumbs-down:** title "Sorry to hear that!", reason input is required
3. User submits the modal (or cancels/closes without submitting).
4. If submitted, an ephemeral confirmation is posted and feedback is optionally
   recorded to Azure Cosmos DB (if configured).
5. If cancelled/closed without submitting, no feedback is recorded.

Feedback records capture the complete interaction—user request, AI response, and
optional reason—to enable analysis and continuous improvement of Fiona's guidance
quality. Records are automatically purged after 90 days.

**Feedback document schema:**

| Field            | Description                                                      |
| ---------------- | ---------------------------------------------------------------- |
| `feedbackId`     | `{userId}_{messageTs}` — composite key enabling upsert on change |
| `userId`         | Slack user ID                                                    |
| `channelId`      | Slack channel ID                                                 |
| `messageTs`      | Message timestamp                                                |
| `value`          | `good-feedback` or `bad-feedback`                                |
| `reason`         | User-provided reason (string or null)                            |
| `userMessage`    | The user's original prompt (retrieved from thread history)       |
| `botResponse`    | Fiona's response text                                            |
| `deploymentType` | `local`, `insiders`, or `production`                             |
| `timestamp`      | ISO 8601 timestamp                                               |
| `ttl`            | Time-to-live (seconds). Cosmos DB automatically deletes records after 90 days (7,776,000 seconds) |

**Data retention:** All feedback records are subject to Cosmos DB's TTL policy
and are automatically expunged 90 days after creation.

Cosmos DB supports three authentication methods (in priority order):

1. Connection string (`COSMOS_CONNECTION_STRING`)
1. Endpoint + key (`COSMOS_ENDPOINT` + `COSMOS_KEY`)
1. Managed identity (`COSMOS_ENDPOINT` only, uses `DefaultAzureCredential`)

If Cosmos DB is not configured, feedback is acknowledged to the user but not
persisted.

### 2.6 Slack Users Store

Fiona resolves Slack user IDs to human-readable names and email addresses by
querying the `slack-users` CosmosDB container. This enables features like
`/fiona escalate` to display user names in escalation messages and provide
meaningful context to users.

The `slack-users` container is populated via `scripts/load-slack-users.js`, which
ingests the Slack workspace member list from either the Slack API or an Admin CSV
export. Records include user ID, name, real name, email, and account status.

For detailed instructions on loading and refreshing the Slack user list, see
[Slack Users → CosmosDB](slack-users-cosmosdb.md).

### 2.7 Interaction Analytics

Every `app_mention` and assistant thread `message` event is recorded to an Azure
Cosmos DB `interactions` container for long-term engagement analysis.

**Recording behavior:**

- Rate-limited requests are recorded immediately (before the user-facing message)
  so they appear in error metrics.
- All other interactions are recorded in a `finally` block, capturing both
  successes and errors with categorized error types.
- If Cosmos DB is not configured, recording is silently skipped (no-op).
- The record ID is `{userId}_{threadTs}_{messageTs}`, providing idempotency on
  Slack event redelivery.

**Interaction document schema:**

| Field             | Description                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| `id`              | `{userId}_{threadTs}_{messageTs}` — composite key for idempotency      |
| `userId`          | Slack user ID (opaque token, no PII)                                   |
| `teamId`          | Slack team/workspace ID                                                |
| `channelId`       | Slack channel ID                                                       |
| `threadTs`        | Interaction session identifier (`thread_ts` for message flows, `trigger_id` for slash commands) |
| `messageTs`       | Interaction event identifier (`message_ts` for message flows, `trigger_id` for slash commands) |
| `interactionType` | `app_mention`, `assistant_message`, `slash_help`, `slash_ask`, `slash_search`, or `slash_unknown` |
| `status`          | `success` or `error`                                                   |
| `errorType`       | `rate_limited`, `llm_error`, `llm_rate_limited`, `cosmos_error`, `timeout`, `unknown` — only set when `status = error` |
| `rateLimited`     | `true` if the rate limiter blocked this request                        |
| `deploymentType`  | `local`, `insiders`, or `production`                                   |
| `timestamp`       | ISO 8601 timestamp                                                     |

> [!NOTE]
> Message content is deliberately excluded from interaction records. Only
> metadata is stored, preserving user privacy.

### 2.8 Weekly Usage Report

A separate Azure Function (`apps/usage-report-function`) runs on a configurable
cron schedule (default: 9 AM UTC every Monday) and posts an engagement summary
to a Slack channel via incoming webhook.

**KPIs reported:**

| Metric                  | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| Distinct users          | Count of unique users with successful interactions       |
| Sessions                | Count of distinct session identifiers (`threadTs`) across successful, non-rate-limited interactions |
| Total interactions      | All interactions (success + error) in the window         |
| Error count & rate      | Absolute count and percentage of errored interactions    |
| Rate-limited hits       | Count of rate-limiter blocks                             |
| Good / bad feedback     | Feedback button click counts                             |
| Feedback ratio          | `good / (good + bad) * 100`                              |
| Avg interactions / user | Mean interactions per active user                        |
| Feedback response rate  | Percentage of successful interactions that were rated    |

The lookback window defaults to the past 7 days. The webhook URL is retrieved
from Azure Key Vault at runtime using Managed Identity.

### 2.9 Loading / Status Messages

While processing, Fiona sets a "thinking..." status with a randomly selected
loading message:

- *Teaching the hamsters to type faster...*
- *Untangling the internet cables...*
- *Consulting the office goldfish...*
- *Polishing up the response just for you...*
- *Convincing the AI to stop overthinking...*

### 2.10 Fiona Skills (Slash Commands)

Fiona exposes a set of **Skills** through the `/fiona` slash command, giving
users quick access to structured actions without needing to @-mention Fiona or
compose a conversational prompt. Skills complement the existing conversation
entry points (§2.1) and are registered as a single Slack slash command with
sub-command routing.

**Available skills:** `/fiona help`, `/fiona ask`, `/fiona search`,
`/fiona escalate`.

**Escalation detection:** In addition to the explicit `/fiona escalate` command,
Fiona monitors regular conversation for escalation intent (e.g., the word
"escalate") and proactively offers to escalate via interactive buttons.

> For full requirements, UX flows, and acceptance criteria see
> **[Fiona Skills PRD](fiona-skills-prd.md)**.

## 3. Non-Functional Requirements

### 3.1 Implemented

| Category                  | Requirement                                                             | Implementation                                                                               |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Availability**          | Bot must maintain a persistent connection to Slack                      | Fixed 1-replica deployment; Socket Mode (outbound WebSocket) eliminates ingress dependencies |
| **Security — Auth**       | Azure services use Entra ID where possible                              | `DefaultAzureCredential` for Cosmos DB managed identity                                      |
| **Security — Secrets**    | Secrets are not stored in code                                          | Environment variables injected at runtime; `.env` in `.gitignore`                            |
| **Security — Guardrails** | LLM must not generate harmful content or leak its system prompt         | System prompt includes explicit guidelines; persona constraints; domain filtering            |
| **Resilience**            | Optional subsystems must not block core functionality                   | Cosmos DB feedback, rate limiting degrade gracefully                                         |
| **Code Quality**          | Consistent formatting and linting                                       | Biome 2.x with 120-char line width, single quotes, LF line endings                           |
| **Testing**               | Comprehensive unit test coverage                                        | Jest with 100% coverage target; all listeners, tools, and agent modules covered              |
| **CI/CD**                 | Automated build and deploy                                              | GitHub Actions → Docker build → ACR push → Azure Container Apps via Bicep                    |
| **Observability**         | Configurable log verbosity                                              | `LOG_LEVEL` env var (debug, info, warn, error)                                               |
| **Observability**         | Usage analytics and weekly engagement reporting                         | Every interaction recorded to Cosmos DB `interactions` container; weekly summary posted to Slack via Azure Function |
| **Thread context**        | Send thread context with each message to enable context-aware responses | Listeners retrieve channel history and include recent messages in LLM prompt                 |

### 3.2 Suggested (Not Yet Implemented)

| Category          | Requirement                                                   | Notes                                                                                | Related Jira |
| ----------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------ |
| **Security**      | Sanitize or redact sensitive data before writing to logs      | Error log may contain API responses with PII or keys                                 | AI-47        |
| **Reliability**   | Guard against undefined `context` in assistant thread started | Edge case when Slack sends unexpected payload shape                                  | AI-44        |
| **Observability** | Structured logging with correlation IDs                       | Enables tracing a single user request across log entries                             | —            |
| **Observability** | Azure billing and activity alerts                             | Cost guardrails for LLM and Cosmos DB usage                                          | AI-32        |
| **Scalability**   | Persistent rate-limit state                                   | Current in-memory store resets on restart; consider external store for multi-replica | —            |
| **Performance**   | Response latency SLA                                          | No target defined; should establish p50/p95 baseline                                 | AI-35        |

---

## 4. Architecture

### 4.1 Technology Stack

| Component  | Technology                                                     |
| ---------- | -------------------------------------------------------------- |
| Runtime    | Node.js 22 (Alpine for containers)                             |
| Framework  | Slack Bolt 4.x (JavaScript, ES Modules)                        |
| LLM SDKs   | `openai` 6.x (used as a thin client against the Perplexity Sonar API) |
| Database   | Azure Cosmos DB (optional, for feedback and interaction analytics) |
| Auth       | `@azure/identity` (DefaultAzureCredential)                     |
| Linting    | Biome 2.x                                                      |
| Testing    | Jest 29.x                                                      |
| Containers | Docker (node:22-alpine), Azure Container Apps                  |
| Functions  | Azure Functions v4 (Node.js), TimerTrigger                     |
| CI/CD      | GitHub Actions + Bicep                                         |

### 4.2 Deployment Topology

```none
┌──────────────────────────────────────────────┐
│  Azure Container Apps Environment            │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  fiona-slack-container                 │  │
│  │  0.25 vCPU / 0.5 Gi  ·  1 replica      │  │
│  │  No ingress (Socket Mode)              │  │
│  │                                        │  │
│  │  node src/app.js                       │  │
│  │   ├─► WebSocket ──► Slack API          │  │
│  │   ├─► HTTPS ──────► LLM Provider       │  │
│  │   └─► HTTPS ──────► Cosmos DB          │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│  Azure Function App                          │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  usage-report-function                 │  │
│  │  TimerTrigger (cron: 0 9 * * 1)        │  │
│  │                                        │  │
│  │  WeeklyReportTrigger/index.js          │  │
│  │   ├─► HTTPS ──────► Cosmos DB          │  │
│  │   ├─► HTTPS ──────► Key Vault          │  │
│  │   └─► HTTPS ──────► Slack Webhook      │  │
│  └────────────────────────────────────────┘  │
└──────────────────────────────────────────────┘
```

### 4.3 Deployment Environments

| Environment  | Purpose                  | How to Run                                                           |
| ------------ | ------------------------ | -------------------------------------------------------------------- |
| `local`      | Developer testing        | `slack run` via Slack CLI; injects into the insiders Slack sandbox   |
| `insiders`   | Pre-production           | Deployed to Azure Container Apps via CI/CD on `insiders-**` branches |
| `production` | Live community workspace | Deployed to Azure Container Apps via CI/CD on `main`                 |

### 4.4 Module Structure

**`apps/fiona-slack/src/`**

```none
src/
├── app.js                          # Entry point: Bolt init, listener registration, start
├── agent/
│   ├── llm-caller.js              # Multi-provider LLM routing, streaming, citation metadata
│   ├── rate-limiter.js            # Per-user sliding-window rate limiter
│   ├── feedback-store.js          # Cosmos DB feedback persistence
│   ├── interaction-store.js       # Cosmos DB interaction analytics persistence
│   ├── tools/
│   │   ├── dice.js                # roll_dice tool implementation
│   │   └── perplexity-search.js   # perplexity_search tool definition
│   └── utils/
│       ├── citation-telemetry.js  # Bounded telemetry arrays for metadata wait & source counts
│       ├── idempotent-finalize.js # Response-ID guard preventing duplicate finalization
│       └── source-normalizer.js   # URL validation, deduplication, title derivation, index map
└── listeners/
    ├── index.js                   # Registers all listener categories
    ├── events/
    │   └── app_mention.js         # @mention handler
    ├── assistant/
    │   ├── assistant_thread_started.js
    │   ├── assistant_thread_context_changed.js
    │   └── message.js             # Assistant thread message handler
    ├── actions/
    │   └── feedback.js            # Feedback button click handler
    └── views/
        └── feedback_block.js      # Feedback button UI block builder
```

**`apps/usage-report-function/`**

```none
WeeklyReportTrigger/
├── function.json                  # TimerTrigger binding config
└── index.js                       # Queries Cosmos DB, formats report, posts to Slack
lib/
├── cosmos-queries.js              # 8 KPI query functions (distinct users, sessions, etc.)
├── slack-formatter.js             # Formats the weekly Slack message string
└── key-vault-client.js            # Retrieves Slack webhook URL from Azure Key Vault
```

## 5. Backlog

> [!WARNING]
> This backlog is only available to Ed-Fi staff and contractors.

See [Jira roadmap board](https://edfi.atlassian.net/jira/software/c/projects/AI/boards/288) for detailed epics, stories, and progress tracking.

## 6. Slack App Configuration

**Manifest:** `apps/fiona-slack/manifest.json`

### 6.1 OAuth Scopes

| Scope               | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `commands`          | Register and receive slash commands (`/fiona`)    |
| `app_mentions:read` | Receive @mention events                           |
| `assistant:write`   | Write to Assistant threads                        |
| `channels:history`  | Read channel message history (for thread context) |
| `channels:join`     | Join public channels when invited                 |
| `chat:write`        | Send messages and streaming responses             |
| `im:history`        | Read DM history                                   |
| `groups:history`    | Read private channel history                      |

### 6.2 Event Subscriptions

`app_mention`, `assistant_thread_started`,
`assistant_thread_context_changed`, `message.im`, `/fiona` (slash command)

### 6.3 Connection Mode

Socket Mode (outbound WebSocket only — no public URL required).

---

## 7. Environment Variable Reference

See `apps/fiona-slack/.env.sample` for the canonical list with inline
documentation. Key groups:

| Group         | Variables                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| Slack         | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_API_URL`, `LOG_LEVEL`                                     |
| LLM           | `PERPLEXITY_API_KEY`, `PERPLEXITY_API_MODEL`, `PERPLEXITY_DOMAIN_FILTER`, `SYSTEM_PROMPT`              |
| Citations     | `CITATION_RENDERING_ENABLED`, `CITATION_MAX_SOURCES`, `CITATION_METADATA_TIMEOUT_MS`, `CITATION_INCLUDE_EVIDENCE` |
| Rate Limiting | `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_MS`                                                      |
| Cosmos DB     | `COSMOS_CONNECTION_STRING`, `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DATABASE`, `COSMOS_CONTAINER`, `COSMOS_INTERACTIONS_CONTAINER`, `COSMOS_USERS_CONTAINER` |
| Deployment    | `DEPLOYMENT_TYPE`                                                                                      |

### 7.2 Usage Report Function (`apps/usage-report-function`)

| Group      | Variables                                                                                                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Schedule   | `REPORT_SCHEDULE` (cron expression, default: `0 9 * * 1`)                                                        |
| Cosmos DB  | `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `COSMOS_INTERACTIONS_CONTAINER`, `COSMOS_FEEDBACK_CONTAINER`               |
| Deployment | `DEPLOYMENT_TYPE`                                                                                                |
| Key Vault  | `KEY_VAULT_URL`, `SLACK_WEBHOOK_KEYVAULT_SECRET_NAME` (secret name, default: `slack-fiona-weekly-report-webhook`) |
