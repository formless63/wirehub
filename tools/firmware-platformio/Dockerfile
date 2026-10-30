# wirehub-tool-<pack>:<packVersion>, one image per platform family (FAMILY build arg selects
# families/<FAMILY>/pack.json: classic = ESP8266 + AVR, esp32, rp2040).
#
# PlatformIO Core plus every platform, framework and toolchain package the
# supported targets need, fetched while the image is built so a compile runs
# with `--network none` (tools/firmware-platformio/README.md).
FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

ARG PLATFORMIO_VERSION=6.2.0
ARG FAMILY=classic

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLATFORMIO_CORE_DIR=/opt/pio \
    PLATFORMIO_SETTING_ENABLE_TELEMETRY=No \
    PLATFORMIO_SETTING_CHECK_PLATFORMIO_INTERVAL=36500 \
    PLATFORMIO_SETTING_CHECK_PRUNE_SYSTEM_THRESHOLD=0 \
    PLATFORMIO_NO_ANSI=1

RUN pip install "platformio==${PLATFORMIO_VERSION}" \
 && apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Build a seed project (generated from pack.json) once per target: this pulls each
# platform, framework, toolchain and build tool (SCons, esptool, …) a compile asks for.
COPY families/${FAMILY}/pack.json /etc/wirehub/pack.json
COPY seed.py /tmp/seed.py
RUN git config --system --add safe.directory '*' \
 && python3 /tmp/seed.py /etc/wirehub/pack.json /tmp/seed \
 && cd /tmp/seed && pio run \
 && rm -rf /tmp/seed /tmp/seed.py /opt/pio/.cache \
 # git-installed packages keep HEAD (pio reads it to recognise them) but not history or submodule repos\
 && find /opt/pio -name .git -type d -prune -exec sh -c 'rm -rf "$1/objects" "$1/modules" && mkdir "$1/objects"' _ {} \; \
 && chmod -R a+rX /opt/pio

COPY entry.py /usr/local/bin/wirehub-firmware
RUN chmod 0755 /usr/local/bin/wirehub-firmware

ARG FAMILY
LABEL org.wirehub.pack-family="${FAMILY}" \
      org.wirehub.tool="platformio" \
      org.wirehub.tool-version="${PLATFORMIO_VERSION}"

# An unprivileged user; the runner may pass --user to match the output directory's owner.
USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/wirehub-firmware"]
