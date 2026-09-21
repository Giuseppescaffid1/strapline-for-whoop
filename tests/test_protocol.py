import pytest

from whoopble import protocol as p

# Frames captured off a real WHOOP 4.0 with a BLE sniffer (bWanShiTong, rusheelraj writeups).
CAPTURED = [
    (0x08, p.Cmd.SET_GENERIC_HR_PROFILE, b"\x01", "aa0800a823080e016c935474"),
    (0x07, p.Cmd.SET_GENERIC_HR_PROFILE, b"\x00", "aa0800a823070e00c7e40f08"),
    (0x8C, p.Cmd.TOGGLE_REALTIME_HR, b"\x01", "aa0800a8238c03017d5ec627"),
    (0x8D, p.Cmd.TOGGLE_REALTIME_HR, b"\x00", "aa0800a8238d0300dc040351"),
    (0x6D, 0x42, bytes.fromhex("01d036656600000000"), "aa100057236d4201d036656600000000f62deb81"),
]


@pytest.mark.parametrize("seq,opcode,payload,expected", CAPTURED)
def test_encode_matches_captured_frames(seq, opcode, payload, expected):
    assert p.encode_command(seq, opcode, payload).hex() == expected


@pytest.mark.parametrize("seq,opcode,payload,expected", CAPTURED)
def test_parse_roundtrip(seq, opcode, payload, expected):
    f = p.parse_frame(bytes.fromhex(expected))
    assert f.packet_type == p.PacketType.COMMAND
    assert f.seq == seq
    assert f.inner[2] == opcode
    assert f.inner[3 : 3 + len(payload)] == payload


def test_padding_to_4_bytes_is_part_of_crc():
    short = p.encode_command(0x6D, 0x42, bytes.fromhex("01d0366566000000"))
    assert short.hex() == CAPTURED[-1][3]


def test_hello_frame_shape():
    f = p.parse_frame(p.encode_command(0, p.Cmd.GET_HELLO_HARVARD, b"\x00"))
    assert f.inner == bytes([0x23, 0x00, 0x23, 0x00])


@pytest.mark.parametrize("bad", ["ab0800a823080e016c935474", "aa0800a923080e016c935474", "aa0800a823080e016c935475"])
def test_parse_rejects_corruption(bad):
    with pytest.raises(p.FrameError):
        p.parse_frame(bytes.fromhex(bad))


def test_reassembler_handles_splits_and_0xaa_in_payload():
    frame = p.encode_command(1, p.Cmd.SET_GENERIC_HR_PROFILE, b"\xaa\xaa\x01")
    r = p.FrameReassembler()
    assert r.feed(frame[:3]) == []
    assert r.feed(frame[3:8]) == []
    out = r.feed(frame[8:] + frame)
    assert [f.raw for f in out] == [frame, frame]
    assert r.dropped == 0


def test_reassembler_resyncs_after_garbage():
    frame = p.encode_command(2, p.Cmd.GET_BATTERY_LEVEL)
    r = p.FrameReassembler()
    out = r.feed(b"\x01\x02\xaa\x09" + frame)
    assert [f.raw for f in out] == [frame]
    assert r.dropped > 0


def test_decode_response_and_battery():
    inner = bytes([p.PacketType.COMMAND_RESPONSE, 0x05, p.Cmd.GET_BATTERY_LEVEL, 0x03, 0x01, 0xF4, 0x01])
    f = p.parse_frame(p.build_frame(inner))
    resp = p.decode_response(f)
    assert (resp.opcode, resp.echoed_seq, resp.status_name, resp.ok) == (0x1A, 3, "ok", True)
    assert p.decode_battery(resp) == 50.0


# Actual frames received from strap "WHOOP 4C2430132" on 2026-09-21.
HELLO_RESPONSE = (
    "aa8c004a2400230001049e03000000eee7e20108550000344332343330313332003865323738326237346634303238346333"
    "663437363138623839323539323039666539626439626538313734383465623231333963390600000002000000100000002900"
    "00001100000006000000000000000806000100000000001100000002000000020000000000000091b2e7d0"
)
BATTERY_RESPONSE = "aa10005724011a01019e0300000000001b835273"
EVENT_23 = "aa10005730ed1700eee7e20160540000c6c90d20"


def test_real_hello_response():
    resp = p.decode_response(p.parse_frame(bytes.fromhex(HELLO_RESPONSE)))
    assert (resp.opcode, resp.echoed_seq, resp.ok) == (p.Cmd.GET_HELLO_HARVARD, 0, True)
    h = p.decode_hello(resp)
    assert h.battery_pct == 92.6
    assert h.device_clock == 31647726
    assert h.serial == "4C2430132"
    assert h.firmware_commit.startswith("8e2782b74f40284c")


def test_real_battery_response():
    resp = p.decode_response(p.parse_frame(bytes.fromhex(BATTERY_RESPONSE)))
    assert (resp.opcode, resp.echoed_seq, resp.ok) == (p.Cmd.GET_BATTERY_LEVEL, 1, True)
    assert p.decode_battery(resp) == 92.6


def test_real_event_frame():
    ev = p.decode_event(p.parse_frame(bytes.fromhex(EVENT_23)))
    assert (ev.event_id, ev.timestamp, ev.body) == (23, 31647726, b"")


def test_decode_realtime_hr():
    inner = bytearray(20)
    inner[0] = p.PacketType.REALTIME_DATA
    inner[2:6] = (1_700_000_000).to_bytes(4, "little")
    inner[8] = 61
    inner[9] = 2
    inner[10:12] = (952).to_bytes(2, "little")
    inner[12:14] = (9999).to_bytes(2, "little")  # out of range, must be dropped
    inner[18] = 1
    rt = p.decode_realtime_hr(p.parse_frame(p.build_frame(bytes(inner))))
    assert (rt.timestamp, rt.heart_rate, rt.rr_intervals_ms, rt.wearing) == (1_700_000_000, 61, (952,), 1)


def test_decode_std_hr_measurement():
    m = p.decode_std_hr_measurement(bytes([0x16, 72, 0x00, 0x04, 0x00, 0x02]))
    assert (m.heart_rate, m.rr_intervals_ms, m.sensor_contact) == (72, (1000, 500), True)
    m16 = p.decode_std_hr_measurement(bytes([0x01, 0x2C, 0x01]))
    assert (m16.heart_rate, m16.rr_intervals_ms, m16.sensor_contact) == (300, (), None)


def test_decode_event():
    inner = (
        bytes([p.PacketType.EVENT, 0])
        + (9).to_bytes(2, "little")
        + (1_700_000_000).to_bytes(4, "little")
        + bytes(2)  # sub-second timestamp
        + (1).to_bytes(2, "little")  # body length
        + b"\x01"
    )
    ev = p.decode_event(p.parse_frame(p.build_frame(inner)))
    assert len(ev.body) == 1, "frame padding must not leak into the event body"
    assert (ev.name, ev.timestamp, ev.body) == ("wrist_on", 1_700_000_000, b"\x01")
