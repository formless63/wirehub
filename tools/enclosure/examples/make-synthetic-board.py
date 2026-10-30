"""Synthetic, public-safe demo board for the enclosure pack (made up for this example)."""
import sys
import pcbnew

LIB = "/usr/share/kicad/footprints"
b = pcbnew.BOARD()
mm = pcbnew.FromMM
def P(x, y): return pcbnew.VECTOR2I(mm(x), mm(y))

# outline 60 x 40 with one chamfered back-left corner, origin (100, 100)
pts = [(100, 104), (104, 100), (160, 100), (160, 140), (100, 140)]
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

for i, (x, y) in enumerate([(103.5, 136.5), (156.5, 136.5), (156.5, 103.5), (110, 103.5)]):
    place("MountingHole", "MountingHole_3.2mm_M3", f"H{i+1}", x, y)
place("Connector_USB", "USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal", "J1", 126, 136.5, 0, "USB-C")
place("Connector_BarrelJack", "BarrelJack_Horizontal", "J2", 145, 112, 270, "DC 5.5/2.1")
place("Package_SO", "SOIC-8_3.9x4.9mm_P1.27mm", "U1", 115, 120, 0, "MCU")
place("Capacitor_THT", "CP_Radial_D6.3mm_P2.50mm", "C1", 130, 118, 0, "100uF")
# nets, so a cable landing on J1 traces through the board; CC1/CC2/SBU stay on no net on purpose
NETS = {
    "VBUS": [("J1", "A4"), ("J1", "A9"), ("J1", "B4"), ("J1", "B9"), ("J2", "1"), ("C1", "1"), ("U1", "8")],
    "GND": [("J1", "A1"), ("J1", "A12"), ("J1", "B1"), ("J1", "B12"), ("J1", "SH"), ("J2", "2"), ("J2", "3"), ("C1", "2"), ("U1", "4")],
    "/USB_D+": [("J1", "A6"), ("J1", "B6"), ("U1", "2")],
    "/USB_D-": [("J1", "A7"), ("J1", "B7"), ("U1", "3")],
}
for name, pins in NETS.items():
    net = pcbnew.NETINFO_ITEM(b, name)
    b.Add(net)
    for ref, num in pins:
        for pad in b.FindFootprintByReference(ref).Pads():
            if pad.GetNumber() == num:
                pad.SetNet(net)
b.GetDesignSettings().SetBoardThickness(mm(1.6))
pcbnew.SaveBoard(sys.argv[1], b)
print("saved", sys.argv[1])
