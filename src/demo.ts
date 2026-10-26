// The unattended demo loop, for a booth or a screen nobody is driving. It runs
// every scenario in turn, forever: each trip shows its quotes and picks for a
// few seconds, then books. Votes decide themselves after a few seconds: the
// manager approves, and finance approves on odd rounds and declines on even
// ones, so both outcomes show. Rooms and seats
// sold are reset at the start of every round. Anyone who gets quotes or votes
// themselves takes over and the loop stops.

import { type Laser } from "@laserdata/laser-sdk"

import { type Auditor } from "./audit.js"
import { cityNamed, settings, type Cabin, type RoomType } from "./config.js"
import { type Desk, type Trip, type TripRequest } from "./desk.js"
import { addDays, isoDate, parseDate, season, today } from "./pricing.js"
import { faults, feed } from "./state.js"
import { type Suppliers } from "./suppliers.js"
import { errorText, sleep } from "./util.js"

const DONE: readonly Trip["status"][] = ["booked", "unwound", "blocked", "declined", "failed"]

interface Scenario {
  readonly title: string
  readonly request: () => Omit<TripRequest, "traveller">
  readonly before?: () => void
}

function trip(from: string, city: string, daysOut: number, nights: number, cabin: Cabin = "economy", room: RoomType | "any" = "any"): Omit<TripRequest, "traveller"> {
  return { from, city, depart: isoDate(addDays(today(), daysOut)), nights, cabin, room }
}

// The first day at least this many days out that is not in a peak season, so
// the booked-ahead trip shows the early-booking discount on its own.
function quietTrip(from: string, city: string, minDays: number, nights: number): Omit<TripRequest, "traveller"> {
  const to = cityNamed(city)
  let date = addDays(today(), minDays)
  while (to !== undefined && season(date, to).factor !== 1) date = addDays(date, 1)
  return { ...trip(from, city, 0, nights), depart: isoDate(date) }
}

// The next 22 December at least a week away.
function christmas(): string {
  const now = today()
  let date = parseDate(`${String(now.getUTCFullYear())}-12-22`)
  if (date.getTime() - now.getTime() < 7 * 86_400_000) date = parseDate(`${String(now.getUTCFullYear() + 1)}-12-22`)
  return isoDate(date)
}

// Trips that book are mixed in with ones that are blocked, need approval or
// are cancelled, so the screen never shows a long run of the same outcome.
const SCENARIOS: readonly Scenario[] = [
  { title: "a trip three weeks out", request: () => trip("Melbourne", "Sydney", 21, 3) },
  { title: "business class on a domestic flight, which policy blocks", request: () => trip("Perth", "Melbourne", 30, 2, "business") },
  { title: "the same Sydney trip next week, dearer", request: () => trip("Melbourne", "Sydney", 6, 3) },
  { title: "a suite over the nightly cap, which policy blocks", request: () => trip("Adelaide", "Sydney", 40, 2, "economy", "suite") },
  { title: "the same Sydney trip booked three months ahead, cheaper", request: () => quietTrip("Melbourne", "Sydney", 90, 3) },
  { title: "business class to Singapore, which needs approval", request: () => trip("Sydney", "Singapore", 45, 5, "business") },
  {
    title: "car hire turns the booking down, so the flight and hotel are cancelled",
    request: () => trip("Melbourne", "Brisbane", 25, 3),
    before: () => {
      faults.carRejects = true
    }
  },
  { title: "Christmas peak", request: () => ({ ...trip("Brisbane", "Auckland", 0, 4), depart: christmas() }) },
  {
    title: "a hotel clerk stalls and another clerk takes over",
    request: () => trip("Sydney", "Perth", 35, 2),
    before: () => {
      faults.stallClerk = true
    }
  }
]

export class DemoLoop {
  running = false
  private round = 0
  private generation = 0

  constructor(
    private readonly desk: Desk,
    private readonly suppliers: Suppliers,
    private readonly laser: Laser,
    private readonly auditor: Auditor,
    private readonly travellers: readonly string[]
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.generation += 1
    const generation = this.generation
    feed.add("demo", "demo loop on", "info")
    void this.run(generation).catch((error: unknown) => {
      feed.add("demo", `demo loop stopped: ${errorText(error)}`, "bad")
      this.running = false
    })
  }

  stop(reason = "demo loop off"): void {
    if (!this.running) return
    this.running = false
    faults.carRejects = false
    faults.stallClerk = false
    feed.add("demo", reason, "info")
  }

  private live(generation: number): boolean {
    return this.running && generation === this.generation
  }

  private async run(generation: number): Promise<void> {
    while (this.live(generation)) {
      this.round += 1
      await this.suppliers.reset(this.laser)
      feed.add("demo", `round ${String(this.round)}: rooms and seats reset`, "info")
      for (const [i, scenario] of SCENARIOS.entries()) {
        if (!this.live(generation)) return
        feed.add("demo", scenario.title, "info")
        scenario.before?.()
        const traveller = this.travellers[(this.round + i) % this.travellers.length] ?? "Traveller"
        await this.play(this.desk.submit({ traveller, ...scenario.request() }), generation)
        if (!this.live(generation)) return
        await sleep(settings.demoPauseMs)
      }
      if (!this.live(generation)) return
      await this.auditor.read()
      await this.auditor.tamper()
    }
  }

  private async play(trip: Trip, generation: number): Promise<void> {
    await this.until(trip, generation, () => trip.status !== "quoting")
    if (trip.status === "choosing" && trip.suggested !== undefined) {
      await sleep(settings.demoPickMs)
      if (!this.live(generation)) return
      this.desk.choose(trip.id, trip.suggested)
    }
    await this.until(trip, generation, () => DONE.includes(trip.status) || trip.status === "voting")
    if (trip.status === "voting") {
      await sleep(settings.demoApproveMs)
      if (!this.live(generation)) return
      const approve = this.round % 2 === 1
      await this.desk.vote(trip.id, "manager", true)
      await sleep(1000)
      await this.desk.vote(trip.id, "finance", approve)
      await this.until(trip, generation, () => DONE.includes(trip.status))
    }
  }

  private async until(trip: Trip, generation: number, done: () => boolean): Promise<void> {
    // The stalled clerk takes about 35 seconds; nothing else takes near 90.
    const deadline = Date.now() + 90_000
    while (this.live(generation) && !done() && Date.now() < deadline) await sleep(250)
    if (!done() && this.live(generation)) feed.add("demo", `${trip.id} did not finish in time; moving on`, "warn", trip.id)
  }
}
