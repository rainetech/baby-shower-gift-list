# Rochelle & Christopher's Baby Shower Gift List

A private-entry baby shower gift registry hosted with GitHub Pages and backed by Firebase Authentication and Cloud Firestore.

Guests enter the shared invitation code, browse the Amazon.ae gift ideas, filter and sort them by Amazon price, compare exact-match prices from other UAE retailers, and reserve a gift in their name. Firestore security rules ensure each gift can only be reserved once, and everyone sees new reservations as they happen.

## How it works

```
public/             the whole site: HTML, CSS, JS, gift data, product images
firestore.rules     who can read and create reservations
firebase.json       Firebase project settings (auth + rules)
.github/workflows/  deploys public/ to GitHub Pages on every push to main
```

- Entering the invitation code signs the guest into a shared Firebase account. The Firestore rules only let that account read or create reservations.
- A reservation is a Firestore document whose id is the gift's Amazon ASIN, so a second guest can't take the same gift. Reservations can't be edited or deleted from the site.
- Merging to `main` deploys the site. No build step.

## Host notes

- **Seeing reservations.** Firebase Console, Firestore Database, `registries/rochelle-and-christopher/reservations`. Each document is one gift: `itemId`, `name`, `reservedAt`.
- **Fixing a mistaken reservation.** Delete that document in the Firebase Console. The gift becomes available again straight away.
- **Changing the invitation code.** In Firebase Console, Authentication, open the registry user and set its password to `registry-<new 4 digits>-access`. The code is exactly 4 digits.
- **Updating the gift list.** Gifts are in `public/gifts-full.js` and their images in `public/assets/<ASIN>.jpg`. Reservations are keyed by ASIN, so a reservation for a removed gift stays in Firestore but no longer shows.
- **Price comparisons.** `public/alternative-prices.js` holds verified exact-match offers from other UAE retailers, with up to three per gift, cheapest first. The check date shown is `priceCheckDate` in that file. An offer with its own `checked` date is an older snapshot that couldn't be re-verified; the site labels it "as of <date>" until it is re-checked or removed.
- Amazon and alternative prices are snapshots and may change. Delivery charges are not included.

## Previewing locally

```sh
python3 -m http.server 8000 -d public
```

Open http://localhost:8000. It talks to the real Firebase project, so you need the invitation code to get past the gate, and any reservation you make is real.
