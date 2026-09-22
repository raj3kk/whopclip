#!/usr/bin/env python3
"""Merge Android res trees at the resource-entry level (later trees win).
Usage: merge_res.py <outdir> <resdir> [<resdir> ...]
"""
import os, sys, shutil, xml.etree.ElementTree as ET

outdir = sys.argv[1]
srcdirs = sys.argv[2:]

values_entries = {}   # (qualifier_file, tag, name) -> element (deep-copied later)
values_order = {}     # qualifier_file -> list of keys in first-seen order

for src in srcdirs:
    if not os.path.isdir(src):
        continue
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        qdir = rel.split(os.sep)[0]  # values, values-v21, drawable, ...
        if qdir.startswith("values"):
            for fn in files:
                if not fn.endswith(".xml"):
                    continue
                qfile = f"{qdir}/{fn}"
                try:
                    tree = ET.parse(os.path.join(root, fn))
                except Exception as e:
                    print(f"WARN: cannot parse {os.path.join(root, fn)}: {e}")
                    continue
                r = tree.getroot()
                for el in list(r):
                    name = el.get("name")
                    if not name:
                        continue
                    key = (qfile, el.tag, name)
                    if key not in values_entries:
                        values_order.setdefault(qfile, []).append(key)
                    # deep copy the element so later trees can overwrite
                    values_entries[key] = ET.fromstring(ET.tostring(el))
        else:
            # non-values: file copy, later wins
            dest_dir = os.path.join(outdir, rel)
            os.makedirs(dest_dir, exist_ok=True)
            for fn in files:
                shutil.copy2(os.path.join(root, fn), os.path.join(dest_dir, fn))

for qfile, keys in values_order.items():
    dest = os.path.join(outdir, qfile)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    r = ET.Element("resources")
    for key in keys:
        r.append(values_entries[key])
    tree = ET.ElementTree(r)
    tree.write(dest, encoding="utf-8", xml_declaration=True)

print(f"merged {len(srcdirs)} res trees -> {outdir}")
