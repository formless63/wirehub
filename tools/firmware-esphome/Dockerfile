# wirehub-tool-firmware-esphome:0.1.0
#
# Pinned ESPHome plus the PlatformIO platforms, frameworks, toolchains and common component
# libraries it needs for ESP32 and ESP8266 (Arduino), fetched while the image is built so a
# compile runs with `--network none` (tools/firmware-esphome/README.md).
FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

ARG ESPHOME_VERSION=2026.9.0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PLATFORMIO_CORE_DIR=/opt/pio \
    XDG_CACHE_HOME=/opt/cache \
    PLATFORMIO_SETTING_ENABLE_TELEMETRY=No \
    PLATFORMIO_NO_ANSI=1 \
    ESPHOME_DASHBOARD_USE_PING=false \
    ESPHOME_NO_COLOR=1

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential \
 && rm -rf /var/lib/apt/lists/* \
 && pip install "esphome==${ESPHOME_VERSION}" \
 && pip freeze > /etc/wirehub-pip-freeze.txt

# Compile one seed per platform so everything those compiles download is already present.
COPY seed /tmp/seed
RUN cd /tmp/seed && for f in seed-*.yaml; do esphome compile "$f" || exit 1; done \
 && mkdir -p /opt/cache/seed-esp32 \
 && cp -r /tmp/seed/.esphome/build/seed-esp32/managed_components /tmp/seed/.esphome/build/seed-esp32/dependencies.lock /opt/cache/seed-esp32/ \
 && rm -rf /tmp/seed /opt/pio/.cache \
 && chmod -R a+rX /opt/pio /opt/cache

# The framework tree stays read-only at its original path (ESPHome's idf-env.json is keyed on it);
# the one directory it writes at compile time points into the run's scratch space (entry.py creates it).
RUN rm -rf /opt/cache/esphome/idf/frameworks/*/.esphome_component_lists \
 && for d in /opt/cache/esphome/idf/frameworks/*/; do ln -s /tmp/wirehub-firmware/idf-component-lists "$d.esphome_component_lists"; done

COPY pack.json /etc/wirehub/pack.json
COPY entry.py /usr/local/bin/wirehub-firmware
RUN chmod 0755 /usr/local/bin/wirehub-firmware

LABEL org.wirehub.pack="firmware-esphome" \
      org.wirehub.pack-version="0.1.0" \
      org.wirehub.tool="esphome" \
      org.wirehub.tool-version="${ESPHOME_VERSION}"

USER 1000:1000
WORKDIR /tmp
ENTRYPOINT ["/usr/local/bin/wirehub-firmware"]
