---
name: automate-bug-fix
description: Use when triaging and fixing Jira bugs that are marked ready for work; performs validation, feasibility scoring, scoped planning, fail-first tests, intent alignment checks, constrained refactor, lint/test verification, and PR creation.
---

# Automate Bug Fix (Jira-Ready Workflow)

Use this skill for Jira issues that are already assumed to be **Ready for Work**.  
Goal: enforce a high-discipline flow from ticket validation to PR creation with explicit checkpoints, scope control, and commit hygiene.

## Inputs

- Jira issue link or ticket details
- Target repository and branch context
- Any acceptance criteria or reproduction details from the bug report

## Guardrails

- Do not change unrelated code.
- Prefer existing patterns in the codebase.
- Keep changes small enough for one reviewer with minimal context switching.
- If scope is too large, stop and provide a decomposition plan instead of proceeding.

## Workflow

### 1) Validate Jira Ticket Readiness

Perform basic checks before coding:

- clear bug statement and expected behavior
- repro steps or observable failure mode
- impacted area(s) identified or inferable
- acceptance criteria / definition of done
- environmental/context details needed to reproduce (if applicable)

If required information is missing, stop and leave a comment detailing what is missing.

If sufficient, create a commit that captures triage/readiness artifacts (if any files were updated) and leave a validation comment summarizing:

- what was validated
- assumptions made
- what will happen next

### 2) Scan Codebase and Build Context

Review only relevant portions of the repository to understand:

- current behavior
- likely root cause
- existing implementation patterns to follow
- exact change surfaces needed

Avoid broad unrelated exploration.

### 3) Create Scoped Plan + Feasibility Score

Produce an implementation plan with:

- files/modules expected to change
- why each is in-scope
- patterns/conventions to preserve
- test strategy overview

Score feasibility using this rubric:

- **1 (Small):** single reviewer, minimal context switching, focused files
- **2 (Medium):** still reviewable by one reviewer with moderate context
- **3 (Large):** likely too broad for one-pass review
- **4 (XL):** cross-cutting / multi-area / high coordination

Decision:

- If score is **1-2**, commit the plan and continue.
- If score is **3-4**, abort implementation and provide a breakdown into smaller, independently reviewable issues.

### 4) Define Tests First (Failing)

From the approved plan:

- identify new tests and/or updates to existing tests
- implement tests that encode expected bug-fix behavior
- run tests and confirm they fail for the intended reason

Commit failing tests.

### 5) Validate Test Intent Against Bug Intent (Up to 3 Iterations)

Review tests alone and derive intended behavior from test changes only.  
Compare derived intent to the Jira bug intent.

- If aligned: commit with a note and proceed.
- If not aligned: revise tests and repeat validation.
- Max retries: **3 iterations**.

If still not aligned after 3 iterations, stop and document the mismatch with recommended ticket clarification.

### 6) Implement/Refactor Within Scope

Apply code changes to satisfy the validated tests and plan:

- follow existing patterns
- avoid unrelated refactors
- keep modifications constrained to scoped areas

Commit implementation/refactor.

### 7) Scope Drift Check

Compare actual changed areas against planned areas:

- list expected files changed
- list unexpected files changed
- for each unexpected change, justify necessity

If unexpected changes are unnecessary, revert them before continuing.

Commit scope-review updates if needed.

### 8) Final Verification and PR

On a fresh commit:

- run repository linter(s)
- run relevant tests, including newly added/updated tests
- ensure all pass

Then open a PR with:

- summary of bug and fix
- validation checkpoints performed
- feasibility score and scope rationale
- test intent alignment outcome
- notes on any justified scope exceptions

## Output Expectations

When this workflow completes, provide:

- readiness validation summary
- feasibility score + go/no-go decision
- plan and scoped change surfaces
- test intent alignment result (and iteration count if used)
- final verification results
- PR link (or decomposition guidance if aborted)