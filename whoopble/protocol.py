"""WHOOP 4.0 BLE protocol: GATT map, framing, checksums and packet codecs.

Pure functions only; nothing here touches Bluetooth, so it is fully unit-testable.
Layout sources: OpenStrap/protocol (constants, framing, live, control) and the
sniffer captures in bWanShiTong/reverse-engineering-whoop-post.
"""

from __future__ import annotations

import re
import zlib
from dataclasses import dataclass

SERVICE_UUID = "61080001-8d6d-82b8-614a-1c8cb0f8dcc6"
CHAR_CMD_TO_STRAP = "61080002-8d6d-82b8-614a-1c8cb0f8dcc6"
CHAR_CMD_FROM_STRAP = "61080003-8d6d-82b8-614a-1c8cb0f8dcc6"
CHAR_EVENTS_FROM_STRAP = "61080004-8d6d-82b8-614a-1c8cb0f8dcc6"
CHAR_DATA_FROM_STRAP = "61080005-8d6d-82b8-614a-1c8cb0f8dcc6"
CHAR_MEMFAULT = "61080007-8d6d-82b8-614a-1c8cb0f8dcc6"
WHOOP_NOTIFY_CHARS = (
    CHAR_CMD_FROM_STRAP,
    CHAR_EVENTS_FROM_STRAP,
    CHAR_DATA_FROM_STRAP,
)

CHAR_STD_HR_MEASUREMENT = "00002a37-0000-1000-8000-00805f9b34fb"
CHAR_STD_BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb"

SOF = 0xAA
HEADER_LEN = 4
CRC32_LEN = 4


class PacketType:
    COMMAND = 0x23
    COMMAND_RESPONSE = 0x24
    REALTIME_DATA = 0x28
    REALTIME_RAW_DATA = 0x2B
    HISTORICAL_DATA = 0x2F
    EVENT = 0x30
    METADATA = 0x31
    CONSOLE_LOGS = 0x32
    REALTIME_IMU_STREAM = 0x33


class Cmd:
    TOGGLE_REALTIME_HR = 0x03
    SET_CLOCK = 0x0A
    GET_CLOCK = 0x0B
    SET_GENERIC_HR_PROFILE = 0x0E
    SEND_HISTORICAL_DATA = 0x16
    HISTORICAL_DATA_RESULT = 0x17
    GET_BATTERY_LEVEL = 0x1A
    GET_DATA_RANGE = 0x22
    GET_HELLO_HARVARD = 0x23
    GET_ADVERTISING_NAME = 0x4C
    RUN_HAPTICS_PATTERN = 0x4F


STATUS_NAMES = {0: "failed", 1: "ok", 2: "deferred", 3: "unsupported"}

EVENT_NAMES = {
    3: "battery_level",
    7: "charging_on",
    8: "charging_off",
    9: "wrist_on",
    10: "wrist_off",
    13: "rtc_lost",
    14: "double_tap",
    15: "boot",
    16: "set_rtc",
    21: "battery_pack_connected",
    22: "battery_pack_removed",
    31: "ble_bonded",
}


class FrameError(ValueError):
    pass


def crc8(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def pad4(data: bytes) -> bytes:
    return data + b"\x00" * (-len(data) % 4)


def build_frame(inner: bytes) -> bytes:
    body = pad4(inner)
    size = len(body) + CRC32_LEN
    header = bytes([SOF]) + size.to_bytes(2, "little")
    header += bytes([crc8(header[1:3])])
    return header + body + zlib.crc32(body).to_bytes(4, "little")


def encode_command(seq: int, opcode: int, payload: bytes = b"") -> bytes:
    return build_frame(bytes([PacketType.COMMAND, seq & 0xFF, opcode & 0xFF]) + bytes(payload))


@dataclass(frozen=True)
class Frame:
    packet_type: int
    seq: int
    inner: bytes
    raw: bytes


def parse_frame(raw: bytes) -> Frame:
    if len(raw) < HEADER_LEN + CRC32_LEN:
        raise FrameError(f"frame too short ({len(raw)} bytes)")
    if raw[0] != SOF:
        raise FrameError(f"bad SOF 0x{raw[0]:02X}")
    if crc8(raw[1:3]) != raw[3]:
        raise FrameError("header CRC-8 mismatch")
    size = int.from_bytes(raw[1:3], "little")
    if len(raw) != HEADER_LEN + size:
        raise FrameError(f"length mismatch: header says {size}, got {len(raw) - HEADER_LEN}")
    body = raw[HEADER_LEN:-CRC32_LEN]
    if zlib.crc32(body) != int.from_bytes(raw[-CRC32_LEN:], "little"):
        raise FrameError("CRC-32 mismatch")
    return Frame(packet_type=body[0], seq=body[1], inner=bytes(body), raw=bytes(raw))


class FrameReassembler:
    """Length-based reassembly of frames split across BLE notifications."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self.dropped = 0

    def feed(self, chunk: bytes) -> list[Frame]:
        self._buf += chunk
        frames: list[Frame] = []
        while len(self._buf) >= HEADER_LEN:
            # Never resync on 0xAA alone: sensor payloads contain it and MTU splits land on it.
            if self._buf[0] != SOF or crc8(self._buf[1:3]) != self._buf[3]:
                del self._buf[0]
                self.dropped += 1
                continue
            total = HEADER_LEN + int.from_bytes(self._buf[1:3], "little")
            if len(self._buf) < total:
                break
            raw = bytes(self._buf[:total])
            del self._buf[:total]
            try:
                frames.append(parse_frame(raw))
            except FrameError:
                self.dropped += 1
        return frames


@dataclass(frozen=True)
class CommandResponse:
    opcode: int
    echoed_seq: int
    status: int
    payload: bytes

    @property
    def ok(self) -> bool:
        return self.status == 1

    @property
    def status_name(self) -> str:
        return STATUS_NAMES.get(self.status, f"unknown({self.status})")


def decode_response(frame: Frame) -> CommandResponse:
    if frame.packet_type != PacketType.COMMAND_RESPONSE:
        raise FrameError(f"not a command response (type 0x{frame.packet_type:02X})")
    i = frame.inner
    if len(i) < 5:
        raise FrameError("response too short")
    return CommandResponse(opcode=i[2], echoed_seq=i[3], status=i[4], payload=bytes(i[5:]))


def decode_battery(resp: CommandResponse) -> float:
    if len(resp.payload) < 2:
        raise FrameError("battery payload too short")
    return int.from_bytes(resp.payload[0:2], "little") / 10


@dataclass(frozen=True)
class Hello:
    battery_pct: float
    device_clock: int
    serial: str
    firmware_commit: str
    payload_hex: str


def decode_hello(resp: CommandResponse) -> Hello:
    """GET_HELLO_HARVARD reply, layout observed on a WHOOP 4.0 (see tests)."""
    pl = resp.payload
    if len(pl) < 15:
        raise FrameError("hello payload too short")
    strings = [s.decode("ascii", "replace") for s in pl[14:].split(b"\x00")]
    commit = strings[1] if len(strings) > 1 and re.fullmatch(r"[0-9a-f]{16,}", strings[1]) else ""
    return Hello(
        battery_pct=int.from_bytes(pl[1:3], "little") / 10,
        device_clock=int.from_bytes(pl[6:10], "little"),
        serial=strings[0],
        firmware_commit=commit,
        payload_hex=pl.hex(),
    )


@dataclass(frozen=True)
class RealtimeHr:
    timestamp: int
    heart_rate: int
    rr_intervals_ms: tuple[int, ...]
    wearing: int | None


def decode_realtime_hr(frame: Frame) -> RealtimeHr:
    i = frame.inner
    if len(i) < 10:
        raise FrameError("realtime frame too short")
    rr: list[int] = []
    for k in range(min(i[9], 4)):
        off = 10 + 2 * k
        if off + 2 > len(i):
            break
        v = int.from_bytes(i[off : off + 2], "little", signed=True)
        if 200 <= v <= 2500:
            rr.append(v)
    return RealtimeHr(
        timestamp=int.from_bytes(i[2:6], "little"),
        heart_rate=i[8],
        rr_intervals_ms=tuple(rr),
        wearing=i[18] if len(i) > 18 else None,
    )


@dataclass(frozen=True)
class StdHrMeasurement:
    heart_rate: int
    rr_intervals_ms: tuple[int, ...]
    sensor_contact: bool | None


def decode_std_hr_measurement(data: bytes) -> StdHrMeasurement:
    """Bluetooth SIG Heart Rate Measurement (0x2A37) characteristic value."""
    flags = data[0]
    if flags & 0x01:
        hr, idx = int.from_bytes(data[1:3], "little"), 3
    else:
        hr, idx = data[1], 2
    contact = bool(flags & 0x02) if flags & 0x04 else None
    if flags & 0x08:
        idx += 2
    rr: list[int] = []
    if flags & 0x10:
        while idx + 2 <= len(data):
            rr.append(round(int.from_bytes(data[idx : idx + 2], "little") * 1000 / 1024))
            idx += 2
    return StdHrMeasurement(hr, tuple(rr), contact)


@dataclass(frozen=True)
class Event:
    event_id: int
    name: str
    timestamp: int
    body: bytes


def decode_event(frame: Frame) -> Event:
    i = frame.inner
    if len(i) < 12:
        raise FrameError("event frame too short")
    eid = int.from_bytes(i[2:4], "little")
    body_len = int.from_bytes(i[10:12], "little")
    return Event(
        event_id=eid,
        name=EVENT_NAMES.get(eid, f"event_{eid}"),
        timestamp=int.from_bytes(i[4:8], "little"),
        body=bytes(i[12 : 12 + body_len]),
    )
