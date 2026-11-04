const DEFAULTS = {
  endpoint: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4o-mini"
};
const MAX_PHOTOS = 8;
const CONFIDENCE_THRESHOLD = 0.6;

const el = (id) => document.getElementById(id);
const statusEl = el("status");
const extractStatusEl = el("extractStatus");
let photos = [];
let lastExtraction = null;
let lastNhtsa = null;
let lastReport = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function setExtractStatus(text) {
  if (extractStatusEl) extractStatusEl.textContent = text;
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
    li.textContent = "The AI returned nothing here — try a stronger model or type in more details below.";
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

const REPORT_KEYS = '{"vehicle": {"year": "", "make": "", "model": "", "trim": "", "generation": "", "mileage": "", "price": "", "location": ""}, "known_issues": [{"issue": "", "typical_mileage": "", "symptoms": "", "severity": ""}], "maintenance_schedule": [{"interval": "", "item": "", "priority": ""}], "seller_questions": ["..."], "red_flags": ["..."], "seller_message_draft": "...", "notes": "..."}';

function buildTextPrompt(f, listing, nhtsaBlock) {
  const carLine = [f.year, f.make, f.model].filter(Boolean).join(" ") || "unknown (read from listing text)";
  const specLines = [];
  if (listing) {
    if (listing.transmission) specLines.push(`Transmission: ${listing.transmission}`);
    if (listing.fuelType) specLines.push(`Fuel type: ${listing.fuelType}`);
    if (listing.exteriorColor) specLines.push(`Exterior color: ${listing.exteriorColor}`);
    if (listing.interiorColor) specLines.push(`Interior color: ${listing.interiorColor}`);
    if (listing.bodyType) specLines.push(`Body type: ${listing.bodyType}`);
    if (listing.drivetrain) specLines.push(`Drivetrain: ${listing.drivetrain}`);
    if (listing.engine) specLines.push(`Engine: ${listing.engine}`);
    if (listing.vin) specLines.push(`VIN: ${listing.vin}`);
    if (listing.condition) specLines.push(`Condition: ${listing.condition}`);
    if (listing.status) specLines.push(`Listing status: ${listing.status}`);
  }
  return [
    "You are an expert used-car inspector specializing in performance cars.",
    "You have extracted text from ONE Facebook Marketplace listing.",
    `Listing URL: ${f.url || "unknown"}`,
    `Title: ${(listing && listing.title) || "unknown"}`,
    `Stated vehicle: ${carLine}`,
    `Stated mileage: ${f.mileage || "unknown"}`,
    `Stated price: ${f.price || "unknown"}`,
    specLines.length ? "Extracted specs:\n" + specLines.join("\n") : "Extracted specs: none",
    "",
    "Seller description (treat specs here as authoritative):",
    "---",
    f.description || "(none extracted)",
    "---",
    "",
    nhtsaBlock || "NHTSA data: unavailable.",
    "",
    "First: if this is NOT a motor vehicle (car, truck, SUV, van, or motorcycle),",
    "reply with exactly this JSON and nothing else:",
    '{"not_vehicle": true, "detected": "<short label, e.g. camera lens>"}',
    "",
    "Otherwise, identify the exact year, make, model, trim, and chassis/generation code",
    "(for example BMW F80). Tailor EVERY section to that exact generation, never generic advice.",
    "Use the NHTSA recalls and complaint patterns to sharpen known_issues and red_flags, but still add generation-specific enthusiast issues the NHTSA data misses.",
    "",
    "Rules:",
    "- known_issues: at least 6, specific to this generation. Each needs typical mileage window, symptoms, and severity. Never an empty list.",
    "- maintenance_schedule: at least 8 items covering engine oil, coolant, transmission fluid, differential fluid, brake fluid/pads/rotors, suspension, spark plugs/coils/filters, plus generation-specific services. At higher mileage, call out what is coming due next.",
    "- seller_questions: at least 6, with at least one per known issue asking for concrete proof (receipts, photos, cold-start video, pre-purchase inspection).",
    "- red_flags: check for undisclosed mods or tune, track use, accident or paint work, price far from market, title problems, and any NHTSA recall that needs proof of repair.",
    "- seller_message_draft: a short polite message to the seller asking the 3 most important questions plus a cold-start video and pre-purchase inspection. Keep it under 600 characters.",
    "",
    "Otherwise, reply as strict JSON with exactly these keys:",
    REPORT_KEYS,
    "No text outside the JSON."
  ].join("\n");
}

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("no-json");
  return JSON.parse(text.slice(start, end + 1));
}

function handleNotVehicle(report, setFn) {
  if (report && report.not_vehicle === true) {
    const what = report.detected ? String(report.detected).trim() : "";
    setFn(`Not analyzing — this looks like ${what || "a non-vehicle item"}. CarLens only covers cars for now.`);
    el("results").hidden = true;
    return true;
  }
  return false;
}

function reportIsEmpty(report) {
  if (!report) return true;
  return ["known_issues", "maintenance_schedule", "seller_questions", "red_flags"]
    .every((k) => !report[k] || report[k].length === 0);
}

// One LLM call, plus a single retry when the model returns valid JSON with
// every section empty (an occasional flake — a second call resolves it).
async function fetchReport(endpoint, model, apiKey, messages) {
  let text = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    text = await callLLM(endpoint, model, apiKey, messages, 3000);
    let report = null;
    try {
      report = extractJson(text);
    } catch {
      return { report: null, text };
    }
    if (report.not_vehicle === true) return { report, text };
    if (!reportIsEmpty(report) || attempt === 1) return { report, text };
    setStatus("Got an empty report — retrying once…");
  }
  return { report: null, text };
}

async function callLLM(endpoint, model, apiKey, messages, maxTokens) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey
    },
    body: JSON.stringify({ model, temperature: 0.2, max_tokens: maxTokens || 3000, messages })
  });
  if (!res.ok) throw new Error("api-" + res.status);
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content || ""
    : "";
  return text;
}

function renderReport(report, text) {
  el("raw").textContent = text;
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
  if (el("sellerDraft")) {
    el("sellerDraft").value = report.seller_message_draft || "";
  }
  el("results").hidden = false;
}

function renderNhtsa(nhtsa) {
  const summaryEl = el("nhtsaSummary");
  const recallsEl = el("nhtsaRecalls");
  const complaintsEl = el("nhtsaComplaints");
  if (!summaryEl || !recallsEl || !complaintsEl) return;
  if (!nhtsa || nhtsa.error === "need year/make/model") {
    summaryEl.textContent = "Add year / make / model to load NHTSA data.";
    recallsEl.innerHTML = "";
    complaintsEl.innerHTML = "";
    return;
  }
  if (nhtsa.notFound) {
    const q = nhtsa.queried || {};
    const what = [q.year, q.make, q.model].filter(Boolean).join(" ");
    summaryEl.textContent = `No NHTSA records matched${what ? " " + what : ""} — the model name may differ from NHTSA's.`;
    recallsEl.innerHTML = "";
    complaintsEl.innerHTML = "";
    return;
  }
  if (nhtsa.error && (!nhtsa.recalls || !nhtsa.recalls.length) && !nhtsa.totalComplaints) {
    summaryEl.textContent = "NHTSA lookup failed: " + nhtsa.error;
    recallsEl.innerHTML = "";
    complaintsEl.innerHTML = "";
    return;
  }
  let summary = `${(nhtsa.recalls || []).length} recall(s), ${nhtsa.totalComplaints || 0} complaint(s) on file.`;
  const asked = nhtsa.queried ? nhtsa.queried.model || "" : "";
  if (nhtsa.matchedModel && asked && nhtsa.matchedModel.toLowerCase() !== asked.toLowerCase()) {
    summary += ` Matched NHTSA model \u201C${nhtsa.matchedModel}\u201D.`;
  }
  summaryEl.textContent = summary;
  recallsEl.innerHTML = "";
  for (const r of (nhtsa.recalls || []).slice(0, 8)) {
    const li = document.createElement("li");
    li.textContent = `${r.campaign || "?"} — ${r.component || ""}: ${(r.summary || "").slice(0, 220)}`;
    recallsEl.appendChild(li);
  }
  if (!recallsEl.children.length) {
    const li = document.createElement("li");
    li.textContent = "No recalls on file for this year / make / model.";
    recallsEl.appendChild(li);
  }
  complaintsEl.innerHTML = "";
  for (const c of (nhtsa.topComponents || []).slice(0, 8)) {
    const li = document.createElement("li");
    li.textContent = `${c.component}: ${c.count} in sample`;
    complaintsEl.appendChild(li);
  }
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

async function getActiveMarketplaceTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.url || tab.url.indexOf("facebook.com") === -1) {
    throw new Error("not-marketplace");
  }
  return tab;
}

async function runExtraction(tabId) {
  if (!chrome.scripting || !chrome.scripting.executeScript) {
    throw new Error("no-scripting");
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractListing
  });
  const listing = results && results[0] ? results[0].result : null;
  if (!listing) throw new Error("no-result");
  return listing;
}

function fillFieldsFromListing(listing) {
  if (!listing) return;
  // Reset first: stale values from a previous listing must not inflate
  // confidence or leak into the analysis of the current tab.
  el("listingUrl").value = listing.url || "";
  el("year").value = "";
  el("make").value = "";
  el("modelField").value = "";
  el("mileage").value = "";
  el("price").value = "";
  el("desc").value = "";
  if (listing.year) el("year").value = listing.year;
  if (listing.make) el("make").value = listing.make;
  if (listing.model) el("modelField").value = listing.model;
  if (listing.mileage) el("mileage").value = listing.mileage;
  if (listing.price) el("price").value = listing.price;
  if (listing.description) el("desc").value = listing.description;
}

function currentFields() {
  return {
    year: el("year").value.trim(),
    make: el("make").value.trim(),
    model: el("modelField").value.trim(),
    mileage: el("mileage").value.trim(),
    price: el("price").value.trim(),
    description: el("desc").value.trim(),
    url: el("listingUrl").value.trim()
  };
}

async function ensureOnePhoto() {
  if (photos.length > 0) return true;
  try {
    const windowId = chrome.windows ? (await chrome.windows.getCurrent()).id : undefined;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 });
    photos.push(dataUrl);
    return true;
  } catch {
    return false;
  }
}

async function renderSaved() {
  const listEl = el("savedList");
  if (!listEl) return;
  let all = {};
  try {
    all = await getSavedListings();
  } catch {
    all = {};
  }
  listEl.innerHTML = "";
  const entries = Object.values(all).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  if (!entries.length) {
    listEl.textContent = "Nothing saved yet.";
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "saved-row";
    const info = document.createElement("span");
    info.className = "saved-info";
    info.textContent = `${e.title || e.id} — ${e.price || "?"}${e.status ? " (" + e.status + ")" : ""}`;
    info.title = e.url || "";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", async () => {
      if (e.url) await chrome.tabs.create({ url: e.url });
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Remove";
    delBtn.addEventListener("click", async () => {
      await removeSavedListing(e.id);
      await renderSaved();
    });
    row.appendChild(info);
    row.appendChild(openBtn);
    row.appendChild(delBtn);
    listEl.appendChild(row);
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

el("analyzeListing").addEventListener("click", async () => {
  const endpoint = el("endpoint").value.trim() || DEFAULTS.endpoint;
  const model = el("model").value.trim() || DEFAULTS.model;
  const apiKey = el("apiKey").value.trim();
  if (!apiKey) {
    setExtractStatus("Add your API key in AI settings first.");
    return;
  }
  setExtractStatus("Reading listing from the open tab…");
  setStatus("");
  el("analyzeListing").disabled = true;
  photos = [];
  try {
    const tab = await getActiveMarketplaceTab();
    if (!parseListingId(tab.url || "")) {
      setExtractStatus("Open a single listing first — this page looks like search or browse, not a car ad.");
      return;
    }
    let listing = null;
    try {
      listing = await runExtraction(tab.id);
      if (listing && isGenericTitle(listing.title)) {
        // SPA still rendering the listing; wait a beat and grab it once more.
        setExtractStatus("Listing is still loading — retrying…");
        await new Promise((r) => setTimeout(r, 2000));
        try {
          listing = await runExtraction(tab.id);
        } catch {
          // keep the first result
        }
      }
    } catch (err) {
      const msg = err && err.message ? err.message : "extract-failed";
      if (msg === "no-scripting") {
        setExtractStatus("This browser is too old for one-click. Type the details below instead.");
      } else {
        setExtractStatus("Could not read the page (" + msg + "). Type the details below instead.");
      }
      return;
    }
    lastExtraction = listing;
    fillFieldsFromListing(listing);
    const fields = currentFields();
    const detection = detectVehicle({
      title: listing.title || "",
      description: fields.description || "",
      year: fields.year || "",
      make: fields.make || "",
      mileage: fields.mileage || "",
      transmission: listing.transmission || "",
      fuelType: listing.fuelType || "",
      vin: listing.vin || "",
      engine: listing.engine || "",
      drivetrain: listing.drivetrain || "",
      bodyType: listing.bodyType || ""
    });
    if (!detection.isVehicle && (fields.description || "").trim().length > 200) {
      if (isGenericTitle(listing.title)) {
        setExtractStatus("The listing didn't finish loading — wait a moment and press Analyze again.");
      } else {
        const name = (listing.title || "").trim().slice(0, 60);
        setExtractStatus(
          (name ? `\u201C${name}\u201D doesn't` : "This doesn't") +
          " look like a vehicle listing — CarLens only covers cars for now."
        );
      }
      el("results").hidden = true;
      return;
    }
    const scored = scoreExtraction({ ...fields, description: fields.description });
    setExtractStatus(
      scored.score >= CONFIDENCE_THRESHOLD
        ? `Got page text (confidence ${scored.score}). Running text analysis…`
        : `Page text is thin (confidence ${scored.score}, missing ${scored.missing.join(", ") || "fields"}). Using photo fallback…`
    );

    lastNhtsa = await fetchNhtsa(fields.year, fields.make, fields.model);
    renderNhtsa(lastNhtsa);
    const nhtsaBlock = formatNhtsaForPrompt(lastNhtsa);

    let messages;
    if (scored.score >= CONFIDENCE_THRESHOLD) {
      messages = [{ role: "user", content: buildTextPrompt(fields, listing, nhtsaBlock) }];
    } else {
      await ensureOnePhoto();
      const photoNote = photos.length
        ? "\n\nOne screenshot is attached as fallback; reconcile it with the text above."
        : "\n\nNo screenshot was available; analyze from the text only.";
      const content = [{ type: "text", text: buildTextPrompt(fields, listing, nhtsaBlock) + photoNote }];
      for (const url of photos.slice(0, MAX_PHOTOS)) {
        content.push({ type: "image_url", image_url: { url } });
      }
      messages = [{ role: "user", content }];
    }

    const { report, text } = await fetchReport(endpoint, model, apiKey, messages);
    el("raw").textContent = text;
    if (!report) {
      setStatus("Got a reply but it was not valid JSON. See raw response below.");
      el("results").hidden = false;
      return;
    }
    if (handleNotVehicle(report, setExtractStatus)) return;
    lastReport = report;
    renderReport(report, text);
    setStatus("Done. Review the sections below.");
    setExtractStatus(`Listing ${listing.id || ""} ${listing.status ? "(" + listing.status + ")" : ""} — confidence ${scored.score}.`);
  } catch (err) {
    if (err && err.message === "not-marketplace") {
      setExtractStatus("Open a Facebook Marketplace listing in the active tab first.");
    } else {
      setExtractStatus("Failed: " + (err && err.message ? err.message : "unknown error"));
    }
  } finally {
    el("analyzeListing").disabled = false;
  }
});

el("quickAnalyze").addEventListener("click", async () => {
  const endpoint = el("endpoint").value.trim() || DEFAULTS.endpoint;
  const model = el("model").value.trim() || DEFAULTS.model;
  const apiKey = el("apiKey").value.trim();
  if (!apiKey) {
    setStatus("Add your API key in AI settings first.");
    return;
  }
  const fields = currentFields();
  if (!fields.make || !fields.model) {
    setStatus("Type at least the make and model to analyze.");
    return;
  }
  if (!manualLooksLikeCar(fields).ok) {
    setStatus("That make doesn't match a known car brand — CarLens only covers cars for now. Check the spelling and try again.");
    return;
  }
  setStatus("Analyzing these details…");
  el("quickAnalyze").disabled = true;
  el("listingUrl").value = "";
  try {
    lastExtraction = null;
    lastNhtsa = await fetchNhtsa(fields.year, fields.make, fields.model);
    renderNhtsa(lastNhtsa);
    const nhtsaBlock = formatNhtsaForPrompt(lastNhtsa);
    const { report, text } = await fetchReport(endpoint, model, apiKey, [{ role: "user", content: buildTextPrompt(fields, null, nhtsaBlock) }]);
    el("raw").textContent = text;
    if (!report) {
      setStatus("Got a reply but it was not valid JSON. See raw response below.");
      el("results").hidden = false;
      return;
    }
    if (handleNotVehicle(report, setStatus)) return;
    lastReport = report;
    renderReport(report, text);
    setStatus("Done. Review the sections below.");
  } catch (err) {
    setStatus("Failed: " + (err && err.message ? err.message : "unknown error"));
  } finally {
    el("quickAnalyze").disabled = false;
  }
});

el("saveCurrent").addEventListener("click", async () => {
  try {
    const fields = currentFields();
    const id = (lastExtraction && lastExtraction.id) || parseListingId(fields.url);
    if (!id) {
      setExtractStatus("Run Analyze listing first so I have a listing ID to save.");
      return;
    }
    await saveListing({
      id,
      url: fields.url || (lastExtraction && lastExtraction.url) || "",
      title: (lastExtraction && lastExtraction.title) || [fields.year, fields.make, fields.model].filter(Boolean).join(" ") || id,
      price: fields.price || "",
      thumbnail: (lastExtraction && lastExtraction.image) || "",
      year: fields.year || "",
      make: fields.make || "",
      model: fields.model || "",
      mileage: fields.mileage || "",
      status: (lastExtraction && lastExtraction.status) || ""
    });
    setExtractStatus("Saved listing " + id + ".");
    await renderSaved();
  } catch (err) {
    setExtractStatus("Save failed: " + (err && err.message ? err.message : "unknown error"));
  }
});

function currentReportMarkdown() {
  if (!lastReport) return "";
  return buildReportMarkdown({
    report: lastReport,
    nhtsa: lastNhtsa,
    listing: lastExtraction,
    fields: currentFields(),
    generatedAt: new Date().toLocaleString()
  });
}

el("copyReport").addEventListener("click", async () => {
  const md = currentReportMarkdown();
  if (!md) {
    setStatus("No report yet — run an analysis first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(md);
    setStatus("Report copied as Markdown.");
  } catch {
    setStatus("Copy failed. Select and copy manually.");
  }
});

el("downloadReport").addEventListener("click", () => {
  const md = currentReportMarkdown();
  if (!md) {
    setStatus("No report yet — run an analysis first.");
    return;
  }
  try {
    const v = (lastReport && lastReport.vehicle) || {};
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = reportFilename(v);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus("Report downloaded.");
  } catch {
    setStatus("Download failed in this browser. Use Copy report instead.");
  }
});

if (el("copyDraft")) {
  el("copyDraft").addEventListener("click", async () => {
    const text = el("sellerDraft").value || "";
    if (!text) {
      setStatus("No draft yet — run an analysis first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus("Message copied. Paste it into the Marketplace chat.");
    } catch {
      setStatus("Copy failed. Select the draft and copy manually.");
    }
  });
}

loadSettings();
initUrl();
renderSaved();
