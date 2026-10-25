"""Regenerate notices from the exact verified restricted helper binaries.

This maintenance tool is not run at install or runtime. It uses only Python's
standard library, and validates module zip content with Go's documented h1
directory hash against the checksum embedded in the pinned executable.
"""
import argparse
import base64
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import re
import urllib.parse
import urllib.request
import zipfile

EXPECTED = {
    "win32-x64": ("win32-x64/cloudflared.exe", "9d23f8b8bee69f4db958a59e44480a9d49242e1e50264ecb1de49428639ee360"),
    "linux-x64": ("linux-x64/cloudflared", "7e0373c8786337d2babc809cf0e5ce8ab365c12782dfab89299271a34f83c694"),
    "linux-arm64": ("linux-arm64/cloudflared", "6b5693dcbf0d712cff5657eb97fe68e484bbcfe4bfa2efff336ac49777472f55"),
    "darwin-x64": ("darwin-x64/cloudflared", "14e9b5dd552cbe488207010232298b78e3bcbd846740cc5ac002c1df5f2a2efb"),
    "darwin-arm64": ("darwin-arm64/cloudflared", "873c1903c21639879653cdc5a9c2dd8dfd06f0571daf518ae45950512d819930"),
}
LICENSE_NAME = re.compile(r"^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$", re.I)


def download(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        body = response.read(128 * 1024 * 1024 + 1)
        if len(body) > 128 * 1024 * 1024:
            raise ValueError("Source archive exceeds the maintenance budget")
        return body


def escaped(value):
    return "".join("!" + c.lower() if c.isupper() else c for c in value)


def binary_modules(root):
    modules = {}
    identities = []
    for target, (name, expected) in EXPECTED.items():
        data = (root / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("The helper is not the pinned restricted build: " + target)
        build_header = data.find(b"\xff Go buildinf:")
        if build_header < 0 or data[build_header + 15] & 2 == 0:
            raise ValueError("Unsupported Go build information format: " + target)
        version_start = build_header + 32
        version_size = data[version_start]
        if version_size >= 128:
            raise ValueError("Unexpected Go version encoding: " + target)
        go_version = data[version_start + 1:version_start + 1 + version_size].decode()
        if go_version != "go1.27.3":
            raise ValueError("Unexpected Go compiler input: " + target)
        marker = b"path\tgithub.com/cloudflare/cloudflared/cmd/cloudflared\n"
        start = data.find(marker)
        if start < 0:
            raise ValueError("Go module build information was not found: " + target)
        lines = data[start:start + 65536].decode("latin1").splitlines()
        previous = None
        target_modules = []
        builds = []
        for line in lines:
            if line.startswith("dep\t") or line.startswith("=>\t"):
                values = line.split("\t")
                if line.startswith("=>\t") and previous is not None:
                    target_modules.pop()
                if len(values) < 4 or not values[3].startswith("h1:"):
                    previous = values[1:3]
                    if line.startswith("dep\t"):
                        target_modules.append(None)
                    continue
                module = (values[1], values[2], values[3])
                target_modules.append(module)
                modules[module] = True
                previous = module
            elif line.startswith("build\t"):
                builds.append(line.removeprefix("build\t"))
            elif builds:
                break
        identities.append({"target": target, "sha256": expected, "bytes": len(data), "goVersion": go_version, "modules": [dict(zip(("path", "version", "h1"), m)) for m in target_modules if m is not None], "build": builds})
    # Only include replacements, not their original unmapped module identities.
    actual = {(m["path"], m["version"], m["h1"]) for identity in identities for m in identity["modules"]}
    return sorted(actual), identities


def collect(module):
    path, version, expected_h1 = module
    url = "https://proxy.golang.org/" + escaped(path) + "/@v/" + urllib.parse.quote(escaped(version), safe="") + ".zip"
    data = download(url)
    notices = []
    digest = hashlib.sha256()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = sorted(archive.namelist())
        if len(names) != len(set(names)) or any("\n" in name for name in names):
            raise ValueError("Unexpected module archive structure: " + path)
        for name in names:
            content = archive.read(name)
            digest.update((hashlib.sha256(content).hexdigest() + "  " + name + "\n").encode())
            if LICENSE_NAME.fullmatch(name.rsplit("/", 1)[-1]):
                notices.append({"file": name, "sha256": hashlib.sha256(content).hexdigest(), "text": content.decode("utf-8")})
    actual = "h1:" + base64.b64encode(digest.digest()).decode()
    if actual != expected_h1:
        raise ValueError("Module source does not match the executable's Go checksum: " + path + " " + version)
    if not notices:
        raise ValueError("No license or notice found in module: " + path)
    return {"path": path, "version": version, "h1": expected_h1, "zipSha256": hashlib.sha256(data).hexdigest(), "source": url, "notices": notices}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binaries", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    modules, binaries = binary_modules(options.binaries)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        collected = list(pool.map(collect, modules))
    go_license_url = "https://raw.githubusercontent.com/golang/go/go1.27.3/LICENSE"
    go_license = download(go_license_url).decode("utf-8")
    output = ["# Third-party notices in cloudflared 2026.10.3-linkspan.1", "", "Generated from the five pinned restricted helper binaries; module versions and Go h1 checksums are taken from their embedded build information. All collected module archives passed the embedded Go content checksums, including replacement modules. This collection preserves license/notice files found in these exact modules and the Go standard library license; it does not assign a new license to Linkspan.", "", "These are modified builds of source de6376c5af4a67cbc65258682e5a01781827643d, with the accompanying cloudflared-restricted.patch applied and fixed Go 1.27.3 build inputs. They are not the official Cloudflare release executables.", "", "## Go standard library 1.27.3", "", go_license_url, "", "~~~~text", go_license.rstrip(), "~~~~", ""]
    for item in collected:
        output.extend(["## " + item["path"] + " " + item["version"], "", "Content checksum: `" + item["h1"] + "`", "", item["source"], ""])
        for notice in item["notices"]:
            output.extend(["### " + notice["file"], "", "~~~~text", notice["text"].rstrip(), "~~~~", ""])
    options.output.mkdir(parents=True, exist_ok=True)
    (options.output / "THIRD_PARTY_NOTICES.cloudflared.md").write_text("\n".join(output), encoding="utf-8", newline="\n")
    for item in collected:
        for notice in item["notices"]:
            del notice["text"]
    (options.output / "cloudflared.build-inputs.json").write_text(json.dumps({"version": "2026.10.3-linkspan.1", "sourceCommit": "de6376c5af4a67cbc65258682e5a01781827643d", "sourceArchiveSha256": "6c6901ae333508e1c529184bf90cb87ff59592620d293401db38415269908311", "patchSha256": hashlib.sha256((options.output / "cloudflared-restricted.patch").read_bytes()).hexdigest(), "binaries": binaries, "modules": collected, "goLicense": {"url": go_license_url, "sha256": hashlib.sha256(go_license.encode()).hexdigest()}}, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"binaries": len(binaries), "modules": len(collected), "noticeFiles": sum(len(item["notices"]) for item in collected)}))


if __name__ == "__main__":
    main()
