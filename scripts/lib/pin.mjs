// The guest account's password is derived from the 4-digit PIN, the same way the site does it.
export const derivePassword = (pin) => `registry-${pin}-access`;

const isPin = (value) => /^\d{4}$/.test(String(value ?? ""));

// Changes the PIN by signing in with the current one and setting a new password, which Firebase
// allows for a signed-in user, so no admin access is needed. Then proves the new PIN works.
// Throws with a clear message; no message ever contains either PIN.
export async function changePin({ firebaseConfig, email, oldPin, newPin, fetchImpl = fetch }) {
  if (!isPin(oldPin) || !isPin(newPin)) throw new Error("Both the current and the new PIN must be exactly 4 digits.");
  if (oldPin === newPin) throw new Error("The new PIN is the same as the current one, so nothing was changed.");

  const call = async (path, payload) => {
    const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/${path}?key=${firebaseConfig.apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  };

  const current = await call("accounts:signInWithPassword", { email, password: derivePassword(oldPin), returnSecureToken: true });
  if (!current.ok || !current.body.idToken) {
    throw new Error(`The current PIN was not accepted (${current.body.error?.message ?? `HTTP ${current.status}`}), so nothing was changed.`);
  }

  const update = await call("accounts:update", { idToken: current.body.idToken, password: derivePassword(newPin), returnSecureToken: false });
  if (!update.ok) throw new Error(`Firebase refused the change (${update.body.error?.message ?? `HTTP ${update.status}`}), so the old PIN still works.`);

  const check = await call("accounts:signInWithPassword", { email, password: derivePassword(newPin), returnSecureToken: true });
  if (!check.ok || !check.body.idToken) throw new Error("The change was sent, but signing in with the new PIN did not work. Check it in the Firebase Console.");
  return true;
}
