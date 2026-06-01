# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=http://localhost:8000
ARG VITE_BASE_PATH=/
ARG VITE_AUTH0_DOMAIN=
ARG VITE_AUTH0_CLIENT_ID=
ARG VITE_AUTH0_AUDIENCE=
ARG VITE_AUTH0_CONNECTION=Username-Password-Authentication
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_AUTH0_DOMAIN=$VITE_AUTH0_DOMAIN
ENV VITE_AUTH0_CLIENT_ID=$VITE_AUTH0_CLIENT_ID
ENV VITE_AUTH0_AUDIENCE=$VITE_AUTH0_AUDIENCE
ENV VITE_AUTH0_CONNECTION=$VITE_AUTH0_CONNECTION
# `npm run build` runs `tsc -b && vite build`, so a TS error fails the
# build. Tests are skipped here intentionally — the suite has stale
# pre-redesign test files (tracked separately); CI runs them advisory.
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf.template
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
# CSP_CONNECT_SRC tells the browser which origins the SPA may XHR/fetch
# from. Empty default = same-origin only (prod, where API + UI share a
# host). For dev where the API is on a different port, set this to the
# full origin, e.g. CSP_CONNECT_SRC=http://localhost:8000.
ARG CSP_CONNECT_SRC=
ENV CSP_CONNECT_SRC=$CSP_CONNECT_SRC
EXPOSE 80
CMD ["/bin/sh", "-c", "BASE=$(echo ${VITE_BASE_PATH} | sed -e 's|^/$||' -e 's|/$||'); BASE_ROOT=${BASE:-/}; sed -e \"s|__BASE_PATH_ROOT__|${BASE_ROOT}|g\" -e \"s|__BASE_PATH__|${BASE}|g\" -e \"s|__CSP_CONNECT_SRC__|${CSP_CONNECT_SRC}|g\" /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
