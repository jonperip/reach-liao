# Reach Liao

Live Singapore bus arrivals, nearby stops, bus service routes and journey planning in one page.

**Open the app:** https://jonperip.github.io/reach-liao/

- Live arrival times with crowding, deck type and wheelchair access
- Saved stops with nicknames and per-stop bus filters (sync between devices with a code)
- Nearby stops on a OneMap map
- Search by bus number, stop code, stop name or place
- Bus service routes with first and last bus times
- Journey planner: Bus + MRT via OneMap (free OneMap API account), or bus-only estimates without one
- NUS Internal Shuttle Bus stops and routes (A1, A2, D1, D2, K, P, R1, R2) with usual hours, plus live shuttle times through the relay below

Data: live arrivals from LTA DataMall via [arrivelah](https://github.com/cheeaun/arrivelah); stops, services and timetables from [BusRouter SG](https://busrouter.sg); maps, place search and journeys from [OneMap](https://www.onemap.gov.sg) © Singapore Land Authority.

## NUS shuttle relay

NUS only lets its own app read live shuttle times, so Reach Liao reads them through a small relay: [`worker/nus-relay.js`](worker/nus-relay.js). It opens the same public guest session the uNivUS web app uses (no NUSNET login or API key) and answers `GET /?stop=CLB` with that stop's shuttle times, cached for 15 seconds. Only `https://jonperip.github.io` may read its answers.

Set it up on Cloudflare Workers (free plan):

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) (create a free account if needed).
2. Go to **Workers & Pages** → **Create** → **Create Worker** (start from "Hello World"). Name it `reach-liao-nus` and click **Deploy**.
3. Click **Edit code**, replace everything with the contents of `worker/nus-relay.js`, and click **Deploy**.
4. Copy the worker's address, e.g. `https://reach-liao-nus.yourname.workers.dev`. Opening `…/?stop=CLB` should show `"ok":true`.
5. In Reach Liao, open **More** → **NUS shuttle live times**, paste the address and tap **Save & test**.
