import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Durable } from "../src/durable-event-manifest.js"
import { SessionLegacy } from "../src/session-legacy.js"
import { SessionMessage } from "../src/session-message.js"

const ref = { sessionID: "ses_legacy", assistantMessageID: "msg_legacy" }
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const native = { signature: "kept" }
const textPart = { type: "text", text: "hi", state: native }
const toolPart = {
  type: "tool",
  id: "call",
  name: "search",
  providerState: native,
  state: { status: "streaming", input: "" },
  time: { created: 0 },
}

const decode = (type: string, data: unknown) => {
  const definition = Durable.get(type)
  if (!definition) throw new Error(`Unknown durable event ${type}`)
  return Schema.decodeUnknownSync(definition.data)(SessionLegacy.event(definition.type, data))
}

describe("SessionLegacy", () => {
  test.each([
    ["session.text.ended.1", { ...ref, ordinal: 0, text: "hi", state: native }],
    ["session.reasoning.started.1", { ...ref, ordinal: 0, state: native }],
    ["session.reasoning.ended.1", { ...ref, ordinal: 0, text: "thought", state: native }],
    ["session.tool.called.1", { ...ref, id: "call", input: {}, executed: true, state: native }],
    ["session.step.ended.1", { ...ref, finish: "stop", providerState: native, cost: 0, tokens }],
    [
      "session.step.failed.1",
      { ...ref, error: { type: "provider.unknown", message: "failed" }, providerState: native },
    ],
    [
      "session.compaction.ended.1",
      { sessionID: ref.sessionID, reason: "auto", text: "s", recent: "", providerState: native },
    ],
  ])("upgrades %s", (type, data) => {
    expect(decode(type, data)).toMatchObject({ native })
  })

  test("upgrades replaced assistant content without touching tool status", () => {
    expect(
      decode("session.message.content.updated.1", {
        sessionID: ref.sessionID,
        messageID: ref.assistantMessageID,
        content: [textPart, toolPart],
      }),
    ).toMatchObject({
      content: [
        { type: "text", native },
        { type: "tool", native, state: { status: "streaming", input: "" } },
      ],
    })
  })

  test("leaves current and unrelated payloads unchanged", () => {
    const current = { ...ref, ordinal: 0, text: "hi", native }
    expect(SessionLegacy.event("session.text.ended", current)).toBe(current)
    const result = { ...ref, id: "call", content: [], executed: true, resultState: native }
    expect(SessionLegacy.event("session.tool.success", result)).toBe(result)
    const user = { type: "user", text: "hi", state: native }
    expect(SessionLegacy.message("user", user)).toBe(user)
  })

  test("keeps the current name when a payload carries both", () => {
    expect(SessionLegacy.event("session.text.ended", { text: "hi", state: { old: true }, native })).toEqual({
      text: "hi",
      native,
    })
  })

  test("upgrades assistant and compaction messages", () => {
    expect(SessionLegacy.message("assistant", { providerState: native, content: [textPart, toolPart] })).toEqual({
      native,
      content: [
        { type: "text", text: "hi", native },
        { type: "tool", id: "call", name: "search", native, state: toolPart.state, time: toolPart.time },
      ],
    })
    expect(SessionLegacy.message("compaction", { status: "completed", providerState: native })).toEqual({
      status: "completed",
      native,
    })
  })

  test("moves the kept text a compaction stored in recent into metadata", () => {
    expect(
      SessionLegacy.message("compaction", { status: "completed", recent: "[User]: kept", metadata: { source: "x" } }),
    ).toEqual({ status: "completed", metadata: { recent: "[User]: kept", source: "x" } })
    expect(SessionLegacy.message("compaction", { status: "completed", recent: "" })).toEqual({ status: "completed" })
    expect(
      SessionLegacy.event("session.compaction.ended", { reason: "auto", text: "s", recent: "[User]: kept" }),
    ).toEqual({ reason: "auto", text: "s" })
    expect(SessionLegacy.event("session.compaction.started", { reason: "auto", recent: "" })).toEqual({
      reason: "auto",
    })
  })

  test("stores the empty recent that versions before v2.1 require, and reads drop it", () => {
    const stored = SessionLegacy.storedMessage("compaction", { status: "completed", summary: "s" })
    expect(stored).toHaveProperty("recent", "")
    expect(SessionLegacy.message("compaction", stored)).toEqual({ status: "completed", summary: "s" })
    // Compactions imported with kept text (V1, old exports) keep it where older versions read it.
    expect(
      SessionLegacy.storedMessage("compaction", { status: "completed", metadata: { recent: "[User]: kept" } }),
    ).toHaveProperty("recent", "[User]: kept")
    const failed = { status: "failed" }
    expect(SessionLegacy.storedMessage("compaction", failed)).toBe(failed)
    expect(SessionLegacy.storedEvent("session.compaction.ended", { text: "s" })).toHaveProperty("recent", "")
    const text = { text: "s" }
    expect(SessionLegacy.storedEvent("session.text.ended", text)).toBe(text)
  })

  test("upgrades exported messages before decoding", () => {
    const message = {
      id: "msg_legacy",
      type: "assistant",
      agent: "build",
      model: { providerID: "anthropic", id: "claude" },
      providerState: native,
      content: [textPart, { type: "reasoning", text: "thought", state: native }],
      time: { created: 0 },
    }
    expect(
      Schema.decodeUnknownSync(Schema.Array(SessionMessage.Info))(SessionLegacy.messages([message])),
    ).toMatchObject([
      {
        native,
        content: [
          { type: "text", native },
          { type: "reasoning", native },
        ],
      },
    ])
  })
})
