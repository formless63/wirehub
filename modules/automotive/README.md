# Automotive — a WireHub domain module

Vehicle diagnostics and buses for WireHub, as a catalog pack (`pack/`): CAN
high/low, K- and L-line, J1850 and battery-positive signals, the OBD-II
family, and both mating halves of OBD-II type A (SAE J1962 / ISO 15031-3) with their mandated pins —
the manufacturer-discretionary pins are marked as such, never presented as
standard. It also carries a generic sealed 3-way connector family (pin and socket
housings with single-wire seals and plugged unused cavities), its crimp contacts, seals,
cavity plug and hand crimp tool (typical values for the class, flagged as inferred), a
2 × 0.5 mm² cable and a sealed sensor lead that uses them. For the resolver (`docs/resolver.md`) it
adds a control unit's sensor port, two 3-wire 5 V sensors whose pinouts differ (a straight cable
would short the 5 V reference to the return; the resolver crosses them and says why), the sensor
signal and level, and a 3 × 0.5 mm² cable. Enable it at first-run setup (`/setup`), or install/update Automotive in Store. Code: MIT; data: CC0-1.0.

Version 0.5.0 requires WireHub 0.8.0 or later for its new 3D shapes. It contains
eight connectors: the OBD-II plug/receptacle, the two generic
sealed 3-way connectors, and [TE DEUTSCH DT04-2P](https://www.te.com/en/product-DT04-2P.html),
[DT06-2S](https://www.te.com/en/product-DT06-2S.html),
[DT04-6P](https://www.te.com/en/product-DT04-6P.html) and
[DT06-6S](https://www.te.com/en/product-DT06-6S.html). The DT entries retain numbered
cavities without assigning vehicle-specific signals. The pack includes nickel-plated
size-16 pin/socket contacts, the 114017 cavity plug, and the corresponding secondary
wedgelocks. DT standard mat seals take 2.23–3.68 mm insulation; the original synthetic
thin-wall sensor examples use a different per-wire sealed system. Those termination
parts are not interchangeable.

Each connector and body has an original generated 3D envelope that works immediately
without a download. DT outside dimensions come from the linked TE product pages;
latches, cavity details, colors and other inferred geometry are identified in each
model's citation. These models are approximations, not manufacturer CAD or fit-check
models. TE's product pages offer exact customer STEP models in their CAD Files section;
an uploaded exact model can replace a generated envelope. No TE geometry is bundled
or relicensed as CC0. The generic sealed 3-way entries remain explicitly synthetic.
Their original mating/rear artwork now makes the cavities, latch and seals visible.
DT physical cavity-number anchors are deliberately absent until verified against the
manufacturer drawings; its 2D view retains the abstract numbered terminals.

The new OBD-II extension example preserves all 16 pins, including the manufacturer
discretionary positions. Its 16-core wire stock is a synthetic illustration rather
than an orderable cable. Confirm actual vehicle usage, wire/contact ratings and
termination instructions when deriving a build from it.
