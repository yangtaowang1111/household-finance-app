# Ledger — iOS

The phone half of the household finance app. Reads the same API as the web
version on the NAS; stores nothing of its own.

## What it is for

The split is deliberate. Setting a budget across fifty-nine categories is
keyboard work and stays on the web. What a phone is for is the other half —
*"are we over on this?"* — asked while standing in a shop, which is exactly when
a laptop is not to hand.

So Budget is read-only here, and Transactions is search-first rather than
edit-first.

## Running it on your phone

You need **Tailscale connected on the phone** — the NAS has no public port, so
without it the app cannot reach anything.

```bash
cd mobile
npm install
npx expo install expo-router expo-status-bar expo-symbols \
  react-native-safe-area-context react-native-screens \
  @react-native-async-storage/async-storage
npx expo start
```

Install **Expo Go** from the App Store, scan the QR code, and the app opens. On
first run it asks for the NAS address and the API key.

The phone and this computer need to be on the same wifi for Expo Go to find the
dev server. Reaching the NAS itself goes over Tailscale, so that part works from
anywhere.

## Making it a real app on the home screen

Expo Go is a viewer — the app lives inside it and disappears when you close it.
For an icon on the home screen that opens on its own, it needs a development
build, which requires an Apple Developer account. Worth doing once the design is
settled; not worth it to look at a first draft.

## Design

`lib/theme.js` holds the whole visual language, converted from the web app's
OKLCH tokens in `public/styles.css`. Change a colour there and it changes
everywhere in the app — consistency is structural rather than maintained by
hand.

The layout follows iOS's grouped-inset list convention (the shape Settings, Mail
and Health all use) and SF Symbols for the tab bar. Matching the platform's own
patterns is most of what "feels native" actually means: a reader knows how these
behave before opening the app.
