FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    python3 \
    python3-venv \
    python3-pip \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# DJI FlightRecord decoder (pydjirecord + CanIFly helpers)
RUN python3 -m venv /opt/dji-decode \
  && /opt/dji-decode/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/dji-decode/bin/pip install --no-cache-dir 'pydjirecord[proto]>=1.3' \
  && /opt/dji-decode/bin/djirecord --help >/dev/null
COPY scripts/dji_details_json.py /opt/dji-decode/bin/canifly-dji-details.py
COPY scripts/dji_decode_flight.py /opt/dji-decode/bin/canifly-dji-decode.py
ENV DJI_DECODE_BIN=/opt/dji-decode/bin/djirecord
ENV DJI_DETAILS_SCRIPT=/opt/dji-decode/bin/canifly-dji-details.py
ENV DJI_DECODE_SCRIPT=/opt/dji-decode/bin/canifly-dji-decode.py

# Pin middleware commit so Docker cache invalidates when schemas change.
# Must include pilot/rank (BADGE_HOURS_BONUS). Bump this SHA when shipping shared exports.
ARG MIDDLEWARE_REF=83aab44f0073ac62fa34b025d1bcd2c7ce40339e
# Avoid shallow-clone checkout races that leave an old tip without pilot/rank.
RUN git clone https://github.com/EugeneKrokhmal/CanIFly-middleware.git /app/CanIFly-middleware \
  && cd /app/CanIFly-middleware \
  && git checkout --force "${MIDDLEWARE_REF}" \
  && test "$(git rev-parse HEAD)" = "${MIDDLEWARE_REF}" \
  && npm install \
  && npm run build \
  && node --input-type=module -e "import('./dist/pilot/rank.js').then((m)=>{if(m.BADGE_HOURS_BONUS!==4){console.error('missing BADGE_HOURS_BONUS');process.exit(1)} console.log('middleware pilot/rank ok', m.BADGE_HOURS_BONUS)})"

WORKDIR /app/CanIFly-api
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
# Ensure file: link points at the cloned middleware built above.
RUN rm -rf node_modules/@canifly/middleware \
  && mkdir -p node_modules/@canifly \
  && ln -s /app/CanIFly-middleware node_modules/@canifly/middleware \
  && node --input-type=module -e "import('@canifly/middleware/pilot/rank').then((m)=>{if(m.BADGE_HOURS_BONUS!==4){console.error('link missing BADGE_HOURS_BONUS');process.exit(1)} console.log('linked middleware pilot/rank ok', m.BADGE_HOURS_BONUS)})"

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "start"]
