"""Command-line entry point: scan, hello, stream, serve."""

from __future__ import annotations

import argparse
import asyncio
import csv
import datetime as dt
import logging
import math
import os
import random
import sys
import time

from . import protocol as p

log = logging.getLogger("whoopble")


async def cmd_scan(a: argparse.Namespace) -> int:
    from .client import scan

    print(f"Scanning for {a.timeout:.0f}s...")
    devices = await scan(a.timeout)
    if not devices:
        print("No WHOOP found.")
        return 1
    for device, rssi in devices:
        print(f"  {device.name or '?':20} {device.address}  RSSI={rssi}")
    return 0


async def cmd_hello(a: argparse.Namespace) -> int:
    from .client import WhoopClient

    async with WhoopClient(a.address, a.raw_log) as w:
        resp = await w.hello()
        print(f"hello: status={resp.status_name}")
        for k, v in vars(p.decode_hello(resp)).items():
            print(f"  {k}: {v}")
        print(f"battery (GET_BATTERY_LEVEL): {await w.battery():.1f}%")
    return 0


async def cmd_stream(a: argparse.Namespace) -> int:
    from .client import WhoopClient

    async with WhoopClient(a.address, a.raw_log) as w:
        resp = await w.hello()
        print(f"hello: {resp.status_name}   battery: {await w.battery():.1f}%")
        if a.std:
            print(f"standard HR profile (0x0E): {(await w.set_generic_hr_profile(True)).status_name}")
        if a.realtime:
            print(f"realtime HR stream (0x03): {(await w.toggle_realtime_hr(True)).status_name}")

        deadline = time.monotonic() + a.seconds if a.seconds else None
        n = 0
        with open(a.output or os.devnull, "w", newline="") as out:
            writer = csv.writer(out) if a.output else None
            if writer:
                writer.writerow(
                    ["host_time", "source", "heart_rate_bpm", "rr_intervals_ms", "device_timestamp", "wearing"]
                )
            try:
                while deadline is None or time.monotonic() < deadline:
                    s = await w.next_sample(timeout=1.0)
                    if s is None:
                        continue
                    n += 1
                    rr = ";".join(map(str, s.rr_intervals_ms))
                    ts = dt.datetime.fromtimestamp(s.host_time).isoformat(timespec="milliseconds")
                    extra = f"  dev_ts={s.device_timestamp}" if s.device_timestamp else ""
                    print(f"{ts} [{s.source:8}] HR={s.heart_rate:3d} bpm  RR={rr or '-'} ms{extra}")
                    if writer:
                        wearing = "" if s.wearing is None else s.wearing
                        writer.writerow([ts, s.source, s.heart_rate, rr, s.device_timestamp or "", wearing])
                        out.flush()
                    if a.count and n >= a.count:
                        break
            except asyncio.CancelledError:
                pass
            finally:
                for name, stop in (("realtime", w.toggle_realtime_hr), ("std", w.set_generic_hr_profile)):
                    if getattr(a, name) and w.is_connected:
                        try:
                            await stop(False)
                        except Exception as exc:  # noqa: BLE001 - best-effort shutdown
                            log.warning("could not stop %s stream: %s", name, exc)
        if a.output:
            print(f"wrote {n} samples to {a.output}")
    return 0


async def cmd_serve(a: argparse.Namespace) -> int:
    from .server import MetricsHub, start_server

    hub = MetricsHub()
    httpd = start_server(hub, a.port)
    print(f"Dashboard: http://localhost:{a.port}   (Ctrl+C to stop)")
    try:
        if a.demo:
            await _demo_feed(hub)
        else:
            await _strap_feed(hub, a)
    finally:
        httpd.shutdown()
    return 0


async def _strap_feed(hub, a: argparse.Namespace) -> None:
    from .client import WhoopClient

    async with WhoopClient(a.address, a.raw_log) as w:
        hello = p.decode_hello(await w.hello())
        battery = await w.battery()
        hub.set_status(connected=True, device="WHOOP 4.0", serial=hello.serial, battery_pct=battery)
        print(f"connected: serial {hello.serial}, battery {battery:.1f}%")
        if a.std:
            await w.set_generic_hr_profile(True)
        if a.realtime:
            await w.toggle_realtime_hr(True)
        next_battery = time.monotonic() + 60
        try:
            while True:
                s = await w.next_sample(timeout=1.0)
                if s is not None:
                    hub.push(s.host_time, s.heart_rate, s.rr_intervals_ms, s.wearing, s.source)
                if time.monotonic() >= next_battery:
                    next_battery = time.monotonic() + 60
                    try:
                        hub.set_status(battery_pct=await w.battery())
                    except Exception as exc:  # noqa: BLE001 - keep streaming
                        log.warning("battery refresh failed: %s", exc)
                if not w.is_connected:
                    hub.set_status(connected=False)
                    print("strap disconnected")
                    break
        except asyncio.CancelledError:
            pass
        finally:
            hub.set_status(connected=False)
            for name, stop in (("realtime", w.toggle_realtime_hr), ("std", w.set_generic_hr_profile)):
                if getattr(a, name) and w.is_connected:
                    try:
                        await stop(False)
                    except Exception as exc:  # noqa: BLE001 - best-effort shutdown
                        log.warning("could not stop %s stream: %s", name, exc)


async def _demo_feed(hub) -> None:
    """Synthetic 1 Hz heart rate so the dashboard can be exercised without a strap."""
    hub.set_status(connected=True, device="demo strap", serial="DEMO", battery_pct=87.0)
    t0 = time.time()
    try:
        while True:
            t = time.time()
            bpm = int(round(64 + 9 * math.sin((t - t0) / 40) + random.gauss(0, 1.2)))
            base = 60000 / bpm
            rr = [int(base + random.gauss(0, 18)) for _ in range(random.choice((0, 1, 1, 2)))]
            hub.push(t, bpm, rr, wearing=1, source="demo")
            await asyncio.sleep(1.0)
    except asyncio.CancelledError:
        pass


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="whoopble", description="WHOOP 4.0 BLE client")
    ap.add_argument("-v", "--verbose", action="store_true", help="debug logging (shows every frame)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("scan", help="find nearby WHOOP straps")
    sp.add_argument("--timeout", type=float, default=10.0)
    sp.set_defaults(fn=cmd_scan)

    def add_conn_args(parser: argparse.ArgumentParser) -> None:
        parser.add_argument("-a", "--address", default=os.environ.get("WHOOP_ADDRESS"),
                            help="device address/UUID (or set WHOOP_ADDRESS)")
        parser.add_argument("--raw-log", help="append every notification as JSONL to this file")

    sp = sub.add_parser("hello", help="handshake + battery")
    add_conn_args(sp)
    sp.set_defaults(fn=cmd_hello)

    sp = sub.add_parser("stream", help="stream live heart rate")
    add_conn_args(sp)
    sp.add_argument("-s", "--seconds", type=float, default=30.0, help="duration (0 = until Ctrl+C)")
    sp.add_argument("-n", "--count", type=int, default=0, help="stop after N samples")
    sp.add_argument("-o", "--output", help="CSV output path")
    sp.add_argument("--std", action=argparse.BooleanOptionalAction, default=True,
                    help="enable the standard 0x2A37 Heart Rate characteristic")
    sp.add_argument("--realtime", action=argparse.BooleanOptionalAction, default=True,
                    help="enable the proprietary 0x28 realtime stream")
    sp.set_defaults(fn=cmd_stream)

    sp = sub.add_parser("serve", help="localhost dashboard with live metrics")
    add_conn_args(sp)
    sp.add_argument("-p", "--port", type=int, default=8765)
    sp.add_argument("--demo", action="store_true", help="synthetic data, no Bluetooth")
    sp.add_argument("--std", action=argparse.BooleanOptionalAction, default=True,
                    help="enable the standard 0x2A37 Heart Rate characteristic")
    sp.add_argument("--realtime", action=argparse.BooleanOptionalAction, default=True,
                    help="enable the proprietary 0x28 realtime stream")
    sp.set_defaults(fn=cmd_serve)

    a = ap.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    if a.cmd != "scan" and not getattr(a, "demo", False) and not a.address:
        ap.error("--address is required (or set WHOOP_ADDRESS)")
    try:
        return asyncio.run(a.fn(a))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
