# WHOOP 4.0 — direct BLE client, live dashboard and companion app

University project on Bluetooth software architecture: talk to a WHOOP 4.0 strap
directly over Bluetooth Low Energy (no WHOOP app, no cloud) and compute sleep,
recovery and strain metrics on your own machine.

Not affiliated with WHOOP. Protocol knowledge comes from the community
reverse-engineering work credited below; it is used only to interoperate with a
device the author owns.

## Layout

| Path | What it is | Status |
|---|---|---|
| `whoopble/` | Python client (`bleak`): framing, CRC-8/CRC-32, request/response matching, live HR, localhost dashboard | verified against a real strap |
| `tests/` | protocol unit tests, including frames captured from the strap | `pytest` — all pass |
| `whoop_app/` | Flutter app (iOS/macOS) on OpenStrap `protocol` + `analytics`: history drain, SQLite store, sleep/HRV/strain cards | written, needs Flutter to build (`whoop_app/SETUP.md`) |
| `whoopble.sh` | launcher that routes through the framework Python so macOS shows the Bluetooth prompt | |

## Python client

```bash
export WHOOP_ADDRESS=<uuid from scan>
./whoopble.sh scan
./whoopble.sh hello                                   # handshake + battery
./whoopble.sh stream --seconds 60 --output hr.csv     # live HR + RR intervals to CSV
./whoopble.sh serve                                   # dashboard at http://localhost:8765
./whoopble.sh serve --demo                            # same dashboard, synthetic data
```

On macOS anything that touches Bluetooth must be started from Terminal (TCC
attributes the access to the launching app). Quit the WHOOP phone app first —
the strap accepts one connection at a time.

## Protocol in one paragraph

Custom GATT service `61080001-8d6d-82b8-614a-1c8cb0f8dcc6`: write commands to
`…0002`, responses on `…0003`, events on `…0004`, data on `…0005`. Every frame is
`[0xAA][len u16 LE][CRC-8 poly 0x07 over len][type, seq, opcode, payload…][CRC-32 (zlib) LE]`,
payload zero-padded to 4 bytes. Handshake `GET_HELLO_HARVARD` (0x23); battery
`GET_BATTERY_LEVEL` (0x1A, deci-percent); `SET_GENERIC_HR_PROFILE` (0x0E) wakes the
dormant standard Heart Rate service (0x180D); `TOGGLE_REALTIME_HR` (0x03) streams
proprietary 1 Hz records; `SEND_HISTORICAL_DATA` (0x16) drains flash in batches
acknowledged with `HISTORICAL_DATA_RESULT` (0x17).

## Credits

- [OpenStrap](https://github.com/OpenStrap) — `protocol`, `analytics`, `edge`, `research` (MIT)
- [bWanShiTong/reverse-engineering-whoop-post](https://github.com/bWanShiTong/reverse-engineering-whoop-post) — original sniffer captures
- Write-ups by [Rusheel Raj](https://www.rusheelraj.com/blog/whoop/), [Alec Jude Wilson](https://judes.club/writing/cracking-the-whoop-5-bluetooth-protocol/) and [zulusierra](https://zulusierra.co/vestigator-part-4-whoop-protocol-cracking/)
