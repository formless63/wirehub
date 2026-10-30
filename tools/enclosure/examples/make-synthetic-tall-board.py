"""Synthetic, public-safe 70 x 45 mm board with one tall part, for the enclosure pack's part-height
reading (made up for this example; KiCad's standard footprints only). Run with KiCad's Python:

    python3 make-synthetic-tall-board.py synthetic-tall-board.kicad_pcb

U2 (TO-220 standing up) is the tallest part by far; C1 is a 10 mm radial electrolytic; TP1 and
FID1 are pads-only footprints with no 3D model (nothing stands above the board there).
"""
import sys
import pcbnew

LIB = "/usr/share/kicad/footprints"
b = pcbnew.BOARD()
mm = pcbnew.FromMM
def P(x, y): return pcbnew.VECTOR2I(mm(x), mm(y))

pts = [(100, 100), (170, 100), (170, 145), (100, 145)]
for a, c in zip(pts, pts[1:] + pts[:1]):
    s = pcbnew.PCB_SHAPE(b)
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(P(*a)); s.SetEnd(P(*c))
    s.SetLayer(pcbnew.Edge_Cuts); s.SetWidth(mm(0.05))
    b.Add(s)

def place(lib, name, ref, x, y, rot=0, value=None):
    fp = pcbnew.FootprintLoad(f"{LIB}/{lib}.pretty", name)
    if fp is None:
        sys.exit(f"missing {lib}:{name}")
    fp.SetReference(ref)
    if value: fp.SetValue(value)
    fp.SetPosition(P(x, y))
    fp.SetOrientationDegrees(rot)
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    b.Add(fp)
    return fp

for i, (x, y) in enumerate([(103.5, 141.5), (166.5, 141.5), (166.5, 103.5), (103.5, 103.5)]):
    place("MountingHole", "MountingHole_3.2mm_M3", f"H{i+1}", x, y)
place("Connector_USB", "USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal", "J1", 125, 141.5, 0, "USB-C")
place("Package_TO_SOT_THT", "TO-220-3_Vertical", "U2", 150, 125, 0, "Regulator")
place("Capacitor_THT", "CP_Radial_D10.0mm_P5.00mm", "C1", 130, 118, 0, "470uF")
place("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm", "U1", 115, 122, 0, "MCU")
place("Resistor_SMD", "R_0603_1608Metric", "R1", 115, 131, 0, "10k")
place("Resistor_SMD", "R_0603_1608Metric", "R2", 119, 131, 0, "10k")
place("Connector_PinHeader_2.54mm", "PinHeader_1x04_P2.54mm_Vertical", "J3", 140, 108, 90, "Header")
place("TestPoint", "TestPoint_Pad_D1.0mm", "TP1", 112, 110, 0, "TP")
place("Fiducial", "Fiducial_1mm_Mask2mm", "FID1", 160, 140, 0, "Fiducial")
b.GetDesignSettings().SetBoardThickness(mm(1.6))
pcbnew.SaveBoard(sys.argv[1], b)
print("saved", sys.argv[1])
