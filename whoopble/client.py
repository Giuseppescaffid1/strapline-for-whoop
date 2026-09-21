"""Async BLE transport for the WHOOP 4.0, built on bleak."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic

from . import protocol as p

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Sample:
    source: str  # "realtime" = proprietary 0x28 stream, "std" = SIG 0x2A37 characteristic
    host_time: float
    heart_rate: int
    rr_intervals_ms: tuple[int, ...]
    device_timestamp: int | None = None
    wearing: int | None = None


async def scan(timeout: float = 10.0):
    found: dict[str, tuple[object, int | None]] = {}

    def on_detect(device, adv) -> None:
        name = adv.local_name or device.name or ""
        advertised = [s.lower() for s in adv.service_uuids]
        if name.upper().startswith("WHOOP") or p.SERVICE_UUID in advertised:
            found[device.address] = (device, adv.rssi)

    async with BleakScanner(detection_callback=on_detect):
        await asyncio.sleep(timeout)
    return sorted(found.values(), key=lambda t: t[1] if t[1] is not None else -999, reverse=True)


class WhoopClient:
    def __init__(self, address: str, raw_log_path: str | None = None, response_timeout: float = 5.0):
        self._address = address
        self._client: BleakClient | None = None
        self._reassemblers: dict[str, p.FrameReassembler] = {}
        self._pending: dict[int, asyncio.Future[p.CommandResponse]] = {}
        self._samples: asyncio.Queue[Sample] = asyncio.Queue()
        self._seq = 0
        self._response_timeout = response_timeout
        self._raw_log = open(raw_log_path, "a") if raw_log_path else None  # noqa: SIM115 closed in disconnect()

    async def __aenter__(self) -> WhoopClient:
        await self.connect()
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.disconnect()

    async def connect(self) -> None:
        self._client = BleakClient(self._address, timeout=20.0)
        await self._client.connect()
        log.info("Connected to %s (MTU %d)", self._address, self._client.mtu_size)
        for uuid in p.WHOOP_NOTIFY_CHARS:
            self._reassemblers[uuid] = p.FrameReassembler()
            await self._client.start_notify(uuid, self._on_whoop_notify)
        # 0x...0007 carries unframed firmware text logs; keep them for the raw log only.
        await self._client.start_notify(p.CHAR_MEMFAULT, self._on_memfault_notify)
        await self._client.start_notify(p.CHAR_STD_HR_MEASUREMENT, self._on_std_hr_notify)

    async def disconnect(self) -> None:
        if self._client and self._client.is_connected:
            await self._client.disconnect()
            log.info("Disconnected")
        if self._raw_log:
            self._raw_log.close()
            self._raw_log = None

    @property
    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    # -- commands -----------------------------------------------------------

    async def send(self, opcode: int, payload: bytes = b"") -> p.CommandResponse:
        assert self._client is not None
        seq = self._seq
        self._seq = (self._seq + 1) & 0xFF
        frame = p.encode_command(seq, opcode, payload)
        fut: asyncio.Future[p.CommandResponse] = asyncio.get_running_loop().create_future()
        self._pending[seq] = fut
        log.debug("-> cmd 0x%02X seq=%d %s", opcode, seq, frame.hex())
        await self._client.write_gatt_char(p.CHAR_CMD_TO_STRAP, frame, response=True)
        try:
            resp = await asyncio.wait_for(fut, self._response_timeout)
        except asyncio.TimeoutError:
            self._pending.pop(seq, None)
            raise TimeoutError(
                f"no response to command 0x{opcode:02X} (seq {seq}) within {self._response_timeout}s"
            ) from None
        log.debug("<- resp 0x%02X status=%s payload=%s", resp.opcode, resp.status_name, resp.payload.hex())
        return resp

    async def hello(self) -> p.CommandResponse:
        return await self.send(p.Cmd.GET_HELLO_HARVARD, b"\x00")

    async def battery(self) -> float:
        return p.decode_battery(await self.send(p.Cmd.GET_BATTERY_LEVEL))

    async def set_generic_hr_profile(self, on: bool) -> p.CommandResponse:
        return await self.send(p.Cmd.SET_GENERIC_HR_PROFILE, bytes([1 if on else 0]))

    async def toggle_realtime_hr(self, on: bool) -> p.CommandResponse:
        return await self.send(p.Cmd.TOGGLE_REALTIME_HR, bytes([1 if on else 0]))

    async def next_sample(self, timeout: float | None = None) -> Sample | None:
        try:
            return await asyncio.wait_for(self._samples.get(), timeout)
        except asyncio.TimeoutError:
            return None

    # -- notification plumbing ---------------------------------------------

    def _on_whoop_notify(self, char: BleakGATTCharacteristic, data: bytearray) -> None:
        uuid = char.uuid.lower()
        self._log_raw(uuid, bytes(data))
        for frame in self._reassemblers[uuid].feed(bytes(data)):
            self._dispatch(uuid, frame)

    def _on_memfault_notify(self, char: BleakGATTCharacteristic, data: bytearray) -> None:
        self._log_raw(char.uuid.lower(), bytes(data))

    def _on_std_hr_notify(self, char: BleakGATTCharacteristic, data: bytearray) -> None:
        self._log_raw(char.uuid.lower(), bytes(data))
        m = p.decode_std_hr_measurement(bytes(data))
        self._samples.put_nowait(Sample("std", time.time(), m.heart_rate, m.rr_intervals_ms))

    def _dispatch(self, uuid: str, frame: p.Frame) -> None:
        t = frame.packet_type
        if t == p.PacketType.COMMAND_RESPONSE:
            resp = p.decode_response(frame)
            fut = self._pending.pop(resp.echoed_seq, None) or self._pending.pop(frame.seq, None)
            if fut is None and len(self._pending) == 1:
                fut = self._pending.pop(next(iter(self._pending)))
            if fut is not None and not fut.done():
                fut.set_result(resp)
            else:
                log.debug("unmatched response opcode=0x%02X seq=%d", resp.opcode, resp.echoed_seq)
        elif t == p.PacketType.REALTIME_DATA:
            try:
                rt = p.decode_realtime_hr(frame)
            except p.FrameError as exc:
                log.debug("undecodable realtime frame (%s): %s", exc, frame.inner.hex())
                return
            self._samples.put_nowait(
                Sample("realtime", time.time(), rt.heart_rate, rt.rr_intervals_ms, rt.timestamp, rt.wearing)
            )
        elif t == p.PacketType.EVENT:
            try:
                ev = p.decode_event(frame)
                log.info("event %s ts=%d body=%s", ev.name, ev.timestamp, ev.body.hex())
            except p.FrameError:
                log.debug("short event frame: %s", frame.inner.hex())
        else:
            log.debug("frame type=0x%02X on ...%s: %s", t, uuid[4:8], frame.inner.hex())

    def _log_raw(self, uuid: str, data: bytes) -> None:
        if self._raw_log:
            self._raw_log.write(json.dumps({"t": time.time(), "char": uuid, "hex": data.hex()}) + "\n")
