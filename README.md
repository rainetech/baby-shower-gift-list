# Rochelle & Christopher's Baby Shower Gift List

A private-entry baby shower gift registry. Guests enter the shared invitation code, browse the Amazon.ae gift ideas, filter and sort them by Amazon price, compare exact-match prices from other UAE retailers, and reserve a gift in their name. Reservations live in a [Neon](https://neon.tech) Postgres database, and each gift can only be reserved once.

## How it works

```
public/        static site (HTML, CSS, JS, gift data, product images)
api/           Vercel serverless functions: POST /api/login, GET|POST /api/reservations
lib/           handler logic, session cookie signing, database schema
scripts/       local preview server
test/          API tests (run against an in-memory Postgres)
```

- The browser never talks to the database. It calls the API, and only the API holds the Neon connection string.
- Entering the invitation code (`POST /api/login`) sets a signed, `HttpOnly` session cookie that lasts 30 days. Reservation requests without it are rejected.
- A wrong code is logged per IP address, and after 10 failures an IP is blocked for 15 minutes.
- The `reservations` table has `item_id` as its primary key, so two guests can never book the same gift, even at the same moment. The loser sees "already reserved" and the list refreshes.
- The page re-checks reservations every 15 seconds and whenever the tab becomes visible again.
- The tables are created automatically the first time the API runs.

## Deploy

1. **Database.** In Vercel, open the project, then Storage, then add the Neon integration (or create a project at neon.tech and copy its connection string). This provides `DATABASE_URL` (`POSTGRES_URL` also works).
2. **Environment variables** (Vercel project, Settings, Environment Variables):

   | Name | Value |
   | --- | --- |
   | `DATABASE_URL` | Neon connection string (set by the integration) |
   | `INVITE_CODE` | The 4-digit invitation code you share with guests |
   | `SESSION_SECRET` | Optional. Any long random string. If omitted, one is derived from the code and database URL |

   Changing `INVITE_CODE` signs everyone out, and guests must enter the new code.
3. **Deploy** from this repository. Vercel serves `public/` and the functions in `api/` (see `vercel.json`).

## Local preview and tests

```sh
npm install
npm run dev     # http://localhost:3000, invitation code 1234, in-memory database (resets on restart)
npm test
```

`INVITE_CODE=4321 PORT=4000 npm run dev` changes the code and port.

## Host notes

- **Seeing and fixing reservations.** Open the Neon console, then SQL Editor:

  ```sql
  select item_id, name, reserved_at from reservations order by reserved_at;
  delete from reservations where item_id = 'B0C65Z31KS';  -- frees that gift up again
  ```

  Guests cannot edit or cancel a reservation, so use this if someone books by mistake.
- **Updating the gift list.** Gifts are in `public/gifts-full.js` and images in `public/assets/<ASIN>.jpg`. Reservations are keyed by Amazon ASIN, so reservations for a removed gift stay in the database but no longer appear.
- **Price comparisons.** `public/alternative-prices.js` holds verified exact-match offers from other UAE retailers. A gift can have several retailers, listed cheapest first. Prices are snapshots, and the check date shown on the site is `priceCheckDate` in that file.
- Amazon and alternative prices are indicative and may change. Delivery charges are not included.
