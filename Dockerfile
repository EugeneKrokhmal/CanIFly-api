FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Pin middleware commit so Docker cache invalidates when schemas change.
ARG MIDDLEWARE_REF=32fa4936138dc41068a8531c43af0083a3696d6e
RUN git clone --depth 1 https://github.com/EugeneKrokhmal/CanIFly-middleware.git /app/CanIFly-middleware \
  && cd /app/CanIFly-middleware \
  && git fetch --depth 1 origin ${MIDDLEWARE_REF} \
  && git checkout ${MIDDLEWARE_REF} \
  && npm install \
  && npm run build

WORKDIR /app/CanIFly-api
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
# Ensure file: link points at the cloned middleware built above.
RUN rm -rf node_modules/@canifly/middleware \
  && mkdir -p node_modules/@canifly \
  && ln -s /app/CanIFly-middleware node_modules/@canifly/middleware

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "run", "start"]
