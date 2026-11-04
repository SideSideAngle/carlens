/* Marketplace DOM extractor.
 * extractListing() is injected into the Marketplace tab via
 * chrome.scripting.executeScript, so it must stay fully self-contained:
 * no references to anything defined outside itself.
 * parseListingId() and scoreExtraction() are pure helpers for the panel.
 */

function parseListingId(url) {
  if (!url) return null;
  const m = String(url).match(/\/marketplace\/item\/(\d+)/);
  if (m) return m[1];
  const m2 = String(url).match(/(\d{8,})/);
  return m2 ? m2[1] : null;
}

function scoreExtraction(l) {
  if (!l) return { score: 0, missing: ["listing"] };
  const checks = [
    ["year", !!(l.year && String(l.year).trim())],
    ["make", !!(l.make && String(l.make).trim())],
    ["model", !!(l.model && String(l.model).trim())],
    ["price", !!(l.price && String(l.price).trim())],
    ["mileage", !!(l.mileage && String(l.mileage).trim())],
    ["description", !!((l.description || "").trim() && String(l.description).trim().length > 40)],
  ];
  const weights = { year: 0.2, make: 0.15, model: 0.15, price: 0.15, mileage: 0.2, description: 0.15 };
  let score = 0;
  const missing = [];
  for (const [key, ok] of checks) {
    if (ok) score += weights[key] || 0;
    else missing.push(key);
  }
  return { score: Math.round(score * 100) / 100, missing };
}

async function extractListing() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const result = {
    url: "",
    id: null,
    title: "",
    price: "",
    mileage: "",
    transmission: "",
    fuelType: "",
    exteriorColor: "",
    interiorColor: "",
    bodyType: "",
    drivetrain: "",
    engine: "",
    vin: "",
    condition: "",
    year: "",
    make: "",
    model: "",
    trim: "",
    location: "",
    description: "",
    image: "",
    status: "",
    ogTitle: "",
    ogDescription: "",
    ogImage: "",
    specs: {},
  };
  try {
    result.url = location.href || "";
    const idMatch = result.url.match(/\/marketplace\/item\/(\d+)/);
    if (idMatch) {
      result.id = idMatch[1];
    } else {
      const idFallback = result.url.match(/(\d{8,})/);
      if (idFallback) result.id = idFallback[1];
    }

    const metaContent = (prop) => {
      try {
        const el = document.querySelector('meta[property="' + prop + '"]');
        return el ? el.getAttribute("content") || "" : "";
      } catch {
        return "";
      }
    };
    result.ogTitle = metaContent("og:title");
    result.ogDescription = metaContent("og:description");
    result.ogImage = metaContent("og:image");
    if (result.ogImage) result.image = result.ogImage;

    // Expand truncated description text ("See more") before reading it.
    try {
      const candidates = Array.from(document.querySelectorAll("div, span"));
      let clicked = 0;
      for (const el of candidates) {
        if (clicked >= 3) break;
        if (!el || !el.textContent) continue;
        // Only leaf-ish nodes to avoid clicking huge containers.
        if (el.children && el.children.length > 2) continue;
        const t = (el.textContent || "").trim().toLowerCase();
        if (t === "see more" || t === "see more…") {
          try {
            el.click();
            clicked += 1;
          } catch {
            // ignore one bad click target
          }
        }
      }
      if (clicked > 0) await sleep(600);
    } catch {
      // non-fatal
    }

    try {
      const h1 = document.querySelector("h1");
      const h1Text = h1 && h1.textContent ? h1.textContent.trim() : "";
      result.title =
        h1Text ||
        (result.ogTitle || "").trim() ||
        (document.title || "").replace(/\s*\|\s*Facebook.*$/, "").trim();
    } catch {
      result.title = (result.ogTitle || "").trim();
    }

    const priceRe = /\$\s?[\d,]+(?:\.\d{2})?/;
    try {
      const ogPrice = (result.ogDescription || "").match(priceRe);
      if (ogPrice) {
        result.price = ogPrice[0];
      } else if (document.body) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = null;
        let count = 0;
        while ((node = walker.nextNode()) && count < 6000) {
          count += 1;
          const t = (node.nodeValue || "").trim();
          if (!t || t.length > 30) continue;
          const pm = t.match(priceRe);
          if (pm) {
            result.price = pm[0];
            break;
          }
        }
      }
    } catch {
      // leave price empty
    }

    // Label-based specs. Facebook class names are obfuscated, so match the
    // visible English label text and read the sibling value.
    try {
      const LABEL_MAP = {
        mileage: "mileage",
        transmission: "transmission",
        "fuel type": "fuelType",
        "exterior color": "exteriorColor",
        "interior color": "interiorColor",
        "body type": "bodyType",
        drivetrain: "drivetrain",
        engine: "engine",
        vin: "vin",
        condition: "condition",
        year: "year",
        make: "make",
        model: "model",
        trim: "trim",
      };
      const els = Array.from(document.querySelectorAll("span, div"));
      const capped = els.length > 20000 ? els.slice(0, 20000) : els;
      const labels = Object.keys(LABEL_MAP);
      for (const label of labels) {
        const key = LABEL_MAP[label];
        if (result[key]) continue;
        for (const el of capped) {
          if (!el || !el.textContent) continue;
          // Leaf label nodes only: avoids matching containers with huge text.
          if (el.children && el.children.length > 1) continue;
          const t = (el.textContent || "").trim();
          if (!t || t.length > 40) continue;
          if (t.toLowerCase() !== label) continue;
          let value = "";
          try {
            if (el.nextElementSibling) {
              value = ((el.nextElementSibling.textContent || "").trim() || "").slice(0, 200);
            }
            const parent = el.parentElement;
            if (!value && parent && parent.nextElementSibling) {
              value = ((parent.nextElementSibling.textContent || "").trim() || "").slice(0, 200);
            }
            if (!value && parent) {
              const pt = (parent.textContent || "").trim();
              if (pt.toLowerCase().indexOf(label) === 0 && pt.length > label.length) {
                value = pt
                  .slice(label.length)
                  .trim()
                  .replace(/^[:\-\s]+/, "")
                  .slice(0, 200);
              }
            }
          } catch {
            value = "";
          }
          if (value && value.length < 200 && value.toLowerCase() !== label) {
            result[key] = value;
            result.specs[key] = value;
            break;
          }
        }
      }
    } catch {
      // specs are best-effort
    }

    try {
      const blocks = Array.from(document.querySelectorAll("span, div"))
        .map((e) => (e.textContent || "").trim())
        .filter((t) => t.length > 150 && t.length < 8000);
      blocks.sort((a, b) => b.length - a.length);
      const bodyLen = document.body && document.body.textContent ? document.body.textContent.length : 0;
      for (const b of blocks.slice(0, 6)) {
        if (!bodyLen || b.length < bodyLen * 0.8) {
          result.description = b.slice(0, 8000);
          break;
        }
      }
      if (!result.description && result.ogDescription) {
        result.description = result.ogDescription.slice(0, 8000);
      }
    } catch {
      if (!result.description && result.ogDescription) {
        result.description = result.ogDescription.slice(0, 8000);
      }
    }

    try {
      const tm = (result.title || "").match(/^\s*(\d{4})\s+([A-Za-z]+)\s+([A-Za-z0-9][A-Za-z0-9\- ]{0,40})/);
      if (tm) {
        if (!result.year) result.year = tm[1];
        if (!result.make) result.make = tm[2];
        if (!result.model) {
          result.model = tm[3].trim().split(/\s{2,}|\s-\s/)[0].trim();
        }
      }
    } catch {
      // ignore title parse errors
    }

    try {
      const badges = Array.from(document.querySelectorAll("span, div"))
        .map((e) => (e.textContent || "").trim())
        .filter((t) => t && t.length < 20)
        .slice(0, 5000)
        .map((t) => t.toLowerCase());
      if (badges.indexOf("sold") !== -1) result.status = "Sold";
      else if (badges.indexOf("pending") !== -1) result.status = "Pending";
      else if (badges.indexOf("available") !== -1) result.status = "Available";
    } catch {
      // status is best-effort
    }

    if (!result.image) {
      try {
        const imgs = Array.from(document.images || []).filter((im) => im.naturalWidth > 200);
        imgs.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
        if (imgs[0] && imgs[0].src) result.image = imgs[0].src;
      } catch {
        // ignore
      }
    }
  } catch (e) {
    result.error = String((e && e.message) || e);
  }
  return result;
}

const CAR_MAKES = [
  "Acura", "Alfa", "Alfa Romeo", "Aprilia", "Aston Martin", "Audi", "Bentley",
  "BMW", "Bugatti", "Buick", "Cadillac", "Chevrolet", "Chevy", "Chrysler",
  "Dodge", "Ducati", "Ferrari", "Fiat", "Ford", "Genesis", "GMC",
  "Harley-Davidson", "Honda", "Hyundai", "Infiniti", "Jaguar", "Jeep",
  "Kawasaki", "Kia", "Koenigsegg", "KTM", "Lamborghini", "Land Rover", "Rover",
  "Lexus", "Lincoln", "Lotus", "Lucid", "Maserati", "Maybach", "Mazda",
  "McLaren", "Mercedes", "Mercedes-Benz", "Mini", "Mitsubishi", "Nissan",
  "Polestar", "Porsche", "Ram", "Rivian", "Rolls-Royce", "Subaru", "Suzuki",
  "Tesla", "Toyota", "Triumph", "Volkswagen", "Volvo", "Yamaha"
];

function normalizeMake(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const KNOWN_MAKE_SET = new Set(CAR_MAKES.map(normalizeMake));

function isKnownCarMake(make) {
  const n = normalizeMake(make);
  return !!n && KNOWN_MAKE_SET.has(n);
}

const VEHICLE_WORDS = [
  "mileage", "odometer", "transmission", "carfax", "autocheck", "mpg",
  "horsepower", "cylinder", "drivetrain", "tire", "engine", "clutch",
  "catalytic", "smog", "vin"
];
const VEHICLE_PHRASES = [
  "clean title", "salvage title", "rebuilt title", "title in hand",
  "test drive", "pre-purchase", "all wheel"
];

function countVehicleKeywords(text) {
  const t = String(text || "").toLowerCase();
  let n = 0;
  for (const w of VEHICLE_WORDS) {
    if (new RegExp("\\b" + w + "s?\\b").test(t)) n += 1;
  }
  for (const p of VEHICLE_PHRASES) {
    if (t.indexOf(p) !== -1) n += 1;
  }
  return n;
}

function titleHasCarMake(title) {
  const words = String(title || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    if (KNOWN_MAKE_SET.has(words[i])) return true;
    if (i + 1 < words.length && KNOWN_MAKE_SET.has(words[i] + words[i + 1])) return true;
  }
  return false;
}

// Local vehicle check over extracted text. High score means clearly a motor
// vehicle; low score with thin text means "can't tell" (let the LLM decide).
function detectVehicle(src) {
  src = src || {};
  const has = (v) => !!(v && String(v).trim());
  let score = 0;
  const signals = [];
  const fieldWeights = [
    ["mileage", 0.35], ["transmission", 0.25], ["fuelType", 0.2],
    ["vin", 0.3], ["engine", 0.15], ["drivetrain", 0.1], ["bodyType", 0.1]
  ];
  for (const [key, w] of fieldWeights) {
    if (has(src[key])) {
      score += w;
      signals.push(key);
    }
  }
  const yearNum = parseInt(src.year, 10);
  if (yearNum >= 1980 && yearNum <= 2035) {
    score += 0.15;
    signals.push("year");
  }
  if (isKnownCarMake(src.make)) {
    score += 0.25;
    signals.push("make");
  } else if (titleHasCarMake(src.title)) {
    score += 0.2;
    signals.push("title-make");
  }
  const kwHits = countVehicleKeywords((src.title || "") + " " + (src.description || ""));
  if (kwHits > 0) {
    score += Math.min(kwHits * 0.06, 0.24);
    signals.push("keywords:" + kwHits);
  }
  score = Math.round(Math.min(score, 1) * 100) / 100;
  return { score, signals, isVehicle: score >= 0.4 };
}

// Generic SPA titles mean the listing hasn't rendered yet (or the tab isn't
// a listing at all): "Search results", "Marketplace", "Facebook", or empty.
function isGenericTitle(title) {
  const t = String(title || "").trim().toLowerCase();
  if (!t) return true;
  if (t === "facebook" || t === "marketplace") return true;
  return t.indexOf("search results") !== -1;
}

// Gate for manually typed details: known make, a mileage, or clearly
// vehicle-flavored notes. Anything else is blocked before any API call.
function manualLooksLikeCar(f) {
  f = f || {};
  if (isKnownCarMake(f.make)) return { ok: true, reason: "make" };
  if (f.mileage && String(f.mileage).trim()) return { ok: true, reason: "mileage" };
  if (countVehicleKeywords(f.description) >= 2) return { ok: true, reason: "keywords" };
  return { ok: false, reason: "unknown-make" };
}

// Export for Node probes; harmless in the extension.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseListingId, scoreExtraction, extractListing,
    detectVehicle, manualLooksLikeCar, isKnownCarMake, countVehicleKeywords,
    isGenericTitle
  };
}
