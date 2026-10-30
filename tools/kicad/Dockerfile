# WireHub tool pack `kicad` (contract v0, tools/README.md). Pinned by digest.
# Stage 1 fetches a pinned subset of kicad-packages3D (models-subset.txt) at build time only;
# the running pack still has no network. Same commit as apps/studio/server/models/kicad-library.ts.
FROM kicad/kicad:10.0.6@sha256:18693567392b80da435f9fa952ce3a3e534c66eb5a6033f5b9c80aa3b19dd3ec AS models
ARG MODELS_COMMIT=2a697f255a3654e5175e2e9b5d2abdb4ca874015
USER root
COPY models-subset.txt /tmp/models-subset.txt
RUN git clone --filter=blob:none --no-checkout --depth 1 https://gitlab.com/kicad/libraries/kicad-packages3D.git /tmp/m \
 && cd /tmp/m && git fetch --depth 1 origin "$MODELS_COMMIT" \
 && git sparse-checkout init --no-cone \
 && sed 's#.*#/&.3dshapes/#' /tmp/models-subset.txt | git sparse-checkout set --no-cone --stdin \
 && git checkout "$MODELS_COMMIT" \
 && mkdir -p /models && for l in $(cat /tmp/models-subset.txt); do mv "$l.3dshapes" /models/; done

FROM kicad/kicad:10.0.6@sha256:18693567392b80da435f9fa952ce3a3e534c66eb5a6033f5b9c80aa3b19dd3ec
ARG PACK_VERSION=10.0.6-7
ENV WIREHUB_PACK_VERSION=${PACK_VERSION} HOME=/tmp
COPY --from=models /models /usr/share/kicad/3dmodels
ENV KICAD10_3DMODEL_DIR=/usr/share/kicad/3dmodels
COPY entry.py repro.py /opt/wirehub/
LABEL org.wirehub.tool-pack="kicad" org.wirehub.tool-pack.version="${PACK_VERSION}" org.wirehub.tool-pack.contract="0"
USER kicad
WORKDIR /tmp
ENTRYPOINT ["python3", "/opt/wirehub/entry.py"]
