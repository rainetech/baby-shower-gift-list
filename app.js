import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { collection, doc, getFirestore, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig, registryUserEmail } from "./firebase-config.js";
import { gifts } from "./gifts-full.js";

const REGISTRY_ID = "rochelle-and-christopher";

const gate = document.querySelector("#gate");
const registry = document.querySelector("#registry");
const accessForm = document.querySelector("#access-form");
const accessCode = document.querySelector("#access-code");
const accessMessage = document.querySelector("#access-message");
const giftGrid = document.querySelector("#gift-grid");
const giftSummary = document.querySelector("#gift-summary");
const giftTemplate = document.querySelector("#gift-template");
const reserveDialog = document.querySelector("#reserve-dialog");
const reserveForm = document.querySelector("#reserve-form");
const dialogGiftName = document.querySelector("#dialog-gift-name");
const guestName = document.querySelector("#guest-name");
const reserveMessage = document.querySelector("#reserve-message");
const dialogClose = document.querySelector(".dialog-close");

let activeGift = null;
let reservations = new Map();
let stopListening = null;

const isLocalPreview = !firebaseConfig
  && ["localhost", "127.0.0.1"].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).has("preview");

if (!firebaseConfig && !isLocalPreview) {
  accessMessage.textContent = "The registry is being prepared. Please try again shortly.";
  accessForm.querySelector("button").disabled = true;
  throw new Error("Firebase has not been configured.");
}

const firebaseApp = firebaseConfig ? initializeApp(firebaseConfig) : null;
const auth = firebaseApp ? getAuth(firebaseApp) : null;
const db = firebaseApp ? getFirestore(firebaseApp) : null;

function derivePassword(code) {
  return `registry-${code}-access`;
}

function setBusy(form, busy) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = busy;
  button.dataset.originalText ||= button.textContent;
  button.textContent = busy ? "Please wait…" : button.dataset.originalText;
}

function escapeText(value) {
  const element = document.createElement("span");
  element.textContent = value;
  return element.textContent;
}

function renderGifts() {
  giftGrid.replaceChildren();

  gifts.forEach((gift) => {
    const fragment = giftTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".gift-card");
    const image = fragment.querySelector("img");
    const reservation = reservations.get(gift.id);

    card.dataset.giftId = gift.id;
    image.src = gift.image;
    image.alt = gift.name;
    fragment.querySelector(".price").textContent = gift.price;
    const giftHeading = fragment.querySelector("h3");
    giftHeading.textContent = gift.name;
    giftHeading.title = gift.name;
    fragment.querySelector(".description").textContent = gift.description || "";

    const amazonLink = fragment.querySelector(".amazon-link");
    amazonLink.href = gift.amazonUrl;
    amazonLink.setAttribute("aria-label", `View ${gift.name} on Amazon`);

    const reserveButton = fragment.querySelector(".reserve-button");
    const giftActions = fragment.querySelector(".gift-actions");
    const reservedBanner = fragment.querySelector(".reserved-banner");
    const statusPill = fragment.querySelector(".status-pill");

    if (reservation) {
      card.classList.add("is-reserved");
      statusPill.textContent = "Reserved";
      reserveButton.remove();
      reservedBanner.hidden = false;
      reservedBanner.querySelector("strong").textContent = escapeText(reservation.name);
    } else {
      reserveButton.addEventListener("click", () => openReservation(gift));
    }

    giftGrid.append(fragment);
  });

  const availableCount = gifts.length - reservations.size;
  giftSummary.textContent = `${availableCount} of ${gifts.length} gift ideas available`;
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
  if (!auth) return;
  accessMessage.textContent = "";
  setBusy(accessForm, true);

  try {
    await signInWithEmailAndPassword(auth, registryUserEmail, derivePassword(accessCode.value.trim()));
    accessForm.reset();
  } catch {
    accessMessage.textContent = "That invitation code isn't quite right. Please try again.";
    accessCode.select();
  } finally {
    setBusy(accessForm, false);
  }
});

reserveForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeGift) return;

  if (!db) {
    reserveMessage.textContent = "Reservations are disabled in the local design preview.";
    return;
  }

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

dialogClose.addEventListener("click", () => reserveDialog.close());
reserveDialog.addEventListener("click", (event) => {
  if (event.target === reserveDialog) reserveDialog.close();
});

if (auth) {
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
    }
  });
} else if (isLocalPreview) {
  gate.hidden = true;
  registry.hidden = false;
  renderGifts();
}

window.addEventListener("pagehide", () => stopListening?.());
