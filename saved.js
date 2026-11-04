/* Saved listings keyed by stable Marketplace ID. */

const SAVED_KEY = "savedListings";

async function getSavedListings() {
  const stored = await chrome.storage.local.get([SAVED_KEY]);
  return stored[SAVED_KEY] || {};
}

async function saveListing(entry) {
  if (!entry || !entry.id) throw new Error("need-id");
  const all = await getSavedListings();
  all[entry.id] = {
    id: entry.id,
    url: entry.url || "",
    title: entry.title || "",
    price: entry.price || "",
    thumbnail: entry.thumbnail || "",
    year: entry.year || "",
    make: entry.make || "",
    model: entry.model || "",
    mileage: entry.mileage || "",
    status: entry.status || "",
    updatedAt: new Date().toISOString(),
    lastChecked: entry.lastChecked || "",
    lastPrice: entry.lastPrice || entry.price || "",
    lastStatus: entry.lastStatus || entry.status || "",
  };
  await chrome.storage.local.set({ [SAVED_KEY]: all });
  return all[entry.id];
}

async function removeSavedListing(id) {
  const all = await getSavedListings();
  delete all[id];
  await chrome.storage.local.set({ [SAVED_KEY]: all });
}

async function updateSavedListing(id, patch) {
  const all = await getSavedListings();
  if (!all[id]) return null;
  all[id] = { ...all[id], ...(patch || {}), updatedAt: new Date().toISOString() };
  await chrome.storage.local.set({ [SAVED_KEY]: all });
  return all[id];
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SAVED_KEY, getSavedListings, saveListing, removeSavedListing, updateSavedListing };
}
