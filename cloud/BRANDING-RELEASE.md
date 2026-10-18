# Approved neon branding release

This release carries the website-approved full neon logo, including the cyan-blue
“STAY THIRSTY,” pink “BEACHES” tagline, cup, palms and wave. All logo and icon
references use `logo20261018` to bypass old browser assets.

## Scope and safeguards

- Both kiosk filenames retain the current beach scene, menu and payment scripts.
- Make Station and the pickup board retain their ticket, voice and authentication logic.
- The cloud Worker source is unchanged and was compared with the live deployed source map.
- Local kiosk updater version 23 includes all new icon assets.
- Cloud PAGE_VERSION 13 refreshes connected displays through their existing update mechanism.
- Clover secrets, station access key, KV namespace and merchant bindings are not changed.
- No real customer orders, payments, done/undo actions or owner-control writes are used in QA.

## Cloud release

Use Node 22 and an authorized Cloudflare deployment environment:

```sh
cd cloud
node build.js
node preserve-live-menu.js
wrangler deploy
```

The branding helper is mandatory for this release. The live cloud station has
menu exports that differ from the repository; the helper preserves both live
`recipes.json` and `addons.json` exactly and stops on failed or invalid downloads.
Do not rebuild after preserving the files without running the helper again.
The normal menu-publication workflow is not changed.

After deployment, verify public health, both HTML pages, logo/icon asset hashes,
unchanged menu hashes, and HTTP 401 for unauthenticated `/queue`.

## Physical kiosk rollout

Merging the manifest into main makes version 23 available to the existing local
updater. Physical device installation requires its next successful sync/reload;
a GitHub merge alone cannot prove an offline kiosk has updated.
