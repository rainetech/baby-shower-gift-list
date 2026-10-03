import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { collection, doc, getFirestore, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig, registryUserEmail } from "./firebase-config.js";
import { amazonPricesCheckedOn, gifts } from "./gifts-full.js";

const REGISTRY_ID = "rochelle-and-christopher";

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
const priceFilter = document.querySelector("#price-filter");
const sortSelect = document.querySelector("#sort-select");
const reserveDialog = document.querySelector("#reserve-dialog");
const reserveForm = document.querySelector("#reserve-form");
const dialogGiftName = document.querySelector("#dialog-gift-name");
const guestName = document.querySelector("#guest-name");
const reserveMessage = document.querySelector("#reserve-message");
const dialogClose = document.querySelector(".dialog-close");
const priceFootnote = document.querySelector("#price-footnote");

let activeGift = null;
let reservations = new Map();
let stopListening = null;
let activeBand = "all";
let activeSort = "default";

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);

function derivePassword(code) {
  return `registry-${code}-access`;
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

function renderGifts() {
  giftGrid.replaceChildren();
  const visible = visibleEntries();

  visible.forEach(({ gift }) => {
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

function startReservationListener() {
  stopListening?.();
  const reservationsRef = collection(db, "registries", REGISTRY_ID, "reservations");
  stopListening = onSnapshot(reservationsRef, (snapshot) => {
    reservations = new Map(snapshot.docs.map((entry) => [entry.id, entry.data()]));
    renderGifts();
  }, () => {
    giftSummary.textContent = "Reservations are temporarily unavailable. Please refresh.";
  });
}

accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  accessMessage.textContent = "";
  setBusy(accessForm, true);

  try {
    await signInWithEmailAndPassword(auth, registryUserEmail, derivePassword(accessCode.value.trim()));
    accessForm.reset();
  } catch (error) {
    if (error?.code === "auth/too-many-requests") {
      accessMessage.textContent = "Too many attempts. Please wait a few minutes and try again.";
    } else if (error?.code === "auth/network-request-failed") {
      accessMessage.textContent = "We couldn't reach the registry. Please check your connection and try again.";
    } else {
      accessMessage.textContent = "That invitation code isn't quite right. Please try again.";
      accessCode.select();
    }
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
    const reservationRef = doc(db, "registries", REGISTRY_ID, "reservations", activeGift.id);
    await setDoc(reservationRef, {
      itemId: activeGift.id,
      name,
      reservedAt: serverTimestamp()
    });
    reserveDialog.close();
  } catch {
    reserveMessage.textContent = "This gift may have just been reserved by another guest. Please choose another one.";
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

priceFootnote.textContent = `Amazon prices checked ${amazonPricesCheckedOn}. Prices are snapshots and may change. Delivery charges are not included.`;
renderPriceFilter();

onAuthStateChanged(auth, (user) => {
  if (user) {
    gate.hidden = true;
    registry.hidden = false;
    renderGifts();
    startReservationListener();
  } else {
    gate.hidden = false;
    registry.hidden = true;
    stopListening?.();
    if (reserveDialog.open) reserveDialog.close();
  }
});

window.addEventListener("pagehide", () => stopListening?.());
