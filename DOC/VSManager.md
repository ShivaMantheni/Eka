# VS Manager — Dynamic Image Path Feature

## Goal
Replace hardcoded `VS_SOURCE_IMAGE` / `VS_IMAGES_PATH` constants with dynamic image path resolution read directly from the VS XML definition file.

## Status: IMPLEMENTED ✓

---

## Problem

Currently in `main.py` (lines 86–88):
```python
VS_SOURCE_IMAGE = "/home/hp/anuradha_builds/target/sonic-vs.img"
VS_IMAGES_PATH  = "/var/lib/libvirt/images/"
VS_XML_PATH     = "/home/hp/prajwal/VMs"
```

On VS start, the destination image path is **hardcoded** — always copied to `VS_IMAGES_PATH/<vs_name>.img`. The XML `<source file>` is then overwritten via `sed` to match. This breaks when VMs live in subdirectories (e.g., `/var/lib/libvirt/images/ShivaKumar/training-vs1.img`).

---

## Proposed Flow

When a VS is started:

1. Read the XML file from `dut.xml_path/<vs_name>.xml`
2. Parse the XML — find `<disk device='disk'>` → `<source file="..."/>`
3. Extract the **destination image path** from the XML (e.g., `/var/lib/libvirt/images/ShivaKumar/training-vs1.img`)
4. Delete the existing image at that path (if it exists)
5. Copy the source template (`VS_SOURCE_IMAGE`) to that same path with the same filename
6. Start the VS via `virsh start` — no XML `sed` rewrite needed

---

## Implementation Plan

### Backend — `main.py`

| Task | Location | Status |
|------|----------|--------|
| Add `extract_image_path_from_xml(xml_file)` helper | Inlined as remote python3 cmd | [x] |
| Replace hardcoded `target_image_path` in `_run_vs_update()` | ~line 4522 | [x] |
| Replace hardcoded path in `_run_vs_batch_update()` | ~line 4320 | [x] |
| Remove `sed` XML source rewrite step | Removed from `_run_vs_update` | [x] |

### Frontend — `app.js` / `index.html`

| Task | Location | Status |
|------|----------|--------|
| Add error message if XML missing or has no disk source | `app.js` VS start handler | [ ] |
| (Optional) Show resolved image path as tooltip/info in VS UI | `index.html` | [ ] |

---

## Key Logic (pseudo-code)

```python
def extract_image_path_from_xml(xml_file: str) -> str:
    tree = ET.parse(xml_file)
    root = tree.getroot()
    for disk in root.iter('disk'):
        if disk.get('device') == 'disk':
            source = disk.find('source')
            if source is not None:
                return source.get('file')
    raise ValueError("No disk image source found in XML")

# In VS start flow:
xml_file  = f"{dut.xml_path}/{vs_name}.xml"
dest_img  = extract_image_path_from_xml(xml_file)   # e.g. /var/lib/libvirt/images/ShivaKumar/training-vs1.img
dest_dir  = os.path.dirname(dest_img)
os.makedirs(dest_dir, exist_ok=True)
if os.path.exists(dest_img):
    os.remove(dest_img)
shutil.copy2(VS_SOURCE_IMAGE, dest_img)             # copy template → destination
subprocess.run(["sudo", "virsh", "start", vs_name], ...)
```

---

## Affected Files
- `main.py` — 3 locations (helper + 2 call sites + remove sed step)
- No DB schema changes (`xml_path` field already exists on `DUT` model, line 153)
- Minor frontend error-handling in `app.js`

---

## Open Questions
- [ ] Should `VS_SOURCE_IMAGE` (the template) also become per-device configurable, or stay as a global?

---

## Change Log

| Date | Session | Note |
|------|---------|------|
| 2026-06-24 | Initial | Plan drafted, awaiting user approval |
| 2026-06-24 | Implementation | All changes applied to main.py; syntax verified |
