import { readFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

import { Auditor } from "./audit.js"
import { CITIES, ORIGINS, ROOM_TYPES, TRAVELLERS, cityNamed, policy, settings, type RoomType } from "./config.js"
import { DemoLoop } from "./demo.js"
import { Desk, validDate, type TripRequest } from "./desk.js"
import { FinanceReader } from "./finance.js"
import { addDays, isoDate, today } from "./pricing.js"
import { faults, feed, type Faults } from "./state.js"
import { Suppliers } from "./suppliers.js"
import { connect, errorText } from "./util.js"

const STATIC = fileURLToPath(new URL("../../static/", import.meta.url))
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" }

const laser = await connect()
await Desk.prepare(laser)
const desk = await Desk.open(laser)
const suppliers = new Suppliers()
await suppliers.seedRooms(laser)
await suppliers.start()
const finance = new FinanceReader()
await finance.start(laser)
const auditor = new Auditor()
await auditor.start(laser)
feed.add("desk", "desk open", "good")
const demo = new DemoLoop(desk, suppliers, laser, auditor, TRAVELLERS)
if (settings.demo) demo.start()

function state(): unknown {
  return {
    demo: demo.running,
    trips: desk.list(),
    events: feed.recent(),
    faults,
    ledger: desk.ledger,
    finance: { seen: finance.seen, bytes: finance.bytes, error: finance.error },
    audit: { results: auditor.results.slice(0, 6), error: auditor.error },
    policy: { approvalOver: policy.approvalOver, hotelCap: policy.hotelCap },
    options: {
      travellers: TRAVELLERS,
      origins: ORIGINS.map((c) => c.name),
      cities: CITIES.map((c) => ({ name: c.name, international: c.international })),
      rooms: ROOM_TYPES,
      today: isoDate(today()),
      depart: isoDate(addDays(today(), 21))
    }
  }
}

function tripRequest(input: Record<string, unknown>): TripRequest | string {
  const from = String(input["from"])
  const city = String(input["city"])
  const depart = String(input["depart"])
  const nights = Number(input["nights"])
  const room = String(input["room"])
  if (cityNamed(from)?.international !== false) return "pick an Australian city to fly from"
  if (cityNamed(city) === undefined || city === from) return "pick a destination other than the origin"
  if (!validDate(depart) || depart < isoDate(today())) return "pick a departure date from today on"
  if (!Number.isInteger(nights) || nights < 1 || nights > 14) return "stay between 1 and 14 nights"
  return {
    traveller: TRAVELLERS.includes(String(input["traveller"])) ? String(input["traveller"]) : TRAVELLERS[0] ?? "Traveller",
    from,
    city,
    depart,
    nights,
    cabin: input["cabin"] === "business" ? "business" : "economy",
    room: ROOM_TYPES.some((r) => r.type === room) ? (room as RoomType) : "any"
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = ""
  for await (const chunk of req) text += String(chunk)
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)))
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, state())
  if (req.method === "POST" && url.pathname === "/api/trips") {
    const input = await body(req)
    demo.stop("demo loop off: someone took over")
    if (input["random"] === true) return send(res, 200, desk.submit(desk.randomRequest(), true))
    const request = tripRequest(input)
    if (typeof request === "string") return send(res, 400, { error: request })
    return send(res, 200, desk.submit(request))
  }
  if (req.method === "POST" && url.pathname === "/api/demo") {
    const input = await body(req)
    if (input["on"] === true) demo.start()
    else demo.stop()
    return send(res, 200, { demo: demo.running })
  }
  if (req.method === "POST" && url.pathname === "/api/choose") {
    const input = await body(req)
    demo.stop("demo loop off: someone took over")
    const room = String(input["room"])
    if (!ROOM_TYPES.some((r) => r.type === room)) return send(res, 400, { error: "unknown room type" })
    desk.choose(String(input["trip"]),{ flight: String(input["flight"]), hotel: String(input["hotel"]), room: room as RoomType })
    return send(res, 200, { ok: true })
  }
  if (req.method === "POST" && url.pathname === "/api/vote") {
    const input = await body(req)
    demo.stop("demo loop off: someone took over")
    await desk.vote(String(input["trip"]), input["voter"] === "finance" ? "finance" : "manager", input["approve"] === true)
    return send(res, 200, { ok: true })
  }
  if (req.method === "POST" && url.pathname === "/api/faults") {
    const input = await body(req)
    const name = String(input["name"]) as keyof Faults
    if (name in faults) faults[name] = input["value"] === true
    return send(res, 200, faults)
  }
  if (req.method === "POST" && url.pathname === "/api/audit") {
    const input = await body(req)
    return send(res, 200, input["action"] === "tamper" ? await auditor.tamper() : await auditor.read())
  }
  if (req.method === "GET") {
    const path = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/static\//, "")
    const file = normalize(join(STATIC, path))
    if (!file.startsWith(STATIC)) return send(res, 404, { error: "not found" })
    try {
      const content = await readFile(file)
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" })
      res.end(content)
      return
    } catch {
      return send(res, 404, { error: "not found" })
    }
  }
  send(res, 404, { error: "not found" })
}

const server = createServer((req, res) => {
  route(req, res).catch((error: unknown) => send(res, 500, { error: errorText(error) }))
})
server.listen(settings.port, "127.0.0.1", () => {
  console.log(`travel desk on http://127.0.0.1:${String(settings.port)}`)
})

async function shutdown(): Promise<void> {
  demo.stop()
  server.close()
  await finance.stop()
  await auditor.stop()
  await suppliers.stop()
  await desk.close()
  await laser.close()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
