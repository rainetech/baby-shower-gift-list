# Rochelle & Christopher's Baby Shower Gift List

A private-entry baby shower gift registry hosted with GitHub Pages and backed by Firebase Authentication and Cloud Firestore.

Guests enter the shared invitation code, browse the Amazon gift ideas, compare verified exact-match prices from UAE retailers, and reserve one in their name. Firestore document creation and security rules ensure each gift can only be reserved once.

## Host notes

- Product prices are indicative and may change. Alternative price snapshots and their check date are stored in `alternative-prices.js`.
- Reservations can be viewed in Firebase Console under `registries/rochelle-and-christopher/reservations`.
- Guests cannot edit or remove reservations. A host can remove an accidental reservation from Firebase Console.
