# Strapline

**Read your own WHOOP 4.0 over Bluetooth — in the browser, on your own machine.**

Connect the strap you already own, see live heart rate and heart-rate variability,
and keep the readings on your own device. No account, no cloud, no server: the page
is static and there is nowhere for your data to be uploaded to.

> Not affiliated with, endorsed by or connected to WHOOP, Inc. "WHOOP" is their
> trademark, used here only to say which hardware this works with.
> Read the [disclaimer](DISCLAIMER.md) before you use it.

## Try it

**[→ Open the dashboard](https://example.github.io/strapline-for-whoop/)** · or
[preview it with synthetic data](https://example.github.io/strapline-for-whoop/?demo=1)
— no strap needed.

Works in **Chrome, Edge, Opera and Brave** on macOS, Windows, Linux and Android.
It cannot work in Safari or Firefox, or anywhere on iPhone and iPad, because
[Web Bluetooth](https://caniuse.com/web-bluetooth) isn't implemented there —
on iOS, [Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055) is the
only browser that can.

Quit the WHOOP app on your phone first: a strap talks to one device at a time.

## What you get

Live heart rate with a zone gauge and trace · RMSSD, SDNN, pNN50 and a Poincaré
plot · respiratory rate derived from beat rhythm (RSA) · time in five heart-rate
zones · Banister TRIMP training load · sessions saved locally with CSV and JSON
export.

## Where your data goes

Into your own browser, and nowhere else. Readings are written to IndexedDB on the
machine that recorded them — roughly 145 bytes per second, so an hour is about half
a megabyte. The author never receives, sees or stores them, and keeps no backup:
clearing your browser data deletes them, so export anything you want to keep.

## What it will not do

The client can only build four commands — handshake, battery, keep-alive, and the
live heart-rate toggle. Everything destructive in the protocol (erasing the device's
flash, rebooting it, moving its read pointer, writing persistent configuration or
firmware) is **impossible to construct**, not merely discouraged. See
`ALLOWED_OPCODES` in [docs/whoop.js](docs/whoop.js).

## Also in this repository

| Path | What it is |
|---|---|
| `docs/` | the web app — a static page, deployable to GitHub Pages as-is |
| `whoopble/` | a Python client (`bleak`): same protocol, plus a localhost dashboard |
| `tests/` | protocol tests, run against frames captured from a real strap |
| `whoop_app/` | a Flutter app (iOS/macOS) for history sync and sleep/recovery metrics |

```bash
# Python client
./whoopble.sh scan
./whoopble.sh serve            # dashboard on http://localhost:8765
python3 -m pytest tests -q     # protocol tests
```

The browser build checks itself against the same captured frames — open the console
on the page and run `whoopSelfTest()`.

## How it works

The strap exposes a custom GATT service, `61080001-8d6d-82b8-614a-1c8cb0f8dcc6`:
commands are written to `…0002`, responses arrive on `…0003`, events on `…0004` and
data on `…0005`. Every frame is

```
[0xAA] [size u16 LE] [CRC-8 poly 0x07 over the size] [payload, padded to 4 bytes] [CRC-32 zlib LE]
```

wrapping `[packet type][sequence][opcode][body]`. `GET_HELLO_HARVARD` (0x23) opens a
session, `GET_BATTERY_LEVEL` (0x1A) returns deci-percent, and `TOGGLE_REALTIME_HR`
(0x03) starts a 1 Hz stream carrying heart rate and beat-to-beat intervals.

## Credits

Protocol knowledge comes from the interoperability community, chiefly
[OpenStrap](https://github.com/OpenStrap) (`protocol`, `analytics`, `research`, MIT) and
[bWanShiTong's write-up](https://github.com/bWanShiTong/reverse-engineering-whoop-post),
with sniffer analyses by [Rusheel Raj](https://www.rusheelraj.com/blog/whoop/),
[Alec Jude Wilson](https://judes.club/writing/cracking-the-whoop-5-bluetooth-protocol/)
and [zulusierra](https://zulusierra.co/vestigator-part-4-whoop-protocol-cracking/).

## Licence

[MIT](LICENSE). No warranty, no liability — see the [disclaimer](DISCLAIMER.md).
