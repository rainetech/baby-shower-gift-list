import { neon } from "@neondatabase/serverless";
import { gifts } from "../public/gifts-full.js";
import { createHandlers } from "./handlers.js";

let client;

// Created lazily so a missing DATABASE_URL becomes a handled 500 instead of a crash at import time.
function query(text, params) {
  client ||= neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  return client.query(text, params);
}

export const { login, reservations } = createHandlers({
  query,
  giftIds: new Set(gifts.map((gift) => gift.id))
});
