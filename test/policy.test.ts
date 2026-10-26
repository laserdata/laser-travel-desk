import assert from "node:assert/strict"
import { test } from "node:test"

import { ConversationId, VoteChoice, type GovernedAction } from "@laserdata/laser-sdk"

import { Approvals, FINANCE, MANAGER, PROPOSALS, TravelPolicy, type Proposal, type ProposalRecord } from "../src/policy.js"

const base: Proposal = {
  trip: "T001",
  traveller: "Priya Raman",
  from: "Melbourne",
  city: "Sydney",
  depart: "2026-11-17",
  international: false,
  cabin: "economy",
  nights: 3,
  flight: { supplier: "pacific-link", name: "Pacific Link", price: 214 },
  hotel: { supplier: "circular-quay-hotel", name: "Circular Quay Hotel", room: "standard queen", price: 690, nightly: 230 },
  total: 904
}

function action(record: ProposalRecord, topic = PROPOSALS): GovernedAction {
  return {
    kind: "publish",
    stream: "travel-desk",
    topic,
    payload: new TextEncoder().encode(JSON.stringify(record)),
    signed: false,
    counters: { sends: 0n, requests: 0n, bytesSent: 0n }
  }
}

async function verdict(policy: TravelPolicy, record: ProposalRecord, topic?: string): Promise<string> {
  return (await policy.decide(action(record, topic))).verdict.kind
}

test("a trip within policy is allowed", async () => {
  assert.equal(await verdict(new TravelPolicy(new Approvals()), { proposal: base }), "allow")
})

test("other topics are not governed", async () => {
  const over = { ...base, total: 9000 }
  assert.equal(await verdict(new TravelPolicy(new Approvals()), { proposal: over }, "ledger"), "allow")
})

test("business class on a domestic flight is blocked", async () => {
  const policy = new TravelPolicy(new Approvals())
  assert.equal(await verdict(policy, { proposal: { ...base, cabin: "business" } }), "block")
  assert.equal(policy.reasons.get("T001"), "business class is for international flights only")
})

test("a hotel over the nightly cap is blocked", async () => {
  const hotel = { ...base.hotel, name: "Darling Harbour Suites", room: "suite", nightly: 529 }
  const policy = new TravelPolicy(new Approvals())
  assert.equal(await verdict(policy, { proposal: { ...base, hotel } }), "block")
  assert.equal(policy.reasons.get("T001"), "the Darling Harbour Suites suite is $529 a night, over the $400 cap")
})

test("a trip over the limit is stepped up, and passes only with a committed vote", async () => {
  const approvals = new Approvals()
  const policy = new TravelPolicy(approvals)
  const over = { ...base, total: 1800 }
  assert.equal(await verdict(policy, { proposal: over }), "step_up")

  const intent = approvals.open(ConversationId.derive("trip/T001"), over)
  const id = intent.intentId.toString()
  approvals.cast(id, MANAGER, VoteChoice.Allow)
  assert.equal(await verdict(policy, { proposal: over, approvedIntent: id }), "block")

  const { decision } = approvals.cast(id, FINANCE, VoteChoice.Allow)
  assert.equal(decision?.outcome, "committed")
  assert.equal(await verdict(policy, { proposal: over, approvedIntent: id }), "allow")

  // The approval is for these exact bytes: a changed total does not pass.
  assert.equal(await verdict(policy, { proposal: { ...over, total: 1801 }, approvedIntent: id }), "block")
})

test("one block vote aborts the intent", () => {
  const approvals = new Approvals()
  const intent = approvals.open(ConversationId.derive("trip/T002"), { ...base, total: 2000 })
  const id = intent.intentId.toString()
  approvals.cast(id, MANAGER, VoteChoice.Allow)
  const { decision } = approvals.cast(id, FINANCE, VoteChoice.Block)
  assert.equal(decision?.outcome, "aborted")
})
