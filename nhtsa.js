/* NHTSA grounding: free public API, no key.
 * Endpoints verified against live api.nhtsa.gov:
 *   /recalls/recallsByVehicle?make=&model=&modelYear=
 *   /complaints/complaintsByVehicle?make=&model=&modelYear=
 * The model must match NHTSA naming near-exactly: "Camry" works, "Camry SE"
 * (with trim) and unknown names return HTTP 400. So we retry with shorter
 * model prefixes before giving up, and report no-match distinctly from
 * network failure so neither the UI nor the LLM mistakes it for clean.
 */

async function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error("nhtsa-" + res.status);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function cleanModel(model) {
  return String(model || "").replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

// Ordered guesses: full string, then shorter prefixes for trim suffixes.
// "Grand Cherokee Limited" -> full, "Grand Cherokee", "Grand".
function modelCandidates(model) {
  const clean = cleanModel(model);
  if (!clean) return [];
  const words = clean.split(" ");
  const out = [clean];
  if (words.length > 2) out.push(words.slice(0, 2).join(" "));
  if (words.length > 1) out.push(words[0]);
  return [...new Set(out)];
}

async function fetchNhtsaEndpoint(kind, year, make, model) {
  const cands = modelCandidates(model);
  for (const m of cands) {
    const q = `?make=${encodeURIComponent(make)}&model=${encodeURIComponent(m)}&modelYear=${encodeURIComponent(year)}`;
    const url = kind === "recalls"
      ? `https://api.nhtsa.gov/recalls/recallsByVehicle${q}`
      : `https://api.nhtsa.gov/complaints/complaintsByVehicle${q}`;
    try {
      const data = await fetchJsonWithTimeout(url, kind === "recalls" ? 10000 : 12000);
      return { data, matchedModel: m };
    } catch (e) {
      if (e && e.status === 400) continue; // name didn't match; try shorter
      return { error: String((e && e.message) || e) };
    }
  }
  return cands.length ? { notFound: true } : { error: "need year/make/model" };
}

function summarizeComplaints(json, cap) {
  const results = (json && json.results) || [];
  const total = (json && (json.count || json.Count)) || results.length;
  const counts = new Map();
  const samples = [];
  const limit = Math.min(results.length, cap || 200);
  for (let i = 0; i < limit; i += 1) {
    const r = results[i] || {};
    const comp = String(r.components || r.component || "Other").split(",")[0].trim() || "Other";
    counts.set(comp, (counts.get(comp) || 0) + 1);
    if (samples.length < 3 && r.summary) {
      samples.push(String(r.summary).slice(0, 280));
    }
  }
  const top = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([component, count]) => ({ component, count }));
  return { totalComplaints: total, topComponents: top, samples };
}

async function fetchNhtsa(year, make, model) {
  const y = String(year || "").trim();
  const mk = String(make || "").trim();
  const md = cleanModel(model);
  const out = {
    recalls: [], totalComplaints: 0, topComponents: [], samples: [],
    error: "", notFound: false, matchedModel: "",
    queried: { year: y, make: mk, model: md }
  };
  if (!y || !mk || !md) {
    out.error = "need year/make/model";
    return out;
  }
  const rec = await fetchNhtsaEndpoint("recalls", y, mk, md);
  let recNotFound = false;
  if (rec.data) {
    const results = (rec.data && rec.data.results) || [];
    out.matchedModel = rec.matchedModel || "";
    out.recalls = results.slice(0, 20).map((r) => ({
      component: r.Component || "",
      summary: r.Summary || "",
      consequence: r.Consequence || "",
      remedy: r.Remedy || "",
      campaign: r.NHTSACampaignNumber || "",
    }));
  } else if (rec.notFound) {
    recNotFound = true;
  } else {
    out.error = rec.error || "lookup failed";
  }
  const comp = await fetchNhtsaEndpoint("complaints", y, mk, out.matchedModel || md);
  let compNotFound = false;
  if (comp.data) {
    if (!out.matchedModel) out.matchedModel = comp.matchedModel || "";
    const s = summarizeComplaints(comp.data, 200);
    out.totalComplaints = s.totalComplaints;
    out.topComponents = s.topComponents;
    out.samples = s.samples;
  } else if (comp.notFound) {
    compNotFound = true;
  } else {
    const msg = comp.error || "lookup failed";
    out.error = out.error ? out.error + "; " + msg : msg;
  }
  out.notFound = recNotFound && compNotFound && !out.error;
  return out;
}

function formatNhtsaForPrompt(nhtsa) {
  if (!nhtsa) return "NHTSA data: unavailable.";
  if (nhtsa.error === "need year/make/model") {
    return "NHTSA data: unavailable (year, make, or model unknown).";
  }
  if (nhtsa.notFound) {
    const q = nhtsa.queried || {};
    const what = [q.year, q.make, q.model].filter(Boolean).join(" ");
    return `NHTSA data: no records matched${what ? " " + what : ""} — the model name may differ from NHTSA's naming. Do not assume zero recalls or complaints.`;
  }
  if (nhtsa.error && !(nhtsa.recalls || []).length && !nhtsa.totalComplaints) {
    return "NHTSA data: unavailable (lookup failed). Do not assume zero recalls or complaints.";
  }
  const lines = [];
  lines.push(`NHTSA recalls: ${(nhtsa.recalls || []).length} found.`);
  for (const r of (nhtsa.recalls || []).slice(0, 8)) {
    lines.push(`- Recall [${r.campaign || "?"}] ${r.component || ""}: ${(r.summary || "").slice(0, 300)}`);
  }
  lines.push(`NHTSA complaints: ${nhtsa.totalComplaints || 0} total.`);
  for (const c of (nhtsa.topComponents || []).slice(0, 8)) {
    lines.push(`- Complaints about ${c.component}: ${c.count} in sample`);
  }
  for (const s of (nhtsa.samples || []).slice(0, 2)) {
    lines.push(`- Sample complaint: ${s.slice(0, 280)}`);
  }
  return lines.join("\n");
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { fetchNhtsa, summarizeComplaints, formatNhtsaForPrompt, modelCandidates, cleanModel };
}
