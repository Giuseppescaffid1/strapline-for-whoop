# Disclaimer

By downloading, installing, running or otherwise using this software, you acknowledge
and accept everything set out below.

## No affiliation

This project is **not affiliated with, authorised by, endorsed by, sponsored by or
connected to WHOOP, Inc.** WHOOP is a registered trademark of WHOOP, Inc., and all
rights in it belong to them. It is used in this repository only descriptively, to
identify the hardware this software interoperates with. No WHOOP trademark, logo,
icon, artwork or branding is used in this project's name, marks or interface, and
nothing here should be read as suggesting that WHOOP produced, reviewed or approves
of it.

This is not a replacement for the WHOOP application. It is an additional way to look
at a device you own, and it leaves that application working normally.

## What this software is

An independent Bluetooth Low Energy client, written from observation of a device's
own radio behaviour and from protocol notes published by the interoperability
community. It contains **no WHOOP source code, firmware, binaries, cryptographic
keys, artwork, or any other material obtained from WHOOP**.

## What it does not touch

These are verifiable by reading the source, and we invite anyone to check:

- It **never contacts WHOOP's servers, APIs, accounts or any of their services.**
  The browser application contains no networking code whatsoever — no `fetch`, no
  `XMLHttpRequest`, no WebSocket, no telemetry. After the page itself is loaded it
  speaks only to a Bluetooth device in the room.
- It **holds no credentials** — no account, no login, no token, no API key.
- It **exposes no one else's data.** It can only reach a device that the person
  using it physically has and consents to pairing with.
- It **does not decrypt, unlock or defeat any protection.** The characteristics it
  reads accept ordinary unauthenticated Bluetooth connections; nothing is bypassed
  to reach them.
- It **does not bypass any subscription, payment or paywall**, and makes no paid
  feature available. It reads live sensor measurements, nothing more.

## Interoperability purpose

This software exists so that the owner of a device can read the measurements that
device takes from their own body, on hardware they own.

In the European Union, Directive 2009/24/EC Articles 5(3) and 6 permit the study and
decompilation of a program for interoperability purposes, and **Article 8 makes any
contractual term purporting to prohibit that void**. In the United States, 17 U.S.C.
§ 1201(f) provides an interoperability exemption.

## No warranty and no liability

The software is provided "as is" under the MIT Licence (see [LICENSE](LICENSE)),
without warranty of any kind. **To the fullest extent permitted by applicable law,
the authors and contributors accept no liability** for any loss or damage of any
kind — including damage to a device, loss of data, loss of warranty cover, or any
direct, indirect or consequential loss — arising from use of, or inability to use,
this software.

You use it entirely at your own risk.

## Risks you accept

- Using third-party software with your device **may void its manufacturer warranty**.
- Connecting from a computer **ends the device's pairing with the manufacturer's
  mobile app**. You will have to pair it again in that app afterwards.
- This software deliberately sends only a short allowlist of read and
  session-toggle commands. It **cannot** erase the device's storage, reboot it,
  change its stored configuration, or write firmware. That is a safeguard taken in
  good faith, not a guarantee of any outcome.

## Not a medical device

This is **not a medical device** and is not certified, cleared or approved by any
regulator. Nothing it produces is a diagnosis, a treatment recommendation, or
medical advice. Beat-to-beat intervals here come from an optical pulse sensor
(pulse-rate variability), which is not an ECG. **Do not use this software to make
any health or treatment decision.** If you have a health concern, consult a
qualified clinician.

## Your data

This software does not transmit your measurements anywhere. Readings stay on the
device that recorded them. The authors never receive, see, store or have any access
to them, and provide no backup — if you clear your browser data or lose the device,
the readings are gone. Export them if you want to keep them.

## If you are WHOOP, or anyone with a concern

This project is offered in good faith and is not intended to harm WHOOP's business,
confuse anyone about who makes it, or help anyone avoid paying for their service.

If you believe something here infringes your rights or misrepresents your product,
**please open an issue or contact the maintainer directly and we will engage with
you promptly.** We would rather fix or remove something than argue about it, and
requests to clarify wording, change naming, or take down specific material will be
taken seriously and acted on quickly.

## Not legal advice

The authors are not lawyers. This document is not legal advice, and the statutory
provisions referred to above are cited for context rather than as a legal opinion.
If you intend to rely on any of them, take your own advice.
