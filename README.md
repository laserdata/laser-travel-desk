# Travel desk on Laser SDK

A corporate travel desk run by agents on one log. Someone asks for a trip from an Australian city to another city on a given date. The desk asks every airline and every hotel in the destination for a price at once and shows whoever answers in time. The traveller picks a flight and a room, and a policy governor checks the trip before it is written. Trips over the limit need approval: a manager and finance must both agree. The desk then books the flight, the hotel and the car as a saga. If a later booking fails, the earlier ones are cancelled.

Nothing has a fixed price. Each supplier prices each quote from the date: booking months ahead is cheapest and prices climb as departure gets close, peak seasons (Christmas and January, Easter, school holidays, each international city's high season) cost more, Friday and Sunday flights cost more, city hotels are dearer on weeknights, and prices rise as seats sell and rooms fill. Each quote says why its price moved.

Built on Laser SDK 0.8.2 for TypeScript, running on Laser Stack locally or LaserData Cloud. The airlines, hotels and car hire firm are made up.

## What it shows

| Laser SDK | In the demo |
|---|---|
| Sessions | Each trip is a session (`laser.sessions().start()`), opened when the request comes in. The request is the session's first state, and the desk records the quotes, the pick, the governor's verdict, the vote and the outcome on it (`session.state().set(...)`). The booking saga runs under the session's id, so the flight, hotel and car steps and their cancellations are child sessions of the trip. A blocked or declined trip ends its session there; a trip that reaches the saga ends with it. The trip card shows the session id |
| Scatter | One quote request goes to every agent that serves `quote-flight`, and one to every agent that serves the destination's hotel skill, such as `quote-hotel/sydney` (`laser.scatter(...)`). The desk names a skill, never a supplier. Thrift Air is the cheapest airline but takes 1.5 to 4 seconds to answer, so it misses the 2.5 second deadline more often than not and the trip goes ahead without its fare |
| Contracts with deadlines | Metro Car Rentals quotes on its own contract (`laser.contract(...).deadline(...)`). **Slow car hire quote** makes it miss: the contract comes back `timedOut` and the trip goes ahead without a car |
| Action governor | The booker's connection carries a governor (`Laser.builder().governor(policy, "enforce")`). Every proposal it publishes is checked before it reaches the log: allowed, blocked (a room over $400 a night, business class on a domestic flight), or needing approval (a trip over $1,500, which the SDK calls a step-up). A block or a step-up comes back as `PolicyBlockedError` or `StepUpRequiredError`, and nothing is written |
| Durable intent | A trip that needs approval becomes an `Intent` with the manager and finance as mandatory voters. Each `Vote.cast` goes on the votes topic, and `decide(...)` returns a committed or aborted `Decision`. The governor then lets the proposal through only if `decision.authorizes(intent)` holds and the intent was raised for exactly that proposal. Change the total by a dollar and it is blocked |
| Saga workflow | `laser.workflow("trip")`: flight, then hotel, then car, each a step routed to the chosen supplier. Each step has a verifier and a compensation (`verifyWith`, `compensateWith`). **Car hire turns down the next booking** fails the car step, and the engine runs the compensations newest first: the hotel releases the room, then the airline cancels the ticket |
| Fenced leases | The hotel step is exclusive (`exclusiveIn("fence")`, `onTimeout("reassign")`). The engine takes a lease and stamps its fence token on the request, and the hotel takes a room with `kv("rooms").casFenced(...)`. **Stall the next hotel clerk** holds the booking past the 30 second step deadline. The engine reassigns the step under a new lease, the retry takes the room with fence 2, and the stalled clerk's late write with fence 1 is refused. One room is taken, not two |
| Consumer filters | Every finished trip goes on the ledger topic. Finance reads it through a consumer group that owns a JSON filter: trips over $1,500, or declined, or cancelled because a later booking failed. The server picks those records out; the rest never reach finance. The panel shows how many payload bytes stayed on the server |
| Governance RBAC | The auditor signs in as its own Iggy user, bound to a `travel-auditor` role that may read the bookings namespace and nothing else (`defineRole`, `bindRoles`, `whoami`). **Read the ledger** works. **Change a booking** is refused by the plane |
| KV | Rooms left per hotel and room type, which the hotels price from, and every booking by reference, which the auditor reads |
| Agent registry | Each supplier advertises the skills it serves on its capability card |

## Run it

You need Node 22.14 or later and Docker.

**1. Start Laser Stack**, from this directory:

```
docker compose up -d
```

**2. Install and start the desk:**

```
npm install
npm start
```

Open http://127.0.0.1:8010.

The desk deletes and recreates its stream (`travel-desk`) at startup. To point it somewhere else, copy `.env.example` to `.env` and edit it.

## Try it

- **Get quotes** with the defaults: Melbourne to Sydney, three weeks out, three nights, economy. The flights and rooms fill in with the reasons each price moved. Thrift Air sometimes makes the panel with the cheapest fare and sometimes misses the deadline; get quotes a few times to see both. The cheapest flight and room are picked; press **Book this trip**, the governor allows it and the three steps go green.
- Get quotes for the same trip departing next week, then three months out: the next-week fares are higher and say how many days out they are, the three-month ones say they were booked ahead.
- Pick a departure around Christmas, Easter or the July school holidays and compare it with a quiet week.
- **Business class from Melbourne to Sydney**: the governor blocks it before anything is written.
- Pick the **suite** at Darling Harbour Suites in Sydney: the page marks it over the cap, and the governor blocks it.
- **Business class to Singapore**: over $1,500, so the card waits for approval. Approve as both manager and finance and it books. Decline as either and it is aborted.
- Book the same flight a few times: each booking sells a seat, and the next quote for that flight goes up and says so.
- Turn on **Car hire turns down the next booking**, then book a trip: the flight and hotel go green, the car fails, and the hotel and flight are struck through as their cancellations run.
- Turn on **Stall the next hotel clerk**, then book a trip: watch the log for about 35 seconds.
- **Random trip** picks a trip and books the cheapest options straight away.
- Use the **Auditor** buttons after a few bookings.

`npm test` runs the policy, vote and pricing tests, which need no server.

## Demo loop

For a booth or a screen that runs unattended:

```
DESK_DEMO=1 npm start
```

It runs every scenario in turn, forever, with the trips that book mixed in among the ones that are blocked, need approval or are cancelled: a trip three weeks out, business class on a domestic flight, the same trip next week, a suite over the cap, the same trip booked three months ahead outside any peak season, business class to Singapore, car hire turning a booking down, a Christmas trip and a stalled hotel clerk. Each card shows its quotes and picks for a few seconds before it books. Votes decide themselves after a few seconds: the manager approves, and finance approves on odd rounds and declines on even ones. Each trip is followed by a pause, rooms and seats sold are reset at the start of every round, and the auditor runs at the end of it. The **Demo loop** button in the header starts and stops it on a running server; getting quotes, picking a trip or voting yourself stops it.

`DESK_DEMO_PAUSE` (default 8) is the seconds between trips, `DESK_DEMO_PICK_DELAY` (default 4) how long a card shows its picks before booking, and `DESK_DEMO_APPROVE_DELAY` (default 4) the seconds before a vote decides.

## Layout

```
src/server.ts     HTTP server and startup
src/desk.ts       quotes, proposals, votes, the booking saga, the ledger
src/policy.ts     the travel policy governor and the intents and votes
src/suppliers.ts  the airline, hotel and car hire agents
src/pricing.ts    how a supplier prices a quote from the date and demand
src/demo.ts       the demo loop: every scenario in turn, unattended
src/finance.ts    the filtered finance reader
src/audit.ts      the auditor's role, Iggy user and connection
src/config.ts     settings, cities, suppliers and base prices
static/           the page
test/             policy, vote and pricing tests
```

## Known limits

- The suppliers run in the desk's process, each on its own connection: three airlines, three hotels in each of the seven cities and the car hire firm. Crash and resume is shown by the support desk and delivery desk demos, not here.
- Seats sold per flight are kept in the airline agents' memory, so a restart resets them. Rooms left are in KV.
- Each agent handles one request at a time. While a clerk is stalled, that hotel misses quotes for other trips too.
- The desk keeps open intents and their votes in memory. Votes and decisions are on the votes topic, but a restart loses a vote in progress.
- `PolicyBlockedError` does not carry the governor's reason, so the governor records its reason per trip and the desk reads it from there.
- Apache Iggy checks its own permissions before the plane sees a managed command, and a KV write counts as a send. The auditor's Iggy user gets read and send on the stream, so the `travel-auditor` role alone decides what it may do.
- No OpenTelemetry traces yet.
