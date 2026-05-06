# Librarian & Explorer Agent Modification Guide

> **Last verified against:** oh-my-openagent v0.12 (2026-04-30)

## Problem Statement

The librarian agent routinely runs for 15-20 minutes and blows its context window. The explore agent, while better-behaved, has no per-agent guardrails and could exhibit similar runaway behavior. Both problems are model-agnostic -- the issues are architectural, not provider-specific.

**Root causes (Librarian):**
1. The prompt is a 278-line instruction manual encouraging 4-6 parallel tool chains, repo cloning, sitemap crawling, and permalink construction
2. There are no per-agent tool call or timeout limits -- only a global circuit breaker (4000 tool calls, 45-min stale timeout)
3. The circuit breaker only triggers on consecutive *identical* tool calls, so a librarian alternating between diverse tools (websearch -> webfetch -> gh clone -> grep -> read) never triggers it

**Root causes (Explorer):**
1. The prompt is already well-scoped (~76 lines) but has zero budget awareness or escalation behavior
2. Same global circuit breaker problem -- no per-agent limits
3. No hard ceiling on how long it can search before returning what it has

---

## Design Requirements (from user)

### Librarian

| Requirement | Value |
|---|---|
| Primary job | Leave the codebase, scour the web, read docs, bring back a summary |
| Response depth | Moderate evidence (code snippets + doc links, no permalink construction/sitemap crawling) |
| Tool budget | 25 calls max |
| Time budget | 5 minutes max |
| Repo cloning | Keep but limit: shallow only, only when grep.app/Context7 fail |
| Failure mode | Escalate: return partial results + flag that deeper investigation is needed |

### Explorer

| Requirement | Value |
|---|---|
| Primary job | Blazing-fast codebase grep. Find files, patterns, coding style. Return paths + descriptions. |
| Prompt changes | Minimal -- add budget awareness and escalation behavior only (no full rewrite) |
| Tool budget | 40 calls max |
| Time budget | 3 minutes max |
| Failure mode | Escalate: return partial results + flag gaps for Sisyphus |

---

## Part 1A: Librarian Prompt Rewrite

### File: `src/agents/librarian.ts`

**Current state (v0.12):** 278-line prompt with 4 phases (Phase 0: Request Classification, Phase 0.5: Documentation Discovery, Phase 1: Execute by Request Type A/B/C/D, Phase 2: Evidence Synthesis), sitemap discovery, repo cloning workflows, permalink construction with commit SHAs, and evidence synthesis. Blocked tools: `write`, `edit`, `apply_patch`, `task`, `call_omo_agent`.

**Target state:** ~80-line prompt modeled after the explore agent's clarity and focus. Single mission: "find documentation, bring back answers."

### New Prompt Design

```
# THE LIBRARIAN

You are THE LIBRARIAN. Your ONE job: leave the codebase, find documentation
and API references on the web, and bring back a clear, actionable summary.

## CRITICAL: DATE AWARENESS

**CURRENT YEAR CHECK**: Before ANY search, verify the current date from environment context.
- **NEVER search for ${currentYear - 1}** - It is NOT ${currentYear - 1} anymore
- **ALWAYS use current year** (${currentYear}+) in search queries

## RULES

1. **SCOPE**: External docs, API references, and code examples ONLY.
   You do NOT search or modify the local codebase.
2. **BUDGET**: You have a HARD LIMIT of 25 tool calls. Plan accordingly.
   - Spend 1-3 calls on discovery (what library, what version, where are docs)
   - Spend 5-15 calls on targeted research (read specific doc pages, find examples)
   - Reserve 2-3 calls for verification if needed
   - If you've used 20+ calls, STOP and summarize what you have.
3. **SPEED**: You must deliver a useful answer quickly.
   Do NOT crawl sitemaps. Do NOT construct GitHub permalinks.
   Do NOT clone repos unless Context7 and grep.app both fail.
4. **NO RABBIT HOLES**: If a search path isn't productive after 2 attempts, MOVE ON.
   A partial answer delivered fast beats a perfect answer delivered never.

## WORKFLOW

### Step 1: Understand the Question
Before any tool call, classify:
- What library/framework/API?
- What specific question needs answering?
- What would a useful answer look like?

### Step 2: Search (parallel where possible)
Use these tools in priority order:
1. **context7** (fastest): Resolve library ID, then query docs directly
2. **websearch** (fast): Find official doc pages, recent blog posts, changelogs
3. **webfetch** (moderate): Read specific doc pages found via search
4. **grep.app** (moderate): Find real-world code examples on GitHub
5. **gh repo clone** (LAST RESORT ONLY): Shallow clone (--depth 1) ONLY when
   tools 1-4 fail. Clone to ${TMPDIR:-/tmp}/. Keep it brief.

Launch 2-3 searches in parallel on your first move. Don't go sequential.

### Step 3: Synthesize
Return a clear answer with:
- Direct answer to the question
- Relevant code snippets (with language identifiers)
- Links to official docs (URL only, no permalink construction)
- Version/compatibility notes if relevant

## RESPONSE FORMAT

<answer>
[Direct, concise answer to the question]

**Key findings:**
- [Finding 1 with doc link]
- [Finding 2 with code example]

**Code example:**
\`\`\`language
// from [source URL]
actual code here
\`\`\`
</answer>

If you hit your budget or can't find a complete answer:

<answer>
[Best answer with what you found]

**Incomplete -- needs deeper investigation:**
- [What you couldn't find]
- [Suggested next steps for the caller]
</answer>

## FAILURE RECOVERY

- **context7 not found**: Try websearch for official docs
- **grep.app no results**: Broaden search terms, try different angle
- **Rate limited**: Switch to a different tool
- **Can't find answer after 15+ calls**: STOP. Return what you have.
  Flag the gaps. Let the caller decide next steps.

## ANTI-PATTERNS (DO NOT)

- Do NOT crawl sitemaps or parse site navigation
- Do NOT construct GitHub permalinks with commit SHAs
- Do NOT clone repos as a first step
- Do NOT run git blame or git log on cloned repos
- Do NOT chase down every tangential reference
- Do NOT use more than 25 tool calls total
- Do NOT include tool names in your response
```

### Key Changes from Current Prompt

| Current | New | Rationale |
|---|---|---|
| 4 request types (A/B/C/D) | Single workflow | Eliminates classification overhead and type-specific rabbit holes |
| Phase 0.5: Sitemap discovery | Removed entirely | Sitemaps are slow, context-heavy, and rarely necessary |
| Permalink construction with SHA | Removed | URLs are sufficient; permalink construction adds 3-5 tool calls per citation |
| "Launch 4+ tools simultaneously" | "Launch 2-3 searches in parallel" | Reduces context burn from parallel result accumulation |
| "gh repo clone" as primary tool | Last resort only | Cloning is the single biggest time/context sink |
| No tool budget | Hard 25-call budget with allocation guidance | Model self-polices tool usage |
| No failure mode | Explicit escalation with partial results | Prevents infinite search loops |
| 278 lines | ~80 lines | Smaller prompt = less context consumed by instructions themselves |

### Metadata Changes

Update `LIBRARIAN_PROMPT_METADATA` to reflect the tighter scope:

```typescript
export const LIBRARIAN_PROMPT_METADATA: AgentPromptMetadata = {
  category: "exploration",
  cost: "CHEAP",
  promptAlias: "Librarian",
  keyTrigger: "External library/source mentioned -> fire `librarian` background",
  triggers: [
    { domain: "Librarian", trigger: "External documentation lookup, API references, library usage examples" },
  ],
  useWhen: [
    "How do I use [library]?",
    "What's the best practice for [framework feature]?",
    "Find examples of [library] usage",
    "What does [API/method] do?",
  ],
}
```

---

## Part 1B: Explorer Prompt Patch

### File: `src/agents/explore.ts`

**Current state (v0.12):** 76-line well-scoped prompt with 6 sections: Your Mission, CRITICAL: What You Must Deliver (Intent Analysis, Parallel Execution, Structured Results), Success Criteria, Failure Conditions, Constraints, Tool Strategy. Blocked tools: `write`, `edit`, `apply_patch`, `task`, `call_omo_agent`. Allowed tools: `lsp_symbols`, `lsp_goto_definition`, `lsp_find_references`, `lsp_diagnostics`, `ast_grep_search`.

**Target state:** Same prompt with two small additions appended to the end:
1. Budget awareness section
2. Escalation behavior on budget hit

### Addition to Existing Prompt

Append the following to the end of the existing explore prompt (before the closing backtick of the template literal):

```

## BUDGET AWARENESS

You have a tool call budget. Plan your search strategy accordingly:
- Launch 3+ tools in parallel on your first move (cast a wide net)
- Cross-validate with 2-3 follow-up reads if needed
- If you've exhausted most of your budget, STOP and return what you have

## ESCALATION

If you cannot find a complete answer within your budget:

<results>
<files>
- [whatever you found so far]
</files>

<answer>
[Best answer with what you found]

**Incomplete -- needs further investigation:**
- [What you couldn't find or verify]
- [Suggested search angles for the caller]
</answer>
</results>

A partial answer with clear gaps flagged is better than no answer.
```

### Why Not a Full Rewrite

The explore prompt is already well-structured with:
- Clear mission ("find files and code, return actionable results")
- Structured output format (`<results>`, `<files>`, `<answer>`)
- Intent analysis requirement (`<analysis>` tags)
- Tool strategy guidance
- Failure conditions

It only lacks budget awareness and graceful degradation. Adding those two sections (~20 lines) is sufficient.

---

## Part 2: Infrastructure Guardrails

These changes apply to BOTH librarian and explore agents (and any future agent types).

### Change 1: Per-agent background task overrides in config schema

**File: `src/config/schema/background-task.ts`** (currently 29 lines)

The current schema has: `defaultConcurrency`, `providerConcurrency`, `modelConcurrency`, `maxDepth`, `staleTimeoutMs`, `messageStalenessTimeoutMs`, `taskTtlMs`, `sessionGoneTimeoutMs`, `syncPollTimeoutMs`, `maxToolCalls`, `circuitBreaker`. The inferred type is exported as `BackgroundTaskConfig`.

Add `AgentTaskOverrideSchema` before `BackgroundTaskConfigSchema`, then add `agentOverrides` as a new field:

```typescript
const AgentTaskOverrideSchema = z.object({
  /** Max tool calls for this agent type (overrides global maxToolCalls) */
  maxToolCalls: z.number().int().min(5).optional(),
  /** Stale timeout for this agent type in ms (overrides global staleTimeoutMs) */
  staleTimeoutMs: z.number().min(30000).optional(),
  /** Circuit breaker consecutive threshold override */
  consecutiveThreshold: z.number().int().min(3).optional(),
})

export const BackgroundTaskConfigSchema = z.object({
  // ... existing fields unchanged ...
  /** Per-agent-type overrides for background task limits */
  agentOverrides: z.record(z.string(), AgentTaskOverrideSchema).optional(),
})
```

This allows config like:

```jsonc
{
  "background_task": {
    "agentOverrides": {
      "librarian": {
        "maxToolCalls": 25,
        "staleTimeoutMs": 300000
      },
      "explore": {
        "maxToolCalls": 40,
        "staleTimeoutMs": 180000
      }
    }
  }
}
```

### Change 2: Resolve per-agent circuit breaker settings

**File: `src/features/background-agent/loop-detector.ts`** (lines 21-31)

Current signature (no agent awareness):
```typescript
export function resolveCircuitBreakerSettings(
  config?: BackgroundTaskConfig
): CircuitBreakerSettings {
  return {
    enabled: config?.circuitBreaker?.enabled ?? DEFAULT_CIRCUIT_BREAKER_ENABLED,
    maxToolCalls:
      config?.circuitBreaker?.maxToolCalls ?? config?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    consecutiveThreshold:
      config?.circuitBreaker?.consecutiveThreshold ?? DEFAULT_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD,
  }
}
```

Extend to accept an optional agent name and check for overrides:

```typescript
export function resolveCircuitBreakerSettings(
  config?: BackgroundTaskConfig,
  agentName?: string,
): CircuitBreakerSettings {
  const agentOverride = agentName ? config?.agentOverrides?.[agentName] : undefined

  return {
    enabled: config?.circuitBreaker?.enabled ?? DEFAULT_CIRCUIT_BREAKER_ENABLED,
    maxToolCalls:
      agentOverride?.maxToolCalls
      ?? DEFAULT_AGENT_TOOL_CALL_LIMITS[agentName ?? ""]
      ?? config?.circuitBreaker?.maxToolCalls
      ?? config?.maxToolCalls
      ?? DEFAULT_MAX_TOOL_CALLS,
    consecutiveThreshold:
      agentOverride?.consecutiveThreshold
      ?? config?.circuitBreaker?.consecutiveThreshold
      ?? DEFAULT_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD,
  }
}
```

**Resolution priority for maxToolCalls:**
1. User config `agentOverrides.{agent}.maxToolCalls` (highest -- user explicitly set it)
2. Built-in agent default `DEFAULT_AGENT_TOOL_CALL_LIMITS[agent]` (sensible per-agent default)
3. User config `circuitBreaker.maxToolCalls` or `maxToolCalls` (global override)
4. `DEFAULT_MAX_TOOL_CALLS` (4000 -- system fallback)

### Change 3: Pass agent name through circuit breaker resolution

**File: `src/features/background-agent/manager.ts`** (2466 lines total)

The `cachedCircuitBreakerSettings` field is declared at line 208:
```typescript
private cachedCircuitBreakerSettings?: CircuitBreakerSettings
```

In the tool-call tracking section (line 1257), pass `task.agent` to the circuit breaker resolver:

```typescript
// Current (lines 1257-1258):
const circuitBreaker = this.cachedCircuitBreakerSettings ?? resolveCircuitBreakerSettings(this.config)
this.cachedCircuitBreakerSettings = circuitBreaker

// New (replace both lines with):
const circuitBreaker = resolveCircuitBreakerSettings(this.config, task.agent)
```

**Note:** This means we can no longer use `cachedCircuitBreakerSettings` as a single global cache since settings vary by agent. Two options:

- **Option A (simple):** Remove the cache entirely. `resolveCircuitBreakerSettings` is a pure function with no I/O -- the cost of calling it per tool invocation is negligible. Also remove the field declaration at line 208.
- **Option B (if concerned about perf):** Use a `Map<string, CircuitBreakerSettings>` keyed by agent name.

**Recommendation: Option A** -- the function does 3 nullish coalescing operations and an object property lookup. No measurable overhead.

### Change 4: Per-agent stale timeout in task-poller

**File: `src/features/background-agent/task-poller.ts`** (225 lines total)

Current code (lines 123-130):
```typescript
  const staleTimeoutMs = config?.staleTimeoutMs ?? DEFAULT_STALE_TIMEOUT_MS
  const sessionGoneTimeoutMs = config?.sessionGoneTimeoutMs ?? DEFAULT_SESSION_GONE_TIMEOUT_MS
  const now = Date.now()
  const abortPromises: Array<Promise<unknown>> = []

  const messageStalenessMs = config?.messageStalenessTimeoutMs ?? DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS

  for (const task of tasks) {
```

Move `staleTimeoutMs` and `messageStalenessMs` inside the `for` loop (line 130) and resolve per-agent. Keep `sessionGoneTimeoutMs`, `now`, and `abortPromises` outside the loop (they're agent-independent):

```typescript
  const sessionGoneTimeoutMs = config?.sessionGoneTimeoutMs ?? DEFAULT_SESSION_GONE_TIMEOUT_MS
  const now = Date.now()
  const abortPromises: Array<Promise<unknown>> = []

  for (const task of tasks) {
    if (task.status !== "running") continue

    const agentOverride = config?.agentOverrides?.[task.agent]
    const staleTimeoutMs =
      agentOverride?.staleTimeoutMs
      ?? DEFAULT_AGENT_STALE_TIMEOUTS[task.agent]
      ?? config?.staleTimeoutMs
      ?? DEFAULT_STALE_TIMEOUT_MS
    const messageStalenessMs =
      agentOverride?.staleTimeoutMs
      ?? DEFAULT_AGENT_STALE_TIMEOUTS[task.agent]
      ?? config?.messageStalenessTimeoutMs
      ?? DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS
```

Note: `sessionGoneTimeoutMs` stays global — when a session crashes, agent type doesn't affect how fast we should detect it.

### Change 5: Set sensible defaults for librarian and explore

**File: `src/features/background-agent/constants.ts`** (currently 60 lines)

Current relevant constants (lines 7-11):
```typescript
export const DEFAULT_STALE_TIMEOUT_MS = 2_700_000          // 45 minutes
export const DEFAULT_MESSAGE_STALENESS_TIMEOUT_MS = 3_600_000  // 60 minutes
export const DEFAULT_MAX_TOOL_CALLS = 4000
export const DEFAULT_CIRCUIT_BREAKER_CONSECUTIVE_THRESHOLD = 20
export const DEFAULT_CIRCUIT_BREAKER_ENABLED = true
```

Add default agent-specific limits as named constants (after line 14, `MIN_IDLE_TIME_MS`):

```typescript
/** Agent-specific tool call defaults applied when no user config override exists */
export const DEFAULT_AGENT_TOOL_CALL_LIMITS: Record<string, number> = {
  librarian: 25,
  explore: 40,
}

/** Agent-specific stale timeout defaults in ms */
export const DEFAULT_AGENT_STALE_TIMEOUTS: Record<string, number> = {
  librarian: 300_000,  // 5 minutes
  explore: 180_000,    // 3 minutes
}
```

These are the built-in defaults that apply when the user hasn't set explicit `agentOverrides` in their config. They sit between "user override" (highest priority) and "global default" (lowest priority) in the resolution chain.

---

## Part 3: Files Modified (Summary)

| File | Change Type | Description |
|---|---|---|
| `src/agents/librarian.ts` | **Rewrite** | Replace 278-line prompt with ~80-line focused prompt. Update metadata. |
| `src/agents/explore.ts` | **Patch** | Append ~20-line budget awareness + escalation section to existing prompt. |
| `src/config/schema/background-task.ts` (29 lines) | **Extend** | Add `AgentTaskOverrideSchema` and `agentOverrides` field |
| `src/features/background-agent/constants.ts` (60 lines) | **Add** | Add `DEFAULT_AGENT_TOOL_CALL_LIMITS` and `DEFAULT_AGENT_STALE_TIMEOUTS` after line 14 |
| `src/features/background-agent/loop-detector.ts` (lines 21-31) | **Modify** | Add `agentName` parameter to `resolveCircuitBreakerSettings`, import new constants, resolve per-agent |
| `src/features/background-agent/manager.ts` (lines 208, 1257-1258) | **Modify** | Pass `task.agent` to circuit breaker resolution, remove `cachedCircuitBreakerSettings` field and its assignment |
| `src/features/background-agent/task-poller.ts` (lines 123-130) | **Modify** | Move `staleTimeoutMs` and `messageStalenessMs` inside loop, resolve per-agent using overrides + defaults |

### Files NOT Modified

| File | Reason |
|---|---|
| `src/tools/delegate-task/*` | No changes needed -- the delegate-task tool already passes agent name through to BackgroundManager |
| `src/config/schema/oh-my-opencode-config.ts` | No changes -- `background_task` field already exists and the schema extension is internal to `background-task.ts` |
| `src/features/background-agent/types.ts` | No changes -- `BackgroundTask.agent` is already a `string` field (line 52) |

---

## Part 4: Test Impact

### Existing tests that need updating

1. **`src/features/background-agent/loop-detector.test.ts`** (296 lines) -- `resolveCircuitBreakerSettings` signature changes (add optional `agentName` param). Existing tests pass `undefined` implicitly and continue to work, but new tests are needed.
2. **`src/features/background-agent/manager-circuit-breaker.test.ts`** (390 lines) -- circuit breaker tests should verify per-agent override behavior.
3. **`src/features/background-agent/task-poller.test.ts`** (963 lines) -- stale timeout tests need cases for per-agent timeout resolution.
4. **`src/features/background-agent/default-stale-timeout.test.ts`** (17 lines) -- verify new agent-specific defaults.

### New tests needed

1. **`resolveCircuitBreakerSettings` with agentName**:
   - `librarian` gets 25 tool calls by default
   - `explore` gets 40 tool calls by default
   - Unknown agent name gets global default (4000)
   - User config `agentOverrides.librarian.maxToolCalls: 15` overrides built-in default of 25
   - User config `agentOverrides.librarian.consecutiveThreshold: 5` overrides global default of 20

2. **Per-agent stale timeout**:
   - Librarian tasks get cancelled at 5 minutes of inactivity
   - Explore tasks get cancelled at 3 minutes of inactivity
   - Oracle tasks (no agent default) fall through to global stale timeout
   - User config override takes precedence over built-in agent default

3. **Config override precedence chain**:
   - User agentOverride > built-in agent default > user global config > system default

---

## Part 5: Verification Plan

After implementation:

1. `bun run typecheck` -- zero errors
2. `bun test` -- all existing tests pass (with updates from Part 4)
3. **Manual QA for Librarian**: Spawn a librarian task and verify:
   - Prompt is the new focused version (check via session read or logs)
   - Task completes within 25 tool calls
   - Task gets cancelled if it exceeds 5 minutes of inactivity
   - Partial results are returned with escalation flag on budget hit
4. **Manual QA for Explorer**: Spawn an explore task and verify:
   - Prompt includes the new budget awareness + escalation section
   - Task respects 40 tool call limit
   - Task gets cancelled if it exceeds 3 minutes of inactivity

---

## Part 6: User Config Example

After these changes, users can further tune per-agent limits in their `oh-my-opencode.jsonc`:

```jsonc
{
  "background_task": {
    // Global defaults still apply to agents without overrides
    "maxToolCalls": 200,
    "staleTimeoutMs": 180000,

    // Per-agent overrides
    "agentOverrides": {
      "librarian": {
        "maxToolCalls": 25,
        "staleTimeoutMs": 300000
      },
      "explore": {
        "maxToolCalls": 40,
        "staleTimeoutMs": 180000
      },
      "oracle": {
        "staleTimeoutMs": 600000
      }
    }
  }
}
```

Alternatively, agent prompts can be augmented via `prompt_append` without touching source:

```jsonc
{
  "agents": {
    "librarian": {
      "prompt_append": "IMPORTANT: You have a HARD LIMIT of 15 tool calls for this task. Plan accordingly."
    },
    "explore": {
      "prompt_append": "IMPORTANT: You have a HARD LIMIT of 20 tool calls. Return what you have if budget runs low."
    }
  }
}
```

---

## Part 7: Summary of Per-Agent Defaults

| Agent | Tool Call Limit | Stale Timeout | Prompt Change |
|---|---|---|---|
| **Librarian** | 25 (was 4000) | 5 min (was 45 min) | Full rewrite: 278 lines -> ~80 lines |
| **Explorer** | 40 (was 4000) | 3 min (was 45 min) | Patch: +20 lines (budget + escalation) |
| **Oracle** | 4000 (unchanged) | 45 min (unchanged) | None |
| **All others** | 4000 (unchanged) | 45 min (unchanged) | None |

All defaults are overridable via `background_task.agentOverrides` in user config.

---

## Appendix: v0.6 → v0.12 Delta Notes

This guide was originally written against v0.6. The following changes occurred in the codebase between v0.6 and v0.12, verified 2026-04-30:

| What changed | v0.6 | v0.12 | Impact on this guide |
|---|---|---|---|
| manager.ts circuit breaker call location | ~line 1064 | **line 1257** | Line references updated above |
| manager.ts total line count | ~unknown | **2466 lines** | No impact |
| BackgroundTaskConfigSchema fields | Fewer timeout fields | Added `taskTtlMs`, `sessionGoneTimeoutMs`, `syncPollTimeoutMs` | No conflict -- `agentOverrides` is additive |
| Schema comment on maxToolCalls | "default: 200" | Still says "default: 200" but constant is 4000 | Cosmetic discrepancy, not our concern |
| BackgroundTask.agent field | `string` | Still `string` (types.ts:52) | No impact |
| task-poller.ts line numbers | ~line 123/128 | **Still lines 123/128** | No change needed |
| Existing test file sizes | Unknown | loop-detector: 296, manager-cb: 390, task-poller: 963, default-stale: 17 | Test additions are additive |
| None of the guide's changes | N/A | **Not yet implemented** | Full guide still applies |
