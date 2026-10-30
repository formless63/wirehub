# WireHub tool pack `slicer-prusaslicer` (contract v0, tools/README.md).
# PrusaSlicer 2.9.2 as Debian trixie packages it (AGPL-3.0), base pinned by digest,
# the slicer pinned by exact package version. Image: wirehub-tool-slicer-prusaslicer:<PACK_VERSION>.
# Runs with --network none --read-only --tmpfs /tmp; it prepares files only and never talks to a printer.
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad
ARG PACK_VERSION=2.9.2-3
ARG PRUSA_SLICER_DEB=2.9.2+dfsg-1
ENV WIREHUB_PACK_VERSION=${PACK_VERSION} HOME=/tmp XDG_RUNTIME_DIR=/tmp PYTHONDONTWRITEBYTECODE=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends prusa-slicer=${PRUSA_SLICER_DEB} python3 \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
COPY entry.py preview.py /opt/wirehub/
RUN prusa-slicer --help | head -n 1
LABEL org.wirehub.tool-pack="slicer-prusaslicer" org.wirehub.tool-pack.version="${PACK_VERSION}" org.wirehub.tool-pack.contract="0"
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/wirehub/entry.py"]
