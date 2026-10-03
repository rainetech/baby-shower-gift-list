import { gifts } from "./gifts-full.js";
import { alternativePrices, priceCheckDate } from "./alternative-prices.js";

const POLL_INTERVAL_MS = 15000;

const PRICE_BANDS = [
  { id: "all", label: "All prices", test: () => true },
  { id: "under-50", label: "Under AED 50", test: (value) => value !== null && value < 50 },
  { id: "50-100", label: "AED 50–100", test: (value) => value !== null && value >= 50 && value < 100 },
  { id: "100-plus", label: "AED 100+", test: (value) => value !== null && value >= 100 }
];

const gate = document.querySelector("#gate");
const registry = document.querySelector("#registry");
const accessForm = document.querySelector("#access-form");
const accessCode = document.querySelector("#access-code");
const accessMessage = document.querySelector("#access-message");
const giftGrid = document.querySelector("#gift-grid");
const giftSummary = document.querySelector("#gift-summary");
const giftTemplate = document.querySelector("#gift-template");
const offerTemplate = document.querySelector("#offer-template");
const priceFilter = document.querySelector("#price-filter");
const sortSelect = document.querySelector("#sort-select");
const reserveDialog = document.querySelector("#reserve-dialog");
const reserveForm = document.querySelector("#reserve-form");
const dialogGiftName = document.querySelector("#dialog-gift-name");
const guestName = document.querySelector("#guest-name");
const reserveMessage = document.querySelector("#reserve-message");
const dialogClose = document.querySelector(".dialog-close");

let activeGift = null;
let reservations = new Map();
let pollTimer = null;
let activeBand = "all";
let activeSort = "default";

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json" }
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.dataset.originalText ||= button.textContent;
  button.textContent = busy ? "Please wait…" : button.dataset.originalText;
}

function priceValue(label) {
  const match = label.match(/[\d,.]+/);
  return match ? Number(match[0].replaceAll(",", "")) : null;
}

function comparisonLabel(amazonPrice, alternativePrice) {
  if (amazonPrice === null) return "Alternative price";
  const difference = Math.abs(amazonPrice - alternativePrice);
  if (difference < 0.01) return "Same listed price";
  return alternativePrice < amazonPrice
    ? `Save AED ${difference.toFixed(2)} here`
    : `Amazon is AED ${difference.toFixed(2)} less`;
}

const entries = gifts.map((gift, index) => ({ gift, index, amazonPrice: priceValue(gift.price) }));

function visibleEntries() {
  const band = PRICE_BANDS.find((candidate) => candidate.id === activeBand);
  const matching = entries.filter((entry) => band.test(entry.amazonPrice));
  if (activeSort === "default") return matching;

  const direction = activeSort === "price-asc" ? 1 : -1;
  return [...matching].sort((a, b) => {
    if (a.amazonPrice === null || b.amazonPrice === null) {
      return (a.amazonPrice === null) - (b.amazonPrice === null) || a.index - b.index;
    }
    return (a.amazonPrice - b.amazonPrice) * direction || a.index - b.index;
  });
}

function renderPriceFilter() {
  priceFilter.replaceChildren();
  PRICE_BANDS.forEach((band) => {
    const count = entries.filter((entry) => band.test(entry.amazonPrice)).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "filter-chip";
    button.dataset.band = band.id;
    button.setAttribute("aria-pressed", String(band.id === activeBand));
    button.append(band.label);
    const badge = document.createElement("span");
    badge.textContent = count;
    button.append(badge);
    button.addEventListener("click", () => {
      activeBand = band.id;
      priceFilter.querySelectorAll(".filter-chip").forEach((chip) => {
        chip.setAttribute("aria-pressed", String(chip.dataset.band === activeBand));
      });
      renderGifts();
    });
    priceFilter.append(button);
  });
}

function renderOffers(fragment, gift, amazonPrice) {
  const offers = [...(alternativePrices[gift.id] ?? [])].sort((a, b) => a.value - b.value);
  if (!offers.length) return;

  // Offers without `checked` were verified on priceCheckDate. Older snapshots carry their own date
  // and are not used for the saving label unless they are all we have.
  const isCurrent = (offer) => !offer.checked || offer.checked === priceCheckDate;
  const basis = (offers.find(isCurrent) ?? offers[0]);
  const checkedOn = isCurrent(basis) ? priceCheckDate : basis.checked;

  const comparison = fragment.querySelector(".price-comparison");
  const list = fragment.querySelector(".offer-list");
  comparison.hidden = false;
  fragment.querySelector(".comparison-title").textContent = offers.length > 1 ? "Exact UAE matches" : "Exact UAE match";
  fragment.querySelector(".saving-label").textContent = comparisonLabel(amazonPrice, basis.value);
  fragment.querySelector(".price-checked").textContent = `Prices checked ${checkedOn}`;
  if (amazonPrice !== null && basis.value < amazonPrice) comparison.classList.add("is-cheaper");

  offers.forEach((offer) => {
    const item = offerTemplate.content.cloneNode(true);
    const link = item.querySelector(".alternative-link");
    const age = isCurrent(offer) ? "" : ` (price from ${offer.checked})`;
    link.href = offer.url;
    link.setAttribute("aria-label", `View ${gift.name} at ${offer.retailer} for ${offer.price}${age}`);
    item.querySelector(".retailer-label").textContent = offer.retailer;
    if (!isCurrent(offer)) {
      const date = item.querySelector(".offer-date");
      date.hidden = false;
      date.textContent = `as of ${offer.checked.replace(/ \d{4}$/, "")}`;
    }
    item.querySelector(".alternative-price").textContent = offer.price;
    list.append(item);
  });
}

function renderGifts() {
  giftGrid.replaceChildren();
  const visible = visibleEntries();

  visible.forEach(({ gift, amazonPrice }) => {
    const fragment = giftTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".gift-card");
    const image = fragment.querySelector("img");
    const reservation = reservations.get(gift.id);

    card.dataset.giftId = gift.id;
    image.src = gift.image;
    image.alt = gift.name;
    fragment.querySelector(".price").textContent = gift.price === "See Amazon"
      ? gift.price
      : `Amazon · ${gift.price}`;
    const giftHeading = fragment.querySelector("h3");
    giftHeading.textContent = gift.name;
    giftHeading.title = gift.name;
    fragment.querySelector(".description").textContent = gift.description || "";

    renderOffers(fragment, gift, amazonPrice);

    const amazonLink = fragment.querySelector(".amazon-link");
    amazonLink.href = gift.amazonUrl;
    amazonLink.setAttribute("aria-label", `View ${gift.name} on Amazon`);

    const reserveButton = fragment.querySelector(".reserve-button");
    const reservedBanner = fragment.querySelector(".reserved-banner");
    const statusPill = fragment.querySelector(".status-pill");

    if (reservation) {
      card.classList.add("is-reserved");
      statusPill.textContent = "Reserved";
      reserveButton.remove();
      reservedBanner.hidden = false;
      reservedBanner.querySelector("strong").textContent = reservation.name;
    } else {
      reserveButton.addEventListener("click", () => openReservation(gift));
    }

    giftGrid.append(fragment);
  });

  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "gift-empty";
    empty.textContent = "No gift ideas in this price range.";
    giftGrid.append(empty);
  }

  const availableInView = visible.filter(({ gift }) => !reservations.has(gift.id)).length;
  giftSummary.textContent = activeBand === "all"
    ? `${availableInView} of ${gifts.length} gift ideas available`
    : `Showing ${visible.length} of ${gifts.length} · ${availableInView} available`;
}

function openReservation(gift) {
  activeGift = gift;
  reserveForm.reset();
  reserveMessage.textContent = "";
  dialogGiftName.textContent = gift.name;
  reserveDialog.showModal();
  setTimeout(() => guestName.focus(), 50);
}

function showGate(message = "") {
  stopPolling();
  registry.hidden = true;
  gate.hidden = false;
  accessMessage.textContent = message;
  if (reserveDialog.open) reserveDialog.close();
}

function showRegistry() {
  gate.hidden = true;
  registry.hidden = false;
  renderGifts();
  startPolling();
}

// Returns false when the guest is not signed in (or the registry cannot be reached).
async function refreshReservations() {
  const { ok, status, data } = await api("/api/reservations");
  if (status === 401) return false;
  if (!ok) throw new Error(`Reservations request failed (${status})`);
  reservations = new Map(data.reservations.map((entry) => [entry.itemId, entry]));
  renderGifts();
  return true;
}

async function poll() {
  if (document.hidden) return;
  try {
    if (!(await refreshReservations())) showGate("Please enter the invitation code again.");
  } catch {
    giftSummary.textContent = "Reservations are temporarily unavailable. Please refresh.";
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accessMessage.textContent = "";
  setBusy(accessForm, true);

  try {
    const { ok, status } = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ code: accessCode.value.trim() })
    });
    if (ok) {
      accessForm.reset();
      if (await refreshReservations()) showRegistry();
      else accessMessage.textContent = "Something went wrong. Please try again.";
    } else if (status === 429) {
      accessMessage.textContent = "Too many attempts. Please wait a few minutes and try again.";
    } else if (status === 401) {
      accessMessage.textContent = "That invitation code isn't quite right. Please try again.";
      accessCode.select();
    } else {
      accessMessage.textContent = "The registry is being prepared. Please try again shortly.";
    }
  } catch {
    accessMessage.textContent = "We couldn't reach the registry. Please check your connection and try again.";
  } finally {
    setBusy(accessForm, false);
  }
});

reserveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeGift) return;

  const name = guestName.value.trim().replace(/\s+/g, " ");
  if (!name) {
    reserveMessage.textContent = "Please enter your name.";
    return;
  }

  reserveMessage.textContent = "";
  setBusy(reserveForm, true);

  try {
    const { ok, status, data } = await api("/api/reservations", {
      method: "POST",
      body: JSON.stringify({ itemId: activeGift.id, name })
    });

    if (ok) {
      reservations.set(data.reservation.itemId, data.reservation);
      renderGifts();
      reserveDialog.close();
    } else if (status === 409) {
      reserveMessage.textContent = "This gift has just been reserved by another guest. Please choose another one.";
      await refreshReservations().catch(() => {});
    } else if (status === 401) {
      showGate("Please enter the invitation code again.");
    } else if (data.error === "invalid_name") {
      reserveMessage.textContent = "Please enter a name of up to 50 characters.";
    } else {
      reserveMessage.textContent = "We couldn't save your reservation. Please try again.";
    }
  } catch {
    reserveMessage.textContent = "We couldn't reach the registry. Please check your connection and try again.";
  } finally {
    setBusy(reserveForm, false);
  }
});

sortSelect.addEventListener("change", () => {
  activeSort = sortSelect.value;
  renderGifts();
});

dialogClose.addEventListener("click", () => reserveDialog.close());
reserveDialog.addEventListener("click", (event) => {
  if (event.target === reserveDialog) reserveDialog.close();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !registry.hidden) poll();
});

renderPriceFilter();

// A guest who already entered the code has a session cookie, so skip the gate for them.
refreshReservations()
  .then((signedIn) => {
    if (signedIn) showRegistry();
    else gate.hidden = false;
  })
  .catch(() => {
    gate.hidden = false;
    accessMessage.textContent = "The registry is being prepared. Please try again shortly.";
  });
