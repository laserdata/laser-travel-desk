// Travel policy as an action governor on the booker's connection. Every trip
// the booker proposes is published to the proposals topic, and the governor
// decides before the record is written: allow it, block it, or step it up to
// a vote. A trip that needs approval becomes a durable intent that a manager and
// finance both vote on. The governor lets the proposal through only with a
// committed decision for that exact proposal.

import {
  ActionDecision,
  AgentId,
  Decision,
  Intent,
  Vote,
  decide,
  type ActionGovernor,
  type ConversationId,
  type GovernedAction,
  type VoteChoice
} from "@laserdata/laser-sdk"

import { policy, settings } from "./config.js"
import { parseJson } from "./util.js"

export const PROPOSALS = "proposals"
export const BOOKER = AgentId.new("booker")
export const MANAGER = AgentId.new("manager")
export const FINANCE = AgentId.new("finance")

export interface Proposal {
  readonly trip: string
  readonly traveller: string
  readonly from: string
  readonly city: string
  readonly depart: string
  readonly international: boolean
  readonly cabin: string
  readonly nights: number
  readonly flight: { readonly supplier: string; readonly name: string; readonly price: number }
  readonly hotel: { readonly supplier: string; readonly name: string; readonly room: string; readonly price: number; readonly nightly: number }
  readonly car?: { readonly supplier: string; readonly name: string; readonly price: number }
  readonly total: number
}

// What the booker publishes: the proposal, and once a vote has passed, the
// intent it was voted on.
export interface ProposalRecord {
  readonly proposal: Proposal
  readonly approvedIntent?: string
}

export function proposalBytes(proposal: Proposal): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(proposal))
}

export class Approvals {
  private readonly intents = new Map<string, Intent>()
  private readonly votes = new Map<string, Vote[]>()
  private readonly decisions = new Map<string, Decision>()

  open(conversation: ConversationId, proposal: Proposal): Intent {
    const intent = new Intent({
      conversation,
      proposer: BOOKER,
      body: proposalBytes(proposal),
      eligibleVoters: [MANAGER, FINANCE],
      mandatoryVoters: [MANAGER, FINANCE],
      policy: { kind: "all" },
      policyVersion: policy.version,
      deadlineMicros: BigInt(Date.now() + settings.voteWindowMs) * 1000n
    })
    intent.validate()
    this.intents.set(intent.intentId.toString(), intent)
    this.votes.set(intent.intentId.toString(), [])
    return intent
  }

  intent(id: string): Intent | undefined {
    return this.intents.get(id)
  }

  cast(id: string, voter: AgentId, choice: VoteChoice): { vote: Vote; decision?: Decision } {
    const intent = this.intents.get(id)
    if (intent === undefined) throw new Error(`no intent ${id}`)
    const vote = Vote.cast(intent, voter, choice)
    const ballots = this.votes.get(id) ?? []
    ballots.push(vote)
    this.votes.set(id, ballots)
    const decision = decide(intent, ballots, BigInt(Date.now()) * 1000n)
    if (decision !== undefined) this.decisions.set(id, decision)
    return decision === undefined ? { vote } : { vote, decision }
  }

  ballots(id: string): readonly Vote[] {
    return this.votes.get(id) ?? []
  }

  // True only when a committed decision authorises this intent and the intent
  // was raised for exactly these proposal bytes.
  authorizes(id: string, proposal: Proposal): boolean {
    const intent = this.intents.get(id)
    const decision = this.decisions.get(id)
    if (intent === undefined || decision === undefined) return false
    if (!decision.authorizes(intent)) return false
    const body = new TextDecoder().decode(intent.body)
    return body === JSON.stringify(proposal)
  }
}

export class TravelPolicy implements ActionGovernor {
  // The reason behind each trip's latest decision. The error a block raises
  // on the publish does not carry it.
  readonly reasons = new Map<string, string>()

  constructor(private readonly approvals: Approvals) {}

  async decide(action: GovernedAction): Promise<ActionDecision> {
    if (action.topic !== PROPOSALS) return ActionDecision.allow()
    const record = parseJson<ProposalRecord>(action.payload)
    const decision = this.rule(record)
    this.reasons.set(record.proposal.trip, decision.reason ?? "")
    return decision
  }

  private rule(record: ProposalRecord): ActionDecision {
    const p = record.proposal
    if (p.hotel.nightly > policy.hotelCap) {
      return ActionDecision.block(`the ${p.hotel.name} ${p.hotel.room} is $${String(p.hotel.nightly)} a night, over the $${String(policy.hotelCap)} cap`)
    }
    if (p.cabin === "business" && !p.international) {
      return ActionDecision.block("business class is for international flights only")
    }
    if (record.approvedIntent !== undefined) {
      return this.approvals.authorizes(record.approvedIntent, p)
        ? ActionDecision.allow().withReason("approved by manager and finance")
        : ActionDecision.block("the approval does not match this trip")
    }
    if (p.total > policy.approvalOver) {
      return ActionDecision.stepUp("trip-approval").withReason(
        `$${String(p.total)} is over the $${String(policy.approvalOver)} limit`
      )
    }
    return ActionDecision.allow().withReason("within policy")
  }
}
