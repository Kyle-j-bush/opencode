import type {
  JsonValue,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  ShellInfo,
} from "@opencode/client/promise"
import { Option, Schema } from "effect"
import { createMemo } from "solid-js"

// `started` is when the work began running: the tool call's run time, the child session's creation, or the shell's start.
type Task =
  | { id: string; type: "subagent"; label: string; agent?: string; started: number }
  | { id: string; type: "shell"; label: string; started: number }

const decodeString = Schema.decodeUnknownOption(Schema.String)

// Tool input and metadata are open JSON, so a field of the wrong type reads as absent.
const text = (value: JsonValue | undefined) => Option.getOrUndefined(decodeString(value))

export function createSessionBackground(input: {
  sessionID: () => string | undefined
  messages: (id: string) => SessionMessageInfo[]
  sessions: () => SessionInfo[]
  status: (id: string) => "idle" | "running"
  shells: () => ShellInfo[]
}) {
  const history = createMemo(() => {
    const completed = new Set<string>()
    const subagents: { id: string; type: "subagent"; label: string; agent: string | undefined; started: number }[] = []
    const shells: { partID: string; task: { id: string; type: "shell"; label: string; started: number } }[] = []
    const id = input.sessionID()

    const complete = (value: JsonValue | undefined) => {
      const done = text(value)

      if (done) completed.add(done)
    }

    const assistant = (id ? input.messages(id) : []).reduce<SessionMessageAssistant | undefined>((latest, message) => {
      if (message.type === "synthetic") {
        if (message.metadata?.source === "subagent") complete(message.metadata.childID)

        if (message.metadata?.source === "shell") {
          complete(message.metadata.shellID)
          complete(message.metadata.jobID)
        }

        return latest
      }

      if (message.type !== "assistant") return latest
      message.content.forEach((part) => {
        if (part.type !== "tool" || (part.name !== "subagent" && part.name !== "shell")) return

        if (part.state.status !== "completed" || part.state.metadata?.status !== "running") return

        if (part.name === "subagent") {
          const sessionID = text(part.state.metadata.sessionID)

          if (!sessionID) return
          subagents.push({
            id: sessionID,
            type: "subagent",
            label: text(part.state.input.description) ?? sessionID,
            agent: text(part.state.input.agent),
            started: part.time.ran ?? part.time.created,
          })

          return
        }

        shells.push({
          partID: part.id,
          task: {
            id: text(part.state.metadata.shellID) ?? part.id,
            type: "shell",
            label: text(part.state.input.command) ?? part.id,
            started: part.time.ran ?? part.time.created,
          },
        })
      })

      return message.time.completed === undefined ? message : latest
    }, undefined)

    return {
      // Completion notices can identify the shell or its original tool call.
      subagents: subagents.filter((task) => !completed.has(task.id)),
      shells: shells.flatMap((item) => (completed.has(item.partID) || completed.has(item.task.id) ? [] : [item.task])),
      blocking:
        assistant?.content.flatMap((part) => {
          if (part.type !== "tool" || part.state.status !== "running") return []

          if (part.name !== "shell" && part.name !== "subagent") return []
          const shell = part.name === "shell"

          return [
            {
              type: shell ? ("shell" as const) : ("subagent" as const),
              partID: part.id,
              id: text(shell ? part.state.metadata.shellID : part.state.metadata.sessionID),
              label: text(shell ? part.state.input.command : part.state.input.description),
              started: part.time.ran ?? part.time.created,
            },
          ]
        }) ?? [],
    }
  })

  const blocking = createMemo(() => history().blocking)

  const tasks = createMemo(() => {
    const id = input.sessionID()

    if (!id) return []
    const current = history()

    const active = input.sessions().flatMap((info) => {
      if (info?.parentID !== id) return []

      if (input.status(info.id) === "idle") return []

      if (
        current.blocking.some(
          (item) => item.type === "subagent" && (item.id === info.id || (!!item.label && info.title === item.label)),
        )
      )
        return []

      return [{ id: info.id, type: "subagent" as const, label: info.title ?? info.id, started: info.time.created }]
    })

    const running = input.shells().flatMap((shell) => {
      if (shell.status !== "running" || shell.metadata.sessionID !== id) return []

      if (
        current.blocking.some(
          (item) => item.type === "shell" && (item.id === shell.id || (!!item.label && shell.command === item.label)),
        )
      )
        return []

      return [{ id: shell.id, type: "shell" as const, label: shell.command, started: shell.time.started }]
    })

    return [
      ...new Map<string, Task>(
        [...current.subagents, ...active, ...current.shells, ...running].map((task) => [task.id, task]),
      ).values(),
    ]
  })

  return { blocking, tasks }
}
