# CarLens

One-click used-car help for Facebook Marketplace. Open a listing, hit **Analyze this listing**, and get known issues, a maintenance schedule, seller questions, red flags, real NHTSA recall data, and a message draft — in a Chrome side panel.

<!-- TODO: replace with your demo video link -->
> 🎬 [**Demo video:** coming soon — 90 seconds, one listing, full report.](https://youtu.be/3O4ecIyk87s)

## The problem

Most used-car buyers aren't car people. A Marketplace listing shows a price and a few photos, but the expensive questions — *what breaks on this exact car, what's due at this mileage, what should I ask the seller* — take hours of forum-diving to answer. CarLens answers them in one click, where the buyer already is.

## What it does

- **One-click listing analysis** — reads the open tab (text first, screenshot fallback only when needed) and produces a full buyer's report.
- **Manual mode** — type any year / make / model for the same report, no listing required.
- **Real NHTSA data** — recalls and complaint patterns from a free public API, matched even when the listing includes the trim.
- **Seller message draft** — one-click copy into the Marketplace chat.
- **Saved cars + Markdown export** — bookmark listings, copy or download the full report to keep.
- **Car-only guard** — non-vehicle listings are detected and politely refused.

## Try it (2 minutes, bring your own key)

CarLens calls an AI model you choose — there is no bundled key, so the repo is safe to fork.

1. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked** → select the `carlens` folder.
2. Click the toolbar icon, open **AI settings**, paste an API key and save. Any OpenAI-compatible endpoint works — OpenAI, or a free-tier key from providers like Google AI Studio or OpenRouter.
3. Open a logged-in Marketplace car listing and click **Analyze this listing**.

The model call is the only cost (fractions of a cent on cheap models). NHTSA data is free and keyless.

## How it works

- **MV3 side panel** (`activeTab` + `scripting`): extraction runs in the tab you're already viewing, so there's no login wall and no server-side scraping.
- **Label-based DOM extraction** instead of brittle CSS selectors, with listing-ID parsing, "See more" expansion, and a confidence score that triggers the screenshot+vision fallback.
- **Bring-your-own-key** OpenAI-compatible call for the analysis; **NHTSA grounding** for recalls/complaints so the report isn't pure LLM memory.
- **Guardrails**: vehicle detection (local + LLM backstop), loading-aware retries, and one automatic retry on empty model replies.
- **Local-first**: key, settings, and saved cars live in `chrome.storage.local`. Nothing leaves the browser except the listing text (plus one fallback screenshot when needed) to your chosen endpoint.

## Project structure

- `manifest.json` — MV3, side panel, minimal permissions.
- `background.js` — opens the panel on toolbar click.
- `extractor.js` — in-tab listing extraction, vehicle detection, manual-input gate.
- `nhtsa.js` — recalls + complaints lookup with model-name fallback.
- `saved.js` — saved-cars storage.
- `report.js` — Markdown report builder for copy/download.
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — the panel UI and analysis flows.

## Troubleshooting

- **"Open a single listing first"** — one-click needs a listing page (`.../marketplace/item/...`), not search or browse.
- **"Didn't finish loading"** — wait a moment and press Analyze again (one automatic retry is built in).
- **Empty sections** — an occasional model flake; the panel retries once automatically.

## License

MIT — see [LICENSE](LICENSE).
