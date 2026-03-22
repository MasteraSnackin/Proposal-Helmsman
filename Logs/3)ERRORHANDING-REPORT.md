# Error Handling Report

## Goal

Apply the guidance from [3)ERRORHANDING.md](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/Logs/3%29ERRORHANDING.md) to Proposal Helmsman by tightening failure classification, preserving debugging context, and making the API/UI contract more resilient.

## Problems Found

- Unknown API routes were being reported as `405 Method not allowed` instead of `404 Not found`.
- Several dev-server and static-asset error paths bypassed the shared `ApplicationError` contract and returned ad hoc JSON bodies without stable `code` metadata.
- The UI request layer dropped useful structured error details such as `method`, `allowedMethods`, `path`, `service`, and response snippets.
- Successful non-JSON responses could slip through the web client as a raw object instead of failing fast as an invalid response contract.

## Fixes Applied

- Added `MethodNotAllowedError` in [openclaw/runtime/errors.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/runtime/errors.ts) for consistent `405` payloads.
- Updated [backend/proposal-api.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/backend/proposal-api.ts) to:
  - classify unknown API paths as `404 NOT_FOUND`
  - classify wrong methods on known routes as `405 METHOD_NOT_ALLOWED`
  - include structured `details` such as `path`, `method`, and `allowedMethods`
- Updated [openclaw/runtime/dev-server.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/runtime/dev-server.ts) so static `403/404` and non-GET static requests also return the shared structured error payload format.
- Updated [web/app.js](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/web/app.js) to:
  - treat successful non-JSON responses as `INVALID_RESPONSE`
  - preserve backend `details` and raw response snippets on `RequestError`
  - include structured debugging context in normalized UI log messages without making notices noisier for end users

## Validation

- `npm test`: passed (`23/23`)
- `npm run typecheck`: passed
- Added regression coverage in:
  - [openclaw/tests/dev-server.test.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/tests/dev-server.test.ts)
  - [openclaw/tests/web-app.test.ts](/Users/darkcomet/Documents/Hackathon/Proposal%20Helmsman/openclaw/tests/web-app.test.ts)

## Outcome

The project now fails faster on bad response contracts, preserves more useful context for debugging, and returns more accurate, stable error classifications across the API, dev server, and web client.
