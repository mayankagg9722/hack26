SLIDE 1 — ZEN
Zen
The Autonomous Enterprise Migration Agent
From manual migration projects → goal-driven, intelligent migration

Give Zen a migration goal. Zen discovers, maps, tests, migrates, remediates and explains the outcome — with humans only when needed.

What Zen does
DISCOVER
Understand source & target data

MAP
AI-powered field & entity mapping

TEST
Validate migration readiness before cutover

EXECUTE
Migrate records autonomously

REMEDIATE
Detect and fix recoverable failures

EXPLAIN
Generate migration insights with Claude

Bottom tagline
From “Can we migrate?” → “Zen knows we're ready.”

Visual: Put the six capabilities in a horizontal flow:

Discover → Map → Test → Execute → Remediate → Explain

SLIDE 2 — THE PROBLEM
Enterprise migration is more than moving data
When customers move from one ITSM platform to another, they must manage:

Discover → Map → Transform → Test → Migrate → Validate → Fix → Reconcile

Where the friction occurs
Different entities and data models
Complex field mappings and transformations
Historical records and relationships
Missing or incompatible data
API/rate-limit constraints
Migration failures and retries
Workflow / notification side effects
Manual validation and reconciliation
Freshservice's own migration documentation identifies challenges including rate limits, API flexibility, migration-triggered notifications, workflow/business-rule execution, attachment constraints and possible search/analytics delays.

The real problem
Teams spend significant effort making migration safe, complete and trustworthy — not just moving records from A → B.

Current state
Migration = APIs + scripts + specialists + manual troubleshooting

Opportunity
Migration = an autonomous agent that manages the workflow

SLIDE 3 — WHY NOW?
The technology is ready for agentic migration
1. Enterprise migration remains high-touch
Basic Freshservice onboarding can be straightforward, but the research indicates that complexity increases with customized implementations and historical data migration.

2. Freshservice provides the integration foundation
Freshservice supports:

REST API v2 + Product MCP

The Product MCP exposes resources such as tickets, requesters, workspaces, departments and other organizational data, and supports Claude as a client.

3. Migration vendors already focus on confidence
Existing migration solutions emphasize:

Mapping
Test migrations
Validation
Custom migration support
Delta migration
Human assistance
4. AI changes the operating model
Traditional

API → Script → Import → Human troubleshooting

Agentic

Goal → Discover → Reason → Map → Test → Execute → Remediate → Explain

Bottom message
The opportunity is not another migration script. It's an intelligent migration experience that gives customers confidence before, during and after migration.

SLIDE 4 — THE SOLUTION
Zen turns migration into a confidence-based workflow
User starts with a goal
“Migrate all employees and tickets from Jira Service Management to Freshservice.”

Zen automatically:
01 — DISCOVER
JSM

Customers / Employees
Tickets
Freshservice

Requesters
Tickets
Departments
Workspaces
↓

02 — MAP
JSM Customer  → Freshservice Requester
JSM Ticket    → Freshservice Ticket
Department    → Workspace
Priority      → Priority
Status        → Status
↓

03 — TEST
Run a controlled sample migration.

↓

04 — ASSESS READINESS
Migration Readiness: 96%

✓ Required fields
✓ Mapping
✓ Workspace classification
✓ Test migration
✓ Validation

↓

05 — EXECUTE
Run the full migration.

↓

06 — REMEDIATE
Detect → Diagnose → Fix → Retry

↓

07 — RECONCILE
Source vs Target

↓

08 — EXPLAIN
Claude summarizes:

What happened? What went wrong? What was fixed? What remains?

SLIDE 5 — HOW ZEN WORKS
From natural language → autonomous execution
Use this as your main architecture diagram.

                         USER
                           │
                           │
        "Migrate JSM → Freshservice"
                           │
                           ▼
                  ┌─────────────────┐
                  │    ZEN AGENT    │
                  │ Goal Interpreter│
                  └────────┬────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │ ENTITY DISCOVERY│
                  └────────┬────────┘
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
           JSM SOURCE          FRESHSERVICE TARGET
           Customers           Requesters
           Tickets             Tickets
                               Workspaces
                               Departments
                │                     │
                └──────────┬──────────┘
                           ▼
                    AI MAPPING ENGINE
                           │
                           ▼
                    TEST MIGRATION
                           │
                           ▼
                  MIGRATION READINESS
                           │
                     ┌─────┴─────┐
                     │           │
                  NOT READY    READY
                     │           │
                     ▼           ▼
                  REMEDIATE   FULL MIGRATION
                                  │
                                  ▼
                         VALIDATE + RECONCILE
                                  │
                         ┌────────┴────────┐
                         ▼                 ▼
                    AUTO-FIXED        UNRESOLVED
                         │                 │
                         │                 ▼
                         │           HUMAN REVIEW
                         │
                         └────────┬────────┘
                                  ▼
                           CLAUDE INSIGHTS
Technology layer
Source: Jira Service Management API / Adapter

Agent: Zen Migration Engine

Target: Freshservice Product MCP / REST API v2

AI: Claude

Orchestration: Zen MCP

The Freshworks cookbook specifically identifies REST APIs and Product MCP as the relevant connection layers, while distinguishing Product MCP from Developer MCP.

SLIDE 6 — THE AGENTIC EXPERIENCE
One goal. End-to-end migration.
USER
“Migrate all employees and tickets from JSM to Freshservice.”

ZEN DISCOVERS
Source

✓ Customers
✓ Tickets

Target

✓ Requesters
✓ Tickets
✓ Workspaces
✓ Departments

ZEN MAPS
42 fields discovered

36 high-confidence

5 medium-confidence

1 requires review

ZEN TESTS
100 sample records

98 successful

2 automatically remediated

0 critical errors

🟢 Migration Ready
ZEN EXECUTES
10,000 records

Result	Records
Successfully migrated	9,650
Automatically remediated	280
Human review	70
96.5% success rate
CLAUDE EXPLAINS
What went wrong?

Missing requester information was the primary failure category.

What did Zen fix?

Zen resolved records where an existing requester could be identified using email and normalized known department values.

What remains?

70 records require human review because no reliable requester match was found.

SLIDE 7 — WHAT MAKES ZEN DIFFERENT?
From migration execution → migration autonomy
Traditional approach	Zen
Human defines every step	User defines the goal
Manual schema discovery	Automatic discovery
Manual field mapping	AI-assisted mapping
Import and hope	Test before full migration
Monitor failures manually	Agent detects failures
Manually troubleshoot	AI remediation + retry
Manual reconciliation	Automated reconciliation
Human involved throughout	Human only for exceptions
Static migration report	Claude-generated insights
Zen's differentiation
Existing migration solutions demonstrate the value of mapping, test migrations, validation and migration support.

Zen brings these capabilities together into one goal-driven agent.

The Zen principle
Automate where confidence is high. Escalate where judgment is required.

SLIDE 8 — BUSINESS VALUE & SUCCESS
Accelerate customer time-to-value
Customer value
⚡ Faster

Automate repetitive migration work.

🛡️ Safer

Test, validate and reconcile before and after migration.

🤖 Autonomous

AI handles routine failures and remediation.

👤 Human-controlled

Escalate uncertain or critical issues instead of silently proceeding.

Target customers
Enterprise customers adopting Freshservice

Primary users:

IT administrators
Customer onboarding teams
Professional Services
Migration teams
Success metrics
≥95%
Migration success rate

≥80%
Recoverable failures automatically remediated

<10%
Records requiring human intervention

0
Duplicate records

These are target metrics for the MVP, not claimed achieved results.

FINAL SLIDE — THE VISION
If you have time for a ninth slide, make this very minimal.

From Migration Project → Migration Agent
TODAY
Human
 ↓
Configure
 ↓
Map
 ↓
Script
 ↓
Test
 ↓
Migrate
 ↓
Troubleshoot
 ↓
Validate
WITH ZEN
Human
 ↓
"Move JSM → Freshservice"
 ↓
ZEN
 ↓
Discover
 ↓
Map
 ↓
Test
 ↓
Execute
 ↓
Remediate
 ↓
Reconcile
 ↓
Explain
 ↓
Human only when needed
ZEN
Give Zen the goal. Let Zen own the migration.
One important recommendation for your actual PPT
Don't make every slide text-heavy.

I'd make the presentation visually:

Slide 1: Big Zen positioning
Slide 2: Problem journey
Slide 3: Why now + market evidence
Slide 4: Zen workflow
Slide 5: Architecture
Slide 6: Live demo/results ← most important
Slide 7: Differentiation
Slide 8: Business value/metrics
Slide 9: Vision

And during the demo, the strongest sequence is:

"I give Zen one sentence."
↓
"Zen discovers the systems."
↓
"Zen maps them."
↓
"Zen tests the migration."
↓
"Zen tells me whether we're ready."
↓
"Zen executes."
↓
"Something fails."
↓
"Zen fixes it."
↓
"Claude tells me what happened."

That tells the entire agentic story in about 3–4 minutes and makes the PPT support the demo rather than compete with it.