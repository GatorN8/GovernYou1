# Congress Compass — v0.3

A responsive government transparency website, with an official federal data endpoint.

## Files
- `index.html`: website (v0.3)
- `api/federal.js`: independent House recorded-vote, Senate recorded-vote, GPO bill-document and optional Congress.gov bill-action importers
- `vercel.json`: one daily request to `/api/federal` (Hobby plan), plus server-side caching
- `tests/test-api.cjs`: parser validation tests (run with `node --test tests/test-api.cjs`)

## Setup
1. Link this repository to the existing Vercel `congress-compass` project (already configured).
2. Add the free Congress.gov key as a **Production** environment variable named `CONGRESS_API_KEY` in Vercel settings, never in this repository.
3. Redeploy the production site after changing environment variables.
4. Check `/api/federal` for `sources.house`, `sources.senate`, `sources.govinfo`, and `sources.bills` status. Check source timestamps and official URLs.

## Current limitations
- Federal data is checked when requested and cached for approximately three hours; a daily cron request may also occur. There is no persistent records database, so this is not continuous background polling.
- Some upstream data may be delayed, limited, or unavailable. Failures should be displayed, not represented as fresh records.
- Detailed Congress.gov bill records require the key. State and local feeds are not yet automatically imported.
- Existing `index 2.html` in GitHub is a separate older-version copy; Git history also preserves prior commits.
- Vercel's Hobby plan is intended for noncommercial use, subject to usage limits.
