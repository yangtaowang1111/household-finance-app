# Ledger — iOS

The phone half of the household finance app. Reads the same API as the web
version on the NAS; stores nothing of its own but the address and the key.

## What it is for

The split is deliberate. Setting a budget across fifty-nine categories is
keyboard work and stays on the web. What a phone is for is the other half —
*"are we over on this?"* — asked while standing in a shop, which is exactly when
a laptop is not to hand. So Budget is read-only here and Transactions is
search-first.

## Running it

You need **Tailscale connected on the phone**. The NAS has no public port, so
without it the app can reach the dev server but nothing behind it.

```bash
cd mobile
npm install
npx expo start --clear
```

Install **Expo Go** from the App Store, scan the QR code with the **Camera app**
(not from inside Expo Go), and tap the banner. First run asks for the NAS address
and the API key, and tests them before letting you through.

Phone and computer must be on the same wifi for Expo Go to find the dev server.
Reaching the NAS goes over Tailscale, so that part works from anywhere.

## Two things that will bite

**The Expo SDK must match Expo Go exactly.** Expo Go is one app built against one
SDK, so a project targeting a newer one cannot run inside it — the native modules
are simply absent. `latest` is therefore wrong here, however right it looks.

If Expo Go says the project is incompatible, **read the SDK version from Expo
Go's own settings tab** rather than inferring it. The error says only "requires a
newer version", which is true of every version above the one installed and so
identifies none of them. Then `npm install expo@~<that version>.0.0` and restart
with `--clear` — the dev server holds the SDK from when it started, so a
downgrade without a restart looks exactly like a downgrade that failed.

**There are no config plugins, on purpose.** expo-router, expo-symbols and
expo-status-bar each brought one, and the plugin resolver could not load them
under Node 24 — it tries to read TypeScript source from node_modules, which Node
refuses. For three screens with no deep linking, a state variable does what a
router would have. If real navigation is ever needed, that is the moment to add
the dependency back.

## Design

`lib/theme.js` holds the whole visual language, converted from the web app's
OKLCH tokens in `public/styles.css`. Change a colour there and it changes
everywhere — consistency across web, iPhone and iPad is structural rather than
maintained by hand.

Layout follows iOS's grouped-inset list convention, the shape Settings, Mail and
Health all use. Matching the platform's own patterns is most of what "feels
native" means: a reader knows how these behave before opening the app.
