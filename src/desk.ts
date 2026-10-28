// The travel desk. For each trip it gathers quotes from every supplier that
// serves the skill, and the traveller picks a flight and a room from them
// (cheapest is picked to start with). The desk proposes that trip through the
// policy governor, holds a vote when the governor steps it up, and books it as
// a saga: flight, hotel, car, each a workflow step with a compensation that
// cancels it if a later step fails. Each trip is a session, opened when the
// traveller's request comes in and ended when the trip is settled.

import {
  AgentId,
  AgentTopic,
  ConversationId,
  GovernorMode,
  Laser,
  PolicyBlockedError,
  Session,
  SessionLease,
  StepUpRequiredError,
  TopicRetention,
  VoteChoice,
  WorkflowBudget,
  agentMessageBody,
  capabilitySelector,
  routeTo,
  routeToCapable,
  type StepContext
} from "@laserdata/laser-sdk"

import { AIRLINES, CAR_HIRE, CITIES, HOTELS, ORIGINS, TRAVELLERS, cityNamed, hotelsIn, roomLabel, settings, type Cabin, type RoomType } from "./config.js"
import { Approvals, FINANCE, MANAGER, PROPOSALS, TravelPolicy, type Proposal, type ProposalRecord } from "./policy.js"
import { addDays, isoDate, parseDate, today } from "./pricing.js"
import { feed } from "./state.js"
import {
  FENCE_NAMESPACE,
  hotelSkill,
  type BookRequest,
  type Booked,
  type CancelRequest,
  type HotelReply,
  type Quote,
  type QuoteRequest
} from "./suppliers.js"
import { errorText, jsonBytes, parseJson } from "./util.js"

export const DESK = AgentId.new("desk")
export const VOTES = "votes"
export const LEDGER = "ledger"
const FIXED_INBOX = { kind: "fixed" as const, topic: AgentTopic.Sessions }
const RETENTION = TopicRetention.expireAfter(86_400_000)
const SETTLED: readonly Trip["status"][] = ["booked", "unwound", "blocked", "declined", "failed"]

export type StepState = "waiting" | "working" | "done" | "failed" | "cancelled" | "skipped"

export interface TripRequest {
  readonly traveller: string
  readonly from: string
  readonly city: string
  // YYYY-MM-DD
  readonly depart: string
  readonly nights: number
  readonly cabin: Cabin
  // The room type the traveller wants, or "any".
  readonly room: RoomType | "any"
}

export interface Choice {
  readonly flight: string
  readonly hotel: string
  readonly room: RoomType
}

export interface Trip {
  readonly id: string
  readonly request: TripRequest
  status: "quoting" | "choosing" | "policy" | "voting" | "booking" | "booked" | "unwound" | "blocked" | "declined" | "failed"
  quotes: {
    flights: Quote[]
    rooms: Quote[]
    car?: Quote
    missed: string[]
  }
  // What the cheapest pick would be; the page starts from it.
  suggested?: Choice
  // What was picked and proposed.
  choice?: Choice
  proposal?: Proposal
  verdict?: { kind: string; reason: string }
  vote?: { intent: string; manager?: string; finance?: string; outcome?: string; reason?: string }
  steps: { flight: StepState; hotel: StepState; car: StepState }
  refs: Record<string, string>
  run?: string
  session?: string
  note?: string
}

interface OpenSession {
  readonly session: Session
  readonly lease: SessionLease
  // Writes to one session go in order.
  writes: Promise<void>
}

export interface LedgerRecord {
  readonly trip: string
  readonly traveller: string
  readonly city: string
  readonly status: "booked" | "unwound" | "declined" | "blocked"
  readonly total: number
  readonly approval: "vote" | "none"
  readonly lines: readonly { readonly kind: string; readonly supplier: string; readonly price: number; readonly ref?: string }[]
  readonly reason?: string
}

export class Desk {
  readonly trips = new Map<string, Trip>()
  readonly ledger = { records: 0, bytes: 0 }
  private readonly sessions = new Map<string, OpenSession>()
  private seq = 0

  private constructor(
    readonly laser: Laser,
    private readonly booker: Laser,
    readonly approvals: Approvals,
    private readonly policy: TravelPolicy
  ) {}

  static async open(laser: Laser): Promise<Desk> {
    // The governor and the vote handler share one set of intents.
    const approvals = new Approvals()
    const travelPolicy = new TravelPolicy(approvals)
    const booker = await Laser.builder()
      .connectionString(settings.connection)
      .stream(settings.stream)
      .governor(travelPolicy, GovernorMode.Enforce)
      .connect()
    const desk = new Desk(laser, booker, approvals, travelPolicy)
    for (const name of [PROPOSALS, VOTES, LEDGER]) {
      await laser.stream(settings.stream).topic(name).ensure(1)
    }
    return desk
  }

  static async prepare(laser: Laser): Promise<void> {
    if (!settings.keep) {
      try {
        await laser.client.stream.delete({ streamId: settings.stream })
      } catch {
        // Nothing to delete on a first run.
      }
    }
    await laser.sessions().bootstrap(1, RETENTION)
  }

  async close(): Promise<void> {
    for (const open of this.sessions.values()) open.lease.release()
    await this.booker.close()
  }

  list(): readonly Trip[] {
    return [...this.trips.values()].reverse()
  }

  randomRequest(): TripRequest {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] as T
    const from = pick(ORIGINS)
    const to = pick(CITIES.filter((c) => c.id !== from.id))
    return {
      traveller: pick(TRAVELLERS),
      from: from.name,
      city: to.name,
      depart: isoDate(addDays(today(), 3 + Math.floor(Math.random() * 150))),
      nights: 2 + Math.floor(Math.random() * 4),
      cabin: to.international && Math.random() < 0.4 ? "business" : "economy",
      room: "any"
    }
  }

  // A trip from the form stops at its quotes for the traveller to choose. A
  // random trip takes the suggested picks and goes straight on.
  submit(request: TripRequest, auto = false): Trip {
    this.seq += 1
    const trip: Trip = {
      id: `T${String(this.seq).padStart(3, "0")}`,
      request,
      status: "quoting",
      quotes: { flights: [], rooms: [], missed: [] },
      steps: { flight: "waiting", hotel: "waiting", car: "waiting" },
      refs: {}
    }
    this.trips.set(trip.id, trip)
    feed.add(
      "desk",
      `${request.traveller} wants ${request.from} to ${request.city}, departing ${request.depart}, ${String(request.nights)} nights, ${request.cabin}`,
      "info",
      trip.id
    )
    void this.process(trip, auto).catch((error: unknown) => this.fail(trip, error))
    return trip
  }

  private fail(trip: Trip, error: unknown): void {
    trip.note = errorText(error)
    this.advance(trip, "failed")
    feed.add("desk", `trip failed: ${errorText(error)}`, "bad", trip.id)
  }

  // The traveller's request is the session's first state: what they asked
  // for, before any supplier is asked.
  private async begin(trip: Trip): Promise<void> {
    const r = trip.request
    const { session, lease } = await this.laser
      .sessions()
      .start()
      .agent(DESK)
      .tag(`trip:${trip.id}`)
      .tag(`traveller:${r.traveller}`)
      .tag(`city:${r.city}`)
      .begin()
    trip.session = session.conversation.toString()
    const open: OpenSession = { session, lease, writes: Promise.resolve() }
    this.sessions.set(trip.id, open)
    open.writes = session.state().set("intent", { op: "book-trip", ...r }).then(() => undefined)
    await open.writes
    feed.add("desk", `session ${trip.session} opened for this trip`, "info", trip.id)
  }

  // Move the trip on and record it on its session. The booking saga runs
  // inside the session and ends it; a trip settled before the saga ends it
  // here: completed when the desk reached a decision, failed when it could
  // not finish.
  private advance(trip: Trip, status: Trip["status"], detail: Record<string, unknown> = {}): void {
    trip.status = status
    const open = this.sessions.get(trip.id)
    if (open === undefined) return
    const state = open.session.state()
    open.writes = open.writes
      .then(async () => {
        for (const [key, value] of Object.entries(detail)) await state.set(key, value)
        await state.set("status", status)
        if (!SETTLED.includes(status)) return
        this.sessions.delete(trip.id)
        if (trip.run !== trip.session) {
          if (status === "failed") {
            await open.session.fail({ code: { kind: "known", name: "ToolFailure" }, message: trip.note ?? status, retryable: false })
          } else {
            await open.session.end()
          }
        }
        open.lease.release()
      })
      .catch((error: unknown) => {
        feed.add("desk", `could not record the trip on its session: ${errorText(error)}`, "warn", trip.id)
      })
  }

  private async process(trip: Trip, auto: boolean): Promise<void> {
    await this.begin(trip)
    await this.quote(trip)
    const suggested = this.suggest(trip)
    if (suggested === undefined) return
    trip.suggested = suggested
    const q = trip.quotes
    this.advance(trip, "choosing", {
      quotes: { flights: q.flights.length, rooms: q.rooms.length, car: q.car !== undefined, missed: q.missed },
      suggested
    })
    if (auto) await this.proceed(trip, suggested)
  }

  // The traveller's pick from the quotes on the card. Booking runs on after
  // the call returns.
  choose(tripId: string, choice: Choice): void {
    const trip = this.trips.get(tripId)
    if (trip?.status !== "choosing") return
    trip.status = "policy"
    void this.proceed(trip, choice).catch((error: unknown) => this.fail(trip, error))
  }

  private async proceed(trip: Trip, choice: Choice): Promise<void> {
    const proposal = this.propose(trip, choice)
    if (proposal === undefined) {
      trip.status = "choosing"
      return
    }
    trip.choice = choice
    trip.proposal = proposal
    this.advance(trip, "policy", { choice, proposal })
    await this.publishProposal(trip, { proposal })
  }

  // Ask every airline and every hotel in the destination for a price at once,
  // and the car hire firm on its own contract. Whoever has not answered by the
  // deadline is left out.
  private async quote(trip: Trip): Promise<void> {
    const r = trip.request
    const request: QuoteRequest = { op: "quote", trip: trip.id, from: r.from, to: r.city, depart: r.depart, nights: r.nights, cabin: r.cabin }
    const panel = <T>(skill: string): Promise<T[]> =>
      this.laser
        .scatter(DESK, capabilitySelector(skill, { kind: "any" }), jsonBytes(request), FIXED_INBOX, settings.quoteDeadlineMs)
        .then((bodies) => bodies.map((body) => parseJson<T>(body)))
    const car = this.laser
      .contract(routeToCapable("quote-car", { kind: "any" }))
      .from(DESK)
      .payload(jsonBytes(request))
      .inboxRoute(FIXED_INBOX)
      .deadline(settings.carDeadlineMs)
      .send()
    const [flights, hotels, carOutcome] = await Promise.all([
      panel<Quote>("quote-flight"),
      panel<HotelReply>(hotelSkill(r.city)),
      car
    ])
    trip.quotes.flights = flights.sort((a, b) => a.price - b.price)
    trip.quotes.rooms = hotels.flatMap((h) => h.rooms).sort((a, b) => a.price - b.price)
    const answered = new Set([...flights.map((q) => q.supplier), ...hotels.map((h) => h.supplier)])
    trip.quotes.missed = [...AIRLINES.map((a) => a.id), ...hotelsIn(r.city).map((h) => h.id)].filter((id) => !answered.has(id)).map(nameOf)
    for (const name of trip.quotes.missed) {
      feed.add("desk", `${name} was too slow to quote (the desk waits ${String(settings.quoteDeadlineMs / 1000)} seconds)`, "warn", trip.id)
    }
    if (carOutcome.kind === "completed") {
      trip.quotes.car = parseJson<Quote>(agentMessageBody(carOutcome.reply))
    } else {
      trip.steps.car = "skipped"
      feed.add("desk", `${CAR_HIRE.name} was too slow to quote (the desk waits ${String(settings.carDeadlineMs / 1000)} seconds); the trip goes ahead without a car`, "warn", trip.id)
    }
    feed.add("desk", `${String(flights.length)} flight and ${String(trip.quotes.rooms.length)} room prices in`, "info", trip.id)
  }

  // The cheapest flight, and the cheapest room of the type asked for.
  private suggest(trip: Trip): Choice | undefined {
    const want = trip.request.room
    const flight = trip.quotes.flights[0]
    const room = trip.quotes.rooms.find((q) => want === "any" || q.room === want)
    if (flight === undefined || room?.room === undefined) {
      trip.note = flight === undefined ? "no flight quoted in time" : `no ${want === "any" ? "" : roomLabel(want) + " "}room quoted in time`
      this.advance(trip, "failed")
      feed.add("desk", trip.note, "bad", trip.id)
      return undefined
    }
    return { flight: flight.supplier, hotel: room.supplier, room: room.room }
  }

  private propose(trip: Trip, choice: Choice): Proposal | undefined {
    const r = trip.request
    const flight = trip.quotes.flights.find((q) => q.supplier === choice.flight)
    const room = trip.quotes.rooms.find((q) => q.supplier === choice.hotel && q.room === choice.room)
    if (flight === undefined || room === undefined) {
      trip.note = "that flight or room was not quoted"
      return undefined
    }
    const car = trip.quotes.car
    const total = flight.price + room.price + (car?.price ?? 0)
    const base = {
      trip: trip.id,
      traveller: r.traveller,
      from: r.from,
      city: r.city,
      depart: r.depart,
      international: cityNamed(r.city)?.international ?? false,
      cabin: r.cabin,
      nights: r.nights,
      flight: { supplier: flight.supplier, name: flight.name, price: flight.price },
      hotel: { supplier: room.supplier, name: room.name, room: roomLabel(choice.room), price: room.price, nightly: room.nightly ?? Math.round(room.price / r.nights) }
    }
    trip.note = undefined
    return car === undefined
      ? { ...base, total }
      : { ...base, car: { supplier: car.supplier, name: car.name, price: car.price }, total }
  }

  // The booker's publish is what the governor sees. A block or a step-up comes
  // back as an error before anything reaches the log.
  private async publishProposal(trip: Trip, record: ProposalRecord): Promise<void> {
    const proposal = record.proposal
    try {
      await this.booker.stream(settings.stream).topic(PROPOSALS).publish().json(record).send()
    } catch (error) {
      const reason = this.policy.reasons.get(trip.id) ?? error
      if (error instanceof PolicyBlockedError) {
        trip.verdict = { kind: "block", reason: String(reason) }
        this.advance(trip, "blocked", { verdict: trip.verdict })
        feed.add("policy", `blocked: ${trip.verdict.reason}`, "bad", trip.id)
        await this.writeLedger(trip, "blocked", trip.verdict.reason)
        return
      }
      if (error instanceof StepUpRequiredError) {
        const conversation = this.sessions.get(trip.id)?.session.conversation ?? ConversationId.derive(`trip/${trip.id}`)
        const intent = this.approvals.open(conversation, proposal)
        trip.verdict = { kind: "step_up", reason: String(reason) }
        trip.vote = { intent: intent.intentId.toString() }
        this.advance(trip, "voting", { verdict: trip.verdict, vote: trip.vote })
        feed.add("policy", `needs approval: ${trip.verdict.reason}; the manager and finance must both approve`, "warn", trip.id)
        await this.laser
          .stream(settings.stream)
          .topic(VOTES)
          .publish()
          .json({ kind: "intent", trip: trip.id, intent: intent.intentId.toString(), digest: intent.digest, voters: ["manager", "finance"] })
          .send()
        return
      }
      throw error
    }
    trip.verdict = { kind: "allow", reason: this.policy.reasons.get(trip.id) ?? "within policy" }
    this.advance(trip, "policy", { verdict: trip.verdict })
    feed.add("policy", `allowed: ${trip.verdict.reason}`, "good", trip.id)
    await this.book(trip, proposal)
  }

  async vote(tripId: string, voterName: "manager" | "finance", approve: boolean): Promise<void> {
    const trip = this.trips.get(tripId)
    if (trip?.vote === undefined || trip.vote.outcome !== undefined || trip.proposal === undefined) return
    if (trip.vote[voterName] !== undefined) return
    const voter = voterName === "manager" ? MANAGER : FINANCE
    const choice = approve ? VoteChoice.Allow : VoteChoice.Block
    const { vote, decision } = this.approvals.cast(trip.vote.intent, voter, choice)
    trip.vote[voterName] = choice
    feed.add(voterName, `${approve ? "approved" : "declined"} ${trip.request.traveller}'s trip`, approve ? "good" : "bad", trip.id)
    await this.laser
      .stream(settings.stream)
      .topic(VOTES)
      .publish()
      .json({ kind: "vote", trip: trip.id, intent: trip.vote.intent, digest: vote.intentDigest, voter: voterName, choice })
      .send()
    if (decision === undefined) return
    trip.vote.outcome = decision.outcome
    trip.vote.reason = decision.reason
    this.advance(trip, trip.status, { vote: trip.vote })
    await this.laser
      .stream(settings.stream)
      .topic(VOTES)
      .publish()
      .json({ kind: "decision", trip: trip.id, intent: trip.vote.intent, outcome: decision.outcome, reason: decision.reason })
      .send()
    if (decision.outcome === "committed") {
      feed.add("desk", "approved by the manager and finance; booking now", "good", trip.id)
      await this.publishProposal(trip, { proposal: trip.proposal, approvedIntent: trip.vote.intent })
    } else {
      this.advance(trip, "declined")
      feed.add("desk", `declined by ${trip.vote.manager === VoteChoice.Block ? "the manager" : "finance"}; the trip is not booked`, "bad", trip.id)
      await this.writeLedger(trip, "declined", decision.reason)
    }
  }

  // Flight, then hotel, then car. A step that fails runs the compensations
  // of the steps before it, newest first. The hotel step holds a fenced lease
  // and is reassigned if it times out.
  private async book(trip: Trip, p: Proposal): Promise<void> {
    this.advance(trip, "booking")
    const r = trip.request
    const leg = { trip: trip.id, from: r.from, to: r.city, depart: r.depart }
    const book = (kind: "flight" | "hotel" | "car", extra: Partial<BookRequest> = {}) =>
      (_: StepContext): Uint8Array => {
        trip.steps[kind] = "working"
        const request: BookRequest = { op: "book", ...leg, traveller: r.traveller, nights: r.nights, ...extra }
        return jsonBytes(request)
      }
    const cancel = (kind: "flight" | "hotel" | "car", extra: Partial<CancelRequest> = {}) =>
      ({ outputs }: StepContext): Uint8Array => {
        const output = outputs.get(kind)
        const booked = output === undefined ? undefined : parseJson<Booked>(output)
        trip.steps[kind] = "cancelled"
        const request: CancelRequest = { op: "cancel", ...leg, ref: booked?.ref ?? "", ...extra }
        return jsonBytes(request)
      }
    const verify = (kind: "flight" | "hotel" | "car") =>
      (output: Uint8Array): boolean => {
        const booked = parseJson<Booked>(output)
        if (booked.ok && booked.ref !== undefined) {
          trip.steps[kind] = "done"
          trip.refs[kind] = booked.ref
          return true
        }
        trip.steps[kind] = "failed"
        trip.note = booked.reason ?? `${kind} booking failed`
        return false
      }
    const roomExtra = trip.choice === undefined ? {} : { room: trip.choice.room }

    const run = this.sessions.get(trip.id)?.session.conversation ?? ConversationId.derive(`trip-run/${trip.id}/${String(Date.now())}`)
    trip.run = run.toString()
    let workflow = this.laser
      .workflow("trip")
      .inboxRoute(FIXED_INBOX)
      .runId(run)
      .budget(WorkflowBudget.unlimited().wallClock(120_000))
      .step("flight", routeTo(AgentId.new(p.flight.supplier)), book("flight", { cabin: p.cabin as Cabin }))
      .verifyWith(verify("flight"))
      .compensateWith(cancel("flight"))
      .step("hotel", routeTo(AgentId.new(p.hotel.supplier)), book("hotel", roomExtra))
      .after("flight")
      .exclusiveIn(FENCE_NAMESPACE)
      .onTimeout("reassign")
      .verifyWith(verify("hotel"))
      .compensateWith(cancel("hotel", roomExtra))
    if (p.car !== undefined) {
      workflow = workflow
        .step("car", routeTo(AgentId.new(p.car.supplier)), book("car"))
        .after("hotel")
        .verifyWith(verify("car"))
        .compensateWith(cancel("car"))
    }
    feed.add("desk", "booking the flight, then the hotel, then the car", "info", trip.id)
    try {
      await workflow.run()
    } catch (error) {
      for (const kind of ["flight", "hotel", "car"] as const) {
        if (trip.steps[kind] === "working") trip.steps[kind] = "failed"
        if (trip.steps[kind] === "waiting") trip.steps[kind] = "skipped"
      }
      trip.note ??= errorText(error)
      this.advance(trip, "unwound", { steps: trip.steps, refs: trip.refs, note: trip.note })
      feed.add("desk", `could not finish: ${trip.note}. The bookings already made were cancelled`, "bad", trip.id)
      await this.writeLedger(trip, "unwound", trip.note)
      return
    }
    this.advance(trip, "booked", { steps: trip.steps, refs: trip.refs })
    feed.add("desk", `${r.traveller} is booked, $${String(p.total)}`, "good", trip.id)
    await this.writeLedger(trip, "booked")
  }

  private async writeLedger(trip: Trip, status: LedgerRecord["status"], reason?: string): Promise<void> {
    const p = trip.proposal
    const lines: LedgerRecord["lines"] = p === undefined
      ? []
      : [
          { kind: "flight", supplier: p.flight.name, price: p.flight.price, ...(trip.refs["flight"] === undefined ? {} : { ref: trip.refs["flight"] }) },
          { kind: "hotel", supplier: p.hotel.name, price: p.hotel.price, ...(trip.refs["hotel"] === undefined ? {} : { ref: trip.refs["hotel"] }) },
          ...(p.car === undefined
            ? []
            : [{ kind: "car", supplier: p.car.name, price: p.car.price, ...(trip.refs["car"] === undefined ? {} : { ref: trip.refs["car"] }) }])
        ]
    const record: LedgerRecord = {
      trip: trip.id,
      traveller: trip.request.traveller,
      city: trip.request.city,
      status,
      total: p?.total ?? 0,
      approval: trip.vote === undefined ? "none" : "vote",
      lines,
      ...(reason === undefined ? {} : { reason })
    }
    await this.laser.stream(settings.stream).topic(LEDGER).publish().json(record).send()
    this.ledger.records += 1
    this.ledger.bytes += jsonBytes(record).byteLength
  }
}

export function validDate(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(parseDate(iso).getTime())
}

function nameOf(id: string): string {
  return AIRLINES.find((a) => a.id === id)?.name ?? HOTELS.find((h) => h.id === id)?.name ?? id
}
