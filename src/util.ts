import { Laser, agentMessageBody, type AgentMessage } from "@laserdata/laser-sdk"

import { settings } from "./config.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8(text: string): Uint8Array {
  return encoder.encode(text)
}

export function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

export function parseJson<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T
}

export function messageJson<T>(message: AgentMessage): T {
  return parseJson<T>(agentMessageBody(message))
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function connect(connection: string = settings.connection): Promise<Laser> {
  return Laser.builder().connectionString(connection).stream(settings.stream).connect()
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export function ref(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`
}
