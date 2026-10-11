# Publishing `myto` to npm — manual steps

Everything is built and ready. One thing blocks the publish, and it is an
**account credential**, not the code.

## Why `npm publish` returns 403

```
403 Forbidden - PUT https://registry.npmjs.org/myto
Two-factor authentication or granular access token with bypass 2fa enabled
is required to publish packages.
```

npm requires **one** of these to publish:

1. **2FA enabled** on the account (authenticator app), so you can pass `--otp=123456`, **or**
2. A **granular access token with "Bypass 2FA" turned ON**.

Your account (`explorearafat`) currently has `tfa: false`, and the token in
`~/.npmrc` is a granular token that was created **without** the bypass-2FA
option — so npm rejects the publish.

> Note: the email OTP ("The OTP code is: …") only authorises **website logins**.
> It does **not** work for CLI publishing. Passing it to `npm publish --otp=`
> still returns the same 403.

Pick **Option A** (easiest) or **Option B** below.

---

## Step 0 — build and check (do this first, always)

```bash
cd /c/Users/ARAFAT/OneDrive/Desktop/Myto/cli

node build.mjs          # rebuilds dist/cli.js  (~110 kB)
npm test                # 15 tests should pass
npm pack --dry-run      # shows the 4 files that will ship
```

You should see the tarball listed as:

```
LICENSE
README.md
dist/cli.js
package.json
```

---

## Option A — granular token with Bypass 2FA  *(recommended)*

**A1.** In a normal browser, open:

```
https://www.npmjs.com/settings/explorearafat/tokens
```

**A2.** Click **Generate New Token** → choose **Granular Access Token**.

- **Token name:** `myto-publish`
- **Expiration:** 30 days (or whatever you prefer)
- **Packages and scopes:** Read and write
  - Select **All packages**, or add `myto` specifically
- **Organizations:** No access
- ✅ **Enable "Bypass 2FA"** ← this is the critical checkbox

**A3.** Click **Generate Token** and **copy it immediately** (it is shown once).
It looks like `npm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.

**A4.** Save it and publish:

```bash
cd /c/Users/ARAFAT/OneDrive/Desktop/Myto/cli

# store the token (replaces the old one)
npm config set //registry.npmjs.org/:_authToken=npm_PASTE_YOUR_TOKEN_HERE

# confirm it works
npm whoami                 # → explorearafat

# publish
npm publish --access public
```

A successful publish ends with:

```
+ myto@1.0.0
```

---

## Option B — enable 2FA, then publish with an OTP

**B1.** Install an authenticator app (Google Authenticator / Authy / 1Password)
on your phone.

**B2.** In a normal browser, open:

```
https://www.npmjs.com/settings/explorearafat/profile
```

Enable **Two-Factor Authentication** → **Authenticator app** → scan the QR code
→ save the recovery codes.

**B3.** Publish, typing the current 6-digit code from the app:

```bash
cd /c/Users/ARAFAT/OneDrive/Desktop/Myto/cli

npm publish --access public --otp=123456
```

The code changes every 30 seconds — run the command, then enter a fresh code
when prompted.

---

## Step 2 — verify it really published

```bash
npm view myto version            # → 1.0.0
npm view myto dist.tarball       # → https://registry.npmjs.org/myto/-/myto-1.0.0.tgz
```

Then prove the real install works (the whole point):

```bash
npm install -g myto
myto --version                   # → 1.0.0
myto --help
```

---

## Option C — no npm publish at all (git install)

If you want a shareable install without touching the registry, commit `dist/`
and add a `prepare` script. Then anyone can run:

```bash
npm install -g github:explorearafat/myto
```

Requires: removing `dist` from `cli/.gitignore` and adding to `cli/package.json`:

```json
"scripts": { "prepare": "node build.mjs" }
```

---

## Publishing a new version later

```bash
cd /c/Users/ARAFAT/OneDrive/Desktop/Myto/cli
npm version patch        # 1.0.0 → 1.0.1  (or minor / major)
node build.mjs
npm publish --access public          # add --otp=… only if you chose Option B
```

npm will refuse to overwrite an existing version — you must bump it first.

---

## Quick reference

| Task | Command |
| --- | --- |
| Rebuild the CLI | `node build.mjs` |
| Run tests | `npm test` |
| Preview what ships | `npm pack --dry-run` |
| Check login | `npm whoami` |
| Publish | `npm publish --access public` |
| Publish with OTP | `npm publish --access public --otp=123456` |
| Verify live | `npm view myto version` |
| Install globally | `npm install -g myto` |
