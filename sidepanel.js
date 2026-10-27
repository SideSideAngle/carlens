const DEFAULTS = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4o-mini"
};
const MAX_PHOTOS = 8;

const el = (id) => document.getElementById(id);
const statusEl = el("status");
let photos = [];

function setStatus(text) {
  statusEl.textContent = text;
}

function fillList(listEl, items, format) {
  listEl.innerHTML = "";
  for (const item of items || []) {
    const li = document.createElement("li");
    li.textContent = format ? format(item) : item;
    listEl.appendChild(li);
  }
  if (!listEl.children.length) {
    const li = document.createElement("li");
    li.textContent = "The AI returned nothing here — try a stronger model or more photos.";
    listEl.appendChild(li);
  }
}

function formatIssue(item) {
  if (typeof item === "string") return item;
  const parts = [item.issue || JSON.stringify(item)];
  if (item.typical_mileage) parts.push(`typically around ${item.typical_mileage}`);
  if (item.symptoms) parts.push(`signs: ${item.symptoms}`);
  if (item.severity) parts.push(`severity: ${item.severity}`);
  return parts.join(" — ");
}

function formatMaintenance(m) {
  if (typeof m === "string") return m;
  if (m && (m.interval || m.item)) {
    return `${m.interval || "as needed"}: ${m.item || ""} (${m.priority || "normal"})`;
  }
  return JSON.stringify(m);
}

function buildPrompt(f, photoCount) {
  const carLine = [f.year, f.make, f.model].filter(Boolean).join(" ") || "unknown (read from photos)";
  return [
    "You are an expert used-car inspector specializing in performance cars.",
    `You have ${photoCount} photo(s), all from ONE Facebook Marketplace listing, plus the seller's stated details below.`,
    `Listing URL: ${f.url || "unknown"}`,
    `Stated vehicle: ${carLine}`,
    `Stated mileage: ${f.mileage || "unknown"}`,
    `Stated price: ${f.price || "unknown"}`,
    "",
    "First identify the exact year, make, model, trim, and chassis/generation code",
    "(for example BMW F80). Tailor EVERY section to that exact generation, never generic advice.",
    "If the year is unclear, infer the most likely generation from the styling and state that assumption in notes.",
    "",
    "Rules:",
    "- known_issues: at least 6, specific to this generation. Each needs typical mileage window, symptoms, and severity. Never an empty list.",
    "- maintenance_schedule: at least 8 items covering engine oil, coolant, transmission fluid, differential fluid, brake fluid/pads/rotors, suspension, spark plugs/coils/filters, plus generation-specific services. For a performance car give the enthusiast oil interval (shorter than the manufacturer default), not just the dashboard number.",
    "- seller_questions: at least 6, with at least one per known issue asking for concrete proof (receipts, photos, cold-start video, pre-purchase inspection).",
    "- red_flags: check for undisclosed mods or tune, track use, accident or paint work, warning lights in cluster photos, mismatched tires, refusal of cold start or inspection, price far from market, title problems.",
    "",
    "Reply as strict JSON with exactly these keys:",
    '{"vehicle": {"year": "", "make": "", "model": "", "trim": "", "generation": "", "mileage": "", "price": "", "location": ""},',
    '"known_issues": [{"issue": "", "typical_mileage": "", "symptoms": "", "severity": ""}],',
    '"maintenance_schedule": [{"interval": "", "item": "", "priority": ""}],',
    '"seller_questions": ["..."],',
    '"red_flags": ["..."],',
    '"notes": "..."}',
    "No text outside the JSON."
  ].join("\n");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no-json");
  return JSON.parse(text.slice(start, end + 1));
}

function renderPhotos() {
  const strip = el("photos");
  strip.innerHTML = "";
  photos.forEach((src, i) => {
    const img = document.createElement("img");
    img.src = src;
    img.alt = `Listing photo ${i + 1} (click to remove)`;
    img.title = "Click to remove";
    img.addEventListener("click", () => {
      photos.splice(i, 1);
      renderPhotos();
    });
    strip.appendChild(img);
  });
  el("photoHint").textContent =
    photos.length === 0
      ? "No photos yet. Scroll through the listing and capture each angle plus the interior."
      : `${photos.length} photo(s) ready. Click one to remove it.`;
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(["endpoint", "model", "apiKey"]);
  el("endpoint").value = stored.endpoint || DEFAULTS.endpoint;
  el("model").value = stored.model || DEFAULTS.model;
  el("apiKey").value = stored.apiKey || "";
}

async function initUrl() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0] && tabs[0].url) el("listingUrl").value = tabs[0].url;
  } catch {
    el("listingUrl").value = "";
  }
}

el("saveSettings").addEventListener("click", async () => {
  await chrome.storage.local.set({
    endpoint: el("endpoint").value.trim() || DEFAULTS.endpoint,
    model: el("model").value.trim() || DEFAULTS.model,
    apiKey: el("apiKey").value.trim()
  });
  setStatus("Settings saved locally in the browser.");
});

el("addPhoto").addEventListener("click", async () => {
  if (photos.length >= MAX_PHOTOS) {
    setStatus(`Enough — ${MAX_PHOTOS} photos max per analysis.`);
    return;
  }
  setStatus("Capturing…");
  try {
    const windowId = chrome.windows ? (await chrome.windows.getCurrent()).id : undefined;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 });
    photos.push(dataUrl);
    renderPhotos();
    setStatus("Photo added. Scroll to the next angle and capture again.");
  } catch (err) {
    setStatus("Capture failed. Open a normal page and try again.");
  }
});

el("analyze").addEventListener("click", async () => {
  const endpoint = el("endpoint").value.trim() || DEFAULTS.endpoint;
  const model = el("model").value.trim() || DEFAULTS.model;
  const apiKey = el("apiKey").value.trim();
  if (!apiKey) {
    setStatus("Add your API key in AI settings first.");
    return;
  }
  if (photos.length === 0) {
    setStatus("Capture at least one photo first.");
    return;
  }
  setStatus(`Analyzing ${photos.length} photo(s)…`);
  el("analyze").disabled = true;
  try {
    const fields = {
      year: el("year").value.trim(),
      make: el("make").value.trim(),
      model: el("modelField").value.trim(),
      mileage: el("mileage").value.trim(),
      price: el("price").value.trim(),
      url: el("listingUrl").value.trim()
    };
    const content = [{ type: "text", text: buildPrompt(fields, photos.length) }];
    for (const url of photos.slice(0, MAX_PHOTOS)) {
      content.push({ type: "image_url", image_url: { url } });
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: 3000, messages: [{ role: "user", content }] })
    });
    if (!res.ok) throw new Error("api-" + res.status);
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content || ""
      : "";
    el("raw").textContent = text;

    let report;
    try {
      report = extractJson(text);
    } catch {
      setStatus("Got a reply but it was not valid JSON. See raw response below.");
      el("results").hidden = false;
      return;
    }
    const v = report.vehicle || {};
    el("vehicle").textContent =
      [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ") +
      (v.generation ? ` (${v.generation})` : "") +
      ` — mileage ${v.mileage || "unknown"}, price ${v.price || "unknown"}` +
      (v.location ? `, ${v.location}` : "");
    fillList(el("issues"), report.known_issues, formatIssue);
    fillList(el("maintenance"), report.maintenance_schedule, formatMaintenance);
    fillList(el("questions"), report.seller_questions);
    fillList(el("flags"), report.red_flags);
    el("results").hidden = false;
    setStatus("Done. Review the sections below.");
  } catch (err) {
    setStatus("Failed: " + (err && err.message ? err.message : "unknown error"));
  } finally {
    el("analyze").disabled = false;
  }
});

loadSettings();
initUrl();
renderPhotos();
