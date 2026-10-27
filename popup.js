const captureBtn = document.getElementById("capture");
const copyBtn = document.getElementById("copyPrompt");
const downloadBtn = document.getElementById("download");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const listingUrlEl = document.getElementById("listingUrl");

let screenshotDataUrl = "";

function setStatus(text) {
  statusEl.textContent = text;
}

function currentFields() {
  const get = (id) => document.getElementById(id).value.trim();
  return {
    year: get("year"),
    make: get("make"),
    model: get("model"),
    mileage: get("mileage"),
    price: get("price"),
    notes: get("notes"),
    url: listingUrlEl.value.trim()
  };
}

function buildPrompt(f) {
  const carLine = [f.year, f.make, f.model].filter(Boolean).join(" ") || "[year make model from screenshot]";
  return [
    "Analyze the attached Facebook Marketplace used-car listing screenshot.",
    "",
    `Listing URL: ${f.url || "[paste URL]"}`,
    `Stated vehicle: ${carLine}`,
    `Mileage: ${f.mileage || "unknown"}`,
    `Price: ${f.price || "unknown"}`,
    `Seller notes: ${f.notes || "none provided"}`,
    "",
    "1. Extract make, model, year, trim if visible, mileage, price, and location.",
    "2. Correct the stated vehicle details if the screenshot shows something different.",
    "3. List known reliability issues and common failures for that exact year/make/model.",
    "4. Give a 12-month maintenance schedule with approximate priorities.",
    "5. List specific questions to ask the seller before visiting.",
    "6. Flag red flags visible in the listing or photos.",
    "",
    "Keep it practical for a private-party used-car buyer. Say what is uncertain."
  ].join("\n");
}

async function initUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && tabs[0].url) listingUrlEl.value = tabs[0].url;
  } catch {
    listingUrlEl.value = "";
  }
}

captureBtn.addEventListener("click", async () => {
  setStatus("Capturing…");
  try {
    const windowId = chrome.windows ? (await chrome.windows.getCurrent()).id : undefined;
    screenshotDataUrl = await chrome.tabs.captureVisibleTab(windowId, {
      format: "jpeg",
      quality: 85
    });
    previewEl.src = screenshotDataUrl;
    previewEl.hidden = false;
    downloadBtn.disabled = false;
    setStatus("Captured. Download it, then attach it with the prompt.");
  } catch (err) {
    setStatus("Capture failed. Open a normal page and try again.");
  }
});

copyBtn.addEventListener("click", async () => {
  const prompt = buildPrompt(currentFields());
  try {
    await navigator.clipboard.writeText(prompt);
    setStatus("Prompt copied. Paste it into an AI chat with the screenshot.");
  } catch {
    setStatus("Copy failed. Select and copy manually.");
  }
});

downloadBtn.addEventListener("click", async () => {
  if (!screenshotDataUrl) return;
  const a = document.createElement("a");
  a.href = screenshotDataUrl;
  a.download = "marketplace-car-listing.jpg";
  a.click();
  setStatus("Screenshot downloaded.");
});

initUrl();
