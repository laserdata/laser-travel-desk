// The supplier agents. Each is its own agent on its own connection, with a
// capability card: the desk asks for a skill (quote-flight, quote-hotel/<city>,
// quote-car) and the registry says who serves it. Bookings and cancellations
// come as workflow steps and compensations addressed to one supplier.

import {
  Agent,
  AgentId,
  AgentTopic,
  isLeaseLost,
  type AgentCtx,
  type AgentHandle,
  type Health,
  type Laser
} from "@laserdata/laser-sdk"

import {
  AIRLINES,
  CAR_HIRE,
  HOTELS,
  cityNamed,
  roomLabel,
  settings,
  type Airline,
  type Cabin,
  type City,
  type Hotel,
  type RoomType
} from "./config.js"
import { carPrice, flightPrice, parseDate, roomPrice, today } from "./pricing.js"
import { faults, feed } from "./state.js"
import { connect, errorText, jsonBytes, messageJson, ref, sleep, utf8 } from "./util.js"

const HEALTHY: Health = { kind: "known", name: "Healthy" }

// The workflow takes its fence lease in this namespace, and the hotels check
// the same lease when they write the room count.
export const FENCE_NAMESPACE = "fence"
export const ROOMS = "rooms"
export const BOOKINGS = "bookings"

// A stalled clerk holds the booking past the workflow's 30 second step deadline.
const STALL_MS = 33_000

export function hotelSkill(city: string): string {
  return `quote-hotel/${city.toLowerCase()}`
}

export interface QuoteRequest {
  readonly op: "quote"
  readonly trip: string
  readonly from: string
  readonly to: string
  // YYYY-MM-DD
  readonly depart: string
  readonly nights: number
  readonly cabin: Cabin
}

export interface BookRequest {
  readonly op: "book"
  readonly trip: string
  readonly traveller: string
  readonly from: string
  readonly to: string
  readonly depart: string
  readonly nights: number
  readonly cabin?: Cabin
  readonly room?: RoomType
}

export interface CancelRequest {
  readonly op: "cancel"
  readonly trip: string
  readonly ref: string
  readonly from: string
  readonly to: string
  readonly depart: string
  readonly room?: RoomType
}

export type SupplierRequest = QuoteRequest | BookRequest | CancelRequest

export interface Quote {
  readonly supplier: string
  readonly name: string
  readonly price: number
  readonly detail: string
  // Why the price is what it is today: "Easter", "10 days out", ...
  readonly reasons: readonly string[]
  readonly room?: RoomType
  readonly nightly?: number
  readonly left?: number
}

// A hotel answers one quote request with every room type it has free.
export interface HotelReply {
  readonly supplier: string
  readonly name: string
  readonly rooms: readonly Quote[]
}

export interface Booked {
  readonly ok: boolean
  readonly supplier: string
  readonly ref?: string
  readonly reason?: string
}

export function roomKey(hotel: string, room: RoomType): Uint8Array {
  return utf8(`${hotel}:${room}`)
}

function cityOf(name: string): City {
  const city = cityNamed(name)
  if (city === undefined) throw new Error(`unknown city ${name}`)
  return city
}

function dayLabel(iso: string): string {
  return parseDate(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" })
}

export class Suppliers {
  private readonly connections: Laser[] = []
  private readonly handles: AgentHandle[] = []
  // Seats each airline has sold on each flight, by airline, route and date.
  private readonly sold = new Map<string, number>()

  async start(): Promise<void> {
    for (const airline of AIRLINES) {
      await this.spawn(airline.id, ["quote-flight"], (request, ctx) => this.airline(airline, request, ctx))
    }
    for (const hotel of HOTELS) {
      await this.spawn(hotel.id, [hotelSkill(hotel.city)], (request, ctx) => this.hotel(hotel, request, ctx))
    }
    await this.spawn(CAR_HIRE.id, ["quote-car"], (request, ctx) => this.car(request, ctx))
  }

  // Every room free again and no seats sold, for a fresh demo round.
  async reset(laser: Laser): Promise<void> {
    this.sold.clear()
    await this.seedRooms(laser)
  }

  async seedRooms(laser: Laser): Promise<void> {
    for (const hotel of HOTELS) {
      for (const room of Object.keys(hotel.rooms) as RoomType[]) {
        await laser.kv(ROOMS).set(roomKey(hotel.id, room)).json({ left: settings.rooms }).send()
      }
    }
  }

  async stop(): Promise<void> {
    for (const handle of this.handles) await handle[Symbol.asyncDispose]()
    for (const laser of this.connections) await laser.close()
  }

  private async spawn(
    id: string,
    skills: readonly string[],
    handle: (request: SupplierRequest, ctx: AgentCtx) => Promise<void>
  ): Promise<void> {
    const laser = await connect()
    this.connections.push(laser)
    const agent = Agent.builder()
      .id(AgentId.new(id))
      .listenOn(AgentTopic.Sessions)
      .respondOn(AgentTopic.Sessions)
      .capabilities(skills.map((skillId) => ({ skillId, health: HEALTHY })))
      .handler({
        async handle(message, ctx): Promise<void> {
          await handle(messageJson<SupplierRequest>(message), ctx)
        }
      })
      .build()
      .spawn(laser)
    this.handles.push(agent)
    await agent.ready()
  }

  private flightKey(airline: Airline, request: { from: string; to: string; depart: string }): string {
    return `${airline.id}:${request.from}-${request.to}:${request.depart}`
  }

  private async airline(airline: Airline, request: SupplierRequest, ctx: AgentCtx): Promise<void> {
    switch (request.op) {
      case "quote": {
        const [fastest, slowest] = airline.quoteMs
        await sleep(fastest + Math.random() * (slowest - fastest))
        const sold = this.sold.get(this.flightKey(airline, request)) ?? 0
        const priced = flightPrice(airline, cityOf(request.from), cityOf(request.to), request.cabin, parseDate(request.depart), today(), sold)
        const quote: Quote = {
          supplier: airline.id,
          name: airline.name,
          price: priced.price,
          detail: `${airline.code} ${request.cabin}, ${request.from} to ${request.to} return, departs ${dayLabel(request.depart)}`,
          reasons: priced.reasons
        }
        await ctx.respond(jsonBytes(quote))
        return
      }
      case "book": {
        const key = this.flightKey(airline, request)
        this.sold.set(key, (this.sold.get(key) ?? 0) + 1)
        const booked: Booked = { ok: true, supplier: airline.id, ref: ref(airline.code) }
        await this.record(ctx.laser, booked.ref ?? "", { ...request, supplier: airline.id, kind: "flight" })
        feed.add(airline.name, `ticketed ${request.traveller}, ${request.from} to ${request.to} on ${dayLabel(request.depart)}, ${booked.ref ?? ""}`, "good", request.trip)
        await ctx.respond(jsonBytes(booked))
        return
      }
      case "cancel": {
        const key = this.flightKey(airline, request)
        this.sold.set(key, Math.max(0, (this.sold.get(key) ?? 0) - 1))
        await this.unrecord(ctx.laser, request.ref)
        feed.add(airline.name, `cancelled ticket ${request.ref}`, "warn", request.trip)
        await ctx.respond(jsonBytes({ ok: true, supplier: airline.id, ref: request.ref }))
        return
      }
    }
  }

  private async roomsLeft(laser: Laser, hotel: Hotel, room: RoomType): Promise<number> {
    const entry = await laser.kv(ROOMS).getEntry(roomKey(hotel.id, room))
    return entry === undefined ? 0 : (JSON.parse(new TextDecoder().decode(entry.value)) as { left: number }).left
  }

  private async hotel(hotel: Hotel, request: SupplierRequest, ctx: AgentCtx): Promise<void> {
    const rooms = ctx.laser.kv(ROOMS)
    switch (request.op) {
      case "quote": {
        await sleep(300)
        const city = cityOf(hotel.city)
        const quotes: Quote[] = []
        for (const [room, base] of Object.entries(hotel.rooms) as [RoomType, number][]) {
          const left = await this.roomsLeft(ctx.laser, hotel, room)
          if (left < 1) continue
          const priced = roomPrice(base, city, parseDate(request.depart), request.nights, today(), left, settings.rooms)
          quotes.push({
            supplier: hotel.id,
            name: hotel.name,
            room,
            nightly: priced.nightly,
            left,
            price: priced.price,
            detail: `${roomLabel(room)}, ${String(request.nights)} nights at $${String(priced.nightly)}`,
            reasons: priced.reasons
          })
        }
        const reply: HotelReply = { supplier: hotel.id, name: hotel.name, rooms: quotes }
        await ctx.respond(jsonBytes(reply))
        return
      }
      case "book": {
        // The workflow holds a lease for this step and stamps its fence token
        // on the request. The room count only takes a write carrying the
        // current token, so a clerk whose step was reassigned cannot also
        // take a room.
        const provenance = ctx.message.provenance
        const run = provenance.rootConversationId ?? provenance.parentConversationId
        const token = provenance.fenceToken
        const room = request.room ?? "standard"
        if (run === undefined || token === undefined) {
          await ctx.respond(jsonBytes({ ok: false, supplier: hotel.id, reason: "no fence on the request" }))
          return
        }
        const key = roomKey(hotel.id, room)
        if (faults.stallClerk) {
          faults.stallClerk = false
          feed.add(hotel.name, `clerk stalled on ${request.traveller}'s room (attempt ${token.toString()})`, "warn", request.trip)
          await sleep(STALL_MS)
        }
        const entry = await rooms.getEntry(key)
        const left = entry === undefined ? 0 : (JSON.parse(new TextDecoder().decode(entry.value)) as { left: number }).left
        if (entry === undefined || left < 1) {
          feed.add(hotel.name, `no ${roomLabel(room)} rooms left`, "bad", request.trip)
          await ctx.respond(jsonBytes({ ok: false, supplier: hotel.id, reason: `${hotel.name} has no ${roomLabel(room)} rooms left` }))
          return
        }
        try {
          await rooms
            .casFenced(key, FENCE_NAMESPACE, utf8(run.toString()), token)
            .expectVersion(entry.version)
            .json({ left: left - 1 })
            .commit()
        } catch (error) {
          // A stale fence comes back as a lost lease.
          if (isLeaseLost(error)) {
            feed.add(hotel.name, `the stalled clerk woke up, but attempt ${token.toString()} had been handed to another clerk, so no second room was taken`, "bad", request.trip)
            return
          }
          feed.add(hotel.name, `room write failed: ${errorText(error)}`, "bad", request.trip)
          throw error
        }
        const booked: Booked = { ok: true, supplier: hotel.id, ref: ref("H") }
        await this.record(ctx.laser, booked.ref ?? "", { ...request, supplier: hotel.id, kind: "hotel" })
        feed.add(hotel.name, `held a ${roomLabel(room)} for ${request.traveller} (attempt ${token.toString()}), ${String(left - 1)} left`, "good", request.trip)
        await ctx.respond(jsonBytes(booked))
        return
      }
      case "cancel": {
        const key = roomKey(hotel.id, request.room ?? "standard")
        for (;;) {
          const entry = await rooms.getEntry(key)
          if (entry === undefined) break
          const left = (JSON.parse(new TextDecoder().decode(entry.value)) as { left: number }).left
          try {
            await rooms.set(key).json({ left: left + 1 }).expectVersion(entry.version).commit()
            break
          } catch {
            // Someone else moved the count first. Read it again.
          }
        }
        await this.unrecord(ctx.laser, request.ref)
        feed.add(hotel.name, `cancelled room booking ${request.ref}`, "warn", request.trip)
        await ctx.respond(jsonBytes({ ok: true, supplier: hotel.id, ref: request.ref }))
        return
      }
    }
  }

  private async car(request: SupplierRequest, ctx: AgentCtx): Promise<void> {
    switch (request.op) {
      case "quote": {
        await sleep(faults.slowCarQuote ? settings.carDeadlineMs + 1500 : 300)
        const priced = carPrice(CAR_HIRE.daily, cityOf(request.to), parseDate(request.depart), request.nights, today())
        const quote: Quote = {
          supplier: CAR_HIRE.id,
          name: CAR_HIRE.name,
          price: priced.price,
          detail: `${String(request.nights)} days from ${request.to} airport`,
          reasons: priced.reasons
        }
        await ctx.respond(jsonBytes(quote))
        return
      }
      case "book": {
        if (faults.carRejects) {
          faults.carRejects = false
          feed.add(CAR_HIRE.name, `turned down ${request.traveller}: no cars left at ${request.to} airport`, "bad", request.trip)
          await ctx.respond(jsonBytes({ ok: false, supplier: CAR_HIRE.id, reason: `no cars left at ${request.to} airport` }))
          return
        }
        const booked: Booked = { ok: true, supplier: CAR_HIRE.id, ref: ref("MC") }
        await this.record(ctx.laser, booked.ref ?? "", { ...request, supplier: CAR_HIRE.id, kind: "car" })
        feed.add(CAR_HIRE.name, `car booked for ${request.traveller}, ${booked.ref ?? ""}`, "good", request.trip)
        await ctx.respond(jsonBytes(booked))
        return
      }
      case "cancel": {
        await this.unrecord(ctx.laser, request.ref)
        feed.add(CAR_HIRE.name, `cancelled car ${request.ref}`, "warn", request.trip)
        await ctx.respond(jsonBytes({ ok: true, supplier: CAR_HIRE.id, ref: request.ref }))
        return
      }
    }
  }

  private async record(laser: Laser, bookingRef: string, value: unknown): Promise<void> {
    await laser.kv(BOOKINGS).set(utf8(bookingRef)).json(value).send()
  }

  private async unrecord(laser: Laser, bookingRef: string): Promise<void> {
    await laser.kv(BOOKINGS).delete(utf8(bookingRef))
  }
}
