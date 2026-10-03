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
- **Price comparisons.** `public/alternative-prices.js` holds exact-match offers from other UAE retailers, cheapest first. The check date shown is `priceCheckDate` in that file. An offer can also be:
  - a **dated snapshot** (its own `checked` date), labelled "as of <date>" on the site because it couldn't be re-verified;
  - **link-only** (no price), shown as "Check price" for sites whose prices can't be read automatically;
  - **`soldOut: true`**, hidden on the site but kept so it can come back.
- Amazon and alternative prices are snapshots and may change. Delivery charges are not included.

## Keeping prices fresh

`scripts/update-prices.mjs` refreshes the Amazon.ae wishlist prices and every retailer price, rewrites `public/gifts-full.js` and `public/alternative-prices.js`, and prints a Markdown report of what changed.

```sh
node scripts/update-prices.mjs --dry-run   # report only, writes nothing
node scripts/update-prices.mjs             # refresh and write the two data files
node --test "test/*.test.mjs"              # unit tests (no network needed)
```

It needs Node 22.21 or newer and no packages. Safety rules, all listed in the report:

- A price that moves by more than 25% (Amazon) or 40% (other retailers) is **held for review**, not applied. Amazon sometimes shows a different offer depending on where the page is fetched from, so a few prices can differ from what you see in the UAE.
- If the wishlist scrape finds fewer than 80% of the gifts, or Amazon serves a bot check, nothing is changed.
- Items added to or missing from the Amazon wishlist are reported but **not** added or removed. Adding a gift means adding its image and name by hand.
- A retailer page that can't be read is left as it was and dated. Several sites (Noon, Lulu, Sharaf DG, Babyshop, Carrefour, Union Coop, Waitrose) often block automated requests.
- FirstCry only tells the script a product is in stock when its page data shows a quantity above 0. A quantity of 0 is read as "unknown", because it also appears on products that can be bought.

### Every morning, automatically

`.github/workflows/price-update.yml` runs the script at 06:07 UAE time. If prices changed it commits the two data files to `main` and starts the Pages deploy, so the live site updates by itself. Nothing needs setting up. To run it right now: GitHub, Actions, "Update prices", "Run workflow".

If something needs a look (a held price, a gift added to or missing from the Amazon wishlist, a gift bought on Amazon, or a failed run), the run opens one issue labelled `price-review` with the report, keeps it up to date, and closes it once everything is clear. The full report is also on each run's summary page.

`scripts/held-ignore.json` lists gifts whose Amazon price from the server differs a lot from what you see in the UAE (Amazon shows some items at a different price depending on location). Their price on the site is left alone and they don't raise an issue. Remove an id from the list to have it flagged again.

## Previewing locally

```sh
python3 -m http.server 8000 -d public
```

Open http://localhost:8000. It talks to the real Firebase project, so you need the invitation code to get past the gate, and any reservation you make is real.
