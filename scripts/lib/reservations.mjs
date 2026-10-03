const REGISTRY_ID = "rochelle-and-christopher";

// Signs in as the shared guest account the same way the site does (email plus a password derived
// from the invitation code) and returns the ids of the gifts that are already reserved. The Firestore
// rules only let that account read reservations, so the morning job needs the invitation code.
export async function fetchReservedIds({ firebaseConfig, email, code, fetchImpl = fetch }) {
  if (!code) throw new Error("INVITE_CODE is not set, so reservations can't be read and no prices were changed");

  const signIn = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: `registry-${code}-access`, returnSecureToken: true })
  });
  const auth = await signIn.json().catch(() => ({}));
  if (!signIn.ok || !auth.idToken) {
    throw new Error(`Could not sign in to Firebase to read reservations (${auth.error?.message ?? `HTTP ${signIn.status}`}). Is the INVITE_CODE secret the current invitation code?`);
  }

  const ids = new Set();
  let pageToken = "";
  do {
    const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/registries/${REGISTRY_ID}/reservations?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${auth.idToken}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Could not read reservations (${body.error?.message ?? `HTTP ${response.status}`})`);
    for (const doc of body.documents ?? []) ids.add(doc.name.split("/").pop());
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return ids;
}
