declare const require: (name: string) => any
const { describe, expect, test } = require("bun:test")

import {
  DEFAULT_STALE_TIMEOUT_MS,
  DEFAULT_AGENT_STALE_TIMEOUTS,
  DEFAULT_AGENT_TOOL_CALL_LIMITS,
} from "./constants"

describe("DEFAULT_STALE_TIMEOUT_MS", () => {
  test("uses a 45 minute default", () => {
    // #given
    const expectedTimeout = 45 * 60 * 1000

    // #when
    const timeout = DEFAULT_STALE_TIMEOUT_MS

    // #then
    expect(timeout).toBe(expectedTimeout)
  })
})

describe("DEFAULT_AGENT_STALE_TIMEOUTS", () => {
  test("librarian has a 5 minute stale timeout", () => {
    expect(DEFAULT_AGENT_STALE_TIMEOUTS["librarian"]).toBe(300_000)
  })

  test("explore has a 3 minute stale timeout", () => {
    expect(DEFAULT_AGENT_STALE_TIMEOUTS["explore"]).toBe(180_000)
  })

  test("unknown agents have no default", () => {
    expect(DEFAULT_AGENT_STALE_TIMEOUTS["oracle"]).toBeUndefined()
  })
})

describe("DEFAULT_AGENT_TOOL_CALL_LIMITS", () => {
  test("librarian has a 25 tool call limit", () => {
    expect(DEFAULT_AGENT_TOOL_CALL_LIMITS["librarian"]).toBe(25)
  })

  test("explore has a 40 tool call limit", () => {
    expect(DEFAULT_AGENT_TOOL_CALL_LIMITS["explore"]).toBe(40)
  })

  test("unknown agents have no default", () => {
    expect(DEFAULT_AGENT_TOOL_CALL_LIMITS["oracle"]).toBeUndefined()
  })
})
