# WireHub tool pack: enclosure (build123d / Open CASCADE).
# Image tag: wirehub-tool-enclosure:<packVersion> (see PACK_VERSION below and README.md).
# Runs with --network none --read-only --tmpfs /tmp; everything it needs is baked in here.
FROM ghcr.io/astral-sh/uv:0.12.19 AS uv
FROM python:3.12.13-slim-bookworm

ENV PACK_VERSION=0.3.5 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1 \
    HOME=/tmp \
    MPLCONFIGDIR=/tmp

# OCP wheels link libGL/libX11 even without VTK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxrender1 libx11-6 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /usr/local/bin/uv
COPY requirements.lock /pack/requirements.lock
RUN uv pip install --system --require-hashes -r /pack/requirements.lock

COPY enclosure.py preview.py assemble.py pdf.py entry.py repro.py /pack/
RUN python -c "import build123d, OCP; print('build123d', build123d.__version__)"
# No USER: the runner's fixed `docker run` line cannot know which uid owns /work/out, so the
# entry script writes there and then hands every file to the owner of /work/out. A runner may
# still pass --user; nothing here needs root.
WORKDIR /tmp
ENTRYPOINT ["python", "/pack/entry.py"]
