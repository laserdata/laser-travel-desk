// Settings from the environment, and the made-up world the desk books in:
// travellers, cities, suppliers and their base prices. Every supplier is
// fictional. What a supplier actually charges is worked out per quote in
// pricing.ts.

function env(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === "" ? fallback : value
}

function envNumber(name: string, fallback: number): number {
  const value = Number(env(name, String(fallback)))
  return Number.isFinite(value) ? value : fallback
}

export const settings = {
  connection: env("LASER_CONNECTION_STRING", "iggy:laser@127.0.0.1:8090"),
  stream: env("DESK_STREAM", "travel-desk"),
  keep: env("DESK_KEEP", "0") === "1",
  port: envNumber("DESK_PORT", 8010),
  auditorUser: env("DESK_AUDITOR_USER", "travel-auditor"),
  auditorPassword: env("DESK_AUDITOR_PASSWORD", "travel-auditor-local"),
  // How long the quote panel waits for suppliers, and the car hire contract.
  quoteDeadlineMs: envNumber("DESK_QUOTE_DEADLINE_MS", 2500),
  carDeadlineMs: envNumber("DESK_CAR_DEADLINE_MS", 2000),
  // How long votes stay open on a trip that needs approval.
  voteWindowMs: envNumber("DESK_VOTE_WINDOW_MS", 10 * 60_000),
  // Rooms of each type each hotel has free when the desk starts.
  rooms: envNumber("DESK_ROOMS", 4),
  // The unattended demo loop: on at startup, seconds between trips, seconds a
  // card shows its picks before it books, and seconds before a vote decides.
  demo: env("DESK_DEMO", "0") === "1",
  demoPauseMs: envNumber("DESK_DEMO_PAUSE", 8) * 1000,
  demoPickMs: envNumber("DESK_DEMO_PICK_DELAY", 4) * 1000,
  demoApproveMs: envNumber("DESK_DEMO_APPROVE_DELAY", 4) * 1000
}

export const policy = {
  // A trip over this needs a manager and finance to approve it.
  approvalOver: envNumber("DESK_APPROVAL_OVER", 1500),
  // No hotel over this a night, approved or not.
  hotelCap: envNumber("DESK_HOTEL_CAP", 400),
  version: 1n
}

export interface City {
  readonly id: string
  readonly name: string
  readonly international: boolean
  readonly lat: number
  readonly lon: number
  // Multiplies hotel rates: Sydney and Singapore cost more than Adelaide.
  readonly cost: number
}

// Trips start in an Australian city and go to any other city here.
export const CITIES: readonly City[] = [
  { id: "melbourne", name: "Melbourne", international: false, lat: -37.81, lon: 144.96, cost: 1.0 },
  { id: "sydney", name: "Sydney", international: false, lat: -33.87, lon: 151.21, cost: 1.15 },
  { id: "brisbane", name: "Brisbane", international: false, lat: -27.47, lon: 153.03, cost: 0.9 },
  { id: "perth", name: "Perth", international: false, lat: -31.95, lon: 115.86, cost: 0.95 },
  { id: "adelaide", name: "Adelaide", international: false, lat: -34.93, lon: 138.6, cost: 0.85 },
  { id: "auckland", name: "Auckland", international: true, lat: -36.85, lon: 174.76, cost: 1.0 },
  { id: "singapore", name: "Singapore", international: true, lat: 1.35, lon: 103.82, cost: 1.25 }
]

export const ORIGINS: readonly City[] = CITIES.filter((c) => !c.international)

export function cityNamed(name: string): City | undefined {
  return CITIES.find((c) => c.name === name)
}

export const TRAVELLERS: readonly string[] = [
  "Priya Raman",
  "Tom Nguyen",
  "Aroha Walker",
  "Sam Costa",
  "Mei Chen"
]

export type Cabin = "economy" | "business"

export interface Airline {
  readonly id: string
  readonly name: string
  readonly code: string
  // Multiplies the route fare.
  readonly factor: number
  // How long a quote takes, picked between these two for each quote. Thrift Air
  // is cheapest but often slower than the 2.5 second panel deadline.
  readonly quoteMs: readonly [number, number]
}

export const AIRLINES: readonly Airline[] = [
  { id: "coastal-airways", name: "Coastal Airways", code: "CW", factor: 1.0, quoteMs: [300, 600] },
  { id: "pacific-link", name: "Pacific Link", code: "PL", factor: 0.94, quoteMs: [700, 1200] },
  { id: "thrift-air", name: "Thrift Air", code: "TF", factor: 0.8, quoteMs: [1500, 4000] }
]

export const BUSINESS_FACTOR = 3.2

export type RoomType = "standard" | "deluxe" | "suite"

export const ROOM_TYPES: readonly { readonly type: RoomType; readonly label: string }[] = [
  { type: "standard", label: "standard queen" },
  { type: "deluxe", label: "deluxe king" },
  { type: "suite", label: "suite" }
]

export function roomLabel(type: RoomType): string {
  return ROOM_TYPES.find((r) => r.type === type)?.label ?? type
}

export interface Hotel {
  readonly id: string
  readonly name: string
  readonly city: string
  // Base nightly rate for each room type the hotel has, before the city's
  // cost and the date's pricing.
  readonly rooms: Readonly<Partial<Record<RoomType, number>>>
}

// Three kinds of hotel in every city: an inn with standard rooms only, a hotel
// with standard and deluxe rooms, and a suites hotel with deluxe rooms and
// suites. Suites are over the nightly cap in most cities.
const INN = { standard: 150 }
const HOTEL = { standard: 200, deluxe: 270 }
const SUITES = { deluxe: 290, suite: 460 }

const HOTEL_NAMES: Readonly<Record<string, readonly [string, string, string]>> = {
  melbourne: ["Docklands Inn", "Collins Street Hotel", "Southbank Suites"],
  sydney: ["Central Station Inn", "Circular Quay Hotel", "Darling Harbour Suites"],
  brisbane: ["Fortitude Valley Inn", "Riverside Hotel", "Kangaroo Point Suites"],
  perth: ["Northbridge Inn", "Swan River Hotel", "Kings Park Suites"],
  adelaide: ["Rundle Mall Inn", "North Terrace Hotel", "Glenelg Beach Suites"],
  auckland: ["Queen Street Inn", "Viaduct Harbour Hotel", "Ponsonby Suites"],
  singapore: ["Chinatown Inn", "Marina View Hotel", "Orchard Road Suites"]
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
}

export const HOTELS: readonly Hotel[] = CITIES.flatMap((c) => {
  const names = HOTEL_NAMES[c.id]
  if (names === undefined) return []
  const [inn, hotel, suites] = names
  return [
    { id: slug(inn), name: inn, city: c.name, rooms: INN },
    { id: slug(hotel), name: hotel, city: c.name, rooms: HOTEL },
    { id: slug(suites), name: suites, city: c.name, rooms: SUITES }
  ]
})

export function hotelsIn(city: string): readonly Hotel[] {
  return HOTELS.filter((h) => h.city === city)
}

export const CAR_HIRE = { id: "metro-car-rentals", name: "Metro Car Rentals", daily: 75 }
