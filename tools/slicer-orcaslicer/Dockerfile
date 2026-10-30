# WireHub tool pack `slicer-orcaslicer` (contract v0, tools/README.md).
# OrcaSlicer 2.4.2 (AGPL-3.0), the official Linux AppImage (Ubuntu 24.04 build) pinned by its
# release sha256 and unpacked at build time (no FUSE at run time), on Ubuntu 24.04 pinned by digest.
# The runtime libraries come from the Ubuntu archive as it stood on one date (snapshot.ubuntu.com),
# so a rebuild resolves the same package versions. Image: wirehub-tool-slicer-orcaslicer:<PACK_VERSION>.
# Runs with --network none --read-only --tmpfs /tmp; it prepares files only and never talks to a printer.
FROM ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac
ARG PACK_VERSION=2.4.2-2
ARG ORCA_VERSION=2.4.2
ARG ORCA_SHA256=d12fb8c8eac1aecd2dfb6377acd48f994f8fa439ed5292fa532dd82880f029fd
ARG UBUNTU_SNAPSHOT=20261020T000000Z
ENV WIREHUB_PACK_VERSION=${PACK_VERSION} WIREHUB_ORCA_VERSION=${ORCA_VERSION} HOME=/tmp XDG_RUNTIME_DIR=/tmp \
    LC_ALL=C PYTHONDONTWRITEBYTECODE=1 DEBIAN_FRONTEND=noninteractive
# the snapshot archive is served over https only: ca-certificates comes from the base's own archive first
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && apt-get update --snapshot ${UBUNTU_SNAPSHOT} \
 && apt-get install -y --no-install-recommends --snapshot ${UBUNTU_SNAPSHOT} \
      python3 \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libsoup-3.0-0 libsecret-1-0 \
      libgl1 libglu1-mesa libopengl0 libegl1 libglx0 libgl1-mesa-dri \
      libsm6 libice6 libx11-6 libxext6 libxkbcommon0 libwayland-egl1 libwayland-server0 libwayland-client0 \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 libdbus-1-3 fontconfig \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
ADD --checksum=sha256:${ORCA_SHA256} \
    https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404_V${ORCA_VERSION}.AppImage \
    /tmp/orca.AppImage
RUN cd /tmp && chmod +x orca.AppImage && ./orca.AppImage --appimage-extract >/dev/null \
 && mv squashfs-root /opt/orca && rm orca.AppImage \
 && chmod -R a+rX /opt/orca
COPY entry.py preview.py /opt/wirehub/
RUN python3 /opt/wirehub/entry.py --self-check
LABEL org.wirehub.tool-pack="slicer-orcaslicer" org.wirehub.tool-pack.version="${PACK_VERSION}" org.wirehub.tool-pack.contract="0" \
      org.wirehub.tool.orcaslicer.sha256="${ORCA_SHA256}"
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/wirehub/entry.py"]
