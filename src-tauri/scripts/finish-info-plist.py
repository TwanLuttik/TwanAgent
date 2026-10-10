#!/usr/bin/env python3
"""Close a truncated __TEXT,__info_plist section in a Mach-O binary.

Tauri's macOS dev embed stops before the final '>' of </plist>.
TCC then ignores NSMicrophoneUsageDescription and aborts the process.
"""
import struct
import sys

MH_MAGIC_64 = 0xFEEDFACF
LC_SEGMENT_64 = 0x19


def main() -> int:
    path = sys.argv[1]
    data = bytearray(open(path, "rb").read())
    if len(data) < 32 or struct.unpack_from("<I", data, 0)[0] != MH_MAGIC_64:
        return 0
    ncmds = struct.unpack_from("<I", data, 16)[0]
    offset = 32
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from("<II", data, offset)
        if cmd == LC_SEGMENT_64 and data[offset + 8 : offset + 14] == b"__TEXT":
            nsects = struct.unpack_from("<I", data, offset + 64)[0]
            sect = offset + 72
            for _section in range(nsects):
                name = data[sect : sect + 16].split(b"\0", 1)[0]
                print(f"section {name!r}")
                if name == b"__info_plist":
                    return close_section(path, data, sect)
                sect += 80
        offset += cmdsize
    return 0


def close_section(path: str, data: bytearray, sect: int) -> int:
    size = struct.unpack_from("<Q", data, sect + 40)[0]
    fileoff = struct.unpack_from("<I", data, sect + 48)[0]
    blob = bytes(data[fileoff : fileoff + size])
    print(f"size={size} off={fileoff} tail={blob[-20:]!r} mic={b'NSMicrophoneUsageDescription' in blob}")
    if b"NSMicrophoneUsageDescription" not in blob:
        return 0
    text = blob.rstrip(b"\0")
    mic = b"NSMicrophoneUsageDescription"
    if not text.startswith(b"<?xml") or mic not in text:
        print("missing microphone key", file=sys.stderr)
        return 1
    # The embedded section is readable one byte short, which drops the final
    # '>'. Move the microphone key to the front so that short read still
    # contains it, and keep the document closed inside `size`.
    if text.find(mic) < 180 and text.endswith(b"</plist>"):
        print("microphone key already leads")
        return 0
    import plistlib
    try:
        doc = plistlib.loads(text if text.endswith(b">") else text + b">")
    except Exception as err:
        print(f"could not parse embedded plist: {err}", file=sys.stderr)
        return 1
    reason = doc.get(mic.decode())
    if not isinstance(reason, str) or not reason:
        print("microphone usage text missing", file=sys.stderr)
        return 1
    ordered = {mic.decode(): reason}
    for key, value in doc.items():
        if key != mic.decode():
            ordered[key] = value
    text = plistlib.dumps(ordered, fmt=plistlib.FMT_XML)
    if not text.endswith(b"\n"):
        text += b"\n"
    if len(text) > size:
        print(f"closed Info.plist does not fit ({len(text)} > {size})", file=sys.stderr)
        return 1
    padded = text + b"\0" * (size - len(text))
    data[fileoff : fileoff + size] = padded
    open(path, "wb").write(data)
    print(f"closed Info.plist in {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
