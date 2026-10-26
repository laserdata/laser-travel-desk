// The auditor signs in as its own Iggy user, bound to one role: read the
// bookings ledger, nothing else. The plane enforces it, whatever the client
// asks for.

import {
  Laser,
  isPermissionDenied,
  resourcePatternAll,
  resourcePatternLiteral,
  type Grant,
  type Role
} from "@laserdata/laser-sdk"

import { settings } from "./config.js"
import { BOOKINGS } from "./suppliers.js"
import { errorText, utf8 } from "./util.js"

const ROLE = "travel-auditor"
// Apache Iggy's `UserStatus.Active`.
const ACTIVE_USER = 1

export interface AuditResult {
  readonly at: number
  readonly action: string
  readonly allowed: boolean
  readonly detail: string
}

export class Auditor {
  readonly results: AuditResult[] = []
  error?: string
  private laser?: Laser

  async start(desk: Laser): Promise<void> {
    try {
      const resource = desk.kv(BOOKINGS).resourceNamespace
      const grants: readonly Grant[] = [
        { effect: "allow", feature: "kv", action: "read", resource: resourcePatternLiteral(resource) },
        { effect: "deny", feature: "kv", action: "write", resource: resourcePatternAll() },
        { effect: "deny", feature: "kv", action: "delete", resource: resourcePatternAll() }
      ]
      const role: Role = { name: ROLE, grants }
      await desk.defineRole(role)
      const user = await this.user(desk)
      await this.readOnly(desk, user)
      await desk.bindRoles(user, [ROLE])
      this.laser = await Laser.builder()
        .connectionString(auditorConnection())
        .stream(settings.stream)
        .connect()
      const who = await this.laser.whoami()
      this.results.unshift({
        at: Date.now(),
        action: "sign in",
        allowed: true,
        detail: `signed in as ${settings.auditorUser}, allowed to read bookings and nothing else (role ${who.roles.join(", ")})`
      })
    } catch (error) {
      this.error = errorText(error)
    }
  }

  // Reads every booking on the ledger.
  async read(): Promise<AuditResult> {
    return this.attempt("read the bookings ledger", async (laser) => {
      const page = await laser.kv(BOOKINGS).scan().fetch()
      return `${String(page.entries.length)} bookings visible`
    })
  }

  // Tries to change a booking's price, which the role denies.
  async tamper(): Promise<AuditResult> {
    return this.attempt("change a booking's price", async (laser) => {
      await laser.kv(BOOKINGS).set(utf8("audit-test")).json({ price: 1 }).send()
      return "write went through"
    })
  }

  async stop(): Promise<void> {
    await this.laser?.close()
  }

  private async attempt(action: string, body: (laser: Laser) => Promise<string>): Promise<AuditResult> {
    let result: AuditResult
    if (this.laser === undefined) {
      result = { at: Date.now(), action, allowed: false, detail: this.error ?? "auditor not connected" }
    } else {
      try {
        result = { at: Date.now(), action, allowed: true, detail: await body(this.laser) }
      } catch (error) {
        result = { at: Date.now(), action, allowed: false, detail: denial(error) }
      }
    }
    this.results.unshift(result)
    return result
  }

  // Apache Iggy checks its own permissions before the plane sees a managed
  // command, and a KV write is a send. The auditor gets read and send on the
  // stream there, so the travel-auditor role alone decides what it may do.
  private async readOnly(desk: Laser, user: number): Promise<void> {
    const stream = await desk.client.stream.get({ streamId: settings.stream })
    if (stream === null) throw new Error(`no stream ${settings.stream}`)
    await desk.client.user.updatePermissions({
      userId: user,
      permissions: {
        global: {
          ManageServers: false,
          ReadServers: false,
          ManageUsers: false,
          ReadUsers: false,
          ManageStreams: false,
          ReadStreams: false,
          ManageTopics: false,
          ReadTopics: false,
          PollMessages: false,
          SendMessages: false
        },
        streams: [
          {
            streamId: stream.id,
            permissions: {
              manageStream: false,
              readStream: true,
              manageTopics: false,
              readTopics: true,
              pollMessages: true,
              sendMessages: true
            },
            topics: []
          }
        ]
      }
    })
  }

  private async user(desk: Laser): Promise<number> {
    const existing = await desk.client.user.get({ userId: settings.auditorUser })
    if (existing !== null) return existing.id
    const created = await desk.client.user.create({
      username: settings.auditorUser,
      password: settings.auditorPassword,
      status: ACTIVE_USER
    })
    return created.id
  }
}

// The desk's connection string with the auditor's credentials in place of its own.
function auditorConnection(): string {
  const at = settings.connection.lastIndexOf("@")
  const host = at < 0 ? settings.connection : settings.connection.slice(at + 1)
  return `${settings.auditorUser}:${settings.auditorPassword}@${host}`
}

function denial(error: unknown): string {
  return isPermissionDenied(error) ? "refused: the auditor may only read bookings" : errorText(error)
}
