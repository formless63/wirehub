# Automotive — a WireHub domain module

Vehicle diagnostics and buses for WireHub, as a catalog pack (`pack/`): CAN
high/low, K- and L-line, J1850 and battery-positive signals, the OBD-II
family, and the OBD-II plug (SAE J1962 / ISO 15031-3) with its mandated pins —
the manufacturer-discretionary pins are marked as such, never presented as
standard. It also carries a generic sealed 3-way connector family (pin and socket
housings with single-wire seals and plugged unused cavities), its crimp contacts, seals,
cavity plug and hand crimp tool (typical values for the class, flagged as inferred), a
2 × 0.5 mm² cable and a sealed sensor lead that uses them. For the resolver (`docs/resolver.md`) it
adds a control unit's sensor port, two 3-wire 5 V sensors whose pinouts differ (a straight cable
would short the 5 V reference to the return; the resolver crosses them and says why), the sensor
signal and level, and a 3 × 0.5 mm² cable. Enable it at first-run setup (`/setup`). Code: MIT; data: CC0-1.0.
