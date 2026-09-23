#!/usr/bin/env python3
"""Validate shipped archives, not just dist directories. Extract native smoke binary."""
import hashlib
import pathlib
import platform
import sys
import tarfile
import zipfile

root = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
required = {f"sente-{os}-{arch}.tar.gz" for os in ("darwin", "linux") for arch in ("arm64", "x64", "x64-baseline")}
required |= {f"sente-linux-{arch}-musl.tar.gz" for arch in ("arm64", "x64", "x64-baseline")}
required |= {f"sente-windows-{arch}.zip" for arch in ("arm64", "x64", "x64-baseline")}
manifest = {}
for line in (root / "SHA256SUMS.txt").read_text().splitlines():
    digest, name = line.split()
    assert name not in manifest, "duplicate manifest entry"
    manifest[name] = digest
assert set(manifest) == required, "wrong platform formats or missing assets"
assert {p.name for p in root.iterdir()} == required | {"SHA256SUMS.txt"}, "unexpected assets"
native_os = "darwin" if sys.platform == "darwin" else "linux"
native_arch = "arm64" if platform.machine() in ("arm64", "aarch64") else "x64-baseline"
native = f"sente-{native_os}-{native_arch}.tar.gz"
output.mkdir(parents=True, exist_ok=True)
for name in sorted(required):
    archive = root / name
    with archive.open("rb") as stream:
        assert hashlib.file_digest(stream, "sha256").hexdigest() == manifest[name], name + " checksum mismatch"
    if name.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            members = [m for m in z.infolist() if not m.is_dir()]
            assert len(members) == 1 and members[0].filename.removeprefix("./") == "sente.exe", name
            assert z.read(members[0])[:2] == b"MZ", name + " invalid executable"
    else:
        with tarfile.open(archive) as tar:
            members = [m for m in tar.getmembers() if not m.isdir()]
            assert len(members) == 1, name
            member = members[0]
            assert member.isfile() and member.name.removeprefix("./") == "sente" and member.mode & 0o111, name
            binary = tar.extractfile(member).read()
            assert binary[:4] in (b"\x7fELF", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"), name
            if name == native:
                (output / "sente").write_bytes(binary)
                (output / "sente").chmod(0o755)
print("PASS: 12 archives, formats, executable layout and SHA256; native extracted")
