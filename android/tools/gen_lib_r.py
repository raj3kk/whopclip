#!/usr/bin/env python3
"""Generate library R classes for AAR dependencies (v14 root fix).

ROOT CAUSE (v12/v13): AAR bytecode references its own library R classes
  (e.g. androidx.work.R$bool.workmanager_test_configuration,
   androidx.startup.R$string.androidx_startup). The manual build only
  generated the APP's com.whopclip.agent.R class, so those library R
  classes were missing from the dex:
    - v12: WorkManager.initialize() -> WorkManagerImplExtKt.createWorkManager
           -> getBoolean(R.bool.workmanager_test_configuration)
           -> NoClassDefFoundError: androidx/work/R$bool  ("Failed resolution")
    - v13: InitializationProvider.onCreate() -> AppInitializer
           -> getString(R.string.androidx_startup)
           -> NoClassDefFoundError: androidx/startup/R$string  (instant death
           at launch, before Application.onCreate — uncatchable)

This script reads each extracted AAR's R.txt + AndroidManifest.xml (package),
maps every entry to the FINAL merged resource id from the app's generated
R.java, and emits a Kotlin R.kt per library package. Kotlin was chosen
because the build has no javac; verified output:
    const val x = 0x...            -> public static final int x
    @JvmField val A = intArrayOf() -> public static final int[] A
both as static fields on the R$<type> class — exactly what AAR bytecode
references via sget.

Usage: gen_lib_r.py <app R.java> <outdir> <aar-dir> [<aar-dir> ...]
Writes <outdir>/<pkg path>/R.kt for every AAR dir containing R.txt.
Exits non-zero if a *critical* (work/startup) entry cannot be mapped.
"""
import os
import re
import sys
import xml.etree.ElementTree as ET

CRITICAL_PKGS = ("androidx.work", "androidx.startup")


def parse_app_r(path):
    """{(inner, name): id} for int fields, {(inner, name): [ids]} for int[]."""
    src = open(path).read()
    ints, arrays = {}, {}
    # Brace-counting scan: styleable bodies contain multi-line int[]
    # initializers whose "};" would fool a naive regex.
    for m in re.finditer(r"public static final class (\w+)\s*\{", src):
        inner = m.group(1)
        depth, i = 1, m.end()
        while i < len(src) and depth > 0:
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
            i += 1
        body = src[m.end():i - 1]
        for f in re.finditer(r"public static final int (\w+)=(0x[0-9a-fA-F]+);", body):
            ints[(inner, f.group(1))] = f.group(2)
        for f in re.finditer(
            r"public static final int\[\] (\w+)=\{([^}]*)\};", body, re.S
        ):
            ids = [x.strip() for x in f.group(2).split(",") if x.strip()]
            arrays[(inner, f.group(1))] = ids
    return ints, arrays


def parse_r_txt(path):
    """[(kind, type, name, count)] — kind is 'int' or 'int[]'."""
    entries = []
    for line in open(path):
        line = line.strip()
        m = re.match(r"int (\w+) (\w+) 0x[0-9a-fA-F]+$", line)
        if m:
            entries.append(("int", m.group(1), m.group(2), 0))
            continue
        m = re.match(r"int\[\] (\w+) (\w+) \{(.*)\}$", line)
        if m:
            count = len([x for x in m.group(3).split(",") if x.strip()])
            entries.append(("int[]", m.group(1), m.group(2), count))
    return entries


def aar_package(aar_dir):
    man = os.path.join(aar_dir, "AndroidManifest.xml")
    try:
        root = ET.parse(man).getroot()
        return root.get("package")
    except Exception:
        return None


def main():
    r_java, outdir = sys.argv[1], sys.argv[2]
    aar_dirs = sys.argv[3:]
    ints, arrays = parse_app_r(r_java)
    print(f"gen_lib_r: app R.java -> {len(ints)} int fields, {len(arrays)} int[] arrays")
    total_fields, warnings, critical_missing = 0, [], []
    for ad in aar_dirs:
        r_txt = os.path.join(ad, "R.txt")
        if not os.path.isfile(r_txt):
            continue
        pkg = aar_package(ad)
        if not pkg:
            warnings.append(f"{ad}: no package in AndroidManifest.xml, skipped")
            continue
        buckets = {}  # inner -> [kotlin lines]
        for kind, typ, name, count in parse_r_txt(r_txt):
            if kind == "int":
                rid = ints.get((typ, name))
                if rid is None:
                    msg = f"{pkg}.R${typ}.{name}: resource not in merged app R"
                    (critical_missing if pkg in CRITICAL_PKGS else warnings).append(msg)
                    continue
                buckets.setdefault(typ, []).append(
                    f"        const val {name} = {rid}"
                )
                total_fields += 1
            else:  # int[] styleable
                ids = arrays.get((typ, name))
                if ids is None or len(ids) != count:
                    msg = (f"{pkg}.R${typ}.{name}: styleable array not in merged "
                           f"app R (want {count}, got {len(ids) if ids else 0})")
                    (critical_missing if pkg in CRITICAL_PKGS else warnings).append(msg)
                    continue
                buckets.setdefault(typ, []).append(
                    f"        @JvmField val {name}: IntArray = intArrayOf({', '.join(ids)})"
                )
                total_fields += 1
        if not buckets:
            continue
        lines = [f"package {pkg}", "", "object R {"]
        for typ in sorted(buckets):
            lines.append(f"    object {typ} {{")
            lines.extend(buckets[typ])
            lines.append("    }")
        lines.append("}")
        dest = os.path.join(outdir, *pkg.split("."), "R.kt")
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        open(dest, "w").write("\n".join(lines) + "\n")
        print(f"gen_lib_r: {pkg}.R -> {sum(len(v) for v in buckets.values())} fields")
    for w in warnings:
        print(f"gen_lib_r WARN: {w}")
    if critical_missing:
        for m in critical_missing:
            print(f"gen_lib_r CRITICAL: {m}")
        sys.exit(2)
    print(f"gen_lib_r: OK, {total_fields} fields total")


if __name__ == "__main__":
    main()
