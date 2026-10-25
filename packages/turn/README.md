# TURN material

Import only `@jokoagent/linkspan-turn/twilio` or `/coturn` on the server.
The root entry contains contracts and validation, no SDK or binary. Cloudflare
remains independently available through `@jokoagent/linkspan-cloudflare/turn`.

The host records an operation before issuance, supplies limited secret access,
rechecks media authority before delivering results, and closes media immediately
on local revocation. Twilio and coturn REST credentials have **TTL-only** retirement;
there is no per-username revocation API. The return value reports that limitation
and the precise expiry. It never claims to terminate an existing allocation.
Twilio requires explicit account opt-in; usage and budgets belong to that account.
coturn is an optional existing deployment, not a prerequisite for hosted TURN.

The adapters implement [Twilio Tokens](https://www.twilio.com/docs/stun-turn/api)
and [coturn's TURN REST credential mechanism](https://github.com/coturn/coturn/blob/master/README.turnserver).
They do not run a broker, store application users, or accept application Bearers.
Lost dispatched responses are outcome-unknown and are never automatically retried.
