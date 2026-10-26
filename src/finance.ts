// Finance only wants the trips that needed a vote or came apart. Its consumer
// group owns a filter, so the server picks those records off the ledger and
// the rest never cross the network.

import { ConsumerFilter, FilterExpr, type FilteredReader, type Laser } from "@laserdata/laser-sdk"

import { policy, settings } from "./config.js"
import { LEDGER, type LedgerRecord } from "./desk.js"
import { feed } from "./state.js"
import { errorText, parseJson } from "./util.js"

export class FinanceReader {
  readonly seen: LedgerRecord[] = []
  bytes = 0
  error?: string
  private reader?: FilteredReader
  private stopped = false

  static filter(): ConsumerFilter {
    return ConsumerFilter.json(
      FilterExpr.any([
        FilterExpr.pred("total", "gt", policy.approvalOver),
        FilterExpr.pred("status", "eq", "unwound"),
        FilterExpr.pred("status", "eq", "declined")
      ])
    )
  }

  async start(laser: Laser): Promise<void> {
    const group = laser.stream(settings.stream).topic(LEDGER).consumerGroup(`finance-${Date.now().toString(36)}`)
    await group.create({ filter: FinanceReader.filter() })
    this.reader = await group.reader().start({ kind: "first" }).build()
    void this.loop()
  }

  private async loop(): Promise<void> {
    const reader = this.reader
    if (reader === undefined) return
    while (!this.stopped) {
      try {
        const record = await reader.nextRecord({ timeoutMs: 1000 })
        const entry = parseJson<LedgerRecord>(record.message.payload)
        this.seen.unshift(entry)
        this.bytes += record.message.payload.byteLength
        feed.add("finance", `received ${entry.trip} (${entry.status === "unwound" ? "cancelled" : entry.status}, $${String(entry.total)}), one of the trips finance reviews`, "info", entry.trip)
        await reader.ack(record)
      } catch (error) {
        if (this.stopped) return
        if (error instanceof Error && error.name === "TimeoutError") continue
        this.error = errorText(error)
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.reader?.close()
  }
}
