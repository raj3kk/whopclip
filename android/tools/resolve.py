#!/usr/bin/env python3
"""Resolve Maven transitive closure (compile+runtime) and download aar/jar files.
Usage: resolve.py <outdir>
Reads hardcoded root deps below. Writes artifacts to outdir, prints classpath.
"""
import os, re, sys, urllib.request, xml.etree.ElementTree as ET

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)

GOOGLE = "https://dl.google.com/dl/android/maven2"
CENTRAL = "https://repo.maven.apache.org/maven2"

ROOTS = [
    ("androidx.core", "core-ktx", "1.12.0"),
    ("androidx.appcompat", "appcompat", "1.6.1"),
    ("com.google.android.material", "material", "1.11.0"),
    ("androidx.work", "work-runtime-ktx", "2.9.0"),
    ("org.jetbrains.kotlinx", "kotlinx-coroutines-android", "1.7.3"),
]

NS = {"m": "http://maven.apache.org/POM/4.0.0"}

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "whopclip-resolver/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()

def pom_xml(group, artifact, version, repo):
    path = f"{group.replace('.', '/')}/{artifact}/{version}/{artifact}-{version}.pom"
    repos = [repo] if repo else []
    repos += [r for r in (GOOGLE, CENTRAL) if r not in repos]
    for base in repos:
        try:
            return fetch(f"{base}/{path}"), base
        except Exception:
            continue
    raise RuntimeError(f"POM not found: {group}:{artifact}:{version}")

def text(el, tag):
    c = el.find(f"m:{tag}", NS)
    return c.text.strip() if c is not None and c.text else None

resolved = {}   # (group, artifact) -> version (nearest wins)
queue = []      # (group, artifact, version, depth, repo_hint)

for g, a, v in ROOTS:
    queue.append((g, a, v, 0, None))

order = []
while queue:
    g, a, v, depth, repo_hint = queue.pop(0)
    key = (g, a)
    if key in resolved:
        continue
    xml, base = pom_xml(g, a, v, repo_hint)
    resolved[key] = (v, base)
    order.append((g, a, v, base))
    root = ET.fromstring(xml)
    props = {}
    for p in root.findall("m:properties/m:*", NS):
        tag = p.tag.split("}")[-1]
        if p.text:
            props[tag] = p.text.strip()
    parent = root.find("m:parent", NS)
    if parent is not None:
        for t in ("groupId", "artifactId", "version"):
            pass  # properties from parent rarely needed for our deps
    depman = {}
    for d in root.findall("m:dependencyManagement/m:dependencies/m:dependency", NS):
        dg, da, dv = text(d, "groupId"), text(d, "artifactId"), text(d, "version")
        if dg and da and dv:
            depman[(dg, da)] = dv
    for d in root.findall("m:dependencies/m:dependency", NS):
        dg, da = text(d, "groupId"), text(d, "artifactId")
        scope = text(d, "scope") or "compile"
        opt = text(d, "optional")
        if not dg or not da or scope in ("test", "provided") or opt == "true":
            continue
        if dg.startswith("org.jetbrains.kotlin") and da in ("kotlin-stdlib", "kotlin-stdlib-jdk8", "kotlin-stdlib-jdk7"):
            continue  # provided by kotlinc dist
        dv = text(d, "version")
        if not dv:
            dv = depman.get((dg, da))
        if not dv:
            # property placeholder
            continue
        for pk, pv in props.items():
            dv = dv.replace("${" + pk + "}", pv)
        dv = re.sub(r"\$\{[^}]+\}", "", dv)
        if not dv:
            continue
        # Maven version ranges: [1.6.1] -> 1.6.1 ; [1.0,) -> 1.0 ; (,2.0] -> skip upper-only
        m = re.match(r"^[\[\(]\s*([^,\s\)\]]+)", dv)
        if m:
            dv = m.group(1)
        if not dv or "${" in dv or "," in dv:
            continue
        if (dg, da) not in resolved:
            queue.append((dg, da, dv, depth + 1, base))

print(f"resolved {len(order)} artifacts")
with open(os.path.join(OUT, "order.txt"), "w") as f:
    for g, a, v, base in order:
        f.write(f"{a}-{v}\n")
dl = 0
for g, a, v, base in order:
    stem = f"{a}-{v}"
    got = None
    for ext in ("aar", "jar"):
        dest = os.path.join(OUT, f"{stem}.{ext}")
        if os.path.exists(dest):
            got = dest
            break
        url = f"{base}/{g.replace('.', '/')}/{a}/{v}/{stem}.{ext}"
        try:
            data = fetch(url)
            with open(dest, "wb") as f:
                f.write(data)
            got = dest
            dl += 1
            break
        except Exception:
            continue
    if not got:
        print(f"WARN: no aar/jar for {g}:{a}:{v}")
    else:
        print(f"ok {g}:{a}:{v} -> {os.path.basename(got)}")
print(f"downloaded {dl} new files")
