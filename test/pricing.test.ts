import assert from "node:assert/strict"
import { test } from "node:test"

import { AIRLINES, cityNamed, type City } from "../src/config.js"
import { addDays, easter, flightPrice, isoDate, leadTime, parseDate, roomPrice, season, stayNights } from "../src/pricing.js"

function city(name: string): City {
  const c = cityNamed(name)
  assert.ok(c)
  return c
}

const airline = AIRLINES[0]
assert.ok(airline)
const melbourne = city("Melbourne")
const sydney = city("Sydney")
const booked = parseDate("2026-03-02")

test("Easter falls on the right Sunday", () => {
  assert.equal(isoDate(easter(2026)), "2026-04-05")
  assert.equal(isoDate(easter(2027)), "2027-03-28")
})

test("booking far ahead is cheaper than booking close in", () => {
  const depart = parseDate("2026-08-25")
  const far = flightPrice(airline, melbourne, sydney, "economy", depart, addDays(depart, -150), 0, 1)
  const near = flightPrice(airline, melbourne, sydney, "economy", depart, addDays(depart, -5), 0, 1)
  assert.ok(far.price < near.price)
  assert.deepEqual(near.reasons.filter((r) => r.endsWith("days out")), ["5 days out"])
  assert.ok(far.reasons.some((r) => r.includes("months ahead")))
})

test("lead time leaves prices alone between one and two months out", () => {
  assert.equal(leadTime("flight", 45).factor, 1)
  assert.equal(leadTime("flight", 45).reason, undefined)
})

test("peak seasons cost more than a quiet week", () => {
  const quiet = season(parseDate("2026-05-12"), sydney)
  assert.equal(quiet.factor, 1)
  assert.equal(season(parseDate("2026-12-22"), sydney).reason, "Christmas and January peak")
  assert.equal(season(parseDate("2026-04-06"), sydney).reason, "Easter")
  assert.equal(season(parseDate("2026-07-07"), sydney).reason, "July school holidays")
  assert.ok(season(parseDate("2027-01-10"), city("Auckland")).factor > season(parseDate("2027-01-10"), sydney).factor)
})

test("a Friday flight costs more than a Wednesday one", () => {
  const friday = flightPrice(airline, melbourne, sydney, "economy", parseDate("2026-05-15"), booked, 0, 1)
  const wednesday = flightPrice(airline, melbourne, sydney, "economy", parseDate("2026-05-13"), booked, 0, 1)
  assert.ok(friday.price > wednesday.price)
  assert.ok(friday.reasons.includes("Friday flight"))
})

test("city hotels are dearer on weeknights than at the weekend", () => {
  assert.equal(stayNights(parseDate("2026-05-11"), 3).reason, "weeknight rates")
  assert.equal(stayNights(parseDate("2026-05-15"), 2).reason, "weekend rates")
})

test("seats sold and rooms filling push the price up", () => {
  const depart = parseDate("2026-05-12")
  const empty = flightPrice(airline, melbourne, sydney, "economy", depart, booked, 0, 1)
  const busy = flightPrice(airline, melbourne, sydney, "economy", depart, booked, 3, 1)
  assert.ok(busy.price > empty.price)
  const plenty = roomPrice(200, sydney, depart, 2, booked, 4, 4, 1)
  const last = roomPrice(200, sydney, depart, 2, booked, 1, 4, 1)
  assert.ok(last.nightly > plenty.nightly)
  assert.ok(last.reasons.includes("only 1 left"))
})

test("a Sydney suite is over the nightly cap even booked far ahead at the weekend", () => {
  const room = roomPrice(460, sydney, parseDate("2026-08-21"), 2, addDays(parseDate("2026-08-21"), -150), 4, 4, 0.96)
  assert.ok(room.nightly > 400)
})
