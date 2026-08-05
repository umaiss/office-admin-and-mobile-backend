# OB Track — Auth API for Frontend

Base URL: `http://13.60.233.201/api/v1`

All requests and responses are JSON. Send `Content-Type: application/json`.

## Response envelope

**Every** successful response is wrapped like this:

```json
{
  "success": true,
  "data": { ... },
  "timestamp": "2026-07-31T09:15:00.000Z"
}
```

Read your payload from `data`. Errors use the same `success` field, set to `false`:

```json
{
  "success": false,
  "statusCode": 401,
  "message": "Invalid credentials, or the account is deactivated.",
  "error": "Unauthorized",
  "path": "/api/v1/auth/login",
  "timestamp": "2026-07-31T09:15:00.000Z",
  "requestId": "req-1a2b3c"
}
```

`message` can be a string or an array of strings (array on validation errors). Branch on `success`.

---

## 1. Login

Sign in with email and password. Returns the user plus an access/refresh token pair.

**POST** `/api/v1/auth/login`

Request body:

```json
{
  "email": "admin@yourcompany.com",
  "password": "CHANGE_ME_MIN_12_CHARS"
}
```

Test office-boy credentials:

```json
{
  "email": "bilal@obtrack.local",
  "password": "Password123!"
}
```

Success `200`:

```json
{
  "success": true,
  "data": {
    "accessToken": "<jwt>",
    "refreshToken": "3f2504e0-....Zm9vYmFy",
    "expiresIn": 900,
    "user": {
      "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "name": "Ahmed Khan",
      "email": "ahmed@example.com",
      "role": "OFFICE_BOY",
      "phone": "+923001234567",
      "isActive": true
    }
  },
  "timestamp": "2026-07-31T09:15:00.000Z"
}
```

Notes:
- `expiresIn` is **seconds** until the access token expires.
- `role` is either `"ADMIN"` or `"OFFICE_BOY"`.
- Store `refreshToken` in secure storage (Keychain / Keystore) — never in localStorage/AsyncStorage in plain text.
- `401` on wrong credentials or a deactivated account.
- This endpoint is rate-limited more strictly than the rest of the API.

---

## 2. Login through Access Token (get current user)

Use the access token to fetch the signed-in user's own profile. This is how you restore a session on app launch — if the stored access token is still valid, call this to confirm who's logged in without a fresh password login.

**GET** `/api/v1/auth/profile`

Header:

```
Authorization: Bearer <accessToken>
```

No body.

Success `200`:

```json
{
  "success": true,
  "data": {
    "id": "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "name": "Ahmed Khan",
    "email": "ahmed@example.com",
    "role": "OFFICE_BOY",
    "phone": "+923001234567",
    "isActive": true,
    "lastLoginAt": "2026-07-31T09:10:00.000Z",
    "createdAt": "2026-07-01T08:00:00.000Z",
    "updatedAt": "2026-07-31T09:10:00.000Z"
  },
  "timestamp": "2026-07-31T09:15:00.000Z"
}
```

- `401` if the token is missing, invalid, or expired → send the user to login (or refresh first, see below).

---

## 3. Refresh (exchange refresh token for a new pair)

When the access token has expired (or is about to), exchange the refresh token for a **new** access + refresh pair. No access token needed here — the refresh token is the credential.

**POST** `/api/v1/auth/refresh`

Request body:

```json
{
  "refreshToken": "3f2504e0-....Zm9vYmFy"
}
```

Success `200`:

```json
{
  "success": true,
  "data": {
    "accessToken": "<new jwt>",
    "refreshToken": "<new refresh token>",
    "expiresIn": 900
  },
  "timestamp": "2026-07-31T09:15:00.000Z"
}
```

**Important — token rotation:**
- The old refresh token is revoked the moment you refresh. **Always save the new `refreshToken`** and discard the old one.
- Presenting an already-used refresh token is treated as theft and ends **every** session for that user (they'll be logged out everywhere). So never refresh twice with the same token — serialize your refresh calls if the app fires several requests at once.
- `401` on an invalid, expired, or reused token → send the user to login.

---

## 4. Logout (end session on this device)

Revokes the supplied refresh token. Other devices stay logged in.

**POST** `/api/v1/auth/logout`

Request body:

```json
{
  "refreshToken": "3f2504e0-....Zm9vYmFy"
}
```

Success `200`:

```json
{
  "success": true,
  "data": { "message": "Logged out successfully" },
  "timestamp": "2026-07-31T09:15:00.000Z"
}
```

- Always returns success, even for an unknown token — so clear local tokens and route to login regardless of the response.

---

## Suggested client flow

1. **Login** → store `accessToken`, `refreshToken`, and `user`.
2. Send `Authorization: Bearer <accessToken>` on every authenticated request.
3. On any `401`, call **refresh** once, save the new pair, retry the original request. If refresh also 401s → clear tokens, go to login.
4. On app launch with a stored token → call **profile** to restore the session (refresh first if the access token is already expired).
5. **Logout** → call the endpoint, then clear stored tokens.
