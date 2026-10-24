"""
Seeds 40 HP LaserJet printer parts into the database.
- Safe to run on a fresh DB (no Roboflow data required)
- Idempotent: existing class_ids are skipped
- Called automatically on Docker startup

Source: AI Parts Finder_Parts List_Jasper_rev.xlsx
  class_id      = row index (0-based, matches YOLO class ID)
  serial_number = SVC Part Number
  part_name     = Part Description
"""
from sqlalchemy import text, inspect
from database import SessionLocal, Part, init_db, engine

PARTS_DATA = {
    0:  {"name": "SVC_HP LaserJet Fuser 220V Kit",               "serial": "5PN77-67001"},
    1:  {"name": "SVC_HP LaserJet CYM Managed Imaging Drum",     "serial": "W9078-67001"},
    2:  {"name": "SVC_HP LaserJet Black Managed Imaging Drum",   "serial": "W9077-67001"},
    3:  {"name": "SVC_HP LaserJet Toner Collection Unit",        "serial": "6SB85-67001"},
    4:  {"name": "Waste toner duct unit",                        "serial": "JC96-13015A"},
    5:  {"name": "SVC_HP LaserJet Trays 2-x Roller Kit",        "serial": "5PN66-67001"},
    6:  {"name": "SVC_HP LaserJet Yellow Developer Unit",        "serial": "5PN73-67003"},
    7:  {"name": "Hard disk 500GB SED",                          "serial": "933853-011"},
    8:  {"name": "HP LaserJet ADF Maintenance Kit",              "serial": "5RC00-67001"},
    9:  {"name": "Main PCA (Formatter)",                         "serial": "6CF14-67011"},
    10: {"name": "Laser scanner unit (LSU)",                     "serial": "JC97-05149A"},
    11: {"name": "Control panel (10.1 inch)",                    "serial": "5QK42-60104"},
    12: {"name": "SVC_T2 transfer assembly",                     "serial": "5PN80-67002"},
    13: {"name": "Low Voltage Power Supply (LVPS), 220V",        "serial": "JC44-00150C"},
    14: {"name": "High Voltage Power Supply (HVPS)",             "serial": "JC44-00240C"},
    15: {"name": "SVC_HPLJ 300ipm300shtFlw DADFhighspdScnr",    "serial": "5QK39-67002"},
    16: {"name": "ADF Whole Unit Kit, Valiant A3",               "serial": "5QK08-67014"},
    17: {"name": "Fuser drive board (FDB), 220V",                "serial": "JC44-00236C"},
    18: {"name": "SVC-Flat Cable, Faro SICB 50pin",             "serial": "5QK08-67011"},
    19: {"name": "SVC-Flat Cable, Faro SICB 68pin",             "serial": "5QK08-67012"},
    20: {"name": "FLAT CABLE-LSU",                               "serial": "5QK03-50003"},
    21: {"name": "Exit unit",                                    "serial": "JC90-01856A"},
    22: {"name": "Right door assembly",                          "serial": "JC95-02247A"},
    23: {"name": "Front cover assembly",                         "serial": "6ER04-61001"},
    24: {"name": "Registration unit assembly",                   "serial": "8GS05-60128"},
    25: {"name": "Registration sensor",                          "serial": "0604-001381"},
    26: {"name": "Feed 2 sensor",                                "serial": "0604-001490"},
    27: {"name": "Fuser, Exit drive assembly",                   "serial": "JC93-01850A"},
    28: {"name": "Drum, ITB motor",                              "serial": "JC31-00123C"},
    29: {"name": "Reservoir drive motor",                        "serial": "JC93-01659A"},
    30: {"name": "Tray 3 empty sensor",                          "serial": "3SJ00-60110"},
    31: {"name": "Duplex 1 motor",                               "serial": "JC93-00336A"},
    32: {"name": "Toner dispense motor",                         "serial": "SS216-80501"},
    33: {"name": "CPR shutter motor",                            "serial": "JC31-00078A"},
    34: {"name": "LVPS fan",                                     "serial": "JC31-00198A"},
    35: {"name": "FDB fan",                                      "serial": "JC31-00154A"},
    36: {"name": "LSU fan assembly",                             "serial": "JC93-01019A"},
    37: {"name": "Right door switch assembly",                   "serial": "JC93-01467A"},
    38: {"name": "Front door switch assembly",                   "serial": "JC93-00466A"},
    39: {"name": "Outer environment sensor assembly",            "serial": "5QJ90-40002"},
}


def seed():
    init_db()

    db = SessionLocal()
    inserted = 0
    try:
        for class_id, info in PARTS_DATA.items():
            exists = db.query(Part).filter(Part.class_id == class_id).first()
            if not exists:
                db.add(Part(
                    class_id=class_id,
                    serial_number=info["serial"],
                    part_desc=info["name"],
                ))
                inserted += 1
        db.commit()
    finally:
        db.close()
    print(f"[INFO] Seeding complete: {inserted} parts inserted.")


if __name__ == "__main__":
    seed()
