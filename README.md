# Rochelle & Christopher's Baby Shower Gift List

A private-entry baby shower gift registry hosted with GitHub Pages and backed by Firebase Authentication and Cloud Firestore.

Guests enter the shared invitation code, browse the Amazon.ae gift ideas, filter and sort them by Amazon price, and reserve a gift in their name. Firestore security rules ensure each gift can only be reserved once, and everyone sees new reservations as they happen.

## How it works

```
public/             the whole site: HTML, CSS, JS, gift data, product images
firestore.rules     who can read and create reservations
firebase.json       Firebase project settings (auth + rules)
.github/workflows/  deploys public/ to GitHub Pages, refreshes prices every morning, applies Remove/Keep decisions
```

- Entering the invitation code signs the guest into a shared Firebase account. The Firestore rules only let that account read or create reservations.
- A reservation is a Firestore document whose id is the gift's Amazon ASIN, so a second guest can't take the same gift. Reservations can't be edited or deleted from the site.
- Merging to `main` deploys the site. No build step.

## Host notes

- **Seeing reservations.** Firebase Console, Firestore Database, `registries/rochelle-and-christopher/reservations`. Each document is one gift: `itemId`, `name`, `reservedAt`.
- **Fixing a mistaken reservation.** Delete that document in the Firebase Console. The gift becomes available again straight away.
- **Changing the invitation code.** The code is exactly 4 digits and is the password of the registry user in Firebase Authentication, stored as `registry-<code>-access`. The Firebase Console can't set a new password directly (its "Reset password" sends an email, and this user's address is not a real one), so use the Firebase Auth admin API or the Admin SDK to set the registry user's password. Then update the `INVITE_CODE` secret (see "Keeping prices fresh"), or the morning price job will stop and raise an issue. Guests signed in with the old code are signed out and need the new one.
- **Updating the gift list.** Gifts are in `public/gifts-full.js` and their images in `public/assets/<ASIN>.jpg`. Reservations are keyed by ASIN, so a reservation for a removed gift stays in Firestore but no longer shows.
- Amazon prices are snapshots and may change. Delivery charges are not included.

## Keeping prices fresh

Prices come from the Amazon.ae wishlist and are refreshed every morning. `scripts/update-prices.mjs` reads the wishlist, updates the prices in `public/gifts-full.js`, and prints a Markdown report of what changed.

```sh
node scripts/update-prices.mjs --dry-run   # report only, writes nothing
node scripts/update-prices.mjs             # refresh and write the data file
node --test "test/*.test.mjs"              # unit tests (no network needed)
```

It needs Node 22.21 or newer and no packages. Safety rules, all listed in the report:

- A price that moves by more than 25% is **held for review**, not applied. Amazon sometimes shows a different offer depending on where the page is fetched from, so a few prices can differ from what you see in the UAE.
- If the wishlist scrape finds fewer than 80% of the gifts, or Amazon serves a bot check, nothing is changed.
- **Gifts a guest has already reserved are never touched**: no price change and no alert. To know which are reserved, the job signs in as the guest account and reads Firestore, so it needs the invitation code in a repository secret named `INVITE_CODE` (GitHub, Settings, Secrets and variables, Actions, New repository secret). If the secret is missing or wrong, the job changes nothing and opens the issue. For a manual run on your own machine: `INVITE_CODE=<code> node scripts/update-prices.mjs`, or add `--ignore-reservations` to skip the check.
- Only the `price` of a gift ever changes. Items added to or missing from the Amazon wishlist are reported but **not** added or removed. Adding a gift means adding its image and name by hand.

### Every morning, automatically

`.github/workflows/price-update.yml` runs the script at 06:07 UAE time. If prices changed it commits `public/gifts-full.js` to `main` and starts the Pages deploy, so the live site updates by itself. Nothing needs setting up. To run it right now: GitHub, Actions, "Update prices", "Run workflow".

If something needs a look (a held price, a gift added to or missing from the Amazon wishlist, a gift bought on Amazon, or a failed run), the run opens one issue labelled `price-review` with the report, keeps it up to date, and closes it once everything is clear. The full report is also on each run's summary page.

`scripts/ignore.json` lists gifts the host has already looked at. A gift on it keeps its price on the site however far Amazon's price moves (Amazon shows some items at a different price depending on location), and a wishlist item on it that is deliberately not on the site isn't reported as new. Remove an id from the list to have it flagged again.

### Big price jumps: Remove or Keep

When a gift's Amazon price moves by more than 25% (and a guest hasn't reserved it), the site keeps the old price and the open `price-review` issue lists it with two links: **Remove it from the list** and **keep it at the new price**.

Tapping one opens a pre-filled GitHub issue. Press "Submit new issue" and within a minute the gift list changes, the site redeploys, and the issue closes with a note saying what happened (`.github/workflows/gift-decision.yml`). Only the repository owner and collaborators can do this, a gift a guest has already reserved is never removed or repriced, and a removed gift is added to `scripts/ignore.json` so the morning check doesn't report it as new. If nobody does anything, the site keeps the old price.

WhatsApp alerts are not switched on. The code for sending them through CallMeBot is in `scripts/lib/notify.mjs` and `scripts/notify-held.mjs` (with tests), but no workflow step calls it.

### Repository secret

Set this under GitHub, Settings, Secrets and variables, Actions, New repository secret:

| Secret | Value | Used for |
| --- | --- | --- |
| `INVITE_CODE` | The current 4-digit invitation code | Reading which gifts are reserved, so they are left alone |

## Previewing locally

```sh
python3 -m http.server 8000 -d public
```

Open http://localhost:8000. It talks to the real Firebase project, so you need the invitation code to get past the gate, and any reservation you make is real.
