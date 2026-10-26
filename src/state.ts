// What the browser shows: the desk's event feed and the faults it can switch on.

export type Tone = "info" | "good" | "warn" | "bad"

export interface DeskEvent {
  readonly at: number
  readonly who: string
  readonly text: string
  readonly tone: Tone
  readonly trip?: string
}

export class EventFeed {
  private readonly items: DeskEvent[] = []

  add(who: string, text: string, tone: Tone = "info", trip?: string): void {
    const event: DeskEvent = trip === undefined
      ? { at: Date.now(), who, text, tone }
      : { at: Date.now(), who, text, tone, trip }
    this.items.push(event)
    if (this.items.length > 200) this.items.shift()
    console.log(`[${who}] ${text}`)
  }

  recent(n = 60): readonly DeskEvent[] {
    return this.items.slice(-n).reverse()
  }
}

export interface Faults {
  // Metro Car Rentals takes longer to quote than the desk waits.
  slowCarQuote: boolean
  // Metro Car Rentals turns the next booking down, so the trip unwinds.
  carRejects: boolean
  // The next hotel booking stalls past its deadline, so the step is reassigned.
  stallClerk: boolean
}

export const faults: Faults = { slowCarQuote: false, carRejects: false, stallClerk: false }

export const feed = new EventFeed()
