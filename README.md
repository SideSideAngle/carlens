# Marketplace Car Helper (Chrome extension, unpacked)

One click in the side panel: captures the visible Marketplace tab, sends it to a vision API with your locally stored key, and shows the report.

## What you get

- Extracted year, make, model, trim, mileage, price, location
- Known issues for that exact car
- Maintenance schedule with priorities
- Questions to ask the seller
- Red flags

## Load it

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select the `marketplace-car-extension` folder.
4. Click the toolbar icon to open the side panel.

## First run

1. Open a Facebook Marketplace car listing.
2. In the side panel, open **AI settings**, paste your API key (default endpoint is OpenAI-compatible chat completions), save.
3. Optionally fill year / make / model / mileage / price.
4. Click **Capture photo** on each angle: scroll through the listing photos and interior, capturing up to 8. Click a thumbnail to remove it.
5. Click **Analyze photos**.

Model tip: the default `gpt-4o-mini` is cheap but gives thinner car knowledge. If answers feel generic, switch the model to `gpt-4o` (costs more per analysis).

## Privacy

- The API key is stored only in `chrome.storage.local` in your browser.
- The screenshot plus listing context is sent to whichever endpoint you configure. Each call may cost a small amount per your provider.

## Files

- `manifest.json` — MV3, side panel, `activeTab` + `tabs` + `storage` + `sidePanel`, plus `<all_urls>` (Chrome only allows tab screenshots with `<all_urls>` or a fresh toolbar-click grant, and the panel outlives that grant).
- `background.js` — opens the panel on toolbar click.
- `sidepanel.html` / `sidepanel.css` / `sidepanel.js` — capture with `chrome.tabs.captureVisibleTab`, OpenAI-compatible vision call, rendered report.
- `popup.*` — leftover from the manual-paste prototype, no longer referenced.
