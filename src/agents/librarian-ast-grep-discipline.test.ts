/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"
import { createLibrarianAgent } from "./librarian"

describe("librarian agent prompt discipline", () => {
  const model = "openai/gpt-5.4-mini-fast"

  it("#given the prompt #when inspecting #then enforces a 25 tool call budget", () => {
    const agent = createLibrarianAgent(model)
    const prompt = agent.prompt ?? ""

    expect(prompt).toContain("HARD LIMIT of 25 tool calls")
    expect(prompt).toContain("20+ calls, STOP")
  })

  it("#given the prompt #when inspecting #then lists tools in priority order", () => {
    const agent = createLibrarianAgent(model)
    const prompt = agent.prompt ?? ""

    expect(prompt).toContain("context7")
    expect(prompt).toContain("websearch")
    expect(prompt).toContain("webfetch")
    expect(prompt).toContain("grep.app")
    expect(prompt).toContain("gh repo clone")
  })

  it("#given the prompt #when inspecting #then treats repo cloning as last resort", () => {
    const agent = createLibrarianAgent(model)
    const prompt = agent.prompt ?? ""

    expect(prompt).toContain("LAST RESORT ONLY")
    expect(prompt).toContain("--depth 1")
  })

  it("#given the prompt #when inspecting #then forbids sitemap crawling and permalink construction", () => {
    const agent = createLibrarianAgent(model)
    const prompt = agent.prompt ?? ""

    expect(prompt).toContain("Do NOT crawl sitemaps")
    expect(prompt).toContain("Do NOT construct GitHub permalinks")
  })

  it("#given the prompt #when inspecting #then includes escalation behavior", () => {
    const agent = createLibrarianAgent(model)
    const prompt = agent.prompt ?? ""

    expect(prompt).toContain("Incomplete -- needs deeper investigation")
    expect(prompt).toContain("Suggested next steps for the caller")
  })

  it("#given the prompt #when inspecting #then includes date awareness", () => {
    const agent = createLibrarianAgent(model)
    const prompt = agent.prompt ?? ""

    const currentYear = new Date().getFullYear()
    expect(prompt).toContain(`${currentYear}`)
    expect(prompt).toContain("CURRENT YEAR CHECK")
  })
})
