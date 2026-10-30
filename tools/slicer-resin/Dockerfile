# WireHub tool pack `slicer-resin` (contract v0, tools/README.md).
# Resin (masked-LCD SLA) print preparation: PrusaSlicer 2.9.2 in SLA mode (Debian trixie package,
# AGPL-3.0) slices to .sl1, then UVtoolsCmd (UVtools, AGPL-3.0, pinned release zip, SHA-256 checked)
# converts that to the printer's own format (.goo for Elegoo's current printers).
# Image: wirehub-tool-slicer-resin:<PACK_VERSION>. Runs with --network none --read-only --tmpfs /tmp;
# it prepares files only and never talks to a printer.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
ARG PACK_VERSION=0.1.1
ARG PRUSA_SLICER_DEB=2.9.2+dfsg-1
ARG UVTOOLS_VERSION=7.0.2
ARG UVTOOLS_SHA256=45ca00b1c16adbacfc4ac674d8111c9b13574eb96c11b5cabe0f02ed1c932057
ENV WIREHUB_PACK_VERSION=${PACK_VERSION} UVTOOLS_VERSION=${UVTOOLS_VERSION} HOME=/tmp XDG_RUNTIME_DIR=/tmp \
    PYTHONDONTWRITEBYTECODE=1 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DOTNET_BUNDLE_EXTRACT_BASE_DIR=/tmp/dotnet-bundle
RUN apt-get update \
 && apt-get install -y --no-install-recommends prusa-slicer=${PRUSA_SLICER_DEB} python3 ca-certificates curl unzip \
      libgdiplus libgeotiff5 libdc1394-25 libopenexr-3-1-30 libgl1 libglu1-mesa libtbb12 libfontconfig1 \
 && curl -fsSL -o /tmp/uvtools.zip "https://github.com/sn4k3/UVtools/releases/download/v${UVTOOLS_VERSION}/UVtools_linux-x64_v${UVTOOLS_VERSION}.zip" \
 && echo "${UVTOOLS_SHA256}  /tmp/uvtools.zip" | sha256sum -c - \
 && mkdir -p /opt/uvtools && unzip -q /tmp/uvtools.zip -d /opt/uvtools && rm /tmp/uvtools.zip \
 && chmod +x /opt/uvtools/UVtoolsCmd \
 && apt-get purge -y curl unzip && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
COPY entry.py preview.py /opt/wirehub/
RUN prusa-slicer --help | head -n 1 && /opt/uvtools/UVtoolsCmd --version
LABEL org.wirehub.tool-pack="slicer-resin" org.wirehub.tool-pack.version="${PACK_VERSION}" org.wirehub.tool-pack.contract="0"
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/wirehub/entry.py"]
