#!/usr/bin/env node
// Changes the invitation PIN (the password of the shared guest account).
//
//   OLD_PIN=1111 NEW_PIN=2222 node scripts/change-pin.mjs
//
// Needs the current PIN, not admin access. Afterwards: update the INVITE_CODE repository secret, and
// tell guests the new PIN. Guests signed in with the old one are signed out within about an hour.
import { firebaseConfig, registryUserEmail } from "../public/firebase-config.js";
import { changePin } from "./lib/pin.mjs";

try {
  await changePin({ firebaseConfig, email: registryUserEmail, oldPin: process.env.OLD_PIN, newPin: process.env.NEW_PIN });
  console.log("Done: the PIN is changed and the new one signs in. Update the INVITE_CODE secret on GitHub next.");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
