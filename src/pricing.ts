// How suppliers price a quote. Nothing has a fixed price: a fare or a room
// rate starts from a base and moves with how far ahead the trip is booked,
// the season, the day of the week and how full the flight or hotel is. Each
// quote carries the reasons it moved, so the page can show them.

import { BUSINESS_FACTOR, type Airline, type Cabin, type City } from "./config.js"

const DAY = 86_400_000

export interface Priced {
  readonly price: number
  readonly reasons: readonly string[]
}

interface Factor {
  readonly factor: number
  readonly reason?: string
}

// A YYYY-MM-DD date as midnight UTC.
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function today(): Date {
  return parseDate(isoDate(new Date()))
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY)
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY)
}

// Easter Sunday in the Gregorian calendar.
export function easter(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

function within(date: Date, start: Date, end: Date): boolean {
  return date.getTime() >= start.getTime() && date.getTime() <= end.getTime()
}

// Australian peak periods, and each international city's own high season.
export function season(date: Date, city: City): Factor {
  const y = date.getUTCFullYear()
  const m = date.getUTCMonth()
  const md = (month: number, day: number): Date => new Date(Date.UTC(y, month, day))
  let factor = 1
  const reasons: string[] = []
  const peak = (f: number, reason: string): void => {
    factor *= f
    reasons.push(reason)
  }
  if (within(date, md(11, 18), md(11, 31)) || m === 0) peak(1.3, "Christmas and January peak")
  const e = easter(y)
  if (within(date, addDays(e, -3), addDays(e, 7))) peak(1.25, "Easter")
  if (within(date, md(5, 27), md(6, 19))) peak(1.2, "July school holidays")
  if (within(date, md(8, 19), md(9, 4))) peak(1.1, "September school holidays")
  if (city.id === "auckland" && (m === 11 || m <= 1)) peak(1.15, "Auckland's summer high season")
  if (city.id === "singapore" && (m === 11 || m <= 1)) peak(1.1, "Singapore's high season")
  return reasons.length === 0 ? { factor } : { factor, reason: reasons.join(", ") }
}

// Booking well ahead is cheapest; prices climb as the date gets close.
export function leadTime(kind: "flight" | "stay", days: number): Factor {
  const steps: readonly [number, number][] = kind === "flight"
    ? [[3, 1.6], [7, 1.4], [14, 1.25], [30, 1.1], [60, 1.0], [120, 0.9]]
    : [[3, 1.25], [7, 1.15], [14, 1.08], [60, 1.0], [120, 0.97]]
  const far = kind === "flight" ? 0.85 : 0.95
  const factor = steps.find(([limit]) => days <= limit)?.[1] ?? far
  if (factor > 1) return { factor, reason: days <= 1 ? "departs tomorrow" : `${String(days)} days out` }
  if (factor < 1) return { factor, reason: `booked ${String(Math.round(days / 30))} months ahead` }
  return { factor }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// Friday and Sunday flights are busiest, midweek ones quietest.
export function departureDay(date: Date): Factor {
  const day = date.getUTCDay()
  if (day === 5 || day === 0) return { factor: 1.12, reason: `${WEEKDAYS[day] ?? ""} flight` }
  if (day === 2 || day === 3) return { factor: 0.95, reason: "midweek flight" }
  return { factor: 1 }
}

// City hotels fill with business travellers on weeknights and are cheaper at
// the weekend. The rate is averaged over the nights of the stay.
export function stayNights(arrive: Date, nights: number): Factor {
  let total = 0
  for (let n = 0; n < nights; n += 1) {
    const day = addDays(arrive, n).getUTCDay()
    total += day >= 1 && day <= 4 ? 1.1 : day === 0 ? 1.0 : 0.9
  }
  const factor = total / Math.max(nights, 1)
  if (factor >= 1.03) return { factor, reason: "weeknight rates" }
  if (factor <= 0.97) return { factor, reason: "weekend rates" }
  return { factor }
}

function apply(base: number, factors: readonly Factor[], jitter: number): Priced {
  let price = base * jitter
  const reasons: string[] = []
  for (const f of factors) {
    price *= f.factor
    if (f.reason !== undefined) reasons.push(f.reason)
  }
  return { price: Math.round(price), reasons }
}

// A small random wobble, so two quotes for the same trip can differ.
export function wobble(): number {
  return 0.96 + Math.random() * 0.08
}

function distanceKm(a: City, b: City): number {
  const rad = (deg: number): number => (deg * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLon = rad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

// The return economy fare on a route before any of the date's pricing.
export function routeFare(from: City, to: City): number {
  return 2 * (50 + 0.09 * distanceKm(from, to))
}

export function flightPrice(
  airline: Airline,
  from: City,
  to: City,
  cabin: Cabin,
  depart: Date,
  bookedOn: Date,
  seatsSold: number,
  jitter = wobble()
): Priced {
  const base = routeFare(from, to) * airline.factor * (cabin === "business" ? BUSINESS_FACTOR : 1)
  const demand: Factor = seatsSold > 0
    ? { factor: 1 + 0.06 * seatsSold, reason: `${String(seatsSold)} ${seatsSold === 1 ? "seat" : "seats"} already sold on this flight` }
    : { factor: 1 }
  return apply(base, [leadTime("flight", daysBetween(bookedOn, depart)), season(depart, to), departureDay(depart), demand], jitter)
}

export interface RoomPriced extends Priced {
  readonly nightly: number
}

export function roomPrice(
  baseNightly: number,
  city: City,
  arrive: Date,
  nights: number,
  bookedOn: Date,
  left: number,
  total: number,
  jitter = wobble()
): RoomPriced {
  const full = total > 0 ? 1 - left / total : 0
  const demand: Factor = left <= 2 && left > 0
    ? { factor: 1 + 0.2 * full, reason: `only ${String(left)} left` }
    : { factor: 1 + 0.2 * full }
  const nightly = apply(
    baseNightly * city.cost,
    [leadTime("stay", daysBetween(bookedOn, arrive)), season(arrive, city), stayNights(arrive, nights), demand],
    jitter
  )
  return { nightly: nightly.price, price: nightly.price * nights, reasons: nightly.reasons }
}

export function carPrice(daily: number, city: City, pickup: Date, days: number, bookedOn: Date, jitter = wobble()): Priced {
  const perDay = apply(daily, [leadTime("stay", daysBetween(bookedOn, pickup)), season(pickup, city)], jitter)
  return { price: perDay.price * days, reasons: perDay.reasons }
}
